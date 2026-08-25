import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, type BigIntStats } from 'node:fs'
import {
  lstat,
  open,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { StagedUpdateArchive } from './TrustedUpdateStager'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 5 * 60_000
const MAX_PATH_LENGTH = 4_096
const MAX_FEED_BYTES = 64 * 1024
const ARCHIVE_NAME = 'update.app.zip'
const FEED_NAME = 'releases.json'

const UPDATE_EVENTS = Object.freeze([
  'update-downloaded',
  'update-not-available',
  'error'
] as const)

type SquirrelUpdateEvent = (typeof UPDATE_EVENTS)[number]
type SquirrelUpdateListener = (...args: unknown[]) => void

export interface SquirrelAutoUpdaterAdapter {
  setFeedURL(options: { url: string; serverType: 'json' }): void
  getFeedURL(): string
  checkForUpdates(): void | PromiseLike<unknown>
  quitAndInstall(): void
  on(event: SquirrelUpdateEvent, listener: SquirrelUpdateListener): unknown
  removeListener(event: SquirrelUpdateEvent, listener: SquirrelUpdateListener): unknown
}

export type TrustedSquirrelUpdateErrorCode =
  | 'invalid-request'
  | 'busy'
  | 'feed-write-failed'
  | 'check-failed'
  | 'update-not-available'
  | 'version-mismatch'
  | 'artifact-mismatch'
  | 'timeout'
  | 'failed-closed'
  | 'not-ready'
  | 'already-started'
  | 'install-start-failed'

/** Fixed, content-free failures safe to project across a future IPC boundary. */
export class TrustedSquirrelUpdateError extends Error {
  constructor(readonly code: TrustedSquirrelUpdateErrorCode) {
    super(updateErrorMessage(code))
    this.name = 'TrustedSquirrelUpdateError'
  }
}

export interface TrustedSquirrelPrepareRequest {
  staged: StagedUpdateArchive
  expectedVersion: string
  currentVersion: string
}

export interface PreparedSquirrelUpdate {
  state: 'ready'
  version: string
}

export interface TrustedSquirrelUpdaterOptions {
  autoUpdater: SquirrelAutoUpdaterAdapter
  timeoutMs?: number
  now?: () => Date
}

type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'preparing' }
  | { phase: 'ready'; version: string }
  | { phase: 'installing'; version: string }
  | { phase: 'failed-closed' }

interface ArchiveIdentity {
  device: bigint
  inode: bigint
  size: bigint
  modifiedNs: bigint
  changedNs: bigint
}

interface FeedArtifact {
  bytes: Uint8Array
  releaseDate: Date
}

/**
 * Main-only handoff from a TrustedUpdateStager archive to Electron's signed
 * Squirrel.Mac installer. It writes only inert feed metadata and never quits
 * the application as part of prepare().
 */
export class TrustedSquirrelUpdater {
  private readonly timeoutMs: number
  private state: UpdaterState = { phase: 'idle' }

  constructor(private readonly options: TrustedSquirrelUpdaterOptions) {
    this.timeoutMs = boundedTimeout(options.timeoutMs)
    validateAdapter(options.autoUpdater)
  }

