import {
  AlertTriangle,
  Check,
  Database,
  FileText,
  RefreshCw,
  ShieldCheck,
  Trash2
} from 'lucide-react'
import React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MEMORY_PUBLIC_LIMITS,
  type MemoryDeleteResult,
  type PublicMemoryFileContents,
  type PublicMemoryFileSummary
} from '../../../shared/memory'
import type { PrivacyDisplayResolver } from '../../../shared/privacy'
import {
  groupMemorySummaries,
  memorySummaryDisplay,
  utf8ByteLength
} from '../memoryPresentation'
import { SafeMarkdown } from './SafeMarkdown'

interface MemorySettingsProps {
  active: boolean
  memoryEnabled: boolean
  privacy: PrivacyDisplayResolver
  onApplySetting: (input: { memoryEnabled: boolean }) => Promise<void>
  onList: () => Promise<PublicMemoryFileSummary[]>
  onRead: (input: { token: string }) => Promise<PublicMemoryFileContents>
  onRemember: (input: { note: string }) => Promise<void>
  onDelete: (input: { token: string }) => Promise<MemoryDeleteResult>
}

type ListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; entries: PublicMemoryFileSummary[] }
  | { status: 'error' }

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; summary: PublicMemoryFileSummary }
  | { status: 'ready'; value: PublicMemoryFileContents }
  | { status: 'error'; summary: PublicMemoryFileSummary }

type Feedback =
  | { tone: 'error' | 'success' | 'neutral'; message: string }
  | undefined

