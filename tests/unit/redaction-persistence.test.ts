import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcpClientOptions, AcpStartResult } from '../../src/main/acp/AcpClient'
import type { AcpConnection, AcpConnectionEvents } from '../../src/main/acp/AcpConnection'
import { SessionManager } from '../../src/main/acp/SessionManager'
import { AppStateStore, defaultState } from '../../src/main/persistence/AppStateStore'
import { normalizeSessionUpdate } from '../../src/shared/acp/events'
import { appendSessionError, applyAcpEvent } from '../../src/shared/chat/reducer'
import type { SessionSnapshot } from '../../src/shared/models'

const CANARY = 'snapshot-persistence-canary-5c12'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

class DiagnosticConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  start = async (): Promise<AcpStartResult> => ({ sessionId: 'remote', resumed: false })
  prompt = async (): Promise<void> => undefined
  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => undefined
}

describe('redaction before snapshots and persistence', () => {
  it('keeps tool payload and raw stderr canaries out of transcript state and disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-redaction-persistence-'))
    temporaryDirectories.push(root)
    const connection = new DiagnosticConnection()
    const manager = new SessionManager(2, () => connection)
    let snapshot = session()
    manager.on('error', (_sessionId, error) => {
      snapshot = appendSessionError(snapshot, error.message)
    })
    manager.create('local-1', options)

    const event = normalizeSessionUpdate({
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: `Fetch Bearer ${CANARY}`,
        rawInput: {
          summary: `Fetch metadata sk-${CANARY} https://user:${CANARY}@example.test/?api_key=${CANARY}&safe=visible`,
          token: `xai-${CANARY}`,
          headers: { authorization: `Bearer ${CANARY}` },
          env: { XAI_API_KEY: CANARY },
          path: `/private/${CANARY}`
        }
      }
    })
    snapshot = applyAcpEvent(snapshot, event)
    connection.emit(
      'stderr',
      `Authentication failed Bearer ${CANARY} /private/${CANARY} env XAI_API_KEY=${CANARY}`
    )

    const serializedSnapshot = JSON.stringify(snapshot)
    expect(serializedSnapshot).toContain('Fetch metadata')
    expect(serializedSnapshot).toContain('safe=visible')
    expect(serializedSnapshot).toContain('Grok authentication failed.')
    expect(serializedSnapshot).not.toContain(CANARY)
    expect(serializedSnapshot).not.toContain('/private/')

    const state = defaultState(process.execPath)
    state.projects = [{
      id: 'project-1',
      name: 'Project',
      path: root,
      sessionIds: ['local-1'],
      createdAt: '2026-08-25T00:00:00.000Z'
    }]
    state.sessions = [snapshot]
    state.selectedProjectId = 'project-1'
    state.selectedSessionId = 'local-1'
    const statePath = join(root, 'state.json')
    await new AppStateStore(statePath, process.execPath).save(state)
    const persisted = await readFile(statePath, 'utf8')

    expect(persisted).toContain('Fetch metadata')
    expect(persisted).toContain('safe=visible')
    expect(persisted).toContain('Grok authentication failed.')
    expect(persisted).not.toContain(CANARY)
    expect(persisted).not.toContain('/private/')
    await manager.stopAll()
  })
})

const options: AcpClientOptions = {
  cliPath: '/tmp/grok',
  cwd: '/tmp',
  model: 'grok-4.6',
  reasoningEffort: 'xhigh'
}

function session(): SessionSnapshot {
  const timestamp = '2026-08-25T00:00:00.000Z'
  return {
    id: 'local-1',
    projectId: 'project-1',
    title: 'Security test',
    status: 'running',
    model: 'grok-4.6',
    mode: 'default',
    reasoningEffort: 'xhigh',
    permissionMode: 'ask',
    contextUsed: 0,
    contextLimit: 500_000,
    transcript: [],
    createdAt: timestamp,
    updatedAt: timestamp
  }
}
