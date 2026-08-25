/** Locale-stable counterparts of the pinned Swift ContextUsageFormatter. */
export function formatDecimalTokens(value: number): string {
  const bounded = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(bounded)
}

export function formatCompactTokens(value: number): string {
  const bounded = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  return bounded >= 1_000 ? `${Math.round(bounded / 1_000)}K` : String(bounded)
}

export function formatContextSummary(used: number | undefined, limit: number | undefined): string {
  return `${used === undefined ? '—' : formatDecimalTokens(used)} / ${
    limit === undefined ? '—' : formatDecimalTokens(limit)
  } tokens`
}

export function usagePercent(
  used: number | undefined,
  limit: number | undefined
): number | undefined {
  if (!isNonnegativeFinite(used) || !isPositiveFinite(limit)) return undefined
  return clampPercent(Math.round((used / limit) * 100))
}

export function cachedPercent(
  cached: number | undefined,
  input: number | undefined
): number | undefined {
  if (!isNonnegativeFinite(cached) || !isPositiveFinite(input)) return undefined
  return clampPercent(Math.round((cached / input) * 100))
}

export function formatCachedLine(
  cached: number | undefined,
  input: number | undefined
): string | undefined {
  if (!isNonnegativeFinite(cached)) return undefined
  const percent = cachedPercent(cached, input)
  return `${formatDecimalTokens(cached)} cached${percent === undefined ? '' : ` (${percent}%)`}`
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function isNonnegativeFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}
