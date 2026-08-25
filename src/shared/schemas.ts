import { z } from 'zod'
import { sessionActivitySnapshotSchema } from './acp/sessionActivity'
import {
  pendingInteractionSchema,
  publicPendingInteractionSchema
} from './acp/interactions'
import { attachmentItemSummarySchema } from './attachments'
import { turnTokenUsageSchema } from './acp/usage'
import { MAX_ACTIVITY_COUNT, activityEntrySchema, activityKindSchema } from './acp/activity'
import { workspaceHealthResultSchema } from './workspaceHealth'
import { SESSION_ACTIVITY_STATUSES } from './sessionPresentation'

const identifier = z.string().min(1).max(256)
const timestamp = z.string().min(1).max(64)
const boundedPath = z.string().min(1).max(4096)

export const publicSavedAgentSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(128),
  mission: z.string().min(1).max(2_048),
  glyph: z.string().min(1).max(128),
  color: z.string().regex(/^#[0-9A-F]{6}$/u),
  isPinned: z.boolean()
}).strict()

const publicBoundSavedAgentSummarySchema = z.object({
  name: z.string().min(1).max(128),
  glyph: z.string().min(1).max(128),
  color: z.string().regex(/^#[0-9A-F]{6}$/u)
}).strict()

export const publicAgentRosterSnapshotSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    agents: z.array(publicSavedAgentSummarySchema).max(24)
  }).strict(),
  z.object({
    status: z.literal('invalid'),
    revision: z.literal(0),
    reason: z.enum(['malformed', 'non-regular', 'symlink', 'oversize', 'unreadable'])
  }).strict()
])

const messageItemSchema = z.object({
  id: identifier,
  kind: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  text: z.string().max(2 * 1024 * 1024 + 64),
  createdAt: timestamp,
  streaming: z.boolean().optional(),
  attachments: z.array(attachmentItemSummarySchema).min(1).max(16).optional()
}).strict()

const thoughtItemSchema = z.object({
  id: identifier,
  kind: z.literal('thought'),
  text: z.string().max(2 * 1024 * 1024 + 64),
  createdAt: timestamp,
  streaming: z.boolean().optional()
}).strict()

const toolItemSchema = z.object({
  id: identifier,
  kind: z.literal('tool'),
  title: z.string().max(2_000),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  detail: z.string().max(256 * 1024).optional(),
  activityKind: activityKindSchema.optional(),
  createdAt: timestamp
}).strict()

const activityItemSchema = z.object({
  id: identifier,
  kind: z.literal('activity'),
  entries: z.array(activityEntrySchema).min(1).max(11),
  hookCount: z.number().int().nonnegative().max(MAX_ACTIVITY_COUNT),
  isLead: z.boolean(),
  open: z.boolean().optional(),
  createdAt: timestamp
}).strict()

const planItemSchema = z.object({
  id: identifier,
  kind: z.literal('plan'),
  entries: z.array(z.object({
    text: z.string().max(20_000),
    status: z.enum(['pending', 'in_progress', 'completed'])
  }).strict()).max(200),
  createdAt: timestamp
}).strict()

const errorItemSchema = z.object({
  id: identifier,
  kind: z.literal('error'),
  text: z.string().max(64 * 1024),
  createdAt: timestamp
}).strict()

const noticeItemSchema = z.object({
  id: identifier,
  kind: z.literal('notice'),
  text: z.string().max(64 * 1024),
  createdAt: timestamp
}).strict()

export const transcriptItemSchema = z.discriminatedUnion('kind', [
  messageItemSchema,
  thoughtItemSchema,
  toolItemSchema,
  activityItemSchema,
  planItemSchema,
  errorItemSchema,
  noticeItemSchema
])

export const permissionOptionSchema = z.object({
  id: identifier,
  label: z.string().min(1).max(2_000),
  intent: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']).optional()
}).strict()

export const pendingPermissionSchema = z.object({
  requestId: identifier,
  sessionId: identifier,
  title: z.string().min(1).max(2_000),
  description: z.string().max(20_000).optional(),
  options: z.array(permissionOptionSchema).max(32)
}).strict()

export const publicPendingPermissionSchema = pendingPermissionSchema
  .omit({ sessionId: true })
  .strict()

