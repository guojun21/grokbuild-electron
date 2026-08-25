import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AppController,
  SavedAgentOperationUnavailableError
} from '../../src/main/AppController'
import type { AcpConnection, AcpConnectionEvents } from '../../src/main/acp/AcpConnection'
import type { AcpStartResult } from '../../src/main/acp/AcpClient'
import type { AttachmentPrompt } from '../../src/shared/attachments'
import type { InteractionAnswer } from '../../src/shared/acp/interactions'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'
import {
  AGENT_ROSTER_FILE_NAME,
  AgentRosterStore
} from '../../src/main/agents/AgentRosterStore'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface AgentConnectionHooks {
  beforeStart?: () => Promise<void>
  beforeStop?: () => Promise<void>
}

class AgentConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  stopCount = 0
  promptCount = 0

  constructor(
    readonly options: Parameters<NonNullable<ConstructorParameters<typeof AppController>[0]['acpFactory']>>[0],
    private readonly beforeForkStart?: (() => Promise<void>) | undefined,
    private readonly hooks: AgentConnectionHooks = {}
  ) {
    super()
  }

  async start(): Promise<AcpStartResult> {
    await this.hooks.beforeStart?.()
    if (this.options.forkSession) {
      await this.beforeForkStart?.()
      return {
        sessionId: this.options.forkSession.newSessionId,
        resumed: false,
        forkedFrom: this.options.forkSession.sourceSessionId
      }
    }
    return {
      sessionId: this.options.resumeSessionId ?? '10000000-0000-4000-8000-000000000001',
      resumed: Boolean(this.options.resumeSessionId)
    }
  }

  async prompt(_prompt: AttachmentPrompt): Promise<void> { this.promptCount += 1 }
  cancel(): void {}
  async setModel(): Promise<void> {}
  async setMode(): Promise<void> {}
  async answerPermission(): Promise<void> {}
  async answerInteraction(_interactionId: string, _answer: InteractionAnswer): Promise<void> {}
  async stop(): Promise<void> {
    this.stopCount += 1
    await this.hooks.beforeStop?.()
  }
}

