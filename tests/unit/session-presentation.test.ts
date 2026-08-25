import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_GROUPS,
  DASHBOARD_SECTION_ORDER,
  DASHBOARD_TITLE_MAX_CHARACTERS,
  DASHBOARD_UNTITLED,
  SESSION_ACTIVITY_STATUSES,
  canSettleSession,
  compactDashboardRole,
  dashboardTitle,
  isDashboardPromptDump,
  resolveDashboardGroup,
  resolveSessionActivityStatus,
  sessionDurationLabel,
  sessionStatusDemandsAttention,
  sessionStatusLabel,
  shouldMarkBackgroundUnread,
  sidebarProjectMatches,
  sidebarValuesMatch,
  type DashboardGroupingInputs,
  type SessionStatusInputs
} from '../../src/shared/sessionPresentation'

const booleans = [false, true] as const

describe('session activity presentation', () => {
  it('resolves every signal combination using the pinned Swift priority', () => {
    for (const isStreaming of booleans) {
      for (const isAwaitingUser of booleans) {
        for (const hasError of booleans) {
          for (const hasUnreadCompletion of booleans) {
            const inputs: Required<SessionStatusInputs> = {
              isStreaming,
              isAwaitingUser,
              hasError,
              hasUnreadCompletion
            }
            const expected = isAwaitingUser
              ? 'needs-input'
              : hasError
                ? 'error'
                : isStreaming
                  ? 'working'
                  : hasUnreadCompletion
                    ? 'finished-unread'
                    : 'idle'

            expect(resolveSessionActivityStatus(inputs)).toBe(expected)
          }
        }
      }
    }
  })

  it('matches Swift attention and settlement behavior for every status', () => {
    expect(SESSION_ACTIVITY_STATUSES).toEqual([
      'idle',
      'working',
      'needs-input',
      'finished-unread',
      'error'
    ])

    const expected = {
      idle: { attention: false, canSettle: true },
      working: { attention: false, canSettle: false },
      'needs-input': { attention: true, canSettle: false },
      'finished-unread': { attention: true, canSettle: true },
      error: { attention: true, canSettle: true }
    } as const

    for (const status of SESSION_ACTIVITY_STATUSES) {
      expect(sessionStatusDemandsAttention(status)).toBe(expected[status].attention)
      expect(canSettleSession(status)).toBe(expected[status].canSettle)
    }
  })

  it('marks background unread for all streaming and message-growth combinations', () => {
    for (const wasStreaming of booleans) {
      for (const isStreaming of booleans) {
        for (const messageCountGrew of booleans) {
          expect(shouldMarkBackgroundUnread({ wasStreaming, isStreaming, messageCountGrew })).toBe(
            !isStreaming && (wasStreaming || messageCountGrew)
          )
        }
      }
    }
  })
})

describe('sidebar presentation', () => {
  it('matches trimmed project and session metadata case-insensitively', () => {
    const sessions = [{
      title: 'Investigate Issue',
      roleName: 'Researcher',
      specialistName: 'Ada'
    }]

    expect(sidebarValuesMatch('auth', ['Desktop', 'Fix Auth Flow'])).toBe(true)
    expect(sidebarValuesMatch('RESEARCH', ['researcher'])).toBe(true)
    expect(sidebarValuesMatch('billing', ['Fix Auth Flow'])).toBe(false)
    expect(sidebarValuesMatch('  ', [])).toBe(true)
    expect(sidebarProjectMatches(' desktop ', 'Desktop Client', sessions)).toBe(true)
    expect(sidebarProjectMatches('research', 'Desktop Client', sessions)).toBe(true)
    expect(sidebarProjectMatches('ADA', 'Desktop Client', sessions)).toBe(true)
    expect(sidebarProjectMatches('billing', 'Desktop Client', sessions)).toBe(false)
  })

  it('returns only a match decision and never echoes searched metadata', () => {
    const result = sidebarProjectMatches('needle', 'Neutral Project', [{
      title: 'Needle Session',
      roleName: 'Builder',
      specialistName: 'Teammate'
    }])

    expect(result).toBe(true)
    expect(typeof result).toBe('boolean')
  })

  it('formats status copy and working duration at every unit boundary', () => {
    expect(sessionDurationLabel(1_000_000, 1_000_000)).toBe('1s')
    expect(sessionDurationLabel(1_001_000, 1_000_000)).toBe('1s')
    expect(sessionDurationLabel(1_000_000, 1_059_999)).toBe('59s')
    expect(sessionDurationLabel(1_000_000, 1_060_000)).toBe('1m')
    expect(sessionDurationLabel(1_000_000, 1_125_000)).toBe('2m')
    expect(sessionDurationLabel(1_000_000, 4_599_000)).toBe('59m')
    expect(sessionDurationLabel(1_000_000, 4_600_000)).toBe('1h')
    expect(sessionDurationLabel(1_000_000, 4_720_000)).toBe('1h 2m')

    expect(sessionStatusLabel({
      status: 'working',
      workingSinceMs: 1_000_000,
      nowMs: 1_125_000
    })).toBe('Working 2m')
    expect(sessionStatusLabel({ status: 'working', nowMs: 1_000_000 })).toBe('Working')
    expect(sessionStatusLabel({ status: 'needs-input', nowMs: 1_000_000 })).toBe('Needs input')
    expect(sessionStatusLabel({ status: 'finished-unread', nowMs: 1_000_000 })).toBe('Completed')
    expect(sessionStatusLabel({ status: 'error', nowMs: 1_000_000 })).toBe('Error')
    expect(sessionStatusLabel({ status: 'idle', nowMs: 1_000_000 })).toBeNull()
  })
})