export const sessionSnapshotSchema = z.object({
  id: identifier,
  acpSessionId: identifier.optional(),
  projectId: identifier,
  title: z.string().min(1).max(2_000),
  status: z.enum(['idle', 'starting', 'running', 'waiting', 'failed']),
  model: z.string().min(1).max(128),
  mode: z.enum(['default', 'plan', 'ask', 'yolo']),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  permissionMode: z.enum(['ask', 'auto']).default('ask'),
  availableModels: z.array(z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    contextLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  }).strict()).max(64).optional(),
  availableModes: z.array(z.object({
    id: z.enum(['default', 'plan', 'ask', 'yolo']),
    name: z.string().min(1).max(128)
  }).strict()).max(8).optional(),
  contextUsed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  contextLimit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastTurnUsage: turnTokenUsageSchema.optional(),
  pendingHookRuns: z.number().int().positive().max(MAX_ACTIVITY_COUNT).optional(),
  transcript: z.array(transcriptItemSchema).max(4_000),
  pendingPermission: pendingPermissionSchema.optional(),
  pendingInteraction: pendingInteractionSchema.optional(),
  lastError: z.string().max(64 * 1024).optional(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict()

export const publicSessionSnapshotSchema = sessionSnapshotSchema
  .omit({
    acpSessionId: true,
    pendingPermission: true,
    pendingInteraction: true
  })
  .extend({
    canFork: z.boolean(),
    activityStatus: z.enum(SESSION_ACTIVITY_STATUSES),
    hasUnreadCompletion: z.boolean(),
    pendingUserCount: z.number().int().nonnegative().max(128),
    workingSince: z.string().datetime({ offset: true }).optional(),
    activities: sessionActivitySnapshotSchema.optional(),
    savedAgentId: z.string().uuid().optional(),
    savedAgent: publicBoundSavedAgentSummarySchema.optional(),
    pendingPermission: publicPendingPermissionSchema.optional(),
    pendingInteraction: publicPendingInteractionSchema.optional()
  })
  .strict()

export const projectSnapshotSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(2_000),
  path: boundedPath,
  sessionIds: z.array(identifier).max(10_000),
  createdAt: timestamp
}).strict()

const legacyAppSettingsSchema = z.object({
  appearance: z.enum(['system', 'light', 'dark']),
  reduceMotion: z.boolean(),
  grokCliPath: boundedPath,
  maxLiveSessions: z.number().int().min(1).max(8)
}).strict()

export const appSettingsSchema = legacyAppSettingsSchema.extend({
  privacyMode: z.boolean(),
  memoryEnabled: z.boolean()
}).strict()

const persistedStateV1Schema = z.object({
  version: z.literal(1).optional(),
  projects: z.array(projectSnapshotSchema).max(2_000),
  sessions: z.array(sessionSnapshotSchema).max(10_000),
  selectedProjectId: identifier.optional(),
  selectedSessionId: identifier.optional(),
  settings: legacyAppSettingsSchema
}).strict()

const persistedStateV2Schema = z.object({
  version: z.literal(2),
  projects: z.array(projectSnapshotSchema).max(2_000),
  sessions: z.array(sessionSnapshotSchema).max(10_000),
  pinnedProjectIds: z.array(identifier).max(5),
  pinnedSessionIds: z.array(identifier).max(20),
  selectedProjectId: identifier.optional(),
  selectedSessionId: identifier.optional(),
  settings: legacyAppSettingsSchema
}).strict()

const selectedSessionIdByProjectSchema = z.record(identifier, identifier).superRefine(
  (selections, context) => {
    if (Object.keys(selections).length > 2_000) {
      context.addIssue({
        code: 'custom',
        message: 'Workspace session selections exceed the persistence limit'
      })
    }
  }
)

const persistedStateV3Schema = z.object({
  version: z.literal(3),
  projects: z.array(projectSnapshotSchema).max(2_000),
  sessions: z.array(sessionSnapshotSchema).max(10_000),
  pinnedProjectIds: z.array(identifier).max(5),
  pinnedSessionIds: z.array(identifier).max(20),
  selectedSessionIdByProject: selectedSessionIdByProjectSchema,
  selectedProjectId: identifier.optional(),
  selectedSessionId: identifier.optional(),
  settings: legacyAppSettingsSchema
}).strict()

const persistedStateV4Schema = z.object({
  version: z.literal(4),
  projects: z.array(projectSnapshotSchema).max(2_000),
  sessions: z.array(sessionSnapshotSchema).max(10_000),
  pinnedProjectIds: z.array(identifier).max(5),
  pinnedSessionIds: z.array(identifier).max(20),
  settledSessionIds: z.array(identifier).max(10_000),
  selectedSessionIdByProject: selectedSessionIdByProjectSchema,
  selectedProjectId: identifier.optional(),
  selectedSessionId: identifier.optional(),
  settings: legacyAppSettingsSchema
}).strict()

