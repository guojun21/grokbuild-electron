import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AppController,
  UpdateQuiescenceUnavailableError,
  type UpdateQuiescenceLease
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
import type { ProjectSnapshot, SessionSnapshot } from '../../src/shared/models'
import type { WorkspaceHealthState } from '../../src/shared/workspaceHealth'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class QuiescenceConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  startCount = 0
  stopCount = 0

  constructor(
    readonly localSessionId: string,
    private readonly stopGate?: Promise<void>
  ) {
    super()
  }

  start = async (): Promise<AcpStartResult> => {
    this.startCount += 1
    return {
      sessionId: `remote-${this.localSessionId}`,
      resumed: this.startCount > 1
    }
  }

  prompt = async (): Promise<void> => undefined
  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => {
    this.stopCount += 1
    await this.stopGate
  }
}

class ToggleStateStore extends AppStateStore {
  failSaves = false

  override async save(state: PersistedState): Promise<void> {
    if (this.failSaves) throw new Error('private persistence failure')
    await super.save(state)
  }
}

describe('AppController update quiescence', () => {
  it('serializes main integration child-process work with update quiescence', async () => {
    const harness = await createHarness()
    const operation = harness.controller.acquireIntegrationOperation()

    await expect(harness.controller.acquireUpdateQuiescence())
      .rejects.toBeInstanceOf(UpdateQuiescenceUnavailableError)
    operation.release()
    operation.release()

    const update = await harness.controller.acquireUpdateQuiescence()
    expect(() => harness.controller.acquireIntegrationOperation())
      .toThrow(UpdateQuiescenceUnavailableError)
    update.release()
    await harness.controller.stop()
  })

  it('strictly rejects every concurrent controller operation and an unsettled session', async () => {
    const harness = await createHarness()
    const internals = controllerInternals(harness.controller)
    const connection = harness.connections[0]!
    const project = harness.controller.snapshot().projects[0]!
    const session = internals.state.sessions.find((candidate) => candidate.id === harness.sessionId)!

    const cases: Array<{
      name: string
      set(): void
      clear(): void
    }> = [
      {
        name: 'stopping',
        set: () => { internals.stopping = true },
        clear: () => { internals.stopping = false }
      },
      {
        name: 'migration flag',
        set: () => { internals.migrationApplying = true },
        clear: () => { internals.migrationApplying = false }
      },
      {
        name: 'migration operation',
        set: () => { internals.migrationOperation = Promise.resolve() },
        clear: () => { internals.migrationOperation = undefined }
      },
      {
        name: 'fork start',
        set: () => { internals.forkStarts.set(harness.sessionId, Promise.resolve(session)) },
        clear: () => { internals.forkStarts.clear() }
      },
      {
        name: 'retry start',
        set: () => { internals.retryStarts.set(harness.sessionId, Promise.resolve()) },
        clear: () => { internals.retryStarts.clear() }
      },
      {
        name: 'session lifecycle',
        set: () => { internals.sessionLifecycleLocks.add(harness.sessionId) },
        clear: () => { internals.sessionLifecycleLocks.clear() }
      },
      {
        name: 'project removal',
        set: () => { internals.projectRemovalLocks.add(project.id) },
        clear: () => { internals.projectRemovalLocks.clear() }
      },
      {
        name: 'destructive persistence',
        set: () => { internals.destructivePersistenceTransactions = 1 },
        clear: () => { internals.destructivePersistenceTransactions = 0 }
      },
      {
        name: 'connection start',
        set: () => {
          internals.connectionStarts.set(harness.sessionId, {
            client: connection,
            promise: Promise.resolve(connection)
          })
        },
        clear: () => { internals.connectionStarts.clear() }
      },
      {
        name: 'workspace health check',
        set: () => {
          internals.workspaceHealthChecks.set(project.id, {
            project,
            path: project.path,
            promise: Promise.resolve('ready')
          })
        },
        clear: () => { internals.workspaceHealthChecks.clear() }
      },
      {
        name: 'unsettled session',
        set: () => { session.status = 'running' },
        clear: () => { session.status = 'idle' }
      }
    ]

    for (const testCase of cases) {
      testCase.set()
      await expect(harness.controller.acquireUpdateQuiescence(), testCase.name)
        .rejects.toBeInstanceOf(UpdateQuiescenceUnavailableError)
      expect(connection.stopCount, testCase.name).toBe(0)
      testCase.clear()
    }

    const lease = await harness.controller.acquireUpdateQuiescence()
    await expect(harness.controller.acquireUpdateQuiescence())
      .rejects.toBeInstanceOf(UpdateQuiescenceUnavailableError)
    lease.release()
    await harness.controller.stop()
  })

  it('gates every public mutation while keeping snapshots readable', async () => {
    const harness = await createHarness()
    const controller = harness.controller
    const projectId = controller.snapshot().selectedProjectId!
    const sessionId = harness.sessionId
    const candidate = controller.migrationSnapshot()
    const lease = await controller.acquireUpdateQuiescence()

    expect(controller.snapshot().selectedSessionId).toBe(sessionId)
    expect(controller.migrationSnapshot().selectedSessionId).toBe(sessionId)

    expect(() => controller.setCliVersion(process.execPath, '1.0.5')).toThrow(UpdateQuiescenceUnavailableError)
    expect(() => controller.moveProject(projectId, 'down')).toThrow(UpdateQuiescenceUnavailableError)
    expect(() => controller.setProjectPinned(projectId, true)).toThrow(UpdateQuiescenceUnavailableError)
    expect(() => controller.setSessionPinned(sessionId, true)).toThrow(UpdateQuiescenceUnavailableError)
    expect(() => controller.cancelTurn(sessionId)).toThrow(UpdateQuiescenceUnavailableError)
    expect(() => controller.updateSession({ sessionId, mode: 'plan' })).toThrow(UpdateQuiescenceUnavailableError)

    const blocked = [
      controller.applyMigrationState(candidate),
      controller.addProject(process.cwd()),
      controller.selectProject(projectId),
      controller.createSession(projectId),
      controller.selectSession(sessionId),
      controller.removeProject(projectId),
      controller.closeSession(sessionId),
      controller.duplicateSession(sessionId),
      controller.forkSession(sessionId),
      controller.stageAttachments(sessionId, []),
      controller.prepareAttachments(sessionId),
      controller.cancelAttachments(sessionId, 'opaque-token'),
      controller.sendPrompt(sessionId, 'must stay blocked'),
      controller.retrySession(sessionId),
      controller.answerPermission(sessionId, 'request', 'allow_once'),
      controller.answerInteraction(sessionId, 'interaction', {
        kind: 'plan',
        decision: 'approved'
      }),
      controller.updateSettings({ reduceMotion: true }),
      controller.setGrokCliPath(process.execPath)
    ]
    for (const operation of blocked) {
      await expect(operation).rejects.toBeInstanceOf(UpdateQuiescenceUnavailableError)
    }

    lease.release()
    lease.release()
    await controller.stop()
  })

  it('drains every worker before resolving and reconnects the selected session once on release', async () => {
    const stopGate = deferred<void>()
    const harness = await createHarness(stopGate.promise)
    let acquired: UpdateQuiescenceLease | undefined
    const acquiring = harness.controller.acquireUpdateQuiescence().then((lease) => {
      acquired = lease
      return lease
    })

    await eventually(() => harness.connections[0]?.stopCount === 1)
    expect(acquired).toBeUndefined()
    stopGate.resolve()
    const lease = await acquiring
    expect(harness.connections).toHaveLength(1)

    lease.release()
    lease.release()
    await eventually(() => harness.connections.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(harness.connections).toHaveLength(2)
    expect(harness.connections[1]?.startCount).toBe(1)
    await harness.controller.stop()
  })

  it('treats persistence failure as acquisition failure, unlocks, and restores the selected worker', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const root = await temporaryRoot()
    const store = new ToggleStateStore(join(root, 'state.json'), process.execPath)
    const harness = await createHarness(undefined, store)
    store.failSaves = true

    const error = await rejection(harness.controller.acquireUpdateQuiescence())
    expect(error).toBeInstanceOf(UpdateQuiescenceUnavailableError)
    expect(String(error)).not.toContain('private persistence failure')
    await eventually(() => harness.connections.length === 2)

    store.failSaves = false
    await expect(harness.controller.updateSettings({ reduceMotion: true })).resolves.toBeUndefined()
    await harness.controller.stop()
  })

  it('lets normal stop finish with a held lease and never reconnects after release', async () => {
    const harness = await createHarness()
    const lease = await harness.controller.acquireUpdateQuiescence()
    expect(harness.connections).toHaveLength(1)

    await expect(harness.controller.stop()).resolves.toBeUndefined()
    lease.release()
    lease.release()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(harness.connections).toHaveLength(1)
    expect(harness.connections[0]?.stopCount).toBe(1)
  })
})

