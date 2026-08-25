import { z } from 'zod'
import {
  MAX_SESSION_ACTIVITY_COUNTER,
  MAX_SESSION_ACTIVITY_ITEMS,
  MAX_SESSION_ACTIVITY_TEXT_CHARS
} from './sessionActivity'
import { sanitizeDisplayTitle } from '../security/redaction'

const identitySchema = z.string().min(1).max(256)
const labelSchema = z.string().max(MAX_SESSION_ACTIVITY_TEXT_CHARS)
const counterSchema = z.number().int().nonnegative().max(MAX_SESSION_ACTIVITY_COUNTER)
const revisionSchema = z.string().regex(/^\d{1,20}$/u)

const schedulerClockFields = {
  generation: revisionSchema.optional(),
  revision: revisionSchema.optional()
} as const

const schedulePayloadSchema = z.object({
  identity: identitySchema,
  label: labelSchema,
  schedule: labelSchema.optional(),
  nextFireAt: z.string().max(64).optional()
}).strict()

const workflowPayloadSchema = z.object({
  identity: identitySchema,
  revision: revisionSchema.optional(),
  name: labelSchema,
  objective: labelSchema.optional(),
  status: z.enum([
    'active',
    'paused',
    'budget_limited',
    'completed',
    'cancelled',
    'failed',
    'interrupted',
    'cleared',
    'unknown'
  ]),
  phase: labelSchema.optional(),
  phaseIndex: counterSchema.optional(),
  phaseCount: counterSchema.optional(),
  agentBudget: counterSchema.optional(),
  agentsUsed: counterSchema.optional(),
  agentsReserved: counterSchema.optional(),
  activeAgents: counterSchema.optional(),
  agentUsageIncomplete: z.boolean().optional(),
  elapsedMs: counterSchema.optional()
}).strict()

const goalPayloadSchema = z.object({
  identity: identitySchema.optional(),
  objective: labelSchema,
  status: z.enum(['active', 'paused', 'completed', 'cancelled', 'failed', 'cleared', 'unknown']),
  phase: labelSchema.optional(),
  tokenBudget: counterSchema.optional(),
  tokensUsed: counterSchema.optional(),
  elapsedMs: counterSchema.optional(),
  totalDeliverables: counterSchema.optional(),
  completedDeliverables: counterSchema.optional(),
  workerRounds: counterSchema.optional(),
  verifyRounds: counterSchema.optional(),
  activeAgents: counterSchema.optional()
}).strict()

export const sessionActivityUpdateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('activity_schedule_upsert'),
    source: z.enum(['typed', 'legacy']),
    fired: z.boolean(),
    callIdentity: identitySchema.optional(),
    ...schedulerClockFields,
    schedule: schedulePayloadSchema
  }).strict(),
  z.object({
    type: z.literal('activity_schedule_delete'),
    source: z.enum(['typed', 'legacy']),
    callIdentity: identitySchema.optional(),
    ...schedulerClockFields,
    identity: identitySchema
  }).strict(),
  z.object({
    type: z.literal('activity_schedule_replace'),
    source: z.literal('legacy'),
    callIdentity: identitySchema.optional(),
    ...schedulerClockFields,
    overflowed: z.boolean(),
    schedules: z.array(schedulePayloadSchema).max(MAX_SESSION_ACTIVITY_ITEMS)
  }).strict(),
  z.object({
    type: z.literal('activity_background_update'),
    identity: identitySchema,
    kind: z.enum(['command', 'monitor', 'subagent']),
    label: labelSchema,
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'unknown'])
  }).strict(),
  z.object({
    type: z.literal('activity_workflow_update'),
    source: z.enum(['typed', 'legacy']),
    workflow: workflowPayloadSchema
  }).strict(),
  z.object({
    type: z.literal('activity_goal_update'),
    goal: goalPayloadSchema
  }).strict(),
  z.object({
    type: z.literal('activity_legacy_scheduler_input'),
    callIdentity: identitySchema,
    operation: z.enum(['create', 'list', 'delete']),
    targetIdentity: identitySchema.optional(),
    label: labelSchema.optional(),
    schedule: labelSchema.optional()
  }).strict(),
  z.object({ type: z.literal('activity_unknown') }).strict()
])

