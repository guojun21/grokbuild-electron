import {
  Archive,
  CalendarDays,
  History,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { PublicSessionHistoryRecord } from '../../../shared/sessionHistory'
import type { PrivacyDisplayResolver } from '../../../shared/privacy'
import { ModalSurface } from './ModalSurface'

interface SessionHistoryPanelProps {
  projectName?: string
  privacy: PrivacyDisplayResolver
  records: readonly PublicSessionHistoryRecord[]
  query: string
  loading: boolean
  error?: string
  busyToken?: string
  onQueryChange: (query: string) => void
  onRefresh: () => void
  onOpen: (token: string) => void
  onDelete: (token: string) => void
  onClose: () => void
}

const MAX_QUERY_BYTES = 256

export function SessionHistoryPanel({
  projectName,
  privacy,
  records,
  query,
  loading,
  error,
  busyToken,
  onQueryChange,
  onRefresh,
  onOpen,
  onDelete,
  onClose
}: SessionHistoryPanelProps): React.JSX.Element {
  const hasQuery = !privacy.enabled && query.trim().length > 0
  const displayProjectName = projectName ? privacy.projectName(projectName) : undefined

  return (
    <ModalSurface className="history-dialog" labelledBy="history-title" onClose={onClose}>
      <section className="history-panel">
        <header className="history-header">
          <div className="history-glyph" aria-hidden="true"><History size={19} /></div>
          <div>
            <span className="history-kicker">Grok CLI</span>
            <h2 id="history-title">Sessions History</h2>
            <p>{displayProjectName ? `${displayProjectName} · saved CLI sessions` : 'Select a project to browse saved sessions.'}</p>
          </div>
          <button
            className="history-refresh"
            type="button"
            disabled={!projectName || loading || busyToken !== undefined}
            onClick={onRefresh}
          >
            <RefreshCw className={loading ? 'spinning' : ''} size={13} />
            Refresh
          </button>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close Sessions History">
            <X size={16} />
          </button>
        </header>

        <div className="history-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            data-modal-initial-focus
            value={privacy.enabled ? '' : query}
            placeholder={privacy.enabled ? 'Search hidden in Privacy Mode' : 'Search summaries and first prompts'}
            aria-label="Search CLI session history"
            disabled={privacy.enabled || !projectName || busyToken !== undefined}
            onChange={(event) => onQueryChange(boundedUtf8(event.currentTarget.value, MAX_QUERY_BYTES))}
          />
          {!privacy.enabled && query ? (
            <button type="button" aria-label="Clear history search" onClick={() => onQueryChange('')}>
              <X size={12} />
            </button>
          ) : <span aria-hidden="true" />}
        </div>

        {error ? (
          <div className="history-error" role="status">
            Session history could not be loaded. Refresh and try again.
          </div>
        ) : null}

        <div className="history-body" aria-busy={loading}>
          {loading && records.length === 0 ? (
            <div className="history-empty">
              <LoaderCircle className="spinning" size={23} aria-hidden="true" />
              <strong>Loading session history…</strong>
              <span>Reading the selected project through the Grok CLI.</span>
            </div>
          ) : records.length === 0 ? (
            <div className="history-empty">
              <Archive size={24} aria-hidden="true" />
              <strong>{hasQuery ? 'No matching sessions' : 'No saved CLI sessions'}</strong>
              <span>{hasQuery ? 'Try a different summary or first-prompt search.' : 'New CLI sessions will appear here after they are saved.'}</span>
            </div>
          ) : (
            <div className="history-list" role="list" aria-label="Saved CLI sessions">
              {records.map((record, index) => {
                const title = privacy.historySummary(historyTitle(record.summary), index + 1)
                const busy = busyToken === record.token
                return (
                  <article className="history-row" role="listitem" key={record.token}>
                    <button
                      className="history-open"
                      type="button"
                      disabled={loading || busyToken !== undefined}
                      aria-label={`Open ${title}`}
                      onClick={() => onOpen(record.token)}
                    >
                      <span className="history-row-title">{title}</span>
                      <span className="history-row-meta">
                        <span className="history-status">{statusLabel(record.status)}</span>
                        <span><CalendarDays size={10} /> Updated {record.updated}</span>
                        {record.created !== record.updated ? <span>Created {record.created}</span> : null}
                      </span>
                    </button>
                    <button
                      className="history-delete"
                      type="button"
                      disabled={loading || busyToken !== undefined}
                      aria-label={`Delete history session ${title}`}
                      title="Delete from Grok CLI history"
                      onClick={() => onDelete(record.token)}
                    >
                      {busy ? <LoaderCircle className="spinning" size={13} /> : <Trash2 size={13} />}
                    </button>
                  </article>
                )
              })}
            </div>
          )}
        </div>

        <footer className="history-footer">
          History is read from <code>grok sessions</code>. Opening an item restores it into this project.
        </footer>
      </section>
    </ModalSurface>
  )
}

function historyTitle(summary: string): string {
  const value = summary.trim().replace(/\s+/gu, ' ')
  return value || 'Untitled CLI session'
}

function statusLabel(status: string): string {
  return status
    .replace(/[_-]+/gu, ' ')
    .replace(/^./u, (character) => character.toLocaleUpperCase())
}

function boundedUtf8(value: string, maximumBytes: number): string {
  let result = ''
  let bytes = 0
  const encoder = new TextEncoder()
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength
    if (bytes + characterBytes > maximumBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}
