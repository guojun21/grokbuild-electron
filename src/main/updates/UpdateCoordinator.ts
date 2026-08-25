import type { GrokCliService } from '../grok/GrokCliService'
import type { AppUpdateStatus, CliUpdateStatus, UpdateOverview } from '../../shared/updates'
import {
  checkAppUpdate,
  parseGrokCliUpdateCheck,
  type AppUpdateCheckOptions
} from './UpdateService'

export interface UpdateCoordinatorOptions {
  appVersion: string
  releasesUrl?: string | undefined
  productAssetStem: string
  cli?: Pick<GrokCliService, 'checkForUpdate'> | undefined
  /** Resolves the current CLI path at check time after Settings changes. */
  cliProvider?: (() => Pick<GrokCliService, 'checkForUpdate'> | undefined) | undefined
  fetchImpl?: typeof fetch | undefined
  now?: (() => Date) | undefined
  candidateTtlMs?: number | undefined
}

export interface UpdateCheckResult {
  overview: UpdateOverview
  appReleaseUrl?: string
}

/** Main-only install authority. Never expose this value through IPC or logs. */
export interface AppUpdateCandidate {
  installedVersion: string
  latestVersion: string
  tagName: string
  downloadUrl: string
  assetDigest: string
  assetSize?: number | undefined
  publishedAt?: string | undefined
}

const DEFAULT_CANDIDATE_TTL_MS = 15 * 60_000
const MAX_CANDIDATE_TTL_MS = 60 * 60_000

/**
 * Discovery only. It never downloads, swaps, executes, or restarts a binary.
 * A release-page action is intentionally separate from installation trust.
 */
export class UpdateCoordinator {
  private readonly candidateTtlMs: number
  private cachedCandidate: { candidate: AppUpdateCandidate; expiresAt: number } | undefined
  private checkSequence = 0

  constructor(private readonly options: UpdateCoordinatorOptions) {
    this.candidateTtlMs = boundedCandidateTtl(options.candidateTtlMs)
  }

  async check(cwd?: string): Promise<UpdateCheckResult> {
    const sequence = ++this.checkSequence
    this.cachedCandidate = undefined
    const [app, cli] = await Promise.all([
      this.checkApplication(),
      this.checkCli(cwd)
    ])
    const checkedAt = this.options.now?.() ?? new Date()
    if (sequence === this.checkSequence && app.candidate) {
      this.cachedCandidate = {
        candidate: structuredClone(app.candidate),
        expiresAt: checkedAt.getTime() + this.candidateTtlMs
      }
    }
    return {
      overview: {
        checkedAt: checkedAt.toISOString(),
        app: app.status,
        cli
      },
      ...(app.releaseUrl ? { appReleaseUrl: app.releaseUrl } : {})
    }
  }

  /**
   * Consumes the latest exact candidate. Failed or abandoned installs require
   * a fresh discovery pass so an old release response cannot be replayed.
   */
  consumeAppCandidate(): AppUpdateCandidate | undefined {
    const cached = this.cachedCandidate
    this.cachedCandidate = undefined
    if (!cached) return undefined
    const now = (this.options.now?.() ?? new Date()).getTime()
    return now <= cached.expiresAt ? structuredClone(cached.candidate) : undefined
  }

  private async checkApplication(): Promise<{
    status: AppUpdateStatus
    releaseUrl?: string
    candidate?: AppUpdateCandidate
  }> {
    if (!this.options.releasesUrl) return { status: { state: 'unconfigured' } }
    try {
      const request: AppUpdateCheckOptions = {
        installedVersion: this.options.appVersion,
        releasesUrl: this.options.releasesUrl,
        productAssetStem: this.options.productAssetStem,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
      }
      const release = await checkAppUpdate(request)
      const candidate = release.updateAvailable && release.downloadUrl && release.assetDigest
        ? {
            installedVersion: release.installedVersion,
            latestVersion: release.latestVersion,
            tagName: release.tagName,
            downloadUrl: release.downloadUrl,
            assetDigest: release.assetDigest,
            ...(release.assetSize !== undefined ? { assetSize: release.assetSize } : {}),
            ...(release.publishedAt ? { publishedAt: release.publishedAt } : {})
          }
        : undefined
      return release.updateAvailable
        ? { status: {
            state: 'update-available',
            installed: release.installedVersion,
            latest: release.latestVersion,
            assetAvailable: Boolean(candidate)
          }, releaseUrl: release.releaseUrl, ...(candidate ? { candidate } : {}) }
        : { status: {
            state: 'up-to-date',
            installed: release.installedVersion,
            latest: release.latestVersion
          }, releaseUrl: release.releaseUrl }
    } catch {
      return {
        status: {
          state: 'failed',
          message: 'Could not check the Electron app release feed.'
        }
      }
    }
  }

  private async checkCli(cwd?: string): Promise<CliUpdateStatus> {
    const cli = this.options.cliProvider?.() ?? this.options.cli
    if (!cli || !cwd) return { state: 'unavailable' }
    try {
      return parseGrokCliUpdateCheck(await cli.checkForUpdate(cwd))
    } catch {
      return { state: 'failed', message: 'Could not check for Grok CLI updates.' }
    }
  }
}

function boundedCandidateTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CANDIDATE_TTL_MS
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CANDIDATE_TTL_MS) {
    throw new TypeError('Update candidate lifetime is invalid.')
  }
  return value
}