  async prepare(request: TrustedSquirrelPrepareRequest): Promise<PreparedSquirrelUpdate> {
    if (this.state.phase === 'failed-closed') {
      throw new TrustedSquirrelUpdateError('failed-closed')
    }
    if (this.state.phase !== 'idle') throw new TrustedSquirrelUpdateError('busy')
    this.state = { phase: 'preparing' }

    let feedPath: string | undefined
    let archiveHandle: FileHandle | undefined
    let handoffStarted = false
    try {
      if (!request || typeof request !== 'object') {
        throw new TrustedSquirrelUpdateError('invalid-request')
      }
      const expectedVersion = parseVersion(request.expectedVersion)
      const currentVersion = parseVersion(request.currentVersion)
      if (compareParsedVersions(expectedVersion.components, currentVersion.components) <= 0) {
        throw new TrustedSquirrelUpdateError('invalid-request')
      }

      const archive = await validateStagedArchive(request.staged)
      feedPath = join(request.staged.directory, FEED_NAME)
      const archiveUrl = pathToFileURL(request.staged.archivePath).toString()
      const feedUrl = pathToFileURL(feedPath).toString()
      const feed = makeFeed(
        expectedVersion.normalized,
        archiveUrl,
        request.staged,
        this.options.now
      )
      await writeFeedAtomically(request.staged.directory, feedPath, feed.bytes)

      // Bind the feed to the stager's exact bytes immediately before handing
      // control to Squirrel. Keep the verified inode open until Electron says
      // the update has been downloaded, and re-check the path on both sides.
      archiveHandle = await openVerifiedArchive(request.staged, archive)
      await assertArchiveBound(request.staged.archivePath, archiveHandle, archive)

      await waitForDownloadedUpdate(
        this.options.autoUpdater,
        {
          feedUrl,
          archiveUrl,
          expectedVersion: expectedVersion.normalized,
          expectedReleaseDate: feed.releaseDate,
          timeoutMs: this.timeoutMs,
          onHandoff: () => { handoffStarted = true }
        }
      )
      await assertArchiveBound(request.staged.archivePath, archiveHandle, archive)

      this.state = { phase: 'ready', version: expectedVersion.normalized }
      return Object.freeze({ state: 'ready', version: expectedVersion.normalized })
    } catch (error) {
      this.state = handoffStarted ? { phase: 'failed-closed' } : { phase: 'idle' }
      // Once checkForUpdates() may have started, Electron/Squirrel can retain
      // a pending update that applies on the next launch. Preserve its source
      // material and make this updater permanently non-retryable.
      if (!handoffStarted && feedPath) await unlink(feedPath).catch(() => undefined)
      if (handoffStarted) throw new TrustedSquirrelUpdateError('failed-closed')
      if (error instanceof TrustedSquirrelUpdateError) throw error
      throw new TrustedSquirrelUpdateError('feed-write-failed')
    } finally {
      await archiveHandle?.close().catch(() => undefined)
    }
  }

  quitAndInstall(): void {
    if (this.state.phase === 'failed-closed') {
      throw new TrustedSquirrelUpdateError('failed-closed')
    }
    if (this.state.phase === 'installing') {
      throw new TrustedSquirrelUpdateError('already-started')
    }
    if (this.state.phase !== 'ready') {
      throw new TrustedSquirrelUpdateError('not-ready')
    }

    const version = this.state.version
    // Consume readiness before crossing the adapter boundary. A synchronous
    // adapter failure must never result in a second install attempt.
    this.state = { phase: 'installing', version }
    try {
      this.options.autoUpdater.quitAndInstall()
    } catch {
      throw new TrustedSquirrelUpdateError('install-start-failed')
    }
  }
}

async function validateStagedArchive(staged: StagedUpdateArchive): Promise<ArchiveIdentity> {
  if (
    !staged ||
    !isCanonicalAbsolutePath(staged.directory) ||
    !isCanonicalAbsolutePath(staged.archivePath) ||
    staged.archivePath !== join(staged.directory, ARCHIVE_NAME) ||
    !Number.isSafeInteger(staged.byteLength) || staged.byteLength < 1 ||
    !/^[0-9a-f]{64}$/.test(staged.sha256)
  ) {
    throw new TrustedSquirrelUpdateError('invalid-request')
  }

  try {
    const [canonicalDirectory, directoryEntry, archiveEntry, archiveInfo] = await Promise.all([
      realpath(staged.directory),
      lstat(staged.directory, { bigint: true }),
      lstat(staged.archivePath, { bigint: true }),
      stat(staged.archivePath, { bigint: true })
    ])
    if (
      canonicalDirectory !== staged.directory ||
      !directoryEntry.isDirectory() || directoryEntry.isSymbolicLink() ||
      !archiveEntry.isFile() || archiveEntry.isSymbolicLink() ||
      archiveInfo.size !== BigInt(staged.byteLength) ||
      (Number(directoryEntry.mode) & 0o077) !== 0 ||
      (Number(archiveEntry.mode) & 0o077) !== 0 ||
      directoryEntry.dev !== archiveEntry.dev ||
      !isOwnedByCurrentUser(directoryEntry.uid) ||
      !isOwnedByCurrentUser(archiveEntry.uid) ||
      await realpath(staged.archivePath) !== staged.archivePath
    ) {
      throw new Error('invalid-stage')
    }
    return archiveIdentity(archiveEntry)
  } catch {
    throw new TrustedSquirrelUpdateError('invalid-request')
  }
}

