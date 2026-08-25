import { describe, expect, it } from 'vitest'
import {
  PRIVACY_DISPLAY_MAX_ORDINAL,
  PRIVACY_DISPLAY_PLACEHOLDERS,
  createPrivacyDisplayResolver
} from '../../src/shared/privacy'

const CANARIES = Object.freeze({
  project: 'Acme launch codes',
  session: 'Investigate customer 042',
  path: '/Users/alice/Private/Acme launch codes',
  worktree: '../worktrees/secret-hotfix',
  branch: 'feature/customer-042-secret',
  savedAgent: 'Revenue Incident Commander',
  mission: 'Protect the private acquisition plan',
  history: 'First prompt contained a private access token'
})

describe('privacy display resolver', () => {
  it('returns every source string byte-for-byte in normal mode', () => {
    const display = createPrivacyDisplayResolver(false)

    expect(display.enabled).toBe(false)
    expect(display.projectName(CANARIES.project, 1)).toBe(CANARIES.project)
    expect(display.sessionTitle(CANARIES.session, 2)).toBe(CANARIES.session)
    expect(display.path(CANARIES.path)).toBe(CANARIES.path)
    expect(display.worktree(CANARIES.worktree, 3)).toBe(CANARIES.worktree)
    expect(display.branch(CANARIES.branch)).toBe(CANARIES.branch)
    expect(display.savedAgentName(CANARIES.savedAgent, 4)).toBe(CANARIES.savedAgent)
    expect(display.savedAgentMission(CANARIES.mission)).toBe(CANARIES.mission)
    expect(display.historySummary(CANARIES.history, 5)).toBe(CANARIES.history)
  })

  it('uses input-independent placeholders for every sensitive display kind', () => {
    const display = createPrivacyDisplayResolver(true)
    const projected = {
      project: display.projectName(CANARIES.project, 1),
      session: display.sessionTitle(CANARIES.session, 2),
      path: display.path(CANARIES.path),
      worktree: display.worktree(CANARIES.worktree, 3),
      branch: display.branch(CANARIES.branch),
      savedAgent: display.savedAgentName(CANARIES.savedAgent, 4),
      mission: display.savedAgentMission(CANARIES.mission),
      history: display.historySummary(CANARIES.history, 5)
    }

    expect(display.enabled).toBe(true)
    expect(projected).toEqual({
      project: 'Project 1',
      session: 'Session 2',
      path: PRIVACY_DISPLAY_PLACEHOLDERS.path,
      worktree: 'Worktree 3',
      branch: PRIVACY_DISPLAY_PLACEHOLDERS.branch,
      savedAgent: 'Saved Agent 4',
      mission: PRIVACY_DISPLAY_PLACEHOLDERS.savedAgentMission,
      history: 'Saved session 5'
    })

    const serialized = JSON.stringify(projected)
    for (const canary of Object.values(CANARIES)) expect(serialized).not.toContain(canary)
    expect(projected.path).not.toContain('Acme launch codes')
  })

  it('adds only valid bounded one-based ordinals', () => {
    const display = createPrivacyDisplayResolver(true)

    expect(display.projectName('private', 1)).toBe('Project 1')
    expect(display.projectName('private', PRIVACY_DISPLAY_MAX_ORDINAL))
      .toBe(`Project ${PRIVACY_DISPLAY_MAX_ORDINAL}`)
    for (const ordinal of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
      PRIVACY_DISPLAY_MAX_ORDINAL + 1]) {
      expect(display.projectName('private', ordinal)).toBe(PRIVACY_DISPLAY_PLACEHOLDERS.project)
    }
  })

  it('does not normalize, trim, or mutate authoritative values', () => {
    const source = Object.freeze({
      project: '  exact project  ',
      path: '/private/path/'
    })
    const before = JSON.stringify(source)

    const normal = createPrivacyDisplayResolver(false)
    const hidden = createPrivacyDisplayResolver(true)
    expect(normal.projectName(source.project)).toBe('  exact project  ')
    expect(normal.path(source.path)).toBe('/private/path/')
    expect(hidden.projectName(source.project)).toBe('Project')
    expect(hidden.path(source.path)).toBe('••••')
    expect(JSON.stringify(source)).toBe(before)
    expect(Object.isFrozen(normal)).toBe(true)
    expect(Object.isFrozen(hidden)).toBe(true)
  })
})
