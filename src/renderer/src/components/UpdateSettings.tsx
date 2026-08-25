import { AlertTriangle, CheckCircle2, Download, ExternalLink, RefreshCw, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type {
  AppUpdateInstallResult,
  CliUpdateInstallResult,
  UpdateOverview
} from '../../../shared/updates'

export function UpdateSettings({
  onCheck,
  onInstallAppUpdate,
  onInstallCliUpdate,
  onOpenAppRelease
}: {
  onCheck: () => Promise<UpdateOverview>
  onInstallAppUpdate: () => Promise<AppUpdateInstallResult>
  onInstallCliUpdate: () => Promise<CliUpdateInstallResult>
  onOpenAppRelease: () => Promise<void>
}): React.JSX.Element {
  const [overview, setOverview] = useState<UpdateOverview>()
  const [checking, setChecking] = useState(false)
  const [installingApp, setInstallingApp] = useState(false)
  const [installingCli, setInstallingCli] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState<string>()
  const busy = checking || installingApp || installingCli || restarting

  async function check(): Promise<void> {
    setChecking(true)
    setError(undefined)
    try {
      setOverview(await onCheck())
    } catch {
      setError('Update discovery failed. No files were downloaded or changed.')
    } finally {
      setChecking(false)
    }
  }

  async function installAppUpdate(): Promise<void> {
    setInstallingApp(true)
    setError(undefined)
    try {
      const result = await onInstallAppUpdate()
      if (result.state === 'restarting') setRestarting(true)
    } catch {
      setError('The update could not be prepared. Check for updates again before retrying.')
    } finally {
      setInstallingApp(false)
    }
  }

  async function installCliUpdate(): Promise<void> {
    setInstallingCli(true)
    setError(undefined)
    try {
      const result = await onInstallCliUpdate()
      if (result.state === 'installed') {
        setOverview((current) => current ? {
          ...current,
          checkedAt: new Date().toISOString(),
          cli: result.updateAvailable
            ? {
                state: 'update-available',
                current: result.current,
                latest: result.latest,
                ...(result.channel ? { channel: result.channel } : {})
              }
            : {
                state: 'up-to-date',
                current: result.current,
                latest: result.latest,
                ...(result.channel ? { channel: result.channel } : {})
              }
        } : current)
      }
    } catch {
      setError('The Grok CLI update failed. Check for updates again before retrying.')
    } finally {
      setInstallingCli(false)
    }
  }

  return (
    <div className="update-settings" data-testid="update-settings">
      <div className="settings-section-heading update-heading">
        <span className="settings-kicker">Release discovery</span>
        <h3>Updates</h3>
        <p>Checks the Electron release feed and the installed Grok CLI. Installation never runs automatically.</p>
        <button className="secondary-small" type="button" disabled={busy} onClick={() => void check()}>
          <RefreshCw size={13} className={checking ? 'spinning' : undefined} />
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {error ? <div className="mcp-inline-error" role="alert"><AlertTriangle size={14} />{error}</div> : null}
      {!overview ? (
        <div className="update-empty">No update check has run in this window.</div>
      ) : (
        <div className="update-results">
          <UpdateRow title="GrokBuild Electron" status={overview.app.state}>
            {overview.app.state === 'unconfigured' ? (
              <span>No trusted Electron release feed is configured for this build.</span>
            ) : overview.app.state === 'failed' ? (
              <span>{overview.app.message}</span>
            ) : overview.app.state === 'up-to-date' ? (
              <span>Version {overview.app.installed} is current.</span>
            ) : (
              <>
                <span>Version {overview.app.latest} is available (installed {overview.app.installed}).</span>
                <span className="update-result-actions">
                  <button type="button" className="secondary-small" disabled={busy} onClick={() => void onOpenAppRelease()}>
                    <ExternalLink size={12} /> Release notes
                  </button>
                  {overview.app.assetAvailable ? (
                    <button type="button" className="primary-small" disabled={busy} onClick={() => void installAppUpdate()}>
                      <RotateCcw size={12} className={installingApp ? 'spinning' : undefined} />
                      {restarting ? 'Restarting…' : installingApp ? 'Preparing…' : 'Install and restart'}
                    </button>
                  ) : null}
                </span>
              </>
            )}
          </UpdateRow>

          <UpdateRow title="Grok CLI" status={overview.cli.state}>
            {overview.cli.state === 'unavailable' ? (
              <span>The CLI is unavailable.</span>
            ) : overview.cli.state === 'failed' ? (
              <span>{overview.cli.message}</span>
            ) : overview.cli.state === 'up-to-date' ? (
              <span>Version {overview.cli.current} is current.</span>
            ) : (
              <>
                <span>Version {overview.cli.latest} is available (installed {overview.cli.current}).</span>
                <span className="update-result-actions">
                  <button type="button" className="primary-small" disabled={busy} onClick={() => void installCliUpdate()}>
                    <Download size={12} className={installingCli ? 'spinning' : undefined} />
                    {installingCli ? 'Updating CLI…' : 'Install CLI update'}
                  </button>
                </span>
              </>
            )}
          </UpdateRow>
          <small className="update-checked-at">Checked {new Date(overview.checkedAt).toLocaleString()}</small>
        </div>
      )}

      <div className="update-trust-note">
        <AlertTriangle size={15} />
        <span>Before restart, the archive must pass digest, app identity, architecture, Gatekeeper, notarization, and current-signing-requirement checks. macOS then performs the replacement with Squirrel recovery.</span>
      </div>
    </div>
  )
}

function UpdateRow({
  title,
  status,
  children
}: {
  title: string
  status: string
  children: React.ReactNode
}): React.JSX.Element {
  const healthy = status === 'up-to-date'
  const warning = status === 'update-available' || status === 'failed'
  return (
    <section className="update-result-row">
      <span className={`update-result-icon ${healthy ? 'healthy' : warning ? 'warning' : ''}`}>
        {healthy ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
      </span>
      <div>
        <strong>{title}</strong>
        <div className="update-result-copy">{children}</div>
      </div>
    </section>
  )
}
