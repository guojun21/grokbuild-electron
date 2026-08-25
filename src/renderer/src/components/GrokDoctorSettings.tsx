import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DoctorCheck, GrokDoctorReport } from '../../../shared/doctor'

interface GrokDoctorSettingsProps {
  onCheck: () => Promise<GrokDoctorReport>
}

export function GrokDoctorSettings({ onCheck }: GrokDoctorSettingsProps): React.JSX.Element {
  const [report, setReport] = useState<GrokDoctorReport>()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const sequence = useRef(0)

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
    void check()
    return () => { sequence.current += 1 }
  }, [check])

  return (
    <section className="doctor-card" data-testid="grok-doctor" aria-labelledby="doctor-heading">
      <div className="doctor-heading">
        <div>
          <h4 id="doctor-heading">Grok Doctor</h4>
          <p>Read-only checks for the CLI and local sign-in state.</p>
        </div>
        <button type="button" onClick={() => void check()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'spinning' : undefined} />
          {loading ? 'Checking…' : 'Recheck'}
        </button>
      </div>
      {failed ? (
        <p className="doctor-error" role="alert">Could not check Grok status.</p>
      ) : report ? (
        <>
          <div className="doctor-checks" aria-live="polite">
            {report.checks.map((check) => <DoctorRow key={check.key} check={check} />)}
          </div>
          {report.remediation === 'run-grok-login' ? (
            <div className="doctor-remediation" data-testid="doctor-login-remediation">
              <strong>Sign in from Terminal</strong>
              <span>Run <code>grok login</code>, then choose Recheck. GrokBuild does not run this command for you.</span>
            </div>
          ) : report.remediation === 'choose-cli' ? (
            <div className="doctor-remediation">
              <strong>CLI required</strong>
              <span>Choose or install the Grok CLI above, then recheck.</span>
            </div>
          ) : null}
        </>
      ) : (
        <p className="doctor-loading" aria-live="polite">Checking Grok status…</p>
      )}
    </section>
  )
}

function DoctorRow({ check }: { check: DoctorCheck }): React.JSX.Element {
  const Icon = check.status === 'ok'
    ? CheckCircle2
    : check.status === 'failed'
      ? XCircle
      : check.status === 'warning'
        ? AlertTriangle
        : CircleHelp
  return (
    <div className={`doctor-check ${check.status}`} data-testid={`doctor-check-${check.key}`}>
      <Icon size={15} aria-hidden="true" />
      <span><strong>{check.title}</strong><small>{check.detail}</small></span>
    </div>
  )
}