export const persistedStateSchema = z.object({
  version: z.literal(5),
  projects: z.array(projectSnapshotSchema).max(2_000),
  sessions: z.array(sessionSnapshotSchema).max(10_000),
  pinnedProjectIds: z.array(identifier).max(5),
  pinnedSessionIds: z.array(identifier).max(20),
  settledSessionIds: z.array(identifier).max(10_000),
  selectedSessionIdByProject: selectedSessionIdByProjectSchema,
  selectedProjectId: identifier.optional(),
  selectedSessionId: identifier.optional(),
  settings: appSettingsSchema
}).strict().superRefine((state, context) => {
  addDuplicateIdIssues(state.projects, 'projects', context)
  addDuplicateIdIssues(state.sessions, 'sessions', context)
  const projectIds = new Set(state.projects.map((project) => project.id))
  const sessionsById = new Map(state.sessions.map((session) => [session.id, session]))
  for (const [projectId, sessionId] of Object.entries(state.selectedSessionIdByProject)) {
    const session = sessionsById.get(sessionId)
    if (!projectIds.has(projectId) || session?.projectId !== projectId) {
      context.addIssue({
        code: 'custom',
        path: ['selectedSessionIdByProject', projectId],
        message: 'Workspace session selection must reference a session in that project'
      })
    }
  }
})

export function parsePersistedState(value: unknown): PersistedStateData {
  const version = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as { version?: unknown }).version
    : undefined
  if (version === undefined || version === 1) {
    const legacy = persistedStateV1Schema.parse(value)
    const selectedSessionIdByProject = legacySelectionMap(legacy)
    return normalizePersistedSessionTracking(persistedStateSchema.parse({
      version: 5,
      projects: legacy.projects,
      sessions: legacy.sessions,
      pinnedProjectIds: [],
      pinnedSessionIds: [],
      settledSessionIds: [],
      selectedSessionIdByProject,
      ...(legacy.selectedProjectId ? { selectedProjectId: legacy.selectedProjectId } : {}),
      ...(legacy.selectedSessionId ? { selectedSessionId: legacy.selectedSessionId } : {}),
      settings: migrateLegacySettings(legacy.settings)
    }))
  }
  if (version === 2) {
    const legacy = persistedStateV2Schema.parse(value)
    const selectedSessionIdByProject = legacySelectionMap(legacy)
    return normalizePersistedSessionTracking(persistedStateSchema.parse({
      ...legacy,
      version: 5,
      settledSessionIds: [],
      selectedSessionIdByProject,
      settings: migrateLegacySettings(legacy.settings)
    }))
  }
  if (version === 3) {
    const legacy = persistedStateV3Schema.parse(value)
    return normalizePersistedSessionTracking(persistedStateSchema.parse({
      ...legacy,
      version: 5,
      settledSessionIds: [],
      settings: migrateLegacySettings(legacy.settings)
    }))
  }
  if (version === 4) {
    const legacy = persistedStateV4Schema.parse(value)
    return normalizePersistedSessionTracking(persistedStateSchema.parse({
      ...legacy,
      version: 5,
      settings: migrateLegacySettings(legacy.settings)
    }))
  }
  return normalizePersistedSessionTracking(persistedStateSchema.parse(value))
}

function migrateLegacySettings(
  settings: z.infer<typeof legacyAppSettingsSchema>
): z.infer<typeof appSettingsSchema> {
  return {
    ...settings,
    privacyMode: false,
    memoryEnabled: false
  }
}

function normalizePersistedSessionTracking(
  state: z.infer<typeof persistedStateSchema>
): z.infer<typeof persistedStateSchema> {
  const validSessionIds = new Set(state.sessions.map((session) => session.id))
  const pinnedSessionIds = new Set(state.pinnedSessionIds)
  const seen = new Set<string>()
  return {
    ...state,
    settledSessionIds: state.settledSessionIds.filter((sessionId) =>
      validSessionIds.has(sessionId) &&
      !pinnedSessionIds.has(sessionId) &&
      !seen.has(sessionId) &&
      Boolean(seen.add(sessionId))
    )
  }
}