export type SessionActivityUpdate = z.infer<typeof sessionActivityUpdateSchema>

type UnknownRecord = Record<string, unknown>

const PRIVATE_IDENTITY_KEYS = [
  'sessionId',
  'session_id',
  'taskId',
  'task_id',
  'parentTaskId',
  'parent_task_id',
  'subagentId',
  'subagent_id',
  'monitorId',
  'monitor_id',
  'toolCallId',
  'tool_call_id',
  'runId',
  'run_id',
  'workflowRunId',
  'workflow_run_id',
  'goalId',
  'goal_id',
  'id'
] as const

const PRIVATE_IDENTITY_RECORD_KEYS = [
  'task_snapshot',
  'taskSnapshot',
  'task',
  'scheduledTask',
  'subagent',
  'monitor',
  'workflow',
  'run',
  'goal',
  'toolCall',
  'tool_call'
] as const

/** Parse params or a full x.ai/_x.ai notification/session-update frame. */
export function parseSessionActivityUpdate(value: unknown): SessionActivityUpdate | undefined {
  const unwrapped = unwrap(value)
  if (!unwrapped) return undefined
  const { update, privateIdentities } = unwrapped
  const kind = canonical(firstString(read(update, 'sessionUpdate'), read(update, 'type'), read(update, 'kind')))

  switch (kind) {
    case 'scheduledtaskcreated':
      return parseTypedSchedule(update, false, privateIdentities)
    case 'scheduledtaskfired':
      return parseTypedSchedule(update, true, privateIdentities)
    case 'scheduledtaskdeleted': {
      const identity = privateIdentity(first(read(update, 'task_id'), read(update, 'taskId'), read(update, 'id')))
      return identity
        ? { type: 'activity_schedule_delete', source: 'typed', identity, ...schedulerClock(update) }
        : { type: 'activity_unknown' }
    }
    case 'taskbackgrounded':
      return parseBackground(update, 'command', 'running', privateIdentities)
    case 'taskcompleted':
      return parseBackground(
        update,
        'command',
        normalizeBackgroundStatus(read(update, 'status'), 'completed'),
        privateIdentities
      )
    case 'monitorevent':
      return parseBackground(update, 'monitor', 'running', privateIdentities)
    case 'subagentspawned':
    case 'subagentprogress':
      return parseBackground(update, 'subagent', 'running', privateIdentities)
    case 'subagentfinished':
      return parseBackground(
        update,
        'subagent',
        normalizeBackgroundStatus(read(update, 'status'), 'completed'),
        privateIdentities
      )
    case 'workflowupdated':
      return parseWorkflow(update, 'typed', privateIdentities)
    case 'goalupdated':
      return parseGoal(update, privateIdentities)
    case 'toolcall':
    case 'toolcallupdate':
      return parseLegacyTool(update, kind === 'toolcall', privateIdentities)
    default:
      return unwrapped.notification && looksLikeActivityKind(kind)
        ? { type: 'activity_unknown' }
        : undefined
  }
}

/** Explicit aliases make the intended AcpClient call sites unambiguous. */
export const sessionActivityUpdateFromSessionNotification = parseSessionActivityUpdate
export const sessionActivityUpdateFromSessionUpdate = parseSessionActivityUpdate

function parseTypedSchedule(
  update: UnknownRecord,
  fired: boolean,
  privateIdentities: readonly string[]
): SessionActivityUpdate {
  const task = nestedRecord(update, 'task_snapshot', 'taskSnapshot', 'task', 'schedule', 'scheduledTask')
  const identity = privateIdentity(first(
    read(update, 'task_id'), read(update, 'taskId'), read(update, 'id'),
    read(task, 'task_id'), read(task, 'taskId'), read(task, 'id')
  ))
  if (!identity) return { type: 'activity_unknown' }
  return {
    type: 'activity_schedule_upsert',
    source: 'typed',
    fired,
    ...schedulerClock(update),
    schedule: schedulePayload(update, task, identity, privateIdentities)
  }
}

