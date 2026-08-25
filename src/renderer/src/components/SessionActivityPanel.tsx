import {
  Activity,
  Bot,
  CircleAlert,
  CircleCheck,
  Clock3,
  LoaderCircle,
  Pause,
  Radio,
  SquareTerminal,
  Target,
  Workflow,
  X
} from 'lucide-react'
import type {
  BackgroundActivity,
  GoalActivity,
  SessionActivitySnapshot,
  WorkflowActivity
} from '../../../shared/acp/sessionActivity'
import { ModalSurface } from './ModalSurface'

interface SessionActivityPanelProps {
  sessionTitle: string
  snapshot: SessionActivitySnapshot
  onClose: () => void
}

const syncCopy: Record<SessionActivitySnapshot['syncState'], {
  label: string
  detail: string
}> = {
  unseen: {
    label: 'Not synced',
    detail: 'Reconnect this chat to ask the Grok CLI for its session activity.'
  },
  replaying: {
    label: 'Syncing',
    detail: 'Rebuilding activity from the Grok CLI session replay.'
  },
  live: {
    label: 'Live',
    detail: 'This view follows authoritative Grok CLI updates for the current session.'
  },
  offline: {
    label: 'Offline',
    detail: 'Showing the last known activity. Reconnect this chat to refresh it.'
  }
}

export function SessionActivityPanel({
  sessionTitle,
  snapshot,
  onClose
}: SessionActivityPanelProps): React.JSX.Element {
  const total = snapshot.schedules.length + snapshot.background.length + snapshot.workflows.length +
    (snapshot.goal ? 1 : 0)
  const sync = syncCopy[snapshot.syncState]

  return (
    <ModalSurface className="activity-dialog" labelledBy="activity-title" onClose={onClose}>
      <section className="activity-panel" data-testid="session-activity-panel">
        <header className="activity-header">
          <div className="activity-glyph" aria-hidden="true"><Activity size={19} /></div>
          <div>
            <span className="activity-kicker">CLI-owned activity</span>
            <h2 id="activity-title">Tasks &amp; Workflows</h2>
            <p>{sessionTitle}</p>
          </div>
          <span className={`activity-sync sync-${snapshot.syncState}`} role="status">
            {snapshot.syncState === 'replaying' ? <LoaderCircle className="spinning" size={11} /> : null}
            {sync.label}
          </span>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close Tasks and Workflows"
            data-modal-initial-focus
          >
            <X size={16} />
          </button>
        </header>

        <div className="activity-sync-note">
          <span>{sync.detail}</span>
          {snapshot.unknownEventCount > 0 ? (
            <span className="activity-unknown">
              <CircleAlert size={11} />
              {formatCount(snapshot.unknownEventCount)} unsupported {snapshot.unknownEventCount === 1 ? 'update' : 'updates'} ignored
            </span>
          ) : null}
        </div>

        <div className="activity-summary-grid" aria-label="Activity summary">
          <SummaryCard icon={Clock3} label="Scheduled" value={snapshot.schedules.length} tone="amber" />
          <SummaryCard icon={Radio} label="Observed" value={snapshot.background.length} tone="blue" />
          <SummaryCard icon={Workflow} label="Workflows" value={snapshot.workflows.length} tone="violet" />
          <SummaryCard icon={Target} label="Goal" value={snapshot.goal ? 1 : 0} tone="green" />
        </div>

        <div className="activity-body">
          {total === 0 ? (
            <ActivityEmpty syncState={snapshot.syncState} />
          ) : (
            <>
              {snapshot.schedules.length > 0 ? (
                <ActivitySection
                  icon={Clock3}
                  title="Scheduled"
                  eyebrow="Authoritative"
                  description="Recurring work reported by the Grok CLI for this session."
                >
                  {snapshot.schedules.map((task) => (
                    <article className="activity-row" key={task.viewKey}>
                      <div className="activity-row-icon tone-amber"><Clock3 size={14} /></div>
                      <div className="activity-row-copy">
                        <strong>{task.label}</strong>
                        <span>{task.schedule ?? 'Recurring schedule'}{task.nextFireAt ? ` · ${formatTimestamp(task.nextFireAt)}` : ''}</span>
                      </div>
                      <div className="activity-row-meta">
                        <StatusPill status={task.status} />
                        {task.fireCount > 0 ? <small>{formatCount(task.fireCount)} fired</small> : null}
                      </div>
                    </article>
                  ))}
                </ActivitySection>
              ) : null}

              {snapshot.background.length > 0 ? (
                <ActivitySection
                  icon={Radio}
                  title="Background"
                  eyebrow="Observed in this session"
                  description="Commands, monitors, and subagents seen in the live event stream; this is not a global task list."
                >
                  {snapshot.background.map((item) => (
                    <article className="activity-row" key={item.viewKey}>
                      <div className="activity-row-icon tone-blue"><BackgroundIcon kind={item.kind} /></div>
                      <div className="activity-row-copy">
                        <strong>{item.label}</strong>
                        <span>{backgroundKindLabel(item.kind)} · {formatCount(item.updateCount)} {item.updateCount === 1 ? 'update' : 'updates'}</span>
                      </div>
                      <div className="activity-row-meta"><StatusPill status={item.status} /></div>
                    </article>
                  ))}
                </ActivitySection>
              ) : null}

              {snapshot.workflows.length > 0 ? (
                <ActivitySection
                  icon={Workflow}
                  title="Workflow runs"
                  eyebrow="CLI state"
                  description="Run phase and agent-call budget are kept separate from chat context usage."
                >
                  {snapshot.workflows.map((workflow) => (
                    <WorkflowRow key={workflow.viewKey} workflow={workflow} />
                  ))}
                </ActivitySection>
              ) : null}

              {snapshot.goal ? (
                <ActivitySection
                  icon={Target}
                  title="Goal"
                  eyebrow="CLI state"
                  description="Goal status changes only after an authoritative goal update."
                >
                  <GoalRow goal={snapshot.goal} />
                </ActivitySection>
              ) : null}
            </>
          )}
        </div>

        <footer className="activity-footer">
          Scheduled work runs only while GrokBuild is open and this session&apos;s Grok process remains active.
        </footer>
      </section>
    </ModalSurface>
  )
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  tone
}: {
  icon: typeof Clock3
  label: string
  value: number
  tone: 'amber' | 'blue' | 'violet' | 'green'
}): React.JSX.Element {
  return (
    <div className={`activity-summary-card tone-${tone}`}>
      <span><Icon size={13} /></span>
      <div><strong>{formatCount(value)}</strong><small>{label}</small></div>
    </div>
  )
}

