/**
 * Display-only privacy projection for screenshot and screen-share surfaces.
 *
 * This module deliberately accepts presentation strings rather than persisted
 * project/session records. Callers keep the authoritative values for search,
 * routing, IPC capabilities, and persistence, and use this resolver only at
 * the final visible/accessible-name boundary.
 */

export const PRIVACY_DISPLAY_PLACEHOLDERS = Object.freeze({
  project: 'Project',
  session: 'Session',
  path: '••••',
  worktree: 'Worktree',
  branch: 'Branch',
  savedAgent: 'Saved Agent',
  savedAgentMission: 'Instructions hidden',
  history: 'Saved session'
})

/** Persisted schemas currently bound every user-visible collection to 10,000 or fewer items. */
export const PRIVACY_DISPLAY_MAX_ORDINAL = 10_000

export interface PrivacyDisplayResolver {
  readonly enabled: boolean
  projectName: (value: string, ordinal?: number) => string
  sessionTitle: (value: string, ordinal?: number) => string
  path: (value: string) => string
  worktree: (value: string, ordinal?: number) => string
  branch: (value: string) => string
  savedAgentName: (value: string, ordinal?: number) => string
  savedAgentMission: (value: string) => string
  historySummary: (value: string, ordinal?: number) => string
}

/**
 * Create a small resolver that returns source strings byte-for-byte in normal
 * mode and fixed, input-independent copy in privacy mode.
 *
 * Optional one-based ordinals let repeated hidden rows remain distinguishable
 * without deriving copy from names, paths, ids, or other private metadata.
 */
export function createPrivacyDisplayResolver(enabled: boolean): PrivacyDisplayResolver {
  const privacyEnabled = enabled === true
  const visibleOr = (value: string, placeholder: string, ordinal?: number): string =>
    privacyEnabled ? indexedPlaceholder(placeholder, ordinal) : value

  return Object.freeze({
    enabled: privacyEnabled,
    projectName: (value: string, ordinal?: number) =>
      visibleOr(value, PRIVACY_DISPLAY_PLACEHOLDERS.project, ordinal),
    sessionTitle: (value: string, ordinal?: number) =>
      visibleOr(value, PRIVACY_DISPLAY_PLACEHOLDERS.session, ordinal),
    path: (value: string) => visibleOr(value, PRIVACY_DISPLAY_PLACEHOLDERS.path),
    worktree: (value: string, ordinal?: number) =>
      visibleOr(value, PRIVACY_DISPLAY_PLACEHOLDERS.worktree, ordinal),
    branch: (value: string) => visibleOr(value, PRIVACY_DISPLAY_PLACEHOLDERS.branch),
    savedAgentName: (value: string, ordinal?: number) =>
      visibleOr(value, PRIVACY_DISPLAY_PLACEHOLDERS.savedAgent, ordinal),
    savedAgentMission: (value: string) =>
      visibleOr(value, PRIVACY_DISPLAY_PLACEHOLDERS.savedAgentMission),
    historySummary: (value: string, ordinal?: number) =>
      visibleOr(value, PRIVACY_DISPLAY_PLACEHOLDERS.history, ordinal)
  })
}

function indexedPlaceholder(placeholder: string, ordinal: number | undefined): string {
  if (
    ordinal === undefined ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > PRIVACY_DISPLAY_MAX_ORDINAL
  ) {
    return placeholder
  }
  return `${placeholder} ${ordinal}`
}
