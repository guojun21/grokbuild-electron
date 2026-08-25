import { describe, expect, it } from 'vitest'
import {
  checkAppUpdate,
  compareVersions,
  isNotarizationClaimed,
  normalizeVersion,
  parseGrokCliUpdateCheck
} from '../../src/main/updates/UpdateService'

describe('UpdateService', () => {
  it('selects the highest stable notarized release and only its exact Electron asset', async () => {
    const releases = [
      release({ tag: 'v9.0.0', name: 'Unsigned', draft: false }),
      release({ tag: 'v0.1.5', name: 'v0.1.5 (Notarized)' }),
      release({
        tag: 'v0.2.0',
        name: 'v0.2.0 (Notarized)',
        assets: [
          asset('GrokBuild-v0.2.0.app.zip', 'https://example.com/swift.zip'),
          asset(
            'GrokBuild-Electron-v0.2.0.app.zip',
            'https://example.com/electron.zip',
            `sha256:${'a'.repeat(64)}`,
            12_345
          )
        ]
      })
    ]
    const result = await checkAppUpdate({
      installedVersion: '0.1.0',
      releasesUrl: 'https://api.example.com/releases',
      productAssetStem: 'GrokBuild-Electron',
      fetchImpl: async () => jsonResponse(releases)
    })
    expect(result).toMatchObject({
      latestVersion: '0.2.0',
      assetName: 'GrokBuild-Electron-v0.2.0.app.zip',
      downloadUrl: 'https://example.com/electron.zip',
      assetDigest: `sha256:${'a'.repeat(64)}`,
      assetSize: 12_345,
      updateAvailable: true,
      notarizationClaimed: true
    })
  })

  it('never treats a claim as signature verification or falls back to the Swift asset', async () => {
    const result = await checkAppUpdate({
      installedVersion: '0.3.0',
      releasesUrl: 'https://api.example.com/releases',
      productAssetStem: 'GrokBuild-Electron',
      fetchImpl: async () => jsonResponse([release({
        tag: 'v0.2.0',
        body: 'This version is properly code-signed and notarized.',
        assets: [
          asset('GrokBuild-v0.2.0.app.zip', 'https://example.com/swift.zip'),
          asset('GrokBuild-Electron-v0.1.9.app.zip', 'https://example.com/wrong-version.zip')
        ]
      })])
    })
    expect(result.downloadUrl).toBeUndefined()
    expect(result.updateAvailable).toBe(false)
    expect(result.notarizationClaimed).toBe(true)
  })

  it('rejects unsafe feeds, prereleases, drafts, oversized bodies, and redirects', async () => {
    await expect(checkAppUpdate({
      installedVersion: '0.1.0',
      releasesUrl: 'http://example.com/releases',
      productAssetStem: 'GrokBuild-Electron'
    })).rejects.toThrow('HTTPS')
    await expect(checkAppUpdate({
      installedVersion: '0.1.0',
      releasesUrl: 'https://example.com/releases',
      productAssetStem: 'GrokBuild-Electron',
      fetchImpl: async () => jsonResponse([
        release({ tag: 'v1.0.0', name: 'v1 (Notarized)', draft: true }),
        { ...release({ tag: 'v1.0.0', name: 'v1 (Notarized)' }), prerelease: true }
      ])
    })).rejects.toThrow('No stable release')
    await expect(checkAppUpdate({
      installedVersion: '0.1.0',
      releasesUrl: 'https://example.com/releases',
      productAssetStem: 'GrokBuild-Electron',
      fetchImpl: async () => new Response('[]', {
        headers: { 'content-length': String(3 * 1024 * 1024) }
      })
    })).rejects.toThrow('too large')
  })

  it('ignores non-canonical release tags before they can reach native confirmation', async () => {
    const result = await checkAppUpdate({
      installedVersion: '0.1.0',
      releasesUrl: 'https://example.com/releases',
      productAssetStem: 'GrokBuild-Electron',
      fetchImpl: async () => jsonResponse([
        release({ tag: 'v999.0.0\nInstall trusted update?', name: 'bad (Notarized)' }),
        release({ tag: 'v0.2.0', name: 'v0.2.0 (Notarized)' })
      ])
    })
    expect(result.tagName).toBe('v0.2.0')
    expect(result.latestVersion).toBe('0.2.0')
  })

  it('parses bounded CLI update JSON without echoing malformed output', () => {
    expect(parseGrokCliUpdateCheck(JSON.stringify({
      currentVersion: '1.0.5', latestVersion: '1.0.6', updateAvailable: true, channel: 'stable'
    }))).toEqual({
      state: 'update-available', current: '1.0.5', latest: '1.0.6', channel: 'stable'
    })
    expect(parseGrokCliUpdateCheck('secret-canary-not-json')).toEqual({
      state: 'failed', message: 'Could not parse Grok CLI update status.'
    })
  })

  it('compares normalized numeric version components', () => {
    expect(normalizeVersion(' V1.2.0 ')).toBe('1.2.0')
    expect(compareVersions('v0.2.0', '0.1.10')).toBe(1)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0)
    expect(isNotarizationClaimed('v1 (Notarized)', undefined)).toBe(true)
  })
})

function release(options: {
  tag: string
  name?: string
  body?: string
  draft?: boolean
  assets?: unknown[]
}): Record<string, unknown> {
  return {
    tag_name: options.tag,
    name: options.name ?? null,
    body: options.body ?? null,
    html_url: `https://example.com/releases/${options.tag}`,
    published_at: '2026-08-25T00:00:00Z',
    draft: options.draft ?? false,
    prerelease: false,
    assets: options.assets ?? []
  }
}

function asset(name: string, url: string, digest?: string, size?: number): Record<string, unknown> {
  return {
    name,
    browser_download_url: url,
    ...(digest ? { digest } : {}),
    ...(size !== undefined ? { size } : {})
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
