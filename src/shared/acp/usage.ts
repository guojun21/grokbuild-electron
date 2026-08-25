import { z } from 'zod'

/**
 * A deliberately high, finite ceiling for one reported token counter.
 *
 * Grok's current context windows are several orders of magnitude smaller. The
 * ceiling keeps hostile numeric strings, infinities, and unsafe integers out of
 * the persisted renderer state without clipping a plausible future model.
 */
export const MAX_TOKEN_COUNT = 1_000_000_000

export const tokenCountSchema = z.number().int().nonnegative().max(MAX_TOKEN_COUNT)

export const turnTokenUsageSchema = z.object({
  inputTokens: tokenCountSchema.optional(),
  outputTokens: tokenCountSchema.optional(),
  cachedReadTokens: tokenCountSchema.optional(),
  reasoningTokens: tokenCountSchema.optional(),
  totalTokens: tokenCountSchema.optional()
}).strict().refine(
  (usage) =>
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.cachedReadTokens !== undefined ||
    usage.reasoningTokens !== undefined,
  { message: 'A turn usage report must contain at least one usage bucket' }
)

export type TurnTokenUsage = z.infer<typeof turnTokenUsageSchema>

type UnknownRecord = Record<string, unknown>

const cachedKeys = [
  'cachedReadTokens',
  'cached_read_tokens',
  'cacheReadTokens',
  'cacheReadInputTokens',
  'cache_read_input_tokens',
  'cached_tokens'
] as const

/**
 * Port of the pinned Swift TurnTokenUsageParser dialect and precedence.
 *
 * Only the five bounded counters are returned. Session ids, model metadata,
 * provider payloads, and any sibling wire values are intentionally discarded.
 */
export function parseTurnTokenUsage(value: unknown): TurnTokenUsage | undefined {
  return parseTurnTokenUsageAtDepth(value, 0, new WeakSet<object>())
}

/** Parse the params of session/update or x.ai/session_notification. */
export function parseTurnTokenUsageFromSessionUpdate(
  value: unknown
): TurnTokenUsage | undefined {
  const params = record(value)
  return parseTurnTokenUsage(params) ?? parseTurnTokenUsage(params.update)
}

/**
 * Context-window usage is separate from the last-turn buckets. This mirrors
 * Swift's `_meta.totalTokens` handling and retains the Electron mock's explicit
 * `usage_update { used, limit }` compatibility shape.
 */
export function parseContextUsageFromSessionUpdate(
  value: unknown
): { used: number; limit?: number } | undefined {
  const params = record(value)
  const update = record(params.update ?? params)
  const kind = firstString(update.sessionUpdate, update.type, update.kind)
  const usage = record(update.usage ?? update)
  const explicitUsed = kind === 'usage_update' || kind === 'usage'
    ? strictTokenCount(usage.used)
    : undefined
  const explicitLimit = kind === 'usage_update' || kind === 'usage'
    ? strictTokenCount(usage.limit)
    : undefined
  const metaTotal = contextTotal(params)
  const used = metaTotal ?? explicitUsed
  if (used === undefined) return undefined
  return {
    used,
    ...(explicitLimit !== undefined ? { limit: explicitLimit } : {})
  }
}

function parseTurnTokenUsageAtDepth(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): TurnTokenUsage | undefined {
  if (depth > 2) return undefined
  const json = record(value)
  if (Object.keys(json).length === 0) return undefined
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return undefined
    seen.add(value)
  }

  const topLevelUsage = fromTokenBag(record(json.usage))
  if (topLevelUsage) return topLevelUsage

  const meta = record(json._meta)
  if (Object.keys(meta).length > 0) {
    const nestedMetaUsage = fromTokenBag(record(meta.usage))
    if (nestedMetaUsage) return nestedMetaUsage
    const flatMetaUsage = fromTokenBag(meta)
    if (flatMetaUsage) return flatMetaUsage
  }

  const flatUsage = fromTokenBag(json)
  if (flatUsage) return flatUsage
  return json.result === undefined
    ? undefined
    : parseTurnTokenUsageAtDepth(json.result, depth + 1, seen)
}

function fromTokenBag(bag: UnknownRecord): TurnTokenUsage | undefined {
  if (Object.keys(bag).length === 0) return undefined
  const cached = firstTokenCount(bag, cachedKeys) ?? cachedFromPromptDetails(bag)
  const fullInput = firstTokenCount(bag, ['inputTokens', 'prompt_tokens'])
  const uncachedInput = firstTokenCount(bag, ['input_tokens'])
  const input = fullInput ?? (
    uncachedInput === undefined
      ? undefined
      : cached === undefined
        ? uncachedInput
        : safeTokenSum(uncachedInput, cached)
  )
  const candidate = {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...optionalCounter(bag, 'outputTokens', ['outputTokens', 'output_tokens', 'completion_tokens']),
    ...(cached !== undefined ? { cachedReadTokens: cached } : {}),
    ...optionalCounter(bag, 'reasoningTokens', [
      'reasoningTokens',
      'reasoning_tokens',
      'thoughtTokens',
      'thought_tokens'
    ]),
    ...optionalCounter(bag, 'totalTokens', ['totalTokens', 'total_tokens'])
  }
  const parsed = turnTokenUsageSchema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}

function optionalCounter<K extends keyof TurnTokenUsage>(
  bag: UnknownRecord,
  outputKey: K,
  keys: readonly string[]
): Partial<TurnTokenUsage> {
  const value = firstTokenCount(bag, keys)
  return value === undefined ? {} : { [outputKey]: value }
}

function cachedFromPromptDetails(bag: UnknownRecord): number | undefined {
  const details = record(bag.prompt_tokens_details ?? bag.promptTokensDetails)
  return firstTokenCount(details, ['cached_tokens', 'cachedTokens'])
}

function firstTokenCount(
  bag: UnknownRecord,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const parsed = compatibleTokenCount(bag[key])
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** Swift accepts integer-valued NSNumber/Double and decimal strings. */
function compatibleTokenCount(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined
    const integer = Math.trunc(value)
    return integer <= MAX_TOKEN_COUNT ? integer : undefined
  }
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) return undefined
  const integer = Number(value)
  return Number.isSafeInteger(integer) && integer <= MAX_TOKEN_COUNT ? integer : undefined
}

function strictTokenCount(value: unknown): number | undefined {
  return tokenCountSchema.safeParse(value).success
    ? value as number
    : undefined
}

function safeTokenSum(left: number, right: number): number | undefined {
  const total = left + right
  return Number.isSafeInteger(total) && total <= MAX_TOKEN_COUNT ? total : undefined
}

function contextTotal(value: unknown): number | undefined {
  const params = record(value)
  return totalIn(params) ?? totalIn(params._meta) ?? totalIn(params.update)
}

function totalIn(value: unknown): number | undefined {
  const object = record(value)
  const meta = Object.keys(record(object._meta)).length > 0
    ? record(object._meta)
    : object
  return strictTokenCount(meta.totalTokens)
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string')
}
