import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename } from 'node:path'
import { EventEmitter } from 'node:events'
import { normalizeSessionUpdate } from '../shared/acp/events'
import { persistedStateSchema } from '../shared/schemas'
import {
  appendSessionError,
  appendSessionNotice,
  appendUserMessage,
  applyAcpEvent
} from '../shared/chat/reducer'
import type {
  AppSettings,
  AppSnapshot,
  PendingPermission,
  PublicAgentRosterSnapshot,
  PublicSavedAgentSummary,
  ProjectSnapshot,
  SessionSnapshot
} from '../shared/models'
import type { UpdateSessionInput, UpdateSettingsInput } from '../shared/ipc'
import type { InteractionAnswer, PendingInteraction } from '../shared/acp/interactions'
import { SessionManager } from './acp/SessionManager'
import type { AcpClientOptions, AcpPermissionRequest } from './acp/AcpClient'
import type { AcpConnection, AcpConnectionOptions } from './acp/AcpConnection'
import { PublicAcpError, toPublicAcpError } from './acp/PublicSessionError'
import {
  AppStateStore,
  serializePersistedState,
  type PersistedState
} from './persistence/AppStateStore'
import type { SessionLifecycleEvent } from './notifications/SessionNotificationCoordinator'
import {
  AttachmentBroker,
  AttachmentBrokerError
} from './attachments/AttachmentBroker'
import type {
  AttachmentItemSummary,
  AttachmentPromptBlock,
  AttachmentSelectionSummary,
  ConsumedAttachments
} from '../shared/attachments'
import type { WorkspaceHealthState } from '../shared/workspaceHealth'
import { isStrictUuid } from '../shared/identifiers'
import { canonicalCliVersion, cliVersionAtLeast } from './grok/cliVersion'
import {
  WorkspaceHealthService,
  WorkspaceUnavailableError,
  type WorkspaceIdentity
} from './workspaces/WorkspaceHealthService'
import {
  ProjectOrderPolicy,
  type ProjectMoveDirection
} from './workspaces/ProjectOrderPolicy'
import {
  canSettleSession,
  resolveSessionActivityStatus,
  type SessionActivityStatus
} from '../shared/sessionPresentation'
import {
  dashboardProjectStatusSchema,
  type DashboardProjectStatus
} from '../shared/dashboard'
import { DashboardInspector } from './git/DashboardInspector'
import {
  SessionHistoryBroker,
  SessionHistoryBrokerError,
  type SessionHistoryContext
} from './history/SessionHistoryBroker'
import type {
  PublicSessionHistoryRecord,
  SessionHistoryDeleteResult
} from '../shared/sessionHistory'
import { sessionActivityUpdateSchema } from '../shared/acp/sessionActivityUpdates'
import {
  SessionActivityProjection
} from './acp/SessionActivityProjection'
import {
  emptyAgentRoster,
  inlineAcpAgentProfile,
  materializeSavedAgentUpdate,
  type AgentRoster,
  type SavedAgent,
  type SavedAgentDraft,
  type SavedAgentUpdate
} from '../shared/agents'
import {
  AgentRosterStoreError,
  type AgentRosterLoadResult,
  type AgentRosterMutationResult,
  type AgentRosterStore
} from './agents/AgentRosterStore'
import type { PublicGrokAgentCatalog } from '../shared/agentCatalog'
import type { GrokAgentCatalogService } from './agents/GrokAgentCatalogService'
import type {
  PublicMemoryFileContents,
  PublicMemoryFileSummary
} from '../shared/memory'
import type { MemoryBroker } from './memory/MemoryBroker'

type AgentRosterStoreApi = Pick<AgentRosterStore,
  | 'load'
  | 'create'
  | 'update'
  | 'delete'
  | 'setSessionBinding'
  | 'installStarterCrew'
  | 'mutate'
  | 'recover'
>

export interface AppControllerOptions {
  appVersion: string
  cliPath: string
  store: AppStateStore
  seedProjectPath?: string
  acpFactory?: (options: AcpConnectionOptions) => AcpConnection
  attachmentBroker?: AttachmentBroker
  workspaceHealthService?: WorkspaceHealthService
  dashboardInspector?: Pick<DashboardInspector, 'inspect'>
  sessionHistoryBroker?: Pick<
    SessionHistoryBroker,
    'list' | 'search' | 'resolve' | 'delete' | 'clear'
  >
  agentRosterStore?: AgentRosterStoreApi
  agentCatalogService?: Pick<GrokAgentCatalogService, 'list' | 'clear'>
  memoryBroker?: Pick<MemoryBroker, 'list' | 'read' | 'remember' | 'deleteSession' | 'clear'>
}

export const MAX_PINNED_PROJECTS = 5
export const MAX_PINNED_SESSIONS = 20
export const MAX_SETTLED_SESSIONS = 10_000
export const MAX_UNREAD_SESSIONS = 10_000
export const MAX_CACHED_SESSION_ACTIVITY_PROJECTIONS = 64
const MAX_CONCURRENT_AGENT_CATALOG_OPERATIONS = 8

export class ForkSessionUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForkSessionUnavailableError'
  }
}

export class UpdateQuiescenceUnavailableError extends Error {
  readonly code = 'update-quiescence-unavailable'

  constructor() {
    super('The application cannot pause sessions for an update right now.')
    this.name = 'UpdateQuiescenceUnavailableError'
  }
}

export class DashboardInspectionUnavailableError extends Error {
  constructor() {
    super('The selected project changed or became unavailable. Try the dashboard inspection again.')
    this.name = 'DashboardInspectionUnavailableError'
  }
}

export class SessionHistoryUnavailableError extends Error {
  constructor() {
    super('Session history changed or became unavailable. Refresh history and try again.')
    this.name = 'SessionHistoryUnavailableError'
  }
}

export class SavedAgentOperationUnavailableError extends Error {
  constructor(message = 'Saved agents changed or are unavailable. Refresh and try again.') {
    super(message)
    this.name = 'SavedAgentOperationUnavailableError'
  }
}

export class MemoryOperationUnavailableError extends Error {
  constructor(message = 'Memory is unavailable right now. Try again.') {
    super(message)
    this.name = 'MemoryOperationUnavailableError'
  }
}

export class MemorySettingsUnavailableError extends Error {
  constructor() {
    super('Wait for sessions and background work to become idle before changing Memory.')
    this.name = 'MemorySettingsUnavailableError'
  }
}

export class MemorySettingsReconnectError extends Error {
  constructor() {
    super('The Memory setting was saved, but one or more Grok sessions could not restart safely.')
    this.name = 'MemorySettingsReconnectError'
  }
}

export interface SavedAgentEditorChanges {
  name?: string
  mission?: string
  glyph?: string
  color?: string
  roleName?: string | null
  defaultModel?: string | null
  permissionProfile?: SavedAgent['permissionProfile']
  browserEnabled?: boolean
  computerUseEnabled?: boolean
  preferredSkills?: string[]
  isPinned?: boolean
}

export type SessionHistoryDeleteConfirmation = (summary: string) => Promise<boolean>

export interface UpdateQuiescenceLease {
  release(): void
}

/** Main-only lease for child-process/config operations initiated outside AppController. */
export interface IntegrationOperationLease {
  release(): void
}