async function openVerifiedArchive(
  staged: StagedUpdateArchive,
  expected: ArchiveIdentity
): Promise<FileHandle> {
  let handle: FileHandle | undefined
  try {
    handle = await open(
      staged.archivePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    )
    const before = await handle.stat({ bigint: true })
    if (!sameArchiveIdentity(archiveIdentity(before), expected)) {
      throw new Error('archive-changed')
    }
    const digest = await digestArchive(handle, staged.byteLength)
    const after = await handle.stat({ bigint: true })
    if (
      !before.isFile() || !after.isFile() ||
      !sameArchiveIdentity(archiveIdentity(after), expected) ||
      digest !== staged.sha256
    ) {
      throw new Error('archive-changed')
    }
    await assertArchiveBound(staged.archivePath, handle, expected)
    return handle
  } catch {
    await handle?.close().catch(() => undefined)
    throw new TrustedSquirrelUpdateError('invalid-request')
  }
}

async function assertArchiveBound(
  path: string,
  handle: FileHandle,
  expected: ArchiveIdentity
): Promise<void> {
  try {
    const [descriptorEntry, pathEntry, canonicalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path)
    ])
    if (
      canonicalPath !== path || !descriptorEntry.isFile() ||
      !pathEntry.isFile() || pathEntry.isSymbolicLink() ||
      !sameArchiveIdentity(archiveIdentity(descriptorEntry), expected) ||
      !sameArchiveIdentity(archiveIdentity(pathEntry), expected)
    ) {
      throw new Error('archive-changed')
    }
  } catch {
    throw new TrustedSquirrelUpdateError('invalid-request')
  }
}

async function digestArchive(handle: FileHandle, expectedSize: number): Promise<string> {
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(128 * 1024)
  let position = 0
  while (position < expectedSize) {
    const length = Math.min(buffer.byteLength, expectedSize - position)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead <= 0) throw new Error('archive-truncated')
    digest.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  const trailing = await handle.read(buffer, 0, 1, position)
  if (trailing.bytesRead !== 0) throw new Error('archive-grew')
  return digest.digest('hex')
}

function archiveIdentity(entry: BigIntStats): ArchiveIdentity {
  return {
    device: entry.dev,
    inode: entry.ino,
    size: entry.size,
    modifiedNs: entry.mtimeNs,
    changedNs: entry.ctimeNs
  }
}

function sameArchiveIdentity(left: ArchiveIdentity, right: ArchiveIdentity): boolean {
  return left.device === right.device && left.inode === right.inode &&
    left.size === right.size && left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
}

