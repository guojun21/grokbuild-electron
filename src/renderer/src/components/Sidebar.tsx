import brandIcon from '../assets/brand-icon.png'
import { useEffect, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  Folder,
  GitFork,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  UsersRound,
  X
} from 'lucide-react'
import type {
  AppSnapshot,
  ProjectSnapshot,
  PublicSessionSnapshot
} from '../../../shared/models'
import {
  canSettleSession,
  sessionStatusLabel,
  sidebarProjectMatches,
  sidebarValuesMatch
} from '../../../shared/sessionPresentation'
import type { WorkspaceHealthState } from '../../../shared/workspaceHealth'
import type { PrivacyDisplayResolver } from '../../../shared/privacy'
import { sidebarAgentPresentations } from '../agentPresentation'
import { AgentAvatar } from './AgentAvatar'

interface SidebarProps {
  snapshot: AppSnapshot
  overlayOpen: boolean
  privacy: PrivacyDisplayResolver
  onAddProject: () => void
  onCreateSession: (projectId: string) => void
  onSelectProject: (projectId: string) => void
  onSelectSession: (sessionId: string) => void
  onRemoveProject: (projectId: string) => void
  onCloseSession: (sessionId: string) => void
  onDuplicateSession: (sessionId: string) => void
  onForkSession: (sessionId: string) => void
  onSetProjectPinned: (projectId: string, pinned: boolean) => void
  onMoveProject: (projectId: string, direction: 'up' | 'down') => void
  onSetSessionPinned: (sessionId: string, pinned: boolean) => void
  onSetSessionSettled: (sessionId: string, settled: boolean) => void
  onSetSessionUnread: (sessionId: string, unread: boolean) => void
  onOpenSettings: () => void
}

type MenuTarget = `project:${string}` | `session:${string}`

