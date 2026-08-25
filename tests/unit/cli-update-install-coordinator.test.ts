import { describe, expect, it, vi } from 'vitest'
import {
  CliUpdateInstallCoordinator,
  CliUpdateInstallError,
  type CliUpdateRuntime
} from '../../src/main/updates/CliUpdateInstallCoordinator'
import { UpdateOperationLock } from '../../src/main/updates/UpdateOperationLock'
import { GrokCliServiceError } from '../../src/main/grok/GrokCliService'

describe('CliUpdateInstallCoordinator', () => {
  it('drains sessions, confirms exact fresh versions, installs, verifies, and releases in order', async () => {
    const events: string[] = []
    const runtime = makeRuntime(events)
    const quiescence = {
      release: vi.fn(() => events.push('quiescence-release'))
    }
    const controller = {
      acquireUpdateQuiescence: vi.fn(async () => {
        events.push('quiescence-acquire')
        return quiescence
      })
    }
    const confirmInstall = vi.fn(async (current: string, latest: string) => {
      events.push(`confirm:${current}->${latest}`)
      return true
    })
    const recordInstalledVersion = vi.fn((path: string, version: string) => {
      events.push(`record:${path}:${version}`)
    })
    const lock = new UpdateOperationLock()
    const coordinator = new CliUpdateInstallCoordinator({
      runtimeProvider: () => {
        events.push('runtime')
        return runtime
      },
      controller,
      operationLock: lock,
      confirmInstall,
      recordInstalledVersion,
      handleAmbiguousFailure: async () => undefined
    })

    await expect(coordinator.installCli()).resolves.toEqual({
      state: 'installed',
      current: '1.0.6',
      latest: '1.0.6',
      updateAvailable: false,
      channel: 'stable'
    })
    expect(events).toEqual([
      'quiescence-acquire',
      'runtime',
      'check:1',
      'confirm:1.0.5->1.0.6',
      'install:1.0.6',
      'check:2',
      'quiescence-release',
      'record:/fixed/grok:1.0.6'
    ])
    expect(confirmInstall).toHaveBeenCalledWith('1.0.5', '1.0.6')
    expect(lock.snapshot()).toEqual({ busy: false })
  })

  it('never runs the updater when confirmation is cancelled', async () => {
    const events: string[] = []
    const runtime = makeRuntime(events)
    const coordinator = makeCoordinator({
      runtime,
      confirmInstall: async () => false
    })

    await expect(coordinator.installCli()).resolves.toEqual({ state: 'cancelled' })
    expect(runtime.cli.installUpdate).not.toHaveBeenCalled()
    expect(events).toEqual(['check:1'])
  })

  it('requires a fresh actionable check while the gates are held', async () => {
    const runtime = makeRuntime([], [upToDate('1.0.6')])
    const coordinator = makeCoordinator({ runtime })

    const error = await rejection(coordinator.installCli())
    expect(error).toMatchObject({ code: 'fresh-check-required' })
    expect(runtime.cli.installUpdate).not.toHaveBeenCalled()
  })

  it('retains both gates and requests guarded quit when the installed executable cannot be verified', async () => {
    const runtime = makeRuntime([])
    vi.mocked(runtime.cli.readVersion).mockResolvedValueOnce('grok 1.0.5 (stale)')
    const operationLock = new UpdateOperationLock()
    const release = vi.fn()
    const handleAmbiguousFailure = vi.fn(async () => undefined)
    const coordinator = new CliUpdateInstallCoordinator({
      runtimeProvider: () => runtime,
      controller: { acquireUpdateQuiescence: async () => ({ release }) },
      operationLock,
      confirmInstall: async () => true,
      handleAmbiguousFailure
    })

    const error = await rejection(coordinator.installCli())
    expect(error).toMatchObject({ code: 'ambiguous-failure' })
    expect(release).not.toHaveBeenCalled()
    expect(handleAmbiguousFailure).toHaveBeenCalledOnce()
    expect(operationLock.snapshot()).toEqual({ busy: true, operation: 'cli' })
    await expect(coordinator.installCli()).rejects.toMatchObject({ code: 'ambiguous-failure' })
  })

  it('binds the command to the confirmed version when the feed advances during installation', async () => {
    const events: string[] = []
    const runtime = makeRuntime(events, [
      available('1.0.5', '1.0.6'),
      available('1.0.6', '1.0.7')
    ])

    await expect(makeCoordinator({ runtime }).installCli()).resolves.toEqual({
      state: 'installed',
      current: '1.0.6',
      latest: '1.0.7',
      updateAvailable: true,
      channel: 'stable'
    })
    expect(runtime.cli.installUpdate).toHaveBeenCalledWith('/fixed/project', '1.0.6')
    expect(events).toContain('install:1.0.6')
  })

  it('installs and verifies an exact prerelease target', async () => {
    const runtime = makeRuntime([], [
      available('0.1.150', '0.1.151-alpha-feature.2'),
      upToDate('0.1.151-alpha-feature.2')
    ])

    await expect(makeCoordinator({ runtime }).installCli()).resolves.toMatchObject({
      state: 'installed',
      current: '0.1.151-alpha-feature.2',
      latest: '0.1.151-alpha-feature.2',
      updateAvailable: false
    })
    expect(runtime.cli.installUpdate).toHaveBeenCalledWith(
      '/fixed/project',
      '0.1.151-alpha-feature.2'
    )
  })

  it('rejects a downgrade even when a hostile check labels it available', async () => {
    const runtime = makeRuntime([], [available('1.0.6', '1.0.5')])
    const confirmInstall = vi.fn(async () => true)

    await expect(makeCoordinator({ runtime, confirmInstall }).installCli())
      .rejects.toMatchObject({ code: 'check-failed' })
    expect(confirmInstall).not.toHaveBeenCalled()
    expect(runtime.cli.installUpdate).not.toHaveBeenCalled()
  })

  it('rejects untrusted version text before native confirmation or command execution', async () => {
    const runtime = makeRuntime([], [available('1.0.5', '1.0.6\n--force')])
    const confirmInstall = vi.fn(async () => true)

    await expect(makeCoordinator({ runtime, confirmInstall }).installCli())
      .rejects.toMatchObject({ code: 'check-failed' })
    expect(confirmInstall).not.toHaveBeenCalled()
    expect(runtime.cli.installUpdate).not.toHaveBeenCalled()
  })

  it('maps private command and check failures to fixed public errors', async () => {
    const runtime = makeRuntime([])
    vi.mocked(runtime.cli.installUpdate).mockRejectedValueOnce(
      new GrokCliServiceError('invalid-cli', 'update-install')
    )
    const installError = await rejection(makeCoordinator({ runtime }).installCli())
    expect(installError).toMatchObject({ code: 'install-failed' })
    expect(String(installError)).not.toMatch(/xai-private|\/Users\/private/)

    vi.mocked(runtime.cli.checkForUpdate).mockRejectedValueOnce(
      new Error('secret stderr')
    )
    const checkError = await rejection(makeCoordinator({ runtime }).installCli())
    expect(checkError).toMatchObject({ code: 'check-failed' })
    expect(String(checkError)).not.toContain('secret stderr')
  })

  it('treats an arbitrary updater failure as ambiguous and never reconnects or leaks it', async () => {
    const runtime = makeRuntime([])
    vi.mocked(runtime.cli.installUpdate).mockRejectedValueOnce(
      new Error('xai-private /Users/private/.grok partial replacement')
    )
    const release = vi.fn()
    const handleAmbiguousFailure = vi.fn(async () => undefined)
    const coordinator = new CliUpdateInstallCoordinator({
      runtimeProvider: () => runtime,
      controller: { acquireUpdateQuiescence: async () => ({ release }) },
      operationLock: new UpdateOperationLock(),
      confirmInstall: async () => true,
      handleAmbiguousFailure
    })

    const error = await rejection(coordinator.installCli())
    expect(error).toMatchObject({ code: 'ambiguous-failure' })
    expect(String(error)).not.toMatch(/xai-private|\/Users\/private|partial replacement/)
    expect(release).not.toHaveBeenCalled()
    expect(handleAmbiguousFailure).toHaveBeenCalledOnce()
  })

  it('uses exact local version verification when the post-install feed check fails', async () => {
    const runtime = makeRuntime([])
    vi.mocked(runtime.cli.checkForUpdate).mockResolvedValueOnce(available('1.0.5', '1.0.6'))
      .mockRejectedValueOnce(new Error('offline private diagnostic'))

    await expect(makeCoordinator({ runtime }).installCli()).resolves.toEqual({
      state: 'installed',
      current: '1.0.6',
      latest: '1.0.6',
      updateAvailable: false
    })
  })

  it('does not turn a verified update into failure when display-version recording throws', async () => {
    const runtime = makeRuntime([])
    const release = vi.fn()
    const coordinator = new CliUpdateInstallCoordinator({
      runtimeProvider: () => runtime,
      controller: { acquireUpdateQuiescence: async () => ({ release }) },
      operationLock: new UpdateOperationLock(),
      confirmInstall: async () => true,
      recordInstalledVersion: () => { throw new Error('private UI cache failure') },
      handleAmbiguousFailure: async () => undefined
    })

    await expect(coordinator.installCli()).resolves.toMatchObject({
      state: 'installed',
      current: '1.0.6'
    })
    expect(release).toHaveBeenCalledOnce()
  })

  it('rejects hostile arguments before acquiring either gate', async () => {
    const acquireUpdateQuiescence = vi.fn()
    const operationLock = new UpdateOperationLock()
    const coordinator = new CliUpdateInstallCoordinator({
      runtimeProvider: () => undefined,
      controller: { acquireUpdateQuiescence },
      operationLock,
      confirmInstall: async () => true,
      handleAmbiguousFailure: async () => undefined
    })

    const call = coordinator.installCli as (...args: unknown[]) => Promise<unknown>
    await expect(call({ cliPath: '/tmp/evil', args: ['update', '--force'] }))
      .rejects.toMatchObject({ code: 'invalid-request' })
    expect(acquireUpdateQuiescence).not.toHaveBeenCalled()
    expect(operationLock.snapshot()).toEqual({ busy: false })
  })

  it('shares mutual exclusion with an app update and never drains on contention', async () => {
    const operationLock = new UpdateOperationLock()
    const appLease = operationLock.acquire('app')
    const acquireUpdateQuiescence = vi.fn()
    const coordinator = new CliUpdateInstallCoordinator({
      runtimeProvider: () => makeRuntime([]),
      controller: { acquireUpdateQuiescence },
      operationLock,
      confirmInstall: async () => true,
      handleAmbiguousFailure: async () => undefined
    })

    await expect(coordinator.installCli()).rejects.toMatchObject({ code: 'busy' })
    expect(acquireUpdateQuiescence).not.toHaveBeenCalled()
    appLease.release()
  })

  it('does not resolve the runtime until after quiescence is acquired', async () => {
    const events: string[] = []
    const coordinator = new CliUpdateInstallCoordinator({
      runtimeProvider: () => {
        events.push('runtime')
        return undefined
      },
      controller: {
        acquireUpdateQuiescence: async () => {
          events.push('quiescence')
          return { release: () => events.push('release') }
        }
      },
      operationLock: new UpdateOperationLock(),
      confirmInstall: async () => true,
      handleAmbiguousFailure: async () => undefined
    })

    await expect(coordinator.installCli()).rejects.toMatchObject({ code: 'unavailable' })
    expect(events).toEqual(['quiescence', 'runtime', 'release'])
  })
})

