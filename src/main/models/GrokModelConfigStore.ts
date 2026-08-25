import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, type BigIntStats, type Stats } from 'node:fs'
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  ManagedTomlError,
  parseManagedToml,
  rewriteManagedToml,
  type ManagedModelCatalog,
  type ManagedModelConfigMutation
} from './managedToml'
import {
  DEFAULT_ADVISORY_LOCK_TIMEOUT_MS,
  MacOsAdvisoryLockRunner,
  type AdvisoryLockRunner
} from './MacOsAdvisoryLockRunner'

export const MAX_GROK_CONFIG_BYTES = 1024 * 1024

const MISSING_REVISION = revisionOfMissingPath()

export type GrokModelConfigInvalidReason =
  | 'malformed'
  | 'managed-block'
  | 'non-regular'
  | 'symlink'
  | 'hardlink'
  | 'owner'
  | 'permissions'
  | 'oversize'
  | 'unreadable'

export interface GrokModelConfigSnapshot {
  /** Opaque optimistic-concurrency token; it contains no configuration bytes. */
  revision: string
  catalog: ManagedModelCatalog
}

export type GrokModelConfigLoadResult =
  | {
      status: 'ready'
      source: 'missing' | 'unmanaged' | 'managed'
      snapshot: GrokModelConfigSnapshot
    }
  | {
      status: 'invalid'
      reason: GrokModelConfigInvalidReason
    }

export type GrokModelConfigStoreErrorCode =
  | 'invalid-config'
  | 'revision-conflict'
  | 'invalid-mutation'
  | 'provider-in-use'
  | 'persist-failed'

export class GrokModelConfigStoreError extends Error {
  constructor(readonly code: GrokModelConfigStoreErrorCode) {
    super(storeErrorMessage(code))
    this.name = 'GrokModelConfigStoreError'
  }
}

export interface GrokModelConfigStoreOptions {
  /** Test seam immediately before the path snapshot CAS. */
  beforeIdentityCheck?: (() => Promise<void>) | undefined
  /** Test seam while the cross-instance lock is held, followed by a second CAS. */
  afterIdentityCheck?: (() => Promise<void>) | undefined
  /** Test seam for the main-owned OS advisory lock boundary. */
  advisoryLockRunner?: AdvisoryLockRunner | undefined
}

/**
 * Main-process-only targeted store for Grok's config.toml.
 *
 * The renderer must never choose this path. Production construction should use
 * a main-owned canonical `GROK_HOME`/home location. Reads bind the parent
 * directory identity, reject aliases/hardlinks/foreign or writable entries,
 * and return only parsed managed records. Writes retain every unmanaged byte,
 * coordinate separate Store instances with a same-directory lease, compare the
 * complete file digest before rename, fsync both file and directory, and verify
 * the committed bytes. A non-cooperating same-UID process can still race the
 * final rename syscall; Node exposes no portable rename-if-unchanged primitive.
 */
export class GrokModelConfigStore {
  private operationTail: Promise<void> = Promise.resolve()
  private boundLocationPromise: Promise<BoundConfigLocation> | undefined
  private readonly requestedPath: string
  private readonly beforeIdentityCheck: (() => Promise<void>) | undefined
  private readonly afterIdentityCheck: (() => Promise<void>) | undefined
  private readonly advisoryLockRunner: AdvisoryLockRunner
  private readonly lockAbortControllers = new Set<AbortController>()
  private stopped = false

  constructor(path: string, options: GrokModelConfigStoreOptions = {}) {
    this.requestedPath = resolve(path)
    this.beforeIdentityCheck = options.beforeIdentityCheck
    this.afterIdentityCheck = options.afterIdentityCheck
    this.advisoryLockRunner = options.advisoryLockRunner ?? new MacOsAdvisoryLockRunner()
  }

  load(): Promise<GrokModelConfigLoadResult> {
    return this.enqueue(async () => {
      try {
        return await this.withExclusiveLock(async (location) =>
          cloneLoadResult(await this.readAt(location)))
      } catch {
        return { status: 'invalid', reason: 'unreadable' }
      }
    })
  }