function schedulePayload(
  primary: UnknownRecord,
  nested: UnknownRecord,
  identity: string,
  privateIdentities: readonly string[] = []
): z.infer<typeof schedulePayloadSchema> {
  const identities = mergePrivateIdentities(privateIdentities, [identity])
  const label = safeText(
    firstString(read(primary, 'prompt'), read(nested, 'prompt')),
    'Scheduled task',
    identities
  )
  const schedule = optionalText(firstString(
    read(primary, 'human_schedule'), read(primary, 'humanSchedule'), read(primary, 'interval_human'),
    read(primary, 'intervalHuman'), read(primary, 'interval'), read(nested, 'human_schedule'),
    read(nested, 'humanSchedule'), read(nested, 'interval')
  ), identities)
  const nextFireAt = normalizeDate(first(
    read(primary, 'next_fire_at'), read(primary, 'nextFireAt'),
    read(nested, 'next_fire_at'), read(nested, 'nextFireAt')
  ))
  return {
    identity,
    label,
    ...(schedule ? { schedule } : {}),
    ...(nextFireAt ? { nextFireAt } : {})
  }
}

function parseBackground(
  update: UnknownRecord,
  kind: 'command' | 'monitor' | 'subagent',
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown',
  privateIdentities: readonly string[]
): SessionActivityUpdate {
  const nested = nestedRecord(update, 'task_snapshot', 'taskSnapshot', 'task', 'subagent', 'monitor')
  const identity = privateIdentity(first(
    read(update, 'task_id'), read(update, 'taskId'), read(update, 'subagent_id'),
    read(update, 'subagentId'), read(update, 'monitor_id'), read(update, 'monitorId'),
    read(update, 'tool_call_id'), read(update, 'toolCallId'), read(update, 'id'),
    read(nested, 'task_id'), read(nested, 'taskId'), read(nested, 'subagent_id'),
    read(nested, 'subagentId'), read(nested, 'monitor_id'), read(nested, 'monitorId'), read(nested, 'id')
  ))
  if (!identity) return { type: 'activity_unknown' }
  const fallback = kind === 'command' ? 'Background command' : kind === 'monitor' ? 'Monitor' : 'Subagent'
  const identities = mergePrivateIdentities(privateIdentities, [identity])
  // Commands/output/event text are deliberately not copied. Only a bounded
  // descriptive label from known metadata is eligible for the public view.
  const label = safeText(firstString(
    read(update, 'monitor_description'), read(update, 'monitorDescription'),
    read(update, 'name'), read(update, 'role'), read(nested, 'name'), read(nested, 'role')
  ), fallback, identities)
  return { type: 'activity_background_update', identity, kind, label, status }
}

