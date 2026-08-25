import type { PublicGrokAgentCatalog, GrokAgentSourceKind } from '../../shared/agentCatalog'
import type {
  PublicAgentRosterSnapshot,
  PublicSavedAgentSummary,
  PublicSessionSnapshot
} from '../../shared/models'
import { sidebarValuesMatch } from '../../shared/sessionPresentation'
import {
  RESERVED_AGENT_ROLE_NAMES,
  agentIdentityKey,
  suggestedAgentRoleName
} from '../../shared/agents'

export interface SidebarAgentPresentation {
  agent: PublicSavedAgentSummary
  boundSessions: PublicSessionSnapshot[]
  targetSessionId?: string
  status: 'working' | 'ready'
}

export interface GrokAgentCatalogViewEntry {
  name: string
  description: string
  sourceKind: GrokAgentSourceKind
  pluginDisplayName?: string
}

export interface GrokAgentCatalogViewGroup {
  sourceKind: GrokAgentSourceKind
  label: string
  entries: GrokAgentCatalogViewEntry[]
}

const CATALOG_GROUPS: readonly Pick<GrokAgentCatalogViewGroup, 'sourceKind' | 'label'>[] = [
  { sourceKind: 'project', label: 'Project' },
  { sourceKind: 'user', label: 'User' },
  { sourceKind: 'plugin', label: 'Plug-ins' },
  { sourceKind: 'builtin', label: 'Built-in' }
]

function timestampValue(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Derive the sidebar roster exclusively from public binding summaries. No raw
 * roster binding table or launch identity crosses into the renderer.
 */
export function sidebarAgentPresentations(
  roster: PublicAgentRosterSnapshot,
  sessions: readonly PublicSessionSnapshot[],
  options: { showAll: boolean; query: string }
): SidebarAgentPresentation[] {
  if (roster.status !== 'ready') return []

  return roster.agents.flatMap((agent) => {
    const boundSessions = sessions
      .filter((session) => session.savedAgentId === agent.id)
      .sort((left, right) =>
        timestampValue(right.updatedAt) - timestampValue(left.updatedAt) ||
        left.title.localeCompare(right.title)
      )
    const active = agent.isPinned || boundSessions.length > 0
    if (!options.showAll && !active) return []
    if (!sidebarValuesMatch(options.query, [agent.name, agent.mission])) return []

    const targetSessionId = boundSessions[0]?.id
    const presentation: SidebarAgentPresentation = {
      agent,
      boundSessions,
      ...(targetSessionId ? { targetSessionId } : {}),
      status: boundSessions.some((session) => session.activityStatus === 'working')
        ? 'working'
        : 'ready'
    }
    return [presentation]
  }).sort((left, right) =>
    Number(right.status === 'working') - Number(left.status === 'working') ||
    Number(right.agent.isPinned) - Number(left.agent.isPinned) ||
    left.agent.name.localeCompare(right.agent.name)
  )
}

/**
 * Short-lived catalog tokens are intentionally discarded before catalog data
 * enters component state. The remaining shape is display-only.
 */
export function sanitizeGrokAgentCatalog(
  catalog: PublicGrokAgentCatalog
): GrokAgentCatalogViewEntry[] {
  return catalog.map((entry) => ({
    name: entry.name,
    description: entry.description,
    sourceKind: entry.sourceKind,
    ...(entry.pluginDisplayName ? { pluginDisplayName: entry.pluginDisplayName } : {})
  }))
}

export function groupGrokAgentCatalog(
  entries: readonly GrokAgentCatalogViewEntry[]
): GrokAgentCatalogViewGroup[] {
  return CATALOG_GROUPS.flatMap((group) => {
    const matching = entries.filter((entry) => entry.sourceKind === group.sourceKind)
    return matching.length > 0 ? [{ ...group, entries: matching }] : []
  })
}

export function savedAgentNameValidationError(
  name: string,
  agents: readonly Pick<PublicSavedAgentSummary, 'id' | 'name'>[],
  editingAgentId?: string
): string | undefined {
  const normalizedName = agentIdentityKey(name)
  if (!normalizedName) return 'Enter a name.'
  const suggestedRole = suggestedAgentRoleName(name)
  if (!suggestedRole) return 'Use at least one letter or number in the name.'
  if (RESERVED_AGENT_ROLE_NAMES.has(suggestedRole)) {
    return 'This name is reserved by Grok. Choose a more specific name.'
  }
  if (agents.some((agent) =>
    agent.id !== editingAgentId && agentIdentityKey(agent.name) === normalizedName
  )) {
    return 'A Saved Agent already uses this name.'
  }
  return undefined
}
