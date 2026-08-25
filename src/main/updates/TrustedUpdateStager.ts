import { createHash, timingSafeEqual } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink
} from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_REDIRECTS = 4
const STAGED_DIRECTORY_PATTERN = /^grokbuild-update-[A-Za-z0-9]{6}$/
const SQUIRREL_FEED_TEMP_PATTERN =
  /^\.squirrel-feed-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/
const STALE_STAGE_REGULAR_FILES = new Set(['update.app.zip', 'releases.json'])
const GITHUB_REDIRECT_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com'
])

export type TrustedUpdateStageErrorCode =
  | 'invalid-request'
  | 'busy'
  | 'download-failed'
  | 'download-too-large'
  | 'digest-mismatch'

export class TrustedUpdateStageError extends Error {
  constructor(readonly code: TrustedUpdateStageErrorCode) {
    super(stageErrorMessage(code))
    this.name = 'TrustedUpdateStageError'
  }
}

export interface TrustedUpdateStageRequest {
  downloadUrl: string
  expectedDigest: string
  expectedSize?: number
}

export interface StagedUpdateArchive {
  directory: string
  archivePath: string
  byteLength: number
  sha256: string
}

export interface TrustedUpdateStagerOptions {
  stagingRoot: string
  fetchImpl?: typeof fetch
  maximumBytes?: number
  timeoutMs?: number
}

export interface StaleUpdateStageCleanupResult {
  removed: number
  skipped: number
  failed: number
}

/**
 * Main-only download boundary. A staged archive is inert: this class never
 * extracts, executes, signs, installs, swaps, or restarts anything.
 */
export class TrustedUpdateStager {
  private readonly fetchImpl: typeof fetch
  private readonly maximumBytes: number
  private readonly timeoutMs: number
  private readonly ownedDirectories = new Set<string>()
  private active = false

