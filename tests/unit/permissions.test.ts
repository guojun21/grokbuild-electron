import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AppController,
  chooseAutoPermissionOption
} from '../../src/main/AppController'
import type {
  AcpPermissionRequest,
  AcpStartResult
} from '../../src/main/acp/AcpClient'
import type {
  AcpConnection,
  AcpConnectionEvents
} from '../../src/main/acp/AcpConnection'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'
import type { PendingPermission } from '../../src/shared/models'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class FakePermissionConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  readonly answers: Array<{ requestId: string; optionId: string }> = []
  start = async (): Promise<AcpStartResult> => ({ sessionId: 'remote-session', resumed: false })
  prompt = async (): Promise<void> => undefined
  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (requestId: string, optionId: string): Promise<void> => {
    this.answers.push({ requestId, optionId })
  }
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => undefined
}

describe('permission queue', () => {
  it('chooses allow-always, then another allow, then the first offered option', () => {
    expect(chooseAutoPermissionOption(permission('p1', [
      { id: 'reject', label: 'Reject', intent: 'reject_once' },
      { id: 'allow_once', label: 'Allow once', intent: 'allow_once' },
      { id: 'allow_always', label: 'Always allow', intent: 'allow_always' }
    ]))).toBe('allow_always')
    expect(chooseAutoPermissionOption(permission('p2', [
      { id: 'reject', label: 'Reject', intent: 'reject_once' },
      { id: 'allow_once', label: 'Allow once', intent: 'allow_once' }
    ]))).toBe('allow_once')
    expect(chooseAutoPermissionOption(permission('p3', [
      { id: 'custom', label: 'Continue' }
    ]))).toBe('custom')
  })

  it('shows and answers concurrent requests in FIFO order while ignoring duplicates', async () => {
    const { controller, connection, sessionId } = await harness()
    connection.emit('permission', request('first'))
    connection.emit('permission', request('second'))
    connection.emit('permission', request('second'))

    expect(controller.snapshot().sessions[0]?.pendingPermission?.requestId).toBe('first')
    expect(controller.snapshot().sessions[0]?.pendingPermission).not.toHaveProperty('sessionId')
    expect(JSON.stringify(controller.snapshot())).not.toContain('remote-session')
    await controller.answerPermission(sessionId, 'first', 'allow_once')
    expect(controller.snapshot().sessions[0]?.pendingPermission?.requestId).toBe('second')
    await controller.answerPermission(sessionId, 'second', 'allow_once')
    expect(controller.snapshot().sessions[0]?.pendingPermission).toBeUndefined()
    expect(connection.answers).toEqual([
      { requestId: 'first', optionId: 'allow_once' },
      { requestId: 'second', optionId: 'allow_once' }
    ])
    await controller.stop()
  })

  it('drains the existing queue sequentially when Auto accept is enabled', async () => {
    const { controller, connection, sessionId } = await harness()
    connection.emit('permission', request('first'))
    connection.emit('permission', request('second'))
    controller.updateSession({ sessionId, permissionMode: 'auto' })

    await eventually(() => connection.answers.length === 2)
    expect(connection.answers).toEqual([
      { requestId: 'first', optionId: 'allow_always' },
      { requestId: 'second', optionId: 'allow_always' }
    ])
    expect(controller.snapshot().sessions[0]?.pendingPermission).toBeUndefined()
    await controller.stop()
  })
})

async function harness(): Promise<{
  controller: AppController
  connection: FakePermissionConnection
  sessionId: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-permissions-'))
  temporaryRoots.push(root)
  let connection: FakePermissionConnection | undefined
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store: new AppStateStore(join(root, 'state.json'), process.execPath),
    seedProjectPath: process.cwd(),
    acpFactory: () => {
      connection = new FakePermissionConnection()
      return connection
    }
  })
  await controller.initialize()
  const projectId = controller.snapshot().projects[0]!.id
  const sessionId = (await controller.createSession(projectId)).id
  controller.sendPrompt(sessionId, 'start')
  await eventually(() => Boolean(connection))
  return { controller, connection: connection!, sessionId }
}

function request(requestId: string): AcpPermissionRequest {
  return {
    rpcId: requestId,
    requestId,
    sessionId: 'remote-session',
    title: `Allow ${requestId}?`,
    options: [
      { id: 'allow_once', label: 'Allow once', intent: 'allow_once' },
      { id: 'allow_always', label: 'Always allow', intent: 'allow_always' },
      { id: 'reject_once', label: 'Reject', intent: 'reject_once' }
    ]
  }
}

function permission(
  requestId: string,
  options: PendingPermission['options']
): PendingPermission {
  return { requestId, sessionId: 'local', title: 'Allow?', options }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condition did not become true')
}
