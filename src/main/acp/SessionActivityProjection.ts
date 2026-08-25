import {
  MAX_SESSION_ACTIVITY_COUNTER,
  MAX_SESSION_ACTIVITY_ITEMS,
  MAX_SESSION_ACTIVITY_UNKNOWN_EVENTS,
  sessionActivitySnapshotSchema,
  type BackgroundActivity,
  type GoalActivity,
  type ScheduledActivity,
  type SessionActivitySnapshot,
  type SessionActivitySyncState,
  type WorkflowActivity
} from '../../shared/acp/sessionActivity'
import {
  parseSessionActivityUpdate,
  sessionActivityUpdateSchema,
  type SessionActivityUpdate
} from '../../shared/acp/sessionActivityUpdates'

const MAX_INTERNAL_TOMBSTONES = 256
const MAX_PENDING_LEGACY_CALLS = 128

interface InternalSchedule {
  identity: string
  source: 'typed' | 'legacy'
  publicValue: ScheduledActivity
}

interface InternalBackground {
  identity: string
  publicValue: BackgroundActivity
}

interface InternalWorkflow {
  identity: string
  revision?: bigint
  source: 'typed' | 'legacy'
  publicValue: WorkflowActivity
}

interface InternalGoal {
  identity: string
  publicValue: GoalActivity
}

interface LegacySchedulerInput {
  operation: 'create' | 'list' | 'delete'
  targetIdentity?: string
  label?: string
  schedule?: string
}

/** Main-only state. Raw CLI identities never appear in the public snapshot. */
export interface SessionActivityProjectionState {
  syncState: SessionActivitySyncState
  unknownEventCount: number
  nextViewSequence: number
  schedules: Map<string, InternalSchedule>
  background: Map<string, InternalBackground>
  workflows: Map<string, InternalWorkflow>
  workflowTombstones: Set<string>
  workflowTombstonesSaturated: boolean
  goal: InternalGoal | undefined
  goalTombstones: Set<string>
  goalTombstonesSaturated: boolean
  legacySchedulerInputs: Map<string, LegacySchedulerInput>
  scheduleOverflowed: boolean
  backgroundProtectionOverflowed: boolean
  workflowProtectionOverflowed: boolean
  goalProtectionOverflowed: boolean
  schedulerAuthority: 'typed' | 'legacy' | undefined
  schedulerGeneration: bigint | undefined
  schedulerRevision: bigint | undefined
}

export function createSessionActivityProjectionState(): SessionActivityProjectionState {
  return {
    syncState: 'unseen',
    unknownEventCount: 0,
    nextViewSequence: 1,
    schedules: new Map(),
    background: new Map(),
    workflows: new Map(),
    workflowTombstones: new Set(),
    workflowTombstonesSaturated: false,
    goal: undefined,
    goalTombstones: new Set(),
    goalTombstonesSaturated: false,
    legacySchedulerInputs: new Map(),
    scheduleOverflowed: false,
    backgroundProtectionOverflowed: false,
    workflowProtectionOverflowed: false,
    goalProtectionOverflowed: false,
    schedulerAuthority: undefined,
    schedulerGeneration: undefined,
    schedulerRevision: undefined
  }
}

/**
 * Pure reducer: every accepted event returns detached Maps/Sets and leaves the
 * input state untouched. Raw identities stay inside this main-process state.
 */
