import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { AppController, UpdateQuiescenceLease } from '../AppController'
import type { MacAppIdentityService } from './MacAppIdentityService'
import type {
  TrustedAppArchiveVerifier,
  VerifiedAppArchive
} from './TrustedAppArchiveVerifier'
import {
  TrustedSquirrelUpdateError,
  type TrustedSquirrelUpdater
} from './TrustedSquirrelUpdater'
import type {
  StagedUpdateArchive,
  TrustedUpdateStager
} from './TrustedUpdateStager'
import type {
  UpdateCheckResult,
  UpdateCoordinator
} from './UpdateCoordinator'
import {
  UpdateOperationBusyError,
  type UpdateOperationLease,
  type UpdateOperationLock
} from './UpdateOperationLock'

export const PRODUCTION_APP_BUNDLE_ID = 'com.oasmet.grokbuild-electron'
export const PRODUCTION_APP_NAME = 'GrokBuild Electron'

export type AppUpdateInstallErrorCode =
  | 'invalid-request'
  | 'busy'
  | 'fresh-check-required'
  | 'confirmation-failed'
  | 'identity-ineligible'
  | 'location-ineligible'
  | 'version-mismatch'
  | 'stage-failed'
  | 'verification-failed'
  | 'quiescence-failed'
  | 'prepare-failed'
  | 'install-start-failed'
  | 'cleanup-failed'
  | 'already-started'
  | 'check-failed'

/** Fixed, content-free failures safe for a future narrow IPC projection. */
export class AppUpdateInstallError extends Error {
  constructor(readonly code: AppUpdateInstallErrorCode) {
    super(publicErrorMessage(code))
    this.name = 'AppUpdateInstallError'
  }
}

type DiscoveryBoundary = Pick<UpdateCoordinator, 'check' | 'consumeAppCandidate'>
type IdentityBoundary = Pick<MacAppIdentityService, 'inspect'>
type StageBoundary = Pick<TrustedUpdateStager, 'stage' | 'discard'>
type VerifyBoundary = Pick<TrustedAppArchiveVerifier, 'verify' | 'discard'>
type SquirrelBoundary = Pick<TrustedSquirrelUpdater, 'prepare' | 'quitAndInstall'>
type QuiescenceBoundary = Pick<AppController, 'acquireUpdateQuiescence'>
type OperationLockBoundary = Pick<UpdateOperationLock, 'acquire' | 'runExclusive'>

export interface AppUpdateInstallCoordinatorOptions {
  updateCoordinator: DiscoveryBoundary
  identityService: IdentityBoundary
  stager: StageBoundary
  verifier: VerifyBoundary
  squirrel: SquirrelBoundary
  operationLock: OperationLockBoundary
  controller: QuiescenceBoundary
  executablePath: string
  isPackaged: boolean
  /** Main-only user confirmation. It receives no URL, path, digest, or identity. */
  confirmInstall: (latestVersion: string) => Promise<boolean>
  /** Must latch outer quit intent before action; irreversible handoff forbids rollback. */
  startUpdateQuit: (install: () => void) => void | Promise<void>
  /** Controlled ordinary quit for a terminal/ambiguous Squirrel handoff. */
  quitApplication: () => void
  homeDirectory?: string | undefined
  expectedBundleId?: string | undefined
  expectedAppName?: string | undefined
}

type InstallStep =
  | 'candidate'
  | 'confirmation'
  | 'identity'
  | 'location'
  | 'version'
  | 'stage'
  | 'verify'
  | 'quiescence'
  | 'prepare'
  | 'quit'

interface InstallResources {
  staged?: StagedUpdateArchive | undefined
  verified?: VerifiedAppArchive | undefined
  quiescenceLease?: UpdateQuiescenceLease | undefined
  operationLease?: UpdateOperationLease | undefined
}

export type AppUpdateInstallResult = 'cancelled' | 'restarting'

/**
 * Main-only orchestration for Electron Squirrel.Mac. The renderer supplies no
 * path, URL, digest, identity, version, or install argument.
 */
export class AppUpdateInstallCoordinator {
  private readonly homeDirectory: string
  private readonly expectedBundleId: string
  private readonly expectedAppName: string
  private installStarted = false

