import type {
  MemoryScope,
  PublicMemoryFileSummary
} from '../../shared/memory'

export const MEMORY_SCOPE_GROUPS = Object.freeze([
  { scope: 'global', label: 'Global' },
  { scope: 'workspace', label: 'Workspaces' },
  { scope: 'session', label: 'Sessions' }
] satisfies ReadonlyArray<{ scope: MemoryScope; label: string }>)

export interface MemorySummaryDisplay {
  scope: MemoryScope
  scopeLabel: 'Global' | 'Workspace' | 'Session'
  title: string
  workspaceLabel?: string
  sizeLabel: string
  dateLabel: string
}

/**
 * Projects only user-facing metadata. In particular, the capability token is
 * deliberately omitted so it cannot accidentally reach DOM attributes or
 * accessible names.
 */
export function memorySummaryDisplay(summary: PublicMemoryFileSummary): MemorySummaryDisplay {
  return {
    scope: summary.scope,
    scopeLabel: scopeLabel(summary.scope),
    title: summary.title,
    ...(summary.workspaceLabel ? { workspaceLabel: summary.workspaceLabel } : {}),
    sizeLabel: formatMemoryBytes(summary.byteLength),
    dateLabel: formatMemoryDate(summary.modifiedAt)
  }
}

export function groupMemorySummaries(
  summaries: readonly PublicMemoryFileSummary[]
): ReadonlyArray<{
  scope: MemoryScope
  label: string
  entries: readonly PublicMemoryFileSummary[]
}> {
  return MEMORY_SCOPE_GROUPS.map((group) => ({
    ...group,
    entries: summaries.filter((summary) => summary.scope === group.scope)
  })).filter((group) => group.entries.length > 0)
}

export function formatMemoryBytes(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return 'Size unavailable'
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${compactNumber(bytes / 1_024)} KB`
  return `${compactNumber(bytes / (1_024 * 1_024))} MB`
}

export function formatMemoryDate(value: string | undefined): string {
  if (!value) return 'Date unavailable'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'Date unavailable'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(timestamp))
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1
  }).format(value)
}

function scopeLabel(scope: MemoryScope): MemorySummaryDisplay['scopeLabel'] {
  switch (scope) {
    case 'global': return 'Global'
    case 'workspace': return 'Workspace'
    case 'session': return 'Session'
  }
}