export function Sidebar({
  snapshot,
  overlayOpen,
  privacy,
  onAddProject,
  onCreateSession,
  onSelectProject,
  onSelectSession,
  onRemoveProject,
  onCloseSession,
  onDuplicateSession,
  onForkSession,
  onSetProjectPinned,
  onMoveProject,
  onSetSessionPinned,
  onSetSessionSettled,
  onSetSessionUnread,
  onOpenSettings
}: SidebarProps): React.JSX.Element {
  const [openMenu, setOpenMenu] = useState<MenuTarget>()
  const [removeConfirmation, setRemoveConfirmation] = useState<string>()
  const [filter, setFilter] = useState('')
  const [showAllAgents, setShowAllAgents] = useState(false)
  const [settledExpanded, setSettledExpanded] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const sessionsById = new Map(snapshot.sessions.map((session) => [session.id, session]))
  const projectsById = new Map(snapshot.projects.map((project) => [project.id, project]))
  const pinnedProjectIds = new Set(snapshot.pinnedProjectIds)
  const pinnedSessionIds = new Set(snapshot.pinnedSessionIds)
  const settledSessionIds = new Set(snapshot.settledSessionIds)
  const projectOrdinals = new Map(snapshot.projects.map((project, index) => [project.id, index + 1]))
  const sessionOrdinals = new Map(snapshot.sessions.map((session, index) => [session.id, index + 1]))
  const agentOrdinals = snapshot.agentRoster.status === 'ready'
    ? new Map(snapshot.agentRoster.agents.map((agent, index) => [agent.id, index + 1]))
    : new Map<string, number>()
  const workspaceHealthByProject = new Map(
    snapshot.workspaceHealth.map((health) => [health.projectId, health.state])
  )
  const agentsById = snapshot.agentRoster.status === 'ready'
    ? new Map(snapshot.agentRoster.agents.map((agent) => [agent.id, agent]))
    : new Map()
  const normalizedFilter = filter.trim()
  const isFiltering = normalizedFilter.length > 0
  const orderedProjects = snapshot.projects.filter((project) => sidebarProjectMatches(
    normalizedFilter,
    project.name,
    project.sessionIds
      .filter((id) => !pinnedSessionIds.has(id) && !settledSessionIds.has(id))
      .flatMap((id) => {
        const session = sessionsById.get(id)
        const agent = session?.savedAgentId ? agentsById.get(session.savedAgentId) : undefined
        return session ? [{
          title: session.title,
          ...(agent?.mission ? { roleName: agent.mission } : {}),
          ...(session.savedAgent?.name ? { specialistName: session.savedAgent.name } : {})
        }] : []
      })
  ))
  const pinnedSessions = snapshot.pinnedSessionIds.flatMap((id) => {
    const session = sessionsById.get(id)
    const project = session ? projectsById.get(session.projectId) : undefined
    const agent = session?.savedAgentId ? agentsById.get(session.savedAgentId) : undefined
    return session && project && sidebarValuesMatch(normalizedFilter, [
      session.title,
      project.name,
      session.savedAgent?.name ?? '',
      agent?.mission ?? ''
    ])
      ? [session]
      : []
  })
  const settledSessions = snapshot.settledSessionIds.flatMap((id) => {
    const session = sessionsById.get(id)
    const project = session ? projectsById.get(session.projectId) : undefined
    const agent = session?.savedAgentId ? agentsById.get(session.savedAgentId) : undefined
    return session && project && sidebarValuesMatch(normalizedFilter, [
      session.title,
      project.name,
      session.savedAgent?.name ?? '',
      agent?.mission ?? ''
    ])
      ? [session]
      : []
  })
  const sidebarAgents = sidebarAgentPresentations(snapshot.agentRoster, snapshot.sessions, {
    showAll: showAllAgents || isFiltering,
    query: normalizedFilter
  })
  const hasWorkingSession = snapshot.sessions.some((session) => session.activityStatus === 'working')

  useEffect(() => {
    if (!hasWorkingSession) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hasWorkingSession])

  useEffect(() => {
    if (!overlayOpen) return
    setOpenMenu(undefined)
    setRemoveConfirmation(undefined)
  }, [overlayOpen])

  useEffect(() => {
    if (isFiltering) setOpenMenu(undefined)
  }, [isFiltering])

  useEffect(() => {
    if (!privacy.enabled) return
    setFilter('')
    setOpenMenu(undefined)
    setRemoveConfirmation(undefined)
  }, [privacy.enabled])

  const closeMenuThen = (action: () => void): void => {
    setOpenMenu(undefined)
    action()
  }

  const renderSession = (
    session: PublicSessionSnapshot,
    project: ProjectSnapshot,
    pinned: boolean
  ): React.JSX.Element => {
    const menuId = `session:${session.id}` as const
    const sessionName = privacy.sessionTitle(session.title, sessionOrdinals.get(session.id))
    const projectName = privacy.projectName(project.name, projectOrdinals.get(project.id))
    const agentName = session.savedAgent
      ? privacy.savedAgentName(
          session.savedAgent.name,
          session.savedAgentId ? agentOrdinals.get(session.savedAgentId) : undefined
        )
      : undefined
    const workspaceReady = workspaceHealthByProject.get(project.id) === 'ready'
    const settled = settledSessionIds.has(session.id)
    const statusLabel = sessionStatusLabel({
      status: session.activityStatus,
      ...(session.workingSince && !Number.isNaN(Date.parse(session.workingSince))
        ? { workingSinceMs: Date.parse(session.workingSince) }
        : {}),
      nowMs
    })
    const testId = pinned
      ? `pinned-session-${session.id}`
      : settled
        ? `settled-session-${session.id}`
        : `session-${session.id}`
    return (
      <div className={`session-row-shell ${pinned ? 'pinned' : ''} ${settled ? 'settled' : ''}`} key={session.id}>
        <button
          className={`session-row ${session.id === snapshot.selectedSessionId ? 'selected' : ''}`}
          type="button"
          onClick={() => onSelectSession(session.id)}
          data-testid={testId}
          aria-label={`Open ${sessionName}`}
          title={`${sessionName}${agentName ? ` — ${agentName}` : ''}${pinned || settled ? ` — ${projectName}` : ''}${statusLabel ? ` — ${statusLabel}` : ''}`}
        >
          <SessionIndicator status={session.activityStatus} />
          <span className="session-name">
            <span>{sessionName}</span>
            {pinned || settled ? <small>{projectName}</small> : null}
          </span>
          <span className="session-row-meta">
            {session.savedAgent ? (
              <span className="session-agent-badge" title={`Saved Agent: ${agentName}`}>
                <AgentAvatar glyph={session.savedAgent.glyph} color={session.savedAgent.color} label={agentName ?? 'Saved Agent'} size="small" redacted={privacy.enabled} />
              </span>
            ) : null}
            {statusLabel ? <span className={`session-status status-${session.activityStatus}`}>{statusLabel}</span> : null}
          </span>
        </button>
        <button
          className="row-menu-trigger"
          type="button"
          aria-label={`Actions for session ${sessionName}`}
          aria-expanded={openMenu === menuId}
          onClick={() => setOpenMenu(openMenu === menuId ? undefined : menuId)}
        >
          <MoreHorizontal size={14} />
        </button>
        {openMenu === menuId ? (
          <div className="row-action-menu" role="menu" aria-label={`Session actions for ${sessionName}`}>
            <button type="button" role="menuitem" onClick={() => closeMenuThen(() => onSetSessionPinned(session.id, !pinned))}>
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
              {pinned ? 'Unpin Session' : 'Pin Session'}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!settled && !canSettleSession(session.activityStatus)}
              title={!settled && !canSettleSession(session.activityStatus)
                ? 'Working sessions and sessions waiting for input cannot be settled.'
                : undefined}
              onClick={() => closeMenuThen(() => onSetSessionSettled(session.id, !settled))}
            >
              {settled ? <ArchiveRestore size={13} /> : <Archive size={13} />}
              {settled ? 'Return to Active' : 'Settle Session'}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => closeMenuThen(() => onSetSessionUnread(session.id, !session.hasUnreadCompletion))}
            >
              {session.hasUnreadCompletion ? <Eye size={13} /> : <EyeOff size={13} />}
              {session.hasUnreadCompletion ? 'Mark as Read' : 'Mark as Unread'}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!workspaceReady}
              title={workspaceReady ? undefined : 'Restore the workspace before duplicating this chat.'}
              onClick={() => closeMenuThen(() => onDuplicateSession(session.id))}
            >
              <Copy size={13} /> Duplicate Session
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!session.canFork}
              title={session.canFork
                ? 'Fork Session'
                : 'Fork Session requires an idle, started chat in a ready workspace and Grok CLI 1.0.5 or newer.'}
              onClick={() => closeMenuThen(() => onForkSession(session.id))}
            >
              <GitFork size={13} /> Fork Session
            </button>
            <span className="menu-separator" />
            <button className="danger-menu-item" type="button" role="menuitem" onClick={() => closeMenuThen(() => onCloseSession(session.id))}>
              <X size={13} /> Close Session
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <aside className="sidebar" aria-label="Projects and chats">
      <div className="sidebar-titlebar" aria-hidden="true" />
      <div className="sidebar-header">
        <div className="brand-lockup">
          <span className="brand-mark"><img src={brandIcon} alt="" draggable={false} /></span>
          <span>GrokBuild</span>
        </div>
        <button className="icon-button" type="button" onClick={onAddProject} aria-label="Add project">
          <Plus size={16} />
        </button>
      </div>

      <button className="add-project" type="button" onClick={onAddProject}>
        <Plus size={14} />
        Add Project
      </button>

      <div className="sidebar-search">
        <Search size={13} aria-hidden="true" />
        <input
          type="search"
          value={privacy.enabled ? '' : filter}
          aria-label="Filter agents, projects, and sessions"
          placeholder={privacy.enabled ? 'Search hidden while private' : 'Filter agents, projects, and chats'}
          disabled={privacy.enabled}
          onChange={(event) => setFilter(event.target.value.slice(0, 256))}
        />
        {filter ? (
          <button type="button" aria-label="Clear filter" onClick={() => setFilter('')}>
            <X size={12} />
          </button>
        ) : null}
      </div>

      {snapshot.agentRoster.status === 'ready' && snapshot.agentRoster.agents.length > 0 ? (
        <section className="sidebar-agent-section" aria-label="Saved Agents">
          <div className="sidebar-agent-heading">
            <span><UsersRound size={12} /> Agents</span>
            {!isFiltering ? (
              <button type="button" onClick={() => setShowAllAgents((current) => !current)}>
                {showAllAgents ? 'Active only' : 'Show all'}
              </button>
            ) : null}
          </div>
          {sidebarAgents.length === 0 ? (
            <div className="sidebar-agent-empty">
              {isFiltering ? 'No agents matched.' : 'No pinned or assigned agents.'}
            </div>
          ) : (
            <div className="sidebar-agent-list">
              {sidebarAgents.map(({ agent, targetSessionId, status }) => {
                const displayName = privacy.savedAgentName(agent.name, agentOrdinals.get(agent.id))
                return (
                  <button
                    key={agent.id}
                    className="sidebar-agent-row"
                    type="button"
                    disabled={!targetSessionId}
                    aria-label={targetSessionId ? `Open ${displayName}` : `${displayName} is not assigned`}
                    title={targetSessionId ? `Open the latest chat assigned to ${displayName}.` : 'Assign this agent from an existing chat first.'}
                    onClick={() => targetSessionId && onSelectSession(targetSessionId)}
                  >
                    <AgentAvatar glyph={agent.glyph} color={agent.color} label={displayName} size="medium" redacted={privacy.enabled} />
                    <span className="sidebar-agent-copy">
                      <strong>{displayName}</strong>
                      <small className={`agent-state-${status}`}><span />{status === 'working' ? 'Working' : 'Ready'}</small>
                    </span>
                    {agent.isPinned ? <Pin size={10} aria-label="Pinned" /> : null}
                  </button>
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      {pinnedSessions.length > 0 ? (
        <section className="pinned-session-section" aria-label="Pinned sessions">
          <div className="sidebar-section-label">
            <Pin size={12} />
            Pinned
          </div>
          <div className="pinned-session-list">
            {pinnedSessions.map((session) => {
              const project = projectsById.get(session.projectId)
              return project ? renderSession(session, project, true) : null
            })}
          </div>
        </section>
      ) : null}

      <div className="sidebar-section-label">
        <Folder size={13} />
        Projects
      </div>

      <div className="project-list" data-testid="project-list">
        {orderedProjects.length === 0 ? (
          <div className="sidebar-empty">
            {isFiltering ? 'No projects or active chats matched.' : 'Add a local folder to begin.'}
          </div>
        ) : (
          orderedProjects.map((project) => {
            const displayProjectName = privacy.projectName(
              project.name,
              projectOrdinals.get(project.id)
            )
            const projectNameMatches = sidebarValuesMatch(normalizedFilter, [project.name])
            const sessions = project.sessionIds
              .filter((id) => !pinnedSessionIds.has(id))
              .filter((id) => !settledSessionIds.has(id))
              .map((id) => sessionsById.get(id))
              .filter((session): session is PublicSessionSnapshot => Boolean(session))
              .filter((session) => !isFiltering || projectNameMatches || sidebarValuesMatch(
                normalizedFilter,
                [
                  session.title,
                  session.savedAgent?.name ?? '',
                  session.savedAgentId ? agentsById.get(session.savedAgentId)?.mission ?? '' : ''
                ]
              ))
            const selected = project.id === snapshot.selectedProjectId
            const pinned = pinnedProjectIds.has(project.id)
            const group = orderedProjects.filter((candidate) =>
              pinnedProjectIds.has(candidate.id) === pinned
            )
            const groupIndex = group.findIndex((candidate) => candidate.id === project.id)
            const canMoveUp = groupIndex > 0
            const canMoveDown = groupIndex >= 0 && groupIndex < group.length - 1
            const menuId = `project:${project.id}` as const
            const health = workspaceHealthByProject.get(project.id) ?? 'unreadable'
            const healthLabel = workspaceHealthLabel(health)
            const healthDescriptionId = healthLabel ? `project-health-${project.id}` : undefined
            return (
              <section className="project-group" key={project.id} data-testid={`project-${project.id}`}>
                <div className="project-row-shell">
                  <button
                    className={`project-row ${selected ? 'selected' : ''} ${healthLabel ? 'workspace-unavailable' : ''}`}
                    type="button"
                    aria-describedby={healthDescriptionId}
                    aria-label={`Open ${displayProjectName}`}
                    title={privacy.path(project.path)}
                    onClick={() => onSelectProject(project.id)}
                  >
                    <Folder size={15} strokeWidth={1.8} />
                    <span className="project-copy">
                      <span className="project-name">{displayProjectName}</span>
                      {healthLabel ? (
                        <span
                          className="project-health"
                          id={healthDescriptionId}
                          data-testid={`workspace-health-${project.id}`}
                        >
                          <CircleAlert size={10} aria-hidden="true" />
                          {healthLabel}
                        </span>
                      ) : null}
                    </span>
                    {pinned ? <Pin className="pin-mark" size={11} aria-label="Pinned" /> : <ChevronDown size={14} />}
                  </button>
                  <button
                    className="row-menu-trigger"
                    type="button"
                    aria-label={`Actions for project ${displayProjectName}`}
                    aria-expanded={openMenu === menuId}
                    onClick={() => setOpenMenu(openMenu === menuId ? undefined : menuId)}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  {openMenu === menuId ? (
                    <div className="row-action-menu" role="menu" aria-label={`Project actions for ${displayProjectName}`}>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!pinned && snapshot.pinnedProjectIds.length >= 5}
                        onClick={() => closeMenuThen(() => onSetProjectPinned(project.id, !pinned))}
                      >
                        {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                        {pinned ? 'Unpin Project' : 'Pin to Top'}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!canMoveUp}
                        title={canMoveUp ? undefined : 'Already first in this project group.'}
                        onClick={() => closeMenuThen(() => onMoveProject(project.id, 'up'))}
                      >
                        <ArrowUp size={13} /> Move Up
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!canMoveDown}
                        title={canMoveDown ? undefined : 'Already last in this project group.'}
                        onClick={() => closeMenuThen(() => onMoveProject(project.id, 'down'))}
                      >
                        <ArrowDown size={13} /> Move Down
                      </button>
                      <span className="menu-separator" />
                      <button
                        className="danger-menu-item"
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOpenMenu(undefined)
                          setRemoveConfirmation(project.id)
                        }}
                      >
                        <Trash2 size={13} /> Remove Project
                      </button>
                    </div>
                  ) : null}
                </div>
                {removeConfirmation === project.id ? (
                  <div className="project-remove-confirm" role="alertdialog" aria-label={`Remove project ${displayProjectName}`}>
                    <strong>Remove {displayProjectName}?</strong>
                    <span>{project.sessionIds.length} {project.sessionIds.length === 1 ? 'chat' : 'chats'} will close. Files stay on disk.</span>
                    <div>
                      <button type="button" onClick={() => setRemoveConfirmation(undefined)}>Cancel</button>
                      <button
                        className="danger-text-button"
                        type="button"
                        onClick={() => {
                          setRemoveConfirmation(undefined)
                          onRemoveProject(project.id)
                        }}
                      >
                        Remove Project
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="session-list">
                  {sessions.map((session) => renderSession(session, project, false))}
                  <button
                    className="new-session-row"
                    type="button"
                    disabled={health !== 'ready'}
                    title={health === 'ready' ? undefined : 'Restore the workspace before creating a chat.'}
                    onClick={() => onCreateSession(project.id)}
                  >
                    <MessageSquare size={13} />
                    New chat
                  </button>
                </div>
              </section>
            )
          })
        )}
      </div>

      {(isFiltering ? settledSessions.length > 0 : snapshot.settledSessionIds.length > 0) ? (
        <section className="settled-session-section" aria-label="Settled sessions">
          {isFiltering || settledExpanded ? (
            <>
              <button
                className="settled-session-heading"
                type="button"
                aria-expanded="true"
                onClick={() => setSettledExpanded(false)}
              >
                <Archive size={12} />
                Settled
                <span>{settledSessions.length}</span>
                {!isFiltering ? <ChevronDown className="expanded" size={12} /> : null}
              </button>
              <div className="settled-session-list">
                {settledSessions.map((session) => {
                  const project = projectsById.get(session.projectId)
                  return project ? renderSession(session, project, false) : null
                })}
              </div>
            </>
          ) : (
            <button
              className="settled-session-heading collapsed"
              type="button"
              aria-expanded="false"
              onClick={() => setSettledExpanded(true)}
            >
              <Archive size={12} />
              Show {snapshot.settledSessionIds.length} settled {snapshot.settledSessionIds.length === 1 ? 'session' : 'sessions'}
              <ChevronDown size={12} />
            </button>
          )}
        </section>
      ) : null}

      <button className="settings-row" type="button" onClick={onOpenSettings}>
        <Settings size={15} />
        Settings
        <span className="version-label">v{snapshot.appVersion}</span>
      </button>
    </aside>
  )
}

function workspaceHealthLabel(state: WorkspaceHealthState): string | undefined {
  switch (state) {
    case 'ready': return undefined
    case 'missing': return 'Folder missing'
    case 'not-directory': return 'Not a folder'
    case 'changed': return 'Location changed'
    case 'unreadable': return 'Access unavailable'
  }
}

function SessionIndicator({ status }: { status: PublicSessionSnapshot['activityStatus'] }): React.JSX.Element {
  return <span className={`session-indicator status-${status}`} aria-hidden="true" />
}

