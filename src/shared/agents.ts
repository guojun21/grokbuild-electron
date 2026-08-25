import { z } from 'zod'
import {
  ACP_AGENT_PROFILE_LIMITS,
  acpAgentProfileSchema,
  type AcpAgentProfile
} from './acp/workerProtocol'

export const AGENT_ROSTER_VERSION = 1 as const
export const MAX_SAVED_AGENTS = 24
export const MAX_AGENT_SESSION_BINDINGS = 10_000

export const SAVED_AGENT_LIMITS = Object.freeze({
  nameCharacters: 128,
  missionCharacters: ACP_AGENT_PROFILE_LIMITS.descriptionChars,
  glyphCharacters: 128,
  roleNameCharacters: ACP_AGENT_PROFILE_LIMITS.nameChars,
  modelIdCharacters: 128,
  preferredSkills: 32,
  preferredSkillCharacters: 128,
  localSessionIdCharacters: 256
})

export const RESERVED_AGENT_ROLE_NAMES = new Set([
  'general',
  'general-purpose',
  'explore',
  'plan',
  'vision',
  'verify',
  'computer'
])

export const savedAgentPermissionProfileSchema = z.enum([
  'inherit',
  'readOnly',
  'workspaceWrite'
])

const uuidSchema = z.string().uuid()
const timestampSchema = z.string().datetime({ offset: true })
const canonicalColorSchema = z.string().regex(/^#[0-9A-F]{6}$/u)
const roleNameSchema = z.string()
  .min(1)
  .max(SAVED_AGENT_LIMITS.roleNameCharacters)
  .regex(/^[A-Za-z0-9_-]+$/u)
const optionalInputString = (maximum: number): z.ZodOptional<z.ZodNullable<z.ZodString>> =>
  z.string().max(maximum).nullable().optional()

export const savedAgentSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(SAVED_AGENT_LIMITS.nameCharacters),
  mission: z.string().min(1).max(SAVED_AGENT_LIMITS.missionCharacters),
  glyph: z.string().min(1).max(SAVED_AGENT_LIMITS.glyphCharacters),
  color: canonicalColorSchema,
  roleName: roleNameSchema.optional(),
  defaultModel: z.string().min(1).max(SAVED_AGENT_LIMITS.modelIdCharacters).optional(),
  permissionProfile: savedAgentPermissionProfileSchema,
  browserEnabled: z.boolean(),
  computerUseEnabled: z.boolean(),
  preferredSkills: z.array(
    z.string().min(1).max(SAVED_AGENT_LIMITS.preferredSkillCharacters)
  ).max(SAVED_AGENT_LIMITS.preferredSkills),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastSessionId: uuidSchema.optional(),
  isPinned: z.boolean()
}).strict()

const savedAgentInputFields = {
  id: uuidSchema,
  name: z.string().max(SAVED_AGENT_LIMITS.nameCharacters + 64),
  mission: z.string().max(SAVED_AGENT_LIMITS.missionCharacters + 64),
  glyph: z.string().max(SAVED_AGENT_LIMITS.glyphCharacters + 64),
  color: z.string().max(16),
  roleName: optionalInputString(SAVED_AGENT_LIMITS.roleNameCharacters + 64),
  defaultModel: optionalInputString(SAVED_AGENT_LIMITS.modelIdCharacters + 64),
  permissionProfile: savedAgentPermissionProfileSchema.default('inherit'),
  browserEnabled: z.boolean().default(false),
  computerUseEnabled: z.boolean().default(false),
  preferredSkills: z.array(
    z.string().max(SAVED_AGENT_LIMITS.preferredSkillCharacters + 64)
  ).max(SAVED_AGENT_LIMITS.preferredSkills).default([]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  isPinned: z.boolean().default(false)
} as const

const savedAgentInputSchema = z.object({
  ...savedAgentInputFields,
  lastSessionId: uuidSchema.nullable().optional()
}).strict()

/** Exact raw-array shape written by the Swift SpecialistAgentStore. */
const legacySwiftSavedAgentSchema = z.object({
  ...savedAgentInputFields,
  lastSessionID: uuidSchema.nullable().optional()
}).strict()

export const localAgentSessionIdSchema = z.string()
  .min(1)
  .max(SAVED_AGENT_LIMITS.localSessionIdCharacters)
  .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value), 'Session id contains control characters')
  .refine(
    (value) => value !== '__proto__' && value !== 'prototype' && value !== 'constructor',
    'Session id is reserved'
  )

