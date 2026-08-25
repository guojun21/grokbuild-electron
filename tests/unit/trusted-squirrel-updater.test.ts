import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { StagedUpdateArchive } from '../../src/main/updates/TrustedUpdateStager'
import {
  TrustedSquirrelUpdateError,
  TrustedSquirrelUpdater,
  type SquirrelAutoUpdaterAdapter
} from '../../src/main/updates/TrustedSquirrelUpdater'

const roots: string[] = []
const PRIVATE_CANARY = '/private/update-canary-5ea8f0.app.zip'
const FEED_DATE = new Date('2026-08-25T01:02:03.000Z')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('TrustedSquirrelUpdater', () => {
  it('atomically writes a private file feed and becomes ready without quitting', async () => {
    const staged = await stagedArchive('signed-update-archive')
    const adapter = new FakeAutoUpdater()
    adapter.onCheck = () => emitDownloadedFromFeed(adapter)
    const updater = new TrustedSquirrelUpdater({
      autoUpdater: adapter,
      now: () => FEED_DATE
    })

    const prepared = await updater.prepare({
      staged,
      currentVersion: '1.1.9',
      expectedVersion: 'v1.2.0'
    })

    expect(prepared).toEqual({ state: 'ready', version: '1.2.0' })
    expect(adapter.feed).toMatchObject({ serverType: 'json' })
    expect(adapter.feed?.url.startsWith('file://')).toBe(true)
    const feedPath = fileURLToPath(adapter.feed!.url)
    expect(feedPath).toBe(join(staged.directory, 'releases.json'))
    expect((Number((await lstat(feedPath, { bigint: true })).mode) & 0o777)).toBe(0o600)
    expect((await readdir(staged.directory)).sort()).toEqual([
      'releases.json',
      'update.app.zip'
    ])

    const feed = JSON.parse(await readFile(feedPath, 'utf8')) as {
      currentRelease: string
      releases: Array<{
        version: string
        updateTo: Record<string, string | number>
      }>
    }
    expect(feed).toEqual({
      currentRelease: '1.2.0',
      releases: [{
        version: '1.2.0',
        updateTo: {
          version: '1.2.0',
          pub_date: '2026-08-25T01:02:03Z',
          notes: '',
          name: '1.2.0',
          url: pathToFileURL(staged.archivePath).toString(),
          sha256: staged.sha256,
          size: staged.byteLength
        }
      }]
    })
    expect(adapter.checkCalls).toBe(1)
    expect(adapter.quitCalls).toBe(0)
    expect(noUpdateListeners(adapter)).toBe(true)
    expect(JSON.stringify(prepared)).not.toContain('file://')
    expect(JSON.stringify(prepared)).not.toContain(staged.directory)

    updater.quitAndInstall()
    expect(adapter.quitCalls).toBe(1)
    expect(() => updater.quitAndInstall()).toThrowError(expect.objectContaining({
      code: 'already-started'
    }))
    expect(adapter.quitCalls).toBe(1)
  })

  it('permits only one prepare operation and cleans every event listener', async () => {
    const staged = await stagedArchive('single-flight-update')
    const adapter = new FakeAutoUpdater()
    const updater = new TrustedSquirrelUpdater({ autoUpdater: adapter, timeoutMs: 1_000 })

    const first = updater.prepare({
      staged,
      currentVersion: '2.0.0',
      expectedVersion: '2.0.1'
    })
    await waitFor(() => adapter.checkCalls === 1)
    await expect(updater.prepare({
      staged,
      currentVersion: '2.0.0',
      expectedVersion: '2.0.1'
    })).rejects.toMatchObject({ code: 'busy' })

    await emitDownloadedFromFeed(adapter)
    await expect(first).resolves.toEqual({ state: 'ready', version: '2.0.1' })
    expect(noUpdateListeners(adapter)).toBe(true)
    await expect(updater.prepare({
      staged,
      currentVersion: '2.0.0',
      expectedVersion: '2.0.2'
    })).rejects.toMatchObject({ code: 'busy' })
  })

  it.each([
    {
      name: 'update-not-available',
      emit(adapter: FakeAutoUpdater) { adapter.emit('update-not-available', {}) },
      code: 'update-not-available'
    },
    {
      name: 'adapter error',
      emit(adapter: FakeAutoUpdater) { adapter.emit('error', new Error(PRIVATE_CANARY)) },
      code: 'check-failed'
    },
    {
      name: 'wrong release name',
      async emit(adapter: FakeAutoUpdater) {
        await emitDownloadedFromFeed(adapter, {
          releaseName: `3.1.0-${PRIVATE_CANARY}`
        })
      },
      code: 'version-mismatch'
    }
  ])('locks terminally after $name once Squirrel handoff starts', async ({ emit }) => {
    const staged = await stagedArchive('event-failure-update')
    const adapter = new FakeAutoUpdater()
    adapter.onCheck = () => emit(adapter)
    const updater = new TrustedSquirrelUpdater({
      autoUpdater: adapter,
      now: () => FEED_DATE
    })

    const error = await rejection(updater.prepare({
      staged,
      currentVersion: '3.0.0',
      expectedVersion: '3.1.0'
    }))

    expect(error).toBeInstanceOf(TrustedSquirrelUpdateError)
    expect(error).toMatchObject({ code: 'failed-closed' })
    expect(serializeError(error)).not.toContain(PRIVATE_CANARY)
    expect(noUpdateListeners(adapter)).toBe(true)
    expect((await readdir(staged.directory)).sort()).toEqual([
      'releases.json',
      'update.app.zip'
    ])
    await expect(updater.prepare({
      staged,
      currentVersion: '3.0.0',
      expectedVersion: '3.1.1'
    })).rejects.toMatchObject({ code: 'failed-closed' })
    expect(adapter.checkCalls).toBe(1)
    expect(() => updater.quitAndInstall()).toThrowError(expect.objectContaining({
      code: 'failed-closed'
    }))
  })

  it('bounds a silent check and maps rejected checks without leaking raw errors', async () => {
    const timedStage = await stagedArchive('timeout-update')
    const silentAdapter = new FakeAutoUpdater()
    const timed = new TrustedSquirrelUpdater({ autoUpdater: silentAdapter, timeoutMs: 15 })
    await expect(timed.prepare({
      staged: timedStage,
      currentVersion: '4.0.0',
      expectedVersion: '4.0.1'
    })).rejects.toMatchObject({ code: 'failed-closed' })
    expect(noUpdateListeners(silentAdapter)).toBe(true)
    expect((await readdir(timedStage.directory)).sort()).toEqual([
      'releases.json',
      'update.app.zip'
    ])
    await expect(timed.prepare({
      staged: timedStage,
      currentVersion: '4.0.0',
      expectedVersion: '4.0.2'
    })).rejects.toMatchObject({ code: 'failed-closed' })

    const rejectedStage = await stagedArchive('rejected-check-update')
    const rejectedAdapter = new FakeAutoUpdater()
    rejectedAdapter.onCheck = () => Promise.reject(new Error(PRIVATE_CANARY))
    const rejected = new TrustedSquirrelUpdater({ autoUpdater: rejectedAdapter })
    const error = await rejection(rejected.prepare({
      staged: rejectedStage,
      currentVersion: '4.0.0',
      expectedVersion: '4.0.1'
    }))
    expect(error).toMatchObject({ code: 'failed-closed' })
    expect(serializeError(error)).not.toContain(PRIVATE_CANARY)
    expect(noUpdateListeners(rejectedAdapter)).toBe(true)
    await expect(rejected.prepare({
      staged: rejectedStage,
      currentVersion: '4.0.0',
      expectedVersion: '4.0.2'
    })).rejects.toMatchObject({ code: 'failed-closed' })
  })

  it.each([
    ['equal', '5.0.0', '5.0.0'],
    ['lower', '5.0.0', '4.9.9'],
    ['prerelease', '5.0.0', '5.1.0-beta.1'],
    ['ambiguous leading zero', '5.0.0', '05.1.0'],
    ['whitespace', '5.0.0', ' 5.1.0']
  ])('rejects a %s version before configuring Electron', async (_name, current, expected) => {
    const staged = await stagedArchive('non-monotonic-update')
    const adapter = new FakeAutoUpdater()
    const updater = new TrustedSquirrelUpdater({ autoUpdater: adapter, now: () => FEED_DATE })

    await expect(updater.prepare({ staged, currentVersion: current, expectedVersion: expected }))
      .rejects.toMatchObject({ code: 'invalid-request' })
    expect(adapter.feed).toBeUndefined()
    expect(adapter.checkCalls).toBe(0)
  })

  it('requires the exact private staged directory/update.app.zip shape', async () => {
    const staged = await stagedArchive('invalid-stage-update')
    const adapter = new FakeAutoUpdater()
    const updater = new TrustedSquirrelUpdater({ autoUpdater: adapter, now: () => FEED_DATE })

    await expect(updater.prepare({
      staged: { ...staged, archivePath: join(staged.directory, 'renamed.zip') },
      currentVersion: '6.0.0',
      expectedVersion: '6.0.1'
    })).rejects.toMatchObject({ code: 'invalid-request' })

    const linkPath = join(staged.directory, 'archive-link.zip')
    await symlink(staged.archivePath, linkPath)
    await expect(updater.prepare({
      staged: { ...staged, archivePath: linkPath },
      currentVersion: '6.0.0',
      expectedVersion: '6.0.1'
    })).rejects.toMatchObject({ code: 'invalid-request' })
    expect(adapter.checkCalls).toBe(0)
  })

  it('re-hashes the stager artifact before handoff and rejects a digest mismatch reversibly', async () => {
    const staged = await stagedArchive('digest-bound-update')
    const adapter = new FakeAutoUpdater()
    const updater = new TrustedSquirrelUpdater({ autoUpdater: adapter, now: () => FEED_DATE })

    await expect(updater.prepare({
      staged: { ...staged, sha256: '0'.repeat(64) },
      currentVersion: '6.1.0',
      expectedVersion: '6.1.1'
    })).rejects.toMatchObject({ code: 'invalid-request' })
    expect(adapter.checkCalls).toBe(0)
    expect(await readdir(staged.directory)).toEqual(['update.app.zip'])
  })

  it('fails reversibly when Electron does not retain the exact local feed URL', async () => {
    const staged = await stagedArchive('feed-url-bound-update')
    const adapter = new FakeAutoUpdater()
    adapter.reportedFeedUrl = `file://${PRIVATE_CANARY}`
    const updater = new TrustedSquirrelUpdater({ autoUpdater: adapter, now: () => FEED_DATE })

    await expect(updater.prepare({
      staged,
      currentVersion: '6.2.0',
      expectedVersion: '6.2.1'
    })).rejects.toMatchObject({ code: 'artifact-mismatch' })
    expect(adapter.checkCalls).toBe(0)
    expect(await readdir(staged.directory)).toEqual(['update.app.zip'])

    delete adapter.reportedFeedUrl
    adapter.onCheck = () => emitDownloadedFromFeed(adapter)
    await expect(updater.prepare({
      staged,
      currentVersion: '6.2.0',
      expectedVersion: '6.2.1'
    })).resolves.toEqual({ state: 'ready', version: '6.2.1' })
  })

  it.each([
    ['archive URL', { updateUrl: `file://${PRIVATE_CANARY}` }],
    ['release date', { releaseDate: new Date('2026-08-25T01:02:04.000Z') }],
    ['release notes', { releaseNotes: PRIVATE_CANARY }]
  ] as const)('fails closed when the downloaded event has the wrong %s', async (_name, overrides) => {
    const staged = await stagedArchive('event-binding-update')
    const adapter = new FakeAutoUpdater()
    adapter.onCheck = () => emitDownloadedFromFeed(adapter, overrides)
    const updater = new TrustedSquirrelUpdater({ autoUpdater: adapter, now: () => FEED_DATE })

    const error = await rejection(updater.prepare({
      staged,
      currentVersion: '6.3.0',
      expectedVersion: '6.3.1'
    }))
    expect(error).toMatchObject({ code: 'failed-closed' })
    expect(serializeError(error)).not.toContain(PRIVATE_CANARY)
    expect(adapter.checkCalls).toBe(1)
    await expect(updater.prepare({
      staged,
      currentVersion: '6.3.0',
      expectedVersion: '6.3.2'
    })).rejects.toMatchObject({ code: 'failed-closed' })
  })

  it('holds and rechecks the verified inode across the Squirrel handoff', async () => {
    const staged = await stagedArchive('inode-bound-update')
    const adapter = new FakeAutoUpdater()
    adapter.onCheck = async () => {
      await writeFile(staged.archivePath, Buffer.alloc(staged.byteLength, 0x5a))
      await emitDownloadedFromFeed(adapter)
    }
    const updater = new TrustedSquirrelUpdater({ autoUpdater: adapter, now: () => FEED_DATE })

    await expect(updater.prepare({
      staged,
      currentVersion: '6.4.0',
      expectedVersion: '6.4.1'
    })).rejects.toMatchObject({ code: 'failed-closed' })
    expect(adapter.checkCalls).toBe(1)
    expect((await readdir(staged.directory)).sort()).toEqual([
      'releases.json',
      'update.app.zip'
    ])
  })

  it('allows quit exactly once only after ready and keeps adapter failures fixed', async () => {
    const staged = await stagedArchive('quit-update')
    const adapter = new FakeAutoUpdater()
    adapter.quitFailure = new Error(`${PRIVATE_CANARY}?token=secret`)
    const updater = new TrustedSquirrelUpdater({ autoUpdater: adapter, now: () => FEED_DATE })

    expect(() => updater.quitAndInstall()).toThrowError(expect.objectContaining({ code: 'not-ready' }))
    adapter.onCheck = () => emitDownloadedFromFeed(adapter)
    await updater.prepare({
      staged,
      currentVersion: '7.0.0',
      expectedVersion: '7.0.1'
    })

    const first = captureThrow(() => updater.quitAndInstall())
    expect(first).toMatchObject({ code: 'install-start-failed' })
    expect(serializeError(first)).not.toContain(PRIVATE_CANARY)
    expect(adapter.quitCalls).toBe(1)
    expect(() => updater.quitAndInstall()).toThrowError(expect.objectContaining({
      code: 'already-started'
    }))
    expect(adapter.quitCalls).toBe(1)
  })

  it('cleans listeners when feed configuration throws synchronously', async () => {
    const staged = await stagedArchive('configuration-failure-update')
    const adapter = new FakeAutoUpdater()
    adapter.feedFailure = new Error(PRIVATE_CANARY)
    const updater = new TrustedSquirrelUpdater({ autoUpdater: adapter, now: () => FEED_DATE })

    const error = await rejection(updater.prepare({
      staged,
      currentVersion: '8.0.0',
      expectedVersion: '8.0.1'
    }))
    expect(error).toMatchObject({ code: 'check-failed' })
    expect(serializeError(error)).not.toContain(PRIVATE_CANARY)
    expect(noUpdateListeners(adapter)).toBe(true)
    expect(await readdir(staged.directory)).toEqual(['update.app.zip'])

    delete adapter.feedFailure
    adapter.onCheck = () => emitDownloadedFromFeed(adapter)
    await expect(updater.prepare({
      staged,
      currentVersion: '8.0.0',
      expectedVersion: '8.0.1'
    })).resolves.toEqual({ state: 'ready', version: '8.0.1' })
  })

  it('fails closed on an exact stale download event emitted while replacing the feed', async () => {
    const staged = await stagedArchive('stale-downloaded-update')
    const adapter = new FakeAutoUpdater()
    adapter.onSetFeed = () => {
      adapter.emit(
        'update-downloaded',
        {},
        '',
        '8.1.1',
        FEED_DATE,
        pathToFileURL(staged.archivePath).toString()
      )
    }
    const updater = new TrustedSquirrelUpdater({ autoUpdater: adapter, now: () => FEED_DATE })

    await expect(updater.prepare({
      staged,
      currentVersion: '8.1.0',
      expectedVersion: '8.1.1'
    })).rejects.toMatchObject({ code: 'failed-closed' })

    expect(adapter.checkCalls).toBe(0)
    expect(noUpdateListeners(adapter)).toBe(true)
    expect((await readdir(staged.directory)).sort()).toEqual([
      'releases.json',
      'update.app.zip'
    ])
    await expect(updater.prepare({
      staged,
      currentVersion: '8.1.0',
      expectedVersion: '8.1.2'
    })).rejects.toMatchObject({ code: 'failed-closed' })
  })
})

