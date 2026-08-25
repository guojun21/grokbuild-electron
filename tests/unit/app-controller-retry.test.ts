import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppController } from '../../src/main/AppController'
import type { AcpStartResult } from '../../src/main/acp/AcpClient'
import type { AcpConnection, AcpConnectionEvents } from '../../src/main/acp/AcpConnection'
import { PublicAcpError } from '../../src/main/acp/PublicSessionError'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class RetryConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  startCount = 0
  promptCount = 0
  stopCount = 0

  constructor(
    private readonly startFailure?: Error,
    private readonly promptFailure?: Error,
    private readonly emitPendingPermission = false
  ) {
    super()
  }

  start = async (): Promise<AcpStartResult> => {
    this.startCount += 1
    if (this.startFailure) throw this.startFailure
    return { sessionId: 'remote-session', resumed: false }
  }

  prompt = async (): Promise<void> => {
    this.promptCount += 1
    if (this.emitPendingPermission) {
      this.emit('permission', {
        rpcId: 'permission-1',
        requestId: 'permission-1',
        sessionId: 'remote-session',
        title: 'Approve the tool?',
        options: [{ id: 'allow_once', label: 'Allow once', intent: 'allow_once' }]
      })
      this.emit('interaction', {
        kind: 'plan',
        interactionId: 'interaction-1',
        sessionId: 'remote-session',
        planContent: 'A pending plan'
      })
    }
    if (this.promptFailure) throw this.promptFailure
  }

  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => { this.stopCount += 1 }
}

describe('explicit session retry', () => {
  it('deduplicates concurrent retry, clears failure/input, and never replays the old prompt', async () => {
    const failed = new RetryConnection(
      undefined,
      new PublicAcpError('authentication'),
      true
    )
    const recovered = new RetryConnection()
    const { controller, sessionId } = await harness([failed, recovered])

    controller.sendPrompt(sessionId, 'This prompt must be recorded once')
    await eventually(() => controller.snapshot().sessions[0]?.status === 'failed')
    expect(controller.snapshot().sessions[0]?.pendingPermission).toBeDefined()
    expect(controller.snapshot().sessions[0]?.pendingInteraction).toBeDefined()

    const first = controller.retrySession(sessionId)
    const duplicate = controller.retrySession(sessionId)
    expect(duplicate).toBe(first)
    await first

    const session = controller.snapshot().sessions[0]
    expect(session).toMatchObject({ status: 'idle' })
    expect(session?.lastError).toBeUndefined()
    expect(session?.pendingPermission).toBeUndefined()
    expect(session?.pendingInteraction).toBeUndefined()
    expect(failed.promptCount).toBe(1)
    expect(recovered.startCount).toBe(1)
    expect(recovered.promptCount).toBe(0)
    expect(session?.transcript.filter((item) => item.kind === 'message' && item.role === 'user'))
      .toHaveLength(1)
    await controller.stop()
  })

  it('maps retry failure to fixed public copy without persisting raw diagnostics', async () => {
    const canary = 'QA_RETRY_CANARY /private/retry/auth.json authentication required'
    const failed = new RetryConnection(undefined, new PublicAcpError('authentication'))
    const retryFailure = new RetryConnection(new Error(canary))
    const { controller, sessionId, statePath } = await harness([failed, retryFailure])

    controller.sendPrompt(sessionId, 'Start once')
    await eventually(() => controller.snapshot().sessions[0]?.status === 'failed')
    await expect(controller.retrySession(sessionId)).rejects.toThrow(
      'Grok authentication failed. Sign in again and retry.'
    )

    const serialized = JSON.stringify(controller.snapshot())
    expect(serialized).not.toContain('RETRY-CANARY')
    expect(serialized).not.toContain('/private/retry')
    expect(controller.snapshot().sessions[0]?.lastError).toBe(
      'Grok authentication failed. Sign in again and retry.'
    )
    await controller.stop()
    expect(await readFile(statePath, 'utf8')).not.toContain('RETRY-CANARY')
  })
})

async function harness(connections: RetryConnection[]): Promise<{
  controller: AppController
  sessionId: string
  statePath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-retry-'))
  temporaryRoots.push(root)
  const statePath = join(root, 'state.json')
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store: new AppStateStore(statePath, process.execPath),
    seedProjectPath: process.cwd(),
    acpFactory: () => {
      const connection = connections.shift()
      if (!connection) throw new Error('Unexpected connection request')
      return connection
    }
  })
  await controller.initialize()
  const projectId = controller.snapshot().projects[0]!.id
  const sessionId = (await controller.createSession(projectId)).id
  return { controller, sessionId, statePath }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condition did not become true')
}
