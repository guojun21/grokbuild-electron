import {
  sanitizeDisplayText,
  sanitizeDisplayTitle,
  sanitizeJsonValue,
  stringifySanitizedJson
} from '../security/redaction'
import { classifyToolActivity, type ActivityKind, type HookExecutionEvent } from './activity'
import { baseTrustedAcpUpdateSchema, parseHookExecution } from './trustedUpdates'
import { parseContextUsageFromSessionUpdate, type TurnTokenUsage } from './usage'

export type NormalizedAcpEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | { type: 'tool_start'; id: string; title: string; detail?: string; activityKind?: ActivityKind }
  | { type: 'tool_update'; id: string; status: 'pending' | 'running' | 'completed' | 'failed'; detail?: string; title?: string; activityKind?: ActivityKind }
  | { type: 'plan'; entries: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }> }
  | { type: 'context_usage'; used: number; limit?: number | undefined }
  | { type: 'turn_usage'; usage: TurnTokenUsage }
  | { type: 'mode_changed'; mode: 'default' | 'plan' | 'ask' | 'yolo'; permissionMode?: 'ask' | 'auto' | undefined }
  | HookExecutionEvent
  | { type: 'turn_complete' }
  | { type: 'unknown'; name: string; payload: unknown }

type UnknownRecord = Record<string, unknown>

const maxDeltaChars = 512 * 1024
const maxDetailChars = 256 * 1024
const maxTitleChars = 2_000
const maxPlanEntries = 200
const maxPlanEntryChars = 20_000
const maxSafeToolFields = 32
const safeToolTextKeys = new Set(['text', 'message', 'summary', 'description', 'status', 'name', 'title'])
const safeToolScalarKeys = new Set(['count', 'total', 'success', 'exitCode', 'durationMs'])

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {}
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string')
}

function normalizeStatus(value: unknown): 'pending' | 'running' | 'completed' | 'failed' {
  if (value === 'completed' || value === 'success' || value === 'done') return 'completed'
  if (value === 'failed' || value === 'error' || value === 'cancelled') return 'failed'
  if (value === 'running' || value === 'in_progress') return 'running'
  return 'pending'
}

function normalizePlanStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
  if (value === 'completed' || value === 'success' || value === 'done') return 'completed'
  if (value === 'running' || value === 'in_progress') return 'in_progress'
  return 'pending'
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const object = record(value)
  return firstString(object.text, object.content, record(object.content).text)
}

function displayDetailFrom(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const detail = sanitizeDisplayText(value, maxDetailChars).trim()
  return detail || undefined
}

function rawToolDetailFrom(value: unknown, direction: 'input' | 'output'): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const parsed = parseBoundedJson(value)
    if (parsed !== undefined) return structuredToolDetail(parsed, direction)
    const detail = sanitizeDisplayText(value, maxDetailChars).trim()
    return detail || undefined
  }
  return structuredToolDetail(value, direction)
}