class FakeAutoUpdater extends EventEmitter implements SquirrelAutoUpdaterAdapter {
  feed?: { url: string; serverType: 'json' }
  reportedFeedUrl?: string
  feedFailure?: Error
  quitFailure?: Error
  onSetFeed?: () => void
  onCheck?: () => void | PromiseLike<unknown>
  checkCalls = 0
  quitCalls = 0

  setFeedURL(options: { url: string; serverType: 'json' }): void {
    if (this.feedFailure) throw this.feedFailure
    this.feed = options
    this.onSetFeed?.()
  }

  getFeedURL(): string {
    return this.reportedFeedUrl ?? this.feed?.url ?? ''
  }

  checkForUpdates(): void | PromiseLike<unknown> {
    this.checkCalls += 1
    return this.onCheck?.()
  }

  quitAndInstall(): void {
    this.quitCalls += 1
    if (this.quitFailure) throw this.quitFailure
  }
}

async function stagedArchive(contents: string): Promise<StagedUpdateArchive> {
  const initial = await mkdtemp(join(tmpdir(), 'grokbuild-squirrel-update-'))
  const directory = await realpath(initial)
  roots.push(directory)
  await chmod(directory, 0o700)
  const archivePath = join(directory, 'update.app.zip')
  const bytes = Buffer.from(contents)
  await writeFile(archivePath, bytes, { mode: 0o600, flag: 'wx' })
  await chmod(archivePath, 0o600)
  return {
    directory,
    archivePath,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

async function emitDownloadedFromFeed(
  adapter: FakeAutoUpdater,
  overrides: {
    releaseNotes?: string
    releaseName?: string
    releaseDate?: Date
    updateUrl?: string
  } = {}
): Promise<void> {
  if (!adapter.feed) throw new Error('Expected a configured feed.')
  const feed = JSON.parse(await readFile(fileURLToPath(adapter.feed.url), 'utf8')) as {
    releases: Array<{
      updateTo: {
        notes: string
        name: string
        pub_date: string
        url: string
      }
    }>
  }
  const update = feed.releases[0]?.updateTo
  if (!update) throw new Error('Expected one feed update.')
  adapter.emit(
    'update-downloaded',
    {},
    overrides.releaseNotes ?? update.notes,
    overrides.releaseName ?? update.name,
    overrides.releaseDate ?? new Date(update.pub_date),
    overrides.updateUrl ?? update.url
  )
}

function noUpdateListeners(adapter: FakeAutoUpdater): boolean {
  return adapter.listenerCount('update-downloaded') === 0 &&
    adapter.listenerCount('update-not-available') === 0 &&
    adapter.listenerCount('error') === 0
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Condition did not become true.')
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject.')
}

function captureThrow(fn: () => void): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('Expected function to throw.')
}

function serializeError(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error)
  return JSON.stringify({ ...error, name: error.name, message: error.message })
}
