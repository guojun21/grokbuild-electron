import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AppController,
  MemoryOperationUnavailableError,
  MemorySettingsReconnectError,
  MemorySettingsUnavailableError,
  UpdateQuiescenceUnavailableError
} from '../../src/main/AppController'
import type { AcpStartResult } from '../../src/main/acp/AcpClient'
import type {
  AcpConnection,
  AcpConnectionEvents,
  AcpConnectionOptions
} from '../../src/main/acp/AcpConnection'
import {
  AppStateStore,
  type PersistedState
} from '../../src/main/persistence/AppStateStore'

const roots: string[] = []
const REMOTE_ID = '10000000-0000-4000-8000-000000000001'
const MEMORY_TOKEN = Buffer.alloc(32, 31).toString('base64url')

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class MemoryRuntimeConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  stopCount = 0

  constructor(
    readonly options: AcpConnectionOptions,
    private readonly failStart: boolean,
    private readonly promptGate?: Promise<void>
  ) {
    super()
  }

  start = async (): Promise<AcpStartResult> => {
    if (this.failStart) {
      this.emit('capabilities', {
        currentModelId: 'failed-worker-model',
        availableModels: [{ id: 'failed-worker-model', name: 'Failed worker model' }],
        currentModeId: 'plan',
        availableModes: [{ id: 'plan', name: 'Failed worker mode' }]
      })
      throw new Error('PRIVATE_RECONNECT_CANARY /private/grok/memory')
    }
    if (this.options.forkSession) {
      return {
        sessionId: this.options.forkSession.newSessionId,
        resumed: false,
        forkedFrom: this.options.forkSession.sourceSessionId
      }
    }
    return {
      sessionId: this.options.resumeSessionId ?? REMOTE_ID,
      resumed: this.options.resumeSessionId !== undefined
    }
  }

  prompt = async (): Promise<void> => { await this.promptGate }
  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => { this.stopCount += 1 }

  schedule(identity: string): void {
    this.emit('trustedUpdate', {
      type: 'activity_schedule_upsert',
      source: 'typed',
      fired: false,
      generation: '1',
      revision: '1',
      schedule: { identity, label: 'Protected memory task' }
    })
  }
}

class ToggleStateStore extends AppStateStore {
  failSaves = false
  memoryEnableSaveGate: Promise<void> | undefined
  memoryEnableSaveStarted: (() => void) | undefined

  override async save(state: PersistedState): Promise<void> {
    if (this.failSaves) throw new Error('PRIVATE_PERSISTENCE_CANARY /private/state.json')
    if (state.settings.memoryEnabled && this.memoryEnableSaveGate) {
      this.memoryEnableSaveStarted?.()
      await this.memoryEnableSaveGate
    }
    await super.save(state)
  }
}

class ConnectionFactory {
  readonly options: AcpConnectionOptions[] = []
  readonly connections: MemoryRuntimeConnection[] = []
  failNextStart = false
  promptGate: Promise<void> | undefined

  create = (options: AcpConnectionOptions): MemoryRuntimeConnection => {
    const connection = new MemoryRuntimeConnection(options, this.failNextStart, this.promptGate)
    this.failNextStart = false
    this.options.push(structuredClone(options))
    this.connections.push(connection)
    return connection
  }
}

