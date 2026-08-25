/**
 * Pure presentation rules ported from the pinned GrokBuild Swift v0.3.2 reference.
 *
 * The functions in this module intentionally accept only the small pieces of metadata needed
 * for presentation. Search helpers return booleans and never echo the searched metadata.
 */

export const SESSION_ACTIVITY_STATUSES = [
  'idle',
  'working',
  'needs-input',
  'finished-unread',
  'error'
] as const

export type SessionActivityStatus = (typeof SESSION_ACTIVITY_STATUSES)[number]

export interface SessionStatusInputs {
  readonly isStreaming?: boolean
  readonly isAwaitingUser?: boolean
  readonly hasError?: boolean
  readonly hasUnreadCompletion?: boolean
}

/** Priority: needs input -> error -> working -> finished unread -> idle. */
export function resolveSessionActivityStatus(inputs: SessionStatusInputs): SessionActivityStatus {
  if (inputs.isAwaitingUser === true) return 'needs-input'
  if (inputs.hasError === true) return 'error'
  if (inputs.isStreaming === true) return 'working'
  if (inputs.hasUnreadCompletion === true) return 'finished-unread'
  return 'idle'
}

export function sessionStatusDemandsAttention(status: SessionActivityStatus): boolean {
  return status === 'needs-input' || status === 'finished-unread' || status === 'error'
}

export interface BackgroundUnreadInputs {
  readonly wasStreaming: boolean
  readonly isStreaming: boolean
  readonly messageCountGrew: boolean
}

/**
 * A background completion is observed primarily through streaming true -> false. Message growth
 * is the fallback for already-idle sessions because the assistant placeholder may pre-exist.
 */
export function shouldMarkBackgroundUnread(inputs: BackgroundUnreadInputs): boolean {
  if (inputs.wasStreaming && !inputs.isStreaming) return true
  return inputs.messageCountGrew && !inputs.isStreaming
}

export interface SidebarSessionSearchMetadata {
  readonly title: string
  readonly roleName?: string
  readonly specialistName?: string
}

/** Internal bounds keep filtering work deterministic without exposing matched metadata. */
export const SIDEBAR_SEARCH_LIMITS = Object.freeze({
  queryCharacters: 256,
  valueCharacters: 4_096,
  sessionsPerProject: 1_024
})

function boundedCharacters(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('')
}

function normalizedSearchValue(value: string, limit: number): string {
  return boundedCharacters(value, limit).toLocaleLowerCase()
}

/** Case-insensitive contains matching. A whitespace-only query matches everything. */
export function sidebarValuesMatch(query: string, values: readonly string[]): boolean {
  const trimmed = query.trim()
  if (trimmed.length === 0) return true

  const needle = normalizedSearchValue(trimmed, SIDEBAR_SEARCH_LIMITS.queryCharacters)
  return values.some((value) =>
    normalizedSearchValue(value, SIDEBAR_SEARCH_LIMITS.valueCharacters).includes(needle)
  )
}

/** Match a project name plus the title, role, and specialist name of its sessions. */
export function sidebarProjectMatches(
  query: string,
  projectName: string,
  sessions: readonly SidebarSessionSearchMetadata[]
): boolean {
  if (sidebarValuesMatch(query, [projectName])) return true

  return sessions.slice(0, SIDEBAR_SEARCH_LIMITS.sessionsPerProject).some((session) =>
    sidebarValuesMatch(query, [
      session.title,
      session.roleName ?? '',
      session.specialistName ?? ''
    ])
  )
}

export function canSettleSession(status: SessionActivityStatus): boolean {
  return status !== 'working' && status !== 'needs-input'
}

const MAX_EPOCH_MILLISECONDS = 8_640_000_000_000_000

function isValidEpochMilliseconds(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_EPOCH_MILLISECONDS
}

