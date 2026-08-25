import { z } from 'zod'

/**
 * Hard public bounds for the Tasks / Workflows projection.
 *
 * The CLI remains the source of truth. These limits only bound the semantic
 * view that may eventually cross an IPC boundary; they are not CLI limits.
 */
export const MAX_SESSION_ACTIVITY_ITEMS = 128
export const MAX_SESSION_ACTIVITY_UNKNOWN_EVENTS = 10_000
export const MAX_SESSION_ACTIVITY_TEXT_CHARS = 512
export const MAX_SESSION_ACTIVITY_COUNTER = 1_000_000_000

export const sessionActivitySyncStateSchema = z.enum([
  'unseen',
  'replaying',
  'live',
  'offline'
])

export type SessionActivitySyncState = z.infer<typeof sessionActivitySyncStateSchema>

const viewKeySchema = z.string().regex(/^(schedule|background|workflow)-[1-9]\d{0,9}$/u)
const publicTextSchema = z.string().max(MAX_SESSION_ACTIVITY_TEXT_CHARS)
const publicCounterSchema = z.number().int().nonnegative().max(MAX_SESSION_ACTIVITY_COUNTER)

export const scheduledActivitySchema = z.object({
  viewKey: viewKeySchema,
  label: publicTextSchema,
  status: z.enum(['scheduled', 'fired']),
  schedule: publicTextSchema.optional(),
  nextFireAt: z.string().max(64).optional(),
  fireCount: publicCounterSchema
}).strict()

export type ScheduledActivity = z.infer<typeof scheduledActivitySchema>

export const backgroundActivitySchema = z.object({
  viewKey: viewKeySchema,
  kind: z.enum(['command', 'monitor', 'subagent']),
  label: publicTextSchema,
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'unknown']),
  updateCount: publicCounterSchema
}).strict()

export type BackgroundActivity = z.infer<typeof backgroundActivitySchema>

export const workflowActivitySchema = z.object({
  viewKey: viewKeySchema,
  name: publicTextSchema,
  objective: publicTextSchema.optional(),
  status: z.enum([
    'active',
    'paused',
    'budget_limited',
    'completed',
    'cancelled',
    'failed',
    'interrupted',
    'unknown'
  ]),
  phase: publicTextSchema.optional(),
  phaseIndex: publicCounterSchema.optional(),
  phaseCount: publicCounterSchema.optional(),
  agentBudget: publicCounterSchema.optional(),
  agentsUsed: publicCounterSchema.optional(),
  agentsReserved: publicCounterSchema.optional(),
  activeAgents: publicCounterSchema.optional(),
  agentUsageIncomplete: z.boolean().optional(),
  elapsedMs: publicCounterSchema.optional()
}).strict()

export type WorkflowActivity = z.infer<typeof workflowActivitySchema>

export const goalActivitySchema = z.object({
  objective: publicTextSchema,
  status: z.enum(['active', 'paused', 'completed', 'cancelled', 'failed', 'unknown']),
  phase: publicTextSchema.optional(),
  tokenBudget: publicCounterSchema.optional(),
  tokensUsed: publicCounterSchema.optional(),
  elapsedMs: publicCounterSchema.optional(),
  totalDeliverables: publicCounterSchema.optional(),
  completedDeliverables: publicCounterSchema.optional(),
  workerRounds: publicCounterSchema.optional(),
  verifyRounds: publicCounterSchema.optional(),
  activeAgents: publicCounterSchema.optional()
}).strict()

export type GoalActivity = z.infer<typeof goalActivitySchema>

/**
 * Renderer-safe view. In particular, it has no CLI session/task/run/goal ids,
 * paths, raw input/output, commands, environment values, or arbitrary keys.
 */
export const sessionActivitySnapshotSchema = z.object({
  version: z.literal(1),
  syncState: sessionActivitySyncStateSchema,
  unknownEventCount: z.number().int().nonnegative().max(MAX_SESSION_ACTIVITY_UNKNOWN_EVENTS),
  schedules: z.array(scheduledActivitySchema).max(MAX_SESSION_ACTIVITY_ITEMS),
  background: z.array(backgroundActivitySchema).max(MAX_SESSION_ACTIVITY_ITEMS),
  workflows: z.array(workflowActivitySchema).max(MAX_SESSION_ACTIVITY_ITEMS),
  goal: goalActivitySchema.nullable()
}).strict()

export type SessionActivitySnapshot = z.infer<typeof sessionActivitySnapshotSchema>
