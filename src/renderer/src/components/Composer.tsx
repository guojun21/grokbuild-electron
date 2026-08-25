import { ArrowUp, CircleStop, FileText, Image, Mic, Paperclip, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { PublicAgentRosterSnapshot, PublicSessionSnapshot } from '../../../shared/models'
import type { AttachmentSelectionSummary } from '../../../shared/attachments'
import type { PrivacyDisplayResolver } from '../../../shared/privacy'
import {
  formatCachedLine,
  formatCompactTokens,
  formatContextSummary,
  formatDecimalTokens,
  usagePercent
} from '../../../shared/acp/usageFormat'
import { AgentAvatar } from './AgentAvatar'

interface ComposerProps {
  session: PublicSessionSnapshot
  agentRoster: PublicAgentRosterSnapshot
  privacy: PrivacyDisplayResolver
  workspaceReady: boolean
  onSend: (text: string, attachmentToken?: string) => Promise<boolean>
  onChooseAttachments: () => Promise<AttachmentSelectionSummary | null>
  onCaptureClipboardImage: () => Promise<AttachmentSelectionSummary | null>
  onPreviewImage: (request: { src: string; name: string; path?: string | undefined; origin: { x: number; y: number; width: number; height: number } }) => void
  onCancelAttachments: (token: string) => Promise<void>
  onCancel: () => void
  onBindSavedAgent: (agentId: string | null, expectedRevision: number) => Promise<boolean>
  onUpdate: (changes: Partial<Pick<PublicSessionSnapshot, 'model' | 'mode' | 'reasoningEffort' | 'permissionMode'>>) => void
}

export function Composer({
  session,
  agentRoster,
  privacy,
  workspaceReady,
  onSend,
  onChooseAttachments,
  onCaptureClipboardImage,
  onPreviewImage,
  onCancelAttachments,
  onCancel,
  onBindSavedAgent,
  onUpdate
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [selection, setSelection] = useState<AttachmentSelectionSummary>()
  const [choosingAttachments, setChoosingAttachments] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [bindingAgent, setBindingAgent] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const selectionRef = useRef<AttachmentSelectionSummary | undefined>(undefined)
  const sessionIdRef = useRef(session.id)
  sessionIdRef.current = session.id
  // Ready means the connected session reported a catalog. The current model may
  // legitimately be missing from it (the CLI retired it between sessions); the
  // picker must still offer the catalog so the user can switch away.
  const modelCapabilitiesReady = Boolean(session.availableModels?.length)
  const modeCapabilitiesReady = Boolean(
    session.availableModes?.length &&
    session.availableModes.some((mode) => mode.id === session.mode)
  )
  const models = modelCapabilitiesReady
    ? session.availableModels!.some((model) => model.id === session.model)
      ? session.availableModels!
      : [{ id: session.model, name: session.model }, ...session.availableModels!]
    : [{ id: session.model, name: session.model }]
  const modes = modeCapabilitiesReady
    ? session.availableModes!
    : [{ id: session.mode, name: session.mode }]
  const turnActive = session.status === 'starting' || session.status === 'running' || session.status === 'waiting'
  const workspaceBlocked = !workspaceReady
  const savedAgents = agentRoster.status === 'ready' ? agentRoster.agents : []
  const savedAgentChoice = session.savedAgentId
    ? savedAgents.findIndex((agent) => agent.id === session.savedAgentId)
    : -1
  const savedAgentValue = savedAgentChoice >= 0 ? `agent-${savedAgentChoice}` : 'none'
  const savedAgentName = session.savedAgent
    ? privacy.savedAgentName(
        session.savedAgent.name,
        savedAgentChoice >= 0 ? savedAgentChoice + 1 : undefined
      )
    : undefined

  useEffect(() => {
    setText('')
    setSelection(undefined)
    setChoosingAttachments(false)
    setSubmitting(false)
    setBindingAgent(false)
    selectionRef.current = undefined
    return () => {
      const pending = selectionRef.current
      selectionRef.current = undefined
      if (pending) void onCancelAttachments(pending.token).catch(() => undefined)
    }
  }, [session.id])

  async function bindSavedAgent(choice: string): Promise<void> {
    if (
      agentRoster.status !== 'ready' ||
      workspaceBlocked ||
      turnActive ||
      bindingAgent
    ) return
    const choiceMatch = /^agent-(\d{1,2})$/u.exec(choice)
    const nextAgentId = choice === 'none'
      ? null
      : choiceMatch
        ? savedAgents[Number(choiceMatch[1])]?.id
        : undefined
    if (nextAgentId === undefined || nextAgentId === (session.savedAgentId ?? null)) return
    const bindingSessionId = session.id
    setBindingAgent(true)
    try {
      await onBindSavedAgent(nextAgentId, agentRoster.revision)
    } finally {
      if (sessionIdRef.current === bindingSessionId) setBindingAgent(false)
    }
  }

  function replaceSelection(next: AttachmentSelectionSummary | undefined): void {
    selectionRef.current = next
    setSelection(next)
  }

  async function acquireAttachments(
    source: () => Promise<AttachmentSelectionSummary | null>
  ): Promise<void> {
    if (workspaceBlocked || turnActive || choosingAttachments || submitting) return
    const choosingSessionId = session.id
    setChoosingAttachments(true)
    try {
      const previous = selectionRef.current
      if (previous) {
        replaceSelection(undefined)
        await onCancelAttachments(previous.token).catch(() => undefined)
      }
      const next = await source()
      if (sessionIdRef.current !== choosingSessionId) {
        if (next) await onCancelAttachments(next.token).catch(() => undefined)
        return
      }
      if (next) replaceSelection(next)
    } finally {
      if (sessionIdRef.current === choosingSessionId) setChoosingAttachments(false)
    }
  }

  async function chooseAttachments(): Promise<void> {
    await acquireAttachments(onChooseAttachments)
  }

  function clearAttachments(): void {
    const pending = selectionRef.current
    replaceSelection(undefined)
    if (pending) void onCancelAttachments(pending.token).catch(() => undefined)
  }

  async function submit(): Promise<void> {
    const prompt = text.trim()
    const pending = selectionRef.current
    if (workspaceBlocked || (!prompt && !pending) || turnActive || submitting) return
    const submittingSessionId = session.id
    setSubmitting(true)
    try {
      const sent = await onSend(prompt, pending?.token)
      if (sessionIdRef.current !== submittingSessionId) return
      if (sent) setText('')
      if (pending && selectionRef.current?.token === pending.token) {
        replaceSelection(undefined)
        if (!sent) void onCancelAttachments(pending.token).catch(() => undefined)
      }
    } finally {
      if (sessionIdRef.current === submittingSessionId) setSubmitting(false)
    }
  }

  return (
    <div className="composer-shell">
      <div className="composer" data-testid="composer">
        <textarea
          ref={textarea}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
          onPaste={(event) => {
            const items = event.clipboardData ? Array.from(event.clipboardData.items) : []
            if (!items.some((item) => item.kind === 'file' && item.type.startsWith('image/'))) return
            // Main reads the image straight from the system clipboard; the
            // renderer only reports that a paste happened.
            event.preventDefault()
            void acquireAttachments(onCaptureClipboardImage)
          }}
          placeholder="Plan, build, or / for skills"
          aria-label="Message Grok"
          rows={2}
          disabled={workspaceBlocked || turnActive || submitting}
          title={workspaceBlocked ? 'Restore the workspace before starting new work.' : undefined}
          data-testid="prompt-input"
        />
        {selection ? (
          <div className="attachment-strip" data-testid="attachment-strip">
            <div className="attachment-chips">
              {selection.attachments.map((attachment, index) => (
                attachment.kind === 'image' && attachment.preview && !privacy.enabled ? (
                  <button
                    type="button"
                    className="attachment-thumb"
                    key={`${attachment.kind}-${attachment.displayName}-${index}`}
                    title={attachment.displayName}
                    aria-label={`View ${attachment.displayName}`}
                    onClick={(event) => onPreviewImage({
                      src: attachment.preview!,
                      name: attachment.displayName,
                      path: attachment.path,
                      origin: event.currentTarget.getBoundingClientRect()
                    })}
                  >
                    <img src={attachment.preview} alt={attachment.displayName} draggable={false} />
                  </button>
                ) : (
                  <span
                    className="attachment-chip"
                    data-attachment-kind={attachment.kind}
                    key={`${attachment.kind}-${attachment.displayName}-${index}`}
                    title={privacy.path(attachment.displayName)}
                  >
                    {attachment.kind === 'image' ? <Image size={12} /> : <FileText size={12} />}
                    <span>{privacy.path(attachment.displayName)}</span>
                  </span>
                )
              ))}
            </div>
            <button type="button" onClick={clearAttachments} aria-label="Clear attachments">
              <X size={13} /> Clear
            </button>
          </div>
        ) : null}
        <div className="composer-controls">
          <div className="composer-left">
            <button
              className="composer-icon"
              type="button"
              aria-label="Attach files"
              data-testid="attach-files"
              onClick={() => void chooseAttachments()}
              disabled={workspaceBlocked || turnActive || choosingAttachments || submitting}
              title={workspaceBlocked ? 'Restore the workspace before attaching files.' : undefined}
            ><Paperclip size={15} /></button>
            {savedAgents.length > 0 ? (
              <div
                className="composer-agent-control"
                title={turnActive
                  ? 'Stop the current response before changing the Saved Agent.'
                  : workspaceBlocked
                    ? 'Restore the workspace before changing the Saved Agent.'
                    : 'Changing the Saved Agent reconnects this chat.'}
              >
                <AgentAvatar
                  glyph={session.savedAgent?.glyph ?? 'person.fill'}
                  color={session.savedAgent?.color ?? '#697181'}
                  {...(savedAgentName ? { label: savedAgentName } : {})}
                  size="small"
                  redacted={privacy.enabled}
                />
                <select
                  value={savedAgentValue}
                  aria-label="Saved Agent"
                  disabled={workspaceBlocked || turnActive || bindingAgent}
                  onChange={(event) => void bindSavedAgent(event.target.value)}
                >
                  <option value="none">Grok · no saved agent</option>
                  {savedAgents.map((agent, index) => (
                    <option key={agent.id} value={`agent-${index}`}>
                      {privacy.savedAgentName(agent.name, index + 1)}
                    </option>
                  ))}
                </select>
                <span className="composer-agent-reconnect">change reconnects</span>
              </div>
            ) : session.savedAgent ? (
              <span className="composer-agent-badge" title={`Saved Agent: ${savedAgentName}`}>
                <AgentAvatar glyph={session.savedAgent.glyph} color={session.savedAgent.color} label={savedAgentName ?? 'Saved Agent'} size="small" redacted={privacy.enabled} />
                {savedAgentName}
              </span>
            ) : null}
            <select
              value={session.model}
              onChange={(event) => onUpdate({ model: event.target.value })}
              aria-label="Model"
              title={workspaceBlocked
                ? 'Restore the workspace before changing session settings.'
                : modelCapabilitiesReady
                ? 'Models reported by the connected Grok session.'
                : 'Model options become available after Grok connects.'}
              disabled={workspaceBlocked || !modelCapabilitiesReady}
            >
              {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
            <select
              value={session.permissionMode}
              onChange={(event) => onUpdate({ permissionMode: event.target.value as PublicSessionSnapshot['permissionMode'] })}
              aria-label="Tool permissions"
              title={workspaceBlocked
                ? 'Restore the workspace before changing session settings.'
                : 'Choose whether tool requests need confirmation'}
              disabled={workspaceBlocked}
            >
              <option value="ask">Ask to run</option>
              <option value="auto">Auto accept</option>
            </select>
            <select
              value={session.reasoningEffort}
              onChange={(event) => onUpdate({ reasoningEffort: event.target.value as PublicSessionSnapshot['reasoningEffort'] })}
              aria-label="Reasoning effort"
              title={workspaceBlocked ? 'Restore the workspace before changing session settings.' : undefined}
              disabled={workspaceBlocked}
            >
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">XHigh</option>
              <option value="max">Max</option>
            </select>
          </div>
          <div className="composer-right">
            <ContextUsageControl session={session} />
            <button className="composer-icon" type="button" aria-label="Voice input" disabled><Mic size={15} /></button>
            {turnActive ? (
              <button className="send-button stop" type="button" onClick={onCancel} aria-label="Stop response"><CircleStop size={16} /></button>
            ) : (
              <button
                className="send-button"
                type="button"
                onClick={() => void submit()}
                disabled={workspaceBlocked || submitting || (!text.trim() && !selection)}
                title={workspaceBlocked ? 'Restore the workspace before sending a message.' : undefined}
                aria-label="Send message"
                data-testid="send-prompt"
              ><ArrowUp size={16} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ContextUsageControl({ session }: { session: PublicSessionSnapshot }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const control = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const popoverId = useId()
  const percent = usagePercent(session.contextUsed, session.contextLimit)
  const cachedLine = formatCachedLine(
    session.lastTurnUsage?.cachedReadTokens,
    session.lastTurnUsage?.inputTokens
  )
  const hasLastTurn = session.lastTurnUsage !== undefined && Object.values(session.lastTurnUsage)
    .some((value) => value !== undefined)
  const ringLevel = percent !== undefined && percent >= 85
    ? 'high'
    : percent !== undefined && percent >= 65
      ? 'medium'
      : 'low'

  useEffect(() => setOpen(false), [session.id])

  useEffect(() => {
    if (!open) return undefined
    const dismissOnPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !control.current?.contains(event.target)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', dismissOnPointerDown)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOnPointerDown)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [open])

  return (
    <div className="context-control" ref={control}>
      <button
        ref={trigger}
        className="context-meter"
        type="button"
        aria-label="Context usage"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        title={`${formatContextSummary(session.contextUsed, session.contextLimit)} used`}
        data-testid="context-meter"
        onClick={() => setOpen((current) => !current)}
      >
        <svg className={`context-ring context-ring-${ringLevel}`} viewBox="0 0 18 18" aria-hidden="true">
          <circle className="context-ring-track" cx="9" cy="9" r="6.5" pathLength="100" />
          <circle
            className="context-ring-value"
            cx="9"
            cy="9"
            r="6.5"
            pathLength="100"
            strokeDasharray={`${percent ?? 0} 100`}
          />
        </svg>
        <span>{formatCompactTokens(session.contextUsed)}/{formatCompactTokens(session.contextLimit)}</span>
      </button>
      {open ? (
        <section
          className="context-popover"
          id={popoverId}
          role="dialog"
          aria-labelledby={titleId}
          data-testid="context-usage-popover"
        >
          <header>
            <span className="context-popover-kicker">Metering</span>
            <h2 id={titleId}>Context Usage</h2>
          </header>
          <div className="context-gauge-copy">
            <strong>{formatContextSummary(session.contextUsed, session.contextLimit)}</strong>
            {percent !== undefined ? (
              <span>{percent}% of the model&apos;s context window used</span>
            ) : null}
          </div>
          {percent !== undefined ? (
            <div
              className={`context-progress context-progress-${ringLevel}`}
              role="progressbar"
              aria-label="Model context window used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            ><span style={{ width: `${percent}%` }} /></div>
          ) : null}
          {hasLastTurn ? (
            <section className="last-turn-usage" aria-labelledby={`${titleId}-last-turn`}>
              <h3 id={`${titleId}-last-turn`}>Last turn</h3>
              <dl>
                {session.lastTurnUsage?.inputTokens !== undefined ? (
                  <UsageRow label="Input" value={formatDecimalTokens(session.lastTurnUsage.inputTokens)} />
                ) : null}
                {cachedLine !== undefined ? <UsageRow label="Cached" value={cachedLine} /> : null}
                {session.lastTurnUsage?.outputTokens !== undefined ? (
                  <UsageRow label="Output" value={formatDecimalTokens(session.lastTurnUsage.outputTokens)} />
                ) : null}
                {session.lastTurnUsage?.reasoningTokens !== undefined ? (
                  <UsageRow label="Reasoning" value={formatDecimalTokens(session.lastTurnUsage.reasoningTokens)} />
                ) : null}
                {session.lastTurnUsage?.totalTokens !== undefined ? (
                  <UsageRow label="Total" value={formatDecimalTokens(session.lastTurnUsage.totalTokens)} />
                ) : null}
              </dl>
            </section>
          ) : null}
          <p className="context-footnote">Billed cost is not reported over the Grok agent connection, so only token usage is shown.</p>
        </section>
      ) : null}
    </div>
  )
}

function UsageRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="usage-row" aria-label={`${label}: ${value}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