export function reduceSessionActivityProjection(
  current: SessionActivityProjectionState,
  update: SessionActivityUpdate
): SessionActivityProjectionState {
  const state = cloneState(current)
  switch (update.type) {
    case 'activity_unknown':
      incrementUnknown(state)
      return state
    case 'activity_legacy_scheduler_input': {
      if (state.schedulerAuthority === 'typed') {
        state.legacySchedulerInputs.delete(update.callIdentity)
        return state
      }
      if (!state.legacySchedulerInputs.has(update.callIdentity) &&
          state.legacySchedulerInputs.size >= MAX_PENDING_LEGACY_CALLS) {
        incrementUnknown(state)
        return state
      }
      const pending: LegacySchedulerInput = {
        operation: update.operation,
        ...(update.targetIdentity ? { targetIdentity: update.targetIdentity } : {}),
        ...(update.label ? { label: update.label } : {}),
        ...(update.schedule ? { schedule: update.schedule } : {})
      }
      const previous = state.legacySchedulerInputs.get(update.callIdentity)
      if (previous && update.operation === 'delete' && !update.targetIdentity) {
        if (previous.targetIdentity) state.schedules.delete(previous.targetIdentity)
        state.legacySchedulerInputs.delete(update.callIdentity)
        return state
      }
      state.legacySchedulerInputs.set(update.callIdentity, pending)
      return state
    }
    case 'activity_schedule_replace': {
      if (!acceptSchedulerMutation(state, update.source, update.generation, update.revision)) {
        if (update.callIdentity) state.legacySchedulerInputs.delete(update.callIdentity)
        return state
      }
      const replacement = new Map<string, InternalSchedule>()
      for (const schedule of update.schedules) {
        const existing = state.schedules.get(schedule.identity)
        const viewKey = existing?.publicValue.viewKey ?? nextViewKey(state, 'schedule')
        if (!viewKey) {
          incrementUnknown(state)
          return state
        }
        replacement.set(schedule.identity, {
          identity: schedule.identity,
          source: update.source,
          publicValue: {
            viewKey,
            label: schedule.label,
            status: 'scheduled',
            ...(schedule.schedule ? { schedule: schedule.schedule } : {}),
            ...(schedule.nextFireAt ? { nextFireAt: schedule.nextFireAt } : {}),
            fireCount: existing?.publicValue.fireCount ?? 0
          }
        })
      }
      state.schedules = replacement
      state.scheduleOverflowed = update.overflowed
      if (update.callIdentity) state.legacySchedulerInputs.delete(update.callIdentity)
      return state
    }
    case 'activity_schedule_upsert': {
      if (!acceptSchedulerMutation(state, update.source, update.generation, update.revision)) {
        if (update.callIdentity) state.legacySchedulerInputs.delete(update.callIdentity)
        return state
      }
      const existing = state.schedules.get(update.schedule.identity)
      if (!existing && state.schedules.size >= MAX_SESSION_ACTIVITY_ITEMS) {
        state.scheduleOverflowed = true
        incrementUnknown(state)
        if (update.callIdentity) state.legacySchedulerInputs.delete(update.callIdentity)
        return state
      }
      const pending = update.callIdentity
        ? state.legacySchedulerInputs.get(update.callIdentity)
        : undefined
      const viewKey = existing?.publicValue.viewKey ?? nextViewKey(state, 'schedule')
      if (!viewKey) {
        incrementUnknown(state)
        return state
      }
      const label = update.schedule.label === 'Scheduled task' && pending?.label
        ? pending.label
        : update.schedule.label
      const schedule = update.schedule.schedule ?? pending?.schedule ?? existing?.publicValue.schedule
      const nextFireAt = update.schedule.nextFireAt ?? existing?.publicValue.nextFireAt
      state.schedules.set(update.schedule.identity, {
        identity: update.schedule.identity,
        source: update.source,
        publicValue: {
          viewKey,
          label,
          status: update.fired ? 'fired' : 'scheduled',
          ...(schedule ? { schedule } : {}),
          ...(nextFireAt ? { nextFireAt } : {}),
          fireCount: update.fired
            ? boundedIncrement(existing?.publicValue.fireCount ?? 0)
            : existing?.publicValue.fireCount ?? 0
        }
      })
      if (update.callIdentity) state.legacySchedulerInputs.delete(update.callIdentity)
      return state
    }
    case 'activity_schedule_delete': {
      if (!acceptSchedulerMutation(state, update.source, update.generation, update.revision)) {
        if (update.callIdentity) state.legacySchedulerInputs.delete(update.callIdentity)
        return state
      }
      state.schedules.delete(update.identity)
      if (update.callIdentity) state.legacySchedulerInputs.delete(update.callIdentity)
      return state
    }
    case 'activity_background_update': {
      const existing = state.background.get(update.identity)
      if (existing && isTerminalBackground(existing.publicValue.status) && update.status === 'running') {
        return state
      }
      if (!existing && state.background.size >= MAX_SESSION_ACTIVITY_ITEMS) {
        if (!isTerminalBackground(update.status)) state.backgroundProtectionOverflowed = true
        incrementUnknown(state)
        return state
      }
      const viewKey = existing?.publicValue.viewKey ?? nextViewKey(state, 'background')
      if (!viewKey) {
        incrementUnknown(state)
        return state
      }
      state.background.set(update.identity, {
        identity: update.identity,
        publicValue: {
          viewKey,
          kind: update.kind,
          label: update.label,
          status: update.status,
          updateCount: boundedIncrement(existing?.publicValue.updateCount ?? 0)
        }
      })
      return state
    }
    case 'activity_workflow_update': {
      const workflow = update.workflow
      const revision = workflow.revision === undefined ? undefined : BigInt(workflow.revision)
      const existing = state.workflows.get(workflow.identity)
      if (update.source === 'legacy' && existing?.source === 'typed') return state
      if (update.source === 'typed' && existing?.revision !== undefined && revision !== undefined &&
          revision <= existing.revision) return state
      if (workflow.status === 'cleared') {
        state.workflows.delete(workflow.identity)
        addWorkflowTombstone(state, workflow.identity)
        return state
      }
      if (state.workflowTombstones.has(workflow.identity)) return state
      if (state.workflowTombstonesSaturated) {
        if (!isTerminalWorkflow(workflow.status)) state.workflowProtectionOverflowed = true
        return state
      }
      if (!existing && state.workflows.size >= MAX_SESSION_ACTIVITY_ITEMS) {
        if (!isTerminalWorkflow(workflow.status)) state.workflowProtectionOverflowed = true
        incrementUnknown(state)
        return state
      }
      const viewKey = existing?.publicValue.viewKey ?? nextViewKey(state, 'workflow')
      if (!viewKey) {
        incrementUnknown(state)
        return state
      }
      state.workflows.set(workflow.identity, {
        identity: workflow.identity,
        source: update.source,
        ...(revision !== undefined ? { revision } : {}),
        publicValue: {
          viewKey,
          name: workflow.name,
          ...(workflow.objective ? { objective: workflow.objective } : {}),
          status: workflow.status,
          ...(workflow.phase ? { phase: workflow.phase } : {}),
          ...(workflow.phaseIndex !== undefined ? { phaseIndex: workflow.phaseIndex } : {}),
          ...(workflow.phaseCount !== undefined ? { phaseCount: workflow.phaseCount } : {}),
          ...(workflow.agentBudget !== undefined ? { agentBudget: workflow.agentBudget } : {}),
          ...(workflow.agentsUsed !== undefined ? { agentsUsed: workflow.agentsUsed } : {}),
          ...(workflow.agentsReserved !== undefined ? { agentsReserved: workflow.agentsReserved } : {}),
          ...(workflow.activeAgents !== undefined ? { activeAgents: workflow.activeAgents } : {}),
          ...(workflow.agentUsageIncomplete !== undefined
            ? { agentUsageIncomplete: workflow.agentUsageIncomplete }
            : {}),
          ...(workflow.elapsedMs !== undefined ? { elapsedMs: workflow.elapsedMs } : {})
        }
      })
      return state
    }
    case 'activity_goal_update': {
      const goal = update.goal
      const identity = goal.identity ?? state.goal?.identity
      if (goal.status === 'cleared') {
        if (identity) addGoalTombstone(state, identity)
        if (!goal.identity || state.goal?.identity === goal.identity) state.goal = undefined
        return state
      }
      if (!identity || state.goalTombstones.has(identity)) return state
      if (state.goalTombstonesSaturated) {
        if (goal.status === 'active' || goal.status === 'paused') {
          state.goalProtectionOverflowed = true
        }
        return state
      }
      if (state.goal && state.goal.identity !== identity) {
        addGoalTombstone(state, state.goal.identity)
      }
      const sameGoal = state.goal?.identity === identity ? state.goal : undefined
      state.goal = {
        identity,
        publicValue: {
          objective: goal.objective,
          status: goal.status,
          ...(goal.phase ? { phase: goal.phase } : {}),
          ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
          ...(goal.tokensUsed !== undefined ? { tokensUsed: goal.tokensUsed } : {}),
          ...(goal.elapsedMs !== undefined
            ? { elapsedMs: Math.max(goal.elapsedMs, sameGoal?.publicValue.elapsedMs ?? 0) }
            : sameGoal?.publicValue.elapsedMs !== undefined
              ? { elapsedMs: sameGoal.publicValue.elapsedMs }
              : {}),
          ...(goal.totalDeliverables !== undefined ? { totalDeliverables: goal.totalDeliverables } : {}),
          ...(goal.completedDeliverables !== undefined
            ? { completedDeliverables: goal.completedDeliverables }
            : {}),
          ...(goal.workerRounds !== undefined ? { workerRounds: goal.workerRounds } : {}),
          ...(goal.verifyRounds !== undefined ? { verifyRounds: goal.verifyRounds } : {}),
          ...(goal.activeAgents !== undefined ? { activeAgents: goal.activeAgents } : {})
        }
      }
      return state
    }
  }
}