const sessionBindingsSchema = z.record(localAgentSessionIdSchema, uuidSchema).superRefine(
  (bindings, context) => {
    if (Object.keys(bindings).length > MAX_AGENT_SESSION_BINDINGS) {
      context.addIssue({
        code: 'custom',
        message: `Agent roster can contain at most ${MAX_AGENT_SESSION_BINDINGS} session bindings`
      })
    }
  }
)

const agentRosterInputSchema = z.object({
  version: z.literal(AGENT_ROSTER_VERSION),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  agents: z.array(savedAgentInputSchema).max(MAX_SAVED_AGENTS),
  sessionBindings: sessionBindingsSchema
}).strict()

const legacySwiftRosterSchema = z.array(legacySwiftSavedAgentSchema).max(MAX_SAVED_AGENTS)

export const agentRosterSchema = z.object({
  version: z.literal(AGENT_ROSTER_VERSION),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  agents: z.array(savedAgentSchema).max(MAX_SAVED_AGENTS),
  sessionBindings: sessionBindingsSchema
}).strict().superRefine(addRosterInvariantIssues)

export type SavedAgentPermissionProfile = z.infer<typeof savedAgentPermissionProfileSchema>
export type SavedAgent = z.infer<typeof savedAgentSchema>
export type AgentRoster = z.infer<typeof agentRosterSchema>

export interface SavedAgentDraft {
  id?: string
  name: string
  mission: string
  glyph?: string
  color?: string
  roleName?: string | null
  defaultModel?: string | null
  permissionProfile?: SavedAgentPermissionProfile
  browserEnabled?: boolean
  computerUseEnabled?: boolean
  preferredSkills?: string[]
  lastSessionId?: string | null
  isPinned?: boolean
}

export type SavedAgentUpdate = Omit<SavedAgent, 'createdAt' | 'updatedAt'>

export interface SavedAgentTemplate {
  readonly name: string
  readonly mission: string
  readonly glyph: string
  readonly color: string
  readonly roleName: string
  readonly permissionProfile: SavedAgentPermissionProfile
  readonly browserEnabled?: boolean
  readonly computerUseEnabled?: boolean
}

export const SAVED_AGENT_STARTER_CREW: readonly SavedAgentTemplate[] = Object.freeze([
  Object.freeze({
    name: 'Chief',
    mission: 'Route work, keep scope, synthesize final answer',
    glyph: 'crown.fill',
    color: '#5E5CE6',
    roleName: 'chief',
    permissionProfile: 'workspaceWrite'
  }),
  Object.freeze({
    name: 'Scout',
    mission: 'Research and source-backed briefs',
    glyph: 'binoculars',
    color: '#0A84FF',
    roleName: 'scout',
    permissionProfile: 'readOnly',
    browserEnabled: true
  }),
  Object.freeze({
    name: 'Builder',
    mission: 'Implement code, scripts, integrations',
    glyph: 'hammer.fill',
    color: '#FF9F0A',
    roleName: 'builder',
    permissionProfile: 'workspaceWrite'
  }),
  Object.freeze({
    name: 'Verifier',
    mission: 'Independent review, tests, claim checking',
    glyph: 'checkmark.shield.fill',
    color: '#30D158',
    roleName: 'verifier',
    permissionProfile: 'readOnly'
  }),
  Object.freeze({
    name: 'Operator',
    mission: 'Browser / SaaS / desktop workflows',
    glyph: 'desktopcomputer',
    color: '#FF375F',
    roleName: 'operator',
    permissionProfile: 'workspaceWrite',
    browserEnabled: true,
    computerUseEnabled: true
  })
])

export interface ParsedAgentRoster {
  roster: AgentRoster
  source: 'versioned' | 'swift-legacy'
}

export function emptyAgentRoster(): AgentRoster {
  return {
    version: AGENT_ROSTER_VERSION,
    revision: 0,
    agents: [],
    sessionBindings: {}
  }
}