describe('AppController Memory runtime integration', () => {
  it('threads the persisted switch through new, reconnect, retry, fork, and load workers', async () => {
    const harness = await createHarness()
    const projectId = harness.controller.snapshot().selectedProjectId!
    const sessionId = (await harness.controller.createSession(projectId)).id

    await harness.controller.sendPrompt(sessionId, 'establish a durable session')
    await eventually(() => Boolean(
      harness.controller.migrationSnapshot().sessions.find((item) => item.id === sessionId)
        ?.acpSessionId
    ))
    await eventually(() => controllerInternals(harness.controller).connectionStarts.size === 0)
    expect(harness.factory.options).toHaveLength(1)
    expect(harness.factory.options[0]).toMatchObject({ memoryEnabled: false })

    const first = harness.factory.connections[0]!
    await harness.controller.updateSettings({ memoryEnabled: true })
    expect(first.stopCount).toBe(1)
    expect(harness.factory.options[1]).toMatchObject({
      memoryEnabled: true,
      resumeSessionId: REMOTE_ID
    })

    await harness.controller.retrySession(sessionId)
    expect(harness.factory.options[2]).toMatchObject({
      memoryEnabled: true,
      resumeSessionId: REMOTE_ID
    })

    harness.controller.setCliVersion(process.execPath, 'grok 1.0.5')
    const forked = await harness.controller.forkSession(sessionId)
    const forkOptions = harness.factory.options.find((options) => options.forkSession)
    expect(forkOptions).toMatchObject({
      memoryEnabled: true,
      forkSession: {
        sourceSessionId: REMOTE_ID,
        newSessionId: forked.acpSessionId
      }
    })

    await harness.controller.stop()
    const loadedFactory = new ConnectionFactory()
    const loaded = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(harness.statePath, process.execPath),
      acpFactory: loadedFactory.create
    })
    await loaded.initialize()
    await loaded.selectSession(sessionId)
    await eventually(() => loadedFactory.options.length === 1)
    expect(loadedFactory.options[0]).toMatchObject({
      memoryEnabled: true,
      resumeSessionId: REMOTE_ID
    })
    await loaded.stop()
  })

  it('rolls back a failed durable write and keeps a committed switch after reconnect failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const harness = await createHarness(true)
    const projectId = harness.controller.snapshot().selectedProjectId!
    const sessionId = (await harness.controller.createSession(projectId)).id
    await harness.controller.sendPrompt(sessionId, 'create worker before transaction')
    await eventually(() => harness.factory.options.length === 1)
    await eventuallyPersisted(harness.statePath, false)
    const first = harness.factory.connections[0]!

    harness.store.failSaves = true
    const persistError = await rejection(
      harness.controller.updateSettings({ memoryEnabled: true })
    )
    expect(persistError.message).toBe('Application state could not be persisted.')
    expect(String(persistError)).not.toContain('PRIVATE_PERSISTENCE_CANARY')
    expect(harness.controller.snapshot().settings.memoryEnabled).toBe(false)
    expect(first.stopCount).toBe(0)
    expect(harness.factory.options).toHaveLength(1)

    harness.store.failSaves = false
    harness.factory.failNextStart = true
    const reconnectError = await rejection(
      harness.controller.updateSettings({ memoryEnabled: true })
    )
    expect(reconnectError).toBeInstanceOf(MemorySettingsReconnectError)
    expect(reconnectError.message).toBe(
      'The Memory setting was saved, but one or more Grok sessions could not restart safely.'
    )
    expect(String(reconnectError)).not.toContain('PRIVATE_RECONNECT_CANARY')
    expect(harness.controller.snapshot().settings.memoryEnabled).toBe(true)
    const failedSession = harness.controller.snapshot().sessions.find(
      (session) => session.id === sessionId
    )
    expect(failedSession?.availableModels).toBeUndefined()
    expect(failedSession?.availableModes).toBeUndefined()
    await eventuallyPersisted(harness.statePath, true)
    await harness.controller.stop()

    const restarted = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(harness.statePath, process.execPath)
    })
    await restarted.initialize()
    expect(restarted.snapshot().settings.memoryEnabled).toBe(true)
    await restarted.stop()
  })

  it('recycles the captured worker when scheduled activity arrives during the durable save', async () => {
    const harness = await createHarness()
    const projectId = harness.controller.snapshot().selectedProjectId!
    const sessionId = (await harness.controller.createSession(projectId)).id
    await harness.controller.sendPrompt(sessionId, 'connect before changing Memory')
    await eventually(() => harness.factory.connections.length === 1)
    await eventually(() => controllerInternals(harness.controller).connectionStarts.size === 0)
    await eventually(() => harness.controller.snapshot().sessions.find(
      (session) => session.id === sessionId
    )?.activities?.syncState === 'live')

    const saveGate = deferred<void>()
    const saveStarted = deferred<void>()
    harness.store.memoryEnableSaveGate = saveGate.promise
    harness.store.memoryEnableSaveStarted = () => saveStarted.resolve(undefined)
    const updating = harness.controller.updateSettings({ memoryEnabled: true })
    await saveStarted.promise

    const first = harness.factory.connections[0]!
    first.schedule('SCHEDULE_DURING_MEMORY_SAVE')
    expect(harness.controller.snapshot().sessions.find(
      (session) => session.id === sessionId
    )?.activities?.syncState).toBe('live')
    saveGate.resolve(undefined)

    await expect(updating).resolves.toBeUndefined()
    expect(first.stopCount).toBe(1)
    expect(harness.factory.options).toHaveLength(2)
    expect(harness.factory.options[0]).toMatchObject({ memoryEnabled: false })
    expect(harness.factory.options[1]).toMatchObject({
      memoryEnabled: true,
      resumeSessionId: REMOTE_ID
    })
    await harness.controller.stop()
  })

  it('protects live and replaying scheduled activity but ignores its offline cache', async () => {
    const harness = await createHarness()
    const projectId = harness.controller.snapshot().selectedProjectId!
    const sessionId = (await harness.controller.createSession(projectId)).id
    await harness.controller.sendPrompt(sessionId, 'connect for activity replay')
    await eventually(() => harness.factory.connections.length === 1)
    await eventually(() => harness.controller.snapshot().sessions.find(
      (session) => session.id === sessionId
    )?.activities?.syncState === 'live')
    const connection = harness.factory.connections[0]!
    connection.schedule('PRIVATE_SCHEDULE_ID')

    await expect(harness.controller.updateSettings({ memoryEnabled: true }))
      .rejects.toBeInstanceOf(MemorySettingsUnavailableError)
    expect(connection.stopCount).toBe(0)
    expect(harness.controller.snapshot().settings.memoryEnabled).toBe(false)

    const projection = controllerInternals(harness.controller).activityProjections.get(sessionId)
    expect(projection).toBeDefined()
    projection!.setSyncState('replaying')
    await expect(harness.controller.updateSettings({ memoryEnabled: true }))
      .rejects.toBeInstanceOf(MemorySettingsUnavailableError)
    expect(connection.stopCount).toBe(0)

    connection.emit('exit', 0, null)
    await eventually(() => harness.controller.snapshot().sessions.find(
      (session) => session.id === sessionId
    )?.activities?.syncState === 'offline')
    await expect(harness.controller.updateSettings({ memoryEnabled: true })).resolves.toBeUndefined()
    expect(harness.factory.options[1]).toMatchObject({
      memoryEnabled: true,
      resumeSessionId: REMOTE_ID
    })
    await harness.controller.stop()
  })

  it('fails closed while unrelated integration work is live', async () => {
    const harness = await createHarness()
    const operation = harness.controller.acquireIntegrationOperation()
    await expect(harness.controller.updateSettings({ memoryEnabled: true }))
      .rejects.toBeInstanceOf(MemorySettingsUnavailableError)
    operation.release()
    await harness.controller.stop()
  })

  it('does not recycle a prompt that is pending before the first ACP progress event', async () => {
    const harness = await createHarness()
    const promptGate = deferred<void>()
    harness.factory.promptGate = promptGate.promise
    const projectId = harness.controller.snapshot().selectedProjectId!
    const sessionId = (await harness.controller.createSession(projectId)).id
    await harness.controller.sendPrompt(sessionId, 'pending without a progress event')
    await eventually(() => harness.factory.connections.length === 1)

    await expect(harness.controller.updateSettings({ memoryEnabled: true }))
      .rejects.toBeInstanceOf(MemorySettingsUnavailableError)
    expect(harness.factory.connections[0]!.stopCount).toBe(0)
    expect(harness.controller.snapshot().settings.memoryEnabled).toBe(false)

    promptGate.resolve(undefined)
    await eventually(() => controllerInternals(harness.controller).workingSinceBySessionId.size === 0)
    await harness.controller.stop()
  })

  it('gates remember by the setting and makes broker work a stop/update barrier', async () => {
    const listGate = deferred<void>()
    const listStarted = deferred<void>()
    const broker = {
      list: vi.fn(async () => {
        listStarted.resolve(undefined)
        await listGate.promise
        return []
      }),
      read: vi.fn(async () => ({
        token: MEMORY_TOKEN,
        scope: 'global' as const,
        title: 'Global memory',
        byteLength: 0,
        canDelete: false as const,
        contents: ''
      })),
      remember: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      clear: vi.fn()
    }
    const harness = await createHarness(false, broker)

    await expect(harness.controller.rememberMemory('disabled note'))
      .rejects.toBeInstanceOf(MemoryOperationUnavailableError)
    expect(broker.remember).not.toHaveBeenCalled()
    await expect(harness.controller.readMemory(MEMORY_TOKEN)).resolves.toMatchObject({
      token: MEMORY_TOKEN,
      title: 'Global memory'
    })
    await expect(harness.controller.deleteMemory(MEMORY_TOKEN)).resolves.toBeUndefined()

    const listing = harness.controller.listMemory()
    await listStarted.promise
    await expect(harness.controller.updateSettings({ privacyMode: true })).resolves.toBeUndefined()
    expect(harness.controller.snapshot().settings.privacyMode).toBe(true)
    await expect(harness.controller.updateSettings({ memoryEnabled: true }))
      .rejects.toBeInstanceOf(MemorySettingsUnavailableError)
    await expect(harness.controller.acquireUpdateQuiescence())
      .rejects.toBeInstanceOf(UpdateQuiescenceUnavailableError)

    let stopped = false
    const stopping = harness.controller.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(broker.clear).toHaveBeenCalled()
    listGate.resolve(undefined)
    await expect(listing).resolves.toEqual([])
    await stopping
    expect(stopped).toBe(true)
  })

  it('rotates broker capabilities on setting, project, CLI-context, and stop changes', async () => {
    const broker = {
      list: vi.fn(async () => []),
      read: vi.fn(async () => ({
        token: MEMORY_TOKEN,
        scope: 'global' as const,
        title: 'Global memory',
        byteLength: 0,
        canDelete: false as const,
        contents: ''
      })),
      remember: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      clear: vi.fn()
    }
    const harness = await createHarness(false, broker)
    broker.clear.mockClear()
    expect(broker.clear).not.toHaveBeenCalled()

    await harness.controller.updateSettings({ privacyMode: true })
    expect(broker.clear).toHaveBeenCalledTimes(1)
    await harness.controller.updateSettings({ memoryEnabled: true })
    expect(broker.clear).toHaveBeenCalledTimes(2)

    const otherProject = join(harness.statePath, '..', 'other-project')
    await mkdir(otherProject)
    await harness.controller.addProject(otherProject)
    expect(broker.clear).toHaveBeenCalledTimes(3)
    harness.controller.setCliVersion(process.execPath, 'grok 1.0.5')
    expect(broker.clear).toHaveBeenCalledTimes(4)

    await harness.controller.stop()
    expect(broker.clear).toHaveBeenCalledTimes(5)
  })
})