describe('AppController saved-agent runtime', () => {
  it('projects only local safe summaries and injects the persisted binding on reconnect', async () => {
    const harness = await createHarness()
    const session = await harness.controller.createSession(harness.projectId)
    const agent = await harness.controller.createSavedAgent(0, {
      name: 'Boundary Reviewer',
      mission: 'Review trust boundaries.',
      roleName: 'boundary_reviewer',
      lastSessionId: session.id,
      preferredSkills: ['security']
    })
    await (harness.controller as unknown as {
      ensureConnected(sessionId: string): Promise<AcpConnection>
    }).ensureConnected(session.id)
    const transcriptBefore = harness.controller.migrationSnapshot().sessions[0]!.transcript

    const bound = await harness.controller.bindSavedAgent(session.id, agent.id, 1)
    expect(bound).toMatchObject({
      savedAgentId: agent.id,
      savedAgent: { name: 'Boundary Reviewer', glyph: 'person.fill', color: '#5E5CE6' }
    })
    expect(harness.options).toHaveLength(2)
    expect(harness.options[0]).not.toHaveProperty('agentProfile')
    expect(harness.options[1]?.agentProfile).toEqual({
      name: 'boundary_reviewer',
      description: 'Review trust boundaries.',
      promptBody: 'You are Boundary Reviewer.\n\nInstructions: Review trust boundaries.'
    })
    expect(harness.connections[0]?.stopCount).toBe(1)
    expect(harness.controller.migrationSnapshot().sessions[0]!.transcript).toEqual(transcriptBefore)

    const serialized = JSON.stringify(harness.controller.snapshot())
    expect(serialized).not.toContain('promptBody')
    expect(serialized).not.toContain('lastSessionId')
    expect(serialized).not.toContain(AGENT_ROSTER_FILE_NAME)
    expect(serialized).not.toContain('10000000-0000-4000-8000-000000000001')
    expect(harness.controller.snapshot().agentRoster).toMatchObject({
      status: 'ready',
      revision: 2,
      agents: [{ id: agent.id, name: 'Boundary Reviewer' }]
    })
    expect(serialized).not.toContain('boundary_reviewer')
    await harness.controller.stop()
  })

  it('inherits duplicate bindings before insertion and delete safely recycles to default', async () => {
    const harness = await createHarness()
    const source = await harness.controller.createSession(harness.projectId)
    const created = await harness.controller.createSavedAgent(0, agentDraft())
    await harness.controller.bindSavedAgent(source.id, created.id, 1)
    const duplicate = await harness.controller.duplicateSession(source.id)

    expect(harness.controller.snapshot().sessions.find((item) => item.id === duplicate.id))
      .toMatchObject({ savedAgentId: created.id })
    const afterDuplicate = await harness.rosterStore.load()
    expect(afterDuplicate.status).toBe('ready')
    if (afterDuplicate.status !== 'ready') throw new Error('Expected ready roster')
    expect(afterDuplicate.roster.sessionBindings).toMatchObject({
      [source.id]: created.id,
      [duplicate.id]: created.id
    })

    const sourceTranscript = structuredClone(
      harness.controller.migrationSnapshot().sessions.find((item) => item.id === source.id)!.transcript
    )
    await harness.controller.deleteSavedAgent(afterDuplicate.roster.revision, created.id)
    expect(harness.controller.snapshot().sessions.find((item) => item.id === source.id))
      .not.toHaveProperty('savedAgentId')
    expect(harness.controller.migrationSnapshot().sessions.find((item) => item.id === source.id)!.transcript)
      .toEqual(sourceTranscript)
    expect(harness.options.slice(-2).every((options) => options.agentProfile === undefined)).toBe(true)
    const deleted = await harness.rosterStore.load()
    expect(deleted.status === 'ready' ? deleted.roster.sessionBindings : null).toEqual({})
    await harness.controller.stop()
  })

  it('keeps the old public roster through delayed stop and reconnect, then publishes deletion once', async () => {
    let gateRecycle = false
    const stopStarted = deferred<void>()
    const stopGate = deferred<void>()
    const reconnectStarted = deferred<void>()
    const reconnectGate = deferred<void>()
    const harness = await createHarness(undefined, () => ({
      beforeStop: async () => {
        if (!gateRecycle) return
        stopStarted.resolve(undefined)
        await stopGate.promise
      },
      beforeStart: async () => {
        if (!gateRecycle) return
        reconnectStarted.resolve(undefined)
        await reconnectGate.promise
      }
    }))
    const session = await harness.controller.createSession(harness.projectId)
    const agent = await harness.controller.createSavedAgent(0, agentDraft())
    await (harness.controller as unknown as {
      ensureConnected(sessionId: string): Promise<AcpConnection>
    }).ensureConnected(session.id)
    await harness.controller.bindSavedAgent(session.id, agent.id, 1)
    await new Promise((resolve) => setTimeout(resolve, 25))

    const published: Array<ReturnType<AppController['snapshot']>> = []
    harness.controller.on('changed', (snapshot) => published.push(snapshot))
    gateRecycle = true
    const deletion = harness.controller.deleteSavedAgent(2, agent.id)
    await stopStarted.promise

    const durableDuringStop = await harness.rosterStore.load()
    expect(durableDuringStop.status === 'ready' ? durableDuringStop.roster.agents : null).toEqual([])
    expect(harness.controller.snapshot()).toMatchObject({
      agentRoster: { status: 'ready', revision: 2, agents: [{ id: agent.id }] },
      sessions: [{ id: session.id, savedAgentId: agent.id }]
    })
    await expect(harness.controller.sendPrompt(session.id, 'must remain visibly pending'))
      .rejects.toThrow('current session operation')
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(published.every((snapshot) =>
      snapshot.agentRoster.status === 'ready' && snapshot.agentRoster.agents.some(
        (candidate) => candidate.id === agent.id
      )
    )).toBe(true)

    stopGate.resolve(undefined)
    await reconnectStarted.promise
    expect(harness.controller.snapshot()).toMatchObject({
      agentRoster: { status: 'ready', revision: 2, agents: [{ id: agent.id }] },
      sessions: [{ id: session.id, savedAgentId: agent.id }]
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(published.every((snapshot) =>
      snapshot.agentRoster.status === 'ready' && snapshot.agentRoster.agents.some(
        (candidate) => candidate.id === agent.id
      )
    )).toBe(true)

    reconnectGate.resolve(undefined)
    await deletion
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(harness.controller.snapshot().agentRoster).toEqual({
      status: 'ready', revision: 3, agents: []
    })
    expect(harness.controller.snapshot().sessions.find((item) => item.id === session.id))
      .not.toHaveProperty('savedAgentId')
    expect(published.filter((snapshot) => snapshot.agentRoster.revision === 3)).toHaveLength(1)

    await expect(harness.controller.sendPrompt(session.id, 'uses the default identity')).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(harness.options.at(-1)).not.toHaveProperty('agentProfile')
    expect(harness.connections.at(-1)?.promptCount).toBe(1)
    gateRecycle = false
    await harness.controller.stop()
  })

  it('publishes a durable deletion but leaves the session offline when reconnect fails', async () => {
    let failNextStart = false
    const harness = await createHarness(undefined, () => ({
      beforeStart: async () => {
        if (!failNextStart) return
        failNextStart = false
        throw new Error('PRIVATE_RECONNECT_CANARY')
      }
    }))
    const session = await harness.controller.createSession(harness.projectId)
    const agent = await harness.controller.createSavedAgent(0, agentDraft())
    await (harness.controller as unknown as {
      ensureConnected(sessionId: string): Promise<AcpConnection>
    }).ensureConnected(session.id)
    await harness.controller.bindSavedAgent(session.id, agent.id, 1)
    const oldProfileWorker = harness.connections.at(-1)!

    failNextStart = true
    await expect(harness.controller.deleteSavedAgent(2, agent.id)).rejects.toThrow(
      'saved-agent change was saved'
    )

    const durable = await harness.rosterStore.load()
    expect(durable.status === 'ready' ? durable.roster : null).toMatchObject({
      revision: 3,
      agents: [],
      sessionBindings: {}
    })
    expect(harness.controller.snapshot().agentRoster).toEqual({
      status: 'ready', revision: 3, agents: []
    })
    expect(harness.controller.snapshot().sessions.find((item) => item.id === session.id))
      .not.toHaveProperty('savedAgentId')
    expect(oldProfileWorker.stopCount).toBe(1)
    const failedDesiredWorker = harness.connections.at(-1)!
    expect(failedDesiredWorker).not.toBe(oldProfileWorker)
    expect(failedDesiredWorker.stopCount).toBe(1)
    expect((harness.controller as unknown as {
      sessions: { get(sessionId: string): AcpConnection | undefined }
    }).sessions.get(session.id)).toBeUndefined()

    await expect(harness.controller.sendPrompt(session.id, 'retry with durable identity'))
      .resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(harness.options.at(-1)).not.toHaveProperty('agentProfile')
    expect(oldProfileWorker.promptCount).toBe(0)
    expect(harness.connections.at(-1)?.promptCount).toBe(1)
    expect(JSON.stringify(harness.controller.snapshot())).not.toContain('PRIVATE_RECONNECT_CANARY')
    await harness.controller.stop()
  })

  it('fails closed on an invalid roster until explicit recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-controller-agent-invalid-'))
    roots.push(root)
    const projectPath = join(root, 'project')
    await mkdir(projectPath)
    const rosterPath = join(root, AGENT_ROSTER_FILE_NAME)
    await writeFile(rosterPath, '{"agents":"PRIVATE_INVALID_CANARY"}', 'utf8')
    const options: AgentConnection['options'][] = []
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(join(root, 'state.json'), process.execPath),
      seedProjectPath: projectPath,
      agentRosterStore: new AgentRosterStore(rosterPath),
      acpFactory: (connectionOptions) => {
        options.push(connectionOptions)
        return new AgentConnection(connectionOptions)
      }
    })
    const initialized = await controller.initialize()
    expect(initialized.agentRoster).toEqual({ status: 'invalid', revision: 0, reason: 'malformed' })
    const session = await controller.createSession(initialized.projects[0]!.id)
    await expect(controller.sendPrompt(session.id, 'must not connect')).rejects.toThrow(
      'explicitly recover'
    )
    expect(options).toEqual([])
    await expect(controller.createSavedAgent(0, agentDraft())).rejects.toThrow('explicitly recover')

    await expect(controller.recoverSavedAgentRoster(0)).resolves.toEqual({
      status: 'ready', revision: 0, agents: []
    })
    expect(JSON.stringify(controller.snapshot())).not.toContain('PRIVATE_INVALID_CANARY')
    expect((await readFile(root, 'utf8').catch(() => ''))).not.toContain('PRIVATE_INVALID_CANARY')
    await controller.stop()
  })

  it('preserves private lastSessionId through the narrow editor update', async () => {
    const harness = await createHarness()
    const session = await harness.controller.createSession(harness.projectId)
    const created = await harness.controller.createSavedAgent(0, {
      ...agentDraft(),
      lastSessionId: session.id
    })

    await harness.controller.updateSavedAgentEditor(1, created.id, {
      mission: 'Updated mission',
      roleName: null
    })

    const loaded = await harness.rosterStore.load()
    if (loaded.status !== 'ready') throw new Error('Expected ready roster')
    expect(loaded.roster.agents[0]).toMatchObject({
      id: created.id,
      mission: 'Updated mission',
      lastSessionId: session.id
    })
    expect(loaded.roster.agents[0]).not.toHaveProperty('roleName')
    await harness.controller.stop()
  })

  it('does not recycle a worker for cosmetic edits but rejects live profile changes', async () => {
    const harness = await createHarness()
    const session = await harness.controller.createSession(harness.projectId)
    const created = await harness.controller.createSavedAgent(0, agentDraft())
    await harness.controller.bindSavedAgent(session.id, created.id, 1)
    const activeConnection = harness.connections.at(-1)!
    const launchCount = harness.options.length
    ;(harness.controller as unknown as {
      updateSessionRecord(
        sessionId: string,
        update: (current: typeof session) => typeof session
      ): void
    }).updateSessionRecord(session.id, (current) => ({ ...current, status: 'running' }))

    await harness.controller.updateSavedAgentEditor(2, created.id, { isPinned: true })
    expect(harness.options).toHaveLength(launchCount)
    expect(activeConnection.stopCount).toBe(0)
    await expect(harness.controller.updateSavedAgentEditor(3, created.id, {
      mission: 'A changed runtime mission.'
    })).rejects.toThrow('stably idle')
    await expect(harness.controller.deleteSavedAgent(3, created.id)).rejects.toThrow('stably idle')
    await harness.controller.stop()
  })

  it('removes orphan local bindings during initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-controller-agent-orphan-'))
    roots.push(root)
    const projectPath = join(root, 'project')
    await mkdir(projectPath)
    const rosterStore = new AgentRosterStore(join(root, AGENT_ROSTER_FILE_NAME))
    const created = await rosterStore.create(0, agentDraft())
    await rosterStore.setSessionBinding(
      created.roster.revision,
      'orphan-local-session',
      created.value.id
    )
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(join(root, 'state.json'), process.execPath),
      seedProjectPath: projectPath,
      agentRosterStore: rosterStore
    })

    const initialized = await controller.initialize()
    expect(initialized.agentRoster).toMatchObject({ status: 'ready', revision: 3 })
    const loaded = await rosterStore.load()
    expect(loaded.status === 'ready' ? loaded.roster.sessionBindings : null).toEqual({})
    await controller.stop()
  })

  it('prewrites an inherited fork binding and compensates it when the remote fork fails', async () => {
    let harness!: Awaited<ReturnType<typeof createHarness>>
    let observedChildId: string | undefined
    harness = await createHarness(async () => {
      const forkOptions = harness.options.find((options) => options.forkSession)
      observedChildId = forkOptions?.localSessionId
      const duringFork = await harness.rosterStore.load()
      expect(duringFork.status === 'ready' && observedChildId
        ? duringFork.roster.sessionBindings[observedChildId]
        : undefined).toBeTruthy()
      throw new Error('private remote fork failure')
    })
    const source = await harness.controller.createSession(harness.projectId)
    await (harness.controller as unknown as {
      ensureConnected(sessionId: string): Promise<AcpConnection>
    }).ensureConnected(source.id)
    const agent = await harness.controller.createSavedAgent(0, agentDraft())
    await harness.controller.bindSavedAgent(source.id, agent.id, 1)

    await expect(harness.controller.forkSession(source.id)).rejects.toThrow(
      'Grok reported an unexpected error'
    )
    const loaded = await harness.rosterStore.load()
    if (loaded.status !== 'ready') throw new Error('Expected ready roster')
    expect(observedChildId).toBeTruthy()
    expect(loaded.roster.sessionBindings).toEqual({ [source.id]: agent.id })
    const forkLaunch = harness.options.find((options) => options.forkSession)
    expect(forkLaunch?.agentProfile?.name).toBe('local_verifier')
    await harness.controller.stop()
  })

  it('blocks concurrent runtime changes and lets stop drain a roster commit slower than its bounded diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-controller-agent-slow-'))
    roots.push(root)
    const projectPath = join(root, 'project')
    await mkdir(projectPath)
    const gate = deferred<void>()
    const started = deferred<void>()
    const rosterStore = new SlowBindingRosterStore(
      join(root, AGENT_ROSTER_FILE_NAME),
      started.resolve,
      gate.promise
    )
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(join(root, 'state.json'), process.execPath),
      seedProjectPath: projectPath,
      agentRosterStore: rosterStore,
      acpFactory: (options) => new AgentConnection(options)
    })
    const initialized = await controller.initialize()
    const session = await controller.createSession(initialized.projects[0]!.id)
    const agent = await controller.createSavedAgent(0, agentDraft())
    const binding = controller.bindSavedAgent(session.id, agent.id, 1)
    await started.promise

    await expect(controller.bindSavedAgent(session.id, null, 1)).rejects.toBeInstanceOf(
      SavedAgentOperationUnavailableError
    )
    await expect(controller.setGrokCliPath(process.execPath)).rejects.toBeInstanceOf(
      SavedAgentOperationUnavailableError
    )
    await expect(controller.applyMigrationState(controller.migrationSnapshot())).rejects.toThrow(
      'Wait for current session and project operations'
    )
    let stopped = false
    const stopping = controller.stop().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(stopped).toBe(false)
    gate.resolve(undefined)
    await Promise.all([binding, stopping])
    expect(stopped).toBe(true)

    const snapshotAtStop = controller.snapshot()
    const stateAtStop = controller.migrationSnapshot()
    const rosterAtStop = await rosterStore.load()
    expect(snapshotAtStop.sessions.find((item) => item.id === session.id)).toMatchObject({
      savedAgentId: agent.id
    })
    expect(stateAtStop.sessions.map((item) => item.id)).toContain(session.id)
    expect(rosterAtStop.status === 'ready'
      ? rosterAtStop.roster.sessionBindings[session.id]
      : undefined).toBe(agent.id)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(controller.snapshot()).toEqual(snapshotAtStop)
    expect(controller.migrationSnapshot()).toEqual(stateAtStop)
  })

  it('restores a precleared binding when closing the app-state transaction rolls back', async () => {
    const harness = await createHarness()
    const session = await harness.controller.createSession(harness.projectId)
    const agent = await harness.controller.createSavedAgent(0, agentDraft())
    await harness.controller.bindSavedAgent(session.id, agent.id, 1)
    await (harness.controller as unknown as {
      flushPersistence(requireSuccess: boolean): Promise<void>
    }).flushPersistence(true)
    const originalSave = harness.stateStore.save.bind(harness.stateStore)
    harness.stateStore.save = async () => { throw new Error('private state failure') }
    try {
      await expect(harness.controller.closeSession(session.id)).rejects.toThrow(
        'Application state could not be persisted'
      )
      expect(harness.controller.snapshot().sessions.find((item) => item.id === session.id))
        .toMatchObject({ savedAgentId: agent.id })
      const roster = await harness.rosterStore.load()
      expect(roster.status === 'ready' ? roster.roster.sessionBindings[session.id] : undefined)
        .toBe(agent.id)
    } finally {
      harness.stateStore.save = originalSave
      await harness.controller.stop()
    }
  })

  it('keeps local roster edits independent while catalog discovery remains bounded and stale-safe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-controller-agent-catalog-'))
    roots.push(root)
    const projectPath = join(root, 'project')
    const otherPath = join(root, 'other')
    await Promise.all([mkdir(projectPath), mkdir(otherPath)])
    const staleGate = deferred<void>()
    const staleStarted = deferred<void>()
    const stopGate = deferred<void>()
    const stopStarted = deferred<void>()
    let calls = 0
    let clears = 0
    let expectedCatalogPath: string | undefined
    const catalog = [{
      token: 'A'.repeat(43),
      name: 'Verifier',
      description: 'Verify the result.',
      sourceKind: 'builtin' as const
    }]
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(join(root, 'state.json'), process.execPath),
      seedProjectPath: projectPath,
      agentRosterStore: new AgentRosterStore(join(root, AGENT_ROSTER_FILE_NAME)),
      agentCatalogService: {
        list: async ({ canonicalCwd, cliPath }) => {
          expect(canonicalCwd).toBe(expectedCatalogPath)
          expect(cliPath).toBe(process.execPath)
          calls += 1
          if (calls === 2) {
            staleStarted.resolve(undefined)
            await staleGate.promise
          }
          if (calls === 3) {
            stopStarted.resolve(undefined)
            await stopGate.promise
          }
          return catalog
        },
        clear: () => { clears += 1 }
      }
    })
    const initialized = await controller.initialize()
    const projectId = initialized.projects[0]!.id
    expectedCatalogPath = initialized.projects[0]!.path
    await expect(controller.listGrokAgentCatalog(projectId)).resolves.toEqual(catalog)

    const listing = controller.listGrokAgentCatalog(projectId)
    await staleStarted.promise
    await expect(controller.acquireUpdateQuiescence()).rejects.toThrow(
      'cannot pause sessions for an update'
    )
    const created = await controller.createSavedAgent(0, agentDraft())
    await controller.updateSavedAgentEditor(1, created.id, { isPinned: true })
    expect(controller.snapshot().agentRoster).toMatchObject({
      status: 'ready',
      revision: 2,
      agents: [{ id: created.id, isPinned: true }]
    })
    await controller.addProject(otherPath)
    staleGate.resolve(undefined)
    await expect(listing).rejects.toThrow('context changed')
    expect(clears).toBeGreaterThan(0)

    const stopListing = controller.listGrokAgentCatalog(projectId)
    await stopStarted.promise
    let stopSettled = false
    const stopping = controller.stop().then(() => { stopSettled = true })
    await Promise.resolve()
    expect(stopSettled).toBe(false)
    stopGate.resolve(undefined)
    await expect(stopListing).rejects.toThrow('context changed')
    await stopping
    expect(stopSettled).toBe(true)
  })
})