describe('dashboard presentation', () => {
  it('resolves every signal combination using the six-group Swift priority', () => {
    for (let mask = 0; mask < 256; mask += 1) {
      const inputs: Required<DashboardGroupingInputs> = {
        pendingUserCount: mask & 1 ? 1 : 0,
        hasUnreadCompletion: Boolean(mask & 2),
        isFailed: Boolean(mask & 4),
        isStreaming: Boolean(mask & 8),
        isStarting: Boolean(mask & 16),
        isBusy: Boolean(mask & 32),
        dirtyCount: mask & 64 ? 1 : 0,
        scheduledCount: mask & 128 ? 1 : 0
      }
      const expected = inputs.pendingUserCount > 0 || inputs.hasUnreadCompletion
        ? 'needs-you'
        : inputs.isFailed
          ? 'failed'
          : inputs.isStreaming || inputs.isStarting || inputs.isBusy
            ? 'working'
            : inputs.dirtyCount > 0
              ? 'needs-review'
              : inputs.scheduledCount > 0
                ? 'scheduled'
                : 'idle'

      expect(resolveDashboardGroup(inputs)).toBe(expected)
    }
  })

  it('keeps section order identical to grouping priority and handles invalid counts safely', () => {
    expect(DASHBOARD_SECTION_ORDER).toEqual([
      'needs-you',
      'failed',
      'working',
      'needs-review',
      'scheduled',
      'idle'
    ])
    expect(DASHBOARD_SECTION_ORDER).toEqual(DASHBOARD_GROUPS)
    expect(resolveDashboardGroup({
      pendingUserCount: Number.NaN,
      dirtyCount: -1,
      scheduledCount: Number.POSITIVE_INFINITY
    })).toBe('idle')
  })

  it('sanitizes context dumps, collapses whitespace, and compacts roles', () => {
    expect(dashboardTitle('<user_info> OS Version: macos Shell: zsh Workspace Path: hidden')).toBe(
      DASHBOARD_UNTITLED
    )
    expect(dashboardTitle('OS Version: macos\nWorkspace Path hidden')).toBe(DASHBOARD_UNTITLED)
    expect(dashboardTitle('  ')).toBe(DASHBOARD_UNTITLED)
    expect(dashboardTitle('  whats\n\tup?  ')).toBe('whats up?')
    expect(dashboardTitle('<html> table')).toBe('<html> table')
    expect(dashboardTitle('<3 thanks')).toBe('<3 thanks')
    expect(isDashboardPromptDump('<html>')).toBe(false)
    expect(isDashboardPromptDump('<user_info> OS Version: macos')).toBe(true)
    expect(compactDashboardRole(' Default (grok build) ')).toBe('Default')
    expect(compactDashboardRole(' researcher ')).toBe('researcher')
  })

  it('truncates at a word boundary and counts Unicode grapheme clusters like Swift', () => {
    const long = 'word '.repeat(20)
    const displayed = dashboardTitle(long)
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

    expect(displayed.endsWith('…')).toBe(true)
    expect(Array.from(segmenter.segment(displayed)).length).toBeLessThanOrEqual(
      DASHBOARD_TITLE_MAX_CHARACTERS + 1
    )

    const emoji = '👩‍💻'
    expect(dashboardTitle(emoji.repeat(DASHBOARD_TITLE_MAX_CHARACTERS))).toBe(
      emoji.repeat(DASHBOARD_TITLE_MAX_CHARACTERS)
    )
    expect(dashboardTitle(emoji.repeat(DASHBOARD_TITLE_MAX_CHARACTERS + 1))).toBe(
      `${emoji.repeat(DASHBOARD_TITLE_MAX_CHARACTERS)}…`
    )
  })
})