function ActivitySection({
  icon: Icon,
  title,
  eyebrow,
  description,
  children
}: {
  icon: typeof Clock3
  title: string
  eyebrow: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="activity-section" aria-label={title}>
      <header className="activity-section-heading">
        <span><Icon size={13} /></span>
        <div><strong>{title}</strong><small>{eyebrow}</small></div>
        <p>{description}</p>
      </header>
      <div className="activity-row-list">{children}</div>
    </section>
  )
}

function WorkflowRow({ workflow }: { workflow: WorkflowActivity }): React.JSX.Element {
  const used = workflow.agentsUsed ?? workflow.activeAgents
  const total = workflow.agentBudget
  const progress = used !== undefined && total !== undefined && total > 0
    ? Math.min(100, Math.round((used / total) * 100))
    : undefined
  return (
    <article className="activity-row activity-row-tall">
      <div className="activity-row-icon tone-violet"><Workflow size={14} /></div>
      <div className="activity-row-copy">
        <strong>{workflow.name}</strong>
        <span>{workflow.phase ?? workflow.objective ?? 'Workflow run'}</span>
        {progress !== undefined ? (
          <div className="activity-budget" aria-label={`${progress}% of workflow agent budget used`}>
            <span style={{ width: `${progress}%` }} />
          </div>
        ) : null}
      </div>
      <div className="activity-row-meta">
        <StatusPill status={workflow.status} />
        {used !== undefined && total !== undefined ? <small>{formatCount(used)} / {formatCount(total)} calls</small> : null}
        {workflow.elapsedMs !== undefined ? <small>{formatElapsed(workflow.elapsedMs)}</small> : null}
      </div>
    </article>
  )
}