  constructor(private readonly options: TrustedUpdateStagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maximumBytes = boundedPositive(options.maximumBytes, DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES)
    this.timeoutMs = boundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, 5 * 60_000)
  }

  async stage(request: TrustedUpdateStageRequest): Promise<StagedUpdateArchive> {
    if (this.active) throw new TrustedUpdateStageError('busy')
    this.active = true
    try {
      return await this.stageExclusive(request)
    } finally {
      this.active = false
    }
  }

  private async stageExclusive(request: TrustedUpdateStageRequest): Promise<StagedUpdateArchive> {
    const initialUrl = validatedDownloadUrl(request.downloadUrl)
    const expectedDigest = parseDigest(request.expectedDigest)
    const expectedSize = request.expectedSize === undefined
      ? undefined
      : boundedPositive(request.expectedSize, 0, this.maximumBytes)
    const root = await canonicalStagingRoot(this.options.stagingRoot)
    const directory = await mkdtemp(join(root, 'grokbuild-update-'))
    this.ownedDirectories.add(directory)
    const archivePath = join(directory, 'update.app.zip')
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), this.timeoutMs)
    let handle: Awaited<ReturnType<typeof open>> | undefined

    try {
      const response = await fetchBoundedRedirects(
        this.fetchImpl,
        initialUrl,
        abort.signal
      )
      if (!response.ok || !response.body) throw new TrustedUpdateStageError('download-failed')
      const declaredLength = parsedContentLength(response.headers.get('content-length'))
      if (declaredLength !== undefined && declaredLength > this.maximumBytes) {
        throw new TrustedUpdateStageError('download-too-large')
      }
      if (expectedSize !== undefined && declaredLength !== undefined && declaredLength !== expectedSize) {
        throw new TrustedUpdateStageError('download-failed')
      }

      handle = await open(archivePath, 'wx', 0o600)
      const reader = response.body.getReader()
      const digest = createHash('sha256')
      let byteLength = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          if (!chunk.value || chunk.value.byteLength === 0) continue
          byteLength += chunk.value.byteLength
          if (byteLength > this.maximumBytes) {
            await reader.cancel().catch(() => undefined)
            throw new TrustedUpdateStageError('download-too-large')
          }
          digest.update(chunk.value)
          await writeAll(handle, chunk.value)
        }
      } finally {
        reader.releaseLock()
      }
      if (byteLength === 0 || (expectedSize !== undefined && byteLength !== expectedSize)) {
        throw new TrustedUpdateStageError('download-failed')
      }
      await handle.sync()
      await handle.close()
      handle = undefined
      const actualDigest = digest.digest()
      if (!timingSafeEqual(actualDigest, expectedDigest)) {
        throw new TrustedUpdateStageError('digest-mismatch')
      }
      return {
        directory,
        archivePath,
        byteLength,
        sha256: actualDigest.toString('hex')
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await this.removeOwnedDirectory(directory)
      if (error instanceof TrustedUpdateStageError) throw error
      throw new TrustedUpdateStageError('download-failed')
    } finally {
      clearTimeout(timeout)
    }
  }

  async discard(staged: StagedUpdateArchive): Promise<void> {
    if (basename(staged.archivePath) !== 'update.app.zip') return
    if (staged.archivePath !== join(staged.directory, 'update.app.zip')) return
    await this.removeOwnedDirectory(staged.directory)
  }

  /**
   * Removes only stale directories from an earlier process. The dedicated
   * staging root, exact mkdtemp name, same-user ownership, private mode,
   * same-device placement, and canonical direct-child path must all match.
   * Directories owned by this live stager are never considered stale.
   */
  async cleanupStale(): Promise<StaleUpdateStageCleanupResult> {
    if (this.active) throw new TrustedUpdateStageError('busy')
    this.active = true
    try {
      const root = await canonicalStagingRoot(this.options.stagingRoot)
      const rootEntry = await lstat(root)
      let removed = 0
      let skipped = 0
      let failed = 0

      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!STAGED_DIRECTORY_PATTERN.test(entry.name)) continue
        const directory = join(root, entry.name)
        if (this.ownedDirectories.has(directory)) {
          skipped += 1
          continue
        }

        try {
          const before = await lstat(directory)
          if (
            !before.isDirectory() || before.isSymbolicLink() ||
            before.dev !== rootEntry.dev ||
            !isOwnedPrivatePath(before) ||
            await realpath(directory) !== directory
          ) {
            skipped += 1
            continue
          }
          const contents = await safeStaleContents(directory, rootEntry.dev)
          if (contents === undefined) {
            skipped += 1
            continue
          }

          // Narrow the replacement window before deleting only whitelisted
          // regular files. The identity comparison refuses a directory or
          // staging root exchanged after inspection.
          const confirmed = await lstat(directory)
          const confirmedRoot = await lstat(root)
          const confirmedContents = await safeStaleContents(directory, rootEntry.dev)
          if (
            !sameRootIdentity(rootEntry, confirmedRoot) ||
            await realpath(root) !== root ||
            !sameDirectoryIdentity(before, confirmed) ||
            confirmedContents === undefined ||
            contents.length !== confirmedContents.length ||
            contents.some((name, index) => name !== confirmedContents[index])
          ) {
            skipped += 1
            continue
          }
          // Delete only the already validated regular files, then remove the
          // now-empty directory. If any unknown entry appears after inspection,
          // rmdir fails closed instead of recursively descending into it.
          for (const name of confirmedContents) await unlink(join(directory, name))
          await rmdir(directory)
          removed += 1
        } catch {
          failed += 1
        }
      }
      return Object.freeze({ removed, skipped, failed })
    } finally {
      this.active = false
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.ownedDirectories].map((directory) =>
      this.removeOwnedDirectory(directory)
    ))
  }

  private async removeOwnedDirectory(directory: string): Promise<void> {
    if (!this.ownedDirectories.has(directory)) return
    await rm(directory, { recursive: true, force: true })
    this.ownedDirectories.delete(directory)
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (result.bytesWritten <= 0) throw new TrustedUpdateStageError('download-failed')
    offset += result.bytesWritten
  }
}

