import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type {
  AcpClientOptions,
  AcpPermissionRequest,
  AcpStartResult
} from '../../src/main/acp/AcpClient'
import type { AcpConnection, AcpConnectionEvents } from '../../src/main/acp/AcpConnection'
import { SessionManager } from '../../src/main/acp/SessionManager'

class FakeConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  stopped = false
  start = async (): Promise<AcpStartResult> => ({
    sessionId: 'fake-session',
    resumed: false
  })
  prompt = async (): Promise<void> => undefined
  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => { this.stopped = true }
}

class ControlledStopConnection extends FakeConnection {
  stopCount = 0

  constructor(
    private readonly stopStarted: () => void,
    private readonly stopGate: Promise<void>,
    private readonly rejectAfterGate = false
  ) {
    super()
  }

  override stop = async (): Promise<void> => {
    this.stopCount += 1
    this.stopStarted()
    await this.stopGate
    if (this.rejectAfterGate) throw new Error('private child shutdown failure')
    this.stopped = true
  }
}

const options: AcpClientOptions = {
  cliPath: '/tmp/grok',
  cwd: '/tmp',
  model: 'grok-4.6',
  reasoningEffort: 'xhigh'
}

describe('SessionManager process identity', () => {
  it('preserves a validated primary-agent profile through connection construction', () => {
    const received: Array<AcpClientOptions & { localSessionId: string; generation: number }> = []
    const manager = new SessionManager(2, (connectionOptions) => {
      received.push(connectionOptions)
      return new FakeConnection()
    })
    const agentProfile = {
      name: 'security_reviewer',
      description: 'Reviews trust boundaries.',
      promptBody: 'Inspect the requested boundary and report concrete findings.'
    }

    manager.create('profile-session', { ...options, agentProfile })

    expect(received).toEqual([{
      ...options,
      agentProfile,
      localSessionId: 'profile-session',
      generation: 1
    }])
  })

  it('waits in stopAll for an explicit stop that already left the live map', async () => {
    const gate = deferred<void>()
    const started = deferred<void>()
    const connection = new ControlledStopConnection(
      () => started.resolve(undefined),
      gate.promise
    )
    const manager = new SessionManager(2, () => connection)
    manager.create('slow-session', options)

    const stopping = manager.stop('slow-session')
    await started.promise
    await manager.stop('slow-session')
    let stopAllResolved = false
    const stoppingAll = manager.stopAll().then(() => { stopAllResolved = true })
    await Promise.resolve()

    expect(stopAllResolved).toBe(false)
    expect(connection.stopCount).toBe(1)
    gate.resolve(undefined)
    await Promise.all([stopping, stoppingAll])
    expect(connection.stopCount).toBe(1)
  })

  it('drains an already-evicted LRU stop even when child shutdown rejects', async () => {
    const gate = deferred<void>()
    const started = deferred<void>()
    const created: FakeConnection[] = []
    const manager = new SessionManager(1, () => {
      const connection = created.length === 0
        ? new ControlledStopConnection(
            () => started.resolve(undefined),
            gate.promise,
            true
          )
        : new FakeConnection()
      created.push(connection)
      return connection
    })
    manager.create('evicted', options)
    manager.create('current', options)
    await started.promise

    let stopAllResolved = false
    const stoppingAll = manager.stopAll().then(() => { stopAllResolved = true })
    await Promise.resolve()
    expect(stopAllResolved).toBe(false)

    gate.resolve(undefined)
    await expect(stoppingAll).resolves.toBeUndefined()
    expect((created[0] as ControlledStopConnection).stopCount).toBe(1)
    expect(created[1]?.stopped).toBe(true)
  })

  it('buffers bounded fork-start events until atomic activation', () => {
    const connection = new FakeConnection()
    const manager = new SessionManager(2, () => connection)
    const updates: unknown[] = []
    const capabilities: unknown[] = []
    manager.on('update', (_sessionId, update) => updates.push(update))
    manager.on('capabilities', (_sessionId, value) => capabilities.push(value))

    const client = manager.createDeferred('fork-child', options)
    connection.emit('update', { sessionUpdate: 'usage_update', usage: { used: 1, limit: 2 } })
    connection.emit('capabilities', {
      currentModelId: 'grok-4.6',
      availableModels: [{ id: 'grok-4.6', name: 'Grok 4.6' }],
      currentModeId: 'default',
      availableModes: [{ id: 'default', name: 'Agent' }]
    })
    expect(updates).toEqual([])
    expect(capabilities).toEqual([])

    manager.activateDeferred('fork-child', client)
    expect(updates).toHaveLength(1)
    expect(capabilities).toHaveLength(1)
  })

  it('fails closed when deferred events exceed the total byte budget', () => {
    const connection = new FakeConnection()
    const manager = new SessionManager(2, () => connection)
    const client = manager.createDeferred('fork-child', options)

    connection.emit('update', { payload: 'x'.repeat(600 * 1024) })
    expect(connection.stopped).toBe(false)
    connection.emit('update', { payload: 'x'.repeat(500 * 1024) })

    expect(connection.stopped).toBe(true)
    expect(manager.isCurrent('fork-child', client)).toBe(false)
    expect(() => manager.activateDeferred('fork-child', client)).toThrow(/no longer current/)
  })

  it('buffers up to 256 deferred events and fails closed on the next event', () => {
    const acceptedConnection = new FakeConnection()
    const acceptedManager = new SessionManager(2, () => acceptedConnection)
    const acceptedClient = acceptedManager.createDeferred('accepted-child', options)
    const acceptedUpdates: unknown[] = []
    acceptedManager.on('update', (_sessionId, update) => acceptedUpdates.push(update))
    for (let index = 0; index < 256; index += 1) {
      acceptedConnection.emit('update', { index })
    }
    expect(acceptedConnection.stopped).toBe(false)
    acceptedManager.activateDeferred('accepted-child', acceptedClient)
    expect(acceptedUpdates).toHaveLength(256)

    const overflowConnection = new FakeConnection()
    const overflowManager = new SessionManager(2, () => overflowConnection)
    const overflowClient = overflowManager.createDeferred('overflow-child', options)
    for (let index = 0; index < 257; index += 1) {
      overflowConnection.emit('update', { index })
    }
    expect(overflowConnection.stopped).toBe(true)
    expect(overflowManager.isCurrent('overflow-child', overflowClient)).toBe(false)
    expect(() => overflowManager.activateDeferred('overflow-child', overflowClient))
      .toThrow(/no longer current/)
  })

  it('replays a buffered exit as a failed activation identity', () => {
    const connection = new FakeConnection()
    const manager = new SessionManager(2, () => connection)
    const client = manager.createDeferred('fork-child', options)
    connection.emit('exit', 1, null)

    manager.activateDeferred('fork-child', client)

    expect(manager.isCurrent('fork-child', client)).toBe(false)
  })

  it('does not evict a live session for a provisional fork until activation commits', async () => {
    const created: FakeConnection[] = []
    const manager = new SessionManager(1, () => {
      const connection = new FakeConnection()
      created.push(connection)
      return connection
    })
    const existing = manager.create('existing', options)
    const failedFork = manager.createDeferred('failed-fork', options)
    expect(created[0]?.stopped).toBe(false)
    await manager.stop('failed-fork')
    expect(created[0]?.stopped).toBe(false)
    expect(manager.isCurrent('existing', existing)).toBe(true)

    const committedFork = manager.createDeferred('committed-fork', options)
    manager.setProtection('committed-fork', 'selected', true)
    manager.activateDeferred('committed-fork', committedFork)
    expect(created[0]?.stopped).toBe(false)
    manager.enforceLimit('committed-fork')
    expect(created[0]?.stopped).toBe(true)
    expect(manager.isCurrent('committed-fork', committedFork)).toBe(true)
    await manager.stopAll()
  })

  it('drops late updates and permissions from a replaced client', async () => {
    const created: FakeConnection[] = []
    const manager = new SessionManager(2, () => {
      const connection = new FakeConnection()
      created.push(connection)
      return connection
    })
    const updates: unknown[] = []
    const permissions: AcpPermissionRequest[] = []
    manager.on('update', (_sessionId, update) => updates.push(update))
    manager.on('permission', (_sessionId, permission) => permissions.push(permission))

    const oldClient = manager.create('local-1', options) as FakeConnection
    expect(manager.isCurrent('local-1', oldClient)).toBe(true)
    await manager.stop('local-1')
    const currentClient = manager.create('local-1', options) as FakeConnection
    expect(manager.isCurrent('local-1', oldClient)).toBe(false)
    expect(manager.isCurrent('local-1', currentClient)).toBe(true)
    oldClient.emit('update', { stale: true })
    oldClient.emit('trustedUpdate', {
      type: 'turn_usage', usage: { inputTokens: 999 }
    })
    oldClient.emit('permission', permission('stale'))
    currentClient.emit('update', { current: true })
    currentClient.emit('trustedUpdate', {
      type: 'context_usage', used: 12_345, limit: 131_072
    })
    currentClient.emit('trustedUpdate', {
      type: 'mode_changed', mode: 'plan'
    })
    currentClient.emit('permission', permission('current'))

    expect(oldClient.stopped).toBe(true)
    expect(created).toHaveLength(2)
    expect(updates).toEqual([
      { current: true },
      { type: 'context_usage', used: 12_345, limit: 131_072 },
      { type: 'mode_changed', mode: 'plan' }
    ])
    expect(permissions.map((item) => item.requestId)).toEqual(['current'])
    await manager.stopAll()
  })

  it('temporarily exceeds the soft limit rather than evicting protected work', async () => {
    const created: FakeConnection[] = []
    const manager = new SessionManager(1, () => {
      const connection = new FakeConnection()
      created.push(connection)
      return connection
    })

    manager.create('busy', options)
    manager.setProtection('busy', 'turn', true)
    manager.create('new', options)
    expect(created[0]?.stopped).toBe(false)
    expect(created[1]?.stopped).toBe(false)

    manager.setProtection('busy', 'turn', false)
    expect(created[0]?.stopped).toBe(false)
    expect(created[1]?.stopped).toBe(true)
    await manager.stopAll()
  })

  it('keeps independent protection reasons until every owner releases the session', async () => {
    const created: FakeConnection[] = []
    const manager = new SessionManager(1, () => {
      const connection = new FakeConnection()
      created.push(connection)
      return connection
    })

    manager.create('selected-turn', options)
    manager.setProtection('selected-turn', 'selected', true)
    manager.setProtection('selected-turn', 'turn', true)
    manager.create('new', options)
    manager.setProtection('selected-turn', 'turn', false)
    expect(created[0]?.stopped).toBe(false)

    manager.setProtection('selected-turn', 'selected', false)
    expect(created[0]?.stopped).toBe(false)
    expect(created[1]?.stopped).toBe(true)
    await manager.stopAll()
  })

  it('maps raw stderr to a deduplicated fixed public taxonomy', async () => {
    const connection = new FakeConnection()
    const manager = new SessionManager(2, () => connection)
    const errors: Error[] = []
    manager.on('error', (_sessionId, error) => errors.push(error))
    manager.create('diagnostic-session', options)
    const canary = 'stderr-private-canary-91b6'

    connection.emit('stderr', `debug line Bearer ${canary}`)
    for (let index = 0; index < 10; index += 1) {
      connection.emit('stderr', `Authentication expired token=${canary} /private/${canary}`)
    }
    connection.emit('stderr', `429 rate limit xai-${canary}`)
    connection.emit('stderr', `ECONNREFUSED https://user:${canary}@example.test/?token=${canary}`)
    connection.emit('stderr', `fatal panic env XAI_API_KEY=${canary}`)
    connection.emit('stderr', `unexpected error argv --token ${canary}`)

    expect(errors.map((error) => error.message)).toEqual([
      'Grok authentication failed. Sign in again and retry.',
      'Grok is temporarily rate limited. Wait and retry.',
      'Grok could not reach the service. Check the connection and retry.',
      'The Grok process stopped unexpectedly. Start a new prompt to reconnect.',
      'Grok reported an unexpected error. Retry the request.'
    ])
    const serialized = JSON.stringify(errors.map((error) => ({ name: error.name, message: error.message })))
    expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain('/private/')
    expect(serialized).not.toContain('argv')
    await manager.stopAll()
  })
})

function permission(requestId: string): AcpPermissionRequest {
  return {
    rpcId: requestId,
    requestId,
    sessionId: 'remote-1',
    title: 'Allow?',
    options: [{ id: 'allow_once', label: 'Allow once', intent: 'allow_once' }]
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}