function parseWorkflow(
  update: UnknownRecord,
  source: 'typed' | 'legacy',
  privateIdentities: readonly string[]
): SessionActivityUpdate {
  const run = nestedRecord(update, 'workflow', 'run')
  const identity = privateIdentity(first(
    read(update, 'run_id'), read(update, 'runId'),
    read(run, 'run_id'), read(run, 'runId'),
    source === 'legacy' ? read(update, 'displayName') : undefined,
    source === 'legacy' ? read(update, 'display_name') : undefined,
    source === 'legacy' ? read(update, 'handle') : undefined,
    source === 'legacy' ? read(update, 'id') : undefined
  ))
  const revision = source === 'typed'
    ? normalizeRevision(first(read(update, 'revision'), read(run, 'revision')))
    : undefined
  if (!identity || (source === 'typed' && !revision)) return { type: 'activity_unknown' }
  const identities = mergePrivateIdentities(privateIdentities, [identity])
  const rawStatus = firstString(read(update, 'status'), read(update, 'state'), read(run, 'status'), read(run, 'state'))
  const status = normalizeWorkflowStatus(rawStatus)
  const name = safeText(firstString(
    read(update, 'name'), read(update, 'display_name'), read(update, 'displayName'),
    read(run, 'name'), read(run, 'display_name'), read(run, 'displayName')
  ), 'Workflow', identities)
  const objective = optionalText(
    firstString(read(update, 'objective'), read(run, 'objective')),
    identities
  )
  const phase = optionalText(firstString(
    read(update, 'current_phase'), read(update, 'currentPhase'), read(update, 'phase'),
    read(run, 'current_phase'), read(run, 'currentPhase'), read(run, 'phase')
  ), identities)
  const phases = firstArray(read(update, 'phases'), read(run, 'phases'))
  const workflow = {
    identity,
    ...(revision ? { revision } : {}),
    name,
    ...(objective ? { objective } : {}),
    status,
    ...(phase ? { phase } : {}),
    ...optionalCounter('phaseIndex', first(read(update, 'current_phase_index'), read(update, 'currentPhaseIndex'))),
    ...(phases ? { phaseCount: Math.min(phases.length, MAX_SESSION_ACTIVITY_COUNTER) } : {}),
    ...optionalCounter('agentBudget', first(read(update, 'agent_budget'), read(update, 'agentBudget'), read(run, 'agent_budget'))),
    ...optionalCounter('agentsUsed', first(read(update, 'agents_used'), read(update, 'agentsUsed'), read(run, 'agents_used'))),
    ...optionalCounter('agentsReserved', first(read(update, 'agents_reserved'), read(update, 'agentsReserved'), read(run, 'agents_reserved'))),
    ...optionalCounter('activeAgents', activeAgentCount(first(read(update, 'active_agents'), read(update, 'activeAgents'), read(run, 'active_agents')))),
    ...(typeof first(read(update, 'agent_usage_incomplete'), read(update, 'agentUsageIncomplete')) === 'boolean'
      ? { agentUsageIncomplete: first(read(update, 'agent_usage_incomplete'), read(update, 'agentUsageIncomplete')) as boolean }
      : {}),
    ...optionalCounter('elapsedMs', first(read(update, 'elapsed_ms'), read(update, 'elapsedMs'), read(run, 'elapsed_ms')))
  }
  const parsed = workflowPayloadSchema.safeParse(workflow)
  return parsed.success
    ? { type: 'activity_workflow_update', source, workflow: parsed.data }
    : { type: 'activity_unknown' }
}

function parseGoal(update: UnknownRecord, privateIdentities: readonly string[]): SessionActivityUpdate {
  const goal = nestedRecord(update, 'goal')
  const status = normalizeGoalStatus(firstString(
    read(update, 'status'), read(update, 'state'), read(goal, 'status'), read(goal, 'state')
  ))
  const identity = privateIdentity(first(
    read(update, 'goal_id'), read(update, 'goalId'), read(goal, 'goal_id'), read(goal, 'goalId')
  ))
  if (status !== 'cleared' && !identity) return { type: 'activity_unknown' }
  const identities = mergePrivateIdentities(privateIdentities, identity ? [identity] : [])
  const objective = safeText(
    firstString(read(update, 'objective'), read(goal, 'objective')),
    'Goal',
    identities
  )
  const phase = optionalText(firstString(read(update, 'phase'), read(goal, 'phase')), identities)
  const payload = {
    ...(identity ? { identity } : {}),
    objective,
    status,
    ...(phase ? { phase } : {}),
    ...optionalCounter('tokenBudget', first(read(update, 'token_budget'), read(update, 'tokenBudget'))),
    ...optionalCounter('tokensUsed', first(read(update, 'tokens_used'), read(update, 'tokensUsed'))),
    ...optionalCounter('elapsedMs', first(read(update, 'elapsed_ms'), read(update, 'elapsedMs'))),
    ...optionalCounter('totalDeliverables', first(read(update, 'total_deliverables'), read(update, 'totalDeliverables'))),
    ...optionalCounter('completedDeliverables', first(read(update, 'completed_deliverables'), read(update, 'completedDeliverables'))),
    ...optionalCounter('workerRounds', first(read(update, 'total_worker_rounds'), read(update, 'totalWorkerRounds'))),
    ...optionalCounter('verifyRounds', first(read(update, 'total_verify_rounds'), read(update, 'totalVerifyRounds'))),
    ...optionalCounter('activeAgents', activeAgentCount(first(read(update, 'active_agents'), read(update, 'activeAgents'))))
  }
  const parsed = goalPayloadSchema.safeParse(payload)
  return parsed.success ? { type: 'activity_goal_update', goal: parsed.data } : { type: 'activity_unknown' }
}

