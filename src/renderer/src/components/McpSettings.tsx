import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  McpDoctorResult,
  McpScope,
  McpServerSummary,
  McpTransport
} from '../../../shared/mcp'

interface McpSettingsProps {
  active: boolean
  cliAvailable: boolean
  projectId?: string | undefined
  projectName?: string | undefined
}

interface PairDraft {
  id: string
  name: string
  value: string
}

interface DoctorTarget {
  name?: string | undefined
}

export function McpSettings({
  active,
  cliAvailable,
  projectId,
  projectName
}: McpSettingsProps): React.JSX.Element {
  const [servers, setServers] = useState<McpServerSummary[]>([])
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<McpScope>('user')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [url, setUrl] = useState('')
  const [environment, setEnvironment] = useState<PairDraft[]>([])
  const [headers, setHeaders] = useState<PairDraft[]>([])
  const [pendingRemoval, setPendingRemoval] = useState<string>()
  const [doctorTarget, setDoctorTarget] = useState<DoctorTarget>()
  const [doctorResult, setDoctorResult] = useState<McpDoctorResult>()

  useEffect(() => {
    if (!active || !cliAvailable || !projectName) return
    void loadServers()
  }, [active, cliAvailable, projectId, projectName])

  async function loadServers(): Promise<void> {
    setBusy('list')
    setError(undefined)
    try {
      const result = await window.grokbuild.listMcp()
      setServers(result.servers)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(undefined)
    }
  }

  async function mutate(
    operation: string,
    action: () => Promise<unknown>,
    success: string
  ): Promise<boolean> {
    setBusy(operation)
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      const result = await window.grokbuild.listMcp()
      setServers(result.servers)
      setNotice(success)
      return true
    } catch (caught) {
      setError(errorMessage(caught))
      return false
    } finally {
      setBusy(undefined)
    }
  }

  async function submitAdd(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const common = { name, scope, transport }
    const action = transport === 'stdio'
      ? () => window.grokbuild.addMcp({
          ...common,
          transport,
          command,
          args: splitLines(argsText),
          environment: environment
            .filter((entry) => entry.name || entry.value)
            .map(({ name: variableName, value }) => ({ name: variableName, value }))
        })
      : () => window.grokbuild.addMcp({
          ...common,
          transport,
          url,
          headers: headers
            .filter((entry) => entry.name || entry.value)
            .map(({ name: headerName, value }) => ({ name: headerName, value }))
        })
    const succeeded = await mutate(`add:${name}`, action, `${name} was added to ${scope} configuration.`)
    if (!succeeded) return
    setShowAdd(false)
    resetAddForm()
  }

  async function runDoctor(): Promise<void> {
    const target = doctorTarget
    if (!target) return
    setBusy('doctor')
    setError(undefined)
    setNotice(undefined)
    setDoctorResult(undefined)
    try {
      const result = await window.grokbuild.doctorMcp({
        ...(target.name ? { name: target.name } : {}),
        confirmExternalLaunch: true
      })
      setDoctorResult(result)
      setDoctorTarget(undefined)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(undefined)
    }
  }

  function resetAddForm(): void {
    setName('')
    setScope('user')
    setTransport('stdio')
    setCommand('')
    setArgsText('')
    setUrl('')
    setEnvironment([])
    setHeaders([])
  }

  if (!projectName) {
    return (
      <div className="mcp-empty" data-testid="mcp-settings-empty">
        <Server size={22} />
        <strong>Select a project first</strong>
        <p>MCP project scope and discovery follow the folder selected in the sidebar.</p>
      </div>
    )
  }

  if (!cliAvailable) {
    return (
      <div className="mcp-empty" data-testid="mcp-settings-empty">
        <AlertTriangle size={22} />
        <strong>Grok CLI unavailable</strong>
        <p>Choose a working Grok CLI under Application before managing MCP servers.</p>
      </div>
    )
  }

  return (
    <div className="mcp-settings" data-testid="mcp-settings">
      <div className="mcp-heading">
        <div>
          <span className="settings-kicker">Selected project</span>
          <h3>MCP Servers</h3>
          <p>CLI-owned configuration for <strong>{projectName}</strong>. Secrets remain masked.</p>
        </div>
        <div className="mcp-heading-actions">
          <button
            className="secondary-small"
            type="button"
            onClick={() => setDoctorTarget({})}
            disabled={Boolean(busy)}
          >
            Run diagnostics
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => void loadServers()}
            disabled={Boolean(busy)}
            aria-label="Refresh MCP servers"
          >
            <RefreshCw size={14} className={busy === 'list' ? 'spinning' : undefined} />
          </button>
        </div>
      </div>

      {error ? <div className="mcp-inline-error" role="alert"><AlertTriangle size={14} />{error}</div> : null}
      {notice ? <div className="mcp-inline-notice" role="status"><CheckCircle2 size={14} />{notice}</div> : null}

      {doctorTarget ? (
        <section className="mcp-doctor-confirm" role="alertdialog" aria-labelledby="mcp-doctor-title">
          <AlertTriangle size={17} />
          <div>
            <strong id="mcp-doctor-title">
              {doctorTarget.name ? `Start ${doctorTarget.name} for diagnostics?` : 'Start configured servers for diagnostics?'}
            </strong>
            <p>Grok Doctor launches external MCP commands, performs a handshake, and requests their tool list.</p>
            <div className="mcp-confirm-actions">
              <button type="button" className="secondary-small" onClick={() => setDoctorTarget(undefined)}>Cancel</button>
              <button type="button" className="primary-small" onClick={() => void runDoctor()} disabled={busy === 'doctor'}>
                Run external checks
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {doctorResult ? <DoctorReport result={doctorResult} onClose={() => setDoctorResult(undefined)} /> : null}

      <div className="mcp-list-heading">
        <span>{servers.length} configured</span>
        <button
          type="button"
          className="mcp-add-toggle"
          onClick={() => setShowAdd((current) => !current)}
          aria-expanded={showAdd}
        >
          <Plus size={13} /> Add server {showAdd ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      {showAdd ? (
        <form className="mcp-add-form" onSubmit={(event) => void submitAdd(event)} data-testid="mcp-add-form">
          <div className="mcp-form-grid">
            <label>
              Name
              <input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={128} autoComplete="off" title="Letters, numbers, underscores, and hyphens" />
            </label>
            <label>
              Scope
              <select aria-label="Scope" value={scope} onChange={(event) => setScope(event.target.value as McpScope)}>
                <option value="user">User</option>
                <option value="project">Project</option>
              </select>
            </label>
            <label>
              Transport
              <select aria-label="Transport" value={transport} onChange={(event) => setTransport(event.target.value as McpTransport)}>
                <option value="stdio">stdio</option>
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </label>
          </div>

          {transport === 'stdio' ? (
            <>
              <label>
                Command
                <input aria-label="Command" value={command} onChange={(event) => setCommand(event.target.value)} required placeholder="npx" autoComplete="off" />
              </label>
              <label>
                Arguments <small>One argument per line; spaces are preserved.</small>
                <textarea aria-label="Arguments" value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-example'} spellCheck={false} />
              </label>
              <PairEditor
                label="Environment"
                entries={environment}
                namePlaceholder="TOKEN"
                onChange={setEnvironment}
              />
            </>
          ) : (
            <>
              <label>
                URL
                <input aria-label="URL" value={url} onChange={(event) => setUrl(event.target.value)} required type="url" placeholder="https://mcp.example.com/mcp" autoComplete="off" />
              </label>
              <PairEditor
                label="Headers"
                entries={headers}
                namePlaceholder="Authorization"
                onChange={setHeaders}
              />
            </>
          )}

          <div className="mcp-form-actions">
            <button type="button" className="secondary-small" onClick={() => { setShowAdd(false); resetAddForm() }}>Cancel</button>
            <button type="submit" className="primary-small" disabled={Boolean(busy)}>Add server</button>
          </div>
        </form>
      ) : null}

      {busy === 'list' && servers.length === 0 ? (
        <div className="mcp-loading" role="status"><RefreshCw size={14} className="spinning" /> Reading CLI configuration…</div>
      ) : servers.length === 0 ? (
        <div className="mcp-empty compact">
          <Server size={19} />
          <strong>No servers configured</strong>
          <p>Add a scoped server definition; Grok watches configuration changes automatically.</p>
        </div>
      ) : (
        <ul className="mcp-server-list" data-testid="mcp-server-list">
          {servers.map((server) => {
            const key = `${server.scope}:${server.name}`
            const removable = server.scope === 'user' || server.scope === 'project'
            const actionable = server.name !== '[invalid-name]'
            return (
              <li key={key} className={!server.enabled ? 'disabled' : undefined}>
                <span className={`mcp-status-dot ${server.enabled ? 'enabled' : 'disabled'}`} aria-hidden="true" />
                <div className="mcp-server-copy">
                  <div className="mcp-server-title">
                    <strong>{server.name}</strong>
                    <span>{server.transport}</span>
                    <span>{server.scope}</span>
                    {!server.enabled ? <span className="mcp-disabled-label">disabled</span> : null}
                  </div>
                  <div className="mcp-server-meta">
                    <code>{server.targetRedacted}</code>
                    {server.hasEnvironment ? <span>environment configured</span> : null}
                    {server.hasHeaders ? <span>headers configured</span> : null}
                  </div>
                  {pendingRemoval === key ? (
                    <div className="mcp-remove-confirm">
                      <span>Remove the {server.scope} definition?</span>
                      <button type="button" onClick={() => setPendingRemoval(undefined)}>Cancel</button>
                      <button
                        type="button"
                        className="danger-text-button"
                        onClick={() => void mutate(
                          `remove:${key}`,
                          () => window.grokbuild.removeMcp({ name: server.name, scope: server.scope as McpScope }),
                          `${server.name} was removed.`
                        ).then((removed) => {
                          if (removed) setPendingRemoval(undefined)
                        })}
                      >Remove</button>
                    </div>
                  ) : null}
                </div>
                <div className="mcp-server-actions">
                  <button type="button" onClick={() => setDoctorTarget({ name: server.name })} disabled={!actionable || Boolean(busy)}>Check</button>
                  <button
                    type="button"
                    disabled={!actionable || Boolean(busy)}
                    aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.name}`}
                    onClick={() => void mutate(
                      `toggle:${key}`,
                      () => server.enabled
                        ? window.grokbuild.disableMcp({ name: server.name })
                        : window.grokbuild.enableMcp({ name: server.name }),
                      `${server.name} was ${server.enabled ? 'disabled' : 'enabled'}.`
                    )}
                  >{server.enabled ? 'Disable' : 'Enable'}</button>
                  <button
                    className="icon-button"
                    type="button"
                    disabled={!actionable || !removable || Boolean(busy)}
                    onClick={() => setPendingRemoval(key)}
                    aria-label={`Remove ${server.name} from ${server.scope} scope`}
                  ><Trash2 size={13} /></button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function PairEditor({
  label,
  entries,
  namePlaceholder,
  onChange
}: {
  label: string
  entries: PairDraft[]
  namePlaceholder: string
  onChange: (entries: PairDraft[]) => void
}): React.JSX.Element {
  return (
    <fieldset className="mcp-pair-editor">
      <legend>{label}</legend>
      {entries.map((entry, index) => (
        <div key={entry.id} className="mcp-pair-row">
          <input
            value={entry.name}
            onChange={(event) => onChange(replacePair(entries, index, { name: event.target.value }))}
            placeholder={namePlaceholder}
            aria-label={`${label} name ${index + 1}`}
            required
            autoComplete="off"
          />
          <input
            value={entry.value}
            onChange={(event) => onChange(replacePair(entries, index, { value: event.target.value }))}
            placeholder="Value"
            aria-label={`${label} value ${index + 1}`}
            required
            type="password"
            autoComplete="new-password"
          />
          <button type="button" className="icon-button" onClick={() => onChange(entries.filter((_, entryIndex) => entryIndex !== index))} aria-label={`Remove ${label.toLowerCase()} row`}><X size={13} /></button>
        </div>
      ))}
      <button type="button" className="mcp-pair-add" onClick={() => onChange([...entries, newPair()])}><Plus size={12} /> Add {label.toLowerCase()} value</button>
    </fieldset>
  )
}

function DoctorReport({ result, onClose }: { result: McpDoctorResult; onClose: () => void }): React.JSX.Element {
  return (
    <section className="mcp-doctor-result" aria-label="MCP diagnostic result" data-testid="mcp-doctor-result">
      <div>
        <CheckCircle2 size={16} />
        <strong>{result.healthyCount} healthy</strong>
        <span>{result.failingCount} failing</span>
      </div>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Dismiss MCP diagnostic result"><X size={13} /></button>
      {result.servers.length > 0 ? (
        <ul>
          {result.servers.map((server) => (
            <li key={`${server.source}:${server.name}`}>
              <span className={`mcp-status-dot ${server.healthy ? 'enabled' : 'failed'}`} />
              <strong>{server.name}</strong>
              <span>{server.transport} · {server.source}</span>
              <span>{server.checks.filter((check) => check.passed).length}/{server.checks.length} checks</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function newPair(): PairDraft {
  return { id: crypto.randomUUID(), name: '', value: '' }
}

function replacePair(
  entries: PairDraft[],
  index: number,
  changes: Partial<Pick<PairDraft, 'name' | 'value'>>
): PairDraft[] {
  return entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...changes } : entry)
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/u).filter((line) => line.length > 0)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'MCP operation failed'
}