/** Swift-compatible elapsed label: minimum 1s, then whole minutes, then hours/minutes. */
export function sessionDurationLabel(startedAtMs: number, nowMs: number): string {
  if (!isValidEpochMilliseconds(startedAtMs) || !isValidEpochMilliseconds(nowMs)) return '1s'

  const seconds = Math.max(0, Math.trunc((nowMs - startedAtMs) / 1_000))
  if (seconds < 60) return `${Math.max(1, seconds)}s`
  if (seconds < 3_600) return `${Math.trunc(seconds / 60)}m`

  const hours = Math.trunc(seconds / 3_600)
  const minutes = Math.trunc((seconds % 3_600) / 60)
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

export interface SessionStatusLabelInputs {
  readonly status: SessionActivityStatus
  readonly workingSinceMs?: number
  readonly nowMs: number
}

export function sessionStatusLabel(inputs: SessionStatusLabelInputs): string | null {
  switch (inputs.status) {
    case 'idle':
      return null
    case 'working':
      return inputs.workingSinceMs === undefined
        ? 'Working'
        : `Working ${sessionDurationLabel(inputs.workingSinceMs, inputs.nowMs)}`
    case 'needs-input':
      return 'Needs input'
    case 'finished-unread':
      return 'Completed'
    case 'error':
      return 'Error'
  }
}

export const DASHBOARD_GROUPS = [
  'needs-you',
  'failed',
  'working',
  'needs-review',
  'scheduled',
  'idle'
] as const

export type DashboardGroup = (typeof DASHBOARD_GROUPS)[number]

/** Section order is deliberately identical to group resolution priority. */
export const DASHBOARD_SECTION_ORDER: readonly DashboardGroup[] = DASHBOARD_GROUPS

export interface DashboardGroupingInputs {
  readonly isStreaming?: boolean
  readonly isStarting?: boolean
  readonly isBusy?: boolean
  readonly isFailed?: boolean
  readonly pendingUserCount?: number
  readonly hasUnreadCompletion?: boolean
  readonly dirtyCount?: number
  readonly scheduledCount?: number
}

function isPositiveCount(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value > 0
}

/** Priority: needs you -> failed -> working -> needs review -> scheduled -> idle. */
export function resolveDashboardGroup(inputs: DashboardGroupingInputs): DashboardGroup {
  if (isPositiveCount(inputs.pendingUserCount) || inputs.hasUnreadCompletion === true) {
    return 'needs-you'
  }
  if (inputs.isFailed === true) return 'failed'
  if (inputs.isStreaming === true || inputs.isStarting === true || inputs.isBusy === true) {
    return 'working'
  }
  if (isPositiveCount(inputs.dirtyCount)) return 'needs-review'
  if (isPositiveCount(inputs.scheduledCount)) return 'scheduled'
  return 'idle'
}

export const DASHBOARD_UNTITLED = 'Untitled session'
export const DASHBOARD_TITLE_MAX_CHARACTERS = 48

const dashboardGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemes(value: string): string[] {
  return Array.from(dashboardGraphemeSegmenter.segment(value), ({ segment }) => segment)
}

/** Cursor/grok context banners are not genuine user-authored titles. */
export function isDashboardPromptDump(text: string): boolean {
  const lower = text.toLowerCase()
  if (lower.startsWith('<user_info') || lower.startsWith('user_info')) return true
  return lower.includes('os version:') && lower.includes('workspace path')
}

/** Display-only cleanup; it never mutates the stored session title. */
export function dashboardTitle(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/gu, ' ')
  if (collapsed.length === 0 || isDashboardPromptDump(collapsed)) return DASHBOARD_UNTITLED

  const characters = graphemes(collapsed)
  if (characters.length <= DASHBOARD_TITLE_MAX_CHARACTERS) return collapsed

  const prefix = characters.slice(0, DASHBOARD_TITLE_MAX_CHARACTERS).join('')
  const lastSpace = prefix.lastIndexOf(' ')
  return `${lastSpace >= 0 ? prefix.slice(0, lastSpace) : prefix}…`
}

export function compactDashboardRole(roleName: string): string {
  const trimmed = roleName.trim()
  return trimmed.startsWith('Default') ? 'Default' : trimmed
}