function makeFeed(
  version: string,
  archiveUrl: string,
  staged: StagedUpdateArchive,
  now?: () => Date
): FeedArtifact {
  const sourceDate = now?.() ?? new Date()
  if (!Number.isFinite(sourceDate.getTime())) {
    throw new TrustedSquirrelUpdateError('invalid-request')
  }
  // Squirrel.Mac's NSDateFormatter accepts whole-second ISO 8601 reliably.
  const date = new Date(Math.floor(sourceDate.getTime() / 1_000) * 1_000)
  const publishedAt = date.toISOString().replace('.000Z', 'Z')
  const body = `${JSON.stringify({
    currentRelease: version,
    releases: [{
      version,
      updateTo: {
        version,
        pub_date: publishedAt,
        notes: '',
        name: version,
        url: archiveUrl,
        sha256: staged.sha256,
        size: staged.byteLength
      }
    }]
  })}\n`
  const bytes = new TextEncoder().encode(body)
  if (bytes.byteLength > MAX_FEED_BYTES) throw new TrustedSquirrelUpdateError('invalid-request')
  return { bytes, releaseDate: date }
}

async function writeFeedAtomically(
  directory: string,
  feedPath: string,
  bytes: Uint8Array
): Promise<void> {
  const temporaryPath = join(directory, `.squirrel-feed-${randomUUID()}.tmp`)
  let file: FileHandle | undefined
  let directoryHandle: FileHandle | undefined
  try {
    file = await open(temporaryPath, 'wx', 0o600)
    await file.chmod(0o600)
    await file.writeFile(bytes)
    await file.sync()
    await file.close()
    file = undefined

    await rename(temporaryPath, feedPath)
    directoryHandle = await open(directory, 'r')
    await directoryHandle.sync()
    await directoryHandle.close()
    directoryHandle = undefined
  } catch {
    await file?.close().catch(() => undefined)
    await directoryHandle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    await unlink(feedPath).catch(() => undefined)
    throw new TrustedSquirrelUpdateError('feed-write-failed')
  }
}

interface DownloadExpectation {
  feedUrl: string
  archiveUrl: string
  expectedVersion: string
  expectedReleaseDate: Date
  timeoutMs: number
  onHandoff: () => void
}

async function waitForDownloadedUpdate(
  autoUpdater: SquirrelAutoUpdaterAdapter,
  expectation: DownloadExpectation
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let handoffMarked = false
    let acceptEvents = false
    let preCheckEvent = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const downloaded: SquirrelUpdateListener = (...args) => {
      if (!acceptEvents) {
        preCheckEvent = true
        return
      }
      const releaseName = args[2]
      if (releaseName !== expectation.expectedVersion) {
        settle(new TrustedSquirrelUpdateError('version-mismatch'))
        return
      }
      const releaseNotes = args[1]
      const releaseDate = args[3]
      const updateUrl = args[4]
      if (
        releaseNotes !== '' || !(releaseDate instanceof Date) ||
        releaseDate.getTime() !== expectation.expectedReleaseDate.getTime() ||
        updateUrl !== expectation.archiveUrl || !hasExpectedFeed()
      ) {
        settle(new TrustedSquirrelUpdateError('artifact-mismatch'))
        return
      }
      settle()
    }
    const unavailable: SquirrelUpdateListener = () => {
      if (!acceptEvents) {
        preCheckEvent = true
        return
      }
      settle(new TrustedSquirrelUpdateError('update-not-available'))
    }
    const failed: SquirrelUpdateListener = () => {
      if (!acceptEvents) {
        preCheckEvent = true
        return
      }
      settle(new TrustedSquirrelUpdateError('check-failed'))
    }
    const listeners = [
      ['update-downloaded', downloaded],
      ['update-not-available', unavailable],
      ['error', failed]
    ] as const satisfies ReadonlyArray<readonly [SquirrelUpdateEvent, SquirrelUpdateListener]>

    function cleanup(): void {
      if (timeout) clearTimeout(timeout)
      for (const [event, listener] of listeners) {
        try {
          autoUpdater.removeListener(event, listener)
        } catch {
          // Listener cleanup cannot reveal adapter failures or replace the
          // fixed outcome already selected by settle().
        }
      }
    }

    function hasExpectedFeed(): boolean {
      try {
        return autoUpdater.getFeedURL() === expectation.feedUrl
      } catch {
        return false
      }
    }

    function markHandoff(): void {
      if (handoffMarked) return
      handoffMarked = true
      expectation.onHandoff()
    }

    function settle(error?: TrustedSquirrelUpdateError): void {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }

    try {
      for (const [event, listener] of listeners) autoUpdater.on(event, listener)
      timeout = setTimeout(() => {
        settle(new TrustedSquirrelUpdateError('timeout'))
      }, expectation.timeoutMs)
      autoUpdater.setFeedURL({ url: expectation.feedUrl, serverType: 'json' })
      if (preCheckEvent) {
        // A stale updater event during feed replacement proves there is
        // already updater state we cannot safely classify.
        markHandoff()
        settle(new TrustedSquirrelUpdateError('artifact-mismatch'))
        return
      }
      const expectedFeedRetained = hasExpectedFeed()
      if (preCheckEvent) {
        markHandoff()
        settle(new TrustedSquirrelUpdateError('artifact-mismatch'))
        return
      }
      if (!expectedFeedRetained) {
        settle(new TrustedSquirrelUpdateError('artifact-mismatch'))
        return
      }
      markHandoff()
      acceptEvents = true
      const check = autoUpdater.checkForUpdates()
      if (isPromiseLike(check)) {
        void Promise.resolve(check).catch(() => {
          settle(new TrustedSquirrelUpdateError('check-failed'))
        })
      }
    } catch {
      if (preCheckEvent) markHandoff()
      settle(new TrustedSquirrelUpdateError('check-failed'))
    }
  })
}

