import {
  Activity,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FolderOpen,
  History,
  LayoutDashboard,
  Plus,
  RefreshCw,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DashboardProjectStatus } from '../../shared/dashboard'
import type { AppSnapshot } from '../../shared/models'
import type { AttachmentSelectionSummary } from '../../shared/attachments'
import type { PublicSessionHistoryRecord } from '../../shared/sessionHistory'
import type { SessionActivitySnapshot } from '../../shared/acp/sessionActivity'
import type { WorkspaceHealthState } from '../../shared/workspaceHealth'
import type { ProjectOpenTargetStatus } from '../../shared/ipc'
import { createPrivacyDisplayResolver } from '../../shared/privacy'
import { Composer } from './components/Composer'
import { ImageLightbox, type LightboxRequest } from './components/ImageLightbox'
import { SessionDashboardPanel } from './components/SessionDashboardPanel'
import { SessionHistoryPanel } from './components/SessionHistoryPanel'
import { SessionActivityPanel } from './components/SessionActivityPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { Transcript } from './components/Transcript'

const SIDEBAR_WIDTH_DEFAULT = 272
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 460
const SIDEBAR_WIDTH_KEY = 'grokbuild.sidebarWidth'

function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)))
}

/**
 * Drag handle between the sidebar and the conversation. Width is a pure
 * display preference, so it lives in localStorage rather than the main-owned
 * settings store. Double-click restores the default.
 */