  mutate(
    expectedRevision: string,
    mutation: ManagedModelConfigMutation
  ): Promise<GrokModelConfigSnapshot> {
    return this.enqueue(async () => {
      try {
        return await this.withExclusiveLock(async (location) => {
          if (!/^[a-f0-9]{64}$/u.test(expectedRevision)) {
            throw new GrokModelConfigStoreError('revision-conflict')
          }
          const loaded = await this.readAt(location)
          if (loaded.status !== 'ready') {
            throw new GrokModelConfigStoreError('invalid-config')
          }
          if (loaded.snapshot.revision !== expectedRevision) {
            throw new GrokModelConfigStoreError('revision-conflict')
          }

          let rewritten: ReturnType<typeof rewriteManagedToml>
          try {
            rewritten = rewriteManagedToml(loaded.text, mutation)
          } catch (error) {
            throw mapManagedTomlMutationError(error)
          }
          if (!rewritten.changed) return cloneSnapshot(loaded.snapshot)

          const bytes = Buffer.from(rewritten.text, 'utf8')
          if (bytes.byteLength > MAX_GROK_CONFIG_BYTES) {
            throw new GrokModelConfigStoreError('persist-failed')
          }
          await this.write(location, bytes, loaded.pathSnapshot)
          return {
            revision: revisionOfEntry(bytes),
            catalog: structuredClone(rewritten.catalog)
          }
        })
      } catch (error) {
        if (error instanceof GrokModelConfigStoreError) throw error
        throw new GrokModelConfigStoreError('persist-failed')
      }
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const controller of this.lockAbortControllers) controller.abort()
    await this.operationTail
  }

  private async readAt(location: BoundConfigLocation): Promise<InternalLoadResult> {
    await assertBoundParent(location)
    const file = await readConfigFile(location.configPath)
    await assertBoundParent(location)
    if (file.status === 'missing') {
      return {
        status: 'ready',
        source: 'missing',
        snapshot: { revision: MISSING_REVISION, catalog: { providers: [], models: [] } },
        text: '',
        pathSnapshot: { kind: 'missing', revision: MISSING_REVISION }
      }
    }
    if (file.status === 'invalid') return file

    let text: string
    try {
      // Preserve a leading BOM as data so the TOML validator can reject it;
      // silently stripping it would make a later write alter unmanaged bytes.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes)
    } catch {
      return { status: 'invalid', reason: 'malformed', identity: file.identity }
    }
    try {
      const parsed = parseManagedToml(text)
      const revision = revisionOfEntry(file.bytes)
      return {
        status: 'ready',
        source: parsed.hasManagedEnvelope ? 'managed' : 'unmanaged',
        snapshot: { revision, catalog: structuredClone(parsed.catalog) },
        text,
        pathSnapshot: { kind: 'entry', identity: file.identity, revision }
      }
    } catch (error) {
      return {
        status: 'invalid',
        reason: error instanceof ManagedTomlError && error.code !== 'malformed-toml'
          ? 'managed-block'
          : 'malformed',
        identity: file.identity
      }
    }
  }

  private async write(
    location: BoundConfigLocation,
    bytes: Uint8Array,
    expected: ConfigPathSnapshot
  ): Promise<void> {
    const temporaryPath = join(
      location.parentPath,
      `.${basename(location.configPath)}.${process.pid}.${randomUUID()}.tmp`
    )
    let handle: FileHandle | undefined
    let temporarySnapshot: Extract<ConfigPathSnapshot, { kind: 'entry' }> | undefined
    try {
      await assertBoundParent(location)
      handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600
      )
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.chmod(0o600)
      const temporaryIdentity = identityFromStats(await handle.stat())
      temporarySnapshot = {
        kind: 'entry',
        identity: temporaryIdentity,
        revision: revisionOfEntry(bytes)
      }
      await handle.close()
      handle = undefined

      await this.beforeIdentityCheck?.()
      await assertBoundParent(location)
      await assertPathSnapshot(location.configPath, expected)
      await this.afterIdentityCheck?.()
      await assertBoundParent(location)
      // The second digest comparison also protects the test seam and narrows
      // the unavoidable check-to-rename window for non-cooperating writers.
      await assertPathSnapshot(location.configPath, expected)
      await assertPathSnapshot(temporaryPath, temporarySnapshot)
      await rename(temporaryPath, location.configPath)
      await syncBoundParent(location)
      await assertCommittedBytes(location.configPath, bytes)
    } finally {
      await handle?.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  private async withExclusiveLock<T>(
    operation: (location: BoundConfigLocation) => Promise<T>
  ): Promise<T> {
    if (this.stopped) throw new Error('Model configuration store is stopped')
    const location = await this.boundLocation()
    const controller = new AbortController()
    this.lockAbortControllers.add(controller)
    let lease: ConfigLockLease
    try {
      lease = await acquireConfigLock(location, this.advisoryLockRunner, controller.signal)
    } finally {
      this.lockAbortControllers.delete(controller)
    }
    try {
      if (this.stopped) throw new Error('Model configuration store is stopped')
      await assertBoundParent(location)
      await assertConfigLockLease(location, lease)
      const result = await operation(location)
      await assertConfigLockLease(location, lease)
      return result
    } finally {
      await lease.handle.close().catch(() => undefined)
    }
  }

  private async boundLocation(): Promise<BoundConfigLocation> {
    this.boundLocationPromise ??= bindConfigLocation(this.requestedPath)
    const location = await this.boundLocationPromise
    await assertBoundParent(location)
    return location
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

interface ParentDirectoryIdentity {
  device: bigint
  inode: bigint
  owner: bigint
  mode: bigint
}

interface BoundConfigLocation {
  parentPath: string
  configPath: string
  lockPath: string
  parentIdentity: ParentDirectoryIdentity
}

interface ConfigLockLease {
  handle: FileHandle
  identity: ConfigFileIdentity
}

interface ConfigFileIdentity {
  device: number
  inode: number
  size: number
  modifiedMs: number
  changedMs: number
  links: number
  owner: number
  mode: number
}

type ConfigPathSnapshot =
  | { kind: 'missing'; revision: string }
  | { kind: 'entry'; identity: ConfigFileIdentity; revision: string }

type InternalLoadResult =
  | (Extract<GrokModelConfigLoadResult, { status: 'ready' }> & {
      text: string
      pathSnapshot: ConfigPathSnapshot
    })
  | (Extract<GrokModelConfigLoadResult, { status: 'invalid' }> & {
      identity?: ConfigFileIdentity | undefined
    })

type ConfigFileReadResult =
  | { status: 'missing' }
  | { status: 'ready'; bytes: Uint8Array; identity: ConfigFileIdentity }
  | {
      status: 'invalid'
      reason: GrokModelConfigInvalidReason
      identity?: ConfigFileIdentity | undefined
    }

async function bindConfigLocation(requestedPath: string): Promise<BoundConfigLocation> {
  const requestedParent = dirname(requestedPath)
  const parentPath = await realpath(requestedParent)
  if (comparableCanonicalPath(requestedParent) !== comparableCanonicalPath(parentPath)) {
    throw new Error('Configuration parent aliases are not allowed')
  }
  const stats = await lstat(parentPath, { bigint: true })
  assertSafeParentStats(stats)
  const location: BoundConfigLocation = {
    parentPath,
    configPath: join(parentPath, basename(requestedPath)),
    lockPath: join(parentPath, `.${basename(requestedPath)}.grokbuild-electron.lock`),
    parentIdentity: {
      device: stats.dev,
      inode: stats.ino,
      owner: stats.uid,
      mode: stats.mode & 0o777n
    }
  }
  await assertBoundParent(location)
  return location
}

async function assertBoundParent(location: BoundConfigLocation): Promise<void> {
  const before = await lstat(location.parentPath, { bigint: true })
  assertSafeParentStats(before)
  if (!sameParentIdentity(before, location.parentIdentity)) {
    throw new Error('Bound configuration parent identity changed')
  }
  if (await realpath(location.parentPath) !== location.parentPath) {
    throw new Error('Bound configuration parent is no longer canonical')
  }
  const after = await lstat(location.parentPath, { bigint: true })
  assertSafeParentStats(after)
  if (!sameParentIdentity(after, location.parentIdentity) ||
      before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Bound configuration parent identity changed')
  }
}

function assertSafeParentStats(stats: BigIntStats): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Configuration parent is not a canonical directory')
  }
  const expectedOwner = currentOwner()
  if (expectedOwner !== undefined && stats.uid !== BigInt(expectedOwner)) {
    throw new Error('Configuration parent owner is invalid')
  }
  if ((stats.mode & 0o022n) !== 0n) {
    throw new Error('Configuration parent permissions are unsafe')
  }
}

function sameParentIdentity(
  stats: BigIntStats,
  expected: ParentDirectoryIdentity
): boolean {
  return stats.dev === expected.device && stats.ino === expected.inode &&
    stats.uid === expected.owner && (stats.mode & 0o777n) === expected.mode
}

function comparableCanonicalPath(path: string): string {
  const normalized = resolve(path).normalize('NFC')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

async function readConfigFile(path: string): Promise<ConfigFileReadResult> {
  let entry: Awaited<ReturnType<typeof lstat>>
  try {
    entry = await lstat(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'invalid', reason: 'unreadable' }
  }
  const entryIdentity = identityFromStats(entry)
  const unsafeReason = unsafeFileReason(entry)
  if (unsafeReason) return { status: 'invalid', reason: unsafeReason, identity: entryIdentity }

  let handle: FileHandle | undefined
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    const opened = await handle.stat()
    const openedIdentity = identityFromStats(opened)
    if (!sameFileIdentity(entryIdentity, openedIdentity)) {
      return { status: 'invalid', reason: 'unreadable', identity: openedIdentity }
    }
    const openedUnsafeReason = unsafeFileReason(opened)
    if (openedUnsafeReason) {
      return { status: 'invalid', reason: openedUnsafeReason, identity: openedIdentity }
    }
    const bytes = await readBounded(handle, MAX_GROK_CONFIG_BYTES)
    const afterRead = identityFromStats(await handle.stat())
    if (!sameFileIdentity(openedIdentity, afterRead)) {
      return { status: 'invalid', reason: 'unreadable', identity: afterRead }
    }
    return bytes
      ? { status: 'ready', bytes, identity: afterRead }
      : { status: 'invalid', reason: 'oversize', identity: afterRead }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 'missing' }
    if (code === 'ELOOP') return { status: 'invalid', reason: 'symlink', identity: entryIdentity }
    return { status: 'invalid', reason: 'unreadable' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function unsafeFileReason(stats: Stats): GrokModelConfigInvalidReason | undefined {
  if (stats.isSymbolicLink()) return 'symlink'
  if (!stats.isFile()) return 'non-regular'
  if (stats.nlink !== 1) return 'hardlink'
  const expectedOwner = currentOwner()
  if (expectedOwner !== undefined && stats.uid !== expectedOwner) return 'owner'
  if ((stats.mode & 0o022) !== 0) return 'permissions'
  if (stats.size > MAX_GROK_CONFIG_BYTES) return 'oversize'
  return undefined
}

async function assertPathSnapshot(path: string, expected: ConfigPathSnapshot): Promise<void> {
  const current = await readConfigFile(path)
  if (expected.kind === 'missing') {
    if (current.status !== 'missing') throw new Error('Configuration path changed')
    return
  }
  if (current.status !== 'ready' ||
      !sameFileIdentity(current.identity, expected.identity) ||
      revisionOfEntry(current.bytes) !== expected.revision) {
    throw new Error('Configuration path changed')
  }
}

async function assertCommittedBytes(path: string, expectedBytes: Uint8Array): Promise<void> {
  const current = await readConfigFile(path)
  if (current.status !== 'ready' ||
      revisionOfEntry(current.bytes) !== revisionOfEntry(expectedBytes)) {
    throw new Error('Committed configuration verification failed')
  }
}

async function acquireConfigLock(
  location: BoundConfigLocation,
  runner: AdvisoryLockRunner,
  signal: AbortSignal
): Promise<ConfigLockLease> {
  const lease = await openPersistentConfigLock(location)
  try {
    await runner.acquire({
      fd: lease.handle.fd,
      timeoutMs: DEFAULT_ADVISORY_LOCK_TIMEOUT_MS,
      signal
    })
    await assertBoundParent(location)
    await assertConfigLockLease(location, lease)
    return lease
  } catch (error) {
    await lease.handle.close().catch(() => undefined)
    throw error
  }
}

async function openPersistentConfigLock(
  location: BoundConfigLocation
): Promise<ConfigLockLease> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assertBoundParent(location)
    let entry: Stats | undefined
    try {
      entry = await lstat(location.lockPath, { bigint: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    let handle: FileHandle | undefined
    let created = false
    try {
      if (entry) {
        assertSafePersistentLockStats(entry)
        handle = await open(
          location.lockPath,
          fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
        )
      } else {
        assertCreationUmask()
        try {
          handle = await open(
            location.lockPath,
            fsConstants.O_RDWR |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              fsConstants.O_NOFOLLOW |
              fsConstants.O_NONBLOCK,
            0o600
          )
          created = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw error
        }
      }

      const openedStats = await handle.stat({ bigint: false })
      assertSafePersistentLockStats(openedStats)
      const openedIdentity = identityFromStats(openedStats)
      if (entry && !sameFileIdentity(identityFromStats(entry), openedIdentity)) {
        throw new Error('Persistent configuration lock identity changed')
      }
      await assertBoundParent(location)
      await assertPersistentLockPath(location, openedIdentity)

      if (created) {
        await handle.sync()
        await syncBoundParent(location)
        await assertPersistentLockPath(location, openedIdentity)
      }
      return { handle, identity: openedIdentity }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  throw new Error('Persistent configuration lock could not be opened safely')
}

async function assertConfigLockLease(
  location: BoundConfigLocation,
  lease: ConfigLockLease
): Promise<void> {
  const heldStats = await lease.handle.stat({ bigint: false })
  assertSafePersistentLockStats(heldStats)
  const heldIdentity = identityFromStats(heldStats)
  if (!sameFileIdentity(heldIdentity, lease.identity)) {
    throw new Error('Persistent configuration lock changed while held')
  }
  await assertPersistentLockPath(location, lease.identity)
}

async function assertPersistentLockPath(
  location: BoundConfigLocation,
  expected: ConfigFileIdentity
): Promise<void> {
  const entry = await lstat(location.lockPath, { bigint: false })
  assertSafePersistentLockStats(entry)
  if (!sameFileIdentity(identityFromStats(entry), expected)) {
    throw new Error('Persistent configuration lock path identity changed')
  }
}

function assertSafePersistentLockStats(stats: Stats): void {
  const expectedOwner = currentOwner()
  if (expectedOwner === undefined || stats.isSymbolicLink() || !stats.isFile() ||
      stats.nlink !== 1 || stats.uid !== expectedOwner || stats.size !== 0 ||
      (stats.mode & 0o777) !== 0o600) {
    throw new Error('Persistent configuration lock is unsafe')
  }
}

function assertCreationUmask(): void {
  const mask = process.umask()
  if ((0o600 & (~mask & 0o777)) !== 0o600) {
    throw new Error('Process umask cannot create a safe configuration lock')
  }
}

async function syncBoundParent(location: BoundConfigLocation): Promise<void> {
  await assertBoundParent(location)
  let handle: FileHandle | undefined
  try {
    handle = await open(
      location.parentPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    )
    const stats = await handle.stat({ bigint: true })
    if (!stats.isDirectory() ||
        stats.dev !== location.parentIdentity.device ||
        stats.ino !== location.parentIdentity.inode) {
      throw new Error('Bound configuration parent identity changed')
    }
    await handle.sync()
  } finally {
    await handle?.close().catch(() => undefined)
  }
  await assertBoundParent(location)
}

async function readBounded(handle: FileHandle, maximum: number): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= maximum) {
    const remaining = maximum + 1 - total
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    total += bytesRead
    chunks.push(buffer.subarray(0, bytesRead))
  }
  if (total > maximum) return undefined
  return Buffer.concat(chunks, total)
}

function identityFromStats(stats: {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  nlink: number
  uid: number
  mode: number
}): ConfigFileIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedMs: stats.mtimeMs,
    changedMs: stats.ctimeMs,
    links: stats.nlink,
    owner: stats.uid,
    mode: stats.mode & 0o777
  }
}

function sameFileIdentity(left: ConfigFileIdentity, right: ConfigFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode &&
    left.size === right.size && left.modifiedMs === right.modifiedMs &&
    left.changedMs === right.changedMs && left.links === right.links &&
    left.owner === right.owner && left.mode === right.mode
}

function revisionOfMissingPath(): string {
  return createHash('sha256')
    .update('grokbuild-config-revision-v1\0missing\0', 'utf8')
    .digest('hex')
}

function revisionOfEntry(bytes: Uint8Array): string {
  return createHash('sha256')
    .update('grokbuild-config-revision-v1\0entry\0', 'utf8')
    .update(bytes)
    .digest('hex')
}

function currentOwner(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

function cloneSnapshot(snapshot: GrokModelConfigSnapshot): GrokModelConfigSnapshot {
  return { revision: snapshot.revision, catalog: structuredClone(snapshot.catalog) }
}

function cloneLoadResult(result: GrokModelConfigLoadResult): GrokModelConfigLoadResult {
  return result.status === 'ready'
    ? { status: 'ready', source: result.source, snapshot: cloneSnapshot(result.snapshot) }
    : { status: 'invalid', reason: result.reason }
}

function mapManagedTomlMutationError(error: unknown): GrokModelConfigStoreError {
  if (!(error instanceof ManagedTomlError)) {
    return new GrokModelConfigStoreError('invalid-mutation')
  }
  if (error.code === 'provider-in-use') {
    return new GrokModelConfigStoreError('provider-in-use')
  }
  return new GrokModelConfigStoreError('invalid-mutation')
}

function storeErrorMessage(code: GrokModelConfigStoreErrorCode): string {
  switch (code) {
    case 'invalid-config': return 'The Grok configuration requires explicit repair before editing.'
    case 'revision-conflict': return 'The Grok configuration changed before the edit could be saved.'
    case 'invalid-mutation': return 'The model configuration change is invalid.'
    case 'provider-in-use': return 'The provider is still used by a managed model.'
    case 'persist-failed': return 'The Grok configuration could not be saved safely.'
  }
}