function structuredToolDetail(value: unknown, direction: 'input' | 'output'): string {
  if (Array.isArray(value)) {
    return `Tool ${direction} received (${Math.min(value.length, 10_000)} items).`
  }
  if (value === null || typeof value !== 'object') {
    return `Tool ${direction} received.`
  }
  const projected: Record<string, string | number | boolean> = {}
  let keyCount = 0
  try {
    const keys = Object.keys(value)
    keyCount = Math.min(keys.length, 10_000)
    for (const key of keys.slice(0, maxSafeToolFields)) {
      const candidate = (value as Record<string, unknown>)[key]
      if (safeToolTextKeys.has(key) && typeof candidate === 'string') {
        projected[key] = sanitizeDisplayText(candidate, 32 * 1024)
      } else if (
        safeToolScalarKeys.has(key) &&
        (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean')
      ) {
        projected[key] = typeof candidate === 'string'
          ? sanitizeDisplayText(candidate, 2_000)
          : candidate
      }
    }
  } catch {
    return `Tool ${direction} received.`
  }
  if (Object.keys(projected).length === 0) {
    return `Tool ${direction} received (${keyCount} fields).`
  }
  return stringifySanitizedJson(projected, {
    maxDepth: 2,
    maxKeys: maxSafeToolFields,
    maxArrayItems: 1,
    maxStringChars: 32 * 1024,
    maxOutputChars: maxDetailChars
  })
}

function parseBoundedJson(value: string): unknown | undefined {
  const trimmed = value.trim()
  if (
    trimmed.length === 0 || trimmed.length > maxDetailChars ||
    (!trimmed.startsWith('{') && !trimmed.startsWith('['))
  ) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function safeToolIdentifier(value: string): string {
  return sanitizeDisplayTitle(value, 256) || 'unknown-tool'
}

export function normalizeSessionUpdate(params: unknown): NormalizedAcpEvent {
  const envelope = record(params)
  const update = record(envelope.update ?? envelope)
  const name = firstString(update.sessionUpdate, update.type, update.kind) ?? 'unknown'

  switch (name) {
    case 'agent_message_chunk':
    case 'assistant_message_chunk':
      return {
        type: 'assistant_delta',
        text: (textFromContent(update.content ?? update.delta ?? update.text) ?? '').slice(0, maxDeltaChars)
      }
    case 'agent_thought_chunk':
    case 'thought_chunk':
      return {
        type: 'thought_delta',
        text: (textFromContent(update.content ?? update.delta ?? update.text) ?? '').slice(0, maxDeltaChars)
      }
    case 'tool_call': {
      const tool = record(update.toolCall ?? update.tool_call ?? update)
      const detail = tool.rawInput !== undefined
        ? rawToolDetailFrom(tool.rawInput, 'input')
        : displayDetailFrom(tool.detail ?? tool.description)
      const rawTitle = firstString(tool.title, tool.name, update.title) ?? 'Tool activity'
      const title = sanitizeDisplayTitle(rawTitle, maxTitleChars) || 'Tool activity'
      const activityKind = classifyToolActivity(title)
      return {
        type: 'tool_start',
        id: safeToolIdentifier(firstString(tool.toolCallId, tool.id, update.toolCallId) ?? 'unknown-tool'),
        title,
        ...(detail ? { detail } : {}),
        ...(activityKind ? { activityKind } : {})
      }
    }
    case 'tool_call_update': {
      const tool = record(update.toolCall ?? update.tool_call ?? update)
      const detail = tool.rawOutput !== undefined
        ? rawToolDetailFrom(tool.rawOutput, 'output')
        : displayDetailFrom(tool.detail ?? tool.content ?? update.content)
      const rawTitle = firstString(tool.title, tool.name, update.title)
      const title = rawTitle
        ? sanitizeDisplayTitle(rawTitle, maxTitleChars) || undefined
        : undefined
      const activityKind = title ? classifyToolActivity(title) : undefined
      return {
        type: 'tool_update',
        id: safeToolIdentifier(firstString(tool.toolCallId, tool.id, update.toolCallId) ?? 'unknown-tool'),
        status: normalizeStatus(tool.status ?? update.status),
        ...(detail ? { detail } : {}),
        ...(title ? { title } : {}),
        ...(activityKind ? { activityKind } : {})
      }
    }
    case 'plan': {
      const rawEntries = Array.isArray(update.entries)
        ? update.entries
        : Array.isArray(record(update.plan).entries)
          ? (record(update.plan).entries as unknown[])
          : []
      return {
        type: 'plan',
        entries: rawEntries.slice(0, maxPlanEntries).map((entry) => {
          const item = record(entry)
          return {
            text: (firstString(item.content, item.text, item.title) ?? 'Untitled step').slice(0, maxPlanEntryChars),
            status: normalizePlanStatus(item.status)
          }
        })
      }
    }
    case 'usage_update':
    case 'usage': {
      const usage = parseContextUsageFromSessionUpdate(params)
      return usage
        ? { type: 'context_usage', ...usage }
        : { type: 'unknown', name, payload: {} }
    }
    case 'context_usage':
    case 'turn_usage':
    case 'mode_changed': {
      const trusted = baseTrustedAcpUpdateSchema.safeParse(update)
      return trusted.success
        ? trusted.data
        : { type: 'unknown', name, payload: {} }
    }
    case 'hook_execution': {
      const trusted = baseTrustedAcpUpdateSchema.safeParse(update)
      if (trusted.success && trusted.data.type === 'hook_execution') return trusted.data
      return parseHookExecution(params) ?? { type: 'hook_execution', hook: 'other', runCount: 0 }
    }
    case 'current_mode_update': {
      const rawMode = firstString(update.currentModeId, update.modeId, update.mode)
      if (rawMode === 'yolo' || rawMode === 'auto') {
        return { type: 'mode_changed', mode: 'yolo', permissionMode: 'auto' }
      }
      const mode = rawMode === 'agent' ? 'default' : rawMode
      return mode === 'default' || mode === 'plan' || mode === 'ask'
        ? { type: 'mode_changed', mode }
        : {
            type: 'unknown',
            name: 'current_mode_update',
            payload: sanitizeJsonValue(update, {
              maxDepth: 2,
              maxKeys: 16,
              maxArrayItems: 4,
              maxStringChars: 256,
              maxOutputChars: 2_000
            })
          }
    }
    case 'turn_complete':
    case 'turn_end':
      return { type: 'turn_complete' }
    default:
      return {
        type: 'unknown',
        name: sanitizeDisplayTitle(name, 256) || 'unknown',
        payload: sanitizeJsonValue(update, {
          maxDepth: 4,
          maxKeys: 64,
          maxArrayItems: 64,
          maxStringChars: 16 * 1024,
          maxOutputChars: 64 * 1024
        })
      }
  }
}