function GoalRow({ goal }: { goal: GoalActivity }): React.JSX.Element {
  const progress = goal.tokensUsed !== undefined && goal.tokenBudget !== undefined && goal.tokenBudget > 0
    ? Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100))
    : undefined
  return (
    <article className="activity-row activity-row-tall goal-row">
      <div className="activity-row-icon tone-green"><Target size={14} /></div>
      <div className="activity-row-copy">
        <strong>{goal.objective}</strong>
        <span>{goal.phase ?? 'Goal in progress'}</span>
        {progress !== undefined ? (
          <div className="activity-budget goal-budget" aria-label={`${progress}% of goal token budget used`}>
            <span style={{ width: `${progress}%` }} />
          </div>
        ) : null}
      </div>
      <div className="activity-row-meta">
        <StatusPill status={goal.status} />
        {goal.tokensUsed !== undefined && goal.tokenBudget !== undefined ? (
          <small>{formatCount(goal.tokensUsed)} / {formatCount(goal.tokenBudget)} tokens</small>
        ) : null}
        {goal.completedDeliverables !== undefined && goal.totalDeliverables !== undefined ? (
          <small>{formatCount(goal.completedDeliverables)} / {formatCount(goal.totalDeliverables)} deliverables</small>
        ) : null}
      </div>
    </article>
  )
}

function ActivityEmpty({
  syncState
}: {
  syncState: SessionActivitySnapshot['syncState']
}): React.JSX.Element {
  const copy = syncState === 'unseen'
    ? ['Activity has not synced yet', 'Open or reconnect this chat before treating the list as empty.']
    : syncState === 'replaying'
      ? ['Rebuilding session activity', 'GrokBuild is waiting for the CLI replay to finish.']
      : syncState === 'offline'
        ? ['No cached activity', 'Reconnect this chat to refresh its CLI-owned state.']
        : ['No current session activity', 'The Grok CLI reported no schedules, observed background work, workflow runs, or goal.']
  return (
    <div className="activity-empty">
      {syncState === 'replaying' ? <LoaderCircle className="spinning" size={24} /> : <Activity size={24} />}
      <strong>{copy[0]}</strong>
      <span>{copy[1]}</span>
    </div>
  )
}

function BackgroundIcon({ kind }: { kind: BackgroundActivity['kind'] }): React.JSX.Element {
  if (kind === 'command') return <SquareTerminal size={14} />
  if (kind === 'subagent') return <Bot size={14} />
  return <Radio size={14} />
}

function StatusPill({ status }: { status: string }): React.JSX.Element {
  const normalized = status.replaceAll('_', ' ')
  const Icon = status === 'completed' || status === 'scheduled'
    ? CircleCheck
    : status === 'paused'
      ? Pause
      : status === 'failed' || status === 'cancelled' || status === 'interrupted'
        ? CircleAlert
        : status === 'running' || status === 'active' || status === 'fired'
          ? LoaderCircle
          : Activity
  return (
    <span className={`activity-status status-${status}`}>
      <Icon className={status === 'running' || status === 'active' ? 'spinning' : ''} size={10} />
      {normalized}
    </span>
  )
}

function backgroundKindLabel(kind: BackgroundActivity['kind']): string {
  if (kind === 'command') return 'Background command'
  if (kind === 'subagent') return 'Subagent'
  return 'Monitor'
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Next run unavailable'
  return `Next ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)}`
}

function formatElapsed(value: number): string {
  if (value < 60_000) return `${Math.max(0, Math.round(value / 1_000))}s`
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`
  return `${Math.round(value / 3_600_000)}h`
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard' })
    .format(value)
}