function SidebarResizer({
  width,
  onResize
}: {
  width: number
  onResize: (width: number) => void
}): React.JSX.Element {
  // Pointer capture keeps move/up events flowing to the handle even when the
  // cursor leaves the window mid-drag; the plain mouse-event version lost the
  // mouseup there and left the drag armed forever.
  const start = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const originX = event.clientX
    const originWidth = width
    document.body.classList.add('resizing-sidebar')
    handle.setPointerCapture(pointerId)
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return
      onResize(clampSidebarWidth(originWidth + (moveEvent.clientX - originX)))
    }
    const stop = (stopEvent: PointerEvent): void => {
      if (stopEvent.pointerId !== pointerId) return
      document.body.classList.remove('resizing-sidebar')
      try {
        handle.releasePointerCapture(pointerId)
      } catch {
        // Already released.
      }
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      title="Drag to resize · double-click to reset"
      onPointerDown={start}
      onDoubleClick={() => onResize(SIDEBAR_WIDTH_DEFAULT)}
    />
  )
}

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot>()
  const [lightbox, setLightbox] = useState<LightboxRequest>()
  const [sidebarWidth, setSidebarWidthState] = useState(() =>
    clampSidebarWidth(Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? SIDEBAR_WIDTH_DEFAULT))
  )
  const setSidebarWidth = useCallback((value: number): void => {
    const next = clampSidebarWidth(value)
    setSidebarWidthState(next)
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next))
    } catch {
      // Display preference only; losing it is harmless.
    }
  }, [])
  const [fatalError, setFatalError] = useState<string>()
  const [operationError, setOperationError] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [retryingSessionId, setRetryingSessionId] = useState<string>()
  const [projectOpenTargets, setProjectOpenTargets] = useState<ProjectOpenTargetStatus[]>([])
  const [projectOpenMenu, setProjectOpenMenu] = useState(false)
  const [dashboardOpen, setDashboardOpen] = useState(false)
  const [dashboardGit, setDashboardGit] = useState<DashboardProjectStatus>()
  const [dashboardLoading, setDashboardLoading] = useState(false)
  const [dashboardError, setDashboardError] = useState<string>()
  const [activityOpen, setActivityOpen] = useState(false)
  const dashboardRequestSequence = useRef(0)
  const dashboardRequestInFlight = useRef(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRecords, setHistoryRecords] = useState<PublicSessionHistoryRecord[]>([])
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string>()
  const [historyBusyToken, setHistoryBusyToken] = useState<string>()
  const [historyRefreshSequence, setHistoryRefreshSequence] = useState(0)
  const historyRequestSequence = useRef(0)

  useEffect(() => {
    const applySnapshot = (next: AppSnapshot): void => {
      setSnapshot((current) => !current || next.revision >= current.revision ? next : current)
    }
    const unsubscribe = window.grokbuild.onStateChanged(applySnapshot)
    void window.grokbuild.bootstrap().then(applySnapshot).catch((error: unknown) => {
      setFatalError(error instanceof Error ? error.message : String(error))
    })
    return unsubscribe
  }, [])

  useEffect(() => window.grokbuild.onOpenSettings(() => {
    setProjectOpenMenu(false)
    setDashboardOpen(false)
    setHistoryOpen(false)
    setActivityOpen(false)
    setSettingsOpen(true)
  }), [])

  useEffect(() => {
    let active = true
    void window.grokbuild.listProjectOpenTargets()
      .then((targets) => { if (active) setProjectOpenTargets(targets) })
      .catch(() => { if (active) setProjectOpenTargets([]) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!snapshot) return
    const root = document.documentElement
    root.dataset.appearance = snapshot.settings.appearance
    root.dataset.reduceMotion = String(snapshot.settings.reduceMotion)
    root.dataset.privacy = String(snapshot.settings.privacyMode)
  }, [
    snapshot?.settings.appearance,
    snapshot?.settings.privacyMode,
    snapshot?.settings.reduceMotion
  ])

  const privacy = useMemo(
    () => createPrivacyDisplayResolver(snapshot?.settings.privacyMode === true),
    [snapshot?.settings.privacyMode]
  )

  const selectedSession = useMemo(
    () => snapshot?.sessions.find((session) => session.id === snapshot.selectedSessionId),
    [snapshot]
  )
  const selectedProject = useMemo(
    () => snapshot?.projects.find((project) => project.id === snapshot.selectedProjectId),
    [snapshot]
  )
  const selectedWorkspaceHealth = useMemo(
    () => selectedProject
      ? snapshot?.workspaceHealth.find((health) => health.projectId === selectedProject.id)?.state
        ?? 'unreadable'
      : undefined,
    [selectedProject, snapshot]
  )
  const installedProjectOpenTargets = useMemo(
    () => projectOpenTargets.filter((target) => target.installed),
    [projectOpenTargets]
  )
  const selectedProjectName = selectedProject
    ? privacy.projectName(
        selectedProject.name,
        snapshot ? snapshot.projects.findIndex((project) => project.id === selectedProject.id) + 1 : undefined
      )
    : undefined
  const selectedSessionTitle = selectedSession
    ? privacy.sessionTitle(
        selectedSession.title,
        snapshot ? snapshot.sessions.findIndex((session) => session.id === selectedSession.id) + 1 : undefined
      )
    : undefined

  useEffect(() => setProjectOpenMenu(false), [selectedProject?.id])

  useEffect(() => {
    setDashboardOpen(false)
    setDashboardGit(undefined)
    setDashboardError(undefined)
    dashboardRequestSequence.current += 1
    dashboardRequestInFlight.current = false
    setHistoryOpen(false)
    setHistoryRecords([])
    setHistoryQuery('')
    setHistoryError(undefined)
    setHistoryBusyToken(undefined)
    setActivityOpen(false)
    historyRequestSequence.current += 1
  }, [selectedProject?.id])

  useEffect(() => setActivityOpen(false), [selectedSession?.id])

  useEffect(() => {
    if (privacy.enabled) setHistoryQuery('')
  }, [privacy.enabled])

  const refreshDashboard = useCallback(async (): Promise<void> => {
    if (!selectedProject || dashboardRequestInFlight.current) return
    const expectedProjectId = selectedProject.id
    const sequence = ++dashboardRequestSequence.current
    dashboardRequestInFlight.current = true
    setDashboardLoading(true)
    setDashboardError(undefined)
    try {
      const status = await window.grokbuild.inspectDashboardGit()
      if (sequence !== dashboardRequestSequence.current) return
      if (status.projectId !== expectedProjectId) {
        setDashboardGit(undefined)
        setDashboardError('stale')
        return
      }
      setDashboardGit(status)
    } catch {
      if (sequence === dashboardRequestSequence.current) {
        setDashboardGit(undefined)
        setDashboardError('unavailable')
      }
    } finally {
      if (sequence === dashboardRequestSequence.current) {
        dashboardRequestInFlight.current = false
        setDashboardLoading(false)
      }
    }
  }, [selectedProject?.id])

  useEffect(() => {
    if (!dashboardOpen || !selectedProject) return
    void refreshDashboard()
    const timer = window.setInterval(() => void refreshDashboard(), 5_000)
    return () => {
      window.clearInterval(timer)
      dashboardRequestSequence.current += 1
      dashboardRequestInFlight.current = false
      setDashboardLoading(false)
    }
  }, [dashboardOpen, refreshDashboard, selectedProject?.id])

  useEffect(() => {
    if (!historyOpen || !selectedProject) return
    const expectedProjectId = selectedProject.id
    const sequence = ++historyRequestSequence.current
    const query = historyQuery.trim()
    setHistoryLoading(true)
    setHistoryError(undefined)
    const timer = window.setTimeout(() => {
      const request = query
        ? window.grokbuild.searchSessionHistory({ query })
        : window.grokbuild.listSessionHistory()
      void request.then((records) => {
        if (sequence !== historyRequestSequence.current) return
        if (records.some((record) => record.projectId !== expectedProjectId)) {
          setHistoryRecords([])
          setHistoryError('stale')
          return
        }
        setHistoryRecords(records)
      }).catch(() => {
        if (sequence === historyRequestSequence.current) {
          setHistoryRecords([])
          setHistoryError('unavailable')
        }
      }).finally(() => {
        if (sequence === historyRequestSequence.current) setHistoryLoading(false)
      })
    }, query ? 250 : 0)
    return () => {
      window.clearTimeout(timer)
      historyRequestSequence.current += 1
    }
  }, [historyOpen, historyQuery, historyRefreshSequence, selectedProject?.id])

  useEffect(() => {
    if (!historyOpen) return
    const timer = window.setInterval(() => {
      setHistoryRefreshSequence((current) => current + 1)
    }, 4 * 60_000)
    return () => window.clearInterval(timer)
  }, [historyOpen])

  if (fatalError) return <div className="fatal-error"><strong>GrokBuild could not start.</strong><span>{fatalError}</span></div>
  if (!snapshot) return <div className="loading-screen"><span className="loading-mark" /> Loading workspace…</div>

  async function addProject(): Promise<void> {
    try {
      setOperationError(undefined)
      const project = await window.grokbuild.chooseProject()
      if (project && project.sessionIds.length === 0) await window.grokbuild.createSession({ projectId: project.id })
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error))
    }
  }

  function runAction(action: () => Promise<unknown>): void {
    setOperationError(undefined)
    void action().catch((error: unknown) => {
      setOperationError(error instanceof Error ? error.message : String(error))
    })
  }

  async function captureClipboardImage(sessionId: string): Promise<AttachmentSelectionSummary | null> {
    setOperationError(undefined)
    try {
      return await window.grokbuild.captureClipboardImage({ sessionId })
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  async function chooseAttachments(sessionId: string): Promise<AttachmentSelectionSummary | null> {
    setOperationError(undefined)
    try {
      return await window.grokbuild.chooseAttachments({ sessionId })
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  async function sendComposerPrompt(
    sessionId: string,
    text: string,
    attachmentToken?: string
  ): Promise<boolean> {
    setOperationError(undefined)
    try {
      await window.grokbuild.sendPrompt({
        sessionId,
        text,
        ...(attachmentToken ? { attachmentToken } : {})
      })
      return true
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  async function bindComposerAgent(
    sessionId: string,
    agentId: string | null,
    expectedRevision: number
  ): Promise<boolean> {
    setOperationError(undefined)
    try {
      await window.grokbuild.bindSavedAgent({ sessionId, agentId, expectedRevision })
      return true
    } catch {
      setOperationError('The Saved Agent could not be changed safely. Review the latest roster and try again.')
      return false
    }
  }

  async function retrySession(sessionId: string): Promise<void> {
    if (retryingSessionId === sessionId) return
    setOperationError(undefined)
    setRetryingSessionId(sessionId)
    try {
      await window.grokbuild.retrySession({ sessionId })
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error))
    } finally {
      setRetryingSessionId((current) => current === sessionId ? undefined : current)
    }
  }

  async function openHistorySession(token: string): Promise<void> {
    if (historyBusyToken) return
    setHistoryBusyToken(token)
    setHistoryError(undefined)
    try {
      await window.grokbuild.openSessionHistory({ token })
      setHistoryOpen(false)
    } catch {
      setHistoryError('action')
    } finally {
      setHistoryBusyToken((current) => current === token ? undefined : current)
    }
  }

  async function deleteHistorySession(token: string): Promise<void> {
    if (historyBusyToken) return
    setHistoryBusyToken(token)
    setHistoryError(undefined)
    try {
      const result = await window.grokbuild.deleteSessionHistory({ token })
      if (result.state === 'deleted') {
        setHistoryRecords((records) => records.filter((record) => record.token !== token))
        setHistoryRefreshSequence((current) => current + 1)
      }
    } catch {
      setHistoryError('action')
    } finally {
      setHistoryBusyToken((current) => current === token ? undefined : current)
    }
  }

  return (
    <div
      className="app-shell"
      data-testid="app-shell"
      style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` }}
    >
      <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />
      {lightbox ? <ImageLightbox request={lightbox} onClose={() => setLightbox(undefined)} /> : null}
      <Sidebar
        snapshot={snapshot}
        privacy={privacy}
        overlayOpen={dashboardOpen || historyOpen || activityOpen || settingsOpen}
        onAddProject={() => void addProject()}
        onCreateSession={(projectId) => runAction(() => window.grokbuild.createSession({ projectId }))}
        onSelectProject={(projectId) => runAction(() => window.grokbuild.selectProject({ projectId }))}
        onSelectSession={(sessionId) => runAction(() => window.grokbuild.selectSession({ sessionId }))}
        onRemoveProject={(projectId) => runAction(() => window.grokbuild.removeProject({ projectId }))}
        onCloseSession={(sessionId) => runAction(() => window.grokbuild.closeSession({ sessionId }))}
        onDuplicateSession={(sessionId) => runAction(() => window.grokbuild.duplicateSession({ sessionId }))}
        onForkSession={(sessionId) => runAction(() => window.grokbuild.forkSession({ sessionId }))}
        onSetProjectPinned={(projectId, pinned) => runAction(() => window.grokbuild.setProjectPinned({ projectId, pinned }))}
        onMoveProject={(projectId, direction) => runAction(() => window.grokbuild.moveProject({ projectId, direction }))}
        onSetSessionPinned={(sessionId, pinned) => runAction(() => window.grokbuild.setSessionPinned({ sessionId, pinned }))}
        onSetSessionSettled={(sessionId, settled) => runAction(() => window.grokbuild.setSessionSettled({ sessionId, settled }))}
        onSetSessionUnread={(sessionId, unread) => runAction(() => window.grokbuild.setSessionUnread({ sessionId, unread }))}
        onOpenSettings={() => {
          setProjectOpenMenu(false)
          setDashboardOpen(false)
          setHistoryOpen(false)
          setActivityOpen(false)
          setSettingsOpen(true)
        }}
      />
      <main className="main-pane">
        <header className="topbar">
          <div className="window-drag-region" />
          <div className="topbar-title">
            <strong>{selectedProjectName ?? 'Workspace'}</strong>
            {selectedSessionTitle ? <span>{selectedSessionTitle}</span> : null}
          </div>
          {selectedProject ? (
            <div className="topbar-project-actions">
              <button
                className="topbar-action-button"
                type="button"
                disabled={selectedWorkspaceHealth !== 'ready'}
                title={selectedWorkspaceHealth === 'ready'
                  ? 'Create another session in this project.'
                  : 'Restore the workspace before creating a chat.'}
                onClick={() => runAction(() => window.grokbuild.createSession({ projectId: selectedProject.id }))}
              >
                <Plus size={13} />
                New chat
              </button>
              <button
                className="topbar-action-button"
                type="button"
                aria-expanded={dashboardOpen}
                onClick={() => {
                  setProjectOpenMenu(false)
                  setHistoryOpen(false)
                  setActivityOpen(false)
                  setDashboardOpen(true)
                }}
              >
                <LayoutDashboard size={13} />
                Dashboard
              </button>
              <button
                className="topbar-action-button"
                type="button"
                aria-expanded={activityOpen}
                disabled={!selectedSession?.activities}
                title={selectedSession?.activities
                  ? 'Show CLI-owned tasks, workflows, and goal activity for this chat.'
                  : 'Connect this chat before viewing its CLI activity.'}
                onClick={() => {
                  setProjectOpenMenu(false)
                  setDashboardOpen(false)
                  setHistoryOpen(false)
                  setActivityOpen(true)
                }}
              >
                <Activity size={13} />
                Tasks
                {selectedSession?.activities && activityCount(selectedSession.activities) > 0 ? (
                  <span className="topbar-action-count">
                    {Math.min(99, activityCount(selectedSession.activities))}
                  </span>
                ) : null}
              </button>
              <button
                className="topbar-action-button"
                type="button"
                aria-expanded={historyOpen}
                disabled={!snapshot.cli.available || selectedWorkspaceHealth !== 'ready'}
                title={!snapshot.cli.available
                  ? 'Choose the Grok CLI before opening session history.'
                  : selectedWorkspaceHealth === 'ready'
                    ? 'Browse sessions saved by the Grok CLI.'
                    : 'Restore the workspace before opening session history.'}
                onClick={() => {
                  setProjectOpenMenu(false)
                  setDashboardOpen(false)
                  setActivityOpen(false)
                  setHistoryOpen(true)
                }}
              >
                <History size={13} />
                History
              </button>
              {installedProjectOpenTargets.length > 0 ? (
                <>
              <button
                className="topbar-open-button"
                type="button"
                aria-haspopup="menu"
                aria-expanded={projectOpenMenu}
                disabled={selectedWorkspaceHealth !== 'ready'}
                title={selectedWorkspaceHealth === 'ready'
                  ? 'Open this project in another macOS app.'
                  : 'Restore the workspace before opening it.'}
                onClick={() => setProjectOpenMenu((current) => !current)}
              >
                <FolderOpen size={13} />
                Open in
                <ChevronDown size={12} />
              </button>
              {projectOpenMenu ? (
                <div className="topbar-open-menu" role="menu" aria-label={`Open ${selectedProjectName} in`}>
                  {installedProjectOpenTargets.map((target) => (
                    <button
                      key={target.target}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setProjectOpenMenu(false)
                        runAction(() => window.grokbuild.openProject({
                          projectId: selectedProject.id,
                          target: target.target
                        }))
                      }}
                    >
                      <FolderOpen size={13} />
                      {target.label}
                      <ExternalLink className="open-target-mark" size={11} />
                    </button>
                  ))}
                </div>
              ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </header>

        {!snapshot.cli.available ? (
          <button className="status-banner" type="button" onClick={() => setSettingsOpen(true)}>
            Grok CLI was not found at <code>{privacy.path(snapshot.cli.path)}</code>. Open Settings to choose it.
          </button>
        ) : null}
        {selectedProject && selectedWorkspaceHealth && selectedWorkspaceHealth !== 'ready' ? (
          <div className="workspace-health-banner" role="status" data-testid="workspace-unavailable-banner">
            <CircleAlert size={16} aria-hidden="true" />
            <div>
              <strong>{workspaceHealthHeading(selectedWorkspaceHealth)}</strong>
              <span>{workspaceHealthMessage(selectedWorkspaceHealth)}</span>
            </div>
            <button
              type="button"
              onClick={() => runAction(() => window.grokbuild.selectProject({ projectId: selectedProject.id }))}
            >
              <RefreshCw size={12} aria-hidden="true" />
              Check again
            </button>
          </div>
        ) : null}
        {operationError ? (
          <div className="operation-error" role="alert">
            <span>{privacy.enabled ? 'The operation could not be completed.' : operationError}</span>
            <button type="button" onClick={() => setOperationError(undefined)} aria-label="Dismiss error">
              <X size={14} />
            </button>
          </div>
        ) : null}
        {selectedSession?.status === 'failed' && selectedWorkspaceHealth === 'ready' ? (
          <div className="retry-banner" role="status" data-testid="retry-banner">
            <div>
              <strong>Grok session needs attention</strong>
              <span>Retry reconnects this session without sending the previous prompt again.</span>
            </div>
            <button
              type="button"
              data-testid="retry-session"
              disabled={retryingSessionId === selectedSession.id}
              onClick={() => void retrySession(selectedSession.id)}
            >
              {retryingSessionId === selectedSession.id ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        ) : null}

        <div className="conversation-pane">
          {selectedSession ? (
            <>
              <Transcript
                session={selectedSession}
                privacyEnabled={privacy.enabled}
                onPreviewImage={setLightbox}
                onAnswerPermission={(requestId, optionId) => runAction(() => window.grokbuild.answerPermission({ sessionId: selectedSession.id, requestId, optionId }))}
                onAnswerInteraction={(interactionId, answer) => runAction(() => window.grokbuild.answerInteraction({ sessionId: selectedSession.id, interactionId, answer }))}
              />
              <Composer
                session={selectedSession}
                agentRoster={snapshot.agentRoster}
                privacy={privacy}
                workspaceReady={selectedWorkspaceHealth === 'ready'}
                onSend={(text, attachmentToken) => sendComposerPrompt(selectedSession.id, text, attachmentToken)}
                onChooseAttachments={() => chooseAttachments(selectedSession.id)}
                onCaptureClipboardImage={() => captureClipboardImage(selectedSession.id)}
                onPreviewImage={setLightbox}
                onCancelAttachments={(token) => window.grokbuild.cancelAttachments({
                  sessionId: selectedSession.id,
                  token
                })}
                onCancel={() => runAction(() => window.grokbuild.cancelTurn({ sessionId: selectedSession.id }))}
                onBindSavedAgent={(agentId, expectedRevision) => bindComposerAgent(
                  selectedSession.id,
                  agentId,
                  expectedRevision
                )}
                onUpdate={(changes) => runAction(() => window.grokbuild.updateSession({ sessionId: selectedSession.id, ...changes }))}
              />
            </>
          ) : (
            <WorkspaceEmpty
              hasProject={Boolean(selectedProject)}
              workspaceReady={!selectedProject || selectedWorkspaceHealth === 'ready'}
              onAddProject={() => void addProject()}
              onCreateSession={() => selectedProject && runAction(() => window.grokbuild.createSession({ projectId: selectedProject.id }))}
            />
          )}
        </div>
      </main>
      {dashboardOpen ? (
        <SessionDashboardPanel
          snapshot={snapshot}
          privacy={privacy}
          {...(dashboardGit ? { git: dashboardGit } : {})}
          loading={dashboardLoading}
          {...(dashboardError ? { error: dashboardError } : {})}
          onRefresh={() => void refreshDashboard()}
          onSelectSession={(sessionId) => {
            setDashboardOpen(false)
            runAction(() => window.grokbuild.selectSession({ sessionId }))
          }}
          onClose={() => setDashboardOpen(false)}
        />
      ) : null}
      {historyOpen ? (
        <SessionHistoryPanel
          {...(selectedProject ? { projectName: selectedProject.name } : {})}
          privacy={privacy}
          records={historyRecords}
          query={historyQuery}
          loading={historyLoading}
          {...(historyError ? { error: historyError } : {})}
          {...(historyBusyToken ? { busyToken: historyBusyToken } : {})}
          onQueryChange={setHistoryQuery}
          onRefresh={() => setHistoryRefreshSequence((current) => current + 1)}
          onOpen={(token) => void openHistorySession(token)}
          onDelete={(token) => void deleteHistorySession(token)}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
      {activityOpen && selectedSession?.activities ? (
        <SessionActivityPanel
          sessionTitle={selectedSessionTitle ?? 'Session'}
          snapshot={selectedSession.activities}
          onClose={() => setActivityOpen(false)}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsPanel
          settings={snapshot.settings}
          privacy={privacy}
          cliAvailable={snapshot.cli.available}
          selectedProjectReady={selectedWorkspaceHealth === 'ready'}
          agentRoster={snapshot.agentRoster}
          sessions={snapshot.sessions}
          {...(snapshot.cli.version ? { cliVersion: snapshot.cli.version } : {})}
          {...(selectedProject ? {
            selectedProjectId: selectedProject.id,
            selectedProjectName: selectedProjectName ?? 'Project'
          } : {})}
          onClose={() => setSettingsOpen(false)}
          onSave={(settings) => runAction(() => window.grokbuild.updateSettings(settings))}
          onChooseCli={() => runAction(() => window.grokbuild.chooseGrokCli())}
        />
      ) : null}
    </div>
  )
}

function WorkspaceEmpty({
  hasProject,
  workspaceReady,
  onAddProject,
  onCreateSession
}: {
  hasProject: boolean
  workspaceReady: boolean
  onAddProject: () => void
  onCreateSession: () => void
}): React.JSX.Element {
  return (
    <div className="workspace-empty">
      <span className="empty-rule" />
      <h1>{hasProject ? 'Start a new chat' : 'Bring a project into focus'}</h1>
      <p>{hasProject ? 'Create a session for this project. Each session keeps its own model, mode, and transcript.' : 'GrokBuild works inside folders you explicitly add. Nothing is scanned before you choose one.'}</p>
      <button
        className="primary-button"
        type="button"
        disabled={hasProject && !workspaceReady}
        title={hasProject && !workspaceReady ? 'Restore the workspace before creating a chat.' : undefined}
        onClick={hasProject ? onCreateSession : onAddProject}
      >
        {hasProject ? 'New chat' : 'Add Project'}
      </button>
    </div>
  )
}

function workspaceHealthHeading(state: Exclude<WorkspaceHealthState, 'ready'>): string {
  switch (state) {
    case 'missing': return 'Workspace folder is missing'
    case 'not-directory': return 'Workspace is no longer a folder'
    case 'changed': return 'Workspace location changed'
    case 'unreadable': return 'Workspace access is unavailable'
  }
}

function workspaceHealthMessage(state: Exclude<WorkspaceHealthState, 'ready'>): string {
  switch (state) {
    case 'missing': return 'Restore the folder, then check again. Saved chats remain available.'
    case 'not-directory': return 'Restore the original folder, then check again. Saved chats remain available.'
    case 'changed': return 'Restore the original folder without an alias, then check again.'
    case 'unreadable': return 'Restore read access to the folder, then check again.'
  }
}

function activityCount(snapshot: SessionActivitySnapshot): number {
  return snapshot.schedules.length + snapshot.background.length + snapshot.workflows.length +
    (snapshot.goal ? 1 : 0)
}
