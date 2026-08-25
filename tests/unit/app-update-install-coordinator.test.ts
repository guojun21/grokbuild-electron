import { describe, expect, it, vi } from 'vitest'
import type { MacAppIdentity } from '../../src/main/updates/MacAppIdentityService'
import type { VerifiedAppArchive } from '../../src/main/updates/TrustedAppArchiveVerifier'
import type { StagedUpdateArchive } from '../../src/main/updates/TrustedUpdateStager'
import { TrustedSquirrelUpdateError } from '../../src/main/updates/TrustedSquirrelUpdater'
import {
  AppUpdateInstallCoordinator,
  AppUpdateInstallError,
  PRODUCTION_APP_BUNDLE_ID,
  PRODUCTION_APP_NAME,
  type AppUpdateInstallCoordinatorOptions
} from '../../src/main/updates/AppUpdateInstallCoordinator'
import {
  UpdateCoordinator,
  type AppUpdateCandidate,
  type UpdateCheckResult
} from '../../src/main/updates/UpdateCoordinator'
import { UpdateOperationLock } from '../../src/main/updates/UpdateOperationLock'

const PRIVATE_CANARY = 'install-private-canary-349be1'
const PRIVATE_URL = `https://private.example/${PRIVATE_CANARY}.zip`
const PRIVATE_TEAM = 'A1B2C3D4E5'

const CANDIDATE: AppUpdateCandidate = Object.freeze({
  installedVersion: '1.0.0',
  latestVersion: '1.1.0',
  tagName: 'v1.1.0',
  downloadUrl: PRIVATE_URL,
  assetDigest: `sha256:${'a'.repeat(64)}`,
  assetSize: 98_765,
  publishedAt: '2026-08-25T00:00:00Z'
})

const IDENTITY: MacAppIdentity = Object.freeze({
  appPath: '/Applications/GrokBuild Electron.app',
  executablePath: '/Applications/GrokBuild Electron.app/Contents/MacOS/GrokBuild Electron',
  bundleId: PRODUCTION_APP_BUNDLE_ID,
  appName: PRODUCTION_APP_NAME,
  shortVersion: '1.0.0',
  bundleVersion: '100',
  teamId: PRIVATE_TEAM,
  designatedRequirement: `identifier ${PRODUCTION_APP_BUNDLE_ID} and team ${PRIVATE_TEAM}`,
  architectures: ['arm64'] as const
})

const STAGED: StagedUpdateArchive = Object.freeze({
  directory: '/private/update-stage',
  archivePath: '/private/update-stage/update.app.zip',
  byteLength: 98_765,
  sha256: 'a'.repeat(64)
})

const VERIFIED: VerifiedAppArchive = Object.freeze({
  directory: '/private/update-verify',
  appPath: '/private/update-verify/GrokBuild Electron.app',
  appName: PRODUCTION_APP_NAME,
  bundleId: PRODUCTION_APP_BUNDLE_ID,
  version: '1.1.0',
  teamId: PRIVATE_TEAM
})

const CHECK_RESULT: UpdateCheckResult = Object.freeze({
  overview: Object.freeze({
    checkedAt: '2026-08-25T01:02:03.000Z',
    app: Object.freeze({
      state: 'update-available' as const,
      installed: '1.0.0',
      latest: '1.1.0',
      assetAvailable: true
    }),
    cli: Object.freeze({ state: 'unavailable' as const })
  }),
  appReleaseUrl: 'https://example.com/releases/v1.1.0'
})

