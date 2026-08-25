import { BadgeCheck, CircleUserRound, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GrokAccountReport } from '../../../shared/account'
import type { PrivacyDisplayResolver } from '../../../shared/privacy'

interface AccountSettingsProps {
  active: boolean
  privacy: PrivacyDisplayResolver
  onCheck: () => Promise<GrokAccountReport>
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function AccountSettings({ active, privacy, onCheck }: AccountSettingsProps): React.JSX.Element {
  const [report, setReport] = useState<GrokAccountReport>()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const sequence = useRef(0)
  const started = useRef(false)

  const check = useCallback(async (): Promise<void> => {
    const request = ++sequence.current
    setLoading(true)
    setFailed(false)
    try {
      const result = await onCheck()
      if (request === sequence.current) setReport(result)
    } catch {
      if (request === sequence.current) {
        setReport(undefined)
        setFailed(true)
      }
    } finally {
      if (request === sequence.current) setLoading(false)
    }
  }, [onCheck])

  useEffect(() => {
    if (!active || started.current) return
    started.current = true
    void check()
  }, [active, check])
  useEffect(() => () => { sequence.current += 1 }, [])

  return (
    <>
      <div className="settings-section-heading">
        <span className="settings-kicker">Account</span>
        <h3>Signed-in Grok account</h3>
        <p>Plan and usage as reported by grok.com for the CLI&apos;s cached sign-in.</p>
      </div>
      <section className="doctor-card account-card" data-testid="account-settings" aria-labelledby="account-heading">
        <div className="doctor-heading">
          <div>
            <h4 id="account-heading">Status</h4>
            <p>Read-only. GrokBuild never edits the sign-in or the plan.</p>
          </div>
          <button type="button" onClick={() => void check()} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'spinning' : undefined} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {failed ? (
          <p className="doctor-error" role="alert">Could not check account status.</p>
        ) : report ? (
          <AccountReportBody report={report} privacy={privacy} />
        ) : (
          <p className="doctor-loading" aria-live="polite">Checking account status…</p>
        )}
      </section>
    </>
  )
}

function AccountReportBody({
  report,
  privacy
}: {
  report: GrokAccountReport
  privacy: PrivacyDisplayResolver
}): React.JSX.Element {
  if (report.state === 'signed-out') {
    return (
      <div className="doctor-remediation">
        <strong>Signed out</strong>
        <span>Run <code>grok login</code> in Terminal, then choose Refresh.</span>
      </div>
    )
  }
  if (report.state === 'failed') {
    return <p className="doctor-error" role="alert">{report.message}</p>
  }
  const email = privacy.enabled ? 'Hidden while private' : report.email
  const displayName = privacy.enabled ? '' : report.displayName
  const membership = report.organizationName ?? report.teamName
  return (
    <div className="account-body" aria-live="polite">
      <div className="account-identity">
        <CircleUserRound size={19} aria-hidden="true" />
        <span>
          <strong data-testid="account-email">{email}</strong>
          {displayName ? <small>{displayName}</small> : null}
          {membership && !privacy.enabled ? <small>{membership}</small> : null}
        </span>
        <span className={`account-tier ${report.tier ? 'paid' : 'free'}`} data-testid="account-tier">
          <BadgeCheck size={13} aria-hidden="true" />
          {report.tier ?? 'Free'}
        </span>
      </div>
      {report.usage ? <AccountUsageBody usage={report.usage} /> : (
        <p className="account-usage-empty">Usage details were not reported for this account.</p>
      )}
      <p className="account-footnote">
        Grok Code access: {report.hasGrokCodeAccess ? 'yes' : 'no'}. Change plan or sign-in from grok.com and the CLI.
      </p>
    </div>
  )
}

function AccountUsageBody({
  usage
}: {
  usage: NonNullable<Extract<GrokAccountReport, { state: 'ok' }>['usage']>
}): React.JSX.Element {
  const allowance = usage.monthlyLimit > 0
  const ratio = allowance ? Math.min(1, usage.used / usage.monthlyLimit) : 0
  const cycles = usage.history.filter((cycle) => cycle.totalUsed > 0).slice(0, 3)
  return (
    <div className="account-usage" data-testid="account-usage">
      <div className="account-usage-row">
        <span>
          <strong>{formatAmount(usage.used)}</strong>
          <small>
            used {formatPeriod(usage.periodStart, usage.periodEnd)}
            {allowance ? ` of ${formatAmount(usage.monthlyLimit)} included` : ' · no monthly allowance on this plan'}
          </small>
        </span>
        {usage.onDemandCap > 0 ? (
          <span>
            <strong>{formatAmount(usage.onDemandCap)}</strong>
            <small>on-demand cap</small>
          </span>
        ) : null}
      </div>
      {allowance ? (
        <div
          className="account-meter"
          role="meter"
          aria-label="Included usage this cycle"
          aria-valuemin={0}
          aria-valuemax={usage.monthlyLimit}
          aria-valuenow={Math.min(usage.used, usage.monthlyLimit)}
        >
          <div className="account-meter-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      ) : null}
      {cycles.length > 0 ? (
        <div className="account-history">
          {cycles.map((cycle) => (
            <span key={`${cycle.year}-${cycle.month}`}>
              <small>{MONTH_LABELS[cycle.month - 1]} {cycle.year}</small>
              <strong>{formatAmount(cycle.totalUsed)}</strong>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2)
}

function formatPeriod(startIso: string, endIso: string): string {
  const start = new Date(startIso)
  const end = new Date(endIso)
  const label = (date: Date): string => `${MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCDate()}`
  return `${label(start)} – ${label(end)}`
}
