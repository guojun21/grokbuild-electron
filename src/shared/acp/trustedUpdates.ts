import { z } from 'zod'
import {
  parseContextUsageFromSessionUpdate,
  parseTurnTokenUsage,
  parseTurnTokenUsageFromSessionUpdate,
  tokenCountSchema,
  turnTokenUsageSchema
} from './usage'
import {
  MAX_ACTIVITY_COUNT,
  hookExecutionEventSchema,
  normalizeHookKind,
  type HookExecutionEvent
} from './activity'
import {
  sessionActivityUpdateFromSessionNotification,
  sessionActivityUpdateFromSessionUpdate,
  sessionActivityUpdateSchema,
  type SessionActivityUpdate
} from './sessionActivityUpdates'

export const acpTurnUsageEventSchema = z.object({
  type: z.literal('turn_usage'),
  usage: turnTokenUsageSchema
}).strict()

export const acpContextUsageEventSchema = z.object({
  type: z.literal('context_usage'),
  used: tokenCountSchema,
  limit: tokenCountSchema.optional()
}).strict()

export const acpModeChangedEventSchema = z.object({
  type: z.literal('mode_changed'),
  mode: z.enum(['default', 'plan', 'ask', 'yolo']),
  permissionMode: z.enum(['auto']).optional()
}).strict()

/**
 * Events allowed to cross the utility-process boundary without their wire
 * envelope. Every member is a strict, small semantic projection.
 */
export const baseTrustedAcpUpdateSchema = z.discriminatedUnion('type', [
  acpTurnUsageEventSchema,
  acpContextUsageEventSchema,
  acpModeChangedEventSchema,
  hookExecutionEventSchema
])

export const trustedAcpUpdateSchema = z.union([
  baseTrustedAcpUpdateSchema,
  sessionActivityUpdateSchema
])

export type TrustedAcpUpdate = z.infer<typeof trustedAcpUpdateSchema>

type UnknownRecord = Record<string, unknown>

/** Swift order: context gauge first, then per-turn buckets, then routed update. */
export function trustedUpdatesFromSessionUpdate(value: unknown): TrustedAcpUpdate[] {
  const events: TrustedAcpUpdate[] = []
  const context = parseContextUsageFromSessionUpdate(value)
  if (context) events.push({ type: 'context_usage', ...context })
  const usage = parseTurnTokenUsageFromSessionUpdate(value)
  if (usage) events.push({ type: 'turn_usage', usage })
  const mode = parseModeChanged(value)
  if (mode) events.push(mode)
  const hook = parseHookExecution(value)
  if (hook) events.push(hook)
  const activity = sessionActivityUpdateFromSessionUpdate(value)
  if (activity && !shouldSuppressReplayedLegacyActivity(value, activity)) {
    events.push(activity)
  }
  return events
}

/** A session/prompt result can update last-turn buckets, never the context gauge. */
export function trustedUpdatesFromPromptResult(value: unknown): TrustedAcpUpdate[] {
  const usage = parseTurnTokenUsage(value)
  return usage ? [{ type: 'turn_usage', usage }] : []
}

/** xAI notifications carry turn usage and may authoritatively confirm a mode. */
export function trustedUpdatesFromSessionNotification(value: unknown): TrustedAcpUpdate[] {
  const events: TrustedAcpUpdate[] = []
  const usage = parseTurnTokenUsageFromSessionUpdate(value)
  if (usage) events.push({ type: 'turn_usage', usage })
  const mode = parseModeChanged(value)
  if (mode) events.push(mode)
  const hook = parseHookExecution(value)
  if (hook) events.push(hook)
  const activity = sessionActivityUpdateFromSessionNotification(value) ??
    sessionActivityUpdateFromSessionNotification({
      method: 'x.ai/session_notification',
      params: value
    })
  if (activity && !shouldSuppressReplayedLegacyActivity(value, activity)) {
    events.push(activity)
  }
  return events
}

/**
 * These wire updates are fully represented by TrustedAcpUpdate and therefore
 * need not cross the worker boundary as an untyped payload as well.
 */
export function isTrustedOnlySessionUpdate(value: unknown): boolean {
  const envelope = record(value)
  const update = record(envelope.update ?? envelope)
  const kind = canonical(firstString(update.sessionUpdate, update.type, update.kind))
  return kind === 'usageupdate' || kind === 'usage' ||
    kind === 'currentmodeupdate' || kind === 'hookexecution' ||
    TRUSTED_ONLY_ACTIVITY_KINDS.has(kind)
}

/**
 * Project one hook update to a fixed event kind plus a bounded run count. The
 * contents of `runs` (commands, paths, env, output, tokens) are never copied.
 */
export function parseHookExecution(value: unknown): HookExecutionEvent | undefined {
  const envelope = record(value)
  const update = record(envelope.update ?? envelope)
  const kind = firstString(update.sessionUpdate, update.type, update.kind)
  if (kind !== 'hook_execution') return undefined
  const rawRuns = update.runs
  const runCount = Array.isArray(rawRuns)
    ? Math.min(MAX_ACTIVITY_COUNT, rawRuns.length)
    : 0
  return {
    type: 'hook_execution',
    hook: normalizeHookKind(firstString(update.event_name, update.eventName)),
    runCount
  }
}

function parseModeChanged(value: unknown): z.infer<typeof acpModeChangedEventSchema> | undefined {
  const envelope = record(value)
  const update = record(envelope.update ?? envelope)
  const kind = firstString(update.sessionUpdate, update.type, update.kind)
  if (kind !== 'current_mode_update') return undefined
  const rawMode = firstString(update.currentModeId, update.modeId, update.mode)
  if (rawMode === 'yolo' || rawMode === 'auto') {
    return { type: 'mode_changed', mode: 'default', permissionMode: 'auto' }
  }
  if (rawMode === 'agent' || rawMode === 'default') {
    return { type: 'mode_changed', mode: 'default' }
  }
  if (rawMode === 'plan' || rawMode === 'ask') {
    return { type: 'mode_changed', mode: rawMode }
  }
  return undefined
}

const TRUSTED_ONLY_ACTIVITY_KINDS = new Set([
  'scheduledtaskcreated',
  'scheduledtaskfired',
  'scheduledtaskdeleted',
  'taskbackgrounded',
  'taskcompleted',
  'monitorevent',
  'subagentspawned',
  'subagentprogress',
  'subagentfinished',
  'workflowupdated',
  'goalupdated'
])

function shouldSuppressReplayedLegacyActivity(
  value: unknown,
  activity: SessionActivityUpdate
): boolean {
  if (!isReplay(value)) return false
  if ('source' in activity && activity.source === 'legacy') return true
  if (activity.type === 'activity_legacy_scheduler_input') return true
  if (activity.type !== 'activity_unknown') return false
  const envelope = record(value)
  const update = record(envelope.update ?? envelope)
  const kind = canonical(firstString(update.sessionUpdate, update.type, update.kind))
  return kind === 'toolcall' || kind === 'toolcallupdate'
}

function isReplay(value: unknown): boolean {
  const envelope = record(value)
  const update = record(envelope.update ?? envelope)
  return record(envelope._meta).isReplay === true || record(update._meta).isReplay === true
}

function canonical(value: string | undefined): string {
  return value?.toLocaleLowerCase('en-US').replace(/[_-]/gu, '') ?? ''
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string')
}