function parseLegacyTool(
  update: UnknownRecord,
  isStart: boolean,
  privateIdentities: readonly string[]
): SessionActivityUpdate | undefined {
  const tool = nestedRecord(update, 'toolCall', 'tool_call')
  const callIdentity = privateIdentity(first(
    read(update, 'toolCallId'), read(update, 'tool_call_id'),
    read(tool, 'toolCallId'), read(tool, 'tool_call_id'), read(tool, 'id')
  ))
  const input = boundedJsonRecord(first(
    read(update, 'rawInput'), read(update, 'raw_input'), read(update, 'rawinput'),
    read(tool, 'rawInput'), read(tool, 'raw_input')
  ))
  const output = boundedJsonRecord(first(
    read(update, 'rawOutput'), read(update, 'raw_output'), read(update, 'rawoutput'),
    read(tool, 'rawOutput'), read(tool, 'raw_output')
  ))
  const meta = record(first(read(update, '_meta'), read(tool, '_meta')))
  const toolMeta = record(read(meta, 'x.ai/tool'))
  const rawName = firstString(read(toolMeta, 'name'), read(tool, 'name'), read(update, 'name'), read(output, 'type'))
  const operation = legacySchedulerOperation(rawName, read(output, 'type'))
  if (!operation) return undefined
  if (!callIdentity) return { type: 'activity_unknown' }
  const callIdentities = mergePrivateIdentities(
    mergePrivateIdentities(privateIdentities, collectPrivateIdentities(tool, input, output)),
    [callIdentity]
  )
  const hasInput = Object.keys(input).length > 0
  const hasOutput = Object.keys(output).length > 0

  if (isStart || (!hasOutput && hasInput)) {
    const targetIdentity = privateIdentity(first(read(input, 'id'), read(input, 'task_id'), read(input, 'taskId')))
    const identities = mergePrivateIdentities(callIdentities, targetIdentity ? [targetIdentity] : [])
    const label = optionalText(firstString(read(input, 'prompt')), identities)
    const schedule = optionalText(firstString(read(input, 'interval')), identities)
    return {
      type: 'activity_legacy_scheduler_input',
      callIdentity,
      operation,
      ...(targetIdentity ? { targetIdentity } : {}),
      ...(label ? { label } : {}),
      ...(schedule ? { schedule } : {})
    }
  }
  if (!hasOutput) return { type: 'activity_unknown' }
  if (operation === 'list') {
    const rawTasks = read(output, 'tasks')
    if (!Array.isArray(rawTasks)) {
      return { type: 'activity_unknown' }
    }
    const schedules: z.infer<typeof schedulePayloadSchema>[] = []
    let overflowed = rawTasks.length > MAX_SESSION_ACTIVITY_ITEMS
    for (const rawTask of rawTasks.slice(0, MAX_SESSION_ACTIVITY_ITEMS)) {
      const task = record(rawTask)
      const identity = privateIdentity(first(read(task, 'id'), read(task, 'task_id'), read(task, 'taskId')))
      if (!identity) {
        // The list still proves that scheduled work may exist. Keep the public
        // projection bounded while preserving fail-closed process protection.
        overflowed = true
        continue
      }
      schedules.push(schedulePayload(task, {}, identity, callIdentities))
    }
    return {
      type: 'activity_schedule_replace',
      source: 'legacy',
      callIdentity,
      overflowed,
      schedules
    }
  }
  const identity = privateIdentity(first(read(output, 'id'), read(output, 'task_id'), read(output, 'taskId')))
  if (operation === 'delete') {
    return identity
      ? { type: 'activity_schedule_delete', source: 'legacy', callIdentity, identity }
      : { type: 'activity_legacy_scheduler_input', callIdentity, operation }
  }
  if (!identity) return { type: 'activity_unknown' }
  const schedule = schedulePayload(output, {}, identity, callIdentities)
  return { type: 'activity_schedule_upsert', source: 'legacy', fired: false, callIdentity, schedule }
}

