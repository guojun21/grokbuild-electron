import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TrustedUpdateStageError,
  TrustedUpdateStager
} from '../../src/main/updates/TrustedUpdateStager'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('TrustedUpdateStager', () => {
  it('streams an exact HTTPS asset, verifies SHA-256, and owns cleanup', async () => {
    const bytes = new TextEncoder().encode('signed-update-archive')
    const root = await temporaryRoot()
    const stager = new TrustedUpdateStager({
      stagingRoot: root,
      fetchImpl: async () => new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) }
      })
    })
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const staged = await stager.stage({
      downloadUrl: 'https://github.com/example/release.zip',
      expectedDigest: `sha256:${sha256}`,
      expectedSize: bytes.byteLength
    })

    expect(staged).toMatchObject({ byteLength: bytes.byteLength, sha256 })
    expect(await readFile(staged.archivePath)).toEqual(Buffer.from(bytes))
    await stager.discard(staged)
    expect(await readdir(root)).toEqual([])
  })

  it('allows only same-host or GitHub release redirects', async () => {
    const bytes = new TextEncoder().encode('redirected-update')
    const calls: string[] = []
    const root = await temporaryRoot()
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const stager = new TrustedUpdateStager({
      stagingRoot: root,
      fetchImpl: async (input) => {
        const url = String(input)
        calls.push(url)
        return calls.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://release-assets.githubusercontent.com/object.zip' }
            })
          : new Response(bytes, { status: 200 })
      }
    })
    const staged = await stager.stage({
      downloadUrl: 'https://github.com/example/release.zip',
      expectedDigest: `sha256:${sha256}`
    })
    expect(calls).toEqual([
      'https://github.com/example/release.zip',
      'https://release-assets.githubusercontent.com/object.zip'
    ])
    await stager.discard(staged)

    const blocked = new TrustedUpdateStager({
      stagingRoot: root,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/update.zip' }
      })
    })
    await expect(blocked.stage({
      downloadUrl: 'https://github.com/example/release.zip',
      expectedDigest: `sha256:${sha256}`
    })).rejects.toMatchObject({ code: 'download-failed' })
  })

  it('cleans partial files on digest, size, network, and request failures', async () => {
    const root = await temporaryRoot()
    const bytes = new TextEncoder().encode('too-many-bytes')
    const wrongDigest = `sha256:${'0'.repeat(64)}`
    const mismatch = new TrustedUpdateStager({
      stagingRoot: root,
      fetchImpl: async () => new Response(bytes, { status: 200 })
    })
    await expect(mismatch.stage({
      downloadUrl: 'https://updates.example/release.zip',
      expectedDigest: wrongDigest
    })).rejects.toMatchObject({ code: 'digest-mismatch' })
    expect(await readdir(root)).toEqual([])

    const oversized = new TrustedUpdateStager({
      stagingRoot: root,
      maximumBytes: 4,
      fetchImpl: async () => new Response(bytes, { status: 200 })
    })
    await expect(oversized.stage({
      downloadUrl: 'https://updates.example/release.zip',
      expectedDigest: wrongDigest
    })).rejects.toMatchObject({ code: 'download-too-large' })
    expect(await readdir(root)).toEqual([])

    await expect(mismatch.stage({
      downloadUrl: 'http://updates.example/release.zip',
      expectedDigest: wrongDigest
    })).rejects.toBeInstanceOf(TrustedUpdateStageError)
    expect(await readdir(root)).toEqual([])
  })

  it('allows only one staging operation at a time', async () => {
    const root = await temporaryRoot()
    const bytes = new TextEncoder().encode('serialized-update')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    let releaseFetch: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => { releaseFetch = resolve })
    const stager = new TrustedUpdateStager({
      stagingRoot: root,
      fetchImpl: async () => {
        await barrier
        return new Response(bytes, { status: 200 })
      }
    })
    const first = stager.stage({
      downloadUrl: 'https://updates.example/release.zip',
      expectedDigest: `sha256:${sha256}`
    })
    await expect(stager.stage({
      downloadUrl: 'https://updates.example/release.zip',
      expectedDigest: `sha256:${sha256}`
    })).rejects.toMatchObject({ code: 'busy' })
    await expect(stager.cleanupStale()).rejects.toMatchObject({ code: 'busy' })
    releaseFetch?.()
    const staged = await first
    await stager.discard(staged)
  })

  it('cleans only exact private stale directories and preserves live or unsafe paths', async () => {
    const root = await temporaryRoot()
    const external = join(root, 'external-preserved')
    await mkdir(external, { mode: 0o700 })
    await writeFile(join(external, 'keep.txt'), 'keep', { mode: 0o600 })

    const stale = join(root, 'grokbuild-update-Ab12Cd')
    await mkdir(stale, { mode: 0o700 })
    await writeFile(join(stale, 'update.app.zip'), 'stale', { mode: 0o600 })

    const staleWithFeed = join(root, 'grokbuild-update-Fe34Ed')
    await mkdir(staleWithFeed, { mode: 0o700 })
    await writeFile(join(staleWithFeed, 'update.app.zip'), 'stale', { mode: 0o600 })
    await writeFile(join(staleWithFeed, 'releases.json'), '{}', { mode: 0o600 })
    await writeFile(
      join(staleWithFeed, '.squirrel-feed-00000000-0000-4000-8000-000000000000.tmp'),
      '{}',
      { mode: 0o600 }
    )
    const emptyStale = join(root, 'grokbuild-update-Em00Ty')
    await mkdir(emptyStale, { mode: 0o700 })

    const linkedContents = join(root, 'grokbuild-update-Ln12Ks')
    await mkdir(linkedContents, { mode: 0o700 })
    await writeFile(join(linkedContents, 'update.app.zip'), 'stale', { mode: 0o600 })
    await symlink(join(external, 'keep.txt'), join(linkedContents, 'external-link'))

    const broad = join(root, 'grokbuild-update-Zz99Yy')
    await mkdir(broad, { mode: 0o700 })
    await chmod(broad, 0o755)
    const linked = join(root, 'grokbuild-update-Sy12Mk')
    await symlink(external, linked)
    const sameNameFile = join(root, 'grokbuild-update-Fi12Le')
    await writeFile(sameNameFile, 'not-a-directory', { mode: 0o600 })
    const broadFile = join(root, 'grokbuild-update-Wp12Er')
    await mkdir(broadFile, { mode: 0o700 })
    await writeFile(join(broadFile, 'update.app.zip'), 'stale', { mode: 0o600 })
    await chmod(join(broadFile, 'update.app.zip'), 0o644)
    const unrelated = join(root, 'unrelated')
    const nestedStage = join(unrelated, 'grokbuild-update-Ne12St')
    await mkdir(nestedStage, { recursive: true, mode: 0o700 })
    const nearMiss = join(root, 'grokbuild-update-Ab12Cd-extra')
    const verifierDirectory = join(root, 'grokbuild-verify-Ab12Cd')
    await mkdir(nearMiss, { mode: 0o700 })
    await mkdir(verifierDirectory, { mode: 0o700 })

    const bytes = new TextEncoder().encode('live-stage')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const stager = new TrustedUpdateStager({
      stagingRoot: root,
      fetchImpl: async () => new Response(bytes, { status: 200 })
    })
    const live = await stager.stage({
      downloadUrl: 'https://updates.example/release.zip',
      expectedDigest: `sha256:${sha256}`
    })

    const result = await stager.cleanupStale()

    expect(result.removed).toBe(3)
    expect(result.skipped).toBeGreaterThanOrEqual(6)
    expect(result.failed).toBe(0)
    await expect(access(stale)).rejects.toThrow()
    await expect(access(staleWithFeed)).rejects.toThrow()
    await expect(access(emptyStale)).rejects.toThrow()
    await expect(access(live.archivePath)).resolves.toBeUndefined()
    await expect(readFile(join(external, 'keep.txt'), 'utf8')).resolves.toBe('keep')
    await expect(access(broad)).resolves.toBeUndefined()
    await expect(access(linked)).resolves.toBeUndefined()
    await expect(access(linkedContents)).resolves.toBeUndefined()
    await expect(readFile(sameNameFile, 'utf8')).resolves.toBe('not-a-directory')
    await expect(access(broadFile)).resolves.toBeUndefined()
    await expect(access(nestedStage)).resolves.toBeUndefined()
    await expect(access(nearMiss)).resolves.toBeUndefined()
    await expect(access(verifierDirectory)).resolves.toBeUndefined()

    await expect(stager.cleanupStale()).resolves.toMatchObject({ removed: 0 })

    await stager.discard(live)
  })

  it('refuses stale cleanup through a symlinked or non-private staging root', async () => {
    const base = await temporaryRoot()
    const target = join(base, 'target')
    await mkdir(join(target, 'grokbuild-update-Ab12Cd'), {
      recursive: true,
      mode: 0o700
    })
    const linkedRoot = join(base, 'linked-root')
    await symlink(target, linkedRoot)

    const linkedStager = new TrustedUpdateStager({ stagingRoot: linkedRoot })
    await expect(linkedStager.cleanupStale()).rejects.toMatchObject({
      code: 'invalid-request'
    })
    await expect(access(join(target, 'grokbuild-update-Ab12Cd')))
      .resolves.toBeUndefined()

    const broadRoot = join(base, 'broad-root')
    const protectedStage = join(broadRoot, 'grokbuild-update-Zz99Yy')
    await mkdir(protectedStage, { recursive: true, mode: 0o700 })
    await chmod(broadRoot, 0o755)
    const broadStager = new TrustedUpdateStager({ stagingRoot: broadRoot })
    await expect(broadStager.cleanupStale()).rejects.toMatchObject({
      code: 'invalid-request'
    })
    await expect(access(protectedStage)).resolves.toBeUndefined()
  })

  it('requires an absolute normalized staging root before starting a download', async () => {
    let fetched = false
    const stager = new TrustedUpdateStager({
      stagingRoot: 'relative-update-stage',
      fetchImpl: async () => {
        fetched = true
        return new Response('unexpected')
      }
    })

    await expect(stager.stage({
      downloadUrl: 'https://updates.example/release.zip',
      expectedDigest: `sha256:${'0'.repeat(64)}`
    })).rejects.toMatchObject({ code: 'invalid-request' })
    expect(fetched).toBe(false)
  })
})

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'grokbuild-update-stage-'))
  const canonical = await realpath(path)
  roots.push(canonical)
  return canonical
}