interface ControllerInternals {
  state: PersistedState
  stopping: boolean
  migrationApplying: boolean
  migrationOperation: Promise<void> | undefined
  destructivePersistenceTransactions: number
  forkStarts: Map<string, Promise<SessionSnapshot>>
  retryStarts: Map<string, Promise<void>>
  sessionLifecycleLocks: Set<string>
  projectRemovalLocks: Set<string>
  connectionStarts: Map<string, { client: AcpConnection; promise: Promise<AcpConnection> }>
  workspaceHealthChecks: Map<string, {
    project: ProjectSnapshot
    path: string
    promise: Promise<WorkspaceHealthState>
  }>
}

function controllerInternals(controller: AppController): ControllerInternals {
  return controller as unknown as ControllerInternals
}

async function createHarness(
  firstStopGate?: Promise<void>,
  store?: AppStateStore
): Promise<{
  controller: AppController
  connections: QuiescenceConnection[]
  sessionId: string
}> {
  const root = store ? undefined : await temporaryRoot()
  const connections: QuiescenceConnection[] = []
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store: store ?? new AppStateStore(join(root!, 'state.json'), process.execPath),
    seedProjectPath: process.cwd(),
    acpFactory: (options: AcpConnectionOptions) => {
      const connection = new QuiescenceConnection(
        options.localSessionId,
        connections.length === 0 ? firstStopGate : undefined
      )
      connections.push(connection)
      return connection
    }
  })
  await controller.initialize()
  const projectId = controller.snapshot().projects[0]!.id
  const sessionId = (await controller.createSession(projectId)).id
  await controller.sendPrompt(sessionId, 'establish a resumable idle worker')
  await eventually(() => {
    const session = controller.snapshot().sessions.find((candidate) => candidate.id === sessionId)
    return connections.length === 1 && session?.status === 'idle'
  })
  return { controller, connections, sessionId }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-update-quiescence-'))
  roots.push(root)
  return root
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for update-quiescence state.')
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject.')
}