function unwrap(value: unknown): {
  update: UnknownRecord
  notification: boolean
  privateIdentities: string[]
} | undefined {
  const root = record(value)
  let method = firstString(read(root, 'method'))
  let subject: unknown = method ? read(root, 'params') : value
  const outerParams = record(subject)
  const nestedMethod = firstString(read(outerParams, 'method'))
  if (nestedMethod && read(outerParams, 'params') !== undefined) {
    method = nestedMethod
    subject = read(outerParams, 'params')
  }
  const normalizedMethod = method?.replace(/^_/u, '')
  if (normalizedMethod && ![
    'x.ai/session_notification',
    'session/update',
    'x.ai/session/update'
  ].includes(normalizedMethod)) return undefined
  const envelope = record(subject)
  const update = record(first(read(envelope, 'update'), subject))
  if (Object.keys(update).length === 0) return undefined
  return {
    update,
    notification: normalizedMethod === 'x.ai/session_notification',
    privateIdentities: collectPrivateIdentities(envelope, update)
  }
}

function legacySchedulerOperation(...values: unknown[]): 'create' | 'list' | 'delete' | undefined {
  for (const value of values) {
    const name = canonical(typeof value === 'string' ? value : undefined)
    if (name === 'schedulercreate') return 'create'
    if (name === 'schedulerlist') return 'list'
    if (name === 'schedulerdelete') return 'delete'
  }
  return undefined
}

function normalizeWorkflowStatus(value: string | undefined): z.infer<typeof workflowPayloadSchema>['status'] {
  switch (canonical(value)) {
    case 'active':
    case 'running': return 'active'
    case 'paused':
    case 'userpaused':
    case 'noprogresspaused': return 'paused'
    case 'budgetlimited': return 'budget_limited'
    case 'complete':
    case 'completed':
    case 'finished': return 'completed'
    case 'cancelled':
    case 'canceled':
    case 'stopped': return 'cancelled'
    case 'failed':
    case 'error': return 'failed'
    case 'interrupted': return 'interrupted'
    case 'cleared': return 'cleared'
    default: return 'unknown'
  }
}

function normalizeGoalStatus(value: string | undefined): z.infer<typeof goalPayloadSchema>['status'] {
  switch (canonical(value)) {
    case 'active':
    case 'running': return 'active'
    case 'paused':
    case 'userpaused': return 'paused'
    case 'complete':
    case 'completed':
    case 'finished': return 'completed'
    case 'cancelled':
    case 'canceled':
    case 'stopped': return 'cancelled'
    case 'failed':
    case 'error': return 'failed'
    case 'cleared': return 'cleared'
    default: return 'unknown'
  }
}

function normalizeBackgroundStatus(
  value: unknown,
  fallback: 'running' | 'completed'
): 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' {
  switch (canonical(typeof value === 'string' ? value : undefined)) {
    case 'running':
    case 'active': return 'running'
    case 'complete':
    case 'completed':
    case 'success': return 'completed'
    case 'failed':
    case 'error': return 'failed'
    case 'cancelled':
    case 'canceled':
    case 'killed': return 'cancelled'
    default: return fallback
  }
}

function safeText(value: string | undefined, fallback: string, identities: readonly string[]): string {
  let text = value ?? fallback
  for (const identity of identities) text = text.split(identity).join('[ID REDACTED]')
  return sanitizeDisplayTitle(text, MAX_SESSION_ACTIVITY_TEXT_CHARS) || fallback
}

function collectPrivateIdentities(...sources: UnknownRecord[]): string[] {
  const identities: string[] = []
  const visit = (source: UnknownRecord): void => {
    for (const key of PRIVATE_IDENTITY_KEYS) {
      const identity = privateIdentity(read(source, key))
      if (identity && !identities.includes(identity)) identities.push(identity)
      if (identities.length >= 32) return
    }
  }
  for (const source of sources) {
    visit(source)
    if (identities.length >= 32) break
    for (const key of PRIVATE_IDENTITY_RECORD_KEYS) {
      visit(record(read(source, key)))
      if (identities.length >= 32) break
    }
    if (identities.length >= 32) break
  }
  return identities
}