export class AppController extends EventEmitter<{
  changed: [snapshot: AppSnapshot]
  sessionLifecycle: [event: SessionLifecycleEvent]
}> {
  private state?: PersistedState
  private cliAvailable = false
  private cliVersion: string | undefined
  private revision = 0
  private broadcastTimer: NodeJS.Timeout | undefined
  private persistTimer: NodeJS.Timeout | undefined
  private persistInFlight: Promise<void> | undefined
  private persistDirty = false
  private persistFailure: Error | undefined
  private stopping = false
  private resolveStopRequested!: () => void
  private readonly stopRequested = new Promise<void>((resolve) => {
    this.resolveStopRequested = resolve
  })
  private updateQuiescenceToken: symbol | undefined
  private integrationOperations = 0
  private readonly memoryOperations = new Set<Promise<unknown>>()
  private memorySettingsOperation: Promise<void> | undefined
  private memorySettingsTransaction: symbol | undefined
  private memoryContextIdentity: string | undefined
  private migrationApplying = false
  private migrationOperation: Promise<void> | undefined
  private destructivePersistenceTransactions = 0
  private readonly permissionQueues = new Map<string, PendingPermission[]>()
  private readonly seenPermissionRequests = new Map<string, Set<string>>()
  private readonly autoPermissionPumps = new Set<string>()
  private readonly interactionQueues = new Map<string, PendingInteraction[]>()
  private readonly lifecycleTurns = new Map<string, number>()
  private readonly cancelledLifecycleTurns = new Map<string, number>()
  private readonly unreadSessionIds = new Set<string>()
  private readonly workingSinceBySessionId = new Map<string, string>()
  /**
   * CLI-owned Tasks / Workflows state is deliberately transient. Active
   * projections survive a worker disconnect as an offline last-known view;
   * staging projections isolate session/load replay until that worker starts.
   */
  private readonly activityProjections = new Map<string, SessionActivityProjection>()
  private readonly activityProjectionStarts = new Map<string, SessionActivityProjection>()
  private readonly connectionStarts = new Map<string, {
    client: AcpConnection
    promise: Promise<AcpConnection>
  }>()
  private readonly retryStarts = new Map<string, Promise<void>>()
  private readonly forkStarts = new Map<string, Promise<SessionSnapshot>>()
  private readonly sessionLifecycleLocks = new Set<string>()
  private readonly projectRemovalLocks = new Set<string>()
  private readonly detachedSessionCleanups = new Set<Promise<unknown>>()
  private readonly workspaceHealthStates = new Map<string, WorkspaceHealthState>()
  private readonly workspaceHealthChecks = new Map<string, {
    project: ProjectSnapshot
    path: string
    promise: Promise<WorkspaceHealthState>
  }>()
  private readonly sessions: SessionManager
  private readonly attachments: AttachmentBroker
  private readonly workspaceHealthService: WorkspaceHealthService
  private readonly dashboardInspector: Pick<DashboardInspector, 'inspect'>
  private readonly sessionHistoryBroker: Pick<
    SessionHistoryBroker,
    'list' | 'search' | 'resolve' | 'delete' | 'clear'
  >
  private readonly sessionHistoryOperations = new Set<Promise<unknown>>()
  private sessionHistoryMutation: symbol | undefined
  private sessionHistoryContextIdentity: string | undefined
  private agentRosterLoad: AgentRosterLoadResult = {
    status: 'ready',
    source: 'missing',
    roster: emptyAgentRoster()
  }
  /**
   * Runtime-affecting roster writes are durable before their workers can be
   * recycled. Keep the last public view stable across that gap while
   * agentRosterLoad carries the desired identity used by reconnects.
   */
  private agentRosterPublicOverride: AgentRosterLoadResult | undefined
  private agentRosterTransaction: symbol | undefined
  private readonly agentRosterOperations = new Set<Promise<void>>()
  private readonly agentCatalogOperations = new Set<Promise<void>>()
  private agentCatalogContextIdentity: string | undefined
  private agentCatalogContextGeneration = 0

  constructor(private readonly options: AppControllerOptions) {
    super()
    this.sessions = options.acpFactory
      ? new SessionManager(4, options.acpFactory)
      : new SessionManager(4)
    this.attachments = options.attachmentBroker ?? new AttachmentBroker()
    this.workspaceHealthService = options.workspaceHealthService ?? new WorkspaceHealthService()
    this.dashboardInspector = options.dashboardInspector ?? new DashboardInspector()
    this.sessionHistoryBroker = options.sessionHistoryBroker ?? new SessionHistoryBroker()
    this.sessions.on('update', (sessionId, params) => this.onAcpUpdate(sessionId, params))
    this.sessions.on('capabilities', (sessionId, capabilities) => {
      this.updateSessionRecord(sessionId, (session) => {
        const withoutStaleCapabilities = withoutCapabilities(session)
        const availableModels = capabilities.availableModels.length > 0
          ? capabilities.availableModels
          : undefined
        const availableModes = capabilities.availableModes.length > 0
          ? capabilities.availableModes
          : undefined
        const model = capabilities.currentModelId ?? session.model
        const mode = capabilities.currentModeId ?? session.mode
        const contextLimit = availableModels?.find((item) => item.id === model)?.contextLimit
          ?? session.contextLimit
        return {
          ...withoutStaleCapabilities,
          model,
          mode,
          ...(availableModels ? { availableModels } : {}),
          ...(availableModes ? { availableModes } : {}),
          contextLimit,
          updatedAt: new Date().toISOString()
        }
      })
    })
    this.sessions.on('permission', (sessionId, request) => this.onPermission(sessionId, request))
    this.sessions.on('interaction', (sessionId, request) => this.onInteraction(sessionId, request))
    this.sessions.on('interactionResolved', (sessionId, resolution) => {
      this.onInteractionResolved(sessionId, resolution.interactionId)
    })
    this.sessions.on('error', (sessionId, error) => {
      this.workingSinceBySessionId.delete(sessionId)
      this.updateSessionRecord(sessionId, (session) => appendSessionError(session, error.message))
    })
    this.sessions.on('exit', (sessionId) => {
      this.workingSinceBySessionId.delete(sessionId)
      this.failActivityProjectionStart(sessionId)
      this.setActivityProjectionOffline(sessionId)
      this.clearPermissionQueue(sessionId)
      this.clearInteractionQueue(sessionId)
      this.updateSessionRecord(sessionId, (session) =>
        session.status === 'idle'
          ? withoutCapabilities(session)
          : appendSessionError(
              withoutCapabilities(session),
              'The Grok process stopped. Start a new prompt to reconnect.'
            )
      )
    })
    this.sessions.on('evicted', (sessionId) => {
      this.setActivityProjectionOffline(sessionId)
    })
  }

  async initialize(): Promise<AppSnapshot> {
    const state = await this.options.store.load()
    normalizeLayoutState(state)
    state.sessions = state.sessions.map((session) => {
      const {
        pendingPermission: _pendingPermission,
        pendingInteraction: _pendingInteraction,
        availableModels: _availableModels,
        availableModes: _availableModes,
        ...rest
      } = session
      return {
        ...rest,
        status: 'idle',
        transcript: session.transcript.map((item) =>
          'streaming' in item && item.streaming ? { ...item, streaming: false } : item
        )
      }
    })
    this.agentRosterLoad = this.options.agentRosterStore
      ? await this.options.agentRosterStore.load()
      : { status: 'ready', source: 'missing', roster: emptyAgentRoster() }
    if (this.agentRosterLoad.status === 'ready' && this.options.agentRosterStore) {
      const validSessionIds = new Set(state.sessions.map((session) => session.id))
      const orphanIds = Object.keys(this.agentRosterLoad.roster.sessionBindings)
        .filter((sessionId) => !validSessionIds.has(sessionId))
      if (orphanIds.length > 0) {
        const cleaned = await this.options.agentRosterStore.mutate(
          this.agentRosterLoad.roster.revision,
          (roster) => {
            for (const sessionId of orphanIds) delete roster.sessionBindings[sessionId]
          }
        )
        this.agentRosterLoad = { status: 'ready', source: 'versioned', roster: cleaned }
      }
    }
    this.state = state
    this.sessionHistoryContextIdentity = sessionHistoryContextIdentity(state)
    this.agentCatalogContextIdentity = agentCatalogContextIdentity(state)
    this.memoryContextIdentity = memoryContextIdentity(state)
    this.sessions.setLimit(state.settings.maxLiveSessions)
    this.cliAvailable = await isExecutable(state.settings.grokCliPath)
    await this.refreshAllWorkspaceHealth(false)

    if (this.options.seedProjectPath && state.projects.length === 0) {
      await this.addProject(this.options.seedProjectPath)
    } else {
      this.emitChanged()
    }
    return this.snapshot()
  }

  setCliVersion(cliPath: string, version: string | undefined): void {
    this.assertNoStateTransaction('recording the Grok CLI version')
    if (this.requireState().settings.grokCliPath !== cliPath) return
    this.sessionHistoryBroker.clear()
    this.agentCatalogContextGeneration += 1
    this.options.agentCatalogService?.clear()
    this.options.memoryBroker?.clear()
    this.cliVersion = canonicalCliVersion(version)
    this.emitChanged()
  }

  snapshot(): AppSnapshot {
    const state = this.requireState()
    const publicAgentRosterLoad = this.agentRosterPublicOverride ?? this.agentRosterLoad
    const projects = orderedProjects(state)
    const hasGlobalForkCapacity = state.sessions.length < 10_000
    const projectSessionCounts = new Map(
      state.projects.map((project) => [project.id, project.sessionIds.length])
    )
    return structuredClone({
      revision: this.revision,
      projects,
      sessions: state.sessions.map((session) => publicSessionSnapshot(
        session,
        this.workspaceHealthStates.get(session.projectId) === 'ready' &&
          supportsSessionFork(this.cliVersion) &&
          hasGlobalForkCapacity &&
          (projectSessionCounts.get(session.projectId) ?? 10_000) < 10_000,
        {
          hasUnreadCompletion:
            state.selectedSessionId !== session.id && this.unreadSessionIds.has(session.id),
          pendingUserCount: Math.min(
            128,
            (this.permissionQueues.get(session.id)?.length ?? 0) +
              (this.interactionQueues.get(session.id)?.length ?? 0)
          ),
          workingSince: this.workingSinceBySessionId.get(session.id),
          activities: this.activityProjectionStarts.get(session.id)?.getSnapshot()
            ?? this.activityProjections.get(session.id)?.getSnapshot(),
          savedAgent: this.savedAgentForSession(session.id, publicAgentRosterLoad)
        }
      )),
      pinnedProjectIds: state.pinnedProjectIds,
      pinnedSessionIds: state.pinnedSessionIds,
      settledSessionIds: state.settledSessionIds,
      unreadSessionIds: [...this.unreadSessionIds].filter((sessionId) =>
        sessionId !== state.selectedSessionId &&
        state.sessions.some((session) => session.id === sessionId)
      ).slice(0, MAX_UNREAD_SESSIONS),
      ...(state.selectedProjectId ? { selectedProjectId: state.selectedProjectId } : {}),
      ...(state.selectedSessionId ? { selectedSessionId: state.selectedSessionId } : {}),
      settings: state.settings,
      workspaceHealth: projects.map((project) => ({
        projectId: project.id,
        state: this.workspaceHealthStates.get(project.id) ?? 'unreadable'
      })),
      agentRoster: publicAgentRosterSnapshot(publicAgentRosterLoad),
      cli: {
        available: this.cliAvailable,
        path: state.settings.grokCliPath,
        ...(this.cliVersion ? { version: this.cliVersion } : {})
      },
      appVersion: this.options.appVersion
    })
  }

  async createSavedAgent(
    expectedRevision: number,
    draft: SavedAgentDraft
  ): Promise<PublicSavedAgentSummary> {
    const release = this.acquireAgentRosterTransaction('creating a saved agent')
    try {
      const store = this.requireAgentRosterStore()
      this.requireReadyAgentRoster(expectedRevision)
      const result = await this.runAgentRosterMutation(() => store.create(expectedRevision, draft))
      return publicSavedAgentSummary(result.value)
    } finally {
      release()
    }
  }

  async updateSavedAgent(
    expectedRevision: number,
    update: SavedAgentUpdate
  ): Promise<PublicSavedAgentSummary> {
    const release = this.acquireAgentRosterTransaction('updating a saved agent')
    let releaseSessions = (): void => undefined
    try {
      const store = this.requireAgentRosterStore()
      const roster = this.requireReadyAgentRoster(expectedRevision)
      const existing = roster.agents.find((agent) => agent.id === update.id.toLocaleLowerCase('en-US'))
      if (!existing) throw new SavedAgentOperationUnavailableError('Saved agent was not found.')
      const projected = materializeSavedAgentUpdate(update, existing, existing.updatedAt)
      const profileChanged = JSON.stringify(inlineAcpAgentProfile(existing)) !==
        JSON.stringify(inlineAcpAgentProfile(projected))
      const boundSessionIds = profileChanged
        ? boundExistingSessionIds(roster, update.id, this.requireState())
        : []
      releaseSessions = this.acquireStableAgentSessions(boundSessionIds, 'updating its saved agent')
      const result = profileChanged
        ? await this.runRuntimeAgentRosterMutation(
            () => store.update(expectedRevision, update),
            boundSessionIds
          )
        : await this.runAgentRosterMutation(() => store.update(expectedRevision, update))
      return publicSavedAgentSummary(result.value)
    } finally {
      releaseSessions()
      release()
    }
  }

  async updateSavedAgentEditor(
    expectedRevision: number,
    agentId: string,
    changes: SavedAgentEditorChanges
  ): Promise<PublicSavedAgentSummary> {
    const roster = this.requireReadyAgentRoster(expectedRevision)
    const existing = roster.agents.find((agent) => agent.id === agentId.toLocaleLowerCase('en-US'))
    if (!existing) throw new SavedAgentOperationUnavailableError('Saved agent was not found.')
    const {
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...privateUpdate
    } = existing
    const {
      roleName,
      defaultModel,
      ...editorChanges
    } = changes
    const merged: SavedAgentUpdate = {
      ...privateUpdate,
      ...editorChanges,
      id: existing.id,
      ...(typeof roleName === 'string' ? { roleName } : {}),
      ...(typeof defaultModel === 'string' ? { defaultModel } : {})
    }
    if (roleName === null) delete merged.roleName
    if (defaultModel === null) delete merged.defaultModel
    return this.updateSavedAgent(expectedRevision, merged)
  }

  async deleteSavedAgent(expectedRevision: number, agentId: string): Promise<void> {
    const release = this.acquireAgentRosterTransaction('deleting a saved agent')
    let releaseSessions = (): void => undefined
    try {
      const store = this.requireAgentRosterStore()
      const roster = this.requireReadyAgentRoster(expectedRevision)
      const boundSessionIds = boundExistingSessionIds(roster, agentId, this.requireState())
      releaseSessions = this.acquireStableAgentSessions(boundSessionIds, 'deleting its saved agent')
      await this.runRuntimeAgentRosterMutation(
        () => store.delete(expectedRevision, agentId),
        boundSessionIds
      )
    } finally {
      releaseSessions()
      release()
    }
  }

  async installStarterAgents(expectedRevision: number): Promise<PublicSavedAgentSummary[]> {
    const release = this.acquireAgentRosterTransaction('installing starter agents')
    try {
      const store = this.requireAgentRosterStore()
      this.requireReadyAgentRoster(expectedRevision)
      const result = await this.runAgentRosterMutation(() =>
        store.installStarterCrew(expectedRevision)
      )
      return result.value.map(publicSavedAgentSummary)
    } finally {
      release()
    }
  }

  async recoverSavedAgentRoster(expectedRevision: number): Promise<PublicAgentRosterSnapshot> {
    const release = this.acquireAgentRosterTransaction('recovering saved agents')
    try {
      const store = this.requireAgentRosterStore()
      if (
        expectedRevision !== 0 ||
        this.agentRosterLoad.status !== 'invalid'
      ) throw new SavedAgentOperationUnavailableError()
      const result = await store.recover()
      this.setReadyAgentRoster(result.roster)
      return publicAgentRosterSnapshot(this.agentRosterLoad)
    } finally {
      release()
    }
  }

  async bindSavedAgent(
    sessionId: string,
    agentId: string | null,
    expectedRevision: number
  ): Promise<import('../shared/models').PublicSessionSnapshot> {
    const release = this.acquireAgentRosterTransaction('changing the saved agent for a session')
    let releaseSession = (): void => undefined
    try {
      const store = this.requireAgentRosterStore()
      this.requireReadyAgentRoster(expectedRevision)
      releaseSession = this.acquireStableAgentSessions(
        [sessionId],
        'changing its saved agent'
      )
      await this.runRuntimeAgentRosterMutation(
        () => store.setSessionBinding(expectedRevision, sessionId, agentId),
        [sessionId]
      )
      const publicSession = this.snapshot().sessions.find((session) => session.id === sessionId)
      if (!publicSession) throw new SavedAgentOperationUnavailableError()
      return publicSession
    } finally {
      releaseSession()
      release()
    }
  }

  async listGrokAgentCatalog(projectId: string): Promise<PublicGrokAgentCatalog> {
    const release = this.acquireAgentCatalogOperation()
    try {
      const service = this.options.agentCatalogService
      if (!service) throw new SavedAgentOperationUnavailableError('Grok agent discovery is unavailable.')
      const project = await this.requireReadyProject(projectId)
      const state = this.requireState()
      const canonicalCwd = project.path
      const cliPath = state.settings.grokCliPath
      const contextGeneration = this.agentCatalogContextGeneration
      if (!this.cliAvailable || this.workspaceHealthStates.get(projectId) !== 'ready') {
        throw new SavedAgentOperationUnavailableError('Grok agent discovery requires a ready workspace and CLI.')
      }
      const result = await service.list({ canonicalCwd, cliPath })
      const currentState = this.requireState()
      const currentProject = currentState.projects.find((candidate) => candidate.id === projectId)
      if (
        this.stopping ||
        this.agentCatalogContextGeneration !== contextGeneration ||
        currentState !== state ||
        currentProject !== project ||
        currentProject.path !== canonicalCwd ||
        currentState.settings.grokCliPath !== cliPath ||
        !this.cliAvailable ||
        this.workspaceHealthStates.get(projectId) !== 'ready'
      ) {
        service.clear()
        throw new SavedAgentOperationUnavailableError('Grok agent discovery context changed. Refresh and try again.')
      }
      return result
    } finally {
      release()
    }
  }

  /** Main-process-only source for non-destructive migration planning. */
  migrationSnapshot(): PersistedState {
    return structuredClone(this.requireState())
  }

  /** Applies a fully validated migration result after persisting it atomically. */
  applyMigrationState(candidate: PersistedState): Promise<void> {
    if (this.sessionHistoryMutation) {
      return Promise.reject(new SessionHistoryUnavailableError())
    }
    if (this.updateQuiescenceToken) {
      return Promise.reject(new UpdateQuiescenceUnavailableError())
    }
    if (
      this.stopping ||
      this.migrationApplying ||
      this.forkStarts.size > 0 ||
      this.retryStarts.size > 0 ||
      this.sessionLifecycleLocks.size > 0 ||
      this.projectRemovalLocks.size > 0 ||
      this.destructivePersistenceTransactions > 0 ||
      this.connectionStarts.size > 0 ||
      this.agentRosterTransaction !== undefined
    ) {
      return Promise.reject(new ForkSessionUnavailableError(
        'Wait for current session and project operations to finish before importing state.'
      ))
    }
    if (this.requireState().sessions.some((session) => !isForkableSourceSession(session))) {
      return Promise.reject(new ForkSessionUnavailableError(
        'Wait for every session to become idle before importing state.'
      ))
    }
    this.migrationApplying = true
    const operation = this.performMigrationState(candidate)
    this.migrationOperation = operation
    void operation.finally(() => {
      if (this.migrationOperation === operation) this.migrationOperation = undefined
      this.migrationApplying = false
    }).catch(() => undefined)
    return operation
  }

  private async performMigrationState(candidate: PersistedState): Promise<void> {
    const current = this.requireState()
    const parsed = persistedStateSchema.parse(candidate) as PersistedState
    const next = structuredClone(parsed)
    const nextProjectIds = new Set(next.projects.map((project) => project.id))
    const nextSessionIds = new Set(next.sessions.map((session) => session.id))
    if (
      current.projects.some((project) => !nextProjectIds.has(project.id)) ||
      current.sessions.some((session) => !nextSessionIds.has(session.id))
    ) {
      throw new Error('Migration results must preserve existing projects and sessions')
    }
    // Imports cannot reorder or mutate lifecycle pins.
    next.pinnedProjectIds = structuredClone(current.pinnedProjectIds)
    next.pinnedSessionIds = structuredClone(current.pinnedSessionIds)
    normalizeLayoutState(next)
    const originalProjectIds = new Set(current.projects.map((project) => project.id))
    const originalSessionIds = new Set(current.sessions.map((session) => session.id))
    const originalSelection = {
      projectId: current.selectedProjectId,
      sessionId: current.selectedSessionId
    }

    // Drain checks that may still quiesce a session, then freeze ACP event
    // production before the one durable candidate write. All UI mutations are
    // rejected while migrationApplying is true.
    await Promise.allSettled(
      [...this.workspaceHealthChecks.values()].map((entry) => entry.promise)
    )
    this.setAllActivityProjectionsOffline()
    await this.sessions.stopAll()
    this.connectionStarts.clear()
    if (this.requireState() !== current) throw new PublicAcpError('generic')
    const rebased = rebaseMigrationState(
      next,
      current,
      originalProjectIds,
      originalSessionIds,
      originalSelection
    )
    await this.saveStateInPersistenceLane(rebased)

    const previousSelectedSessionId = current.selectedSessionId
    this.state = rebased
    const historyIdentity = sessionHistoryContextIdentity(rebased)
    if (this.sessionHistoryContextIdentity !== historyIdentity) {
      this.sessionHistoryBroker.clear()
    }
    this.sessionHistoryContextIdentity = historyIdentity
    const memoryIdentity = memoryContextIdentity(rebased)
    if (this.memoryContextIdentity !== memoryIdentity) this.options.memoryBroker?.clear()
    this.memoryContextIdentity = memoryIdentity
    this.reconcileTransientSessionState()
    if (rebased.selectedSessionId) this.unreadSessionIds.delete(rebased.selectedSessionId)
    await this.refreshAllWorkspaceHealth(false)
    if (previousSelectedSessionId && previousSelectedSessionId !== rebased.selectedSessionId) {
      this.sessions.setProtection(previousSelectedSessionId, 'selected', false)
    }
    if (rebased.selectedSessionId) {
      this.sessions.setProtection(rebased.selectedSessionId, 'selected', true)
    }
    this.publishSnapshotChanged()
  }

  async addProject(inputPath: string): Promise<ProjectSnapshot> {
    this.assertNoStateTransaction('adding a project')
    const state = this.requireState()
    const path = await realpath(inputPath)
    if (!(await stat(path)).isDirectory()) throw new Error('Selected project is not a directory')
    this.assertNoStateTransaction('adding a project')
    if (this.requireState() !== state) {
      throw new PublicAcpError('generic')
    }
    const existing = state.projects.find((project) => project.path === path)
    if (existing) {
      this.assertProjectNotRemoving(existing.id, 'adding')
      this.workspaceHealthStates.set(existing.id, 'ready')
      await this.selectProject(existing.id)
      return existing
    }

    const project: ProjectSnapshot = {
      id: crypto.randomUUID(),
      name: basename(path) || path,
      path,
      sessionIds: [],
      createdAt: new Date().toISOString()
    }
    state.projects.unshift(project)
    this.workspaceHealthStates.set(project.id, 'ready')
    if (state.selectedSessionId) {
      this.sessions.setProtection(state.selectedSessionId, 'selected', false)
    }
    state.selectedProjectId = project.id
    delete state.selectedSessionId
    this.emitChanged()
    return project
  }

  async selectProject(projectId: string): Promise<void> {
    this.assertProjectNotRemoving(projectId, 'selecting')
    const { project, health } = await this.refreshStableProject(projectId)
    this.assertProjectNotRemoving(projectId, 'selecting')
    const state = this.requireState()
    const current = state.sessions.find((session) => session.id === state.selectedSessionId)
    if (current?.projectId === projectId) {
      state.selectedProjectId = projectId
      this.clearSessionUnread(current.id)
      this.emitChanged()
      return
    }
    const nextSession = preferredProjectSession(state, projectId)
    if (nextSession) this.assertSessionNotClosing(nextSession.id, 'selecting')
    if (state.selectedSessionId) {
      this.sessions.setProtection(state.selectedSessionId, 'selected', false)
    }
    state.selectedProjectId = projectId
    if (nextSession) {
      state.selectedSessionId = nextSession.id
      this.clearSessionUnread(nextSession.id)
      rememberDurableSelection(state, nextSession)
      this.sessions.setProtection(nextSession.id, 'selected', true)
      if (health === 'ready') this.reconnectSelectedSession(nextSession.id)
    } else {
      delete state.selectedSessionId
    }
    this.emitChanged()
  }

  async createSession(projectId: string): Promise<SessionSnapshot> {
    if (this.forkStarts.size > 0) {
      throw new ForkSessionUnavailableError('Wait for the session fork to finish before creating another session.')
    }
    this.assertProjectNotRemoving(projectId, 'creating a session in')
    const project = await this.requireReadyProject(projectId)
    this.assertProjectNotRemoving(projectId, 'creating a session in')
    const state = this.requireState()
    const timestamp = new Date().toISOString()
    const session: SessionSnapshot = {
      id: crypto.randomUUID(),
      projectId,
      title: `New chat ${project.sessionIds.length + 1}`,
      status: 'idle',
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
    state.sessions.push(session)
    project.sessionIds.push(session.id)
    if (state.selectedSessionId && state.selectedSessionId !== session.id) {
      this.sessions.setProtection(state.selectedSessionId, 'selected', false)
    }
    state.selectedProjectId = projectId
    state.selectedSessionId = session.id
    this.emitChanged()
    return structuredClone(session)
  }

  async selectSession(sessionId: string): Promise<void> {
    this.assertSessionAvailable(sessionId, 'selecting')
    const { session, health } = await this.refreshStableSession(sessionId)
    this.assertSessionAvailable(sessionId, 'selecting')
    const state = this.requireState()
    if (state.selectedSessionId && state.selectedSessionId !== sessionId) {
      this.sessions.setProtection(state.selectedSessionId, 'selected', false)
    }
    state.selectedProjectId = session.projectId
    state.selectedSessionId = sessionId
    this.clearSessionUnread(sessionId)
    rememberDurableSelection(state, session)
    this.sessions.setProtection(sessionId, 'selected', true)
    this.emitChanged()
    if (health === 'ready') this.reconnectSelectedSession(sessionId)
  }

  async removeProject(projectId: string): Promise<void> {
    if (this.requireState().sessions.some((session) =>
      session.projectId === projectId && this.forkStarts.has(session.id)
    )) {
      throw new ForkSessionUnavailableError('Wait for the session fork to finish before removing this project.')
    }
    const releaseAgentRoster = this.acquireAgentRosterTransaction('removing a project with saved-agent bindings')
    try {
      await this.removeProjectTransaction(projectId)
    } finally {
      releaseAgentRoster()
    }
  }

  private async removeProjectTransaction(projectId: string): Promise<void> {
    this.assertNoStateTransaction('removing this project')
    const state = this.requireState()
    this.getProject(projectId)
    if (state.sessions.some((session) =>
      session.projectId === projectId && this.forkStarts.has(session.id)
    )) {
      throw new ForkSessionUnavailableError('Wait for the session fork to finish before removing this project.')
    }
    if (state.sessions.some((session) =>
      session.projectId === projectId && this.sessionLifecycleLocks.has(session.id)
    )) {
      throw new ForkSessionUnavailableError(
        'Wait for the current session operation to finish before removing this project.'
      )
    }
    if (this.projectRemovalLocks.has(projectId)) return
    this.projectRemovalLocks.add(projectId)
    this.destructivePersistenceTransactions += 1
    let transactionActive = true
    const releaseTransaction = (): void => {
      if (!transactionActive) return
      transactionActive = false
      this.destructivePersistenceTransactions -= 1
      this.projectRemovalLocks.delete(projectId)
    }
    let removedBindings: Record<string, string> = {}
    let bindingOutcome: 'none' | 'precleared' | 'restored' | 'committed' = 'none'
    try {
      const project = this.getProject(projectId)
      const projectIndex = state.projects.findIndex((candidate) => candidate.id === projectId)
      const removedSessions = state.sessions
        .map((session, index) => ({ session: structuredClone(session), index }))
        .filter((entry) => entry.session.projectId === projectId)
      const rollback = {
        project: structuredClone(project),
        projectIndex,
        removedSessions,
        pinnedProjectIds: [...state.pinnedProjectIds],
        pinnedSessionIds: [...state.pinnedSessionIds],
        settledSessionIds: [...state.settledSessionIds],
        mappedSessionId: state.selectedSessionIdByProject[projectId],
        selection: currentSelection(state),
        health: this.workspaceHealthStates.get(projectId)
      }
      const orderedBeforeRemoval = orderedProjects(state)
      const removedSessionIds = removedSessions.map((entry) => entry.session.id)
      removedBindings = await this.preclearSessionBindings(removedSessionIds)
      if (Object.keys(removedBindings).length > 0) bindingOutcome = 'precleared'
      const cleanup = this.trackDetachedCleanup(Promise.allSettled(
        removedSessionIds.map((sessionId) => this.stopSessionWorker(sessionId))
      ))

      state.sessions = state.sessions.filter((session) => session.projectId !== projectId)
      state.projects = state.projects.filter((candidate) => candidate.id !== projectId)
      this.workspaceHealthStates.delete(projectId)
      state.pinnedProjectIds = state.pinnedProjectIds.filter((id) => id !== projectId)
      state.pinnedSessionIds = state.pinnedSessionIds.filter((id) => !removedSessionIds.includes(id))
      state.settledSessionIds = state.settledSessionIds.filter((id) => !removedSessionIds.includes(id))
      delete state.selectedSessionIdByProject[projectId]

      let reconnectSession: SessionSnapshot | undefined
      if (state.selectedProjectId === projectId || removedSessionIds.includes(state.selectedSessionId ?? '')) {
        const nextProject = orderedBeforeRemoval.find((candidate) => candidate.id !== projectId)
        if (nextProject) {
          state.selectedProjectId = nextProject.id
          const nextSession = preferredProjectSession(state, nextProject.id)
          if (nextSession) {
            state.selectedSessionId = nextSession.id
            rememberDurableSelection(state, nextSession)
            this.sessions.setProtection(nextSession.id, 'selected', true)
            reconnectSession = nextSession
          } else {
            delete state.selectedSessionId
          }
        } else {
          delete state.selectedProjectId
          delete state.selectedSessionId
        }
      }
      const committedSelection = currentSelection(state)
      this.emitChanged()
      let persistenceFailure: unknown
      try {
        await this.flushPersistence(true)
      } catch (error) {
        persistenceFailure = error
        restoreRemovedProject(
          state,
          rollback,
          committedSelection,
          this.workspaceHealthStates
        )
        const restoredSelected = state.selectedSessionId
          ? state.sessions.find((session) => session.id === state.selectedSessionId)
          : undefined
        if (
          committedSelection.sessionId &&
          committedSelection.sessionId !== restoredSelected?.id
        ) {
          this.sessions.setProtection(committedSelection.sessionId, 'selected', false)
        }
        if (restoredSelected) this.sessions.setProtection(restoredSelected.id, 'selected', true)
        await this.restoreSessionBindings(removedBindings)
        bindingOutcome = 'restored'
        this.emitChanged()
      } finally {
        await cleanup
      }
      if (persistenceFailure) {
        releaseTransaction()
        if (!this.stopping && state.selectedSessionId) {
          this.reconnectSelectedSession(state.selectedSessionId)
        }
        throw persistenceFailure
      }
      bindingOutcome = 'committed'
      for (const sessionId of removedSessionIds) this.clearTransientSessionState(sessionId)
      if (reconnectSession && !this.stopping) {
        releaseTransaction()
        const health = await this.refreshProjectHealth(reconnectSession.projectId)
        if (
          health === 'ready' &&
          state.selectedSessionId === reconnectSession.id &&
          state.sessions.some((session) => session.id === reconnectSession.id)
        ) this.reconnectSelectedSession(reconnectSession.id)
      }
    } finally {
      try {
        if (bindingOutcome === 'precleared') {
          await this.restoreSessionBindings(removedBindings)
          bindingOutcome = 'restored'
          if (!this.stopping) this.publishSnapshotChanged()
        }
      } finally {
        releaseTransaction()
      }
    }
  }

  moveProject(projectId: string, direction: ProjectMoveDirection): void {
    this.assertProjectNotRemoving(projectId, 'moving')
    const state = this.requireState()
    this.getProject(projectId)
    const result = ProjectOrderPolicy.move(state, projectId, direction)
    if (result.outcome !== 'moved') return
    state.projects = result.projects
    state.pinnedProjectIds = result.pinnedProjectIds
    this.emitChanged()
  }

  async closeSession(sessionId: string): Promise<void> {
    this.assertSessionNotForking(sessionId, 'closing')
    const releaseAgentRoster = this.acquireAgentRosterTransaction('closing a saved-agent session')
    try {
      await this.closeSessionTransaction(sessionId)
    } finally {
      releaseAgentRoster()
    }
  }

  private async closeSessionTransaction(sessionId: string): Promise<void> {
    const releaseLifecycle = this.acquireSessionLifecycle(sessionId, 'closing')
    this.destructivePersistenceTransactions += 1
    let transactionActive = true
    const releaseTransaction = (): void => {
      if (!transactionActive) return
      transactionActive = false
      this.destructivePersistenceTransactions -= 1
      releaseLifecycle()
    }
    let removedBindings: Record<string, string> = {}
    let bindingOutcome: 'none' | 'precleared' | 'restored' | 'committed' = 'none'
    try {
    const state = this.requireState()
    const session = this.getSession(sessionId)
    const project = this.getProject(session.projectId)
    const rollback = {
      session: structuredClone(session),
      sessionIndex: state.sessions.findIndex((candidate) => candidate.id === sessionId),
      projectSessionIndex: project.sessionIds.indexOf(sessionId),
      pinnedSessionIndex: state.pinnedSessionIds.indexOf(sessionId),
      settledSessionIndex: state.settledSessionIds.indexOf(sessionId),
      mappedSessionId: state.selectedSessionIdByProject[project.id],
      selection: currentSelection(state)
    }
    removedBindings = await this.preclearSessionBindings([sessionId])
    if (Object.keys(removedBindings).length > 0) bindingOutcome = 'precleared'
    this.sessions.setProtection(sessionId, 'selected', false)
    const cleanup = this.trackDetachedCleanup(this.stopSessionWorker(sessionId))

    state.sessions = state.sessions.filter((candidate) => candidate.id !== sessionId)
    project.sessionIds = project.sessionIds.filter((id) => id !== sessionId)
    state.pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId)
    state.settledSessionIds = state.settledSessionIds.filter((id) => id !== sessionId)
    if (state.selectedSessionIdByProject[project.id] === sessionId) {
      delete state.selectedSessionIdByProject[project.id]
    }

    let reconnectSession: SessionSnapshot | undefined
    if (state.selectedSessionId === sessionId) {
      const fallback = preferredProjectSession(state, project.id)
        ?? mostRecentlyUsedSession(state.sessions)
      if (fallback) {
        state.selectedProjectId = fallback.projectId
        state.selectedSessionId = fallback.id
        rememberDurableSelection(state, fallback)
        this.sessions.setProtection(fallback.id, 'selected', true)
        reconnectSession = fallback
      } else {
        state.selectedProjectId = project.id
        delete state.selectedSessionId
      }
    }
    const committedSelection = currentSelection(state)
    const committedMappedSessionId = state.selectedSessionIdByProject[project.id]
    this.emitChanged()
    let persistenceFailure: unknown
    try {
      await this.flushPersistence(true)
    } catch (error) {
      persistenceFailure = error
      restoreClosedSession(
        state,
        project,
        rollback,
        committedSelection,
        committedMappedSessionId
      )
      const restoredSelected = state.selectedSessionId
        ? state.sessions.find((candidate) => candidate.id === state.selectedSessionId)
        : undefined
      if (
        committedSelection.sessionId &&
        committedSelection.sessionId !== restoredSelected?.id
      ) {
        this.sessions.setProtection(committedSelection.sessionId, 'selected', false)
      }
      if (restoredSelected) this.sessions.setProtection(restoredSelected.id, 'selected', true)
      await this.restoreSessionBindings(removedBindings)
      bindingOutcome = 'restored'
      this.emitChanged()
    } finally {
      await cleanup.catch(() => undefined)
    }
    if (persistenceFailure) {
      releaseTransaction()
      if (!this.stopping && state.selectedSessionId) {
        this.reconnectSelectedSession(state.selectedSessionId)
      }
      throw persistenceFailure
    }
    bindingOutcome = 'committed'
    this.clearTransientSessionState(sessionId)
    if (reconnectSession && !this.stopping) {
      releaseTransaction()
      const health = await this.refreshProjectHealth(reconnectSession.projectId)
      if (
        health === 'ready' &&
        state.selectedSessionId === reconnectSession.id &&
        state.sessions.some((candidate) => candidate.id === reconnectSession.id)
      ) this.reconnectSelectedSession(reconnectSession.id)
    }
    } finally {
      try {
        if (bindingOutcome === 'precleared') {
          await this.restoreSessionBindings(removedBindings)
          bindingOutcome = 'restored'
          if (!this.stopping) this.publishSnapshotChanged()
        }
      } finally {
        releaseTransaction()
      }
    }
  }

  async duplicateSession(sessionId: string): Promise<SessionSnapshot> {
    if (this.forkStarts.size > 0) {
      throw new ForkSessionUnavailableError('Wait for the session fork to finish before duplicating another session.')
    }
    const releaseAgentRoster = this.acquireAgentRosterTransaction('duplicating a saved-agent session')
    let releaseLifecycle = (): void => undefined
    try {
    releaseLifecycle = this.acquireSessionLifecycle(sessionId, 'duplicating')
    const source = await this.awaitOperationOrStop(this.requireReadySessionProject(sessionId))
    const state = this.requireState()
    const project = this.getProject(source.projectId)
    const timestamp = new Date().toISOString()
    const duplicate: SessionSnapshot = {
      id: crypto.randomUUID(),
      projectId: source.projectId,
      title: duplicateTitle(source.title, state.sessions.map((session) => session.title)),
      status: 'idle',
      model: source.model,
      mode: source.mode,
      reasoningEffort: source.reasoningEffort,
      permissionMode: source.permissionMode,
      contextUsed: 0,
      contextLimit: source.contextLimit,
      transcript: [],
      createdAt: timestamp,
      updatedAt: timestamp
    }
    const roster = this.requireReadyAgentRoster()
    const inheritedAgentId = roster.sessionBindings[sessionId]
    let childBindingCommitted = false
    if (inheritedAgentId) {
      const store = this.requireAgentRosterStore()
      await this.runAgentRosterMutation(() => store.setSessionBinding(
        roster.revision,
        duplicate.id,
        inheritedAgentId
      ), false)
      childBindingCommitted = true
    }
    try {
    const sourceIndex = state.sessions.findIndex((session) => session.id === sessionId)
    const projectIndex = project.sessionIds.indexOf(sessionId)
    if (sourceIndex < 0 || projectIndex < 0) throw new SavedAgentOperationUnavailableError()
    state.sessions.splice(sourceIndex + 1, 0, duplicate)
    project.sessionIds.splice(projectIndex + 1, 0, duplicate.id)
    if (state.selectedSessionId) {
      this.sessions.setProtection(state.selectedSessionId, 'selected', false)
    }
    state.selectedProjectId = source.projectId
    state.selectedSessionId = duplicate.id
    this.emitChanged()
    return structuredClone(duplicate)
    } catch (error) {
      if (childBindingCommitted) await this.compensateSessionBinding(duplicate.id, null)
      throw error
    }
    } finally {
      releaseLifecycle()
      releaseAgentRoster()
    }
  }

  forkSession(sessionId: string): Promise<SessionSnapshot> {
    if (this.sessionHistoryMutation) {
      return Promise.reject(new SessionHistoryUnavailableError())
    }
    if (this.updateQuiescenceToken) {
      return Promise.reject(new UpdateQuiescenceUnavailableError())
    }
    if (this.stopping) return Promise.reject(new PublicAcpError('generic'))
    if (this.migrationApplying) {
      return Promise.reject(new ForkSessionUnavailableError(
        'Wait for state import to finish before forking a session.'
      ))
    }
    if (this.destructivePersistenceTransactions > 0) {
      return Promise.reject(new ForkSessionUnavailableError(
        'Wait for the current save transaction to finish before forking a session.'
      ))
    }
    if (this.sessionLifecycleLocks.has(sessionId) || this.retryStarts.has(sessionId)) {
      return Promise.reject(new ForkSessionUnavailableError(
        'Wait for the current session operation to finish before forking it.'
      ))
    }
    const existing = this.forkStarts.get(sessionId)
    if (existing) return existing
    if (this.forkStarts.size > 0) {
      return Promise.reject(new ForkSessionUnavailableError(
        'Wait for the current session fork to finish before starting another one.'
      ))
    }
    const operation = this.performSessionFork(sessionId)
    this.forkStarts.set(sessionId, operation)
    void operation.finally(() => {
      if (this.forkStarts.get(sessionId) === operation) this.forkStarts.delete(sessionId)
    }).catch(() => undefined)
    return operation
  }

  setProjectPinned(projectId: string, pinned: boolean): void {
    this.assertProjectNotRemoving(projectId, 'pinning')
    const state = this.requireState()
    const project = this.getProject(projectId)
    const alreadyPinned = state.pinnedProjectIds.includes(projectId)
    if (pinned === alreadyPinned) return
    if (pinned) {
      if (state.pinnedProjectIds.length >= MAX_PINNED_PROJECTS) {
        throw new Error(`You can pin up to ${MAX_PINNED_PROJECTS} projects`)
      }
      state.pinnedProjectIds.unshift(projectId)
    } else {
      state.pinnedProjectIds = state.pinnedProjectIds.filter((id) => id !== projectId)
      state.projects = [project, ...state.projects.filter((candidate) => candidate.id !== projectId)]
    }
    this.emitChanged()
  }

  setSessionPinned(sessionId: string, pinned: boolean): void {
    this.assertSessionAvailable(sessionId, 'pinning')
    const state = this.requireState()
    this.getSession(sessionId)
    const alreadyPinned = state.pinnedSessionIds.includes(sessionId)
    if (pinned === alreadyPinned) {
      if (pinned && state.settledSessionIds.includes(sessionId)) {
        state.settledSessionIds = state.settledSessionIds.filter((id) => id !== sessionId)
        this.emitChanged()
      }
      return
    }
    if (pinned) {
      if (state.pinnedSessionIds.length >= MAX_PINNED_SESSIONS) {
        state.pinnedSessionIds.shift()
      }
      state.pinnedSessionIds.push(sessionId)
      state.settledSessionIds = state.settledSessionIds.filter((id) => id !== sessionId)
    } else {
      state.pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId)
    }
    this.emitChanged()
  }

  setSessionSettled(sessionId: string, settled: boolean): void {
    this.assertSessionAvailable(sessionId, 'settling')
    const state = this.requireState()
    const session = this.getSession(sessionId)
    const alreadySettled = state.settledSessionIds.includes(sessionId)
    if (settled) {
      const activityStatus = sessionActivityStatus(
        session,
        this.unreadSessionIds.has(sessionId)
      )
      if (!canSettleSession(activityStatus)) {
        throw new Error('A working session or one that needs input cannot be settled.')
      }
      if (alreadySettled && !state.pinnedSessionIds.includes(sessionId)) return
      state.pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId)
      if (!alreadySettled) {
        if (state.settledSessionIds.length >= MAX_SETTLED_SESSIONS) {
          throw new Error(`You can settle up to ${MAX_SETTLED_SESSIONS} sessions`)
        }
        state.settledSessionIds.push(sessionId)
      }
    } else {
      if (!alreadySettled) return
      state.settledSessionIds = state.settledSessionIds.filter((id) => id !== sessionId)
    }
    this.emitChanged()
  }

  /** Transient renderer focus/attention mutation; deliberately never dirties persistence. */
  setSessionUnread(sessionId: string, unread: boolean): void {
    this.assertSessionAvailable(sessionId, 'changing unread state in')
    const changed = unread
      ? this.markSessionUnread(sessionId)
      : this.clearSessionUnread(sessionId)
    if (changed) this.publishSnapshotChanged()
  }

  async stageAttachments(
    sessionId: string,
    paths: readonly string[]
  ): Promise<AttachmentSelectionSummary> {
    this.assertSessionAvailable(sessionId, 'adding attachments to')
    await this.requireReadySessionProject(sessionId)
    await this.attachments.clearSession(sessionId)
    const session = await this.requireReadySessionProject(sessionId)
    this.assertSessionAvailable(sessionId, 'adding attachments to')
    const project = this.getProject(session.projectId)
    return this.attachments.stage({ sessionId, projectRoot: project.path, paths })
  }

  async prepareAttachments(sessionId: string): Promise<void> {
    this.assertSessionAvailable(sessionId, 'adding attachments to')
    await this.requireReadySessionProject(sessionId)
    this.assertSessionAvailable(sessionId, 'adding attachments to')
  }

  async cancelAttachments(sessionId: string, token: string): Promise<void> {
    this.assertNoStateTransaction('cancelling attachments')
    await this.attachments.cancel(sessionId, token)
  }

  async sendPrompt(sessionId: string, text: string, attachmentToken?: string): Promise<void> {
    const releaseLifecycle = this.acquireSessionLifecycle(sessionId, 'starting a turn in')
    try {
    const userText = text.trim()
    await this.requireReadySessionProject(sessionId)
    if (attachmentToken) {
      await this.sendPromptWithAttachments(sessionId, userText, attachmentToken)
      return
    }
    if (!userText) {
      throw new AttachmentBrokerError('invalid-request')
    }
    this.startPrompt(sessionId, userText, userText)
    } finally {
      releaseLifecycle()
    }
  }

  private async sendPromptWithAttachments(
    sessionId: string,
    userText: string,
    attachmentToken: string
  ): Promise<void> {
    this.getSession(sessionId)
    const consumed = await this.attachments.consume(sessionId, attachmentToken)
    const composed = composeAttachmentPrompt(userText, consumed)
    this.startPrompt(
      sessionId,
      composed.blocks,
      composed.transcriptText,
      this.takeAttachmentDisplayItems(attachmentToken)
    )
  }

  /**
   * Display metadata (names plus bounded preview thumbnails) for staged
   * selections, keyed by lease token. Populated by the IPC layer after
   * staging so a sent user message can carry what it attached.
   */
  private readonly attachmentDisplayItems = new Map<string, AttachmentItemSummary[]>()

  rememberAttachmentDisplayItems(token: string, items: readonly AttachmentItemSummary[]): void {
    if (this.attachmentDisplayItems.size >= 32) {
      const oldest = this.attachmentDisplayItems.keys().next().value
      if (oldest !== undefined) this.attachmentDisplayItems.delete(oldest)
    }
    this.attachmentDisplayItems.set(token, [...items])
  }

  private takeAttachmentDisplayItems(token: string): AttachmentItemSummary[] | undefined {
    const items = this.attachmentDisplayItems.get(token)
    this.attachmentDisplayItems.delete(token)
    return items
  }

  private startPrompt(
    sessionId: string,
    prompt: string | AttachmentPromptBlock[],
    transcriptText: string,
    attachmentItems?: readonly AttachmentItemSummary[]
  ): void {
    this.workingSinceBySessionId.set(sessionId, new Date().toISOString())
    this.clearSessionUnread(sessionId)
    this.updateSessionRecord(sessionId, (current) =>
      appendUserMessage(current, transcriptText, attachmentItems))
    const lifecycleTurn = (this.lifecycleTurns.get(sessionId) ?? 0) + 1
    this.lifecycleTurns.set(sessionId, lifecycleTurn)
    this.emit('sessionLifecycle', { sessionId, status: 'started' })
    const existingClient = this.sessions.get(sessionId)
    if (!existingClient) {
      this.clearPermissionQueue(sessionId)
      this.clearInteractionQueue(sessionId)
    }
    const connection = this.ensureConnected(sessionId)
    const promptClient = this.connectionStarts.get(sessionId)?.client ?? this.sessions.get(sessionId)
    if (promptClient) this.sessions.setProtection(sessionId, 'turn', true)
    void connection
      .then(async (client) => {
        await client.prompt(prompt)
        return client
      })
      .then((client) => {
        if (!this.sessions.isCurrent(sessionId, client)) return
        this.sessions.setProtection(sessionId, 'turn', false)
        this.workingSinceBySessionId.delete(sessionId)
        const cancelled = this.cancelledLifecycleTurns.get(sessionId) === lifecycleTurn
        if (!cancelled && this.requireState().selectedSessionId !== sessionId) {
          this.markSessionUnread(sessionId)
        } else {
          this.clearSessionUnread(sessionId)
        }
        this.updateSessionRecord(sessionId, (current) =>
          applyAcpEvent(current, { type: 'turn_complete' })
        )
        if (!cancelled) {
          this.emit('sessionLifecycle', { sessionId, status: 'completed' })
        }
      })
      .catch((error: unknown) => {
        if (!promptClient || !this.sessions.isCurrent(sessionId, promptClient)) return
        this.sessions.setProtection(sessionId, 'turn', false)
        if (this.cancelledLifecycleTurns.get(sessionId) === lifecycleTurn) return
        this.workingSinceBySessionId.delete(sessionId)
        this.updateSessionRecord(sessionId, (current) =>
          appendSessionError(current, error instanceof Error ? error.message : String(error))
        )
      })
  }

  cancelTurn(sessionId: string): void {
    this.assertSessionAvailable(sessionId, 'cancelling')
    this.assertSessionNotForking(sessionId, 'cancelling')
    const lifecycleTurn = this.lifecycleTurns.get(sessionId)
    if (lifecycleTurn !== undefined) this.cancelledLifecycleTurns.set(sessionId, lifecycleTurn)
    const client = this.sessions.get(sessionId)
    client?.cancel()
    this.permissionQueues.delete(sessionId)
    this.seenPermissionRequests.delete(sessionId)
    this.interactionQueues.delete(sessionId)
    this.sessions.setProtection(sessionId, 'turn', false)
    this.sessions.setProtection(sessionId, 'input', false)
    this.workingSinceBySessionId.delete(sessionId)
    this.clearSessionUnread(sessionId)
    this.updateSessionRecord(sessionId, (session) =>
      applyAcpEvent(withoutPendingInteraction(withoutPendingPermission(session)), { type: 'turn_complete' })
    )
  }

  retrySession(sessionId: string): Promise<void> {
    if (this.stopping) return Promise.reject(new PublicAcpError('generic'))
    const existing = this.retryStarts.get(sessionId)
    if (existing) return existing
    try {
      this.assertSessionAvailable(sessionId, 'retrying')
      this.assertSessionNotForking(sessionId, 'retrying')
    } catch (error) {
      return Promise.reject(error)
    }
    this.getSession(sessionId)
    const operation = this.performSessionRetry(sessionId)
    this.retryStarts.set(sessionId, operation)
    void operation.then(
      () => {
        if (this.retryStarts.get(sessionId) === operation) this.retryStarts.delete(sessionId)
      },
      () => {
        if (this.retryStarts.get(sessionId) === operation) this.retryStarts.delete(sessionId)
      }
    )
    return operation
  }

  async answerPermission(sessionId: string, requestId: string, optionId: string): Promise<void> {
    this.assertSessionAvailable(sessionId, 'answering a permission request in')
    this.assertSessionNotForking(sessionId, 'answering a permission request in')
    const session = this.getSession(sessionId)
    const queue = this.permissionQueues.get(sessionId) ?? []
    const pending = queue[0]
    if (pending?.requestId !== requestId || session.pendingPermission?.requestId !== requestId) {
      throw new Error('Permission request is no longer active')
    }
    if (!pending.options.some((option) => option.id === optionId)) {
      throw new Error('Permission option is not available for this request')
    }
    const client = this.sessions.get(sessionId)
    if (!client) {
      this.clearPermissionQueue(sessionId)
      await this.ensureConnected(sessionId)
      throw new Error('Permission request was refreshed after reconnect; answer the current request')
    }
    await client.answerPermission(requestId, optionId)
    if (!this.sessions.isCurrent(sessionId, client)) {
      throw new Error('Session process changed while the permission response was pending')
    }
    if (this.permissionQueues.get(sessionId)?.[0]?.requestId !== requestId) {
      throw new Error('Permission queue changed while the response was pending')
    }
    queue.shift()
    this.syncPermissionHead(sessionId)
    if (this.getSession(sessionId).permissionMode === 'auto') {
      void this.pumpAutoPermissions(sessionId)
    }
  }

  async answerInteraction(
    sessionId: string,
    interactionId: string,
    answer: InteractionAnswer
  ): Promise<void> {
    this.assertSessionAvailable(sessionId, 'answering a question in')
    this.assertSessionNotForking(sessionId, 'answering a question in')
    const session = this.getSession(sessionId)
    const queue = this.interactionQueues.get(sessionId) ?? []
    const pending = queue[0]
    if (
      pending?.interactionId !== interactionId ||
      session.pendingInteraction?.interactionId !== interactionId
    ) {
      throw new Error('Interaction is no longer active')
    }
    if (pending.kind !== answer.kind) throw new Error('Interaction response type does not match')
    const client = this.sessions.get(sessionId)
    if (!client) {
      this.clearInteractionQueue(sessionId)
      await this.ensureConnected(sessionId)
      throw new Error('Interaction was refreshed after reconnect; answer the current card')
    }
    await client.answerInteraction(interactionId, answer)
    if (!this.sessions.isCurrent(sessionId, client)) {
      throw new Error('Session process changed while the interaction response was pending')
    }
    if (this.interactionQueues.get(sessionId)?.[0]?.interactionId !== interactionId) {
      throw new Error('Interaction queue changed while the response was pending')
    }
    queue.shift()
    this.syncInteractionHead(sessionId)
  }

  updateSession(input: UpdateSessionInput): void {
    this.assertSessionAvailable(input.sessionId, 'changing')
    this.assertSessionNotForking(input.sessionId, 'changing')
    const previous = this.getSession(input.sessionId)
    this.updateSessionRecord(input.sessionId, (session) => ({
      ...session,
      ...(input.title ? { title: input.title } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      updatedAt: new Date().toISOString()
    }))
    const client = this.sessions.get(input.sessionId)
    if (input.reasoningEffort && input.reasoningEffort !== previous.reasoningEffort) {
      this.updateSessionRecord(input.sessionId, withoutCapabilities)
      if (!client && !previous.acpSessionId) return
      this.clearPermissionQueue(input.sessionId)
      this.clearInteractionQueue(input.sessionId)
      void this.sessions.stop(input.sessionId)
        .then(() => this.ensureConnected(input.sessionId))
        .catch((error: unknown) => {
          this.updateSessionRecord(input.sessionId, (session) =>
            appendSessionError(
              session,
              `Reconnect failed: ${error instanceof Error ? error.message : String(error)}`
            )
          )
        })
      return
    }
    if (!client) return
    if (input.model && input.model !== previous.model) {
      void client.setModel(input.model).catch((error: unknown) => {
        if (!this.sessions.isCurrent(input.sessionId, client)) return
        this.updateSessionRecord(input.sessionId, (session) => ({
          ...appendSessionError(
            session,
            `Model switch failed: ${error instanceof Error ? error.message : String(error)}`
          ),
          model: previous.model
        }))
      })
    }
    if (input.mode && input.mode !== previous.mode) {
      void client.setMode(input.mode).catch((error: unknown) => {
        if (!this.sessions.isCurrent(input.sessionId, client)) return
        this.updateSessionRecord(input.sessionId, (session) => ({
          ...appendSessionError(
            session,
            `Mode switch failed: ${error instanceof Error ? error.message : String(error)}`
          ),
          mode: previous.mode
        }))
      })
    }
    if (input.permissionMode === 'auto' && input.permissionMode !== previous.permissionMode) {
      void this.pumpAutoPermissions(input.sessionId)
    }
  }

  async updateSettings(input: UpdateSettingsInput): Promise<void> {
    this.assertNoStateTransaction('changing settings')
    const state = this.requireState()
    const nextSettings: AppSettings = {
      ...state.settings,
      ...(input.appearance !== undefined ? { appearance: input.appearance } : {}),
      ...(input.reduceMotion !== undefined ? { reduceMotion: input.reduceMotion } : {}),
      ...(input.maxLiveSessions !== undefined ? { maxLiveSessions: input.maxLiveSessions } : {}),
      ...(input.privacyMode !== undefined ? { privacyMode: input.privacyMode } : {}),
      ...(input.memoryEnabled !== undefined ? { memoryEnabled: input.memoryEnabled } : {})
    }
    if (settingsEqual(state.settings, nextSettings)) return

    if (nextSettings.memoryEnabled !== state.settings.memoryEnabled) {
      if (this.memoryOperations.size > 0) throw new MemorySettingsUnavailableError()
      if (this.memorySettingsOperation) throw new MemorySettingsUnavailableError()
      const operation = this.performMemorySettingsUpdate(state, nextSettings)
      this.memorySettingsOperation = operation
      void operation.finally(() => {
        if (this.memorySettingsOperation === operation) this.memorySettingsOperation = undefined
      }).catch(() => undefined)
      return operation
    }

    state.settings = nextSettings
    if (input.maxLiveSessions !== undefined) this.sessions.setLimit(input.maxLiveSessions)
    this.emitChanged()
  }

  async listMemory(): Promise<PublicMemoryFileSummary[]> {
    return this.runMemoryOperation(async (broker) => broker.list())
  }

  async readMemory(token: string): Promise<PublicMemoryFileContents> {
    return this.runMemoryOperation(async (broker) => broker.read(token))
  }

  async rememberMemory(note: string): Promise<void> {
    return this.runMemoryOperation(async (broker) => {
      if (!this.requireState().settings.memoryEnabled) {
        throw new MemoryOperationUnavailableError('Enable Memory before saving a note.')
      }
      await broker.remember(note)
    })
  }

  async deleteMemory(token: string): Promise<void> {
    return this.runMemoryOperation(async (broker) => broker.deleteSession(token))
  }

  /**
   * Zero-input, main-owned dashboard inspection for the currently selected
   * project. The integration lease prevents an app/CLI update from beginning
   * while Git is running; selection, path, and filesystem identity are checked
   * again before any result is returned.
   */
  async inspectDashboardGit(): Promise<DashboardProjectStatus> {
    const lease = this.acquireIntegrationOperation()
    try {
      const expectedState = this.requireState()
      const selectedProjectId = expectedState.selectedProjectId
      const expectedProject = selectedProjectId
        ? expectedState.projects.find((project) => project.id === selectedProjectId)
        : undefined
      if (!selectedProjectId || !expectedProject) {
        throw new DashboardInspectionUnavailableError()
      }
      const expectedPath = expectedProject.path

      const { project, health } = await this.refreshStableProject(selectedProjectId)
      this.assertStableDashboardSelection(
        expectedState,
        expectedProject,
        expectedPath
      )
      if (project !== expectedProject) throw new DashboardInspectionUnavailableError()
      if (health !== 'ready') throw new WorkspaceUnavailableError(health)

      const initialWorkspaceIdentity = await this.workspaceHealthService.identity(expectedPath)
      this.assertStableDashboardSelection(
        expectedState,
        expectedProject,
        expectedPath
      )
      if (!initialWorkspaceIdentity) throw new WorkspaceUnavailableError('changed')

      const inspected = await this.dashboardInspector.inspect({
        projectId: selectedProjectId,
        canonicalProjectPath: expectedPath
      })
      const currentWorkspaceIdentity = await this.workspaceHealthService.identity(expectedPath)
      this.assertStableDashboardSelection(
        expectedState,
        expectedProject,
        expectedPath
      )
      if (!sameWorkspaceIdentity(initialWorkspaceIdentity, currentWorkspaceIdentity)) {
        throw new WorkspaceUnavailableError('changed')
      }
      return dashboardProjectStatusSchema.parse(inspected)
    } catch (error) {
      if (
        error instanceof DashboardInspectionUnavailableError ||
        error instanceof WorkspaceUnavailableError
      ) {
        throw error
      }
      // Injected inspectors, Git diagnostics, schema failures, and filesystem
      // errors may contain private paths or repository content.
      throw new DashboardInspectionUnavailableError()
    } finally {
      lease.release()
    }
  }

  /** Lists recent Grok sessions for the current main-owned project/CLI context. */
  async listSessionHistory(): Promise<PublicSessionHistoryRecord[]> {
    if (this.sessionHistoryMutation) throw new SessionHistoryUnavailableError()
    const lease = this.acquireIntegrationOperation()
    try {
      const context = await this.captureSessionHistoryContext()
      const records = await this.trackSessionHistoryOperation(
        this.sessionHistoryBroker.list(historyBrokerInput(context))
      )
      this.assertStableSessionHistoryContext(context)
      return structuredClone(records)
    } catch (error) {
      throw publicSessionHistoryError(error)
    } finally {
      lease.release()
    }
  }

  /** Searches with one already validated bounded query; paths remain main-only. */
  async searchSessionHistory(query: string): Promise<PublicSessionHistoryRecord[]> {
    if (this.sessionHistoryMutation) throw new SessionHistoryUnavailableError()
    const lease = this.acquireIntegrationOperation()
    try {
      const context = await this.captureSessionHistoryContext()
      const records = await this.trackSessionHistoryOperation(
        this.sessionHistoryBroker.search({
          ...historyBrokerInput(context),
          query
        })
      )
      this.assertStableSessionHistoryContext(context)
      return structuredClone(records)
    } catch (error) {
      throw publicSessionHistoryError(error)
    } finally {
      lease.release()
    }
  }

  /**
   * Opens an opaque history capability. A matching local tab is selected;
   * otherwise a transactionally persisted local shell is bound to the cached
   * remote id and loaded through ACP without the stale-session new-chat fallback.
   */
  async openSessionHistory(token: string): Promise<import('../shared/models').PublicSessionSnapshot> {
    const operation = this.acquireSessionHistoryMutation()
    let localSessionId: string | undefined
    let inserted = false
    let client: AcpConnection | undefined
    let rollback: HistoryOpenRollback | undefined
    try {
      const context = await this.captureSessionHistoryContext()
      const firstResolution = await this.sessionHistoryBroker.resolve({
        ...historyBrokerInput(context),
        token
      })
      this.assertStableSessionHistoryContext(context)

      const existing = context.state.sessions.find((session) =>
        session.projectId === context.project.id &&
        session.acpSessionId === firstResolution.remoteId
      )
      if (existing) {
        await this.sessionHistoryBroker.resolve({
          ...historyBrokerInput(context),
          token
        })
        this.assertStableSessionHistoryContext(context)
        this.selectResolvedHistorySession(existing)
        const selected = this.publicSessionById(existing.id)
        // Reconnect only after releasing our own state-write barrier. The call
        // is synchronous up to SessionManager registration, so no renderer
        // mutation can interleave between release and connection ownership.
        operation.release()
        this.reconnectSelectedSession(existing.id)
        return selected
      }

      const state = context.state
      const project = context.project
      const template = state.sessions.find((session) => session.id === state.selectedSessionId)
      const timestamp = new Date().toISOString()
      localSessionId = crypto.randomUUID()
      const restored: SessionSnapshot = {
        id: localSessionId,
        acpSessionId: firstResolution.remoteId,
        projectId: project.id,
        title: sessionHistoryTitle(firstResolution.summary),
        status: 'idle',
        model: template?.projectId === project.id ? template.model : 'grok-4.6',
        mode: template?.projectId === project.id ? template.mode : 'default',
        reasoningEffort: template?.projectId === project.id ? template.reasoningEffort : 'xhigh',
        permissionMode: template?.projectId === project.id ? template.permissionMode : 'ask',
        contextUsed: 0,
        contextLimit: template?.projectId === project.id ? template.contextLimit : 500_000,
        transcript: [],
        createdAt: timestamp,
        updatedAt: timestamp
      }
      validateHistoryInsertion(state, project.id, restored)
      this.requireReadyAgentRoster()

      client = this.sessions.createDeferred(localSessionId, {
        cliPath: context.cliPath,
        cwd: context.canonicalCwd,
        model: restored.model,
        reasoningEffort: restored.reasoningEffort,
        memoryEnabled: context.state.settings.memoryEnabled,
        resumeSessionId: firstResolution.remoteId,
        allowStaleFallback: false,
        ...(process.env.GROKBUILD_E2E === '1' ? { env: { GROKBUILD_E2E: '1' } } : {})
      })
      this.beginActivityProjectionStart(localSessionId, false)
      const started = await client.start()
      const finalResolution = await this.sessionHistoryBroker.resolve({
        ...historyBrokerInput(context),
        token
      })
      this.assertStableSessionHistoryContext(context)
      if (
        finalResolution.remoteId !== firstResolution.remoteId ||
        finalResolution.summary !== firstResolution.summary ||
        !this.sessions.isCurrent(localSessionId, client) ||
        started.sessionId !== firstResolution.remoteId ||
        started.resumed !== true ||
        started.staleFallbackFrom !== undefined
      ) {
        throw new SessionHistoryUnavailableError()
      }

      rollback = {
        selection: currentSelection(state),
        mappedSessionId: state.selectedSessionIdByProject[project.id]
      }
      state.sessions.push(restored)
      project.sessionIds.push(restored.id)
      state.selectedProjectId = project.id
      state.selectedSessionId = restored.id
      rememberDurableSelection(state, restored)
      this.sessions.setProtection(restored.id, 'selected', true)
      inserted = true
      this.sessions.activateDeferred(restored.id, client)
      this.activateActivityProjection(restored.id)
      if (!this.sessions.isCurrent(restored.id, client)) {
        throw new SessionHistoryUnavailableError()
      }
      this.emitChanged()
      await this.flushPersistence(true)
      if (rollback.selection.sessionId && rollback.selection.sessionId !== restored.id) {
        this.sessions.setProtection(rollback.selection.sessionId, 'selected', false)
      }
      this.sessions.enforceLimit(restored.id)
      return this.publicSessionById(restored.id)
    } catch (error) {
      if (localSessionId) this.failActivityProjectionStart(localSessionId)
      if (inserted && localSessionId && rollback && this.state) {
        const state = this.state
        const candidate = state.sessions.find((session) => session.id === localSessionId)
        if (candidate) {
          const project = state.projects.find((item) => item.id === candidate.projectId)
          state.sessions = state.sessions.filter((session) => session.id !== localSessionId)
          if (project) project.sessionIds = project.sessionIds.filter((id) => id !== localSessionId)
          state.pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== localSessionId)
          state.settledSessionIds = state.settledSessionIds.filter((id) => id !== localSessionId)
          if (state.selectedSessionIdByProject[candidate.projectId] === localSessionId) {
            if (rollback.mappedSessionId) {
              state.selectedSessionIdByProject[candidate.projectId] = rollback.mappedSessionId
            } else {
              delete state.selectedSessionIdByProject[candidate.projectId]
            }
          }
          if (state.selectedSessionId === localSessionId) applySelection(state, rollback.selection)
          this.clearTransientSessionState(localSessionId)
          this.sessions.setProtection(localSessionId, 'selected', false)
          if (rollback.selection.sessionId) {
            this.sessions.setProtection(rollback.selection.sessionId, 'selected', true)
          }
          this.emitChanged()
          await this.flushPersistence().catch(() => undefined)
        }
      }
      if (localSessionId) await this.stopSessionWorker(localSessionId).catch(() => undefined)
      else if (client) await client.stop().catch(() => undefined)
      throw publicSessionHistoryError(error)
    } finally {
      operation.release()
    }
  }

  /** Native-confirmed, one-shot deletion using only a cached main-owned remote id. */
  async deleteSessionHistory(
    token: string,
    confirmDelete: SessionHistoryDeleteConfirmation
  ): Promise<SessionHistoryDeleteResult> {
    const operation = this.acquireSessionHistoryMutation()
    try {
      const context = await this.captureSessionHistoryContext()
      const resolution = await this.sessionHistoryBroker.resolve({
        ...historyBrokerInput(context),
        token
      })
      this.assertStableSessionHistoryContext(context)
      assertHistoryDeleteUnprotected(context.state, context.project.id, resolution.remoteId)

      let confirmed: boolean
      try {
        confirmed = await confirmDelete(sessionHistoryTitle(resolution.summary))
      } catch {
        throw new SessionHistoryUnavailableError()
      }
      if (confirmed !== true && confirmed !== false) throw new SessionHistoryUnavailableError()
      if (!confirmed) return { state: 'cancelled' }

      this.assertStableSessionHistoryContext(context)
      const finalResolution = await this.sessionHistoryBroker.resolve({
        ...historyBrokerInput(context),
        token
      })
      this.assertStableSessionHistoryContext(context)
      if (
        finalResolution.remoteId !== resolution.remoteId ||
        finalResolution.summary !== resolution.summary
      ) {
        throw new SessionHistoryUnavailableError()
      }
      assertHistoryDeleteUnprotected(context.state, context.project.id, resolution.remoteId)
      await this.trackSessionHistoryOperation(this.sessionHistoryBroker.delete(
        { ...historyBrokerInput(context), token },
        () => {
          // This callback runs after the broker's asynchronous path/identity
          // checks and immediately before it consumes the destructive token.
          this.assertStableSessionHistoryContext(context)
          assertHistoryDeleteUnprotected(
            this.requireState(),
            context.project.id,
            resolution.remoteId
          )
          return { isLive: false, isSelected: false }
        }
      ))
      this.assertStableSessionHistoryContext(context)
      assertHistoryDeleteUnprotected(
        this.requireState(),
        context.project.id,
        resolution.remoteId
      )
      return { state: 'deleted' }
    } catch (error) {
      throw publicSessionHistoryError(error)
    } finally {
      operation.release()
    }
  }

  async setGrokCliPath(inputPath: string): Promise<string> {
    if (this.agentRosterTransaction) {
      throw new SavedAgentOperationUnavailableError(
        'Wait for the saved-agent operation to finish before changing the Grok CLI.'
      )
    }
    this.assertNoStateTransaction('changing the Grok CLI')
    if (this.forkStarts.size > 0) {
      throw new ForkSessionUnavailableError('Wait for the session fork to finish before changing the Grok CLI.')
    }
    const path = await realpath(inputPath)
    if (!(await isExecutable(path))) throw new Error('Selected Grok CLI is not an executable file')
    if (this.agentRosterTransaction) {
      throw new SavedAgentOperationUnavailableError(
        'Wait for the saved-agent operation to finish before changing the Grok CLI.'
      )
    }
    this.assertNoStateTransaction('changing the Grok CLI')
    const state = this.requireState()
    state.settings = { ...state.settings, grokCliPath: path }
    this.cliAvailable = true
    this.cliVersion = undefined
    this.setAllActivityProjectionsOffline()
    await this.sessions.stopAll()
    state.sessions = state.sessions.map(withoutCapabilities)
    this.emitChanged()
    return path
  }

  async acquireUpdateQuiescence(): Promise<UpdateQuiescenceLease> {
    if (!this.canAcquireUpdateQuiescence()) {
      throw new UpdateQuiescenceUnavailableError()
    }

    const token = Symbol('update-quiescence')
    this.updateQuiescenceToken = token
    this.sessionHistoryBroker.clear()
    try {
      this.setAllActivityProjectionsOffline()
      await this.sessions.stopAll()
      if (this.stopping || this.updateQuiescenceToken !== token) {
        throw new UpdateQuiescenceUnavailableError()
      }
      this.connectionStarts.clear()
      const state = this.requireState()
      state.sessions = state.sessions.map(withoutCapabilities)
      this.emitChanged()
      await this.flushPersistence(true)
    } catch {
      this.releaseUpdateQuiescence(token)
      throw new UpdateQuiescenceUnavailableError()
    }

    let released = false
    return Object.freeze({
      release: () => {
        if (released) return
        released = true
        this.releaseUpdateQuiescence(token)
      }
    })
  }

  acquireIntegrationOperation(): IntegrationOperationLease {
    this.assertNoStateTransaction('starting this operation')
    if (this.stopping) throw new UpdateQuiescenceUnavailableError()
    this.integrationOperations += 1
    let released = false
    return Object.freeze({
      release: () => {
        if (released) return
        released = true
        this.integrationOperations = Math.max(0, this.integrationOperations - 1)
      }
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.resolveStopRequested()
    this.sessionHistoryBroker.clear()
    this.options.agentCatalogService?.clear()
    this.options.memoryBroker?.clear()
    this.setAllActivityProjectionsOffline()
    const sessionHistoryOperations = [...this.sessionHistoryOperations]
    const migrationOperation = this.migrationOperation
    const retryStarts = [...this.retryStarts.values()]
    const forkStarts = [...this.forkStarts.values()]
    const healthChecks = [...this.workspaceHealthChecks.values()].map((entry) => entry.promise)
    const agentRosterOperations = [...this.agentRosterOperations]
    const agentCatalogOperations = [...this.agentCatalogOperations]
    const memoryOperations = [...this.memoryOperations]
    const memorySettingsOperation = this.memorySettingsOperation
    await Promise.all([
      this.sessions.stopAll(),
      this.attachments.dispose(),
      Promise.allSettled([...this.detachedSessionCleanups]),
      Promise.allSettled(sessionHistoryOperations),
      migrationOperation ? migrationOperation.catch(() => undefined) : Promise.resolve()
    ])
    // Saved-agent mutations and lifecycle transactions can span roster writes,
    // app-state persistence, and binding compensation. Once workers have been
    // stopped, these operations must reach their atomic outcome before shutdown
    // is allowed to flush and return. A timeout here would permit them to write
    // after quit. Fork/duplicate waits that have not entered a durable critical
    // section race stopRequested and therefore cannot deadlock this barrier.
    await Promise.allSettled([
      ...agentRosterOperations,
      ...forkStarts,
      ...memoryOperations,
      ...(memorySettingsOperation ? [memorySettingsOperation] : [])
    ])
    await settleWithin([
      ...retryStarts,
      ...healthChecks,
      ...agentCatalogOperations
    ], 250)
    this.connectionStarts.clear()
    this.retryStarts.clear()
    this.forkStarts.clear()
    this.workspaceHealthChecks.clear()
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = undefined
    }
    await this.flushPersistence()
    this.updateQuiescenceToken = undefined
  }

  private async performMemorySettingsUpdate(
    expectedState: PersistedState,
    nextSettings: AppSettings
  ): Promise<void> {
    const release = this.acquireMemorySettingsTransaction()
    const liveSessionIds = this.sessions.liveSessionIds()
    const selectedSession = expectedState.sessions.find(
      (session) => session.id === expectedState.selectedSessionId
    )
    const recycleIds = [...new Set([
      ...liveSessionIds,
      ...(selectedSession?.acpSessionId ? [selectedSession.id] : [])
    ])]
    let committed = false
    try {
      if (this.requireState() !== expectedState) throw new MemorySettingsUnavailableError()
      await this.saveSettingsInPersistenceLane(expectedState, nextSettings)

      if (this.requireState() !== expectedState) throw new MemorySettingsUnavailableError()
      expectedState.settings = structuredClone(nextSettings)
      committed = true
      this.sessions.setLimit(nextSettings.maxLiveSessions)
      this.options.memoryBroker?.clear()
      this.memoryContextIdentity = memoryContextIdentity(expectedState)
      this.publishSnapshotChanged()

      if (this.stopping) return
      // The preflight is the only busy gate. Once the setting is durable, every
      // captured worker must leave its immutable old launch flag even if an ACP
      // activity event arrived while the save was in flight.
      const recycled = await this.recycleMemoryWorkers(recycleIds)
      if (!recycled) throw new MemorySettingsReconnectError()
    } catch (error) {
      if (committed) {
        if (error instanceof MemorySettingsReconnectError) throw error
        throw new MemorySettingsReconnectError()
      }
      if (error instanceof MemorySettingsUnavailableError) throw error
      // saveStateInPersistenceLane emits only this fixed application-state error.
      throw error instanceof Error
        ? error
        : new Error('Application state could not be persisted.')
    } finally {
      release()
    }
  }

  private acquireMemorySettingsTransaction(): () => void {
    if (!this.canChangeMemorySetting()) throw new MemorySettingsUnavailableError()
    const token = Symbol('memory-settings')
    this.memorySettingsTransaction = token
    this.destructivePersistenceTransactions += 1
    this.integrationOperations += 1
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.memorySettingsTransaction === token) this.memorySettingsTransaction = undefined
      this.destructivePersistenceTransactions = Math.max(
        0,
        this.destructivePersistenceTransactions - 1
      )
      this.integrationOperations = Math.max(0, this.integrationOperations - 1)
    }
  }

  private canChangeMemorySetting(): boolean {
    if (
      !this.canAcquireUpdateQuiescence() ||
      this.agentRosterTransaction !== undefined ||
      this.sessionHistoryMutation !== undefined ||
      this.memorySettingsTransaction !== undefined ||
      this.memoryOperations.size > 0 ||
      this.workingSinceBySessionId.size > 0
    ) return false
    for (const projection of [
      ...this.activityProjectionStarts.values(),
      ...this.activityProjections.values()
    ]) {
      if (
        projection.getSnapshot().syncState !== 'offline' &&
        projection.hasLiveProtectionWork()
      ) return false
    }
    return true
  }

  private async recycleMemoryWorkers(sessionIds: string[]): Promise<boolean> {
    const stopResults = await Promise.allSettled(
      sessionIds.map((sessionId) => this.stopWorkerForMemorySetting(sessionId))
    )
    if (this.stopping) return true

    const reconnectIds = sessionIds.filter((_sessionId, index) =>
      stopResults[index]?.status === 'fulfilled'
    )
    const reconnectResults = await Promise.allSettled(reconnectIds.map(async (sessionId) => {
      const session = this.requireState().sessions.find((candidate) => candidate.id === sessionId)
      if (
        !session?.acpSessionId ||
        this.workspaceHealthStates.get(session.projectId) !== 'ready' ||
        this.stopping
      ) return
      try {
        await this.ensureConnected(sessionId, true)
      } catch {
        await this.stopWorkerForMemorySetting(sessionId).catch(() => undefined)
        throw new MemorySettingsReconnectError()
      }
    }))
    return stopResults.every((result) => result.status === 'fulfilled') &&
      reconnectResults.every((result) => result.status === 'fulfilled')
  }

  private async stopWorkerForMemorySetting(sessionId: string): Promise<void> {
    this.permissionQueues.delete(sessionId)
    this.seenPermissionRequests.delete(sessionId)
    this.interactionQueues.delete(sessionId)
    this.autoPermissionPumps.delete(sessionId)
    this.connectionStarts.delete(sessionId)
    this.workingSinceBySessionId.delete(sessionId)
    this.failActivityProjectionStart(sessionId)
    this.setActivityProjectionOffline(sessionId)
    this.updateSessionRecord(sessionId, withoutCapabilities)
    await this.sessions.stop(sessionId)
  }

  private runMemoryOperation<T>(
    operation: (broker: Pick<MemoryBroker, 'list' | 'read' | 'remember' | 'deleteSession' | 'clear'>) => Promise<T>
  ): Promise<T> {
    const broker = this.options.memoryBroker
    if (!broker) return Promise.reject(new MemoryOperationUnavailableError())
    let lease: IntegrationOperationLease
    try {
      lease = this.acquireIntegrationOperation()
    } catch {
      return Promise.reject(new MemoryOperationUnavailableError())
    }
    const tracked = (async () => {
      try {
        return await operation(broker)
      } finally {
        lease.release()
      }
    })()
    this.memoryOperations.add(tracked)
    void tracked.finally(() => this.memoryOperations.delete(tracked)).catch(() => undefined)
    return tracked
  }

  private reconnectSelectedSession(sessionId: string): void {
    if (this.stopping || this.updateQuiescenceToken) return
    const session = this.getSession(sessionId)
    if (this.workspaceHealthStates.get(session.projectId) !== 'ready') return
    if (!session.acpSessionId || this.sessions.get(sessionId)) return
    void this.ensureConnected(sessionId).catch((error: unknown) => {
      this.updateSessionRecord(sessionId, (current) =>
        appendSessionError(
          current,
          `Reconnect failed: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    })
  }

  private async performSessionRetry(sessionId: string): Promise<void> {
    const releaseLifecycle = this.acquireSessionLifecycle(sessionId, 'retrying')
    try {
    await this.requireReadySessionProject(sessionId)
    if (this.stopping) throw new PublicAcpError('generic')
    this.getSession(sessionId)
    this.updateSessionRecord(sessionId, (session) => retryState(session, 'starting'))
    try {
      await this.stopSessionWorker(sessionId)
      if (this.stopping) throw new PublicAcpError('generic')
      await this.ensureConnected(sessionId)
      if (this.stopping) throw new PublicAcpError('generic')
      this.updateSessionRecord(sessionId, (session) => retryState(session, 'idle'))
    } catch (error) {
      const publicError = toPublicAcpError(error)
      await this.stopSessionWorker(sessionId).catch(() => undefined)
      if (this.stopping) throw publicError
      this.updateSessionRecord(sessionId, (session) =>
        appendSessionError(retryState(session, 'idle'), publicError.message)
      )
      throw publicError
    }
    } finally {
      releaseLifecycle()
    }
  }

  private async performSessionFork(sessionId: string): Promise<SessionSnapshot> {
    const releaseAgentRoster = this.acquireAgentRosterTransaction('forking a saved-agent session')
    try {
      return await this.performSessionForkTransaction(sessionId)
    } finally {
      releaseAgentRoster()
    }
  }

  private async performSessionForkTransaction(sessionId: string): Promise<SessionSnapshot> {
    const source = await this.awaitOperationOrStop(this.requireReadySessionProject(sessionId))
    if (this.stopping) throw new PublicAcpError('generic')
    if (!isForkableSourceSession(source)) {
      throw new ForkSessionUnavailableError('Only an idle, settled session can be forked.')
    }
    if (!isStrictUuid(source.acpSessionId)) {
      throw new ForkSessionUnavailableError('Start this session before forking it.')
    }
    if (!supportsSessionFork(this.cliVersion)) {
      throw new ForkSessionUnavailableError('Grok CLI 1.0.5 or newer is required to fork sessions.')
    }

    const state = this.requireState()
    const sourceSnapshot = structuredClone(source)
    const project = this.getProject(source.projectId)
    if (this.projectRemovalLocks.has(project.id)) {
      throw new ForkSessionUnavailableError(
        'Wait for the project operation to finish before forking this session.'
      )
    }
    const projectPath = project.path
    const sourceWorkspaceIdentity = await this.awaitOperationOrStop(
      this.workspaceHealthService.identity(projectPath)
    )
    if (this.stopping) throw new PublicAcpError('generic')
    if (!sourceWorkspaceIdentity) throw new WorkspaceUnavailableError('changed')
    const localSessionId = crypto.randomUUID()
    const remoteSessionId = crypto.randomUUID()
    const forkTimestamp = new Date().toISOString()
    const projectedFork = forkedSessionSnapshot(
      sourceSnapshot,
      localSessionId,
      remoteSessionId,
      forkTimestamp
    )
    const projectedState = structuredClone(state)
    const projectedProject = projectedState.projects.find((candidate) => candidate.id === project.id)
    const projectedSourceIndex = projectedState.sessions.findIndex(
      (candidate) => candidate.id === sourceSnapshot.id
    )
    const projectedProjectIndex = projectedProject?.sessionIds.indexOf(sourceSnapshot.id) ?? -1
    if (!projectedProject || projectedSourceIndex < 0 || projectedProjectIndex < 0) {
      throw new PublicAcpError('generic')
    }
    projectedState.sessions.splice(projectedSourceIndex + 1, 0, projectedFork)
    projectedProject.sessionIds.splice(projectedProjectIndex + 1, 0, projectedFork.id)
    projectedState.selectedProjectId = projectedProject.id
    projectedState.selectedSessionId = projectedFork.id
    rememberDurableSelection(projectedState, projectedFork)
    try {
      serializePersistedState(projectedState)
    } catch {
      throw new ForkSessionUnavailableError(
        'This session cannot be forked because the saved workspace limit was reached.'
      )
    }
    const roster = this.requireReadyAgentRoster()
    const inheritedAgentId = roster.sessionBindings[sessionId]
    const inheritedAgent = inheritedAgentId
      ? roster.agents.find((agent) => agent.id === inheritedAgentId)
      : undefined
    if (inheritedAgentId && !inheritedAgent) throw new SavedAgentOperationUnavailableError()
    let childBindingCommitted = false
    if (inheritedAgentId) {
      const store = this.requireAgentRosterStore()
      await this.runAgentRosterMutation(() => store.setSessionBinding(
        roster.revision,
        localSessionId,
        inheritedAgentId
      ), false)
      childBindingCommitted = true
    }
    if (this.stopping) {
      if (childBindingCommitted) {
        await this.compensateSessionBinding(localSessionId, null)
        childBindingCommitted = false
      }
      throw new PublicAcpError('generic')
    }
    const client = this.sessions.createDeferred(localSessionId, {
      cliPath: state.settings.grokCliPath,
      cwd: project.path,
      model: source.model,
      reasoningEffort: source.reasoningEffort,
      memoryEnabled: state.settings.memoryEnabled,
      ...(inheritedAgent ? { agentProfile: inlineAcpAgentProfile(inheritedAgent) } : {}),
      forkSession: {
        sourceSessionId: source.acpSessionId,
        newSessionId: remoteSessionId,
        newModelId: source.model
      },
      ...(process.env.GROKBUILD_E2E === '1' ? { env: { GROKBUILD_E2E: '1' } } : {})
    })
    this.beginActivityProjectionStart(localSessionId, false)
    let inserted = false
    let previousSelectedProjectId: string | undefined
    let previousSelectedSessionId: string | undefined
    let previousProjectSelection: string | undefined
    try {
      const started = await this.awaitOperationOrStop(client.start())
      const freshSource = await this.awaitOperationOrStop(
        this.requireReadySessionProject(sessionId)
      )
      const freshProject = this.getProject(freshSource.projectId)
      const freshWorkspaceIdentity = await this.awaitOperationOrStop(
        this.workspaceHealthService.identity(projectPath)
      )
      if (!sameWorkspaceIdentity(sourceWorkspaceIdentity, freshWorkspaceIdentity)) {
        throw new WorkspaceUnavailableError('changed')
      }
      if (
        this.stopping ||
        !this.sessions.isCurrent(localSessionId, client) ||
        this.requireState() !== state ||
        freshSource !== source ||
        !isForkableSourceSession(freshSource) ||
        freshSource.acpSessionId !== sourceSnapshot.acpSessionId ||
        freshSource.projectId !== sourceSnapshot.projectId ||
        freshProject !== project ||
        freshProject.path !== projectPath ||
        started.sessionId !== remoteSessionId ||
        started.forkedFrom !== sourceSnapshot.acpSessionId
      ) {
        throw new PublicAcpError('generic')
      }

      const forked = projectedFork
      const sourceIndex = state.sessions.findIndex((candidate) => candidate.id === sourceSnapshot.id)
      const projectIndex = project.sessionIds.indexOf(sourceSnapshot.id)
      if (sourceIndex < 0 || projectIndex < 0) throw new PublicAcpError('generic')
      previousSelectedProjectId = state.selectedProjectId
      previousSelectedSessionId = state.selectedSessionId
      previousProjectSelection = state.selectedSessionIdByProject[project.id]
      state.sessions.splice(sourceIndex + 1, 0, forked)
      project.sessionIds.splice(projectIndex + 1, 0, forked.id)
      inserted = true
      this.sessions.setProtection(forked.id, 'selected', true)
      state.selectedProjectId = project.id
      state.selectedSessionId = forked.id
      rememberDurableSelection(state, forked)
      this.sessions.activateDeferred(localSessionId, client)
      this.activateActivityProjection(localSessionId)
      const activated = state.sessions.find((candidate) => candidate.id === localSessionId)
      if (
        !this.sessions.isCurrent(localSessionId, client) ||
        activated?.status !== 'idle' ||
        activated.pendingPermission ||
        activated.pendingInteraction
      ) {
        throw new PublicAcpError('generic')
      }
      this.emitChanged()
      await this.flushPersistence(true)
      if (previousSelectedSessionId && previousSelectedSessionId !== forked.id) {
        this.sessions.setProtection(previousSelectedSessionId, 'selected', false)
      }
      this.sessions.enforceLimit(forked.id)
      return structuredClone(this.getSession(localSessionId))
    } catch (error) {
      try {
      this.failActivityProjectionStart(localSessionId)
      this.activityProjections.delete(localSessionId)
      if (inserted && this.state === state) {
        state.sessions = state.sessions.filter((candidate) => candidate.id !== localSessionId)
        project.sessionIds = project.sessionIds.filter((candidate) => candidate !== localSessionId)
        state.pinnedSessionIds = state.pinnedSessionIds.filter((candidate) => candidate !== localSessionId)
        state.settledSessionIds = state.settledSessionIds.filter((candidate) => candidate !== localSessionId)
        this.clearTransientSessionState(localSessionId)
        if (state.selectedSessionIdByProject[project.id] === localSessionId) {
          const previousMapped = previousProjectSelection
            ? state.sessions.find((candidate) => candidate.id === previousProjectSelection)
            : undefined
          if (previousMapped?.projectId === project.id) {
            state.selectedSessionIdByProject[project.id] = previousMapped.id
          } else {
            delete state.selectedSessionIdByProject[project.id]
          }
        }
        if (state.selectedSessionId === localSessionId) {
          const previousSelected = previousSelectedSessionId
            ? state.sessions.find((candidate) => candidate.id === previousSelectedSessionId)
            : undefined
          if (
            previousSelected &&
            (!previousSelectedProjectId || previousSelected.projectId === previousSelectedProjectId)
          ) {
            state.selectedProjectId = previousSelected.projectId
            state.selectedSessionId = previousSelected.id
            rememberDurableSelection(state, previousSelected)
            this.sessions.setProtection(previousSelected.id, 'selected', true)
          } else {
            const fallbackProject = state.projects.find(
              (candidate) => candidate.id === previousSelectedProjectId
            ) ?? orderedProjects(state)[0]
            const fallback = fallbackProject
              ? preferredProjectSession(state, fallbackProject.id)
              : undefined
            if (fallbackProject) state.selectedProjectId = fallbackProject.id
            else delete state.selectedProjectId
            if (fallback) {
              state.selectedSessionId = fallback.id
              rememberDurableSelection(state, fallback)
              this.sessions.setProtection(fallback.id, 'selected', true)
            } else {
              delete state.selectedSessionId
            }
          }
        }
        this.emitChanged()
        await this.flushPersistence()
      }
      if (this.sessions.isCurrent(localSessionId, client)) {
        await this.sessions.stop(localSessionId).catch(() => undefined)
      } else {
        await client.stop().catch(() => undefined)
      }
      if (error instanceof ForkSessionUnavailableError || error instanceof WorkspaceUnavailableError) {
        throw error
      }
      throw toPublicAcpError(error)
      } finally {
        if (childBindingCommitted) {
          await this.compensateSessionBinding(localSessionId, null)
        }
      }
    }
  }

  private async stopSessionWorker(sessionId: string): Promise<void> {
    this.permissionQueues.delete(sessionId)
    this.seenPermissionRequests.delete(sessionId)
    this.interactionQueues.delete(sessionId)
    this.lifecycleTurns.delete(sessionId)
    this.cancelledLifecycleTurns.delete(sessionId)
    this.autoPermissionPumps.delete(sessionId)
    this.connectionStarts.delete(sessionId)
    this.workingSinceBySessionId.delete(sessionId)
    this.failActivityProjectionStart(sessionId)
    this.setActivityProjectionOffline(sessionId)
    await Promise.all([
      this.sessions.stop(sessionId),
      this.attachments.clearSession(sessionId)
    ])
  }

  /**
   * Cancels pre-commit external waits when shutdown starts. The original
   * promise remains observed by Promise.race, so a late rejection is handled,
   * but no continuation in the controller can mutate state after stop.
   */
  private async awaitOperationOrStop<T>(operation: Promise<T>): Promise<T> {
    if (this.stopping) throw new PublicAcpError('generic')
    return Promise.race([
      operation,
      this.stopRequested.then(() => {
        throw new PublicAcpError('generic')
      })
    ])
  }

  private ensureConnected(
    sessionId: string,
    memorySettingsReconnect = false
  ): Promise<AcpConnection> {
    if (this.stopping) return Promise.reject(new PublicAcpError('generic'))
    if (this.updateQuiescenceToken) {
      return Promise.reject(new UpdateQuiescenceUnavailableError())
    }
    const current = this.sessions.get(sessionId)
    const inFlight = this.connectionStarts.get(sessionId)
    if (inFlight && this.sessions.isCurrent(sessionId, inFlight.client)) {
      return inFlight.promise
    }
    if (inFlight) this.connectionStarts.delete(sessionId)

    const session = this.getSession(sessionId)
    const project = this.getProject(session.projectId)
    const agentProfile = this.agentProfileForSession(sessionId)
    if (memorySettingsReconnect) {
      if (!this.memorySettingsTransaction || this.projectRemovalLocks.has(project.id)) {
        return Promise.reject(new MemorySettingsReconnectError())
      }
    } else {
      this.assertProjectNotRemoving(project.id, 'starting work in')
    }
    this.assertReadyProject(project.id)
    if (!current && (session.availableModels || session.availableModes)) {
      this.updateSessionRecord(sessionId, withoutCapabilities)
    }
    const client = current ?? this.sessions.create(sessionId, {
      cliPath: this.requireState().settings.grokCliPath,
      cwd: project.path,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      memoryEnabled: this.requireState().settings.memoryEnabled,
      ...(agentProfile ? { agentProfile } : {}),
      ...(session.acpSessionId ? { resumeSessionId: session.acpSessionId } : {}),
      ...(process.env.GROKBUILD_E2E === '1' ? { env: { GROKBUILD_E2E: '1' } } : {})
    })
    if (this.requireState().selectedSessionId === sessionId) {
      this.sessions.setProtection(sessionId, 'selected', true)
    }
    if (!current) this.beginActivityProjectionStart(sessionId)
    const promise = client.start()
      .then(async (startResult) => {
        if (this.stopping || !this.sessions.isCurrent(sessionId, client)) {
          await client.stop().catch(() => undefined)
          throw new Error('Session process changed while reconnecting')
        }
        this.updateSessionRecord(sessionId, (currentSession) => {
          const connected = { ...currentSession, acpSessionId: startResult.sessionId }
          return startResult.staleFallbackFrom
            ? appendSessionNotice(
                connected,
                'Previous Grok session expired; started a fresh chat. Your saved transcript in this tab is still shown.'
              )
            : connected
        })
        if (startResult.staleFallbackFrom) {
          this.replaceActivityProjectionWithFreshLive(sessionId)
        } else {
          this.activateActivityProjection(sessionId)
        }
        return client
      })
      .catch((error: unknown) => {
        this.failActivityProjectionStart(sessionId)
        throw error
      })
      .finally(() => {
        if (this.connectionStarts.get(sessionId)?.promise === promise) {
          this.connectionStarts.delete(sessionId)
        }
      })
    this.connectionStarts.set(sessionId, { client, promise })
    return promise
  }

  private beginActivityProjectionStart(sessionId: string, publish = true): void {
    const projection = new SessionActivityProjection()
    projection.setSyncState('replaying')
    this.activityProjectionStarts.set(sessionId, projection)
    if (publish) this.publishSnapshotChanged()
  }

  private activateActivityProjection(sessionId: string): void {
    const projection = this.activityProjectionStarts.get(sessionId)
      ?? this.activityProjections.get(sessionId)
    if (!projection) return
    this.activityProjectionStarts.delete(sessionId)
    projection.setSyncState('live')
    this.activityProjections.set(sessionId, projection)
    this.pruneOfflineActivityProjections()
    this.syncActivityProtection(sessionId, projection)
    this.publishSnapshotChanged()
  }

  private replaceActivityProjectionWithFreshLive(sessionId: string): void {
    this.activityProjectionStarts.delete(sessionId)
    const projection = new SessionActivityProjection()
    projection.setSyncState('live')
    this.activityProjections.set(sessionId, projection)
    this.pruneOfflineActivityProjections()
    this.syncActivityProtection(sessionId, projection)
    this.publishSnapshotChanged()
  }

  private failActivityProjectionStart(sessionId: string): void {
    if (!this.activityProjectionStarts.delete(sessionId)) return
    const existing = this.activityProjections.get(sessionId)
    if (existing) {
      existing.setSyncState('offline')
      this.touchActivityProjection(sessionId, existing)
      this.syncActivityProtection(sessionId, existing)
    } else {
      this.sessions.setProtection(sessionId, 'activity', false)
    }
    this.publishSnapshotChanged()
  }

  private setActivityProjectionOffline(sessionId: string): void {
    const projection = this.activityProjections.get(sessionId)
    this.sessions.setProtection(sessionId, 'activity', false)
    if (!projection || projection.getSnapshot().syncState === 'offline') return
    projection.setSyncState('offline')
    this.touchActivityProjection(sessionId, projection)
    this.publishSnapshotChanged()
  }

  private setAllActivityProjectionsOffline(): void {
    this.activityProjectionStarts.clear()
    let changed = false
    for (const [sessionId, projection] of this.activityProjections) {
      this.sessions.setProtection(sessionId, 'activity', false)
      if (projection.getSnapshot().syncState === 'offline') continue
      projection.setSyncState('offline')
      changed = true
    }
    this.pruneOfflineActivityProjections()
    if (changed) this.publishSnapshotChanged()
  }

  private touchActivityProjection(
    sessionId: string,
    projection: SessionActivityProjection
  ): void {
    this.activityProjections.delete(sessionId)
    this.activityProjections.set(sessionId, projection)
    this.pruneOfflineActivityProjections()
  }

  private pruneOfflineActivityProjections(): void {
    while (this.activityProjections.size > MAX_CACHED_SESSION_ACTIVITY_PROJECTIONS) {
      const oldestOffline = [...this.activityProjections].find(([, projection]) =>
        projection.getSnapshot().syncState === 'offline'
      )
      if (!oldestOffline) return
      this.activityProjections.delete(oldestOffline[0])
    }
  }

  private syncActivityProtection(
    sessionId: string,
    projection: SessionActivityProjection
  ): void {
    const snapshot = projection.getSnapshot()
    this.sessions.setProtection(
      sessionId,
      'activity',
      snapshot.syncState === 'live' && projection.hasLiveProtectionWork()
    )
  }

  private onPermission(sessionId: string, request: AcpPermissionRequest): void {
    let seen = this.seenPermissionRequests.get(sessionId)
    if (!seen) {
      seen = new Set()
      this.seenPermissionRequests.set(sessionId, seen)
    }
    if (seen.has(request.requestId)) return
    if (seen.size >= 1_024) {
      const oldest = seen.values().next().value as string | undefined
      if (oldest) seen.delete(oldest)
    }
    seen.add(request.requestId)

    const options = request.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(isPermissionIntent(option.intent) ? { intent: option.intent } : {})
    }))
    if (options.length === 0) {
      this.sessions.get(sessionId)?.cancel()
      this.updateSessionRecord(sessionId, (session) =>
        appendSessionError(session, 'Grok requested a permission decision without any valid options.')
      )
      return
    }

    const queue = this.permissionQueues.get(sessionId) ?? []
    if (queue.length >= 64) {
      this.sessions.get(sessionId)?.cancel()
      this.permissionQueues.delete(sessionId)
      this.updateSessionRecord(sessionId, (session) =>
        appendSessionError(withoutPendingPermission(session), 'Too many pending permission requests; the turn was cancelled.')
      )
      return
    }
    queue.push({
      requestId: request.requestId,
      sessionId,
      title: request.title,
      ...(request.description ? { description: request.description } : {}),
      options
    })
    this.permissionQueues.set(sessionId, queue)
    this.syncPermissionHead(sessionId)
    if (this.getSession(sessionId).permissionMode === 'auto') {
      void this.pumpAutoPermissions(sessionId)
    }
  }

  private onInteraction(sessionId: string, request: PendingInteraction): void {
    const queue = this.interactionQueues.get(sessionId) ?? []
    if (queue.some((item) => item.interactionId === request.interactionId)) return
    if (queue.length >= 64) {
      this.sessions.get(sessionId)?.cancel()
      this.interactionQueues.delete(sessionId)
      this.updateSessionRecord(sessionId, (session) =>
        appendSessionError(
          withoutPendingInteraction(session),
          'Too many pending user interactions; the turn was cancelled.'
        )
      )
      this.syncInputProtection(sessionId)
      return
    }
    queue.push({ ...request, sessionId })
    this.interactionQueues.set(sessionId, queue)
    this.syncInteractionHead(sessionId)
  }

  private onInteractionResolved(sessionId: string, interactionId: string): void {
    const queue = this.interactionQueues.get(sessionId)
    if (!queue) return
    const index = queue.findIndex((item) => item.interactionId === interactionId)
    if (index < 0) return
    queue.splice(index, 1)
    if (queue.length === 0) this.interactionQueues.delete(sessionId)
    this.syncInteractionHead(sessionId)
  }

  private syncPermissionHead(sessionId: string): void {
    const head = this.permissionQueues.get(sessionId)?.[0]
    this.syncInputProtection(sessionId)
    this.updateSessionRecord(sessionId, (session) => {
      if (head) {
        return {
          ...session,
          status: 'waiting',
          pendingPermission: head,
          updatedAt: new Date().toISOString()
        }
      }
      const withoutPending = withoutPendingPermission(session)
      return {
        ...withoutPending,
        status: session.status === 'waiting' && !session.pendingInteraction ? 'running' : session.status,
        updatedAt: new Date().toISOString()
      }
    })
  }

  private clearPermissionQueue(sessionId: string): void {
    this.permissionQueues.delete(sessionId)
    this.seenPermissionRequests.delete(sessionId)
    this.syncInputProtection(sessionId)
    this.updateSessionRecord(sessionId, (session) => withoutPendingPermission(session))
  }

  private syncInteractionHead(sessionId: string): void {
    const head = this.interactionQueues.get(sessionId)?.[0]
    this.syncInputProtection(sessionId)
    this.updateSessionRecord(sessionId, (session) => {
      if (head) {
        return {
          ...session,
          status: 'waiting',
          pendingInteraction: head,
          updatedAt: new Date().toISOString()
        }
      }
      const withoutPending = withoutPendingInteraction(session)
      return {
        ...withoutPending,
        status: session.status === 'waiting' && !session.pendingPermission ? 'running' : session.status,
        updatedAt: new Date().toISOString()
      }
    })
  }

  private clearInteractionQueue(sessionId: string): void {
    this.interactionQueues.delete(sessionId)
    this.syncInputProtection(sessionId)
    this.updateSessionRecord(sessionId, (session) => withoutPendingInteraction(session))
  }

  private syncInputProtection(sessionId: string): void {
    const waiting = Boolean(
      this.permissionQueues.get(sessionId)?.length ||
      this.interactionQueues.get(sessionId)?.length
    )
    this.sessions.setProtection(sessionId, 'input', waiting)
  }

  private async pumpAutoPermissions(sessionId: string): Promise<void> {
    if (this.forkStarts.has(sessionId)) return
    if (this.autoPermissionPumps.has(sessionId)) return
    this.autoPermissionPumps.add(sessionId)
    try {
      while (this.getSession(sessionId).permissionMode === 'auto') {
        const queue = this.permissionQueues.get(sessionId)
        const pending = queue?.[0]
        if (!queue || !pending) return
        const optionId = chooseAutoPermissionOption(pending)
        const client = this.sessions.get(sessionId)
        if (!optionId || !client) return
        try {
          await client.answerPermission(pending.requestId, optionId)
        } catch (error) {
          if (!this.sessions.isCurrent(sessionId, client)) return
          this.updateSessionRecord(sessionId, (session) => ({
            ...appendSessionError(
              session,
              `Auto accept failed: ${error instanceof Error ? error.message : String(error)}`
            ),
            permissionMode: 'ask',
            status: 'waiting'
          }))
          return
        }
        if (!this.sessions.isCurrent(sessionId, client)) return
        if (this.permissionQueues.get(sessionId)?.[0]?.requestId !== pending.requestId) return
        queue.shift()
        this.syncPermissionHead(sessionId)
      }
    } finally {
      this.autoPermissionPumps.delete(sessionId)
      if (
        !this.forkStarts.has(sessionId) &&
        this.permissionQueues.get(sessionId)?.length &&
        this.getSession(sessionId).permissionMode === 'auto'
      ) {
        queueMicrotask(() => void this.pumpAutoPermissions(sessionId))
      }
    }
  }

  private onAcpUpdate(sessionId: string, params: unknown): void {
    const activity = sessionActivityUpdateSchema.safeParse(params)
    if (activity.success) {
      const projection = this.activityProjectionStarts.get(sessionId)
        ?? this.activityProjections.get(sessionId)
      // A semantic activity event should only arrive while its current ACP
      // worker is starting or live. Never manufacture a projection for an
      // unbound/stale event.
      if (!projection) return
      projection.apply(activity.data)
      this.syncActivityProtection(sessionId, projection)
      this.publishSnapshotChanged()
      return
    }
    if (isReplaySessionUpdate(params)) return
    const normalized = normalizeSessionUpdate(params)
    this.updateSessionRecord(sessionId, (session) => {
      const next = applyAcpEvent(session, normalized)
      if (
        this.requireState().selectedSessionId !== sessionId &&
        session.status === 'idle' &&
        next.status === 'idle' &&
        assistantTranscriptGrew(session, next)
      ) {
        this.markSessionUnread(sessionId)
      }
      return next
    })
  }

  private getProject(projectId: string): ProjectSnapshot {
    const project = this.requireState().projects.find((item) => item.id === projectId)
    if (!project) throw new Error('Project not found')
    return project
  }

  private getSession(sessionId: string): SessionSnapshot {
    const session = this.requireState().sessions.find((item) => item.id === sessionId)
    if (!session) throw new Error('Session not found')
    return session
  }

  private updateSessionRecord(
    sessionId: string,
    update: (session: SessionSnapshot) => SessionSnapshot
  ): void {
    const state = this.requireState()
    const index = state.sessions.findIndex((session) => session.id === sessionId)
    if (index < 0) return
    const current = state.sessions[index]
    if (!current) return
    const next = update(current)
    state.sessions[index] = next
    const nextActivityStatus = sessionActivityStatus(
      next,
      this.unreadSessionIds.has(sessionId)
    )
    if (nextActivityStatus === 'working' && !this.workingSinceBySessionId.has(sessionId)) {
      this.workingSinceBySessionId.set(sessionId, new Date().toISOString())
    } else if (nextActivityStatus === 'idle' || nextActivityStatus === 'error') {
      this.workingSinceBySessionId.delete(sessionId)
    }
    if (state.selectedSessionId === sessionId) rememberDurableSelection(state, next)
    if (!hasActionableInput(current) && hasActionableInput(next)) {
      this.emit('sessionLifecycle', { sessionId, status: 'needs-input' })
    }
    if (current.status !== 'failed' && next.status === 'failed') {
      this.emit('sessionLifecycle', { sessionId, status: 'error' })
    }
    this.emitChanged()
  }

  private markSessionUnread(sessionId: string): boolean {
    if (this.requireState().selectedSessionId === sessionId) {
      return this.clearSessionUnread(sessionId)
    }
    if (this.unreadSessionIds.has(sessionId)) return false
    if (!this.requireState().sessions.some((session) => session.id === sessionId)) return false
    if (this.unreadSessionIds.size >= MAX_UNREAD_SESSIONS) {
      const oldest = this.unreadSessionIds.values().next().value as string | undefined
      if (oldest) this.unreadSessionIds.delete(oldest)
    }
    this.unreadSessionIds.add(sessionId)
    return true
  }

  private clearSessionUnread(sessionId: string): boolean {
    return this.unreadSessionIds.delete(sessionId)
  }

  private clearTransientSessionState(sessionId: string): void {
    this.unreadSessionIds.delete(sessionId)
    this.workingSinceBySessionId.delete(sessionId)
    this.lifecycleTurns.delete(sessionId)
    this.cancelledLifecycleTurns.delete(sessionId)
    this.activityProjectionStarts.delete(sessionId)
    this.activityProjections.delete(sessionId)
    this.sessions.setProtection(sessionId, 'activity', false)
  }

  private reconcileTransientSessionState(): void {
    const validIds = new Set(this.requireState().sessions.map((session) => session.id))
    for (const sessionId of this.unreadSessionIds) {
      if (!validIds.has(sessionId)) this.unreadSessionIds.delete(sessionId)
    }
    for (const sessionId of this.workingSinceBySessionId.keys()) {
      if (!validIds.has(sessionId)) this.workingSinceBySessionId.delete(sessionId)
    }
    for (const sessionId of this.activityProjectionStarts.keys()) {
      if (!validIds.has(sessionId)) this.activityProjectionStarts.delete(sessionId)
    }
    for (const sessionId of this.activityProjections.keys()) {
      if (!validIds.has(sessionId)) this.activityProjections.delete(sessionId)
    }
  }

  private emitChanged(): void {
    if (!this.state) return
    const catalogIdentity = agentCatalogContextIdentity(this.state)
    if (
      this.agentCatalogContextIdentity !== undefined &&
      this.agentCatalogContextIdentity !== catalogIdentity
    ) {
      this.agentCatalogContextGeneration += 1
      this.options.agentCatalogService?.clear()
    }
    this.agentCatalogContextIdentity = catalogIdentity
    const historyIdentity = sessionHistoryContextIdentity(this.state)
    if (
      this.sessionHistoryContextIdentity !== undefined &&
      this.sessionHistoryContextIdentity !== historyIdentity
    ) {
      this.sessionHistoryBroker.clear()
    }
    this.sessionHistoryContextIdentity = historyIdentity
    const memoryIdentity = memoryContextIdentity(this.state)
    if (
      this.memoryContextIdentity !== undefined &&
      this.memoryContextIdentity !== memoryIdentity
    ) this.options.memoryBroker?.clear()
    this.memoryContextIdentity = memoryIdentity
    this.persistDirty = true
    this.schedulePersistence()
    this.publishSnapshotChanged()
  }

  private publishSnapshotChanged(): void {
    if (!this.state) return
    this.revision += 1
    if (!this.broadcastTimer) {
      this.broadcastTimer = setTimeout(() => {
        this.broadcastTimer = undefined
        if (this.state) this.emit('changed', this.snapshot())
      }, 16)
    }
  }

  private async refreshAllWorkspaceHealth(publish: boolean): Promise<void> {
    const projects = [...this.requireState().projects]
    const results = await this.workspaceHealthService.inspect(
      projects.map((project) => ({ projectId: project.id, path: project.path }))
    ).catch(() => projects.map((project) => ({ projectId: project.id, state: 'unreadable' as const })))
    if (this.stopping) return
    const currentProjects = this.requireState().projects
    const currentIds = new Set(currentProjects.map((project) => project.id))
    let changed = [...this.workspaceHealthStates.keys()].some((projectId) => !currentIds.has(projectId))
    for (const projectId of [...this.workspaceHealthStates.keys()]) {
      if (!currentIds.has(projectId)) this.workspaceHealthStates.delete(projectId)
    }
    for (const project of projects) {
      const current = currentProjects.find((candidate) => candidate.id === project.id)
      if (current !== project || current.path !== project.path) continue
      const state = results.find((result) => result.projectId === project.id)?.state ?? 'unreadable'
      if (this.workspaceHealthStates.get(project.id) !== state) changed = true
      this.workspaceHealthStates.set(project.id, state)
      if (state !== 'ready') await this.stopProjectSessions(project.id)
    }
    if (publish && changed) this.publishSnapshotChanged()
  }

  private assertStableDashboardSelection(
    expectedState: PersistedState,
    expectedProject: ProjectSnapshot,
    expectedPath: string
  ): void {
    const currentState = this.requireState()
    const currentProject = currentState.projects.find(
      (project) => project.id === expectedProject.id
    )
    if (
      currentState !== expectedState ||
      currentState.selectedProjectId !== expectedProject.id ||
      currentProject !== expectedProject ||
      currentProject.path !== expectedPath
    ) {
      throw new DashboardInspectionUnavailableError()
    }
  }

  private async captureSessionHistoryContext(): Promise<ActiveSessionHistoryContext> {
    this.assertSessionHistoryLifecycleAvailable()
    const expectedState = this.requireState()
    const projectId = expectedState.selectedProjectId
    const expectedProject = projectId
      ? expectedState.projects.find((project) => project.id === projectId)
      : undefined
    if (!projectId || !expectedProject || !this.cliAvailable) {
      throw new SessionHistoryUnavailableError()
    }
    const expectedPath = expectedProject.path
    const cliPath = expectedState.settings.grokCliPath
    const { project, health } = await this.refreshStableProject(projectId)
    if (health !== 'ready') throw new WorkspaceUnavailableError(health)
    if (
      this.requireState() !== expectedState ||
      expectedState.selectedProjectId !== projectId ||
      project !== expectedProject ||
      project.path !== expectedPath ||
      expectedState.settings.grokCliPath !== cliPath ||
      !this.cliAvailable
    ) {
      throw new SessionHistoryUnavailableError()
    }
    this.assertSessionHistoryLifecycleAvailable()
    return {
      state: expectedState,
      project,
      projectId,
      canonicalCwd: expectedPath,
      cliPath,
      revision: this.revision
    }
  }

  private assertStableSessionHistoryContext(context: ActiveSessionHistoryContext): void {
    this.assertSessionHistoryLifecycleAvailable()
    const state = this.requireState()
    const project = state.projects.find((candidate) => candidate.id === context.projectId)
    if (
      state !== context.state ||
      this.revision !== context.revision ||
      state.selectedProjectId !== context.projectId ||
      project !== context.project ||
      project.path !== context.canonicalCwd ||
      state.settings.grokCliPath !== context.cliPath ||
      !this.cliAvailable
    ) {
      throw new SessionHistoryUnavailableError()
    }
  }

  private assertSessionHistoryLifecycleAvailable(): void {
    if (
      this.stopping ||
      this.updateQuiescenceToken ||
      this.migrationApplying ||
      this.migrationOperation ||
      this.destructivePersistenceTransactions > 0 ||
      this.projectRemovalLocks.size > 0 ||
      this.sessionLifecycleLocks.size > 0 ||
      this.forkStarts.size > 0 ||
      this.retryStarts.size > 0 ||
      this.connectionStarts.size > 0
    ) {
      throw new SessionHistoryUnavailableError()
    }
  }

  private acquireSessionHistoryMutation(): { release(): void } {
    if (this.sessionHistoryMutation) throw new SessionHistoryUnavailableError()
    const lease = this.acquireIntegrationOperation()
    const token = Symbol('session-history-mutation')
    this.sessionHistoryMutation = token
    let released = false
    return Object.freeze({
      release: () => {
        if (released) return
        released = true
        if (this.sessionHistoryMutation === token) this.sessionHistoryMutation = undefined
        lease.release()
      }
    })
  }

  private selectResolvedHistorySession(session: SessionSnapshot): void {
    // This is the one state mutation owned by the active history transaction;
    // public mutations are rejected by assertNoStateTransaction below.
    this.assertSessionNotClosing(session.id, 'opening')
    const currentSession = this.getSession(session.id)
    if (currentSession !== session || this.projectRemovalLocks.has(session.projectId)) {
      throw new SessionHistoryUnavailableError()
    }
    const state = this.requireState()
    if (state.selectedSessionId && state.selectedSessionId !== session.id) {
      this.sessions.setProtection(state.selectedSessionId, 'selected', false)
    }
    state.selectedProjectId = session.projectId
    state.selectedSessionId = session.id
    this.clearSessionUnread(session.id)
    rememberDurableSelection(state, session)
    this.sessions.setProtection(session.id, 'selected', true)
    this.emitChanged()
  }

  private publicSessionById(
    sessionId: string
  ): import('../shared/models').PublicSessionSnapshot {
    const session = this.snapshot().sessions.find((candidate) => candidate.id === sessionId)
    if (!session) throw new SessionHistoryUnavailableError()
    return session
  }

  private refreshProjectHealth(projectId: string): Promise<WorkspaceHealthState> {
    const project = this.getProject(projectId)
    const inFlight = this.workspaceHealthChecks.get(projectId)
    if (inFlight?.project === project && inFlight.path === project.path) return inFlight.promise
    const operation = this.workspaceHealthService.inspect([{
      projectId: project.id,
      path: project.path
    }])
      .then((results) => results[0]?.state ?? 'unreadable' as const)
      .catch(() => 'unreadable' as const)
      .then(async (state) => {
        if (this.stopping) return 'unreadable' as const
        const current = this.requireState().projects.find((candidate) => candidate.id === projectId)
        if (current !== project || current.path !== project.path) return 'unreadable' as const
        const changed = this.workspaceHealthStates.get(projectId) !== state
        this.workspaceHealthStates.set(projectId, state)
        if (state !== 'ready') await this.stopProjectSessions(projectId)
        if (changed) this.publishSnapshotChanged()
        return state
      })
      .finally(() => {
        if (this.workspaceHealthChecks.get(projectId)?.promise === operation) {
          this.workspaceHealthChecks.delete(projectId)
        }
      })
    this.workspaceHealthChecks.set(projectId, {
      project,
      path: project.path,
      promise: operation
    })
    return operation
  }

  private async refreshStableProject(projectId: string): Promise<{
    project: ProjectSnapshot
    health: WorkspaceHealthState
  }> {
    const expectedState = this.requireState()
    const expectedProject = this.getProject(projectId)
    const expectedPath = expectedProject.path
    const health = await this.refreshProjectHealth(projectId)
    const currentState = this.requireState()
    const currentProject = this.getProject(projectId)
    if (
      currentState !== expectedState ||
      currentProject !== expectedProject ||
      currentProject.path !== expectedPath
    ) throw new WorkspaceUnavailableError('changed')
    return { project: currentProject, health }
  }

  private async refreshStableSession(sessionId: string): Promise<{
    session: SessionSnapshot
    health: WorkspaceHealthState
  }> {
    const expectedState = this.requireState()
    const expectedSession = this.getSession(sessionId)
    const expectedProject = this.getProject(expectedSession.projectId)
    const expectedPath = expectedProject.path
    const health = await this.refreshProjectHealth(expectedProject.id)
    const currentState = this.requireState()
    const currentSession = this.getSession(sessionId)
    const currentProject = this.getProject(currentSession.projectId)
    if (
      currentState !== expectedState ||
      currentSession.projectId !== expectedSession.projectId ||
      currentProject !== expectedProject ||
      currentProject.path !== expectedPath
    ) throw new WorkspaceUnavailableError('changed')
    return { session: currentSession, health }
  }

  private async requireReadyProject(projectId: string): Promise<ProjectSnapshot> {
    const result = await this.refreshStableProject(projectId)
    if (result.health !== 'ready') throw new WorkspaceUnavailableError(result.health)
    return result.project
  }

  private async requireReadySessionProject(sessionId: string): Promise<SessionSnapshot> {
    const result = await this.refreshStableSession(sessionId)
    if (result.health !== 'ready') throw new WorkspaceUnavailableError(result.health)
    return result.session
  }

  private async stopProjectSessions(projectId: string): Promise<void> {
    const sessionIds = this.requireState().sessions
      .filter((session) => session.projectId === projectId)
      .map((session) => session.id)
    await Promise.allSettled(sessionIds.map((sessionId) => this.stopSessionWorker(sessionId)))
    for (const sessionId of sessionIds) {
      const session = this.requireState().sessions.find((candidate) => candidate.id === sessionId)
      if (session && needsWorkspaceQuiescence(session)) {
        this.updateSessionRecord(sessionId, quiesceWorkspaceSession)
      }
    }
  }

  private assertReadyProject(projectId: string): void {
    const state = this.workspaceHealthStates.get(projectId) ?? 'unreadable'
    if (state !== 'ready') throw new WorkspaceUnavailableError(state)
  }

  private schedulePersistence(): void {
    if (this.persistTimer || this.persistInFlight) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      void this.persistLatest()
    }, 120)
  }

  private async persistLatest(): Promise<void> {
    if (!this.state || !this.persistDirty || this.persistInFlight) return
    this.persistDirty = false
    const state = structuredClone(this.state)
    const operation = this.options.store
      .save(state)
      .then(() => { this.persistFailure = undefined })
      .catch(() => {
        this.persistFailure = new Error('Application state could not be persisted.')
        console.error('Failed to persist application state.')
      })
    this.persistInFlight = operation
    await operation
    if (this.persistInFlight === operation) this.persistInFlight = undefined
    if (this.persistDirty) this.schedulePersistence()
  }

  /**
   * Writes a caller-provided snapshot through the same single persistence
   * lane as debounced state writes. The tracked operation always resolves so
   * concurrent flushes can drain it; this caller still receives a fixed error.
   */
  private async saveStateInPersistenceLane(state: PersistedState): Promise<void> {
    await this.flushPersistence(false)
    await this.savePreparedStateInPersistenceLane(state)
  }

  private async saveSettingsInPersistenceLane(
    expectedState: PersistedState,
    settings: AppSettings
  ): Promise<void> {
    await this.flushPersistence(false)
    if (this.requireState() !== expectedState) throw new MemorySettingsUnavailableError()
    const candidate = structuredClone(expectedState)
    candidate.settings = structuredClone(settings)
    await this.savePreparedStateInPersistenceLane(candidate)
  }

  private async savePreparedStateInPersistenceLane(state: PersistedState): Promise<void> {
    const snapshot = structuredClone(state)
    let failure: Error | undefined
    const operation = this.options.store
      .save(snapshot)
      .then(() => { this.persistFailure = undefined })
      .catch(() => {
        failure = new Error('Application state could not be persisted.')
        this.persistFailure = failure
        console.error('Failed to persist application state.')
      })
    this.persistInFlight = operation
    await operation
    if (this.persistInFlight === operation) this.persistInFlight = undefined
    if (this.persistDirty) this.schedulePersistence()
    if (failure) throw failure
  }

  private async flushPersistence(requireSuccess = false): Promise<void> {
    while (this.persistTimer || this.persistInFlight || this.persistDirty) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer)
        this.persistTimer = undefined
      }
      if (this.persistInFlight) await this.persistInFlight
      if (this.persistDirty) await this.persistLatest()
    }
    if (requireSuccess && this.persistFailure) throw this.persistFailure
  }

  private requireState(): PersistedState {
    if (!this.state) throw new Error('AppController is not initialized')
    return this.state
  }

  private requireAgentRosterStore(): AgentRosterStoreApi {
    if (!this.options.agentRosterStore) {
      throw new SavedAgentOperationUnavailableError('Saved agents are not configured for this app instance.')
    }
    return this.options.agentRosterStore
  }

  private requireReadyAgentRoster(expectedRevision?: number): AgentRoster {
    if (this.agentRosterLoad.status !== 'ready') {
      throw new SavedAgentOperationUnavailableError(
        'Saved agents are invalid; explicitly recover the roster before continuing.'
      )
    }
    if (
      expectedRevision !== undefined &&
      this.agentRosterLoad.roster.revision !== expectedRevision
    ) throw new SavedAgentOperationUnavailableError()
    return this.agentRosterLoad.roster
  }

  private acquireAgentRosterTransaction(action: string): () => void {
    this.assertNoStateTransaction(action)
    if (this.stopping || this.agentRosterTransaction) {
      throw new SavedAgentOperationUnavailableError(
        'Wait for the current saved-agent operation to finish and try again.'
      )
    }
    const token = Symbol(action)
    this.agentRosterTransaction = token
    this.integrationOperations += 1
    let settleOperation!: () => void
    const operation = new Promise<void>((resolve) => { settleOperation = resolve })
    this.agentRosterOperations.add(operation)
    void operation.finally(() => this.agentRosterOperations.delete(operation))
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.agentRosterTransaction === token) this.agentRosterTransaction = undefined
      this.integrationOperations = Math.max(0, this.integrationOperations - 1)
      settleOperation()
    }
  }

  private acquireAgentCatalogOperation(): () => void {
    this.assertNoStateTransaction('listing Grok agents')
    if (this.stopping) {
      throw new SavedAgentOperationUnavailableError('Grok agent discovery is unavailable while the app is stopping.')
    }
    if (this.agentCatalogOperations.size >= MAX_CONCURRENT_AGENT_CATALOG_OPERATIONS) {
      throw new SavedAgentOperationUnavailableError(
        'Too many Grok agent discovery requests are already running. Try again shortly.'
      )
    }
    this.integrationOperations += 1
    let settleOperation!: () => void
    const operation = new Promise<void>((resolve) => { settleOperation = resolve })
    this.agentCatalogOperations.add(operation)
    void operation.finally(() => this.agentCatalogOperations.delete(operation))
    let released = false
    return () => {
      if (released) return
      released = true
      this.integrationOperations = Math.max(0, this.integrationOperations - 1)
      settleOperation()
    }
  }

  private async runAgentRosterMutation<T>(
    operation: () => Promise<AgentRosterMutationResult<T>>,
    publish = true
  ): Promise<AgentRosterMutationResult<T>> {
    try {
      const result = await operation()
      this.setReadyAgentRoster(result.roster, publish)
      return result
    } catch (error) {
      if (error instanceof AgentRosterStoreError && error.code === 'revision-conflict') {
        const store = this.options.agentRosterStore
        if (store) {
          this.agentRosterLoad = await store.load()
          if (!this.stopping) this.publishSnapshotChanged()
        }
      }
      throw error
    }
  }

  private async runRuntimeAgentRosterMutation<T>(
    operation: () => Promise<AgentRosterMutationResult<T>>,
    sessionIds: string[]
  ): Promise<AgentRosterMutationResult<T>> {
    const publicRosterBeforeCommit = this.agentRosterLoad
    this.agentRosterPublicOverride = publicRosterBeforeCommit
    let durableRosterCommitted = false
    try {
      const result = await this.runAgentRosterMutation(operation, false)
      durableRosterCommitted = true
      try {
        await this.recycleAgentSessions(sessionIds)
      } catch {
        throw new SavedAgentOperationUnavailableError(
          'The saved-agent change was saved, but its sessions could not reconnect. Send a prompt to retry.'
        )
      }
      return result
    } finally {
      this.agentRosterPublicOverride = undefined
      // A completed store mutation is the durable desired identity even when
      // recycling failed. Never project the old identity after that commit.
      if (durableRosterCommitted && !this.stopping) this.publishSnapshotChanged()
    }
  }

  private setReadyAgentRoster(roster: AgentRoster, publish = true): void {
    this.agentRosterLoad = { status: 'ready', source: 'versioned', roster }
    if (publish && !this.stopping) this.publishSnapshotChanged()
  }

  private savedAgentForSession(
    sessionId: string,
    load: AgentRosterLoadResult = this.agentRosterLoad
  ): SavedAgent | undefined {
    if (load.status !== 'ready') return undefined
    const agentId = load.roster.sessionBindings[sessionId]
    return agentId
      ? load.roster.agents.find((agent) => agent.id === agentId)
      : undefined
  }

  private agentProfileForSession(sessionId: string): ReturnType<typeof inlineAcpAgentProfile> | undefined {
    const roster = this.requireReadyAgentRoster()
    const agentId = roster.sessionBindings[sessionId]
    if (!agentId) return undefined
    const agent = roster.agents.find((candidate) => candidate.id === agentId)
    if (!agent) throw new SavedAgentOperationUnavailableError()
    return inlineAcpAgentProfile(agent)
  }

  private acquireStableAgentSessions(sessionIds: string[], action: string): () => void {
    const uniqueIds = [...new Set(sessionIds)].sort()
    for (const sessionId of uniqueIds) this.assertStableAgentSession(sessionId)
    const releases: Array<() => void> = []
    try {
      for (const sessionId of uniqueIds) {
        releases.push(this.acquireSessionLifecycle(sessionId, action))
        this.assertStableAgentSession(sessionId, true)
      }
    } catch (error) {
      for (const release of releases.reverse()) release()
      throw error
    }
    return () => {
      for (const release of releases.reverse()) release()
    }
  }

  private assertStableAgentSession(sessionId: string, lifecycleHeld = false): void {
    const session = this.getSession(sessionId)
    const projection = this.activityProjectionStarts.get(sessionId)
      ?? this.activityProjections.get(sessionId)
    if (
      !isForkableSourceSession(session) ||
      this.retryStarts.has(sessionId) ||
      this.forkStarts.has(sessionId) ||
      this.connectionStarts.has(sessionId) ||
      (!lifecycleHeld && this.sessionLifecycleLocks.has(sessionId)) ||
      projection?.hasLiveProtectionWork()
    ) {
      throw new SavedAgentOperationUnavailableError(
        'Saved-agent identity can only change while the session is stably idle.'
      )
    }
  }

  private async recycleAgentSessions(sessionIds: string[]): Promise<void> {
    const existing = [...new Set(sessionIds)].filter((sessionId) =>
      this.requireState().sessions.some((session) => session.id === sessionId)
    )
    const stopResults = await Promise.allSettled(
      existing.map((sessionId) => this.stopSessionWorker(sessionId))
    )
    if (stopResults.some((result) => result.status === 'rejected')) {
      // SessionManager removes a client before awaiting stop. Repeat the
      // controller cleanup to make the main-owned runtime unambiguously
      // offline even if a connection's stop promise failed.
      await Promise.allSettled(existing.map((sessionId) => this.stopSessionWorker(sessionId)))
      throw new SavedAgentOperationUnavailableError()
    }
    if (this.stopping) return

    const reconnectResults = await Promise.allSettled(existing.map(async (sessionId) => {
      const session = this.requireState().sessions.find((candidate) => candidate.id === sessionId)
      if (!session || this.workspaceHealthStates.get(session.projectId) !== 'ready' || this.stopping) return
      await this.ensureConnected(sessionId)
    }))
    if (reconnectResults.some((result) => result.status === 'rejected')) {
      // A failed start remains registered until explicitly stopped. Take every
      // affected session offline so no partially recycled identity can serve a
      // later prompt.
      await Promise.allSettled(existing.map((sessionId) => this.stopSessionWorker(sessionId)))
      throw new SavedAgentOperationUnavailableError()
    }
  }

  private async compensateSessionBinding(
    sessionId: string,
    agentId: string | null
  ): Promise<void> {
    const store = this.requireAgentRosterStore()
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const loaded = attempt === 0 ? this.agentRosterLoad : await store.load()
      this.agentRosterLoad = loaded
      if (loaded.status !== 'ready') throw new SavedAgentOperationUnavailableError()
      try {
        const result = await store.setSessionBinding(
          loaded.roster.revision,
          sessionId,
          agentId
        )
        this.setReadyAgentRoster(result.roster)
        return
      } catch (error) {
        lastError = error
      }
    }
    this.failAgentRosterRuntime()
    throw lastError instanceof Error ? lastError : new SavedAgentOperationUnavailableError()
  }

  private async preclearSessionBindings(sessionIds: string[]): Promise<Record<string, string>> {
    const roster = this.requireReadyAgentRoster()
    const ids = new Set(sessionIds)
    const previous = Object.fromEntries(
      Object.entries(roster.sessionBindings).filter(([sessionId]) => ids.has(sessionId))
    )
    if (Object.keys(previous).length === 0) return previous
    const store = this.requireAgentRosterStore()
    const next = await store.mutate(roster.revision, (draft) => {
      for (const sessionId of ids) delete draft.sessionBindings[sessionId]
    })
    this.setReadyAgentRoster(next, false)
    return previous
  }

  private async restoreSessionBindings(bindings: Record<string, string>): Promise<void> {
    if (Object.keys(bindings).length === 0) return
    const roster = this.requireReadyAgentRoster()
    const store = this.requireAgentRosterStore()
    try {
      const next = await store.mutate(roster.revision, (draft) => {
        for (const [sessionId, agentId] of Object.entries(bindings)) {
          draft.sessionBindings[sessionId] = agentId
        }
      })
      this.setReadyAgentRoster(next, false)
    } catch (error) {
      this.failAgentRosterRuntime()
      throw error
    }
  }

  private failAgentRosterRuntime(): void {
    this.agentRosterLoad = { status: 'invalid', reason: 'unreadable' }
    if (!this.stopping) this.publishSnapshotChanged()
  }

  private assertSessionNotForking(sessionId: string, action: string): void {
    if (this.forkStarts.has(sessionId)) {
      throw new ForkSessionUnavailableError(`Wait for the session fork to finish before ${action} this session.`)
    }
  }

  private acquireSessionLifecycle(sessionId: string, action: string): () => void {
    if (this.migrationApplying) {
      throw new ForkSessionUnavailableError(
        `Wait for state import to finish before ${action} this session.`
      )
    }
    this.assertSessionNotForking(sessionId, action)
    this.assertSessionNotClosing(sessionId, action)
    const session = this.getSession(sessionId)
    this.assertProjectNotRemoving(session.projectId, action)
    this.sessionLifecycleLocks.add(sessionId)
    return () => { this.sessionLifecycleLocks.delete(sessionId) }
  }

  private assertSessionNotClosing(sessionId: string, action: string): void {
    if (this.sessionLifecycleLocks.has(sessionId)) {
      throw new ForkSessionUnavailableError(
        `Wait for the current session operation to finish before ${action} this session.`
      )
    }
  }

  private assertProjectNotRemoving(projectId: string, action: string): void {
    if (this.projectRemovalLocks.has(projectId)) {
      throw new ForkSessionUnavailableError(
        `Wait for the project operation to finish before ${action} this project.`
      )
    }
    this.assertNoStateTransaction(`${action} this project`)
  }

  private assertNoStateTransaction(action: string): void {
    if (this.sessionHistoryMutation) {
      throw new SessionHistoryUnavailableError()
    }
    if (this.updateQuiescenceToken) {
      throw new UpdateQuiescenceUnavailableError()
    }
    if (this.migrationApplying) {
      throw new ForkSessionUnavailableError(`Wait for state import to finish before ${action}.`)
    }
    if (this.destructivePersistenceTransactions > 0) {
      throw new ForkSessionUnavailableError(
        `Wait for the current save transaction to finish before ${action}.`
      )
    }
  }

  private canAcquireUpdateQuiescence(): boolean {
    return !this.stopping &&
      !this.updateQuiescenceToken &&
      !this.migrationApplying &&
      !this.migrationOperation &&
      this.forkStarts.size === 0 &&
      this.retryStarts.size === 0 &&
      this.sessionLifecycleLocks.size === 0 &&
      this.projectRemovalLocks.size === 0 &&
      this.destructivePersistenceTransactions === 0 &&
      this.connectionStarts.size === 0 &&
      this.workspaceHealthChecks.size === 0 &&
      this.integrationOperations === 0 &&
      ![...this.permissionQueues.values()].some((queue) => queue.length > 0) &&
      ![...this.interactionQueues.values()].some((queue) => queue.length > 0) &&
      this.autoPermissionPumps.size === 0 &&
      this.requireState().sessions.every(isForkableSourceSession)
  }

  private releaseUpdateQuiescence(token: symbol): void {
    if (this.updateQuiescenceToken !== token) return
    this.updateQuiescenceToken = undefined
    if (this.stopping) return
    const selectedSessionId = this.requireState().selectedSessionId
    if (selectedSessionId) this.reconnectSelectedSession(selectedSessionId)
  }

  private assertSessionAvailable(sessionId: string, action: string): void {
    this.assertSessionNotClosing(sessionId, action)
    const session = this.getSession(sessionId)
    this.assertProjectNotRemoving(session.projectId, action)
  }

  private trackDetachedCleanup<T>(operation: Promise<T>): Promise<T> {
    this.detachedSessionCleanups.add(operation)
    void operation.finally(() => this.detachedSessionCleanups.delete(operation))
      .catch(() => undefined)
    return operation
  }

  private trackSessionHistoryOperation<T>(operation: Promise<T>): Promise<T> {
    this.sessionHistoryOperations.add(operation)
    void operation.finally(() => this.sessionHistoryOperations.delete(operation))
      .catch(() => undefined)
    return operation
  }
}

interface SelectionState {
  projectId: string | undefined
  sessionId: string | undefined
}

interface ActiveSessionHistoryContext extends SessionHistoryContext {
  state: PersistedState
  project: ProjectSnapshot
  revision: number
}

interface HistoryOpenRollback {
  selection: SelectionState
  mappedSessionId: string | undefined
}

interface ClosedSessionRollback {
  session: SessionSnapshot
  sessionIndex: number
  projectSessionIndex: number
  pinnedSessionIndex: number
  settledSessionIndex: number
  mappedSessionId: string | undefined
  selection: SelectionState
}

interface RemovedProjectRollback {
  project: ProjectSnapshot
  projectIndex: number
  removedSessions: Array<{ session: SessionSnapshot; index: number }>
  pinnedProjectIds: string[]
  pinnedSessionIds: string[]
  settledSessionIds: string[]
  mappedSessionId: string | undefined
  selection: SelectionState
  health: WorkspaceHealthState | undefined
}

function currentSelection(state: PersistedState): SelectionState {
  return {
    projectId: state.selectedProjectId,
    sessionId: state.selectedSessionId
  }
}

function historyBrokerInput(context: ActiveSessionHistoryContext): SessionHistoryContext {
  return {
    projectId: context.projectId,
    canonicalCwd: context.canonicalCwd,
    cliPath: context.cliPath
  }
}

function sessionHistoryContextIdentity(state: PersistedState): string {
  return `${state.selectedProjectId ?? ''}\u0000${state.settings.grokCliPath}`
}

function agentCatalogContextIdentity(state: PersistedState): string {
  return `${state.settings.grokCliPath}\u0000${state.projects
    .map((project) => `${project.id}\u0001${project.path}`)
    .sort()
    .join('\u0002')}`
}

function memoryContextIdentity(state: PersistedState): string {
  return JSON.stringify({
    selectedProjectId: state.selectedProjectId ?? null,
    selectedSessionId: state.selectedSessionId ?? null,
    settings: state.settings,
    projects: state.projects
      .map((project) => ({
        id: project.id,
        name: project.name,
        path: project.path,
        sessionIds: project.sessionIds
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  })
}

function settingsEqual(left: AppSettings, right: AppSettings): boolean {
  return left.appearance === right.appearance &&
    left.reduceMotion === right.reduceMotion &&
    left.grokCliPath === right.grokCliPath &&
    left.maxLiveSessions === right.maxLiveSessions &&
    left.privacyMode === right.privacyMode &&
    left.memoryEnabled === right.memoryEnabled
}

function sessionHistoryTitle(summary: string): string {
  return summary.length > 0 ? summary : 'Untitled Grok session'
}

function validateHistoryInsertion(
  state: PersistedState,
  projectId: string,
  session: SessionSnapshot
): void {
  const candidate = structuredClone(state)
  const project = candidate.projects.find((item) => item.id === projectId)
  if (!project) throw new SessionHistoryUnavailableError()
  candidate.sessions.push(session)
  project.sessionIds.push(session.id)
  candidate.selectedProjectId = projectId
  candidate.selectedSessionId = session.id
  rememberDurableSelection(candidate, session)
  try {
    serializePersistedState(candidate)
  } catch {
    throw new SessionHistoryUnavailableError()
  }
}

function assertHistoryDeleteUnprotected(
  state: PersistedState,
  projectId: string,
  remoteId: string
): void {
  const local = state.sessions.find((session) =>
    session.projectId === projectId && session.acpSessionId === remoteId
  )
  if (local) throw new SessionHistoryBrokerError('delete-protected')
}

function publicSessionHistoryError(error: unknown): Error {
  if (
    error instanceof SessionHistoryBrokerError ||
    error instanceof SessionHistoryUnavailableError
  ) return error
  return new SessionHistoryUnavailableError()
}

function sameSelection(left: SelectionState, right: SelectionState): boolean {
  return left.projectId === right.projectId && left.sessionId === right.sessionId
}

function applySelection(state: PersistedState, selection: SelectionState): void {
  if (selection.projectId) state.selectedProjectId = selection.projectId
  else delete state.selectedProjectId
  if (selection.sessionId) state.selectedSessionId = selection.sessionId
  else delete state.selectedSessionId
}

function restoreClosedSession(
  state: PersistedState,
  project: ProjectSnapshot,
  rollback: ClosedSessionRollback,
  committedSelection: SelectionState,
  committedMappedSessionId: string | undefined
): void {
  const sessionId = rollback.session.id
  if (!state.sessions.some((session) => session.id === sessionId)) {
    const restored = needsWorkspaceQuiescence(rollback.session)
      ? quiesceWorkspaceSession(rollback.session)
      : rollback.session
    state.sessions.splice(clampedIndex(rollback.sessionIndex, state.sessions.length), 0, restored)
  }
  if (!project.sessionIds.includes(sessionId)) {
    project.sessionIds.splice(
      clampedIndex(rollback.projectSessionIndex, project.sessionIds.length),
      0,
      sessionId
    )
  }
  if (rollback.pinnedSessionIndex >= 0 && !state.pinnedSessionIds.includes(sessionId)) {
    state.pinnedSessionIds.splice(
      clampedIndex(rollback.pinnedSessionIndex, state.pinnedSessionIds.length),
      0,
      sessionId
    )
  }
  if (
    rollback.settledSessionIndex >= 0 &&
    !state.pinnedSessionIds.includes(sessionId) &&
    !state.settledSessionIds.includes(sessionId)
  ) {
    state.settledSessionIds.splice(
      clampedIndex(rollback.settledSessionIndex, state.settledSessionIds.length),
      0,
      sessionId
    )
  }
  if (state.selectedSessionIdByProject[project.id] === committedMappedSessionId) {
    if (rollback.mappedSessionId) {
      state.selectedSessionIdByProject[project.id] = rollback.mappedSessionId
    } else {
      delete state.selectedSessionIdByProject[project.id]
    }
  }
  if (sameSelection(currentSelection(state), committedSelection)) {
    applySelection(state, rollback.selection)
  }
}

function restoreRemovedProject(
  state: PersistedState,
  rollback: RemovedProjectRollback,
  committedSelection: SelectionState,
  workspaceHealthStates: Map<string, WorkspaceHealthState>
): void {
  const projectId = rollback.project.id
  if (!state.projects.some((project) => project.id === projectId)) {
    state.projects.splice(
      clampedIndex(rollback.projectIndex, state.projects.length),
      0,
      rollback.project
    )
  }
  for (const entry of [...rollback.removedSessions].sort((left, right) => left.index - right.index)) {
    if (state.sessions.some((session) => session.id === entry.session.id)) continue
    const restored = needsWorkspaceQuiescence(entry.session)
      ? quiesceWorkspaceSession(entry.session)
      : entry.session
    state.sessions.splice(clampedIndex(entry.index, state.sessions.length), 0, restored)
  }
  const removedSessionIds = new Set(rollback.removedSessions.map((entry) => entry.session.id))
  state.pinnedProjectIds = restoreTrackedIds(
    state.pinnedProjectIds,
    rollback.pinnedProjectIds,
    new Set([projectId])
  )
  state.pinnedSessionIds = restoreTrackedIds(
    state.pinnedSessionIds,
    rollback.pinnedSessionIds,
    removedSessionIds
  )
  state.settledSessionIds = restoreTrackedIds(
    state.settledSessionIds,
    rollback.settledSessionIds,
    removedSessionIds
  ).filter((sessionId) => !state.pinnedSessionIds.includes(sessionId))
  if (state.selectedSessionIdByProject[projectId] === undefined) {
    if (rollback.mappedSessionId) {
      state.selectedSessionIdByProject[projectId] = rollback.mappedSessionId
    }
  }
  if (sameSelection(currentSelection(state), committedSelection)) {
    applySelection(state, rollback.selection)
  }
  if (rollback.health) workspaceHealthStates.set(projectId, rollback.health)
  else workspaceHealthStates.delete(projectId)
}

function restoreTrackedIds(
  current: readonly string[],
  original: readonly string[],
  tracked: ReadonlySet<string>
): string[] {
  const restored = current.filter((id) => !tracked.has(id))
  original.forEach((id, index) => {
    if (!tracked.has(id) || restored.includes(id)) return
    restored.splice(clampedIndex(index, restored.length), 0, id)
  })
  return restored
}

function clampedIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length))
}

function sameWorkspaceIdentity(
  expected: WorkspaceIdentity,
  actual: WorkspaceIdentity | undefined
): boolean {
  return actual !== undefined &&
    actual.device === expected.device &&
    actual.inode === expected.inode
}

function hasActionableInput(session: SessionSnapshot): boolean {
  return Boolean(
    session.pendingInteraction ||
    (session.permissionMode === 'ask' && session.pendingPermission)
  )
}

function isReplaySessionUpdate(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  const rawUpdate = envelope.update
  const update = rawUpdate && typeof rawUpdate === 'object' && !Array.isArray(rawUpdate)
    ? rawUpdate as Record<string, unknown>
    : envelope
  const envelopeMeta = envelope._meta
  const updateMeta = update._meta
  const envelopeIsReplay = Boolean(
    envelopeMeta && typeof envelopeMeta === 'object' && !Array.isArray(envelopeMeta) &&
      (envelopeMeta as Record<string, unknown>).isReplay === true
  )
  const updateIsReplay = Boolean(
    updateMeta && typeof updateMeta === 'object' && !Array.isArray(updateMeta) &&
      (updateMeta as Record<string, unknown>).isReplay === true
  )
  return envelopeIsReplay || updateIsReplay
}

function isForkableSourceSession(session: SessionSnapshot): boolean {
  return session.status === 'idle' &&
    !session.pendingPermission &&
    !session.pendingInteraction &&
    (session.pendingHookRuns ?? 0) === 0 &&
    !session.transcript.some((item) =>
      ('streaming' in item && item.streaming === true) ||
      (item.kind === 'tool' && (item.status === 'pending' || item.status === 'running')) ||
      (item.kind === 'activity' && item.open === true)
    )
}

function sessionIsWorking(session: SessionSnapshot): boolean {
  return session.status === 'starting' ||
    session.status === 'running' ||
    (session.pendingHookRuns ?? 0) > 0 ||
    session.transcript.some((item) =>
      ('streaming' in item && item.streaming === true) ||
      (item.kind === 'tool' && (item.status === 'pending' || item.status === 'running')) ||
      (item.kind === 'activity' && item.open === true)
    )
}

function sessionActivityStatus(
  session: SessionSnapshot,
  hasUnreadCompletion: boolean
): SessionActivityStatus {
  return resolveSessionActivityStatus({
    isAwaitingUser: hasActionableInput(session) || session.status === 'waiting',
    hasError: session.status === 'failed',
    isStreaming: sessionIsWorking(session),
    hasUnreadCompletion
  })
}

function assistantTranscriptGrew(
  before: SessionSnapshot,
  after: SessionSnapshot
): boolean {
  const assistantFootprint = (session: SessionSnapshot): { count: number; characters: number } =>
    session.transcript.reduce((footprint, item) => {
      if (item.kind !== 'message' || item.role !== 'assistant') return footprint
      return {
        count: footprint.count + 1,
        characters: footprint.characters + Array.from(item.text).length
      }
    }, { count: 0, characters: 0 })
  const previous = assistantFootprint(before)
  const next = assistantFootprint(after)
  return next.count > previous.count || next.characters > previous.characters
}

function publicSessionSnapshot(
  session: SessionSnapshot,
  environmentSupportsFork: boolean,
  presentation: {
    hasUnreadCompletion: boolean
    pendingUserCount: number
    workingSince: string | undefined
    activities: import('../shared/acp/sessionActivity').SessionActivitySnapshot | undefined
    savedAgent: SavedAgent | undefined
  }
): import('../shared/models').PublicSessionSnapshot {
  const {
    acpSessionId: _acpSessionId,
    pendingPermission,
    pendingInteraction,
    ...publicSession
  } = session
  return {
    ...publicSession,
    canFork: environmentSupportsFork && isForkableSourceSession(session) && isStrictUuid(session.acpSessionId),
    activityStatus: sessionActivityStatus(session, presentation.hasUnreadCompletion),
    hasUnreadCompletion: presentation.hasUnreadCompletion,
    pendingUserCount: Math.max(0, Math.min(128, Math.trunc(presentation.pendingUserCount))),
    ...(presentation.workingSince ? { workingSince: presentation.workingSince } : {}),
    ...(presentation.activities ? { activities: presentation.activities } : {}),
    ...(presentation.savedAgent
      ? {
          savedAgentId: presentation.savedAgent.id,
          savedAgent: {
            name: presentation.savedAgent.name,
            glyph: presentation.savedAgent.glyph,
            color: presentation.savedAgent.color
          }
        }
      : {}),
    ...(pendingPermission
      ? { pendingPermission: withoutPrivateSessionId(pendingPermission) }
      : {}),
    ...(pendingInteraction
      ? { pendingInteraction: withoutPrivateSessionId(pendingInteraction) }
      : {})
  }
}

function publicSavedAgentSummary(agent: SavedAgent): PublicSavedAgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    mission: agent.mission,
    glyph: agent.glyph,
    color: agent.color,
    isPinned: agent.isPinned
  }
}

function publicAgentRosterSnapshot(load: AgentRosterLoadResult): PublicAgentRosterSnapshot {
  return load.status === 'ready'
    ? {
        status: 'ready',
        revision: load.roster.revision,
        agents: load.roster.agents.map(publicSavedAgentSummary)
      }
    : { status: 'invalid', revision: 0, reason: load.reason }
}

function boundExistingSessionIds(
  roster: AgentRoster,
  agentId: string,
  state: PersistedState
): string[] {
  const normalizedAgentId = agentId.toLocaleLowerCase('en-US')
  const existingIds = new Set(state.sessions.map((session) => session.id))
  return Object.entries(roster.sessionBindings)
    .filter(([sessionId, boundAgentId]) =>
      existingIds.has(sessionId) && boundAgentId === normalizedAgentId
    )
    .map(([sessionId]) => sessionId)
}

function withoutPrivateSessionId<T extends { sessionId: string }>(
  value: T
): T extends unknown ? Omit<T, 'sessionId'> : never {
  const { sessionId: _sessionId, ...safe } = value
  return safe as T extends unknown ? Omit<T, 'sessionId'> : never
}

/**
 * AttachmentBroker emits an optional file note, an optional image note, then
 * image blocks. Swift places the user's text between those two notes. Derive
 * that ordering structurally so no attachment path or byte payload needs to be
 * exposed outside main.
 */
function composeAttachmentPrompt(
  userText: string,
  consumed: ConsumedAttachments
): { blocks: AttachmentPromptBlock[]; transcriptText: string } {
  const notes = consumed.blocks.filter(
    (block): block is Extract<AttachmentPromptBlock, { type: 'text' }> => block.type === 'text'
  )
  const images = consumed.blocks.filter(
    (block): block is Extract<AttachmentPromptBlock, { type: 'image' }> => block.type === 'image'
  )
  const imageNote = images.length > 0 ? notes.pop() : undefined
  const blocks: AttachmentPromptBlock[] = [
    ...notes,
    ...(userText ? [{ type: 'text' as const, text: userText }] : []),
    ...(imageNote ? [imageNote] : []),
    ...images
  ]
  const transcriptText = blocks
    .filter((block): block is Extract<AttachmentPromptBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
  if (!transcriptText || blocks.length === 0) {
    throw new AttachmentBrokerError('invalid-request')
  }
  return { blocks, transcriptText }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isPermissionIntent(
  value: string | undefined
): value is 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' {
  return (
    value === 'allow_once' ||
    value === 'allow_always' ||
    value === 'reject_once' ||
    value === 'reject_always'
  )
}

export function chooseAutoPermissionOption(permission: PendingPermission): string | undefined {
  return permission.options.find((option) => option.intent === 'allow_always')?.id
    ?? permission.options.find((option) => option.intent?.startsWith('allow'))?.id
    ?? permission.options.find((option) => /^allow(?:\b|_)/i.test(option.id))?.id
    ?? permission.options[0]?.id
}

function withoutPendingPermission(session: SessionSnapshot): SessionSnapshot {
  const { pendingPermission: _pendingPermission, ...rest } = session
  return rest
}

function withoutPendingInteraction(session: SessionSnapshot): SessionSnapshot {
  const { pendingInteraction: _pendingInteraction, ...rest } = session
  return rest
}

function withoutCapabilities(session: SessionSnapshot): SessionSnapshot {
  const {
    availableModels: _availableModels,
    availableModes: _availableModes,
    ...rest
  } = session
  return rest
}

function retryState(
  session: SessionSnapshot,
  status: SessionSnapshot['status']
): SessionSnapshot {
  const {
    lastError: _lastError,
    pendingPermission: _pendingPermission,
    pendingInteraction: _pendingInteraction,
    availableModels: _availableModels,
    availableModes: _availableModes,
    ...rest
  } = session
  return {
    ...rest,
    status,
    updatedAt: new Date().toISOString()
  }
}

function needsWorkspaceQuiescence(session: SessionSnapshot): boolean {
  return (
    session.status !== 'idle' ||
    session.pendingPermission !== undefined ||
    session.pendingInteraction !== undefined ||
    session.availableModels !== undefined ||
    session.availableModes !== undefined ||
    (session.pendingHookRuns ?? 0) > 0 ||
    session.transcript.some((item) => 'streaming' in item && item.streaming === true)
  )
}

function quiesceWorkspaceSession(session: SessionSnapshot): SessionSnapshot {
  const {
    pendingPermission: _pendingPermission,
    pendingInteraction: _pendingInteraction,
    pendingHookRuns: _pendingHookRuns,
    availableModels: _availableModels,
    availableModes: _availableModes,
    ...rest
  } = session
  return {
    ...rest,
    status: 'idle',
    transcript: session.transcript.map((item) =>
      'streaming' in item && item.streaming ? { ...item, streaming: false } : item
    ),
    updatedAt: new Date().toISOString()
  }
}

function forkedSessionSnapshot(
  source: SessionSnapshot,
  localSessionId: string,
  acpSessionId: string,
  timestamp: string
): SessionSnapshot {
  const {
    id: _id,
    acpSessionId: _acpSessionId,
    title: _title,
    status: _status,
    transcript: _transcript,
    pendingPermission: _pendingPermission,
    pendingInteraction: _pendingInteraction,
    pendingHookRuns: _pendingHookRuns,
    availableModels: _availableModels,
    availableModes: _availableModes,
    lastError: _lastError,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...settled
  } = source
  return {
    ...settled,
    id: localSessionId,
    acpSessionId,
    title: `Fork of ${source.title}`.slice(0, 2_000),
    status: 'idle',
    transcript: source.transcript.map((item) => {
      if (item.kind !== 'message' && item.kind !== 'thought') return structuredClone(item)
      const { streaming: _streaming, ...rest } = item
      return structuredClone(rest)
    }),
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

function supportsSessionFork(version: string | undefined): boolean {
  return cliVersionAtLeast(version, [1, 0, 5])
}

function orderedProjects(state: PersistedState): ProjectSnapshot[] {
  return ProjectOrderPolicy.orderedProjects(state)
}

function rebaseMigrationState(
  candidate: PersistedState,
  live: PersistedState,
  originalProjectIds: ReadonlySet<string>,
  originalSessionIds: ReadonlySet<string>,
  originalSelection: { projectId: string | undefined; sessionId: string | undefined }
): PersistedState {
  const importedSessions = candidate.sessions.filter((session) => !originalSessionIds.has(session.id))
  const importedSessionIds = new Set(importedSessions.map((session) => session.id))
  const liveSessionIds = new Set(live.sessions.map((session) => session.id))
  const candidateProjects = new Map(candidate.projects.map((project) => [project.id, project]))
  const liveProjectIds = new Set(live.projects.map((project) => project.id))
  const projects = live.projects.map((project) => {
    const candidateProject = candidateProjects.get(project.id)
    const additions = candidateProject?.sessionIds.filter((sessionId) =>
      importedSessionIds.has(sessionId) && !project.sessionIds.includes(sessionId)
    ) ?? []
    return { ...structuredClone(project), sessionIds: [...project.sessionIds, ...additions] }
  })
  projects.push(...candidate.projects
    .filter((project) => !originalProjectIds.has(project.id) && !liveProjectIds.has(project.id))
    .map((project) => structuredClone(project)))

  const rebased: PersistedState = {
    ...structuredClone(candidate),
    projects,
    sessions: [
      ...live.sessions.map((session) => structuredClone(session)),
      ...importedSessions
        .filter((session) => !liveSessionIds.has(session.id))
        .map((session) => structuredClone(session))
    ],
    pinnedProjectIds: structuredClone(live.pinnedProjectIds),
    pinnedSessionIds: structuredClone(live.pinnedSessionIds),
    settledSessionIds: [
      ...structuredClone(live.settledSessionIds),
      ...candidate.settledSessionIds.filter((sessionId) => importedSessionIds.has(sessionId))
    ],
    selectedSessionIdByProject: {
      ...candidate.selectedSessionIdByProject,
      ...live.selectedSessionIdByProject
    },
    settings: structuredClone(live.settings)
  }
  const selectionChanged =
    live.selectedProjectId !== originalSelection.projectId ||
    live.selectedSessionId !== originalSelection.sessionId
  if (selectionChanged) {
    if (live.selectedProjectId) rebased.selectedProjectId = live.selectedProjectId
    else delete rebased.selectedProjectId
    if (live.selectedSessionId) rebased.selectedSessionId = live.selectedSessionId
    else delete rebased.selectedSessionId
  }
  normalizeLayoutState(rebased)
  return rebased
}

function normalizeLayoutState(state: PersistedState): void {
  state.projects = distinctRecordsById(state.projects)
  state.sessions = distinctRecordsById(state.sessions)
  const projectIds = new Set(state.projects.map((project) => project.id))
  state.sessions = state.sessions.filter((session) => projectIds.has(session.projectId))
  const sessionsById = new Map(state.sessions.map((session) => [session.id, session]))
  for (const project of state.projects) {
    const seen = new Set<string>()
    project.sessionIds = project.sessionIds.filter((id) => {
      const session = sessionsById.get(id)
      return Boolean(session && session.projectId === project.id && !seen.has(id) && seen.add(id))
    })
    for (const session of state.sessions) {
      if (session.projectId === project.id && !seen.has(session.id)) {
        seen.add(session.id)
        project.sessionIds.push(session.id)
      }
    }
  }
  state.pinnedProjectIds = distinctValidIds(state.pinnedProjectIds, projectIds, MAX_PINNED_PROJECTS)
  state.pinnedSessionIds = distinctValidIds(
    state.pinnedSessionIds,
    new Set(state.sessions.map((session) => session.id)),
    MAX_PINNED_SESSIONS
  )
  const pinnedSessionIds = new Set(state.pinnedSessionIds)
  state.settledSessionIds = distinctValidIds(
    state.settledSessionIds,
    new Set(state.sessions.map((session) => session.id)),
    MAX_SETTLED_SESSIONS
  ).filter((sessionId) => !pinnedSessionIds.has(sessionId))
  state.selectedSessionIdByProject = Object.fromEntries(
    Object.entries(state.selectedSessionIdByProject)
      .filter(([projectId, sessionId]) => {
        const session = sessionsById.get(sessionId)
        return session?.projectId === projectId && isDurableSession(session)
      })
      .slice(0, 2_000)
  )
  const selectedSession = state.selectedSessionId
    ? sessionsById.get(state.selectedSessionId)
    : undefined
  if (selectedSession) {
    state.selectedProjectId = selectedSession.projectId
    rememberDurableSelection(state, selectedSession)
  } else {
    delete state.selectedSessionId
    if (!state.selectedProjectId || !projectIds.has(state.selectedProjectId)) {
      const firstProject = orderedProjects(state)[0]
      if (firstProject) state.selectedProjectId = firstProject.id
      else delete state.selectedProjectId
    }
  }
}

function distinctRecordsById<T extends { id: string }>(records: readonly T[]): T[] {
  const seen = new Set<string>()
  return records.filter((record) => !seen.has(record.id) && Boolean(seen.add(record.id)))
}

function rememberDurableSelection(state: PersistedState, session: SessionSnapshot): void {
  if (isDurableSession(session)) {
    state.selectedSessionIdByProject[session.projectId] = session.id
  }
}

function isDurableSession(session: SessionSnapshot): boolean {
  return Boolean(session.acpSessionId || session.transcript.length > 0)
}

function preferredProjectSession(
  state: PersistedState,
  projectId: string
): SessionSnapshot | undefined {
  const sessionsById = new Map(state.sessions.map((session) => [session.id, session]))
  const mapped = sessionsById.get(state.selectedSessionIdByProject[projectId] ?? '')
  if (mapped?.projectId === projectId && isDurableSession(mapped)) return mapped
  const global = sessionsById.get(state.selectedSessionId ?? '')
  if (global?.projectId === projectId) return global
  const project = state.projects.find((candidate) => candidate.id === projectId)
  if (!project) return undefined
  return mostRecentlyUsedSession(
    project.sessionIds.flatMap((sessionId) => {
      const session = sessionsById.get(sessionId)
      return session?.projectId === projectId ? [session] : []
    }).filter(isDurableSession)
  )
    ?? mostRecentlyUsedSession(
      project.sessionIds.flatMap((sessionId) => {
        const session = sessionsById.get(sessionId)
        return session?.projectId === projectId ? [session] : []
      })
    )
}

function mostRecentlyUsedSession(
  sessions: readonly SessionSnapshot[]
): SessionSnapshot | undefined {
  return sessions.reduce<SessionSnapshot | undefined>((latest, session) => {
    if (!latest) return session
    const timestampOrder = session.updatedAt.localeCompare(latest.updatedAt)
    return timestampOrder >= 0 ? session : latest
  }, undefined)
}

function distinctValidIds(ids: string[], valid: Set<string>, limit: number): string[] {
  const seen = new Set<string>()
  return ids.filter((id) => valid.has(id) && !seen.has(id) && seen.add(id)).slice(0, limit)
}

function duplicateTitle(title: string, existingTitles: string[]): string {
  const base = title.trim() || 'Session'
  const first = `${base} (copy)`
  if (!existingTitles.includes(first)) return first
  let suffix = 2
  while (existingTitles.includes(`${base} (copy ${suffix})`)) suffix += 1
  return `${base} (copy ${suffix})`
}

async function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) return
  let timeout: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.allSettled(promises),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs)
    })
  ])
  if (timeout) clearTimeout(timeout)
}