export function MemorySettings({
  active,
  memoryEnabled,
  privacy,
  onApplySetting,
  onList,
  onRead,
  onRemember,
  onDelete
}: MemorySettingsProps): React.JSX.Element {
  const [appliedEnabled, setAppliedEnabled] = useState(memoryEnabled)
  const [draftEnabled, setDraftEnabled] = useState(memoryEnabled)
  const [applyBusy, setApplyBusy] = useState(false)
  const [applyFeedback, setApplyFeedback] = useState<Feedback>()
  const [listState, setListState] = useState<ListState>({ status: 'idle' })
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' })
  const [note, setNote] = useState('')
  const [memoryFeedback, setMemoryFeedback] = useState<Feedback>()
  const [rememberBusy, setRememberBusy] = useState(false)
  const [deletingToken, setDeletingToken] = useState<string>()
  const listSequence = useRef(0)
  const readSequence = useRef(0)
  const activeRef = useRef(active)
  const privacyEnabledRef = useRef(privacy.enabled)
  activeRef.current = active
  privacyEnabledRef.current = privacy.enabled

  useEffect(() => {
    setAppliedEnabled(memoryEnabled)
    setDraftEnabled(memoryEnabled)
    setApplyFeedback(undefined)
  }, [memoryEnabled])

  const loadMemory = useCallback(async (): Promise<void> => {
    if (!activeRef.current || privacyEnabledRef.current) return
    const sequence = ++listSequence.current
    readSequence.current += 1
    setListState({ status: 'loading' })
    setPreview({ status: 'idle' })
    try {
      const entries = await onList()
      if (
        listSequence.current !== sequence ||
        !activeRef.current ||
        privacyEnabledRef.current
      ) return
      setListState({ status: 'ready', entries })
    } catch {
      if (
        listSequence.current !== sequence ||
        !activeRef.current ||
        privacyEnabledRef.current
      ) return
      setListState({ status: 'error' })
    }
  }, [onList])

  useEffect(() => {
    if (!active || privacy.enabled) {
      listSequence.current += 1
      readSequence.current += 1
      setListState({ status: 'idle' })
      setPreview({ status: 'idle' })
      setNote('')
      setMemoryFeedback(undefined)
      setDeletingToken(undefined)
      return
    }
    void loadMemory()
    return () => {
      listSequence.current += 1
      readSequence.current += 1
    }
  }, [active, loadMemory, privacy.enabled])

  async function applyMemorySetting(): Promise<void> {
    if (applyBusy || draftEnabled === appliedEnabled) return
    const requested = draftEnabled
    setApplyBusy(true)
    setApplyFeedback(undefined)
    try {
      await onApplySetting({ memoryEnabled: requested })
      setAppliedEnabled(requested)
      setDraftEnabled(requested)
      setApplyFeedback({
        tone: 'success',
        message: requested
          ? 'Memory enabled. Existing sessions restarted with the new launch policy.'
          : 'Memory disabled. Existing sessions restarted with the new launch policy.'
      })
    } catch {
      setApplyFeedback({
        tone: 'error',
        message: 'The launch policy could not be changed safely. Your staged choice is still here.'
      })
    } finally {
      setApplyBusy(false)
    }
  }

  async function readMemory(summary: PublicMemoryFileSummary): Promise<void> {
    if (!activeRef.current || privacyEnabledRef.current) return
    const sequence = ++readSequence.current
    setMemoryFeedback(undefined)
    setPreview({ status: 'loading', summary })
    try {
      const value = await onRead({ token: summary.token })
      if (
        readSequence.current !== sequence ||
        !activeRef.current ||
        privacyEnabledRef.current
      ) return
      setPreview({ status: 'ready', value })
    } catch {
      if (
        readSequence.current !== sequence ||
        !activeRef.current ||
        privacyEnabledRef.current
      ) return
      setPreview({ status: 'error', summary })
    }
  }

  async function remember(): Promise<void> {
    if (privacyEnabledRef.current || !activeRef.current || !appliedEnabled || rememberBusy) return
    const trimmed = note.trim()
    const byteLength = utf8ByteLength(trimmed)
    if (byteLength === 0 || byteLength > MEMORY_PUBLIC_LIMITS.noteBytes) return
    setRememberBusy(true)
    setMemoryFeedback(undefined)
    try {
      await onRemember({ note: trimmed })
      if (!activeRef.current || privacyEnabledRef.current) return
      setNote('')
      setMemoryFeedback({ tone: 'success', message: 'Note saved to global memory.' })
      await loadMemory()
    } catch {
      setMemoryFeedback({
        tone: 'error',
        message: 'The note could not be saved safely. Your draft is unchanged.'
      })
    } finally {
      setRememberBusy(false)
    }
  }

  async function deleteMemory(summary: PublicMemoryFileSummary): Promise<void> {
    if (
      privacyEnabledRef.current ||
      !activeRef.current ||
      !summary.canDelete ||
      deletingToken
    ) return
    setDeletingToken(summary.token)
    setMemoryFeedback(undefined)
    try {
      const result = await onDelete({ token: summary.token })
      if (!activeRef.current || privacyEnabledRef.current) return
      if (result.state === 'cancelled') {
        setMemoryFeedback({ tone: 'neutral', message: 'Deletion cancelled. Nothing changed.' })
        return
      }
      setMemoryFeedback({ tone: 'success', message: 'Session memory deleted.' })
      await loadMemory()
    } catch {
      if (activeRef.current && !privacyEnabledRef.current) {
        setMemoryFeedback({
          tone: 'error',
          message: 'The session memory could not be deleted safely. Refresh and try again.'
        })
      }
    } finally {
      setDeletingToken(undefined)
    }
  }

  const noteBytes = useMemo(() => utf8ByteLength(note.trim()), [note])
  const noteTooLarge = noteBytes > MEMORY_PUBLIC_LIMITS.noteBytes
  const dirtySetting = draftEnabled !== appliedEnabled

  return (
    <div className="memory-settings">
      <section className="memory-policy" aria-labelledby="memory-settings-heading">
        <div className="memory-heading">
          <div>
            <span className="settings-kicker">Grok CLI storage</span>
            <h3 id="memory-settings-heading">Memory</h3>
            <p>Grok CLI owns memory files. This setting selects the CLI launch policy; applying it safely restarts existing sessions.</p>
          </div>
          <div className="memory-policy-state" aria-label={`Applied memory policy: ${appliedEnabled ? 'on' : 'off'}`}>
            <Database size={13} /> {appliedEnabled ? 'On' : 'Off'}
          </div>
        </div>
        <div className="memory-policy-controls">
          <label className="switch-row">
            <span>
              <strong>Use memory in Grok sessions</strong>
              <small>The staged choice takes effect only after sessions restart.</small>
            </span>
            <input
              type="checkbox"
              checked={draftEnabled}
              aria-label="Use memory in Grok sessions"
              disabled={applyBusy}
              onChange={(event) => {
                setDraftEnabled(event.target.checked)
                setApplyFeedback(undefined)
              }}
            />
          </label>
          <button
            className="primary-small memory-apply-button"
            type="button"
            disabled={!dirtySetting || applyBusy}
            onClick={() => void applyMemorySetting()}
          >
            {applyBusy ? <RefreshCw className="spinning" size={12} /> : <RefreshCw size={12} />}
            {applyBusy ? 'Restarting Sessions…' : 'Apply & Restart Sessions'}
          </button>
        </div>
        {applyFeedback ? <InlineFeedback feedback={applyFeedback} /> : null}
      </section>

      {privacy.enabled ? (
        <section className="memory-privacy-state" aria-label="Memory details hidden">
          <ShieldCheck size={18} />
          <div>
            <strong>Memory details hidden</strong>
            <p>Turn off Privacy Mode to browse, read, remember, or delete memory entries. Files and stored notes are unchanged.</p>
          </div>
        </section>
      ) : (
        <>
          <section className="memory-browser" aria-labelledby="memory-browser-heading">
            <div className="memory-section-heading">
              <div>
                <h4 id="memory-browser-heading">Browse</h4>
                <p>Bounded Markdown previews from the CLI-owned store.</p>
              </div>
              <button
                className="secondary-small"
                type="button"
                disabled={listState.status === 'loading'}
                onClick={() => void loadMemory()}
              >
                <RefreshCw className={listState.status === 'loading' ? 'spinning' : undefined} size={12} />
                Refresh
              </button>
            </div>
            <div className="memory-browser-grid">
              <MemoryList
                state={listState}
                preview={preview}
                {...(deletingToken ? { deletingToken } : {})}
                onRead={readMemory}
                onDelete={deleteMemory}
                onRetry={loadMemory}
              />
              <MemoryPreview state={preview} onRetry={readMemory} />
            </div>
          </section>

          <section className="memory-remember" aria-labelledby="memory-remember-heading">
            <div className="memory-section-heading">
              <div>
                <h4 id="memory-remember-heading">Remember</h4>
                <p>Append one note to global memory. Grok CLI decides how it is recalled.</p>
              </div>
            </div>
            <label htmlFor="memory-note">Note</label>
            <textarea
              id="memory-note"
              value={note}
              maxLength={MEMORY_PUBLIC_LIMITS.noteBytes}
              disabled={!appliedEnabled || rememberBusy}
              aria-describedby="memory-note-help memory-note-count"
              aria-invalid={noteTooLarge || undefined}
              placeholder={appliedEnabled ? 'A durable fact, preference, or convention…' : 'Enable memory to save a note.'}
              onChange={(event) => {
                setNote(event.target.value)
                setMemoryFeedback(undefined)
              }}
            />
            <div className="memory-note-meta">
              <span id="memory-note-help">
                {noteTooLarge ? 'The note exceeds the 8 KiB UTF-8 limit.' : 'Plain text or Markdown · saved only to global memory'}
              </span>
              <span id="memory-note-count" className={noteTooLarge ? 'over-limit' : undefined}>
                {noteBytes.toLocaleString('en-US')} / {MEMORY_PUBLIC_LIMITS.noteBytes.toLocaleString('en-US')} bytes
              </span>
            </div>
            <div className="memory-remember-footer">
              {memoryFeedback ? <InlineFeedback feedback={memoryFeedback} /> : <span />}
              <button
                className="primary-small"
                type="button"
                disabled={!appliedEnabled || rememberBusy || noteBytes === 0 || noteTooLarge}
                onClick={() => void remember()}
              >
                {rememberBusy ? <RefreshCw className="spinning" size={12} /> : <Check size={12} />}
                {rememberBusy ? 'Saving…' : 'Remember'}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function MemoryList({
  state,
  preview,
  deletingToken,
  onRead,
  onDelete,
  onRetry
}: {
  state: ListState
  preview: PreviewState
  deletingToken?: string
  onRead: (summary: PublicMemoryFileSummary) => Promise<void>
  onDelete: (summary: PublicMemoryFileSummary) => Promise<void>
  onRetry: () => Promise<void>
}): React.JSX.Element {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className="memory-list-state" role="status">
        <RefreshCw className="spinning" size={15} />
        <strong>Loading memory…</strong>
        <span>Reading public summaries from Grok CLI storage.</span>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="memory-list-state error" role="alert">
        <AlertTriangle size={15} />
        <strong>Memory could not be listed</strong>
        <span>No stale entries are shown.</span>
        <button className="secondary-small" type="button" onClick={() => void onRetry()}>Retry</button>
      </div>
    )
  }
  if (state.entries.length === 0) {
    return (
      <div className="memory-list-state empty">
        <FileText size={16} />
        <strong>No memory files yet</strong>
        <span>Save a note below to create global memory.</span>
      </div>
    )
  }

  const selectedToken = preview.status === 'loading' || preview.status === 'error'
    ? preview.summary.token
    : preview.status === 'ready'
      ? preview.value.token
      : undefined

  return (
    <div className="memory-groups" aria-label="Memory files">
      {groupMemorySummaries(state.entries).map((group) => (
        <section key={group.scope} aria-label={`${group.label} memory`}>
          <div className="memory-group-heading"><span>{group.label}</span><small>{group.entries.length}</small></div>
          <ul>
            {group.entries.map((summary) => {
              const display = memorySummaryDisplay(summary)
              const selected = selectedToken === summary.token
              const deleting = deletingToken === summary.token
              return (
                <li key={summary.token} className={selected ? 'selected' : undefined}>
                  <button
                    className="memory-row-open"
                    type="button"
                    aria-label={`Open ${display.title}`}
                    aria-pressed={selected}
                    onClick={() => void onRead(summary)}
                  >
                    <span className="memory-row-title">{display.title}</span>
                    <span className="memory-row-meta">
                      <span>{display.scopeLabel}</span>
                      {display.workspaceLabel ? <span>{display.workspaceLabel}</span> : null}
                      <span>{display.sizeLabel}</span>
                      <span>{display.dateLabel}</span>
                    </span>
                  </button>
                  {summary.canDelete ? (
                    <button
                      className="memory-delete-button"
                      type="button"
                      aria-label={`Delete ${display.title}`}
                      disabled={Boolean(deletingToken)}
                      onClick={() => void onDelete(summary)}
                    >
                      {deleting ? <RefreshCw className="spinning" size={12} /> : <Trash2 size={12} />}
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

function MemoryPreview({
  state,
  onRetry
}: {
  state: PreviewState
  onRetry: (summary: PublicMemoryFileSummary) => Promise<void>
}): React.JSX.Element {
  if (state.status === 'idle') {
    return (
      <div className="memory-preview-state">
        <FileText size={17} />
        <strong>Select a memory file</strong>
        <span>Its bounded Markdown preview appears here.</span>
      </div>
    )
  }
  if (state.status === 'loading') {
    return (
      <div className="memory-preview-state" role="status">
        <RefreshCw className="spinning" size={15} />
        <strong>Opening memory…</strong>
        <span>Revalidating the selected file.</span>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="memory-preview-state error" role="alert">
        <AlertTriangle size={15} />
        <strong>Preview unavailable</strong>
        <span>The selection may have changed or expired.</span>
        <button className="secondary-small" type="button" onClick={() => void onRetry(state.summary)}>Retry preview</button>
      </div>
    )
  }
  const display = memorySummaryDisplay(state.value)
  return (
    <article className="memory-preview" aria-label={`${display.title} preview`}>
      <header>
        <div>
          <span>{display.scopeLabel}{display.workspaceLabel ? ` · ${display.workspaceLabel}` : ''}</span>
          <h5>{display.title}</h5>
        </div>
        <small>{display.sizeLabel} · {display.dateLabel}</small>
      </header>
      <div className="memory-preview-scroll">
        <SafeMarkdown source={state.value.contents} />
      </div>
    </article>
  )
}

function InlineFeedback({ feedback }: { feedback: NonNullable<Feedback> }): React.JSX.Element {
  const Icon = feedback.tone === 'error'
    ? AlertTriangle
    : feedback.tone === 'success'
      ? Check
      : FileText
  return (
    <div
      className={`memory-feedback ${feedback.tone}`}
      role={feedback.tone === 'error' ? 'alert' : 'status'}
    >
      <Icon size={12} /> {feedback.message}
    </div>
  )
}
