import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AppController,
  ForkSessionUnavailableError
} from '../../src/main/AppController'
import type { AcpStartResult } from '../../src/main/acp/AcpClient'
import type {
  AcpConnection,
  AcpConnectionEvents,
  AcpConnectionOptions
} from '../../src/main/acp/AcpConnection'
import {
  AppStateStore,
  defaultState
} from '../../src/main/persistence/AppStateStore'
import {
  WorkspaceHealthService,
  type WorkspaceIdentity
} from '../../src/main/workspaces/WorkspaceHealthService'
import type { AttachmentPrompt } from '../../src/shared/attachments'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ))
})

type ForkProfile =
  | 'success'
  | 'method-not-found'
  | 'wrong-id'
  | 'load-failure'
  | 'buffered-exit'
  | 'buffered-error'
  | 'overflow'

class ForkConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  readonly prompts: AttachmentPrompt[] = []
  stopCount = 0

  constructor(
    readonly options: AcpConnectionOptions,
    private readonly profile: ForkProfile,
    private readonly gate?: Promise<void>
  ) {
    super()
  }

  start = async (): Promise<AcpStartResult> => {
    if (!this.options.forkSession) {
      return {
        sessionId: this.options.resumeSessionId
          ?? '10000000-0000-4000-8000-000000000001',
        resumed: Boolean(this.options.resumeSessionId)
      }
    }
    await this.gate
    this.emit('capabilities', {
      currentModelId: this.options.model,
      availableModels: [{ id: this.options.model, name: 'Fork model' }],
      currentModeId: 'default',
      availableModes: [{ id: 'default', name: 'Agent' }]
    })
    this.emit('update', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'FORK_REPLAY_MUST_NOT_APPEAR' },
      _meta: { isReplay: true }
    })
    if (this.profile === 'method-not-found') {
      throw new Error('method not found /private/QA_FORK_SECRET')
    }
    if (this.profile === 'load-failure') {
      throw new Error('child load failed /private/QA_FORK_SECRET')
    }
    if (this.profile === 'buffered-exit') this.emit('exit', 1, null)
    if (this.profile === 'buffered-error') {
      this.emit('stderr', 'unexpected error /private/QA_FORK_SECRET')
    }
    if (this.profile === 'overflow') {
      this.emit('update', { payload: 'x'.repeat(1024 * 1024) })
    }
    return {
      sessionId: this.profile === 'wrong-id'
        ? '20000000-0000-4000-8000-000000000099'
        : this.options.forkSession.newSessionId,
      resumed: false,
      forkedFrom: this.options.forkSession.sourceSessionId
    }
  }

  prompt = async (prompt: AttachmentPrompt): Promise<void> => {
    this.prompts.push(structuredClone(prompt))
  }
  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => { this.stopCount += 1 }
}

