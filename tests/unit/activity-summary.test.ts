import { describe, expect, it } from 'vitest'
import {
  addActivityKind,
  classifyToolActivity,
  formatActivityLine,
  formatActivitySummary,
  parsePersistedActivitySummary
} from '../../src/shared/acp/activity'
import {
  isTrustedOnlySessionUpdate,
  trustedUpdatesFromSessionNotification,
  trustedUpdatesFromSessionUpdate
} from '../../src/shared/acp/trustedUpdates'

describe('pinned Swift-compatible activity summaries', () => {
  it('classifies stable tool verbs without retaining titles', () => {
    expect(classifyToolActivity('Read `/tmp/skills/foo/SKILL.md`')).toBe('read_skill')
    expect(classifyToolActivity('Read `/tmp/project/README.md`')).toBe('read_file')
    expect(classifyToolActivity('List `/tmp/project`')).toBe('listed')
    expect(classifyToolActivity('Get')).toBe('fetched')
    expect(classifyToolActivity('bash')).toBe('ran')
    expect(classifyToolActivity('computer_list_apps')).toBe('computer_use')
    expect(classifyToolActivity('[subagent:general-purpose]')).toBe('subagent')
    expect(classifyToolActivity('spawn.*bash')).toBe('searched')
    expect(classifyToolActivity('"name":"computer list apps"')).toBe('searched')
    expect(classifyToolActivity('Tool call')).toBeUndefined()
  })

  it('preserves first-verb order and the Swift read subtype order', () => {
    const entries = [
      { kind: 'read_file' as const, count: 2 },
      { kind: 'listed' as const, count: 1 },
      { kind: 'read_skill' as const, count: 1 },
      { kind: 'ran' as const, count: 2 }
    ]
    expect(formatActivitySummary(entries)).toBe(
      'Read 1 skill, Read 2 files, Listed 1 dir, Ran 2 commands'
    )
    expect(formatActivityLine(entries, 5)).toBe(
      'Read 1 skill, Read 2 files, Listed 1 dir, Ran 2 commands  [hooks: 5]'
    )
  })

  it('projects unknown titles to one generic label and saturates counts', () => {
    const canary = 'QA_ACTIVITY_SECRET_CANARY_4D91'
    const kind = classifyToolActivity(`/private/${canary} --token xai-${canary}`)
    const entries = addActivityKind([], kind!, 99_999)
    expect(entries).toEqual([{ kind: 'other', count: 10_000 }])
    expect(formatActivitySummary(entries)).toBe('Used 10000 tools')
    expect(JSON.stringify({ entries, summary: formatActivitySummary(entries) })).not.toContain(canary)
    expect(JSON.stringify({ entries })).not.toContain('/private/')
  })

  it('uses the strict trusted path for direct and xAI hook notifications', () => {
    const canary = 'QA_HOOK_WIRE_CANARY_72A9'
    const raw = {
      update: {
        sessionUpdate: 'hook_execution',
        event_name: 'stop',
        runs: [{ command: canary, env: { TOKEN: canary }, path: `/private/${canary}` }]
      }
    }
    expect(isTrustedOnlySessionUpdate(raw)).toBe(true)
    expect(trustedUpdatesFromSessionUpdate(raw)).toEqual([
      { type: 'hook_execution', hook: 'stop', runCount: 1 }
    ])
    expect(trustedUpdatesFromSessionNotification(raw)).toEqual([
      { type: 'hook_execution', hook: 'stop', runCount: 1 }
    ])
    expect(JSON.stringify(trustedUpdatesFromSessionUpdate(raw))).not.toContain(canary)
  })

  it('rehydrates canonical Swift clauses with bounded counts and order', () => {
    expect(parsePersistedActivitySummary(
      'Read 1 skill, Read 2 files, Listed 3 dirs, Edited 4 files, Searched 5, ' +
      'Fetched 6, Ran 7 commands, Computer Use ×2, subagent x3'
    )).toEqual([
      { kind: 'read_skill', count: 1 },
      { kind: 'read_file', count: 2 },
      { kind: 'listed', count: 3 },
      { kind: 'edited', count: 4 },
      { kind: 'searched', count: 5 },
      { kind: 'fetched', count: 6 },
      { kind: 'ran', count: 7 },
      { kind: 'computer_use', count: 2 },
      { kind: 'subagent', count: 3 }
    ])
    expect(parsePersistedActivitySummary('stop')).toEqual([{ kind: 'stop', count: 1 }])
    expect(parsePersistedActivitySummary('Searched 999999999')).toEqual([
      { kind: 'searched', count: 10_000 }
    ])
  })

  it('classifies legacy raw titles but never retains their labels or secrets', () => {
    const canary = 'QA_PERSISTED_ACTIVITY_CANARY_B39A'
    const entries = parsePersistedActivitySummary(
      `Read /private/${canary}, bash --token xai-${canary}, ${canary} ×2`
    )
    expect(entries).toEqual([
      { kind: 'read_file', count: 1 },
      { kind: 'ran', count: 1 },
      { kind: 'other', count: 2 }
    ])
    expect(JSON.stringify(entries)).not.toContain(canary)
    expect(JSON.stringify(entries)).not.toContain('/private/')
    expect(JSON.stringify(entries)).not.toContain('bash')
  })
})
