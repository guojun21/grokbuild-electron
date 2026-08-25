import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppController } from '../../src/main/AppController'
import { AttachmentBroker } from '../../src/main/attachments/AttachmentBroker'
import type { AcpStartResult } from '../../src/main/acp/AcpClient'
import type { AcpConnection, AcpConnectionEvents } from '../../src/main/acp/AcpConnection'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'
import type { AttachmentPrompt } from '../../src/shared/attachments'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ))
})

class CapturingConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  readonly prompts: AttachmentPrompt[] = []

  start = async (): Promise<AcpStartResult> => ({ sessionId: 'remote-session', resumed: false })
  prompt = async (prompt: AttachmentPrompt): Promise<void> => {
    this.prompts.push(structuredClone(prompt))
  }
  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => undefined
}

describe('AppController attachment composition', () => {
  it('sends Swift-order content blocks while persisting only self-describing text', async () => {
    const harness = await createHarness()
    const notePath = join(harness.project, 'notes.txt')
    const imagePath = join(harness.project, 'pixel.png')
    const image = pngBytes()
    await writeFile(notePath, 'ordinary file bytes must not be read')
    await writeFile(imagePath, image)
    const session = await harness.controller.createSession(harness.projectId)
    const selection = await harness.controller.stageAttachments(session.id, [imagePath, notePath])

    await harness.controller.sendPrompt(session.id, 'Inspect these inputs', selection.token)
    await eventually(() => harness.connection.prompts.length === 1)

    expect(harness.connection.prompts[0]).toEqual([
      { type: 'text', text: 'Attached file: notes.txt' },
      { type: 'text', text: 'Inspect these inputs' },
      { type: 'text', text: 'Attached image: pixel.png' },
      { type: 'image', data: image.toString('base64'), mimeType: 'image/png' }
    ])
    const snapshot = harness.controller.snapshot()
    const serializedSnapshot = JSON.stringify(snapshot)
    const userMessage = snapshot.sessions.find((item) => item.id === session.id)?.transcript[0]
    expect(userMessage).toMatchObject({
      kind: 'message',
      role: 'user',
      text: 'Attached file: notes.txt\n\nInspect these inputs\n\nAttached image: pixel.png'
    })
    expect(serializedSnapshot).not.toContain(image.toString('base64'))
    expect(serializedSnapshot).not.toContain(notePath)
    expect(serializedSnapshot).not.toContain(imagePath)

    await harness.controller.stop()
    const persisted = await readFile(harness.statePath, 'utf8')
    expect(persisted).not.toContain(image.toString('base64'))
    expect(persisted).not.toContain(notePath)
    expect(persisted).not.toContain(imagePath)
  })

  it('allows an attachment-only turn and clears leases on close, project removal, and quit', async () => {
    const harness = await createHarness()
    const imagePath = join(harness.project, 'only.png')
    await writeFile(imagePath, pngBytes())

    const attachmentOnly = await harness.controller.createSession(harness.projectId)
    const sent = await harness.controller.stageAttachments(attachmentOnly.id, [imagePath])
    await harness.controller.sendPrompt(attachmentOnly.id, '', sent.token)
    await eventually(() => harness.connection.prompts.length === 1)
    expect(harness.connection.prompts[0]).toEqual([
      { type: 'text', text: 'Attached image: only.png' },
      { type: 'image', data: pngBytes().toString('base64'), mimeType: 'image/png' }
    ])

    const closeLease = await harness.controller.stageAttachments(attachmentOnly.id, [imagePath])
    await harness.controller.closeSession(attachmentOnly.id)
    await expect(harness.broker.consume(attachmentOnly.id, closeLease.token))
      .rejects.toMatchObject({ code: 'invalid-token' })

    const removed = await harness.controller.createSession(harness.projectId)
    const removeLease = await harness.controller.stageAttachments(removed.id, [imagePath])
    await harness.controller.removeProject(harness.projectId)
    await expect(harness.broker.consume(removed.id, removeLease.token))
      .rejects.toMatchObject({ code: 'invalid-token' })

    const addedAgain = await harness.controller.addProject(harness.project)
    const quitting = await harness.controller.createSession(addedAgain.id)
    const quitLease = await harness.controller.stageAttachments(quitting.id, [imagePath])
    await harness.controller.stop()
    await expect(harness.broker.consume(quitting.id, quitLease.token))
      .rejects.toMatchObject({ code: 'invalid-token' })
  })
})

async function createHarness(): Promise<{
  root: string
  project: string
  statePath: string
  projectId: string
  controller: AppController
  broker: AttachmentBroker
  connection: CapturingConnection
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-controller-attachments-'))
  temporaryRoots.push(root)
  const project = join(root, 'project')
  await mkdir(project)
  const statePath = join(root, 'state.json')
  const broker = new AttachmentBroker()
  const connection = new CapturingConnection()
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store: new AppStateStore(statePath, process.execPath),
    seedProjectPath: project,
    attachmentBroker: broker,
    acpFactory: () => connection
  })
  await controller.initialize()
  const projectId = controller.snapshot().projects[0]!.id
  return { root, project, statePath, projectId, controller, broker, connection }
}

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condition did not become true')
}
