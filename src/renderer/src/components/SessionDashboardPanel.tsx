import {
  AlertTriangle,
  Archive,
  Clock3,
  GitBranch,
  GitFork,
  Hand,
  LayoutDashboard,
  LoaderCircle,
  RefreshCw,
  SearchCheck,
  X
} from 'lucide-react'
import type { DashboardProjectStatus } from '../../../shared/dashboard'
import type { AppSnapshot, PublicSessionSnapshot } from '../../../shared/models'
import type { PrivacyDisplayResolver } from '../../../shared/privacy'
import {
  DASHBOARD_SECTION_ORDER,
  dashboardTitle,
  resolveDashboardGroup,
  type DashboardGroup
} from '../../../shared/sessionPresentation'
import { ModalSurface } from './ModalSurface'

interface SessionDashboardPanelProps {
  snapshot: AppSnapshot
  privacy: PrivacyDisplayResolver
  git?: DashboardProjectStatus
  loading: boolean
  error?: string
  onRefresh: () => void
  onSelectSession: (sessionId: string) => void
  onClose: () => void
}

interface DashboardEntry {
  session: PublicSessionSnapshot
  group: DashboardGroup
}

const groupCopy: Record<DashboardGroup, {
  title: string
  icon: typeof Hand
}> = {
  'needs-you': { title: 'Needs you', icon: Hand },
  failed: { title: 'Failed', icon: AlertTriangle },
  working: { title: 'Working', icon: LoaderCircle },
  'needs-review': { title: 'Needs review', icon: SearchCheck },
  scheduled: { title: 'Scheduled', icon: Clock3 },
  idle: { title: 'Idle', icon: Archive }
}

export function SessionDashboardPanel({
  snapshot,
  privacy,
  git,
  loading,
  error,
  onRefresh,
  onSelectSession,
  onClose
}: SessionDashboardPanelProps): React.JSX.Element {
  const project = snapshot.projects.find((candidate) => candidate.id === snapshot.selectedProjectId)
  const projectName = project
    ? privacy.projectName(
        project.name,
        snapshot.projects.findIndex((candidate) => candidate.id === project.id) + 1
      )
    : undefined
  const projectGit = project && git?.projectId === project.id ? git : undefined
  const entries: DashboardEntry[] = project
    ? snapshot.sessions
      .filter((session) => session.projectId === project.id)
      .map((session) => ({
        session,
        group: resolveDashboardGroup({
          pendingUserCount: session.pendingUserCount,
          hasUnreadCompletion: session.hasUnreadCompletion,
          isFailed: session.activityStatus === 'error',
          isStreaming: session.activityStatus === 'working',
          isStarting: session.status === 'starting',
          isBusy: session.status === 'running',
          dirtyCount: projectGit?.dirtyCount ?? 0,
          scheduledCount: session.activities?.syncState === 'live'
            ? session.activities.schedules.length
            : 0
        })
      }))
    : []

  return (
    <ModalSurface className="dashboard-dialog" labelledBy="dashboard-title" onClose={onClose}>
      <section className="dashboard-panel">
        <header className="dashboard-header">
          <div className="dashboard-glyph" aria-hidden="true"><LayoutDashboard size={19} /></div>
          <div>
            <span className="dashboard-kicker">Live workspace</span>
            <h2 id="dashboard-title">Sessions Dashboard</h2>
            <p>{projectName ? `${projectName} · live and restored chats` : 'Select a project to see live sessions.'}</p>
          </div>
          <button
            className="dashboard-refresh"
            type="button"
            disabled={!project || loading}
            onClick={onRefresh}
          >
            <RefreshCw className={loading ? 'spinning' : ''} size={13} />
            Refresh
          </button>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close Sessions Dashboard" data-modal-initial-focus>
            <X size={16} />
          </button>
        </header>

        {error ? <div className="dashboard-error" role="status">Dashboard status could not be refreshed.</div> : null}
        <div className="dashboard-body">
          {entries.length === 0 ? (
            <div className="dashboard-empty">
              <Archive size={24} aria-hidden="true" />
              <strong>{project ? 'No live sessions in this project' : 'No project selected'}</strong>
              <span>Session history is kept in a separate view.</span>
            </div>
          ) : (
            DASHBOARD_SECTION_ORDER.map((group) => {
              const grouped = entries.filter((entry) => entry.group === group)
              if (grouped.length === 0) return null
              const copy = groupCopy[group]
              const Icon = copy.icon
              return (
                <section className={`dashboard-group group-${group}`} key={group} aria-label={copy.title}>
                  <div className="dashboard-group-heading">
                    <span><Icon className={group === 'working' ? 'spinning' : ''} size={12} /></span>
                    <h3>{copy.title}</h3>
                    <strong>{grouped.length}</strong>
                  </div>
                  <div className="dashboard-card-list">
                    {grouped.map(({ session }) => {
                      const title = privacy.sessionTitle(
                        dashboardTitle(session.title),
                        snapshot.sessions.findIndex((candidate) => candidate.id === session.id) + 1
                      )
                      return (
                        <button
                          className="dashboard-session-card"
                          type="button"
                          key={session.id}
                          aria-label={`Open ${title}`}
                          onClick={() => onSelectSession(session.id)}
                        >
                          <div className="dashboard-session-copy">
                            <strong>{title}</strong>
                            <span>{session.model} · {session.mode === 'default' ? 'Agent' : session.mode}</span>
                          </div>
                          <div className="dashboard-session-meta">
                            {session.pendingUserCount > 0 ? <span className="attention">{session.pendingUserCount} pending</span> : null}
                            {projectGit?.isWorktree ? <span><GitFork size={10} /> {privacy.worktree('Worktree')}</span> : null}
                            {projectGit?.branch ? <span><GitBranch size={10} /> {privacy.branch(projectGit.branch)}</span> : null}
                            {projectGit && projectGit.dirtyCount > 0 ? <span className="review">{projectGit.dirtyCount} changed</span> : null}
                          </div>
                          <span className="dashboard-open-mark" aria-hidden="true">›</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })
          )}
        </div>
        <footer className="dashboard-footer">
          Dashboard shows current-project tabs. CLI Sessions History is a separate data source.
        </footer>
      </section>
    </ModalSurface>
  )
}
