import {
  AlertTriangle,
  Check,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  MAX_SAVED_AGENTS,
  SAVED_AGENT_LIMITS,
  missingStarterCrewTemplates
} from '../../../shared/agents'
import type {
  PublicAgentRosterSnapshot,
  PublicSavedAgentSummary,
  PublicSessionSnapshot
} from '../../../shared/models'
import type { SavedAgentEditorFields } from '../../../shared/ipc'
import type { PrivacyDisplayResolver } from '../../../shared/privacy'
import {
  groupGrokAgentCatalog,
  savedAgentNameValidationError,
  sanitizeGrokAgentCatalog,
  type GrokAgentCatalogViewEntry
} from '../agentPresentation'
import {
  AGENT_COLOR_CHOICES,
  AGENT_GLYPH_CHOICES,
  AgentAvatar
} from './AgentAvatar'
import { ModalSurface } from './ModalSurface'

interface AgentsSettingsProps {
  active: boolean
  roster: PublicAgentRosterSnapshot
  sessions: readonly PublicSessionSnapshot[]
  cliAvailable: boolean
  projectId?: string
  projectName?: string
  workspaceReady: boolean
  privacy: PrivacyDisplayResolver
}

interface EditorTarget {
  expectedRevision: number
  agent?: PublicSavedAgentSummary
}

type CatalogState =
  | { status: 'idle' | 'no-project' }
  | { status: 'unavailable'; reason: 'cli' | 'workspace' }
  | { status: 'loading'; projectId: string; projectName: string }
  | { status: 'ready'; projectId: string; projectName: string; entries: GrokAgentCatalogViewEntry[] }
  | { status: 'error'; projectId: string; projectName: string }