describe('AppUpdateInstallCoordinator', () => {
  it('runs the trusted install transaction in exact order and retains quiescence on success', async () => {
    const harness = makeHarness()

    await expect(harness.coordinator.installApp()).resolves.toBe('restarting')

    expect(harness.calls).toEqual([
      'consume',
      'confirm',
      'identity',
      'stage',
      'verify',
      'discard-verified',
      'quiescence',
      'identity',
      'prepare',
      'discard-stage',
      'start-update-quit',
      'quit-and-install',
      'finish-update-quit'
    ])
    expect(harness.fakes.identity).toHaveBeenCalledWith({
      executablePath: '/Applications/GrokBuild Electron.app/Contents/MacOS/GrokBuild Electron',
      isPackaged: true
    })
    expect(harness.fakes.confirmInstall).toHaveBeenCalledWith('1.1.0')
    expect(harness.fakes.stage).toHaveBeenCalledWith({
      downloadUrl: PRIVATE_URL,
      expectedDigest: CANDIDATE.assetDigest,
      expectedSize: 98_765
    })
    expect(harness.fakes.verify).toHaveBeenCalledWith({
      archivePath: STAGED.archivePath,
      expectedBundleId: PRODUCTION_APP_BUNDLE_ID,
      expectedVersion: '1.1.0',
      expectedBundleVersion: '1.1.0',
      expectedAppName: PRODUCTION_APP_NAME,
      expectedTeamId: PRIVATE_TEAM,
      expectedDesignatedRequirement: IDENTITY.designatedRequirement,
      expectedArchitectures: ['arm64']
    })
    expect(harness.fakes.prepare).toHaveBeenCalledWith({
      staged: STAGED,
      currentVersion: '1.0.0',
      expectedVersion: '1.1.0'
    })
    expect(harness.fakes.releaseLease).not.toHaveBeenCalled()
    expect(harness.fakes.discardStage).toHaveBeenCalledOnce()
    await expect(harness.operationLock.runExclusive('cli', () => undefined))
      .rejects.toMatchObject({ code: 'update-operation-busy' })
    await expect(harness.coordinator.installApp())
      .rejects.toMatchObject({ code: 'already-started' })
  })

  it('projects discovery only and never returns a cached install candidate', async () => {
    const harness = makeHarness()
    harness.fakes.check.mockResolvedValueOnce({
      ...CHECK_RESULT,
      candidate: { ...CANDIDATE, secret: PRIVATE_CANARY }
    } as UpdateCheckResult)

    const result = await harness.coordinator.check('/workspace')

    expect(harness.fakes.check).toHaveBeenCalledWith('/workspace')
    expect(result).toEqual(CHECK_RESULT)
    expect(JSON.stringify(result)).not.toContain('candidate')
    expect(JSON.stringify(result)).not.toContain(PRIVATE_CANARY)
    expect(harness.fakes.consume).not.toHaveBeenCalled()
  })

  it('holds the shared lock during exact-version confirmation and consumes cancellation', async () => {
    const harness = makeHarness()
    const confirmationStarted = deferred<string>()
    const decision = deferred<boolean>()
    harness.fakes.confirmInstall.mockImplementationOnce(async (latestVersion) => {
      harness.calls.push('confirm')
      confirmationStarted.resolve(latestVersion)
      return await decision.promise
    })

    const installing = harness.coordinator.installApp()
    await expect(confirmationStarted.promise).resolves.toBe('1.1.0')
    expect(harness.operationLock.snapshot()).toEqual({ busy: true, operation: 'app' })
    await expect(harness.coordinator.check('/workspace'))
      .rejects.toMatchObject({ code: 'busy' })
    await expect(harness.operationLock.runExclusive('cli', () => undefined))
      .rejects.toMatchObject({ code: 'update-operation-busy' })

    decision.resolve(false)
    await expect(installing).resolves.toBe('cancelled')
    expect(harness.fakes.confirmInstall).toHaveBeenCalledWith('1.1.0')
    expect(harness.fakes.identity).not.toHaveBeenCalled()
    expect(harness.fakes.stage).not.toHaveBeenCalled()
    expect(harness.operationLock.snapshot()).toEqual({ busy: false })
    await expect(harness.coordinator.installApp())
      .rejects.toMatchObject({ code: 'fresh-check-required' })
    expect(harness.fakes.confirmInstall).toHaveBeenCalledTimes(1)
  })

  it('maps confirmation rejection to a fixed error and requires a fresh check', async () => {
    const harness = makeHarness()
    harness.fakes.confirmInstall.mockImplementationOnce(async () => {
      harness.calls.push('confirm')
      throw new Error(`${PRIVATE_CANARY} ${PRIVATE_URL} /private/confirm`)
    })

    const error = await rejection(harness.coordinator.installApp())

    expect(error).toMatchObject({ code: 'confirmation-failed' })
    expect(publicError(error)).not.toContain(PRIVATE_CANARY)
    expect(harness.fakes.identity).not.toHaveBeenCalled()
    expect(harness.operationLock.snapshot()).toEqual({ busy: false })
    await expect(harness.coordinator.installApp())
      .rejects.toMatchObject({ code: 'fresh-check-required' })
  })

  it('requires a fresh one-shot candidate after any failed attempt', async () => {
    const harness = makeHarness()
    harness.fakes.identity.mockRejectedValueOnce(new Error(PRIVATE_CANARY))

    await expect(harness.coordinator.installApp())
      .rejects.toMatchObject({ code: 'identity-ineligible' })
    await expect(harness.coordinator.installApp())
      .rejects.toMatchObject({ code: 'fresh-check-required' })
    expect(harness.fakes.identity).toHaveBeenCalledTimes(1)
    expect(harness.fakes.stage).not.toHaveBeenCalled()
  })

  it('rejects an expired real discovery candidate without reaching identity inspection', async () => {
    let now = new Date('2026-08-25T01:00:00Z')
    const discovery = new UpdateCoordinator({
      appVersion: '1.0.0',
      releasesUrl: 'https://api.example.com/releases',
      productAssetStem: 'GrokBuild-Electron',
      candidateTtlMs: 100,
      now: () => now,
      fetchImpl: async () => new Response(JSON.stringify([{
        tag_name: 'v1.1.0',
        name: 'v1.1.0',
        html_url: 'https://example.com/releases/v1.1.0',
        published_at: '2026-08-25T00:00:00Z',
        draft: false,
        prerelease: false,
        assets: [{
          name: 'GrokBuild-Electron-v1.1.0.app.zip',
          browser_download_url: PRIVATE_URL,
          digest: CANDIDATE.assetDigest,
          size: CANDIDATE.assetSize
        }]
      }]))
    })
    const harness = makeHarness({ updateCoordinator: discovery })

    const result = await harness.coordinator.check()
    expect(JSON.stringify(result)).not.toContain(PRIVATE_URL)
    expect(JSON.stringify(result)).not.toContain(CANDIDATE.assetDigest)
    now = new Date('2026-08-25T01:00:00.101Z')
    await expect(harness.coordinator.installApp())
      .rejects.toMatchObject({ code: 'fresh-check-required' })
    expect(harness.fakes.identity).not.toHaveBeenCalled()
  })

  it('accepts only the two exact Applications bundle locations', async () => {
    const home = '/Users/tester'
    const homeHarness = makeHarness({
      homeDirectory: home,
      identity: {
        ...IDENTITY,
        appPath: `${home}/Applications/GrokBuild Electron.app`,
        executablePath: `${home}/Applications/GrokBuild Electron.app/Contents/MacOS/GrokBuild Electron`
      }
    })
    await expect(homeHarness.coordinator.installApp()).resolves.toBe('restarting')

    for (const appPath of [
      '/Users/tester/Downloads/GrokBuild Electron.app',
      '/Applications/GrokBuild Electron.app/',
      '/Applications/Renamed.app'
    ]) {
      const harness = makeHarness({ homeDirectory: home, identity: { ...IDENTITY, appPath } })
      await expect(harness.coordinator.installApp(), appPath)
        .rejects.toMatchObject({ code: 'location-ineligible' })
      expect(harness.fakes.stage).not.toHaveBeenCalled()
    }
  })

  it('fails closed for unsigned or mismatched current identities and versions', async () => {
    const unsigned = makeHarness()
    unsigned.fakes.identity.mockRejectedValueOnce(
      new Error(`${PRIVATE_CANARY} /private/current.app ${PRIVATE_TEAM}`)
    )
    await expect(unsigned.coordinator.installApp())
      .rejects.toMatchObject({ code: 'identity-ineligible' })

    for (const identity of [
      { ...IDENTITY, bundleId: 'example.wrong.bundle' },
      { ...IDENTITY, appName: 'Wrong App' }
    ]) {
      const harness = makeHarness({ identity })
      await expect(harness.coordinator.installApp())
        .rejects.toMatchObject({ code: 'identity-ineligible' })
      expect(harness.fakes.stage).not.toHaveBeenCalled()
    }

    const changed = makeHarness({ identity: { ...IDENTITY, shortVersion: '1.0.1' } })
    await expect(changed.coordinator.installApp())
      .rejects.toMatchObject({ code: 'version-mismatch' })
    expect(changed.fakes.stage).not.toHaveBeenCalled()
  })

  it.each([
    ['stage', 'stage-failed', ['consume', 'confirm', 'identity', 'stage'], 0, 0],
    ['verify', 'verification-failed', [
      'consume', 'confirm', 'identity', 'stage', 'verify', 'discard-stage'
    ], 1, 0],
    ['quiescence', 'quiescence-failed', [
      'consume', 'confirm', 'identity', 'stage', 'verify', 'discard-verified',
      'quiescence', 'discard-stage'
    ], 1, 0],
    ['prepare', 'prepare-failed', [
      'consume', 'confirm', 'identity', 'stage', 'verify', 'discard-verified',
      'quiescence', 'identity', 'prepare', 'discard-stage', 'release-lease'
    ], 1, 1]
  ] as const)(
    'cleans owned resources and releases quiescence when %s fails',
    async (failure, code, calls, stageDiscards, leaseReleases) => {
      const harness = makeHarness()
      failInstallStep(harness, failure)

      const error = await rejection(harness.coordinator.installApp())

      expect(error).toMatchObject({ code })
      expect(harness.calls).toEqual(calls)
      expect(harness.fakes.discardStage).toHaveBeenCalledTimes(stageDiscards)
      expect(harness.fakes.releaseLease).toHaveBeenCalledTimes(leaseReleases)
      expect(publicError(error)).not.toContain(PRIVATE_CANARY)
      expect(publicError(error)).not.toContain('/private/path')
      expect(publicError(error)).not.toContain('https://')
      expect(publicError(error)).not.toContain(PRIVATE_TEAM)
    }
  )

  it('returns restarting, falls back to plain quit, and retains both leases after handoff', async () => {
    const synchronousWrapperFailure = makeHarness()
    synchronousWrapperFailure.fakes.startUpdateQuit.mockImplementationOnce(() => {
      synchronousWrapperFailure.calls.push('start-update-quit')
      throw new Error(`${PRIVATE_CANARY} /private/synchronous-wrapper`)
    })
    await expect(synchronousWrapperFailure.coordinator.installApp())
      .resolves.toBe('restarting')
    expect(synchronousWrapperFailure.fakes.quitApplication).toHaveBeenCalledOnce()
    expect(synchronousWrapperFailure.fakes.releaseLease).not.toHaveBeenCalled()
    expect(synchronousWrapperFailure.fakes.discardStage).toHaveBeenCalledOnce()
    expect(synchronousWrapperFailure.operationLock.snapshot())
      .toEqual({ busy: true, operation: 'app' })

    const wrapperFailure = makeHarness()
    wrapperFailure.fakes.startUpdateQuit.mockImplementationOnce(async () => {
      wrapperFailure.calls.push('start-update-quit')
      throw new Error(`${PRIVATE_CANARY} /private/wrapper`)
    })
    await expect(wrapperFailure.coordinator.installApp()).resolves.toBe('restarting')
    expect(wrapperFailure.fakes.quitApplication).toHaveBeenCalledOnce()
    expect(wrapperFailure.fakes.releaseLease).not.toHaveBeenCalled()
    expect(wrapperFailure.fakes.discardStage).toHaveBeenCalledOnce()
    expect(wrapperFailure.fakes.discardVerified).toHaveBeenCalledOnce()
    expect(wrapperFailure.operationLock.snapshot()).toEqual({ busy: true, operation: 'app' })

    const squirrelFailure = makeHarness()
    squirrelFailure.fakes.quitAndInstall.mockImplementationOnce(() => {
      squirrelFailure.calls.push('quit-and-install')
      throw new Error(`${PRIVATE_CANARY} /private/squirrel`)
    })
    await expect(squirrelFailure.coordinator.installApp()).resolves.toBe('restarting')
    expect(squirrelFailure.fakes.quitApplication).toHaveBeenCalledOnce()
    expect(squirrelFailure.fakes.releaseLease).not.toHaveBeenCalled()
    expect(squirrelFailure.fakes.discardStage).toHaveBeenCalledOnce()
    expect(squirrelFailure.operationLock.snapshot()).toEqual({ busy: true, operation: 'app' })
  })

  it('continues the irreversible quit when prepared source-stage cleanup fails', async () => {
    const harness = makeHarness()
    harness.fakes.discardStage.mockImplementationOnce(async () => {
      harness.calls.push('discard-stage')
      throw new Error(`${PRIVATE_CANARY} /private/stale-stage`)
    })

    await expect(harness.coordinator.installApp()).resolves.toBe('restarting')

    expect(harness.fakes.discardStage).toHaveBeenCalledOnce()
    expect(harness.fakes.quitAndInstall).toHaveBeenCalledOnce()
    expect(harness.fakes.releaseLease).not.toHaveBeenCalled()
    expect(harness.operationLock.snapshot()).toEqual({ busy: true, operation: 'app' })
    expect(harness.calls.slice(-4)).toEqual([
      'discard-stage', 'start-update-quit', 'quit-and-install', 'finish-update-quit'
    ])
  })

  it('ordinary-quits and retains resources when prepare reports a terminal handoff', async () => {
    const harness = makeHarness()
    harness.fakes.prepare.mockImplementationOnce(async () => {
      harness.calls.push('prepare')
      throw new TrustedSquirrelUpdateError('failed-closed')
    })

    await expect(harness.coordinator.installApp()).resolves.toBe('restarting')

    expect(harness.calls).toEqual([
      'consume', 'confirm', 'identity', 'stage', 'verify', 'discard-verified',
      'quiescence', 'identity', 'prepare', 'start-update-quit',
      'quit-application', 'finish-update-quit'
    ])
    expect(harness.fakes.quitApplication).toHaveBeenCalledOnce()
    expect(harness.fakes.quitAndInstall).not.toHaveBeenCalled()
    expect(harness.fakes.discardStage).not.toHaveBeenCalled()
    expect(harness.fakes.releaseLease).not.toHaveBeenCalled()
    expect(harness.operationLock.snapshot()).toEqual({ busy: true, operation: 'app' })
    await expect(harness.coordinator.installApp())
      .rejects.toMatchObject({ code: 'already-started' })
  })

  it('rejects mismatched verified metadata and cleans both owned artifacts', async () => {
    const harness = makeHarness()
    harness.fakes.verify.mockImplementationOnce(async () => {
      harness.calls.push('verify')
      return { ...structuredClone(VERIFIED), version: '9.9.9' }
    })

    await expect(harness.coordinator.installApp())
      .rejects.toMatchObject({ code: 'verification-failed' })
    expect(harness.fakes.discardVerified).toHaveBeenCalledOnce()
    expect(harness.fakes.discardStage).toHaveBeenCalledOnce()
    expect(harness.fakes.acquireUpdateQuiescence).not.toHaveBeenCalled()
    expect(harness.operationLock.snapshot()).toEqual({ busy: false })
  })

  it('retries extraction cleanup in the failure unwind before reporting the verify failure', async () => {
    const harness = makeHarness()
    harness.fakes.discardVerified.mockImplementationOnce(async () => {
      harness.calls.push('discard-verified')
      throw new Error(`${PRIVATE_CANARY} /private/extraction`)
    })

    const error = await rejection(harness.coordinator.installApp())

    expect(error).toMatchObject({ code: 'verification-failed' })
    expect(harness.fakes.discardVerified).toHaveBeenCalledTimes(2)
    expect(harness.fakes.discardStage).toHaveBeenCalledOnce()
    expect(harness.operationLock.snapshot()).toEqual({ busy: false })
    expect(publicError(error)).not.toContain(PRIVATE_CANARY)
  })

  it('falls back to plain quit when the wrapper never invokes its one-shot callback', async () => {
    const harness = makeHarness()
    harness.fakes.startUpdateQuit.mockImplementationOnce(async () => {
      harness.calls.push('start-update-quit')
    })

    await expect(harness.coordinator.installApp()).resolves.toBe('restarting')
    expect(harness.fakes.quitAndInstall).not.toHaveBeenCalled()
    expect(harness.fakes.quitApplication).toHaveBeenCalledOnce()
    expect(harness.fakes.releaseLease).not.toHaveBeenCalled()
    expect(harness.fakes.discardStage).toHaveBeenCalledOnce()
    expect(harness.operationLock.snapshot()).toEqual({ busy: true, operation: 'app' })
  })

  it('rechecks the exact running app identity before the irreversible handoff', async () => {
    const harness = makeHarness()
    harness.fakes.identity
      .mockResolvedValueOnce(structuredClone(IDENTITY))
      .mockResolvedValueOnce({
        ...structuredClone(IDENTITY),
        appPath: '/Users/tester/Downloads/GrokBuild Electron.app',
        designatedRequirement: `${IDENTITY.designatedRequirement} changed`
      })

    const error = await rejection(harness.coordinator.installApp())

    expect(error).toMatchObject({ code: 'identity-ineligible' })
    expect(harness.fakes.identity).toHaveBeenCalledTimes(2)
    expect(harness.fakes.startUpdateQuit).not.toHaveBeenCalled()
    expect(harness.fakes.prepare).not.toHaveBeenCalled()
    expect(harness.fakes.releaseLease).toHaveBeenCalledOnce()
    expect(harness.operationLock.snapshot()).toEqual({ busy: false })
    expect(publicError(error)).not.toContain('/Users/tester/Downloads')
  })

  it('fails closed if cleanup itself fails and still attempts every cleanup action', async () => {
    const harness = makeHarness()
    harness.fakes.prepare.mockRejectedValueOnce(new Error(PRIVATE_CANARY))
    harness.fakes.discardStage.mockImplementationOnce(async () => {
      harness.calls.push('discard-stage')
      throw new Error(`${PRIVATE_CANARY} /private/stage`)
    })
    harness.fakes.releaseLease.mockImplementationOnce(() => {
      harness.calls.push('release-lease')
      throw new Error(`${PRIVATE_CANARY} /private/lease`)
    })

    const error = await rejection(harness.coordinator.installApp())

    expect(error).toMatchObject({ code: 'cleanup-failed' })
    expect(harness.fakes.discardStage).toHaveBeenCalledOnce()
    expect(harness.fakes.releaseLease).toHaveBeenCalledOnce()
    expect(publicError(error)).not.toContain(PRIVATE_CANARY)
  })

  it('uses the shared app/CLI lock, invalidates a contended candidate, and requires recheck', async () => {
    const lock = new UpdateOperationLock()
    const gate = deferred<void>()
    const held = lock.runExclusive('cli', () => gate.promise)
    const harness = makeHarness({ operationLock: lock })

    await expect(harness.coordinator.installApp())
      .rejects.toMatchObject({ code: 'busy' })
    expect(harness.fakes.identity).not.toHaveBeenCalled()
    expect(harness.fakes.consume).toHaveBeenCalledOnce()

    gate.resolve()
    await held
    await expect(harness.coordinator.installApp())
      .rejects.toMatchObject({ code: 'fresh-check-required' })
  })

  it('rejects renderer-supplied install arguments before acquiring authority', async () => {
    const harness = makeHarness()
    const callWithArguments = harness.coordinator.installApp.bind(harness.coordinator) as unknown as (
      value: unknown
    ) => Promise<unknown>

    await expect(callWithArguments(`${PRIVATE_CANARY} /private/archive.zip`))
      .rejects.toMatchObject({ code: 'invalid-request' })
    expect(harness.fakes.consume).toHaveBeenCalledOnce()
    expect(harness.fakes.identity).not.toHaveBeenCalled()
    await expect(harness.coordinator.installApp())
      .rejects.toMatchObject({ code: 'fresh-check-required' })
  })
})