  constructor(private readonly options: AppUpdateInstallCoordinatorOptions) {
    this.homeDirectory = validatedHomeDirectory(options.homeDirectory ?? homedir())
    this.expectedBundleId = validatedBundleId(
      options.expectedBundleId ?? PRODUCTION_APP_BUNDLE_ID
    )
    this.expectedAppName = validatedAppName(options.expectedAppName ?? PRODUCTION_APP_NAME)
  }

  async check(cwd?: string): Promise<UpdateCheckResult> {
    if (this.installStarted) throw new AppUpdateInstallError('already-started')
    try {
      const result = await this.options.operationLock.runExclusive(
        'app',
        () => this.options.updateCoordinator.check(cwd)
      )
      // Keep the install authority (URL, digest, size, and exact versions) in
      // UpdateCoordinator's one-shot cache. Only its discovery projection may
      // leave this main-only coordinator.
      return {
        overview: result.overview,
        ...(result.appReleaseUrl !== undefined ? { appReleaseUrl: result.appReleaseUrl } : {})
      }
    } catch (error) {
      if (error instanceof UpdateOperationBusyError) throw new AppUpdateInstallError('busy')
      if (error instanceof AppUpdateInstallError) throw error
      throw new AppUpdateInstallError('check-failed')
    }
  }

  installApp(): Promise<AppUpdateInstallResult>
  async installApp(...rawArguments: unknown[]): Promise<AppUpdateInstallResult> {
    if (rawArguments.length !== 0) {
      this.options.updateCoordinator.consumeAppCandidate()
      throw new AppUpdateInstallError('invalid-request')
    }
    if (this.installStarted) {
      this.options.updateCoordinator.consumeAppCandidate()
      throw new AppUpdateInstallError('already-started')
    }

    let operationLease: UpdateOperationLease | undefined
    try {
      operationLease = this.options.operationLock.acquire('app')
      return await this.installExclusive(operationLease)
    } catch (error) {
      if (!this.installStarted) operationLease?.release()
      // Once acquired, installExclusive consumes the authority as its first
      // action. Contention happens before that point, so invalidate explicitly.
      if (!operationLease) this.options.updateCoordinator.consumeAppCandidate()
      if (error instanceof UpdateOperationBusyError) throw new AppUpdateInstallError('busy')
      if (error instanceof AppUpdateInstallError) throw error
      throw new AppUpdateInstallError('install-start-failed')
    }
  }