async function fetchBoundedRedirects(
  fetchImpl: typeof fetch,
  initialUrl: URL,
  signal: AbortSignal
): Promise<Response> {
  const allowedHosts = new Set([initialUrl.hostname])
  if (GITHUB_REDIRECT_HOSTS.has(initialUrl.hostname)) {
    for (const host of GITHUB_REDIRECT_HOSTS) allowedHosts.add(host)
  }
  let current = initialUrl
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { accept: 'application/octet-stream' }
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    if (redirects === MAX_REDIRECTS) throw new TrustedUpdateStageError('download-failed')
    const location = response.headers.get('location')
    if (!location) throw new TrustedUpdateStageError('download-failed')
    const next = validatedDownloadUrl(new URL(location, current).toString())
    if (!allowedHosts.has(next.hostname)) throw new TrustedUpdateStageError('download-failed')
    current = next
  }
  throw new TrustedUpdateStageError('download-failed')
}

async function canonicalStagingRoot(path: string): Promise<string> {
  if (
    !path || path.length > 4_096 || path.includes('\0') ||
    !isAbsolute(path) || resolve(path) !== path
  ) throw new TrustedUpdateStageError('invalid-request')
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const canonical = await realpath(path)
    const entry = await lstat(path)
    if (
      canonical !== path || !entry.isDirectory() || entry.isSymbolicLink() ||
      !isOwnedPrivatePath(entry)
    ) throw new Error('unsafe-directory')
    return canonical
  } catch {
    throw new TrustedUpdateStageError('invalid-request')
  }
}

function isOwnedPrivatePath(entry: Stats): boolean {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : entry.uid
  return entry.uid === currentUid && (entry.mode & 0o077) === 0
}

function sameDirectoryIdentity(
  left: Stats,
  right: Stats
): boolean {
  return right.isDirectory() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.mode === right.mode && left.ctimeMs === right.ctimeMs
}

function sameRootIdentity(left: Stats, right: Stats): boolean {
  return right.isDirectory() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.mode === right.mode
}

async function safeStaleContents(
  directory: string,
  rootDevice: number
): Promise<readonly string[] | undefined> {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length > 3) return undefined
  let temporaryFeedCount = 0
  const names = entries.map((entry) => entry.name).sort()
  for (const name of names) {
    const allowedRegularFile = STALE_STAGE_REGULAR_FILES.has(name)
    const temporaryFeed = SQUIRREL_FEED_TEMP_PATTERN.test(name)
    if (!allowedRegularFile && !temporaryFeed) return undefined
    if (temporaryFeed && ++temporaryFeedCount > 1) return undefined
    const path = join(directory, name)
    const metadata = await lstat(path)
    if (
      !metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.dev !== rootDevice || !isOwnedPrivatePath(metadata) ||
      await realpath(path) !== path
    ) return undefined
  }
  return names
}

function validatedDownloadUrl(value: string): URL {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' || url.username || url.password || url.port ||
      isUnsafeHost(url.hostname) || url.hash
    ) throw new Error('unsafe-url')
    return url
  } catch {
    throw new TrustedUpdateStageError('invalid-request')
  }
}

function isUnsafeHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return normalized === 'localhost' || normalized.endsWith('.local') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) ||
    normalized.includes(':')
}

function parseDigest(value: string): Buffer {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(value)
  if (!match?.[1]) throw new TrustedUpdateStageError('invalid-request')
  return Buffer.from(match[1], 'hex')
}

function parsedContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TrustedUpdateStageError('invalid-request')
  }
  return value
}

function stageErrorMessage(code: TrustedUpdateStageErrorCode): string {
  switch (code) {
    case 'invalid-request': return 'The update download request is invalid.'
    case 'busy': return 'Another app update operation is already in progress.'
    case 'download-failed': return 'The app update could not be downloaded safely.'
    case 'download-too-large': return 'The app update download exceeded its size limit.'
    case 'digest-mismatch': return 'The app update failed its SHA-256 integrity check.'
  }
}