interface HarnessOptions {
  updateCoordinator?: AppUpdateInstallCoordinatorOptions['updateCoordinator']
  operationLock?: UpdateOperationLock
  identity?: MacAppIdentity
  candidate?: AppUpdateCandidate | null
  homeDirectory?: string
}

function makeHarness(options: HarnessOptions = {}) {
  const calls: string[] = []
  let candidate: AppUpdateCandidate | undefined = options.candidate === null
    ? undefined
    : structuredClone(options.candidate ?? CANDIDATE)
  const releaseLease = vi.fn(() => { calls.push('release-lease') })
  const check = vi.fn(async () => CHECK_RESULT)
  const consume = vi.fn(() => {
    calls.push('consume')
    const current = candidate
    candidate = undefined
    return current === undefined ? undefined : structuredClone(current)
  })
  const confirmInstall = vi.fn(async (_latestVersion: string) => {
    calls.push('confirm')
    return true
  })
  const identity = vi.fn(async () => {
    calls.push('identity')
    return structuredClone(options.identity ?? IDENTITY)
  })
  const stage = vi.fn(async () => {
    calls.push('stage')
    return structuredClone(STAGED)
  })
  const discardStage = vi.fn(async () => { calls.push('discard-stage') })
  const verify = vi.fn(async () => {
    calls.push('verify')
    return structuredClone(VERIFIED)
  })
  const discardVerified = vi.fn(async () => { calls.push('discard-verified') })
  const acquireUpdateQuiescence = vi.fn(async () => {
    calls.push('quiescence')
    return { release: releaseLease }
  })
  const prepare = vi.fn(async () => {
    calls.push('prepare')
    return { state: 'ready' as const, version: CANDIDATE.latestVersion }
  })
  const quitAndInstall = vi.fn(() => { calls.push('quit-and-install') })
  const quitApplication = vi.fn(() => { calls.push('quit-application') })
  const startUpdateQuit = vi.fn(async (install: () => void) => {
    calls.push('start-update-quit')
    install()
    calls.push('finish-update-quit')
  })
  const updateCoordinator = options.updateCoordinator ?? { check, consumeAppCandidate: consume }
  const operationLock = options.operationLock ?? new UpdateOperationLock()
  const coordinator = new AppUpdateInstallCoordinator({
    updateCoordinator,
    identityService: { inspect: identity },
    stager: { stage, discard: discardStage },
    verifier: { verify, discard: discardVerified },
    squirrel: { prepare, quitAndInstall },
    operationLock,
    controller: { acquireUpdateQuiescence },
    executablePath: IDENTITY.executablePath,
    isPackaged: true,
    confirmInstall,
    startUpdateQuit,
    quitApplication,
    ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {})
  })

  return {
    coordinator,
    operationLock,
    calls,
    fakes: {
      check,
      consume,
      confirmInstall,
      identity,
      stage,
      discardStage,
      verify,
      discardVerified,
      acquireUpdateQuiescence,
      releaseLease,
      prepare,
      quitAndInstall,
      quitApplication,
      startUpdateQuit
    }
  }
}

type InstallFailureStep = 'stage' | 'verify' | 'quiescence' | 'prepare'

function failInstallStep(
  harness: ReturnType<typeof makeHarness>,
  step: InstallFailureStep
): void {
  const failure = new Error(`${PRIVATE_CANARY} /private/path ${PRIVATE_URL} ${PRIVATE_TEAM}`)
  switch (step) {
    case 'stage':
      harness.fakes.stage.mockImplementationOnce(async () => {
        harness.calls.push('stage')
        throw failure
      })
      return
    case 'verify':
      harness.fakes.verify.mockImplementationOnce(async () => {
        harness.calls.push('verify')
        throw failure
      })
      return
    case 'quiescence':
      harness.fakes.acquireUpdateQuiescence.mockImplementationOnce(async () => {
        harness.calls.push('quiescence')
        throw failure
      })
      return
    case 'prepare':
      harness.fakes.prepare.mockImplementationOnce(async () => {
        harness.calls.push('prepare')
        throw failure
      })
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject.')
}

function publicError(error: unknown): string {
  if (!(error instanceof AppUpdateInstallError)) return JSON.stringify(error)
  return JSON.stringify({ name: error.name, code: error.code, message: error.message })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