export function sessionActivitySnapshotFromState(
  state: SessionActivityProjectionState
): SessionActivitySnapshot {
  return sessionActivitySnapshotSchema.parse({
    version: 1,
    syncState: state.syncState,
    unknownEventCount: state.unknownEventCount,
    schedules: [...state.schedules.values()].map(({ publicValue }) => ({ ...publicValue })),
    background: [...state.background.values()].map(({ publicValue }) => ({ ...publicValue })),
    workflows: [...state.workflows.values()].map(({ publicValue }) => ({ ...publicValue })),
    goal: state.goal ? { ...state.goal.publicValue } : null
  })
}

/**
 * Main-only process-liveness truth. Public arrays are display-capped, so the
 * renderer snapshot must never decide whether a worker is safe to evict.
 * Callers apply sync-state policy separately and only protect live sessions.
 */
export function sessionActivityHasLiveProtectionWork(
  state: SessionActivityProjectionState
): boolean {
  if (state.schedules.size > 0 || state.scheduleOverflowed) return true
  if (state.backgroundProtectionOverflowed || state.workflowProtectionOverflowed ||
      state.goalProtectionOverflowed) return true
  if ([...state.background.values()].some(({ publicValue }) =>
    !isTerminalBackground(publicValue.status))) return true
  if ([...state.workflows.values()].some(({ publicValue }) =>
    !isTerminalWorkflow(publicValue.status))) return true
  return state.goal?.publicValue.status === 'active' || state.goal?.publicValue.status === 'paused'
}

