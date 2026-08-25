import { AlertTriangle, ArchiveRestore, CheckCircle2, FileSearch, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  SwiftImportCommitResult,
  SwiftImportPreview
} from '../../../shared/swiftImport'

export function SwiftImportSettings({
  onPreview,
  onCommit,
  onCancel
}: {
  onPreview: () => Promise<SwiftImportPreview | null>
  onCommit: (token: string) => Promise<SwiftImportCommitResult>
  onCancel: (token: string) => Promise<void>
}): React.JSX.Element {
  const [preview, setPreview] = useState<SwiftImportPreview>()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()
  const [completed, setCompleted] = useState<SwiftImportCommitResult>()
  const activeToken = preview?.ok ? preview.token : undefined

  useEffect(() => () => {
    if (activeToken) void onCancel(activeToken).catch(() => undefined)
  }, [activeToken])

  async function chooseSource(): Promise<void> {
    setWorking(true)
    setError(undefined)
    setCompleted(undefined)
    try {
      const result = await onPreview()
      if (!result) return
      setPreview(result)
      if (!result.ok) setError(result.error.message)
    } catch {
      setPreview(undefined)
      setError('Could not preview the Swift state import.')
    } finally {
      setWorking(false)
    }
  }

  async function cancelPreview(): Promise<void> {
    if (!activeToken) {
      setPreview(undefined)
      return
    }
    setWorking(true)
    setError(undefined)
    try {
      await onCancel(activeToken)
    } catch {
      setError('Could not cancel the Swift state preview.')
    } finally {
      setPreview(undefined)
      setWorking(false)
    }
  }

  async function commitPreview(): Promise<void> {
    if (!activeToken) return
    setWorking(true)
    setError(undefined)
    try {
      setCompleted(await onCommit(activeToken))
      setPreview(undefined)
    } catch {
      setPreview(undefined)
      setError('The Swift import could not be committed. Preview the source again.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="swift-import-settings" data-testid="swift-import-settings">
      <div className="settings-section-heading import-heading">
        <span className="settings-kicker">Explicit migration</span>
        <h3>Import from GrokBuild for Swift</h3>
        <p>Select a macOS property-list file to preview a non-destructive merge. GrokBuild never searches for or reads a source automatically.</p>
        <button className="secondary-small" type="button" disabled={working} onClick={() => void chooseSource()}>
          <FileSearch size={13} />
          {working && !preview ? 'Reading…' : 'Choose plist…'}
        </button>
      </div>

      {error ? <div className="mcp-inline-error" role="alert"><AlertTriangle size={14} />{error}</div> : null}
      {completed ? (
        <div className="import-complete" role="status" data-testid="swift-import-complete">
          <CheckCircle2 size={15} />
          <div>
            <strong>Import committed</strong>
            <span>{completed.merge.projectsAdded} projects and {completed.merge.sessionsAdded} sessions added. Existing Electron data stayed authoritative.</span>
          </div>
        </div>
      ) : null}

      {!preview ? (
        <div className="import-empty">
          <ArchiveRestore size={21} />
          <strong>No source selected</strong>
          <span>The preview returns counts only—never file paths or message text.</span>
        </div>
      ) : preview.ok ? (
        <div className="import-preview" data-testid="swift-import-preview">
          <div className="import-counts" aria-label="Import preview counts">
            <ImportCount label="Projects in source" value={preview.source.projectsImported} />
            <ImportCount label="Sessions in source" value={preview.source.sessionsImported} />
            <ImportCount label="Transcript items" value={preview.source.transcriptItemsImported} />
            <ImportCount label="Projects to add" value={preview.merge.projectsAdded} emphasized />
            <ImportCount label="Sessions to add" value={preview.merge.sessionsAdded} emphasized />
            <ImportCount
              label="Already present"
              value={preview.merge.projectsMatchedByPath + preview.merge.sessionsAlreadyPresent}
            />
          </div>
          <div className="import-confirm" role="alertdialog" aria-label="Confirm Swift state import">
            <AlertTriangle size={15} />
            <div>
              <strong>Commit this merge?</strong>
              <p>Existing projects, sessions, settings, selection, and pins win. The selected source file is never modified.</p>
              <div className="import-confirm-actions">
                <button className="secondary-small" type="button" disabled={working} onClick={() => void cancelPreview()}>
                  <X size={12} /> Cancel preview
                </button>
                <button className="primary-small" type="button" disabled={working} onClick={() => void commitPreview()}>
                  <ArchiveRestore size={12} /> {working ? 'Importing…' : 'Import'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="import-empty compact">
          <AlertTriangle size={20} />
          <strong>Preview unavailable</strong>
          <span>Choose another plist to try again.</span>
        </div>
      )}
    </div>
  )
}

function ImportCount({
  label,
  value,
  emphasized = false
}: {
  label: string
  value: number
  emphasized?: boolean
}): React.JSX.Element {
  return (
    <div className={emphasized ? 'emphasized' : undefined} data-import-count={label}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}
