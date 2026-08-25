import type { AttachmentItemSummary } from './attachments'
import type { PendingInteraction, PublicPendingInteraction } from './acp/interactions'
import type { TurnTokenUsage } from './acp/usage'
import type { ActivityEntry, ActivityKind } from './acp/activity'
import type { WorkspaceHealthResult } from './workspaceHealth'
import type { SessionActivityStatus } from './sessionPresentation'

export type SessionStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'failed'

export type TranscriptItem =
  | {
      id: string
      kind: 'message'
      role: 'user' | 'assistant'
      text: string
      createdAt: string
      streaming?: boolean
      /** Bounded display metadata for the attachments this user turn carried. */
      attachments?: AttachmentItemSummary[]
    }
  | {
      id: string
      kind: 'thought'
      text: string
      createdAt: string
      streaming?: boolean
    }
  | {
      id: string
      kind: 'tool'
      title: string
      status: 'pending' | 'running' | 'completed' | 'failed'
      detail?: string
      activityKind?: ActivityKind
      /** Main-validated images this tool call generated, with bounded previews. */
      images?: Array<{ path: string; preview?: string }>
      createdAt: string
    }
  | {
      id: string
      kind: 'activity'
      entries: ActivityEntry[]
      hookCount: number
      isLead: boolean
      open?: boolean
      createdAt: string
    }
  | {
      id: string
      kind: 'plan'
      entries: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }>
      createdAt: string
    }
  | {
      id: string
      kind: 'error'
      text: string
      createdAt: string
    }
  | {
      id: string
      kind: 'notice'
      text: string
      createdAt: string
    }

export interface PermissionOption {
  id: string
  label: string
  intent?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface PendingPermission {
  requestId: string
  sessionId: string
  title: string
  description?: string
  options: PermissionOption[]
}

export type PublicPendingPermission = Omit<PendingPermission, 'sessionId'>

export interface PublicSavedAgentSummary {
  id: string
  name: string
  mission: string
  glyph: string
  color: string
  isPinned: boolean
}

export interface PublicBoundSavedAgentSummary {
  name: string
  glyph: string
  color: string
}

export type PublicAgentRosterSnapshot =
  | {
      status: 'ready'
      revision: number
      agents: PublicSavedAgentSummary[]
    }
  | {
      status: 'invalid'
      revision: 0
      reason: 'malformed' | 'non-regular' | 'symlink' | 'oversize' | 'unreadable'
    }

export interface SessionSnapshot {
  id: string
  acpSessionId?: string
  projectId: string
  title: string
  status: SessionStatus
  model: string
  mode: 'default' | 'plan' | 'ask' | 'yolo'
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  permissionMode: 'ask' | 'auto'
  availableModels?: Array<{ id: string; name: string; contextLimit?: number | undefined }>
  availableModes?: Array<{ id: 'default' | 'plan' | 'ask' | 'yolo'; name: string }>
  contextUsed: number
  contextLimit: number
  lastTurnUsage?: TurnTokenUsage
  /** Safe transient count waiting to attach to the next activity group. */
  pendingHookRuns?: number
  transcript: TranscriptItem[]
  pendingPermission?: PendingPermission
  pendingInteraction?: PendingInteraction
  lastError?: string
  createdAt: string
  updatedAt: string
}

export type PublicSessionSnapshot = Omit<
  SessionSnapshot,
  'acpSessionId' | 'pendingPermission' | 'pendingInteraction'
> & {
  canFork: boolean
  activityStatus: SessionActivityStatus
  hasUnreadCompletion: boolean
  pendingUserCount: number
  workingSince?: string
  activities?: import('./acp/sessionActivity').SessionActivitySnapshot
  savedAgentId?: string
  savedAgent?: PublicBoundSavedAgentSummary
  pendingPermission?: PublicPendingPermission
  pendingInteraction?: PublicPendingInteraction
}

export interface ProjectSnapshot {
  id: string
  name: string
  path: string
  sessionIds: string[]
  createdAt: string
}

export interface AppSettings {
  appearance: 'system' | 'light' | 'dark'
  reduceMotion: boolean
  grokCliPath: string
  maxLiveSessions: number
  privacyMode: boolean
  memoryEnabled: boolean
}

export interface AppSnapshot {
  revision: number
  projects: ProjectSnapshot[]
  sessions: PublicSessionSnapshot[]
  pinnedProjectIds: string[]
  pinnedSessionIds: string[]
  settledSessionIds: string[]
  unreadSessionIds: string[]
  selectedProjectId?: string
  selectedSessionId?: string
  settings: AppSettings
  workspaceHealth: WorkspaceHealthResult[]
  agentRoster: PublicAgentRosterSnapshot
  cli: {
    available: boolean
    path: string
    version?: string
  }
  appVersion: string
}

export interface SessionEvent {
  type: 'snapshot'
  snapshot: AppSnapshot
}