describe('AppController session fork', () => {
  it('atomically forks an idle durable session, prompts the child, and resumes it without reforking', async () => {
    const harness = await createHarness('success')
    const source = await createDurableSource(harness)
    const sourceInternal = harness.controller.migrationSnapshot().sessions.find(
      (session) => session.id === source.id
    )!
    harness.controller.updateSession({
      sessionId: source.id,
      reasoningEffort: 'max',
      permissionMode: 'auto'
    })
    const originalConnection = harness.createdConnections.find(
      (connection) => connection.options.localSessionId === source.id
    )!
    await eventually(() => originalConnection.stopCount === 1)
    await harness.controller.selectSession(source.id)
    await eventually(() => harness.options.filter((options) =>
      options.localSessionId === source.id
    ).length >= 2)

    const forked = await harness.controller.forkSession(source.id)
    const forkOptions = harness.options.find((options) => options.forkSession)?.forkSession
    expect(forkOptions).toEqual({
      sourceSessionId: sourceInternal.acpSessionId,
      newSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      newModelId: source.model
    })
    expect(forked).toMatchObject({
      title: `Fork of ${source.title}`,
      status: 'idle',
      model: source.model,
      mode: source.mode,
      reasoningEffort: 'max',
      permissionMode: 'auto'
    })
    expect(forked.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message', role: 'user', text: 'seed the fork' })
    ]))
    expect(JSON.stringify(forked.transcript)).not.toContain('FORK_REPLAY_MUST_NOT_APPEAR')
    expect(forked).not.toHaveProperty('pendingPermission')
    expect(forked).not.toHaveProperty('pendingInteraction')
    expect(forked).not.toHaveProperty('pendingHookRuns')
    expect(harness.controller.migrationSnapshot().selectedSessionIdByProject[harness.projectId])
      .toBe(forked.id)

    const publicSnapshot = harness.controller.snapshot()
    expect(publicSnapshot.sessions.find((session) => session.id === forked.id)?.canFork).toBe(true)
    expect(JSON.stringify(publicSnapshot)).not.toContain(sourceInternal.acpSessionId)
    expect(JSON.stringify(publicSnapshot)).not.toContain(forkOptions?.newSessionId)
    expect(JSON.stringify(publicSnapshot)).not.toContain('chatMessagesCopied')
    expect(JSON.stringify(publicSnapshot)).not.toContain('updatesCopied')
    expect(JSON.stringify(publicSnapshot)).not.toContain('parentSessionId')

    await harness.controller.sendPrompt(forked.id, 'child prompt')
    await eventually(() => harness.connections.get(forked.id)?.prompts.length === 1)
    await harness.controller.stop()

    const restartedOptions: AcpConnectionOptions[] = []
    const restarted = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(harness.statePath, process.execPath),
      acpFactory: (options) => {
        restartedOptions.push(options)
        return new ForkConnection(options, 'success')
      }
    })
    const restored = await restarted.initialize()
    restarted.setCliVersion(process.execPath, 'grok 1.0.5')
    expect(restored.selectedSessionId).toBe(forked.id)
    await restarted.selectSession(forked.id)
    await eventually(() => restartedOptions.length === 1)
    expect(restartedOptions[0]).toMatchObject({
      resumeSessionId: forkOptions?.newSessionId
    })
    expect(restartedOptions[0]).not.toHaveProperty('forkSession')
    await restarted.stop()
  })

  for (const profile of [
    'method-not-found',
    'wrong-id',
    'load-failure',
    'buffered-exit',
    'buffered-error',
    'overflow'
  ] as const) {
    it(`rolls back every local trace after ${profile}`, async () => {
      const harness = await createHarness(profile)
      const source = await createDurableSource(harness)
      await harness.controller.updateSettings({ maxLiveSessions: 1 })
      const sourceConnection = harness.createdConnections.find(
        (connection) => connection.options.localSessionId === source.id
      )!
      const before = harness.controller.migrationSnapshot()

      await expect(harness.controller.forkSession(source.id)).rejects.toThrow(
        'Grok reported an unexpected error. Retry the request.'
      )

      expect(harness.controller.migrationSnapshot()).toEqual(before)
      expect(harness.controller.snapshot().selectedSessionId).toBe(source.id)
      expect(harness.connections.size).toBe(2)
      const forkConnection = [...harness.connections.values()].find(
        (connection) => connection.options.forkSession
      )
      expect(forkConnection?.stopCount).toBeGreaterThan(0)
      expect(sourceConnection.stopCount).toBe(0)
      expect(JSON.stringify(harness.controller.snapshot())).not.toContain('QA_FORK_SECRET')
      await harness.controller.stop()
    })
  }

  it('locks source mutations and fails closed if the source changes before commit', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const harness = await createHarness('success', gate)
    const source = await createDurableSource(harness)
    const before = harness.controller.migrationSnapshot()
    const forking = harness.controller.forkSession(source.id)
    await eventually(() => harness.options.some((options) => options.forkSession))

    await expect(harness.controller.sendPrompt(source.id, 'race')).rejects.toBeInstanceOf(
      ForkSessionUnavailableError
    )
    await expect(harness.controller.duplicateSession(source.id)).rejects.toBeInstanceOf(
      ForkSessionUnavailableError
    )
    await expect(harness.controller.closeSession(source.id)).rejects.toBeInstanceOf(
      ForkSessionUnavailableError
    )
    await expect(harness.controller.removeProject(harness.projectId)).rejects.toBeInstanceOf(
      ForkSessionUnavailableError
    )
    expect(() => harness.controller.cancelTurn(source.id)).toThrow(ForkSessionUnavailableError)
    await expect(harness.controller.answerPermission(source.id, 'request', 'allow_once'))
      .rejects.toBeInstanceOf(ForkSessionUnavailableError)
    await expect(harness.controller.answerInteraction(source.id, 'interaction', {
      kind: 'plan', decision: 'approved'
    })).rejects.toBeInstanceOf(ForkSessionUnavailableError)

    harness.connections.get(source.id)!.emit('capabilities', {
      currentModelId: 'changed-during-fork',
      availableModels: [{ id: 'changed-during-fork', name: 'Changed' }],
      currentModeId: 'default',
      availableModes: [{ id: 'default', name: 'Agent' }]
    })
    release()
    await expect(forking).rejects.toThrow('Grok reported an unexpected error. Retry the request.')
    const after = harness.controller.migrationSnapshot()
    expect(after.sessions).toHaveLength(before.sessions.length)
    expect(after.sessions[0]?.transcript).toEqual(before.sessions[0]?.transcript)
    await harness.controller.stop()
  })

  it('rejects a fork when the workspace directory is replaced at the same path during the RPC', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const harness = await createHarness('success', gate)
    const source = await createDurableSource(harness)
    const before = harness.controller.migrationSnapshot()
    const forking = harness.controller.forkSession(source.id)
    await eventually(() => harness.options.some((options) => options.forkSession))

    const projectPath = join(harness.root, 'project')
    await rename(projectPath, join(harness.root, 'replaced-project'))
    await mkdir(projectPath)
    release()

    await expect(forking).rejects.toThrow('The workspace location changed.')
    expect(harness.controller.migrationSnapshot()).toEqual(before)
    const forkConnection = harness.createdConnections.find((connection) => connection.options.forkSession)
    expect(forkConnection?.stopCount).toBeGreaterThan(0)
    await harness.controller.stop()
  })

  it('reports a fixed failure and rolls back if the fork commit cannot be persisted', async () => {
    const harness = await createHarness('success')
    const source = await createDurableSource(harness)
    const before = harness.controller.migrationSnapshot()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const originalSave = harness.store.save.bind(harness.store)
    harness.store.save = async () => {
      throw new Error('/private/QA_FORK_PERSIST_SECRET')
    }
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(harness.controller.forkSession(source.id)).rejects.toThrow(
        'Grok reported an unexpected error. Retry the request.'
      )
      expect(harness.controller.migrationSnapshot()).toEqual(before)
      expect(JSON.stringify(harness.controller.snapshot())).not.toContain('QA_FORK_PERSIST_SECRET')
      expect(JSON.stringify(logger.mock.calls)).not.toContain('QA_FORK_PERSIST_SECRET')
    } finally {
      harness.store.save = originalSave
      logger.mockRestore()
      await harness.controller.stop()
    }
  })

  it('never spawns a fork worker after shutdown wins a slow identity check', async () => {
    const identity = deferred<WorkspaceIdentity | undefined>()
    const health = new SlowIdentityWorkspaceHealthService(identity.promise)
    const harness = await createHarness('success', undefined, undefined, health)
    const source = await createDurableSource(harness)
    const createdBeforeFork = harness.createdConnections.length
    const forking = harness.controller.forkSession(source.id)
    void forking.catch(() => undefined)
    await health.started

    await harness.controller.stop()
    identity.resolve({ device: 1n, inode: 1n })
    await expect(forking).rejects.toThrow('Grok reported an unexpected error.')
    expect(harness.createdConnections).toHaveLength(createdBeforeFork)
    expect(harness.controller.migrationSnapshot().sessions).toHaveLength(1)
  })

  it('keeps idle but unsettled sources non-forkable', async () => {
    const harness = await createHarness('success')
    const source = await createDurableSource(harness)
    const mutable = harness.controller as unknown as {
      updateSessionRecord: (
        sessionId: string,
        update: (current: typeof source) => typeof source
      ) => void
    }
    const unsettled = [
      {
        pendingPermission: {
          requestId: 'request', sessionId: source.acpSessionId!, title: 'Approve?',
          options: [{ id: 'allow_once', label: 'Allow once' }]
        }
      },
      {
        pendingInteraction: {
          kind: 'plan' as const, interactionId: 'interaction', sessionId: source.acpSessionId!,
          planContent: 'Plan'
        }
      },
      { pendingHookRuns: 1 },
      {
        transcript: source.transcript.map((item, index) =>
          index === source.transcript.length - 1 && item.kind === 'message'
            ? { ...item, streaming: true }
            : item
        )
      },
      {
        transcript: [{
          id: 'running-tool', kind: 'tool' as const, title: 'Running tool',
          status: 'running' as const, createdAt: source.updatedAt
        }]
      },
      {
        transcript: [{
          id: 'open-activity', kind: 'activity' as const, entries: [], hookCount: 0,
          isLead: false, open: true, createdAt: source.updatedAt
        }]
      }
    ]

    for (const condition of unsettled) {
      mutable.updateSessionRecord(source.id, () => ({
        ...structuredClone(source),
        ...condition,
        status: 'idle'
      }))
      expect(harness.controller.snapshot().sessions.find(
        (session) => session.id === source.id
      )?.canFork).toBe(false)
      await expect(harness.controller.forkSession(source.id)).rejects.toThrow(
        'Only an idle, settled session can be forked.'
      )
    }
    expect(harness.options.filter((options) => options.forkSession)).toHaveLength(0)
    await harness.controller.stop()
  })

  it('keeps fork disabled for non-UUID legacy remote ids and old CLI versions', async () => {
    const harness = await createHarness('success', undefined, 'legacy-remote-id')
    const source = await createDurableSource(harness)
    expect(harness.controller.snapshot().sessions.find((session) => session.id === source.id)?.canFork)
      .toBe(false)
    await expect(harness.controller.forkSession(source.id)).rejects.toThrow(
      'Start this session before forking it.'
    )

    await harness.controller.stop()

    const oldCli = await createHarness('success')
    const validSource = await createDurableSource(oldCli)
    oldCli.controller.setCliVersion(process.execPath, 'grok 1.0.4')
    expect(oldCli.controller.snapshot().sessions.find(
      (session) => session.id === validSource.id
    )?.canFork).toBe(false)
    await expect(oldCli.controller.forkSession(validSource.id)).rejects.toThrow(
      'Grok CLI 1.0.5 or newer is required to fork sessions.'
    )
    const canary = 'QA_CLI_VERSION_SECRET_19A7'
    oldCli.controller.setCliVersion(process.execPath, `grok 1.0.5 token=${canary}`)
    expect(oldCli.controller.snapshot().cli.version).toBeUndefined()
    expect(JSON.stringify(oldCli.controller.snapshot())).not.toContain(canary)
    expect(oldCli.controller.snapshot().sessions.find(
      (session) => session.id === validSource.id
    )?.canFork).toBe(false)
    await oldCli.controller.stop()
  })

  it('rejects the 10,000-session boundary before creating a fork worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-fork-count-preflight-'))
    temporaryRoots.push(root)
    const projectPathInput = join(root, 'project')
    await mkdir(projectPathInput)
    const projectPath = await realpath(projectPathInput)
    const state = defaultState(process.execPath)
    const timestamp = '2026-08-25T00:00:00.000Z'
    const projectId = 'project-1'
    const sourceRemoteId = '10000000-0000-4000-8000-000000000001'
    state.projects = [{
      id: projectId, name: 'Project', path: projectPath,
      sessionIds: Array.from({ length: 10_000 }, (_, index) => `session-${index}`),
      createdAt: timestamp
    }]
    state.sessions = state.projects[0]!.sessionIds.map((id, index) => ({
      id,
      ...(index === 0 ? { acpSessionId: sourceRemoteId } : {}),
      projectId,
      title: id,
      status: 'idle' as const,
      model: 'grok-4.6',
      mode: 'default' as const,
      reasoningEffort: 'xhigh' as const,
      permissionMode: 'ask' as const,
      contextUsed: 0,
      contextLimit: 500_000,
      transcript: [],
      createdAt: timestamp,
      updatedAt: timestamp
    }))
    state.selectedProjectId = projectId
    state.selectedSessionId = 'session-0'
    state.selectedSessionIdByProject = { [projectId]: 'session-0' }
    const store = new AppStateStore(join(root, 'state.json'), process.execPath)
    await store.save(state)
    const created: AcpConnectionOptions[] = []
    const controller = new AppController({
      appVersion: 'test', cliPath: process.execPath, store,
      acpFactory: (options) => {
        created.push(options)
        return new ForkConnection(options, 'success')
      }
    })
    await controller.initialize()
    controller.setCliVersion(process.execPath, 'grok 1.0.5')

    expect(controller.snapshot().sessions[0]?.canFork).toBe(false)
    await expect(controller.forkSession('session-0')).rejects.toThrow(
      'saved workspace limit was reached'
    )
    expect(created).toEqual([])
    await controller.stop()
  })

  it('rejects a projected fork over 64 MiB before creating a fork worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-fork-size-preflight-'))
    temporaryRoots.push(root)
    const projectPathInput = join(root, 'project')
    await mkdir(projectPathInput)
    const projectPath = await realpath(projectPathInput)
    const state = defaultState(process.execPath)
    const timestamp = '2026-08-25T00:00:00.000Z'
    const projectId = 'project-1'
    const sourceId = 'source-session'
    state.projects = [{
      id: projectId, name: 'Project', path: projectPath,
      sessionIds: [sourceId], createdAt: timestamp
    }]
    const largeText = 'x'.repeat(2 * 1024 * 1024)
    state.sessions = [{
      id: sourceId,
      acpSessionId: '10000000-0000-4000-8000-000000000001',
      projectId,
      title: 'Large source',
      status: 'idle',
      model: 'grok-4.6',
      mode: 'default',
      reasoningEffort: 'xhigh',
      permissionMode: 'ask',
      contextUsed: 0,
      contextLimit: 500_000,
      transcript: Array.from({ length: 16 }, (_, index) => ({
        id: `message-${index}`,
        kind: 'message' as const,
        role: 'assistant' as const,
        text: largeText,
        createdAt: timestamp
      })),
      createdAt: timestamp,
      updatedAt: timestamp
    }]
    state.selectedProjectId = projectId
    state.selectedSessionId = sourceId
    state.selectedSessionIdByProject = { [projectId]: sourceId }
    const store = new AppStateStore(join(root, 'state.json'), process.execPath)
    await store.save(state)
    const created: AcpConnectionOptions[] = []
    const controller = new AppController({
      appVersion: 'test', cliPath: process.execPath, store,
      acpFactory: (options) => {
        created.push(options)
        return new ForkConnection(options, 'success')
      }
    })
    await controller.initialize()
    controller.setCliVersion(process.execPath, 'grok 1.0.5')

    await expect(controller.forkSession(sourceId)).rejects.toThrow(
      'saved workspace limit was reached'
    )
    expect(created).toEqual([])
    await controller.stop()
  }, 20_000)
})

