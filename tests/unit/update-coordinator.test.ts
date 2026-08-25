import { describe, expect, it, vi } from 'vitest'
import { UpdateCoordinator } from '../../src/main/updates/UpdateCoordinator'

describe('UpdateCoordinator', () => {
  it('resolves the currently configured CLI for every check', async () => {
    const first = { checkForUpdate: vi.fn(async () => JSON.stringify({
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      updateAvailable: false,
      channel: 'stable'
    })) }
    const second = { checkForUpdate: vi.fn(async () => JSON.stringify({
      currentVersion: '1.0.1',
      latestVersion: '1.0.2',
      updateAvailable: true,
      channel: 'stable'
    })) }
    let current = first
    const coordinator = new UpdateCoordinator({
      appVersion: '1.0.0',
      productAssetStem: 'GrokBuild-Electron',
      cliProvider: () => current
    })

    await expect(coordinator.check('/workspace')).resolves.toMatchObject({
      overview: { cli: { state: 'up-to-date', current: '1.0.0' } }
    })
    current = second
    await expect(coordinator.check('/workspace')).resolves.toMatchObject({
      overview: { cli: { state: 'update-available', current: '1.0.1', latest: '1.0.2' } }
    })
    expect(first.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(second.checkForUpdate).toHaveBeenCalledTimes(1)
  })

  it('combines safe app and CLI discovery without exposing download execution', async () => {
    const coordinator = new UpdateCoordinator({
      appVersion: '0.1.0',
      releasesUrl: 'https://api.example.com/releases',
      productAssetStem: 'GrokBuild-Electron',
      cli: {
        checkForUpdate: async () => JSON.stringify({
          currentVersion: '1.0.5',
          latestVersion: '1.0.6',
          updateAvailable: true,
          channel: 'stable'
        })
      },
      fetchImpl: async () => new Response(JSON.stringify([{
        tag_name: 'v0.2.0',
        name: 'v0.2.0 (Notarized)',
        body: null,
        html_url: 'https://example.com/releases/v0.2.0',
        published_at: '2026-08-25T00:00:00Z',
        draft: false,
        prerelease: false,
        assets: [{
          name: 'GrokBuild-Electron-v0.2.0.app.zip',
          browser_download_url: 'https://example.com/download.zip',
          digest: `sha256:${'a'.repeat(64)}`
        }]
      }])),
      now: () => new Date('2026-08-25T01:02:03Z')
    })

    await expect(coordinator.check('/tmp')).resolves.toEqual({
      overview: {
        checkedAt: '2026-08-25T01:02:03.000Z',
        app: {
          state: 'update-available',
          installed: '0.1.0',
          latest: '0.2.0',
          assetAvailable: true
        },
        cli: {
          state: 'update-available',
          current: '1.0.5',
          latest: '1.0.6',
          channel: 'stable'
        }
      },
      appReleaseUrl: 'https://example.com/releases/v0.2.0'
    })
  })

  it('reports unconfigured and redacted failures instead of throwing raw output', async () => {
    const coordinator = new UpdateCoordinator({
      appVersion: '0.1.0',
      productAssetStem: 'GrokBuild-Electron',
      cli: { checkForUpdate: async () => { throw new Error('secret-canary') } },
      now: () => new Date('2026-08-25T00:00:00Z')
    })
    const result = await coordinator.check('/tmp')
    expect(result.overview.app).toEqual({ state: 'unconfigured' })
    expect(result.overview.cli).toEqual({ state: 'failed', message: 'Could not check for Grok CLI updates.' })
    expect(JSON.stringify(result)).not.toContain('secret-canary')
  })

  it('keeps raw release URLs outside the renderer-safe overview', async () => {
    const coordinator = new UpdateCoordinator({
      appVersion: '0.1.0',
      releasesUrl: 'https://api.example.com/releases',
      productAssetStem: 'GrokBuild-Electron',
      fetchImpl: async () => new Response(JSON.stringify([{
        tag_name: 'v0.2.0',
        name: 'v0.2.0 (Notarized)',
        html_url: 'https://example.com/releases/v0.2.0',
        draft: false,
        prerelease: false,
        assets: []
      }]))
    })
    const result = await coordinator.check()
    expect(result.appReleaseUrl).toBe('https://example.com/releases/v0.2.0')
    expect(JSON.stringify(result.overview)).not.toContain('https://')
  })

  it('keeps the exact install candidate main-only, bounded, and single-use', async () => {
    let now = new Date('2026-08-25T01:00:00Z')
    const coordinator = new UpdateCoordinator({
      appVersion: '0.1.0',
      releasesUrl: 'https://api.example.com/releases',
      productAssetStem: 'GrokBuild-Electron',
      candidateTtlMs: 1_000,
      now: () => now,
      fetchImpl: async () => new Response(JSON.stringify([{
        tag_name: 'v0.2.0',
        name: 'v0.2.0 (Notarized)',
        html_url: 'https://example.com/releases/v0.2.0',
        published_at: '2026-08-25T00:00:00Z',
        draft: false,
        prerelease: false,
        assets: [{
          name: 'GrokBuild-Electron-v0.2.0.app.zip',
          browser_download_url: 'https://example.com/private-canary.zip',
          digest: `sha256:${'b'.repeat(64)}`,
          size: 98_765
        }]
      }]))
    })

    const checked = await coordinator.check()
    expect(JSON.stringify(checked)).not.toContain('private-canary')
    expect(coordinator.consumeAppCandidate()).toEqual({
      installedVersion: '0.1.0',
      latestVersion: '0.2.0',
      tagName: 'v0.2.0',
      downloadUrl: 'https://example.com/private-canary.zip',
      assetDigest: `sha256:${'b'.repeat(64)}`,
      assetSize: 98_765,
      publishedAt: '2026-08-25T00:00:00Z'
    })
    expect(coordinator.consumeAppCandidate()).toBeUndefined()

    await coordinator.check()
    now = new Date('2026-08-25T01:00:02Z')
    expect(coordinator.consumeAppCandidate()).toBeUndefined()
  })

  it('invalidates an older in-flight candidate when a newer check starts', async () => {
    let releaseFirst: (() => void) | undefined
    const firstBarrier = new Promise<void>((resolve) => { releaseFirst = resolve })
    let calls = 0
    const coordinator = new UpdateCoordinator({
      appVersion: '0.1.0',
      releasesUrl: 'https://api.example.com/releases',
      productAssetStem: 'GrokBuild-Electron',
      fetchImpl: async () => {
        calls += 1
        const call = calls
        if (call === 1) await firstBarrier
        const version = call === 1 ? '0.2.0' : '0.3.0'
        return new Response(JSON.stringify([{
          tag_name: `v${version}`,
          name: `v${version} (Notarized)`,
          html_url: `https://example.com/releases/v${version}`,
          draft: false,
          prerelease: false,
          assets: [{
            name: `GrokBuild-Electron-v${version}.app.zip`,
            browser_download_url: `https://example.com/${version}.zip`,
            digest: `sha256:${version === '0.2.0' ? 'a' : 'c'}`.padEnd(71, version === '0.2.0' ? 'a' : 'c')
          }]
        }]))
      }
    })

    const older = coordinator.check()
    const newer = coordinator.check()
    await newer
    releaseFirst?.()
    await older
    expect(coordinator.consumeAppCandidate()?.latestVersion).toBe('0.3.0')
  })
})