function addDuplicateIdIssues(
  values: readonly { id: string }[],
  path: 'projects' | 'sessions',
  context: z.RefinementCtx
): void {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) {
      context.addIssue({
        code: 'custom',
        path: [path, index, 'id'],
        message: `${path === 'projects' ? 'Project' : 'Session'} ids must be unique`
      })
    }
    seen.add(value.id)
  }
}

function legacySelectionMap(state: {
  projects: Array<z.infer<typeof projectSnapshotSchema>>
  sessions: Array<z.infer<typeof sessionSnapshotSchema>>
  selectedSessionId?: string | undefined
}): Record<string, string> {
  if (!state.selectedSessionId) return {}
  const session = state.sessions.find((candidate) => candidate.id === state.selectedSessionId)
  const project = session
    ? state.projects.find((candidate) =>
        candidate.id === session.projectId && candidate.sessionIds.includes(session.id)
      )
    : undefined
  if (!session || !project || (!session.acpSessionId && session.transcript.length === 0)) return {}
  return { [project.id]: session.id }
}

export const appSnapshotSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  projects: z.array(projectSnapshotSchema).max(2_000),
  sessions: z.array(publicSessionSnapshotSchema).max(10_000),
  pinnedProjectIds: z.array(identifier).max(5),
  pinnedSessionIds: z.array(identifier).max(20),
  settledSessionIds: z.array(identifier).max(10_000),
  unreadSessionIds: z.array(identifier).max(10_000),
  selectedProjectId: identifier.optional(),
  selectedSessionId: identifier.optional(),
  settings: appSettingsSchema,
  workspaceHealth: z.array(workspaceHealthResultSchema).max(2_000),
  agentRoster: publicAgentRosterSnapshotSchema,
  cli: z.object({
    available: z.boolean(),
    path: boundedPath,
    version: z.string().max(256).optional()
  }).strict(),
  appVersion: z.string().min(1).max(256)
}).strict().superRefine((snapshot, context) => {
  const projectIds = new Set(snapshot.projects.map((project) => project.id))
  const sessionIds = new Set(snapshot.sessions.map((session) => session.id))
  const pinnedSessionIds = new Set(snapshot.pinnedSessionIds)
  const agentsById = snapshot.agentRoster.status === 'ready'
    ? new Map(snapshot.agentRoster.agents.map((agent) => [agent.id, agent]))
    : new Map<string, never>()
  snapshot.sessions.forEach((session, index) => {
    if (!session.savedAgentId && !session.savedAgent) return
    const agent = session.savedAgentId ? agentsById.get(session.savedAgentId) : undefined
    if (
      !session.savedAgentId ||
      !session.savedAgent ||
      !agent ||
      agent.name !== session.savedAgent.name ||
      agent.glyph !== session.savedAgent.glyph ||
      agent.color !== session.savedAgent.color
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sessions', index, 'savedAgentId'],
        message: 'Session saved-agent summary must match the ready local roster'
      })
    }
  })
  for (const [field, ids] of [
    ['settledSessionIds', snapshot.settledSessionIds],
    ['unreadSessionIds', snapshot.unreadSessionIds]
  ] as const) {
    const tracked = new Set<string>()
    ids.forEach((sessionId, index) => {
      if (!sessionIds.has(sessionId) || tracked.has(sessionId)) {
        context.addIssue({
          code: 'custom',
          path: [field, index],
          message: `${field} must contain unique local session ids`
        })
      }
      if (field === 'settledSessionIds' && pinnedSessionIds.has(sessionId)) {
        context.addIssue({
          code: 'custom',
          path: [field, index],
          message: 'Pinned sessions cannot also be settled'
        })
      }
      tracked.add(sessionId)
    })
  }
  const seen = new Set<string>()
  for (const [index, health] of snapshot.workspaceHealth.entries()) {
    if (!projectIds.has(health.projectId)) {
      context.addIssue({
        code: 'custom',
        path: ['workspaceHealth', index, 'projectId'],
        message: 'Workspace health must reference a registered project'
      })
    }
    if (seen.has(health.projectId)) {
      context.addIssue({
        code: 'custom',
        path: ['workspaceHealth', index, 'projectId'],
        message: 'Workspace health project ids must be unique'
      })
    }
    seen.add(health.projectId)
  }
  if (seen.size !== projectIds.size) {
    context.addIssue({
      code: 'custom',
      path: ['workspaceHealth'],
      message: 'Every registered project requires one workspace health result'
    })
  }
})

export type PersistedStateData = z.infer<typeof persistedStateSchema>