async function createHarness(
  profile: ForkProfile,
  gate?: Promise<void>,
  newSessionId = '10000000-0000-4000-8000-000000000001',
  workspaceHealthService?: WorkspaceHealthService
): Promise<{
  root: string
  statePath: string
  projectId: string
  controller: AppController
  store: AppStateStore
  connections: Map<string, ForkConnection>
  createdConnections: ForkConnection[]
  options: AcpConnectionOptions[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-fork-controller-'))
  temporaryRoots.push(root)
  const projectPath = join(root, 'project')
  const statePath = join(root, 'state.json')
  await mkdir(projectPath)
  const connections = new Map<string, ForkConnection>()
  const createdConnections: ForkConnection[] = []
  const optionsSeen: AcpConnectionOptions[] = []
  const store = new AppStateStore(statePath, process.execPath)
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store,
    seedProjectPath: projectPath,
    ...(workspaceHealthService ? { workspaceHealthService } : {}),
    acpFactory: (options) => {
      optionsSeen.push(options)
      const connection = new ForkConnection(options, profile, options.forkSession ? gate : undefined)
      if (!options.forkSession && !options.resumeSessionId) {
        connection.start = async () => ({ sessionId: newSessionId, resumed: false })
      }
      connections.set(options.localSessionId, connection)
      createdConnections.push(connection)
      return connection
    }
  })
  const initialized = await controller.initialize()
  controller.setCliVersion(process.execPath, 'grok 1.0.5 (qa)')
  return {
    root,
    statePath,
    projectId: initialized.projects[0]!.id,
    controller,
    store,
    connections,
    createdConnections,
    options: optionsSeen
  }
}

class SlowIdentityWorkspaceHealthService extends WorkspaceHealthService {
  private readonly startedGate = deferred<void>()

  constructor(private readonly result: Promise<WorkspaceIdentity | undefined>) {
    super()
  }

  get started(): Promise<void> {
    return this.startedGate.promise
  }

  override async identity(): Promise<WorkspaceIdentity | undefined> {
    this.startedGate.resolve()
    return this.result
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

async function createDurableSource(
  harness: Awaited<ReturnType<typeof createHarness>>
): Promise<ReturnType<AppController['migrationSnapshot']>['sessions'][number]> {
  const source = await harness.controller.createSession(harness.projectId)
  await harness.controller.sendPrompt(source.id, 'seed the fork')
  await eventually(() => Boolean(
    harness.controller.migrationSnapshot().sessions.find((session) => session.id === source.id)
      ?.acpSessionId &&
    harness.controller.migrationSnapshot().sessions.find((session) => session.id === source.id)
      ?.status === 'idle'
  ))
  return harness.controller.migrationSnapshot().sessions.find((session) => session.id === source.id)!
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condition did not become true')
}
