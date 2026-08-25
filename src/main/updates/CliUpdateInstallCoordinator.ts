import type { AppController, UpdateQuiescenceLease } from '../AppController'
import {
  canonicalGrokCliUpdateVersion,
  canonicalGrokCliUpdateVersionOutput,
  compareCanonicalGrokCliVersions,
  GrokCliServiceError,
  type GrokCliService
} from '../grok/GrokCliService'
import { parseGrokCliUpdateCheck } from './UpdateService'
import {
  UpdateOperationBusyError,
  type UpdateOperationLease,
  type UpdateOperationLock
} from './UpdateOperationLock'

export type CliUpdateInstallErrorCode =
  | 'invalid-request'
  | 'busy'
  | 'unavailable'
  | 'quiescence-failed'
  | 'check-failed'
  | 'fresh-check-required'
  | 'confirmation-failed'
  | 'install-failed'
  | 'verification-failed'
  | 'ambiguous-failure'

/** Fixed, content-free failures safe to map across IPC. */
export class CliUpdateInstallError extends Error {
  constructor(readonly code: CliUpdateInstallErrorCode) {
    super(publicErrorMessage(code))
    this.name = 'CliUpdateInstallError'
  }
}

export interface CliUpdateRuntime {
  cliPath: string
  cwd: string
  cli: Pick<GrokCliService, 'checkForUpdate' | 'installUpdate' | 'readVersion'>
}

type ControllerBoundary = Pick<AppController, 'acquireUpdateQuiescence'>
type OperationLockBoundary = Pick<UpdateOperationLock, 'acquire'>

export interface CliUpdateInstallCoordinatorOptions {
  /** Resolves the selected CLI and cwd only after the update gate is held. */
  runtimeProvider: () => CliUpdateRuntime | undefined
  controller: ControllerBoundary
  operationLock: OperationLockBoundary
  /** Main-only native confirmation; no path, argv, output, or token is exposed. */
  confirmInstall: (currentVersion: string, latestVersion: string) => Promise<boolean>
  /** Main-only snapshot refresh after the quiescence gate has been released. */
  recordInstalledVersion?: ((cliPath: string, version: string) => void) | undefined
  /** Requests an ordinary guarded quit after an updater may have mutated disk. */
  handleAmbiguousFailure: () => void | Promise<void>
}

export type CliUpdateInstallResult =
  | { state: 'cancelled' }
  | {
      state: 'installed'
      current: string
      latest: string
      updateAvailable: boolean
      channel?: string | undefined
    }

/**
 * Main-only orchestration for `grok update`.
 *
 * It acquires the shared App/CLI update lock, drains every ACP process with
 * AppController's strict persistence gate, performs a fresh update check,
 * asks for native confirmation using the exact checked versions, executes the
 * fixed CLI command, and verifies the result before allowing sessions to
 * reconnect. Renderer input is deliberately zero-argument.
 */
export class CliUpdateInstallCoordinator {
  private terminal = false
  private retainedLeases:
    | { quiescence: UpdateQuiescenceLease; operation: UpdateOperationLease }
    | undefined

  constructor(private readonly options: CliUpdateInstallCoordinatorOptions) {}

  installCli(): Promise<CliUpdateInstallResult>
  async installCli(...rawArguments: unknown[]): Promise<CliUpdateInstallResult> {
    if (rawArguments.length !== 0) throw new CliUpdateInstallError('invalid-request')
    if (this.terminal) throw new CliUpdateInstallError('ambiguous-failure')

    let operationLease: UpdateOperationLease | undefined
    let quiescenceLease: UpdateQuiescenceLease | undefined
    try {
      operationLease = this.options.operationLock.acquire('cli')
      try {
        quiescenceLease = await this.options.controller.acquireUpdateQuiescence()
      } catch {
        throw new CliUpdateInstallError('quiescence-failed')
      }

      const runtime = this.options.runtimeProvider()
      if (!runtime) throw new CliUpdateInstallError('unavailable')

      const before = await this.check(runtime, 'check-failed')
      if (before.state !== 'update-available') {
        throw new CliUpdateInstallError('fresh-check-required')
      }
      const currentVersion = canonicalGrokCliUpdateVersion(before.current)
      const targetVersion = canonicalGrokCliUpdateVersion(before.latest)
      if (
        !currentVersion || !targetVersion ||
        compareCanonicalGrokCliVersions(currentVersion, targetVersion) >= 0
      ) {
        throw new CliUpdateInstallError('check-failed')
      }

      let confirmed: boolean
      try {
        confirmed = await this.options.confirmInstall(currentVersion, targetVersion)
      } catch {
        throw new CliUpdateInstallError('confirmation-failed')
      }
      if (confirmed !== true && confirmed !== false) {
        throw new CliUpdateInstallError('confirmation-failed')
      }
      if (!confirmed) return { state: 'cancelled' }

      try {
        await runtime.cli.installUpdate(runtime.cwd, targetVersion)
      } catch (error) {
        if (!isDefinitelyPreExecutionFailure(error)) {
          const retainedQuiescence = quiescenceLease
          const retainedOperation = operationLease
          quiescenceLease = undefined
          operationLease = undefined
          return await this.failAmbiguous(retainedQuiescence, retainedOperation)
        }
        throw new CliUpdateInstallError('install-failed')
      }

      let installedVersion: string | undefined
      try {
        installedVersion = canonicalGrokCliUpdateVersionOutput(
          await runtime.cli.readVersion(runtime.cwd)
        )
      } catch {
        // The command returned success but the executable cannot be read back;
        // never reconnect an ACP process through that unverified binary.
      }
      if (installedVersion !== targetVersion) {
        const retainedQuiescence = quiescenceLease
        const retainedOperation = operationLease
        quiescenceLease = undefined
        operationLease = undefined
        return await this.failAmbiguous(retainedQuiescence, retainedOperation)
      }

      const after = await this.safePostCheck(runtime, targetVersion)
      const latestVersion = after?.latest ?? targetVersion
      const updateAvailable = after?.state === 'update-available'

      const result: CliUpdateInstallResult = {
        state: 'installed',
        current: installedVersion,
        latest: latestVersion,
        updateAvailable,
        ...(after?.channel ? { channel: after.channel } : {})
      }
      // AppController intentionally rejects mutations while quiescent. Release
      // that gate first, then refresh only the exact path used by this run while
      // the shared update lock still excludes another update operation.
      quiescenceLease.release()
      quiescenceLease = undefined
      try {
        this.options.recordInstalledVersion?.(runtime.cliPath, installedVersion)
      } catch {
        // Updating the display cache cannot turn a verified binary update into
        // a failed/retryable command. Startup and the next check refresh it.
      }
      return result
    } catch (error) {
      if (error instanceof UpdateOperationBusyError) {
        throw new CliUpdateInstallError('busy')
      }
      if (error instanceof CliUpdateInstallError) throw error
      throw new CliUpdateInstallError('install-failed')
    } finally {
      quiescenceLease?.release()
      operationLease?.release()
    }
  }

