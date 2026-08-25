import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppController } from '../../src/main/AppController'
import type { AcpPermissionRequest, AcpStartResult } from '../../src/main/acp/AcpClient'
import type { AcpConnection, AcpConnectionEvents } from '../../src/main/acp/AcpConnection'
import type { SessionLifecycleEvent } from '../../src/main/notifications/SessionNotificationCoordinator'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class FakeLifecycleConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  cancelCount = 0

  constructor(private readonly promptResult: Promise<void>) {
    super()
  }

  start = async (): Promise<AcpStartResult> => ({ sessionId: 'remote-session', resumed: false })
  prompt = async (): Promise<void> => this.promptResult
  cancel = (): void => { this.cancelCount += 1 }
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => undefined
}

describe('content-free session lifecycle events', () => {
  it('emits one needs-input event and a completion for a successful turn', async () => {
    const prompt = deferred<void>()
    const { controller, connection, sessionId } = await harness(prompt.promise)
    const events: SessionLifecycleEvent[] = []
    controller.on('sessionLifecycle', (event) => events.push(event))

    controller.sendPrompt(sessionId, 'secret prompt that must not enter lifecycle events')
    await eventually(() => events.some((event) => event.status === 'started'))
    connection.emit('permission', permission('permission-1'))
    connection.emit('permission', permission('permission-2'))
    prompt.resolve()
    await eventually(() => events.some((event) => event.status === 'completed'))

    expect(events.map((event) => event.status)).toEqual(['started', 'needs-input', 'completed'])
    expect(events.every((event) => Object.keys(event).sort().join(',') === 'sessionId,status')).toBe(true)
    expect(JSON.stringify(events)).not.toContain('secret prompt')
    await controller.stop()
  })

  it('emits a content-free error target and does not call cancellation completion', async () => {
    const rejected = Promise.reject(new Error('/private/project token=do-not-leak'))
    // Attach a catch immediately so the intentionally rejected fixture cannot become unhandled.
    void rejected.catch(() => undefined)
    const errorHarness = await harness(rejected)
    const errorEvents: SessionLifecycleEvent[] = []
    errorHarness.controller.on('sessionLifecycle', (event) => errorEvents.push(event))
    await errorHarness.controller.sendPrompt(errorHarness.sessionId, 'start failure')
    await eventually(() => errorEvents.some((event) => event.status === 'error'))

    expect(errorEvents.map((event) => event.status)).toEqual(['started', 'error'])
    expect(JSON.stringify(errorEvents)).not.toContain('/private/project')
    await errorHarness.controller.stop()

    const pending = deferred<void>()
    const cancelHarness = await harness(pending.promise)
    const cancelEvents: SessionLifecycleEvent[] = []
    cancelHarness.controller.on('sessionLifecycle', (event) => cancelEvents.push(event))
    await cancelHarness.controller.sendPrompt(cancelHarness.sessionId, 'cancel me')
    cancelHarness.controller.cancelTurn(cancelHarness.sessionId)
    pending.resolve()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(cancelEvents.map((event) => event.status)).toEqual(['started'])
    expect(cancelHarness.connection.cancelCount).toBe(1)
    await cancelHarness.controller.stop()
  })

  it('does not report auto-accepted tool permission as user input', async () => {
    const prompt = deferred<void>()
    const { controller, connection, sessionId } = await harness(prompt.promise)
    controller.updateSession({ sessionId, permissionMode: 'auto' })
    const events: SessionLifecycleEvent[] = []
    controller.on('sessionLifecycle', (event) => events.push(event))

    await controller.sendPrompt(sessionId, 'automatic permission')
    connection.emit('permission', permission('permission-1'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(events.some((event) => event.status === 'needs-input')).toBe(false)
    await controller.stop()
  })
})

async function harness(promptResult: Promise<void>): Promise<{
  controller: AppController
  connection: FakeLifecycleConnection
  sessionId: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-lifecycle-'))
  temporaryRoots.push(root)
  const connection = new FakeLifecycleConnection(promptResult)
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store: new AppStateStore(join(root, 'state.json'), process.execPath),
    seedProjectPath: process.cwd(),
    acpFactory: () => connection
  })
  await controller.initialize()
  const projectId = controller.snapshot().projects[0]!.id
  const sessionId = (await controller.createSession(projectId)).id
  return { controller, connection, sessionId }
}

function permission(requestId: string): AcpPermissionRequest {
  return {
    rpcId: requestId,
    requestId,
    sessionId: 'remote-session',
    title: 'Tool permission',
    options: [{ id: 'allow_once', label: 'Allow once', intent: 'allow_once' }]
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condition did not become true')
}