export class SessionActivityProjection {
  private state = createSessionActivityProjectionState()

  ingest(value: unknown): boolean {
    const update = parseSessionActivityUpdate(value)
    if (!update) return false
    this.state = reduceSessionActivityProjection(this.state, update)
    return true
  }

  apply(update: SessionActivityUpdate): void {
    this.state = reduceSessionActivityProjection(this.state, sessionActivityUpdateGuard(update))
  }

  setSyncState(syncState: SessionActivitySyncState): void {
    this.state = { ...this.state, syncState }
  }

  getSnapshot(): SessionActivitySnapshot {
    return sessionActivitySnapshotFromState(this.state)
  }

  hasLiveProtectionWork(): boolean {
    return sessionActivityHasLiveProtectionWork(this.state)
  }
}

function sessionActivityUpdateGuard(update: SessionActivityUpdate): SessionActivityUpdate {
  // The semantic event normally arrives through a strict worker schema. The
  // class keeps its standalone API fail-closed as well.
  const parsed = parseSemanticUpdate(update)
  return parsed ?? { type: 'activity_unknown' }
}

function parseSemanticUpdate(value: unknown): SessionActivityUpdate | undefined {
  const parsed = sessionActivityUpdateSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function acceptSchedulerMutation(
  state: SessionActivityProjectionState,
  source: 'typed' | 'legacy',
  generation: string | undefined,
  revision: string | undefined
): boolean {
  if (source === 'legacy') {
    if (state.schedulerAuthority === 'typed') return false
    state.schedulerAuthority = 'legacy'
    return true
  }
  if (state.schedulerAuthority !== 'typed') {
    const replacesLegacyAuthority = state.schedulerAuthority === 'legacy'
    state.schedulerAuthority = 'typed'
    state.legacySchedulerInputs.clear()
    if (replacesLegacyAuthority) {
      state.schedules.clear()
      state.scheduleOverflowed = false
    }
  }
  return acceptSchedulerClock(state, generation, revision)
}

function acceptSchedulerClock(
  state: SessionActivityProjectionState,
  generation: string | undefined,
  revision: string | undefined
): boolean {
  if (generation === undefined && revision === undefined) {
    return state.schedulerGeneration === undefined && state.schedulerRevision === undefined
  }
  const nextGeneration = generation === undefined ? state.schedulerGeneration : BigInt(generation)
  const nextRevision = revision === undefined ? undefined : BigInt(revision)
  if (state.schedulerGeneration !== undefined && nextGeneration !== undefined) {
    if (nextGeneration < state.schedulerGeneration) return false
    if (nextGeneration === state.schedulerGeneration && state.schedulerRevision !== undefined &&
        (nextRevision === undefined || nextRevision <= state.schedulerRevision)) return false
  }
  if (nextGeneration !== undefined &&
      (state.schedulerGeneration === undefined || nextGeneration > state.schedulerGeneration)) {
    // A scheduler generation is an authoritative epoch. The CLI re-announces
    // the live set after restore; retaining entries from the prior epoch would
    // manufacture schedules that no longer exist.
    state.schedules.clear()
    state.scheduleOverflowed = false
    state.legacySchedulerInputs.clear()
    state.schedulerGeneration = nextGeneration
    state.schedulerRevision = nextRevision
    return true
  }
  if (nextRevision !== undefined) state.schedulerRevision = nextRevision
  return true
}

function cloneState(state: SessionActivityProjectionState): SessionActivityProjectionState {
  return {
    ...state,
    schedules: new Map(state.schedules),
    background: new Map(state.background),
    workflows: new Map(state.workflows),
    workflowTombstones: new Set(state.workflowTombstones),
    goal: state.goal
      ? { ...state.goal, publicValue: { ...state.goal.publicValue } }
      : undefined,
    goalTombstones: new Set(state.goalTombstones),
    legacySchedulerInputs: new Map(state.legacySchedulerInputs)
  }
}

function nextViewKey(
  state: SessionActivityProjectionState,
  kind: 'schedule' | 'background' | 'workflow'
): string | undefined {
  if (state.nextViewSequence > 9_999_999_999) return undefined
  const key = `${kind}-${state.nextViewSequence}`
  state.nextViewSequence += 1
  return key
}

function addWorkflowTombstone(state: SessionActivityProjectionState, identity: string): void {
  if (state.workflowTombstones.has(identity)) return
  if (state.workflowTombstones.size < MAX_INTERNAL_TOMBSTONES) {
    state.workflowTombstones.add(identity)
  } else {
    state.workflowTombstonesSaturated = true
    incrementUnknown(state)
  }
}

function addGoalTombstone(state: SessionActivityProjectionState, identity: string): void {
  if (state.goalTombstones.has(identity)) return
  if (state.goalTombstones.size < MAX_INTERNAL_TOMBSTONES) {
    state.goalTombstones.add(identity)
  } else {
    state.goalTombstonesSaturated = true
    incrementUnknown(state)
  }
}

function incrementUnknown(state: SessionActivityProjectionState): void {
  state.unknownEventCount = Math.min(
    MAX_SESSION_ACTIVITY_UNKNOWN_EVENTS,
    state.unknownEventCount + 1
  )
}

function boundedIncrement(value: number): number {
  return Math.min(MAX_SESSION_ACTIVITY_COUNTER, value + 1)
}

function isTerminalBackground(status: BackgroundActivity['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isTerminalWorkflow(status: WorkflowActivity['status']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed' ||
    status === 'interrupted'
}