  private async installExclusive(
    operationLease: UpdateOperationLease
  ): Promise<AppUpdateInstallResult> {
    const resources: InstallResources = { operationLease }
    let step: InstallStep = 'candidate'

    try {
      const candidate = this.options.updateCoordinator.consumeAppCandidate()
      if (!candidate) throw new AppUpdateInstallError('fresh-check-required')

      step = 'confirmation'
      const confirmed = await this.options.confirmInstall(candidate.latestVersion)
      if (confirmed !== true && confirmed !== false) {
        throw new AppUpdateInstallError('confirmation-failed')
      }
      if (!confirmed) {
        const cleanupFailed = await this.cleanup(resources)
        if (cleanupFailed) throw new AppUpdateInstallError('cleanup-failed')
        return 'cancelled'
      }

      step = 'identity'
      const identity = await this.options.identityService.inspect({
        executablePath: this.options.executablePath,
        isPackaged: this.options.isPackaged
      })
      if (
        identity.bundleId !== this.expectedBundleId ||
        identity.appName !== this.expectedAppName
      ) throw new AppUpdateInstallError('identity-ineligible')

      step = 'location'
      if (!this.isEligibleInstallLocation(identity.appPath)) {
        throw new AppUpdateInstallError('location-ineligible')
      }

      step = 'version'
      if (identity.shortVersion !== candidate.installedVersion) {
        throw new AppUpdateInstallError('version-mismatch')
      }

      step = 'stage'
      resources.staged = await this.options.stager.stage({
        downloadUrl: candidate.downloadUrl,
        expectedDigest: candidate.assetDigest,
        ...(candidate.assetSize !== undefined ? { expectedSize: candidate.assetSize } : {})
      })

      step = 'verify'
      resources.verified = await this.options.verifier.verify({
        archivePath: resources.staged.archivePath,
        expectedBundleId: this.expectedBundleId,
        expectedVersion: candidate.latestVersion,
        // electron-builder has no independent buildVersion in this product:
        // CFBundleVersion and CFBundleShortVersionString are both the exact,
        // release-verified package version.
        expectedBundleVersion: candidate.latestVersion,
        expectedAppName: this.expectedAppName,
        expectedTeamId: identity.teamId,
        expectedDesignatedRequirement: identity.designatedRequirement,
        expectedArchitectures: identity.architectures
      })
      if (
        resources.verified.bundleId !== this.expectedBundleId ||
        resources.verified.appName !== this.expectedAppName ||
        resources.verified.version !== candidate.latestVersion ||
        resources.verified.teamId !== identity.teamId
      ) throw new AppUpdateInstallError('verification-failed')
      await this.options.verifier.discard(resources.verified)
      resources.verified = undefined

      step = 'quiescence'
      resources.quiescenceLease = await this.options.controller.acquireUpdateQuiescence()

      // Re-establish the current bundle identity at the final reversible
      // boundary. This rejects path replacement, translocation, version drift,
      // or a signature/architecture change before Squirrel can retain a
      // pending update for the next launch.
      step = 'identity'
      const currentIdentity = await this.options.identityService.inspect({
        executablePath: this.options.executablePath,
        isPackaged: this.options.isPackaged
      })
      if (!sameIdentity(identity, currentIdentity)) {
        throw new AppUpdateInstallError('identity-ineligible')
      }
      step = 'location'
      if (!this.isEligibleInstallLocation(currentIdentity.appPath)) {
        throw new AppUpdateInstallError('location-ineligible')
      }
      step = 'version'
      if (currentIdentity.shortVersion !== candidate.installedVersion) {
        throw new AppUpdateInstallError('version-mismatch')
      }

      step = 'prepare'
      try {
        await this.options.squirrel.prepare({
          staged: resources.staged,
          currentVersion: identity.shortVersion,
          expectedVersion: candidate.latestVersion
        })
      } catch (error) {
        if (!(error instanceof TrustedSquirrelUpdateError) || error.code !== 'failed-closed') {
          throw error
        }

        // checkForUpdates crossed its irreversible handoff. Squirrel may apply
        // the retained update at the next launch, so block every retry, retain
        // both leases and the stage, and perform a controlled ordinary quit.
        this.retainForProcessExit(resources)
        this.installStarted = true
        step = 'quit'
        await this.finishIrreversibleQuit(this.options.quitApplication)
        return 'restarting'
      }

      // update-downloaded means Squirrel has copied, extracted, signature-
      // checked, and prepared its own bundle. The source archive is no longer
      // part of the install transaction, so reclaim it before quitting. Cleanup
      // failure is non-retryable here: the pending Squirrel update remains
      // authoritative and the next launch's bounded stale-stage sweep retries.
      await this.discardPreparedSourceStage(resources)
      this.retainForProcessExit(resources)
      this.installStarted = true
      step = 'quit'
      await this.finishIrreversibleQuit(() => this.options.squirrel.quitAndInstall())
      return 'restarting'
    } catch (error) {
      if (this.installStarted) {
        this.retainForProcessExit(resources)
        if (error instanceof AppUpdateInstallError) throw error
        throw new AppUpdateInstallError(errorCodeForStep(step))
      }
      const cleanupFailed = await this.cleanup(resources)
      if (cleanupFailed) throw new AppUpdateInstallError('cleanup-failed')
      if (error instanceof AppUpdateInstallError) throw error
      throw new AppUpdateInstallError(errorCodeForStep(step))
    }
  }

  private async finishIrreversibleQuit(action: () => void): Promise<void> {
    try {
      await this.startControlledQuit(action)
      return
    } catch {
      // Squirrel may already retain a pending update. Never reopen the app for
      // mutations or turn this into a retryable install failure. A plain quit
      // is the only safe best-effort fallback; the next launch lets Squirrel
      // decide whether to apply its cached update.
    }
    try {
      this.options.quitApplication()
    } catch {
      // Both leases and installStarted remain held until the process exits.
    }
  }

  private async startControlledQuit(action: () => void): Promise<void> {
    let actionCalls = 0
    await this.options.startUpdateQuit(() => {
      actionCalls += 1
      if (actionCalls !== 1) throw new AppUpdateInstallError('install-start-failed')
      action()
    })
    if (actionCalls !== 1) throw new AppUpdateInstallError('install-start-failed')
  }

  private retainForProcessExit(resources: InstallResources): void {
    resources.staged = undefined
    resources.verified = undefined
    resources.quiescenceLease = undefined
    resources.operationLease = undefined
  }