function mergePrivateIdentities(
  current: readonly string[],
  additions: readonly string[]
): string[] {
  const identities = [...current]
  for (const identity of additions) {
    if (!identities.includes(identity)) identities.push(identity)
    if (identities.length >= 32) break
  }
  return identities
}

function optionalText(value: string | undefined, identities: readonly string[]): string | undefined {
  if (!value) return undefined
  const text = safeText(value, '', identities)
  return text || undefined
}

function normalizeRevision(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value !== 'string' || !/^\d{1,20}$/u.test(value)) return undefined
  try {
    return BigInt(value) <= 18_446_744_073_709_551_615n ? BigInt(value).toString() : undefined
  } catch {
    return undefined
  }
}

function schedulerClock(update: UnknownRecord): { generation?: string; revision?: string } {
  const meta = record(read(update, '_meta'))
  const generation = normalizeRevision(first(
    read(update, 'scheduler_generation'), read(update, 'schedulerGeneration'),
    read(meta, 'x.ai/schedulerGeneration')
  ))
  const revision = normalizeRevision(first(
    read(update, 'scheduler_revision'), read(update, 'schedulerRevision'),
    read(meta, 'x.ai/schedulerRevision')
  ))
  return {
    ...(generation ? { generation } : {}),
    ...(revision ? { revision } : {})
  }
}

function looksLikeActivityKind(kind: string): boolean {
  return kind.startsWith('activity') || kind.startsWith('scheduledtask') ||
    kind.startsWith('workflow') || kind.startsWith('goal') ||
    kind.startsWith('subagent') || kind.startsWith('monitor') ||
    kind.startsWith('taskbackground') || kind.startsWith('taskcomplete')
}

function normalizeDate(value: unknown): string | undefined {
  const date = typeof value === 'string'
    ? new Date(value)
    : typeof value === 'number' && Number.isFinite(value)
      ? new Date(value < 10_000_000_000 ? value * 1_000 : value)
      : undefined
  if (!date || Number.isNaN(date.getTime())) return undefined
  try {
    return date.toISOString()
  } catch {
    return undefined
  }
}

function activeAgentCount(value: unknown): unknown {
  return Array.isArray(value) ? Math.min(value.length, MAX_SESSION_ACTIVITY_COUNTER) : value
}

function optionalCounter<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
  const count = boundedCounter(value)
  return count === undefined ? {} : { [key]: count } as Record<K, number>
}

function boundedCounter(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.min(MAX_SESSION_ACTIVITY_COUNTER, Math.trunc(value))
  }
  if (typeof value === 'string' && /^\d{1,10}$/u.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? Math.min(MAX_SESSION_ACTIVITY_COUNTER, parsed) : undefined
  }
  return undefined
}

function boundedJsonRecord(value: unknown): UnknownRecord {
  if (typeof value !== 'string') return record(value)
  if (value.length > 64 * 1024 || !/^\s*\{/u.test(value)) return {}
  try {
    return record(JSON.parse(value))
  } catch {
    return {}
  }
}

function privateIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return undefined
  if (/[\u0000-\u001f\u007f]/u.test(value)) return undefined
  return value
}

function canonical(value: string | undefined): string {
  return value?.toLocaleLowerCase('en-US').replace(/[_-]/gu, '') ?? ''
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function nestedRecord(source: UnknownRecord, ...keys: string[]): UnknownRecord {
  for (const key of keys) {
    const candidate = record(read(source, key))
    if (Object.keys(candidate).length > 0) return candidate
  }
  return {}
}

function read(source: UnknownRecord, key: string): unknown {
  try {
    return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined
  } catch {
    return undefined
  }
}

function first(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null)
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  return values.find((value): value is unknown[] => Array.isArray(value))
}
