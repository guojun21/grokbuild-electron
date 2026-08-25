import { describe, expect, it } from 'vitest'
import type {
  PublicAgentRosterSnapshot,
  PublicSavedAgentSummary,
  PublicSessionSnapshot
} from '../../src/shared/models'
import {
  groupGrokAgentCatalog,
  savedAgentNameValidationError,
  sanitizeGrokAgentCatalog,
  sidebarAgentPresentations
} from '../../src/renderer/src/agentPresentation'

const CHIEF_ID = '11111111-1111-4111-8111-111111111111'
const SCOUT_ID = '22222222-2222-4222-8222-222222222222'
const BUILDER_ID = '33333333-3333-4333-8333-333333333333'

function agent(input: Partial<PublicSavedAgentSummary> & Pick<PublicSavedAgentSummary, 'id' | 'name'>): PublicSavedAgentSummary {
  return {
    id: input.id,
    name: input.name,
    mission: input.mission ?? 'Own a bounded area of work',
    glyph: input.glyph ?? 'person.fill',
    color: input.color ?? '#5E5CE6',
    isPinned: input.isPinned ?? false
  }
}

function session(input: {
  id: string
  title: string
  updatedAt: string
  savedAgent: PublicSavedAgentSummary
  activityStatus?: PublicSessionSnapshot['activityStatus']
}): PublicSessionSnapshot {
  return {
    id: input.id,
    projectId: 'project-1',
    title: input.title,
    status: 'idle',
    model: 'grok',
    mode: 'default',
    reasoningEffort: 'medium',
    permissionMode: 'ask',
    contextUsed: 0,
    contextLimit: 128_000,
    transcript: [],
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: input.updatedAt,
    canFork: false,
    activityStatus: input.activityStatus ?? 'idle',
    hasUnreadCompletion: false,
    pendingUserCount: 0,
    savedAgentId: input.savedAgent.id,
    savedAgent: {
      name: input.savedAgent.name,
      glyph: input.savedAgent.glyph,
      color: input.savedAgent.color
    }
  }
}

describe('agent renderer presentation', () => {
  it('shows only pinned or bound agents by default and resolves the latest bound chat', () => {
    const chief = agent({ id: CHIEF_ID, name: 'Chief', isPinned: true })
    const scout = agent({ id: SCOUT_ID, name: 'Scout', mission: 'Research source-backed briefs' })
    const builder = agent({ id: BUILDER_ID, name: 'Builder' })
    const roster: PublicAgentRosterSnapshot = {
      status: 'ready',
      revision: 4,
      agents: [chief, scout, builder]
    }
    const sessions = [
      session({
        id: 'builder-older',
        title: 'Older build',
        updatedAt: '2026-08-25T01:00:00.000Z',
        savedAgent: builder
      }),
      session({
        id: 'builder-latest',
        title: 'Current build',
        updatedAt: '2026-08-25T02:00:00.000Z',
        savedAgent: builder,
        activityStatus: 'working'
      })
    ]

    const active = sidebarAgentPresentations(roster, sessions, { showAll: false, query: '' })
    expect(active.map(({ agent: entry }) => entry.name)).toEqual(['Builder', 'Chief'])
    expect(active[0]).toMatchObject({ targetSessionId: 'builder-latest', status: 'working' })

    const missionSearch = sidebarAgentPresentations(roster, sessions, {
      showAll: true,
      query: 'source-backed'
    })
    expect(missionSearch.map(({ agent: entry }) => entry.name)).toEqual(['Scout'])
    expect(missionSearch[0]?.targetSessionId).toBeUndefined()
  })

  it('drops catalog capability tokens before grouping or rendering', () => {
    const token = 'A'.repeat(43)
    const entries = sanitizeGrokAgentCatalog([{
      token,
      name: 'Project reviewer',
      description: 'Reviews the selected workspace',
      sourceKind: 'project'
    }, {
      token: 'B'.repeat(43),
      name: 'Plugin operator',
      description: 'Runs bounded plug-in workflows',
      sourceKind: 'plugin',
      pluginDisplayName: 'Example Plug-in'
    }])

    expect(JSON.stringify(entries)).not.toContain(token)
    expect(groupGrokAgentCatalog(entries).map((group) => group.sourceKind)).toEqual([
      'project',
      'plugin'
    ])

    const serialized = JSON.stringify(groupGrokAgentCatalog(entries))
    expect(serialized).toContain('Project reviewer')
    expect(serialized).toContain('Example Plug-in')
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain('selector')
  })

  it('explains renderer-known empty, reserved, and duplicate name failures', () => {
    const agents = [agent({ id: CHIEF_ID, name: 'Chief' })]
    expect(savedAgentNameValidationError('🛠️', agents)).toBe(
      'Use at least one letter or number in the name.'
    )
    expect(savedAgentNameValidationError('Plan', agents)).toBe(
      'This name is reserved by Grok. Choose a more specific name.'
    )
    expect(savedAgentNameValidationError('  chief  ', agents)).toBe(
      'A Saved Agent already uses this name.'
    )
    expect(savedAgentNameValidationError('Chief', agents, CHIEF_ID)).toBeUndefined()
  })
})
