import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveReleaseFeedUrl } from '../../src/main/updates/ReleaseFeedConfig'

const VALID = 'https://api.github.com/repos/xai-org/grok-build-desktop/releases'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveReleaseFeedUrl', () => {
  it('allows only a strict GitHub releases endpoint from development or E2E', async () => {
    await expect(resolveReleaseFeedUrl({
      isPackaged: false,
      isE2E: false,
      resourcesPath: '/unused',
      environmentUrl: VALID
    })).resolves.toBe(VALID)
    await expect(resolveReleaseFeedUrl({
      isPackaged: true,
      isE2E: true,
      resourcesPath: '/unused',
      environmentUrl: VALID
    })).resolves.toBe(VALID)

    for (const environmentUrl of [
      'http://api.github.com/repos/xai-org/grok-build-desktop/releases',
      'https://user@api.github.com/repos/xai-org/grok-build-desktop/releases',
      'https://api.github.com:443/repos/xai-org/grok-build-desktop/releases',
      'https://api.github.com/repos/xai-org/grok-build-desktop/releases?token=secret',
      'https://api.github.com/repos/xai-org/grok-build-desktop/releases#secret',
      'https://github.com/xai-org/grok-build-desktop/releases',
      'https://api.github.com/repos/-owner/grok-build-desktop/releases',
      'https://api.github.com/repos/xai-org/../releases'
    ]) {
      await expect(resolveReleaseFeedUrl({
        isPackaged: false,
        isE2E: false,
        resourcesPath: '/unused',
        environmentUrl
      })).resolves.toBeUndefined()
    }
  })

  it('ignores the environment in a packaged app and reads the strict bundle config', async () => {
    const resourcesPath = await temporaryResources()
    await writeFile(
      join(resourcesPath, 'update-feed.json'),
      `${JSON.stringify({ releasesUrl: VALID })}\n`,
      { mode: 0o600 }
    )
    await expect(resolveReleaseFeedUrl({
      isPackaged: true,
      isE2E: false,
      resourcesPath,
      environmentUrl: 'https://api.github.com/repos/attacker/replacement/releases'
    })).resolves.toBe(VALID)
  })

  it('fails closed for missing, null, malformed, oversized, or non-strict config', async () => {
    const cases: Array<string | undefined> = [
      undefined,
      JSON.stringify({ releasesUrl: null }),
      '{',
      JSON.stringify({ releasesUrl: VALID, extra: true }),
      JSON.stringify({ releasesUrl: 'https://api.github.com/repos/x/y/releases?credential=x' }),
      ' '.repeat(4 * 1024 + 1)
    ]
    for (const contents of cases) {
      const resourcesPath = await temporaryResources()
      if (contents !== undefined) {
        await writeFile(join(resourcesPath, 'update-feed.json'), contents, { mode: 0o600 })
      }
      await expect(resolveReleaseFeedUrl({
        isPackaged: true,
        isE2E: false,
        resourcesPath,
        environmentUrl: VALID
      })).resolves.toBeUndefined()
    }
  })

  it('does not follow a bundle config symlink', async () => {
    const resourcesPath = await temporaryResources()
    const target = join(resourcesPath, 'untrusted.json')
    await writeFile(target, JSON.stringify({ releasesUrl: VALID }), { mode: 0o600 })
    await symlink(target, join(resourcesPath, 'update-feed.json'))
    await expect(resolveReleaseFeedUrl({
      isPackaged: true,
      isE2E: false,
      resourcesPath,
      environmentUrl: VALID
    })).resolves.toBeUndefined()
  })

  it('rejects a noncanonical resource path without exposing it in an error', async () => {
    await expect(resolveReleaseFeedUrl({
      isPackaged: true,
      isE2E: false,
      resourcesPath: '/tmp/../tmp/resources',
      environmentUrl: VALID
    })).resolves.toBeUndefined()
  })
})

async function temporaryResources(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-feed-config-'))
  roots.push(root)
  const resourcesPath = join(root, 'resources')
  await mkdir(resourcesPath)
  return resourcesPath
}