async function createHarness(
  toggleStore = false,
  memoryBroker?: {
    list(): Promise<never[]>
    read(token: string): Promise<{
      token: string
      scope: 'global'
      title: string
      byteLength: number
      canDelete: false
      contents: string
    }>
    remember(note: string): Promise<void>
    deleteSession(token: string): Promise<void>
    clear(): void
  }
): Promise<{
  controller: AppController
  factory: ConnectionFactory
  statePath: string
  store: ToggleStateStore
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-memory-runtime-'))
  roots.push(root)
  const projectPath = join(root, 'project')
  const statePath = join(root, 'state.json')
  await mkdir(projectPath)
  const store = new ToggleStateStore(statePath, process.execPath)
  const factory = new ConnectionFactory()
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store,
    seedProjectPath: projectPath,
    acpFactory: factory.create,
    ...(memoryBroker ? { memoryBroker } : {})
  })
  await controller.initialize()
  if (!toggleStore) store.failSaves = false
  return { controller, factory, statePath, store }
}

async function eventuallyPersisted(path: string, memoryEnabled: boolean): Promise<void> {
  await eventually(async () => {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        settings?: { memoryEnabled?: boolean }
      }
      return parsed.settings?.memoryEnabled === memoryEnabled
    } catch {
      return false
    }
  })
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('Expected promise to reject')
}

function controllerInternals(controller: AppController): {
  connectionStarts: Map<string, unknown>
  workingSinceBySessionId: Map<string, string>
  activityProjections: Map<string, {
    setSyncState(syncState: 'unseen' | 'replaying' | 'live' | 'offline'): void
  }>
} {
  return controller as unknown as {
    connectionStarts: Map<string, unknown>
    workingSinceBySessionId: Map<string, string>
    activityProjections: Map<string, {
      setSyncState(syncState: 'unseen' | 'replaying' | 'live' | 'offline'): void
    }>
  }
}