  private async safePostCheck(
    runtime: CliUpdateRuntime,
    installedVersion: string
  ): Promise<
    | { state: 'up-to-date' | 'update-available'; latest: string; channel?: string | undefined }
    | undefined
  > {
    try {
      const after = await this.check(runtime, 'verification-failed')
      if (after.state === 'failed') return undefined
      const current = canonicalGrokCliUpdateVersion(after.current)
      const latest = canonicalGrokCliUpdateVersion(after.latest)
      if (!current || !latest || current !== installedVersion) return undefined
      if (after.state === 'up-to-date' && latest !== installedVersion) return undefined
      if (
        after.state === 'update-available' &&
        compareCanonicalGrokCliVersions(installedVersion, latest) >= 0
      ) return undefined
      return {
        state: after.state,
        latest,
        ...(after.channel ? { channel: after.channel } : {})
      }
    } catch {
      // Exact local --version verification is authoritative for reconnect.
      // Feed refresh is only used to surface a newer version that appeared.
      return undefined
    }
  }

  private async failAmbiguous(
    quiescence: UpdateQuiescenceLease,
    operation: UpdateOperationLease
  ): Promise<never> {
    this.terminal = true
    this.retainedLeases = { quiescence, operation }
    try {
      await this.options.handleAmbiguousFailure()
    } catch {
      // Retain both gates even if the platform quit request itself fails.
    }
    throw new CliUpdateInstallError('ambiguous-failure')
  }

  private async check(
    runtime: CliUpdateRuntime,
    failure: Extract<CliUpdateInstallErrorCode, 'check-failed' | 'verification-failed'>
  ): Promise<ReturnType<typeof parseGrokCliUpdateCheck>> {
    try {
      const result = parseGrokCliUpdateCheck(await runtime.cli.checkForUpdate(runtime.cwd))
      if (result.state === 'failed') {
        throw new CliUpdateInstallError(failure)
      }
      return result
    } catch (error) {
      if (error instanceof CliUpdateInstallError) throw error
      throw new CliUpdateInstallError(failure)
    }
  }
}

function publicErrorMessage(code: CliUpdateInstallErrorCode): string {
  switch (code) {
    case 'invalid-request': return 'The Grok CLI update request is invalid.'
    case 'busy': return 'Another update operation is already in progress.'
    case 'unavailable': return 'The Grok CLI is unavailable.'
    case 'quiescence-failed': return 'Active work could not be paused safely for the Grok CLI update.'
    case 'check-failed': return 'Could not check the Grok CLI update immediately before installation.'
    case 'fresh-check-required': return 'No fresh Grok CLI update is available.'
    case 'confirmation-failed': return 'The Grok CLI update confirmation could not be completed.'
    case 'install-failed': return 'The Grok CLI update command failed.'
    case 'verification-failed': return 'The Grok CLI update could not be verified after installation.'
    case 'ambiguous-failure': return 'The Grok CLI update result is uncertain; restart before using the CLI.'
  }
}

function isDefinitelyPreExecutionFailure(error: unknown): boolean {
  return error instanceof GrokCliServiceError && [
    'invalid-cli',
    'invalid-cwd',
    'invalid-version',
    'spawn-failed'
  ].includes(error.code)
}