/** Parse either Electron v1 or the Swift raw array without mutating the input. */
export function parseAgentRoster(value: unknown): ParsedAgentRoster {
  if (Array.isArray(value)) {
    const legacy = legacySwiftRosterSchema.parse(value)
    return {
      source: 'swift-legacy',
      roster: validateAgentRoster({
        version: AGENT_ROSTER_VERSION,
        revision: 0,
        agents: legacy.map((agent) => normalizeSavedAgent({
          ...agent,
          lastSessionId: agent.lastSessionID
        })),
        sessionBindings: {}
      })
    }
  }

  const input = agentRosterInputSchema.parse(value)
  return {
    source: 'versioned',
    roster: validateAgentRoster({
      version: AGENT_ROSTER_VERSION,
      revision: input.revision,
      agents: input.agents.map(normalizeSavedAgent),
      sessionBindings: normalizeSessionBindings(input.sessionBindings)
    })
  }
}

export function validateAgentRoster(value: unknown): AgentRoster {
  return agentRosterSchema.parse(value)
}

export function normalizeSavedAgent(
  value: z.infer<typeof savedAgentInputSchema>
): SavedAgent {
  const name = normalizedRequired(value.name)
  const mission = normalizedRequired(value.mission)
  const glyph = normalizedRequired(value.glyph)
  const color = canonicalizeAgentColor(value.color) ?? value.color.trim()
  const roleName = normalizedOptional(value.roleName)
  const defaultModel = normalizedOptional(value.defaultModel)
  const lastSessionId = value.lastSessionId ?? undefined
  const normalized = {
    id: value.id.toLowerCase(),
    name,
    mission,
    glyph,
    color,
    ...(roleName ? { roleName } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    permissionProfile: value.permissionProfile,
    browserEnabled: value.browserEnabled,
    computerUseEnabled: value.computerUseEnabled,
    preferredSkills: normalizePreferredSkills(value.preferredSkills),
    createdAt: canonicalTimestamp(value.createdAt),
    updatedAt: canonicalTimestamp(value.updatedAt),
    ...(lastSessionId ? { lastSessionId: lastSessionId.toLowerCase() } : {}),
    isPinned: value.isPinned
  }
  return savedAgentSchema.parse(normalized)
}

export function materializeSavedAgent(
  draft: SavedAgentDraft,
  identity: { id: string; now: string }
): SavedAgent {
  return normalizeSavedAgent(savedAgentInputSchema.parse({
    id: draft.id ?? identity.id,
    name: draft.name,
    mission: draft.mission,
    glyph: draft.glyph ?? 'person.fill',
    color: draft.color ?? '#5E5CE6',
    roleName: draft.roleName,
    defaultModel: draft.defaultModel,
    permissionProfile: draft.permissionProfile ?? 'inherit',
    browserEnabled: draft.browserEnabled ?? false,
    computerUseEnabled: draft.computerUseEnabled ?? false,
    preferredSkills: draft.preferredSkills ?? [],
    createdAt: identity.now,
    updatedAt: identity.now,
    lastSessionId: draft.lastSessionId,
    isPinned: draft.isPinned ?? false
  }))
}

export function materializeSavedAgentUpdate(
  update: SavedAgentUpdate,
  existing: SavedAgent,
  now: string
): SavedAgent {
  return normalizeSavedAgent(savedAgentInputSchema.parse({
    ...update,
    createdAt: existing.createdAt,
    updatedAt: now
  }))
}

export function canonicalizeAgentColor(raw: string): string | undefined {
  let hex = raw.trim()
  if (hex.startsWith('#')) hex = hex.slice(1)
  if (!/^(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/u.test(hex)) return undefined
  if (hex.length === 3) hex = Array.from(hex, (character) => `${character}${character}`).join('')
  return `#${hex.toUpperCase()}`
}

/** Swift-compatible role fallback derived from the display name. */
export function suggestedAgentRoleName(raw: string): string {
  let result = ''
  let lastWasSeparator = false
  for (const character of raw.trim()) {
    if (/^[\p{L}\p{N}_-]$/u.test(character)) {
      result += character
      lastWasSeparator = false
    } else if (!lastWasSeparator) {
      result += '-'
      lastWasSeparator = true
    }
  }
  return result.replace(/^[-_]+|[-_]+$/gu, '').toLocaleLowerCase('en-US')
}

export function effectiveAgentRoleName(agent: Pick<SavedAgent, 'name' | 'roleName'>): string {
  return agent.roleName ?? suggestedAgentRoleName(agent.name)
}

export function effectiveAgentRole(agent: Pick<SavedAgent, 'name' | 'roleName'>): string {
  return effectiveAgentRoleName(agent)
}

/**
 * Main/ACP-only inline profile. Keeping this construction beside roster
 * normalization prevents launch sites from producing a different role or prompt.
 */
export function inlineAcpAgentProfile(
  agent: Pick<SavedAgent, 'name' | 'mission' | 'roleName'>
): AcpAgentProfile {
  return acpAgentProfileSchema.parse({
    name: effectiveAgentRole(agent),
    description: agent.mission,
    promptBody: `You are ${agent.name}.\n\nInstructions: ${agent.mission}`
  })
}

export function agentIdentityKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US')
}

export function missingStarterCrewTemplates(
  agents: readonly Pick<SavedAgent, 'name'>[]
): SavedAgentTemplate[] {
  const names = new Set(agents.map((agent) => agentIdentityKey(agent.name)))
  return SAVED_AGENT_STARTER_CREW.filter((template) => !names.has(agentIdentityKey(template.name)))
}

function addRosterInvariantIssues(
  roster: AgentRoster,
  context: z.RefinementCtx
): void {
  const ids = new Set<string>()
  const names = new Map<string, number>()
  const roles = new Map<string, number>()

  roster.agents.forEach((agent, index) => {
    const id = agent.id.toLowerCase()
    if (ids.has(id)) {
      context.addIssue({ code: 'custom', path: ['agents', index, 'id'], message: 'Agent id must be unique' })
    }
    ids.add(id)

    const nameKey = agentIdentityKey(agent.name)
    if (names.has(nameKey)) {
      context.addIssue({ code: 'custom', path: ['agents', index, 'name'], message: 'Agent name must be unique' })
    } else {
      names.set(nameKey, index)
    }

    const effectiveRole = effectiveAgentRole(agent)
    if (!effectiveRole) {
      context.addIssue({
        code: 'custom',
        path: ['agents', index, 'roleName'],
        message: 'Agent must have an effective role name'
      })
      return
    }
    if (!acpAgentProfileSchema.shape.name.safeParse(effectiveRole).success) {
      context.addIssue({
        code: 'custom',
        path: ['agents', index, 'roleName'],
        message: 'Effective agent role is not a valid ACP agent name'
      })
    }
    const roleKey = agentIdentityKey(effectiveRole)
    if (RESERVED_AGENT_ROLE_NAMES.has(roleKey)) {
      context.addIssue({
        code: 'custom',
        path: ['agents', index, 'roleName'],
        message: 'Agent role name is reserved'
      })
    }
    if (roles.has(roleKey)) {
      context.addIssue({
        code: 'custom',
        path: ['agents', index, 'roleName'],
        message: 'Effective agent role must be unique'
      })
    } else {
      roles.set(roleKey, index)
    }
  })

  for (const [sessionId, agentId] of Object.entries(roster.sessionBindings)) {
    if (!ids.has(agentId.toLowerCase())) {
      context.addIssue({
        code: 'custom',
        path: ['sessionBindings', sessionId],
        message: 'Session binding must reference an existing agent'
      })
    }
  }
}

function normalizeSessionBindings(bindings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bindings).map(([sessionId, agentId]) => [sessionId, agentId.toLowerCase()])
  )
}

function normalizedRequired(value: string): string {
  return value.trim().normalize('NFC')
}

function normalizedOptional(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().normalize('NFC')
  return normalized ? normalized : undefined
}

function normalizePreferredSkills(skills: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const skill of skills) {
    const value = skill.trim().normalize('NFC')
    if (!value) continue
    const key = agentIdentityKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(value)
  }
  return normalized
}

function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString()
}