export function AgentsSettings({
  active,
  roster,
  sessions,
  cliAvailable,
  projectId,
  projectName,
  workspaceReady,
  privacy
}: AgentsSettingsProps): React.JSX.Element {
  const [editor, setEditor] = useState<EditorTarget>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'idle' })
  const [catalogReload, setCatalogReload] = useState(0)
  const catalogRequestSequence = useRef(0)

  const bindingCountByAgent = useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of sessions) {
      if (session.savedAgentId) {
        counts.set(session.savedAgentId, (counts.get(session.savedAgentId) ?? 0) + 1)
      }
    }
    return counts
  }, [sessions])

  const missingStarterCount = roster.status === 'ready'
    ? missingStarterCrewTemplates(roster.agents).length
    : 0
  const starterCapacityExceeded = roster.status === 'ready' &&
    roster.agents.length + missingStarterCount > MAX_SAVED_AGENTS

  useEffect(() => {
    if (!privacy.enabled) return
    setEditor(undefined)
    setError(undefined)
    setNotice(undefined)
  }, [privacy.enabled])

  useEffect(() => {
    const sequence = ++catalogRequestSequence.current
    if (!active) {
      setCatalog({ status: 'idle' })
      return
    }
    if (!projectId || !projectName) {
      setCatalog({ status: 'no-project' })
      return
    }
    if (!cliAvailable) {
      setCatalog({ status: 'unavailable', reason: 'cli' })
      return
    }
    if (!workspaceReady) {
      setCatalog({ status: 'unavailable', reason: 'workspace' })
      return
    }

    setCatalog({ status: 'loading', projectId, projectName })
    void window.grokbuild.listGrokAgentCatalog({ projectId }).then((result) => {
      if (catalogRequestSequence.current !== sequence) return
      setCatalog({
        status: 'ready',
        projectId,
        projectName,
        entries: sanitizeGrokAgentCatalog(result)
      })
    }).catch(() => {
      if (catalogRequestSequence.current !== sequence) return
      setCatalog({ status: 'error', projectId, projectName })
    })

    return () => {
      if (catalogRequestSequence.current === sequence) catalogRequestSequence.current += 1
    }
  }, [active, catalogReload, cliAvailable, projectId, projectName, workspaceReady])

  async function runMutation(
    operation: string,
    action: () => Promise<unknown>,
    success: string
  ): Promise<boolean> {
    if (busy) return false
    setBusy(operation)
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      setNotice(success)
      return true
    } catch {
      setError('The roster changed or could not be updated safely. Review the latest list, then try again.')
      return false
    } finally {
      setBusy(undefined)
    }
  }

  function openEditor(agent?: PublicSavedAgentSummary): void {
    if (roster.status !== 'ready' || privacy.enabled) return
    setError(undefined)
    setNotice(undefined)
    setEditor({ expectedRevision: roster.revision, ...(agent ? { agent } : {}) })
  }

  async function saveEditor(fields: SavedAgentEditorFields): Promise<boolean> {
    const target = editor
    if (!target) return false
    const changesRuntimeProfile = Boolean(
      target.agent && (
        target.agent.name !== fields.name ||
        target.agent.mission !== fields.mission
      )
    )
    const succeeded = target.agent
      ? await runMutation('save', () => window.grokbuild.updateSavedAgent({
          expectedRevision: target.expectedRevision,
          agentId: target.agent!.id,
          changes: { ...fields, isPinned: target.agent!.isPinned }
        }), changesRuntimeProfile
          ? `${target.agent.name} was updated. Assigned chats reconnect with the new instructions.`
          : `${target.agent.name} appearance was updated locally.`)
      : await runMutation('save', () => window.grokbuild.createSavedAgent({
          expectedRevision: target.expectedRevision,
          draft: { ...fields, isPinned: false }
        }), `${fields.name.trim()} was saved locally.`)
    if (succeeded) setEditor(undefined)
    return succeeded
  }

  async function togglePinned(agent: PublicSavedAgentSummary): Promise<void> {
    if (roster.status !== 'ready') return
    await runMutation(`pin:${agent.name}`, () => window.grokbuild.updateSavedAgent({
      expectedRevision: roster.revision,
      agentId: agent.id,
      changes: {
        name: agent.name,
        mission: agent.mission,
        glyph: agent.glyph,
        color: agent.color,
        isPinned: !agent.isPinned
      }
    }), agent.isPinned ? `${agent.name} was unpinned.` : `${agent.name} was pinned.`)
  }

  async function deleteAgent(agent: PublicSavedAgentSummary): Promise<void> {
    if (roster.status !== 'ready' || busy) return
    setBusy(`delete:${agent.name}`)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await window.grokbuild.deleteSavedAgent({
        expectedRevision: roster.revision,
        agentId: agent.id
      })
      if (result.state === 'deleted') {
        setNotice(`${agent.name} was deleted and removed from its chats.`)
      }
    } catch {
      setError('The agent could not be deleted safely. Review the latest roster, then try again.')
    } finally {
      setBusy(undefined)
    }
  }

  async function installStarters(): Promise<void> {
    if (roster.status !== 'ready') return
    await runMutation('starters', () => window.grokbuild.installStarterAgents({
      expectedRevision: roster.revision
    }), 'The missing starter agents were added.')
  }

  async function recoverRoster(): Promise<void> {
    if (busy) return
    setBusy('recover')
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await window.grokbuild.recoverSavedAgentRoster({ expectedRevision: 0 })
      if (result.state === 'recovered') {
        setNotice('Saved Agents were recovered to a clean local roster.')
      }
    } catch {
      setError('Saved Agents could not be recovered safely. The original roster remains untouched.')
    } finally {
      setBusy(undefined)
    }
  }

  const catalogIsStale = (
    catalog.status === 'loading' || catalog.status === 'ready' || catalog.status === 'error'
  ) && catalog.projectId !== projectId
  const rosterControlsBusy = Boolean(busy)

  return (
    <div className="agents-settings">
      <section className="agents-local-section" aria-labelledby="saved-agents-heading">
        <div className="agents-section-heading">
          <div>
            <span className="settings-kicker">Local roster</span>
            <h3 id="saved-agents-heading">Saved Agents</h3>
            <p>Name or mission changes reconnect assigned chats. Pin and appearance changes stay local.</p>
          </div>
          {roster.status === 'ready' ? (
            <div className="agents-heading-actions">
              {missingStarterCount > 0 ? (
                <button
                  className="secondary-small"
                  type="button"
                  disabled={rosterControlsBusy || starterCapacityExceeded}
                  title={starterCapacityExceeded
                    ? `The starter crew needs ${missingStarterCount} open slots; ${MAX_SAVED_AGENTS - roster.agents.length} remain.`
                    : undefined}
                  onClick={() => void installStarters()}
                >
                  <Sparkles size={12} /> Starter crew
                </button>
              ) : (
                <span className="starter-installed"><Check size={11} /> Starter crew installed</span>
              )}
              <button
                className="primary-small"
                type="button"
                disabled={privacy.enabled || rosterControlsBusy || roster.agents.length >= MAX_SAVED_AGENTS}
                title={privacy.enabled ? 'Turn off Privacy Mode to create or edit Saved Agents.' : undefined}
                onClick={() => openEditor()}
              >
                <Plus size={12} /> New Agent
              </button>
            </div>
          ) : null}
        </div>

        {error ? <div className="agents-inline-error" role="alert"><AlertTriangle size={13} /> {error}</div> : null}
        {notice ? (
          <div className="agents-inline-notice" role="status">
            <Check size={13} /> {privacy.enabled ? 'Saved Agent roster updated.' : notice}
          </div>
        ) : null}

        {roster.status === 'invalid' ? (
          <div className="agents-recovery-card">
            <span><AlertTriangle size={17} /></span>
            <div>
              <strong>Saved Agents cannot be read safely</strong>
              <p>{invalidRosterMessage(roster.reason)} The existing bytes stay untouched unless you explicitly recover.</p>
            </div>
            <button
              type="button"
              disabled={rosterControlsBusy}
              onClick={() => void recoverRoster()}
            >
              {busy === 'recover' ? <RefreshCw className="spinning" size={12} /> : <RefreshCw size={12} />}
              Recover…
            </button>
          </div>
        ) : roster.agents.length === 0 ? (
          <div className="agents-empty-card">
            <AgentAvatar glyph="person.fill" color="#5E5CE6" size="large" />
            <strong>No Saved Agents yet</strong>
            <span>Create one profile or install the five-agent starter crew.</span>
          </div>
        ) : (
          <ul className="saved-agent-list">
            {roster.agents.map((agent, index) => {
              const bindingCount = bindingCountByAgent.get(agent.id) ?? 0
              const displayName = privacy.savedAgentName(agent.name, index + 1)
              return (
                <li key={agent.id}>
                  <AgentAvatar
                    glyph={agent.glyph}
                    color={agent.color}
                    label={displayName}
                    size="large"
                    redacted={privacy.enabled}
                  />
                  <div className="saved-agent-copy">
                    <span>
                      <strong>{displayName}</strong>
                      {agent.isPinned ? <span className="saved-agent-pin"><Pin size={9} /> Pinned</span> : null}
                    </span>
                    <p>{privacy.savedAgentMission(agent.mission)}</p>
                    <small>{bindingCount === 0 ? 'Not assigned to a chat' : `${bindingCount} assigned ${bindingCount === 1 ? 'chat' : 'chats'}`}</small>
                  </div>
                  <div className="saved-agent-actions">
                    <button
                      type="button"
                      aria-label={agent.isPinned ? `Unpin ${displayName}` : `Pin ${displayName}`}
                      disabled={rosterControlsBusy}
                      onClick={() => void togglePinned(agent)}
                    >
                      {agent.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                    </button>
                    <button
                      type="button"
                      aria-label={`Edit ${displayName}`}
                      disabled={privacy.enabled || rosterControlsBusy}
                      title={privacy.enabled ? 'Turn off Privacy Mode to edit Saved Agents.' : undefined}
                      onClick={() => openEditor(agent)}
                    ><Pencil size={13} /></button>
                    <button
                      type="button"
                      aria-label={`Delete ${displayName}`}
                      disabled={rosterControlsBusy}
                      onClick={() => void deleteAgent(agent)}
                    ><Trash2 size={13} /></button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="agents-catalog-section" aria-labelledby="agent-catalog-heading">
        <div className="agents-section-heading">
          <div>
            <span className="settings-kicker">Read-only discovery</span>
            <h3 id="agent-catalog-heading">Grok CLI catalog</h3>
            <p>Agents reported for the selected project. Catalog entries are not local Saved Agents.</p>
          </div>
          {catalog.status === 'error' && !catalogIsStale ? (
            <button className="secondary-small" type="button" onClick={() => setCatalogReload((value) => value + 1)}>
              <RefreshCw size={12} /> Retry
            </button>
          ) : null}
        </div>
        <CatalogBody state={catalog} stale={catalogIsStale} privacy={privacy} />
      </section>

      {editor && !privacy.enabled ? createPortal(
        <AgentEditorModal
          key={editor.agent?.id ?? `new-${editor.expectedRevision}`}
          {...(editor.agent ? { agent: editor.agent } : {})}
          bindingCount={editor.agent ? bindingCountByAgent.get(editor.agent.id) ?? 0 : 0}
          rosterAgents={roster.status === 'ready' ? roster.agents : []}
          saving={busy === 'save'}
          {...(error ? { error } : {})}
          onSave={saveEditor}
          onClose={() => {
            setEditor(undefined)
            setError(undefined)
          }}
        />,
        document.body
      ) : null}
    </div>
  )
}

function CatalogBody({
  state,
  stale,
  privacy
}: {
  state: CatalogState
  stale: boolean
  privacy: PrivacyDisplayResolver
}): React.JSX.Element {
  if (privacy.enabled) {
    return (
      <div className="agent-catalog-state privacy-hidden">
        <strong>Catalog details hidden</strong>
        <span>Turn off Privacy Mode to inspect project-scoped agent names and descriptions.</span>
      </div>
    )
  }
  if (stale) return <div className="agent-catalog-state"><RefreshCw className="spinning" size={15} /><strong>Switching projects…</strong><span>Discarding the previous catalog.</span></div>
  switch (state.status) {
    case 'idle':
    case 'no-project':
      return <div className="agent-catalog-state"><strong>Select a project</strong><span>Catalog discovery always runs in an explicitly selected workspace.</span></div>
    case 'unavailable':
      return state.reason === 'cli'
        ? <div className="agent-catalog-state"><strong>Grok CLI is unavailable</strong><span>Choose a working CLI in Application settings first.</span></div>
        : <div className="agent-catalog-state"><strong>Workspace is unavailable</strong><span>Restore the selected project before reading its catalog.</span></div>
    case 'loading':
      return <div className="agent-catalog-state"><RefreshCw className="spinning" size={15} /><strong>Reading {state.projectName}…</strong><span>Inspecting the project-scoped Grok catalog.</span></div>
    case 'error':
      return <div className="agent-catalog-state error"><AlertTriangle size={15} /><strong>Catalog could not be read</strong><span>Nothing from the previous project is shown.</span></div>
    case 'ready':
      return <AgentCatalogGroups entries={state.entries} />
  }
}

export function AgentCatalogGroups({
  entries
}: {
  entries: readonly GrokAgentCatalogViewEntry[]
}): React.JSX.Element {
  const groups = groupGrokAgentCatalog(entries)
  return (
    <div className="agent-catalog-groups">
      {groups.map((group) => (
        <section key={group.sourceKind} aria-label={`${group.label} Grok agents`}>
          <div className="agent-catalog-group-heading"><span>{group.label}</span><small>{group.entries.length}</small></div>
          <ul>
            {group.entries.map((entry, index) => (
              <li key={`${entry.sourceKind}:${entry.name}:${index}`}>
                <div>
                  <strong>{entry.name}</strong>
                  {entry.pluginDisplayName ? <small>{entry.pluginDisplayName}</small> : null}
                </div>
                <p>{entry.description || 'No description supplied.'}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

interface AgentEditorModalProps {
  agent?: PublicSavedAgentSummary
  bindingCount: number
  rosterAgents: readonly PublicSavedAgentSummary[]
  saving: boolean
  error?: string
  onSave: (fields: SavedAgentEditorFields) => Promise<boolean>
  onClose: () => void
}

function AgentEditorModal({
  agent,
  bindingCount,
  rosterAgents,
  saving,
  error,
  onSave,
  onClose
}: AgentEditorModalProps): React.JSX.Element {
  const initial = useMemo(() => ({
    name: agent?.name ?? '',
    mission: agent?.mission ?? '',
    glyph: agent?.glyph ?? 'person.fill',
    color: agent?.color ?? '#5E5CE6'
  }), [agent])
  const [name, setName] = useState(initial.name)
  const [mission, setMission] = useState(initial.mission)
  const [glyph, setGlyph] = useState(initial.glyph)
  const [color, setColor] = useState(initial.color)
  const [discardPrompt, setDiscardPrompt] = useState(false)
  const dirty = name !== initial.name || mission !== initial.mission || glyph !== initial.glyph || color !== initial.color
  const runtimeProfileDirty = name.trim() !== initial.name || mission.trim() !== initial.mission
  const nameError = savedAgentNameValidationError(name, rosterAgents, agent?.id)
  const valid = !nameError && mission.trim().length > 0
  const hasLegacyGlyph = !AGENT_GLYPH_CHOICES.some((choice) => choice.value === initial.glyph)
  const colors = AGENT_COLOR_CHOICES.includes(initial.color as (typeof AGENT_COLOR_CHOICES)[number])
    ? AGENT_COLOR_CHOICES
    : [initial.color, ...AGENT_COLOR_CHOICES]

  function requestClose(): void {
    if (dirty) {
      setDiscardPrompt(true)
      return
    }
    onClose()
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!valid || saving) return
    await onSave({
      name: name.trim(),
      mission: mission.trim(),
      glyph,
      color,
      isPinned: agent?.isPinned ?? false
    })
  }

  return (
    <ModalSurface
      className="agent-editor-dialog"
      labelledBy="agent-editor-title"
      onClose={onClose}
      onRequestClose={() => {
        if (!dirty) return true
        setDiscardPrompt(true)
        return false
      }}
    >
      <form className="agent-editor" onSubmit={(event) => void submit(event)}>
        <header>
          <div>
            <span className="settings-kicker">Local profile</span>
            <h2 id="agent-editor-title">{agent ? `Edit ${agent.name}` : 'New Saved Agent'}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close editor" onClick={requestClose}><X size={15} /></button>
        </header>
        <div className="agent-editor-body">
          {error ? <div className="agents-inline-error" role="alert"><AlertTriangle size={13} /> {error}</div> : null}
          <div className="agent-form-field">
            <label htmlFor="saved-agent-name">Name</label>
            <input
              id="saved-agent-name"
              value={name}
              maxLength={SAVED_AGENT_LIMITS.nameCharacters}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={Boolean(nameError)}
              {...(nameError ? { 'aria-describedby': 'saved-agent-name-error' } : {})}
              data-modal-initial-focus
              autoComplete="off"
            />
            {nameError ? <small id="saved-agent-name-error" className="agent-field-error" role="alert">{nameError}</small> : null}
          </div>
          <div className="agent-form-field">
            <label htmlFor="saved-agent-mission">Mission</label>
            <textarea
              id="saved-agent-mission"
              value={mission}
              maxLength={SAVED_AGENT_LIMITS.missionCharacters}
              rows={4}
              onChange={(event) => setMission(event.target.value)}
              placeholder="Describe the agent's enduring job and boundaries."
              aria-describedby="saved-agent-mission-count"
            />
            <small id="saved-agent-mission-count">{mission.length}/{SAVED_AGENT_LIMITS.missionCharacters}</small>
          </div>
          <fieldset className="agent-glyph-field">
            <legend>Glyph</legend>
            <div className="agent-glyph-choices">
              {hasLegacyGlyph ? (
                <button type="button" className={glyph === initial.glyph ? 'selected' : undefined} aria-label="Keep current glyph" onClick={() => setGlyph(initial.glyph)}>
                  <AgentAvatar glyph={initial.glyph} color={color} />
                </button>
              ) : null}
              {AGENT_GLYPH_CHOICES.map((choice) => (
                <button key={choice.value} type="button" className={glyph === choice.value ? 'selected' : undefined} aria-label={choice.label} aria-pressed={glyph === choice.value} onClick={() => setGlyph(choice.value)}>
                  <AgentAvatar glyph={choice.value} color={color} />
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="agent-color-field">
            <legend>Color</legend>
            <div className="agent-color-choices">
              {colors.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={color === choice ? 'selected' : undefined}
                  style={{ backgroundColor: choice }}
                  aria-label={choice === initial.color && !AGENT_COLOR_CHOICES.includes(choice as (typeof AGENT_COLOR_CHOICES)[number]) ? 'Keep current color' : `Use color ${choice}`}
                  aria-pressed={color === choice}
                  onClick={() => setColor(choice)}
                >{color === choice ? <Check size={11} /> : null}</button>
              ))}
            </div>
          </fieldset>
          {agent && bindingCount > 0 && runtimeProfileDirty ? (
            <p className="agent-reconnect-note">Changing the name or mission reconnects {bindingCount} assigned {bindingCount === 1 ? 'chat' : 'chats'}.</p>
          ) : null}
        </div>
        <footer>
          {discardPrompt ? (
            <div className="agent-discard-confirm" role="alert">
              <span>Discard unsaved changes?</span>
              <button type="button" onClick={() => setDiscardPrompt(false)}>Keep editing</button>
              <button className="danger-text-button" type="button" onClick={onClose}>Discard</button>
            </div>
          ) : (
            <>
              <button className="secondary-small" type="button" onClick={requestClose}>Cancel</button>
              <button className="primary-small" type="submit" disabled={!valid || saving}>{saving ? 'Saving…' : 'Save Agent'}</button>
            </>
          )}
        </footer>
      </form>
    </ModalSurface>
  )
}

function invalidRosterMessage(reason: Extract<PublicAgentRosterSnapshot, { status: 'invalid' }>['reason']): string {
  switch (reason) {
    case 'malformed': return 'The roster format is invalid.'
    case 'non-regular': return 'The roster is not a regular file.'
    case 'symlink': return 'The roster is a symbolic link.'
    case 'oversize': return 'The roster exceeds the safe size limit.'
    case 'unreadable': return 'The roster cannot be read.'
  }
}
