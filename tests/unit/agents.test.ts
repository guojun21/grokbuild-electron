import { describe, expect, it } from 'vitest'
import {
  MAX_SAVED_AGENTS,
  RESERVED_AGENT_ROLE_NAMES,
  SAVED_AGENT_STARTER_CREW,
  agentRosterSchema,
  canonicalizeAgentColor,
  effectiveAgentRole,
  inlineAcpAgentProfile,
  materializeSavedAgent,
  parseAgentRoster,
  suggestedAgentRoleName,
  type AgentRoster,
  type SavedAgent
} from '../../src/shared/agents'

const NOW = '2026-08-25T00:00:00.000Z'

describe('saved agents contract', () => {
  it('normalizes every saved-agent field and builds the sole ACP inline profile shape', () => {
    const agent = materializeSavedAgent({
      id: uuid(1).toUpperCase(),
      name: '  Builder  ',
      mission: ' Implement code ',
      glyph: ' hammer.fill ',
      color: '#abc',
      roleName: ' builder_role ',
      defaultModel: ' grok-build ',
      permissionProfile: 'workspaceWrite',
      browserEnabled: true,
      computerUseEnabled: false,
      preferredSkills: [' /review ', '', '/REVIEW', '/design'],
      lastSessionId: uuid(2).toUpperCase(),
      isPinned: true
    }, { id: uuid(99), now: NOW })

    expect(agent).toEqual({
      id: uuid(1),
      name: 'Builder',
      mission: 'Implement code',
      glyph: 'hammer.fill',
      color: '#AABBCC',
      roleName: 'builder_role',
      defaultModel: 'grok-build',
      permissionProfile: 'workspaceWrite',
      browserEnabled: true,
      computerUseEnabled: false,
      preferredSkills: ['/review', '/design'],
      createdAt: NOW,
      updatedAt: NOW,
      lastSessionId: uuid(2),
      isPinned: true
    })
    expect(effectiveAgentRole(agent)).toBe('builder_role')
    expect(inlineAcpAgentProfile(agent)).toEqual({
      name: 'builder_role',
      description: 'Implement code',
      promptBody: 'You are Builder.\n\nInstructions: Implement code'
    })
  })

  it('reads and normalizes the Swift legacy raw array without writing version metadata into it', () => {
    const legacy = [{
      id: uuid(1).toUpperCase(),
      name: ' Chief ',
      mission: ' Route work ',
      glyph: ' crown.fill ',
      color: '#5e5ce6',
      createdAt: '2026-08-25T00:00:00Z',
      updatedAt: '2026-08-25T00:00:00Z',
      lastSessionID: uuid(2).toUpperCase()
    }]

    const parsed = parseAgentRoster(legacy)

    expect(parsed.source).toBe('swift-legacy')
    expect(parsed.roster).toEqual({
      version: 1,
      revision: 0,
      agents: [{
        id: uuid(1),
        name: 'Chief',
        mission: 'Route work',
        glyph: 'crown.fill',
        color: '#5E5CE6',
        permissionProfile: 'inherit',
        browserEnabled: false,
        computerUseEnabled: false,
        preferredSkills: [],
        createdAt: NOW,
        updatedAt: NOW,
        lastSessionId: uuid(2),
        isPinned: false
      }],
      sessionBindings: {}
    })
  })

  it('keeps the versioned shape strict and bounded', () => {
    const valid = roster([agent(1, 'Agent 1', 'role_1')])
    expect(parseAgentRoster(valid).roster).toEqual(valid)
    expect(() => parseAgentRoster({ ...valid, rendererCanRunShell: true })).toThrow()
    expect(() => parseAgentRoster([{ ...swiftAgent(1), rendererCanRunShell: true }])).toThrow()

    const overflow = Array.from({ length: MAX_SAVED_AGENTS + 1 }, (_, index) =>
      agent(index + 1, `Agent ${index + 1}`, `role_${index + 1}`)
    )
    expect(() => agentRosterSchema.parse(roster(overflow))).toThrow()
  })

  it('enforces case-insensitive display-name and effective-role uniqueness', () => {
    expect(() => agentRosterSchema.parse(roster([
      agent(1, 'Scout', 'scout_one'),
      agent(2, 'sCoUt', 'scout_two')
    ]))).toThrow(/Agent name must be unique/)

    expect(() => agentRosterSchema.parse(roster([
      agent(1, 'First', 'shared_role'),
      agent(2, 'Second', 'SHARED_ROLE')
    ]))).toThrow(/Effective agent role must be unique/)

    const implicit = agent(2, 'Shared Role', undefined)
    expect(effectiveAgentRole(implicit)).toBe('shared-role')
    expect(() => agentRosterSchema.parse(roster([
      agent(1, 'First', 'shared-role'),
      implicit
    ]))).toThrow(/Effective agent role must be unique/)
  })

  it('rejects reserved or ACP-invalid effective roles', () => {
    for (const reserved of RESERVED_AGENT_ROLE_NAMES) {
      expect(() => agentRosterSchema.parse(roster([
        agent(1, 'Custom', reserved)
      ]))).toThrow(/reserved/)
    }
    expect(() => agentRosterSchema.parse(roster([
      agent(1, '计划员', undefined)
    ]))).toThrow(/valid ACP agent name/)
    expect(suggestedAgentRoleName(' Security Review! ')).toBe('security-review')
  })

  it('requires every session binding to point at a local saved-agent id', () => {
    const valid = roster([agent(1, 'Chief', 'chief')])
    valid.sessionBindings['session-1'] = uuid(1)
    expect(agentRosterSchema.parse(valid).sessionBindings).toEqual({ 'session-1': uuid(1) })

    valid.sessionBindings['session-2'] = uuid(2)
    expect(() => agentRosterSchema.parse(valid)).toThrow(/existing agent/)
  })

  it('matches the exact five-person Swift starter crew', () => {
    expect(SAVED_AGENT_STARTER_CREW).toEqual([
      {
        name: 'Chief', mission: 'Route work, keep scope, synthesize final answer',
        glyph: 'crown.fill', color: '#5E5CE6', roleName: 'chief',
        permissionProfile: 'workspaceWrite'
      },
      {
        name: 'Scout', mission: 'Research and source-backed briefs',
        glyph: 'binoculars', color: '#0A84FF', roleName: 'scout',
        permissionProfile: 'readOnly', browserEnabled: true
      },
      {
        name: 'Builder', mission: 'Implement code, scripts, integrations',
        glyph: 'hammer.fill', color: '#FF9F0A', roleName: 'builder',
        permissionProfile: 'workspaceWrite'
      },
      {
        name: 'Verifier', mission: 'Independent review, tests, claim checking',
        glyph: 'checkmark.shield.fill', color: '#30D158', roleName: 'verifier',
        permissionProfile: 'readOnly'
      },
      {
        name: 'Operator', mission: 'Browser / SaaS / desktop workflows',
        glyph: 'desktopcomputer', color: '#FF375F', roleName: 'operator',
        permissionProfile: 'workspaceWrite', browserEnabled: true, computerUseEnabled: true
      }
    ])
  })

  it('canonicalizes supported colors only', () => {
    expect(canonicalizeAgentColor(' #5e5ce6 ')).toBe('#5E5CE6')
    expect(canonicalizeAgentColor('abc')).toBe('#AABBCC')
    expect(canonicalizeAgentColor('blue')).toBeUndefined()
  })
})

function roster(agents: SavedAgent[]): AgentRoster {
  return { version: 1, revision: 0, agents, sessionBindings: {} }
}

function agent(index: number, name: string, roleName: string | undefined): SavedAgent {
  return materializeSavedAgent({
    id: uuid(index),
    name,
    mission: `Mission ${index}`,
    ...(roleName ? { roleName } : {})
  }, { id: uuid(index), now: NOW })
}

function swiftAgent(index: number): Record<string, unknown> {
  return {
    id: uuid(index),
    name: `Agent ${index}`,
    mission: `Mission ${index}`,
    glyph: 'person.fill',
    color: '#5E5CE6',
    createdAt: NOW,
    updatedAt: NOW
  }
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}