  private async discardPreparedSourceStage(resources: InstallResources): Promise<void> {
    const staged = resources.staged
    if (!staged) return
    try {
      await this.options.stager.discard(staged)
      resources.staged = undefined
    } catch {
      // Squirrel has already crossed the irreversible ready boundary. Keep the
      // source reference until retainForProcessExit() and let the next process
      // clean the exact private stale directory; never release leases or retry.
    }
  }

  private async cleanup(resources: InstallResources): Promise<boolean> {
    let failed = false
    if (resources.verified) {
      try {
        await this.options.verifier.discard(resources.verified)
      } catch {
        failed = true
      }
      resources.verified = undefined
    }
    if (resources.staged) {
      try {
        await this.options.stager.discard(resources.staged)
      } catch {
        failed = true
      }
      resources.staged = undefined
    }
    if (resources.quiescenceLease) {
      try {
        resources.quiescenceLease.release()
      } catch {
        failed = true
      }
      resources.quiescenceLease = undefined
    }
    if (resources.operationLease) {
      try {
        resources.operationLease.release()
      } catch {
        failed = true
      }
      resources.operationLease = undefined
    }
    return failed
  }

  private isEligibleInstallLocation(appPath: string): boolean {
    const appBundleName = `${this.expectedAppName}.app`
    return appPath === join('/Applications', appBundleName) ||
      appPath === join(this.homeDirectory, 'Applications', appBundleName)
  }
}

function sameIdentity(
  expected: Awaited<ReturnType<IdentityBoundary['inspect']>>,
  actual: Awaited<ReturnType<IdentityBoundary['inspect']>>
): boolean {
  return actual.appPath === expected.appPath &&
    actual.executablePath === expected.executablePath &&
    actual.bundleId === expected.bundleId &&
    actual.appName === expected.appName &&
    actual.shortVersion === expected.shortVersion &&
    actual.bundleVersion === expected.bundleVersion &&
    actual.teamId === expected.teamId &&
    actual.designatedRequirement === expected.designatedRequirement &&
    actual.architectures.length === expected.architectures.length &&
    actual.architectures.every((architecture, index) =>
      architecture === expected.architectures[index]
    )
}

function validatedHomeDirectory(value: string): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 4_096 ||
    value.includes('\0') || !isAbsolute(value) || resolve(value) !== value
  ) throw new AppUpdateInstallError('invalid-request')
  return value
}

function validatedBundleId(value: string): string {
  if (
    typeof value !== 'string' || value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value)
  ) throw new AppUpdateInstallError('invalid-request')
  return value
}

function validatedAppName(value: string): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 256 ||
    /[\0\r\n/]/.test(value) || value === '.' || value === '..'
  ) throw new AppUpdateInstallError('invalid-request')
  return value
}

function errorCodeForStep(step: InstallStep): AppUpdateInstallErrorCode {
  switch (step) {
    case 'candidate': return 'fresh-check-required'
    case 'confirmation': return 'confirmation-failed'
    case 'identity': return 'identity-ineligible'
    case 'location': return 'location-ineligible'
    case 'version': return 'version-mismatch'
    case 'stage': return 'stage-failed'
    case 'verify': return 'verification-failed'
    case 'quiescence': return 'quiescence-failed'
    case 'prepare': return 'prepare-failed'
    case 'quit': return 'install-start-failed'
  }
}

function publicErrorMessage(code: AppUpdateInstallErrorCode): string {
  switch (code) {
    case 'invalid-request': return 'The app update request is invalid.'
    case 'busy': return 'Another update operation is already in progress.'
    case 'fresh-check-required': return 'Check for updates again before installing.'
    case 'confirmation-failed': return 'The app update could not be confirmed safely.'
    case 'identity-ineligible': return 'This application is not eligible for trusted updates.'
    case 'location-ineligible': return 'Move the application to Applications before updating.'
    case 'version-mismatch': return 'The installed application version changed; check again.'
    case 'stage-failed': return 'The app update could not be downloaded safely.'
    case 'verification-failed': return 'The app update could not be verified safely.'
    case 'quiescence-failed': return 'The application could not pause safely for the update.'
    case 'prepare-failed': return 'The app update could not be prepared safely.'
    case 'install-start-failed': return 'The app update restart could not be started.'
    case 'cleanup-failed': return 'The failed app update could not be cleaned up safely.'
    case 'already-started': return 'The app update installation was already started.'
    case 'check-failed': return 'The app update check could not be completed safely.'
  }
}