function makeCoordinator(options: {
  runtime: CliUpdateRuntime
  confirmInstall?: (current: string, latest: string) => Promise<boolean>
}): CliUpdateInstallCoordinator {
  return new CliUpdateInstallCoordinator({
    runtimeProvider: () => options.runtime,
    controller: { acquireUpdateQuiescence: async () => ({ release: () => undefined }) },
    operationLock: new UpdateOperationLock(),
    confirmInstall: options.confirmInstall ?? (async () => true),
    handleAmbiguousFailure: async () => undefined
  })
}

function makeRuntime(
  events: string[],
  checks: string[] = [available('1.0.5', '1.0.6'), upToDate('1.0.6')]
): CliUpdateRuntime & {
  cli: {
    checkForUpdate: ReturnType<typeof vi.fn<() => Promise<string>>>
    installUpdate: ReturnType<typeof vi.fn<(cwd: string, version: string) => Promise<void>>>
    readVersion: ReturnType<typeof vi.fn<(cwd: string) => Promise<string>>>
  }
} {
  let checkIndex = 0
  let installedVersion = '1.0.5'
  return {
    cliPath: '/fixed/grok',
    cwd: '/fixed/project',
    cli: {
      checkForUpdate: vi.fn(async () => {
        events.push(`check:${checkIndex + 1}`)
        return checks[Math.min(checkIndex++, checks.length - 1)]!
      }),
      installUpdate: vi.fn(async (_cwd: string, version: string) => {
        events.push(`install:${version}`)
        installedVersion = version
      }),
      readVersion: vi.fn(async () => `grok ${installedVersion} (qa)`)
    }
  }
}

function available(current: string, latest: string): string {
  return JSON.stringify({
    currentVersion: current,
    latestVersion: latest,
    updateAvailable: true,
    channel: 'stable'
  })
}

function upToDate(version: string): string {
  return JSON.stringify({
    currentVersion: version,
    latestVersion: version,
    updateAvailable: false,
    channel: 'stable'
  })
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CliUpdateInstallError)
    return error as Error
  }
  throw new Error('Expected promise to reject')
}