interface ParsedVersion {
  normalized: string
  components: readonly [number, number, number]
}

function parseVersion(value: string): ParsedVersion {
  if (typeof value !== 'string' || value.length > 128 || value !== value.trim()) {
    throw new TrustedSquirrelUpdateError('invalid-request')
  }
  const match = /^[vV]?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(value)
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new TrustedSquirrelUpdateError('invalid-request')
  }
  const components = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  return { normalized: components.join('.'), components }
}

function compareParsedVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

function isCanonicalAbsolutePath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && path.length <= MAX_PATH_LENGTH &&
    !path.includes('\0') && isAbsolute(path) && resolve(path) === path
}

function isOwnedByCurrentUser(uid: bigint): boolean {
  return typeof process.getuid !== 'function' || uid === BigInt(process.getuid())
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value && (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new TrustedSquirrelUpdateError('invalid-request')
  }
  return value
}

function validateAdapter(adapter: SquirrelAutoUpdaterAdapter): void {
  if (
    !adapter ||
    typeof adapter.setFeedURL !== 'function' ||
    typeof adapter.getFeedURL !== 'function' ||
    typeof adapter.checkForUpdates !== 'function' ||
    typeof adapter.quitAndInstall !== 'function' ||
    typeof adapter.on !== 'function' ||
    typeof adapter.removeListener !== 'function'
  ) {
    throw new TrustedSquirrelUpdateError('invalid-request')
  }
}

function updateErrorMessage(code: TrustedSquirrelUpdateErrorCode): string {
  switch (code) {
    case 'invalid-request': return 'The prepared app update is invalid.'
    case 'busy': return 'Another app update operation is already in progress.'
    case 'feed-write-failed': return 'The local app update feed could not be prepared safely.'
    case 'check-failed': return 'The app update check could not be completed safely.'
    case 'update-not-available': return 'The prepared app update was not accepted.'
    case 'version-mismatch': return 'The downloaded app update version did not match.'
    case 'artifact-mismatch': return 'The downloaded app update did not match the prepared update.'
    case 'timeout': return 'The app update check timed out.'
    case 'failed-closed': return 'The app updater is in an indeterminate terminal state.'
    case 'not-ready': return 'No app update is ready to install.'
    case 'already-started': return 'The app update installation was already started.'
    case 'install-start-failed': return 'The app update restart could not be started.'
  }
}