async function createHarness(
  beforeForkStart?: () => Promise<void>,
  connectionHooks?: (
    options: AgentConnection['options'],
    connectionIndex: number
  ) => AgentConnectionHooks
): Promise<{
  root: string
  projectId: string
  controller: AppController
  stateStore: AppStateStore
  rosterStore: AgentRosterStore
  options: AgentConnection['options'][]
  connections: AgentConnection[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-controller-agents-'))
  roots.push(root)
  const projectPath = join(root, 'project')
  await mkdir(projectPath)
  const rosterStore = new AgentRosterStore(join(root, AGENT_ROSTER_FILE_NAME))
  const options: AgentConnection['options'][] = []
  const connections: AgentConnection[] = []
  const stateStore = new AppStateStore(join(root, 'state.json'), process.execPath)
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store: stateStore,
    seedProjectPath: projectPath,
    agentRosterStore: rosterStore,
    acpFactory: (connectionOptions) => {
      options.push(connectionOptions)
      const connection = new AgentConnection(
        connectionOptions,
        beforeForkStart,
        connectionHooks?.(connectionOptions, connections.length)
      )
      connections.push(connection)
      return connection
    }
  })
  const initialized = await controller.initialize()
  controller.setCliVersion(process.execPath, 'grok 1.0.5')
  return {
    root,
    projectId: initialized.projects[0]!.id,
    controller,
    stateStore,
    rosterStore,
    options,
    connections
  }
}

class SlowBindingRosterStore extends AgentRosterStore {
  constructor(
    path: string,
    private readonly started: () => void,
    private readonly gate: Promise<void>
  ) {
    super(path)
  }

  override async setSessionBinding(
    expectedRevision: number,
    localSessionId: string,
    agentId: string | null
  ) {
    this.started()
    await this.gate
    return super.setSessionBinding(expectedRevision, localSessionId, agentId)
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

function agentDraft(): Parameters<AppController['createSavedAgent']>[1] {
  return {
    name: 'Verifier',
    mission: 'Verify behavior independently.',
    roleName: 'local_verifier'
  }
}
