import { randomBytes } from 'node:crypto'
import { constants as fsConstants, type BigIntStats, type Dirent } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize
} from 'node:path'
import type {
  MemoryScope,
  PublicMemoryFileContents,
  PublicMemoryFileSummary
} from '../../shared/memory'
import { MEMORY_PUBLIC_LIMITS } from '../../shared/memory'

export const MEMORY_BROKER_HARD_LIMITS = Object.freeze({
  files: MEMORY_PUBLIC_LIMITS.files,
  previewBytes: MEMORY_PUBLIC_LIMITS.previewBytes,
  noteBytes: MEMORY_PUBLIC_LIMITS.noteBytes,
  globalBytes: 2 * 1_024 * 1_024,
  pathBytes: 4_096,
  componentBytes: 255,
  ttlMs: 5 * 60_000,
  lockWaitMs: 2_000,
  staleLockMs: 30_000
})

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const LOCK_FILE_NAME = '.grokbuild-memory.lock'
const TEMP_FILE_PREFIX = '.grokbuild-memory-write-'
const DELETE_FILE_PREFIX = '.grokbuild-memory-delete-'
const RELEASE_DIRECTORY_PREFIX = '.grokbuild-memory-release-'
const TOKEN_ATTEMPTS = 8
const LOCK_RETRY_MS = 10
const MAX_LOCK_RECORD_BYTES = 1_024

export type MemoryBrokerErrorCode =
  | 'unavailable'
  | 'changed'
  | 'too-many-files'
  | 'too-large'
  | 'invalid-utf8'
  | 'invalid-token'
  | 'not-deletable'
  | 'empty-note'
  | 'busy'

export class MemoryBrokerError extends Error {
  constructor(readonly code: MemoryBrokerErrorCode) {
    super(memoryBrokerErrorMessage(code))
    this.name = 'MemoryBrokerError'
  }
}

interface MemoryBrokerLimits {
  files: number
  previewBytes: number
  noteBytes: number
  globalBytes: number
}

export interface MemoryBrokerOptions {
  /** Main-owned path, normally `${homedir()}/.grok/memory`; never renderer input. */
  basePath: string
  limits?: Partial<MemoryBrokerLimits> | undefined
  ttlMs?: number | undefined
  lockWaitMs?: number | undefined
  staleLockMs?: number | undefined
  now?: (() => number) | undefined
  tokenFactory?: (() => string) | undefined
  nonceFactory?: (() => string) | undefined
  isProcessAlive?: ((pid: number) => boolean) | undefined
  /** Test observation hook, invoked only after the directory FileHandle.sync succeeds. */
  onDirectorySynced?: ((path: string) => void) | undefined
}

interface DirectoryIdentity {
  device: bigint
  inode: bigint
  owner: bigint
  mode: bigint
}

interface FileIdentity extends DirectoryIdentity {
  size: bigint
  modifiedNs: bigint
  changedNs: bigint
  links: bigint
}

interface BoundRoot {
  canonicalParent: string
  parentIdentity: DirectoryIdentity
  canonicalBase: string
  baseIdentity: DirectoryIdentity
}

interface BoundParent {
  components: string[]
  identity: DirectoryIdentity
}

interface DiscoveredMemoryFile {
  scope: MemoryScope
  components: string[]
  parents: BoundParent[]
  identity: FileIdentity
  title: string
  workspaceLabel?: string | undefined
  modifiedAt?: string | undefined
}

interface CachedMemoryFile extends DiscoveredMemoryFile {
  root: BoundRoot
  token: string
  generation: symbol
  expiresAt: number
  summary: PublicMemoryFileSummary
}

interface OpenedFile {
  handle: FileHandle
  identity: FileIdentity
}

interface HeldLock {
  path: string
  handle: FileHandle
  identity: FileIdentity
  releaseNonce: string
}

interface LockRecord {
  version: 1
  pid: number
  nonce: string
  createdAt: number
}

/**
 * Main-process capability broker for Grok's Markdown memory store.
 *
 * Absolute paths, workspace directory slugs and filesystem identities never
 * cross this boundary. A list refresh rotates the token generation; every
 * later read/delete re-binds the root, its parent directories and the file.
 */
export class MemoryBroker {
  private readonly basePath: string
  private readonly limits: MemoryBrokerLimits
  private readonly ttlMs: number
  private readonly lockWaitMs: number
  private readonly staleLockMs: number
  private readonly now: () => number
  private readonly tokenFactory: () => string
  private readonly nonceFactory: () => string
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly directorySync: (path: string) => Promise<void>
  private readonly entries = new Map<string, CachedMemoryFile>()
  private generation = Symbol('memory-generation')

  constructor(options: MemoryBrokerOptions) {
    this.basePath = requireBasePath(options.basePath)
    this.limits = {
      files: boundedProductionLimit(options.limits?.files, MEMORY_BROKER_HARD_LIMITS.files),
      previewBytes: boundedProductionLimit(
        options.limits?.previewBytes,
        MEMORY_BROKER_HARD_LIMITS.previewBytes
      ),
      noteBytes: boundedProductionLimit(
        options.limits?.noteBytes,
        MEMORY_BROKER_HARD_LIMITS.noteBytes
      ),
      globalBytes: boundedProductionLimit(
        options.limits?.globalBytes,
        MEMORY_BROKER_HARD_LIMITS.globalBytes
      )
    }
    this.ttlMs = boundedInteger(
      options.ttlMs,
      MEMORY_BROKER_HARD_LIMITS.ttlMs,
      10,
      MEMORY_BROKER_HARD_LIMITS.ttlMs
    )
    this.lockWaitMs = boundedInteger(
      options.lockWaitMs,
      MEMORY_BROKER_HARD_LIMITS.lockWaitMs,
      0,
      10_000
    )
    this.staleLockMs = boundedInteger(
      options.staleLockMs,
      MEMORY_BROKER_HARD_LIMITS.staleLockMs,
      1_000,
      5 * 60_000
    )
    this.now = options.now ?? Date.now
    this.tokenFactory = options.tokenFactory ?? randomCapability
    this.nonceFactory = options.nonceFactory ?? randomCapability
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessLiveness
    this.directorySync = async (path) => {
      await syncDirectory(path, options.onDirectorySynced)
    }
  }

  async list(): Promise<PublicMemoryFileSummary[]> {
    const generation = this.beginGeneration()
    const root = await this.bindRoot(false)
    this.requireGeneration(generation)
    if (!root) return []

    const discovered = await this.discover(root)
    this.requireGeneration(generation)
    await this.requireSameRoot(root)
    this.requireGeneration(generation)

    const tokens = this.issueTokens(discovered.length)
    const expiresAt = safeExpiry(this.readNow(), this.ttlMs)
    const staged = discovered.map((file, index) => {
      const token = tokens[index]!
      const summary: PublicMemoryFileSummary = {
        token,
        scope: file.scope,
        title: file.title,
        ...(file.workspaceLabel ? { workspaceLabel: file.workspaceLabel } : {}),
        ...(file.modifiedAt ? { modifiedAt: file.modifiedAt } : {}),
        byteLength: safeByteLength(file.identity.size),
        canDelete: file.scope === 'session'
      }
      const entry: CachedMemoryFile = {
        ...file,
        root,
        token,
        generation,
        expiresAt,
        summary
      }
      return { entry, summary }
    })
    for (const { entry } of staged) this.entries.set(entry.token, entry)
    return staged.map(({ summary }) => summary)
  }

  async read(token: string): Promise<PublicMemoryFileContents> {
    const entry = await this.resolve(token)
    if (entry.identity.size > BigInt(this.limits.previewBytes)) {
      throw new MemoryBrokerError('too-large')
    }

    const path = await this.revalidatedEntryPath(entry)
    let opened: OpenedFile | undefined
    try {
      opened = await openRegularFile(path)
      if (!sameFileIdentity(opened.identity, entry.identity)) {
        throw new MemoryBrokerError('changed')
      }
      if (opened.identity.size > BigInt(this.limits.previewBytes)) {
        throw new MemoryBrokerError('too-large')
      }
      const bytes = await opened.handle.readFile()
      const afterRead = fileIdentity(await opened.handle.stat({ bigint: true }))
      if (!sameFileIdentity(afterRead, opened.identity) || bytes.byteLength !== Number(afterRead.size)) {
        throw new MemoryBrokerError('changed')
      }
      let contents: string
      try {
        contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new MemoryBrokerError('invalid-utf8')
      }
      return {
        ...entry.summary,
        contents
      }
    } catch (error) {
      throw asMemoryBrokerError(error)
    } finally {
      await closeQuietly(opened?.handle)
    }
  }

  /** Writes a renderer-provided note to global MEMORY.md without returning its path. */
  async remember(note: string): Promise<void> {
    const normalizedNote = canonicalMemoryNote(note, this.limits.noteBytes)
    const root = await this.bindRoot(true)
    if (!root) throw new MemoryBrokerError('unavailable')
    const lock = await this.acquireLock(root)
    let writeError: unknown
    try {
      await this.writeGlobalNote(root, normalizedNote)
      this.beginGeneration()
    } catch (error) {
      writeError = error
      throw asMemoryBrokerError(error)
    } finally {
      try {
        await this.releaseLock(root, lock)
      } catch (releaseError) {
        if (!writeError) throw asMemoryBrokerError(releaseError)
      }
    }
  }

  /** Deletes only a token that was minted for a per-session Markdown log. */
  async deleteSession(token: string): Promise<void> {
    const entry = await this.resolve(token)
    if (entry.scope !== 'session') throw new MemoryBrokerError('not-deletable')

    const path = await this.revalidatedEntryPath(entry)
    const parent = dirname(path)
    const quarantine = join(parent, `${DELETE_FILE_PREFIX}${this.issueNonce()}`)
    const tombstone = join(quarantine, 'memory.md')
    assertBoundedPath(quarantine)
    assertBoundedPath(tombstone)

    let opened: OpenedFile | undefined
    let quarantineIdentity: DirectoryIdentity | undefined
    try {
      opened = await openRegularFile(path)
      if (!sameFileIdentity(opened.identity, entry.identity)) {
        throw new MemoryBrokerError('changed')
      }
      await this.requireEntryParents(entry)
      try {
        await mkdir(quarantine, { mode: 0o700 })
      } catch {
        throw new MemoryBrokerError('changed')
      }
      quarantineIdentity = await requireBoundDirectory(quarantine)
      await this.requireEntryParents(entry)

      // Move first, then verify what moved before unlinking it. This prevents a
      // raced replacement from being permanently deleted under the old name.
      await rename(path, tombstone)
      let moved: OpenedFile | undefined
      try {
        moved = await openRegularFile(tombstone)
        if (!sameFileAfterRename(moved.identity, entry.identity)) {
          throw new MemoryBrokerError('changed')
        }
        await this.requireEntryParents(entry)
        await requirePathMatchesOpenHandle(tombstone, moved.handle)
        await unlink(tombstone)
        if (await removeDirectoryIfIdentityMatches(quarantine, quarantineIdentity)) {
          quarantineIdentity = undefined
        }
        await this.requireEntryParents(entry)
        await this.directorySync(parent)
        await this.requireEntryParents(entry)
      } finally {
        await closeQuietly(moved?.handle)
      }
      this.beginGeneration()
    } catch (error) {
      // A mismatched tombstone is deliberately preserved rather than deleted
      // or renamed over a possibly racing owner file.
      throw asMemoryBrokerError(error)
    } finally {
      await closeQuietly(opened?.handle)
      if (quarantineIdentity) {
        await removeDirectoryIfIdentityMatches(quarantine, quarantineIdentity)
      }
    }
  }

  clear(): void {
    this.beginGeneration()
  }

  private beginGeneration(): symbol {
    this.entries.clear()
    this.generation = Symbol('memory-generation')
    return this.generation
  }

  private requireGeneration(generation: symbol): void {
    if (generation !== this.generation) throw new MemoryBrokerError('changed')
  }

  private async discover(root: BoundRoot): Promise<DiscoveredMemoryFile[]> {
    const files: DiscoveredMemoryFile[] = []
    let remainingScanEntries = Math.max(
      64,
      Math.min(MEMORY_BROKER_HARD_LIMITS.files * 4, this.limits.files * 4)
    )
    const global = await this.discoverFile(
      root,
      ['MEMORY.md'],
      [{ components: [], identity: root.baseIdentity }],
      'global',
      'Global memory'
    )
    if (global) files.push(global)

    const baseScan = await readBoundedDirectory(root.canonicalBase, remainingScanEntries)
    const baseEntries = baseScan.entries
    remainingScanEntries -= baseScan.consumed
    await this.requireSameRoot(root)
    const workspaceNames = baseEntries
      .filter((entry) =>
        entry.isDirectory()
        && !entry.name.startsWith('.')
        && isSafeComponent(entry.name)
      )
      .map((entry) => entry.name)
      .sort(compareNames)

    for (let workspaceIndex = 0; workspaceIndex < workspaceNames.length; workspaceIndex += 1) {
      const workspaceName = workspaceNames[workspaceIndex]!
      const workspacePath = join(root.canonicalBase, workspaceName)
      const workspaceIdentity = await requireBoundDirectory(workspacePath)
      const workspaceParent: BoundParent = {
        components: [workspaceName],
        identity: workspaceIdentity
      }
      const workspaceLabel = `Workspace ${workspaceIndex + 1}`
      const workspaceMemory = await this.discoverFile(
        root,
        [workspaceName, 'MEMORY.md'],
        [
          { components: [], identity: root.baseIdentity },
          workspaceParent
        ],
        'workspace',
        'Workspace memory',
        workspaceLabel
      )
      if (workspaceMemory) files.push(workspaceMemory)

      const sessionsPath = join(workspacePath, 'sessions')
      const sessionsIdentity = await optionalDirectoryIdentity(sessionsPath)
      if (!sessionsIdentity) {
        this.requireFileLimit(files.length)
        continue
      }
      const sessionParent: BoundParent = {
        components: [workspaceName, 'sessions'],
        identity: sessionsIdentity
      }
      const sessionScan = await readBoundedDirectory(sessionsPath, remainingScanEntries)
      const sessionEntries = sessionScan.entries
      remainingScanEntries -= sessionScan.consumed
      const sessions: DiscoveredMemoryFile[] = []
      for (const candidate of sessionEntries) {
        if (
          !candidate.isFile()
          || candidate.name.startsWith('.')
          || extname(candidate.name).toLowerCase() !== '.md'
          || !isSafeComponent(candidate.name)
        ) continue
        this.requireFileLimit(files.length + sessions.length + 1)
        const title = sanitizePublicLabel(
          basename(candidate.name, extname(candidate.name)),
          'Session memory'
        )
        const file = await this.discoverFile(
          root,
          [workspaceName, 'sessions', candidate.name],
          [
            { components: [], identity: root.baseIdentity },
            workspaceParent,
            sessionParent
          ],
          'session',
          title,
          workspaceLabel
        )
        if (file) sessions.push(file)
      }
      sessions.sort(compareSessions)
      files.push(...sessions)
      this.requireFileLimit(files.length)
    }

    this.requireFileLimit(files.length)
    return files
  }

  private async discoverFile(
    root: BoundRoot,
    components: string[],
    parents: BoundParent[],
    scope: MemoryScope,
    title: string,
    workspaceLabel?: string
  ): Promise<DiscoveredMemoryFile | undefined> {
    this.requireFileLimit(this.entries.size)
    const path = join(root.canonicalBase, ...components)
    let opened: OpenedFile | undefined
    try {
      await this.requireBoundParents(root, parents)
      opened = await openRegularFile(path)
      await this.requireBoundParents(root, parents)
      const modifiedAt = modifiedDate(opened.identity.modifiedNs)
      return {
        scope,
        components,
        parents,
        identity: opened.identity,
        title: sanitizePublicLabel(title, `${scope} memory`),
        ...(workspaceLabel
          ? { workspaceLabel: sanitizePublicLabel(workspaceLabel, 'Workspace') }
          : {}),
        ...(modifiedAt ? { modifiedAt } : {})
      }
    } catch (error) {
      if (isMissing(error)) return undefined
      throw asMemoryBrokerError(error)
    } finally {
      await closeQuietly(opened?.handle)
    }
  }

  private requireFileLimit(count: number): void {
    if (count > this.limits.files) throw new MemoryBrokerError('too-many-files')
  }

  private issueTokens(count: number): string[] {
    if (count > this.limits.files) throw new MemoryBrokerError('too-many-files')
    const issued = new Set<string>()
    const tokens: string[] = []
    for (let index = 0; index < count; index += 1) {
      let token: string | undefined
      for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
        let candidate: unknown
        try {
          candidate = this.tokenFactory()
        } catch {
          throw new MemoryBrokerError('unavailable')
        }
        if (
          typeof candidate === 'string'
          && TOKEN_PATTERN.test(candidate)
          && !issued.has(candidate)
          && !this.entries.has(candidate)
        ) {
          token = candidate
          break
        }
      }
      if (!token) throw new MemoryBrokerError('unavailable')
      issued.add(token)
      tokens.push(token)
    }
    return tokens
  }

  private issueNonce(): string {
    let nonce: unknown
    try {
      nonce = this.nonceFactory()
    } catch {
      throw new MemoryBrokerError('unavailable')
    }
    if (typeof nonce !== 'string' || !TOKEN_PATTERN.test(nonce)) {
      throw new MemoryBrokerError('unavailable')
    }
    return nonce
  }

  private async resolve(token: string): Promise<CachedMemoryFile> {
    this.purgeExpired()
    if (!TOKEN_PATTERN.test(token)) throw new MemoryBrokerError('invalid-token')
    const entry = this.entries.get(token)
    if (!entry || entry.generation !== this.generation) {
      throw new MemoryBrokerError('invalid-token')
    }
    await this.requireSameRoot(entry.root)
    this.purgeExpired()
    if (this.entries.get(token) !== entry || entry.generation !== this.generation) {
      throw new MemoryBrokerError('invalid-token')
    }
    return entry
  }

  private async revalidatedEntryPath(entry: CachedMemoryFile): Promise<string> {
    await this.requireEntryParents(entry)
    const path = join(entry.root.canonicalBase, ...entry.components)
    assertBoundedPath(path)
    return path
  }

  private async requireEntryParents(entry: CachedMemoryFile): Promise<void> {
    await this.requireBoundParents(entry.root, entry.parents)
  }

  private async requireBoundParents(root: BoundRoot, parents: BoundParent[]): Promise<void> {
    await this.requireSameRoot(root)
    for (const parent of parents) {
      const path = join(root.canonicalBase, ...parent.components)
      const current = await requireBoundDirectory(path)
      if (!sameDirectoryIdentity(current, parent.identity)) {
        throw new MemoryBrokerError('changed')
      }
    }
    await this.requireSameRoot(root)
  }

  private purgeExpired(): void {
    const now = this.readNow()
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token)
    }
  }

  private readNow(): number {
    let value: unknown
    try {
      value = this.now()
    } catch {
      throw new MemoryBrokerError('unavailable')
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new MemoryBrokerError('unavailable')
    }
    return value
  }

  private async bindRoot(create: boolean): Promise<BoundRoot | undefined> {
    const parentPath = dirname(this.basePath)
    if (create) await ensureDirectory(parentPath)
    const parent = await optionalBoundDirectory(parentPath)
    if (!parent) return undefined

    let createdBase = false
    if (create) {
      try {
        await mkdir(this.basePath, { mode: 0o700 })
        createdBase = true
      } catch (error) {
        if (!isAlreadyExists(error)) throw new MemoryBrokerError('unavailable')
      }
    }
    const base = await optionalBoundDirectory(this.basePath)
    if (!base) return undefined
    const canonicalParent = await canonicalDirectory(parentPath)
    const canonicalBase = await canonicalDirectory(this.basePath)
    if (dirname(canonicalBase) !== canonicalParent) {
      throw new MemoryBrokerError('unavailable')
    }
    assertBoundedPath(canonicalParent)
    assertBoundedPath(canonicalBase)
    if (createdBase) {
      await this.directorySync(canonicalParent)
      const parentAfterSync = await requireBoundDirectory(canonicalParent)
      if (!sameDirectoryIdentity(parentAfterSync, parent)) {
        throw new MemoryBrokerError('changed')
      }
    }
    return {
      canonicalParent,
      parentIdentity: parent,
      canonicalBase,
      baseIdentity: base
    }
  }

  private async requireSameRoot(expected: BoundRoot): Promise<void> {
    const current = await this.bindRoot(false)
    if (
      !current
      || current.canonicalParent !== expected.canonicalParent
      || current.canonicalBase !== expected.canonicalBase
      || !sameDirectoryIdentity(current.parentIdentity, expected.parentIdentity)
      || !sameDirectoryIdentity(current.baseIdentity, expected.baseIdentity)
    ) {
      throw new MemoryBrokerError('changed')
    }
  }

  private async acquireLock(root: BoundRoot): Promise<HeldLock> {
    const lockPath = join(root.canonicalBase, LOCK_FILE_NAME)
    const deadline = Date.now() + this.lockWaitMs
    for (;;) {
      await this.requireSameRoot(root)
      let handle: FileHandle | undefined
      let createdIdentity: FileIdentity | undefined
      try {
        const lockNonce = this.issueNonce()
        const releaseNonce = this.issueNonce()
        const record: LockRecord = {
          version: 1,
          pid: process.pid,
          nonce: lockNonce,
          createdAt: Math.floor(this.readNow())
        }
        handle = await open(
          lockPath,
          fsConstants.O_WRONLY
            | fsConstants.O_CREAT
            | fsConstants.O_EXCL
            | fsConstants.O_NOFOLLOW,
          0o600
        )
        const identity = fileIdentity(await handle.stat({ bigint: true }))
        requireOwnedRegularFile(identity)
        createdIdentity = identity
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
        await handle.sync()
        const afterWrite = fileIdentity(await handle.stat({ bigint: true }))
        if (!sameDirectoryIdentity(identity, afterWrite) || afterWrite.links !== 1n) {
          throw new MemoryBrokerError('changed')
        }
        return { path: lockPath, handle, identity: afterWrite, releaseNonce }
      } catch (error) {
        await closeQuietly(handle)
        if (createdIdentity) await unlinkIfObjectMatches(lockPath, createdIdentity)
        if (!isAlreadyExists(error)) throw asMemoryBrokerError(error)
        if (await this.tryRecoverStaleLock(root, lockPath)) continue
        if (Date.now() >= deadline) throw new MemoryBrokerError('busy')
        await delay(LOCK_RETRY_MS)
      }
    }
  }

  private async tryRecoverStaleLock(root: BoundRoot, lockPath: string): Promise<boolean> {
    let opened: OpenedFile | undefined
    let quarantineIdentity: DirectoryIdentity | undefined
    let moved: OpenedFile | undefined
    let quarantine: string | undefined
    try {
      try {
        opened = await openRegularFile(lockPath)
      } catch (error) {
        if (isMissing(error)) return true
        return false
      }
      if (opened.identity.size <= 0n || opened.identity.size > BigInt(MAX_LOCK_RECORD_BYTES)) {
        return false
      }
      const bytes = await opened.handle.readFile()
      const afterRead = fileIdentity(await opened.handle.stat({ bigint: true }))
      if (!sameFileIdentity(afterRead, opened.identity) || bytes.byteLength !== Number(afterRead.size)) {
        return false
      }
      const record = parseLockRecord(bytes)
      if (!record) return false
      const now = Math.floor(this.readNow())
      if (record.createdAt > now || now - record.createdAt < this.staleLockMs) return false
      let alive: boolean
      try {
        alive = this.isProcessAlive(record.pid)
      } catch {
        return false
      }
      if (typeof alive !== 'boolean' || alive) return false

      const nonce = this.issueNonce()
      quarantine = join(root.canonicalBase, `${RELEASE_DIRECTORY_PREFIX}${nonce}`)
      const movedPath = join(quarantine, 'stale-lock')
      await this.requireSameRoot(root)
      try {
        await mkdir(quarantine, { mode: 0o700 })
      } catch {
        return false
      }
      quarantineIdentity = await requireBoundDirectory(quarantine)
      await this.requireSameRoot(root)
      const currentPathIdentity = fileIdentity(await lstat(lockPath, { bigint: true }))
      if (!sameFileIdentity(currentPathIdentity, opened.identity)) return false
      await rename(lockPath, movedPath)
      moved = await openRegularFile(movedPath)
      const heldAfterRename = fileIdentity(await opened.handle.stat({ bigint: true }))
      if (!sameFileAfterRename(moved.identity, heldAfterRename)) return false
      await this.requireSameRoot(root)
      await requirePathMatchesOpenHandle(movedPath, moved.handle)
      await unlink(movedPath)
      if (await removeDirectoryIfIdentityMatches(quarantine, quarantineIdentity)) {
        quarantineIdentity = undefined
      }
      await this.requireSameRoot(root)
      await this.directorySync(root.canonicalBase)
      await this.requireSameRoot(root)
      return true
    } catch (error) {
      if (isMissing(error)) return true
      if (error instanceof MemoryBrokerError && error.code === 'changed') throw error
      return false
    } finally {
      await closeQuietly(moved?.handle)
      await closeQuietly(opened?.handle)
      if (quarantine && quarantineIdentity) {
        await removeDirectoryIfIdentityMatches(quarantine, quarantineIdentity)
      }
    }
  }

  private async releaseLock(root: BoundRoot, lock: HeldLock): Promise<void> {
    const quarantine = join(root.canonicalBase, `${RELEASE_DIRECTORY_PREFIX}${lock.releaseNonce}`)
    const movedPath = join(quarantine, 'lock')
    let quarantineIdentity: DirectoryIdentity | undefined
    let moved: OpenedFile | undefined
    try {
      const openInfo = await lock.handle.stat({ bigint: true })
      const pathInfo = await lstat(lock.path, { bigint: true })
      requireCurrentOwner(openInfo)
      requireCurrentOwner(pathInfo)
      const openIdentity = fileIdentity(openInfo)
      const pathIdentity = fileIdentity(pathInfo)
      if (
        !sameFileIdentity(openIdentity, pathIdentity)
        || !sameFileIdentity(openIdentity, lock.identity)
      ) {
        throw new MemoryBrokerError('changed')
      }
      await this.requireSameRoot(root)
      try {
        await mkdir(quarantine, { mode: 0o700 })
      } catch {
        throw new MemoryBrokerError('changed')
      }
      quarantineIdentity = await requireBoundDirectory(quarantine)
      await this.requireSameRoot(root)
      await rename(lock.path, movedPath)
      moved = await openRegularFile(movedPath)
      const heldAfterRename = fileIdentity(await lock.handle.stat({ bigint: true }))
      if (!sameFileAfterRename(moved.identity, heldAfterRename)) {
        throw new MemoryBrokerError('changed')
      }
      await this.requireSameRoot(root)
      await requirePathMatchesOpenHandle(movedPath, moved.handle)
      await unlink(movedPath)
      if (await removeDirectoryIfIdentityMatches(quarantine, quarantineIdentity)) {
        quarantineIdentity = undefined
      }
      await this.requireSameRoot(root)
      await this.directorySync(root.canonicalBase)
      await this.requireSameRoot(root)
    } catch (error) {
      throw asMemoryBrokerError(error)
    } finally {
      await closeQuietly(moved?.handle)
      await closeQuietly(lock.handle)
      if (quarantineIdentity) {
        await removeDirectoryIfIdentityMatches(quarantine, quarantineIdentity)
      }
    }
  }

  private async writeGlobalNote(root: BoundRoot, note: string): Promise<void> {
    const target = join(root.canonicalBase, 'MEMORY.md')
    let existing = ''
    let priorIdentity: FileIdentity | undefined
    let opened: OpenedFile | undefined
    try {
      try {
        opened = await openRegularFile(target)
        priorIdentity = opened.identity
        if (priorIdentity.size > BigInt(this.limits.globalBytes)) {
          throw new MemoryBrokerError('too-large')
        }
        const bytes = await opened.handle.readFile()
        const afterRead = fileIdentity(await opened.handle.stat({ bigint: true }))
        if (!sameFileIdentity(afterRead, priorIdentity) || bytes.byteLength !== Number(afterRead.size)) {
          throw new MemoryBrokerError('changed')
        }
        try {
          existing = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          throw new MemoryBrokerError('invalid-utf8')
        }
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    } finally {
      await closeQuietly(opened?.handle)
    }

    const updated = appendMemoryNote(existing, note)
    const bytes = Buffer.from(updated, 'utf8')
    if (bytes.byteLength > this.limits.globalBytes) throw new MemoryBrokerError('too-large')

    const temporary = join(root.canonicalBase, `${TEMP_FILE_PREFIX}${this.issueNonce()}`)
    let temporaryHandle: FileHandle | undefined
    let temporaryIdentity: FileIdentity | undefined
    try {
      temporaryHandle = await open(
        temporary,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW,
        0o600
      )
      await temporaryHandle.writeFile(bytes)
      await temporaryHandle.sync()
      temporaryIdentity = fileIdentity(await temporaryHandle.stat({ bigint: true }))
      requireOwnedRegularFile(temporaryIdentity)

      await this.requireSameRoot(root)
      await requireTargetIdentity(target, priorIdentity)
      await rename(temporary, target)

      const published = await openRegularFile(target)
      try {
        if (!sameFileAfterRename(published.identity, temporaryIdentity)) {
          throw new MemoryBrokerError('changed')
        }
      } finally {
        await closeQuietly(published.handle)
      }
      await this.requireSameRoot(root)
      await this.directorySync(root.canonicalBase)
    } catch (error) {
      if (temporaryIdentity) await unlinkIfIdentityMatches(temporary, temporaryIdentity)
      throw asMemoryBrokerError(error)
    } finally {
      await closeQuietly(temporaryHandle)
    }
  }
}

/** Pure Markdown builder shared by broker tests and future UI-independent QA. */
export function appendMemoryNote(existing: string, note: string): string {
  const entry = `- ${note.replace(/\n/gu, '\n  ')}`
  const headingPattern = /^## Notes[ \t]*\r?$/gmu
  const heading = headingPattern.exec(existing)
  if (!heading) {
    const body = existing.trim()
    return `${body ? `${body}\n\n` : ''}## Notes\n\n${entry}\n`
  }

  const afterHeading = heading.index + heading[0].length
  const nextHeadingPattern = /^## /gmu
  nextHeadingPattern.lastIndex = afterHeading
  const nextHeading = nextHeadingPattern.exec(existing)
  const insertionIndex = nextHeading
    ? precedingLineBreakIndex(existing, nextHeading.index)
    : existing.length
  let prefix = existing.slice(0, insertionIndex)
  const suffix = existing.slice(insertionIndex)
  if (!prefix.endsWith('\n')) prefix += '\n'
  return `${prefix}${entry}\n${suffix}`
}

function precedingLineBreakIndex(value: string, lineStart: number): number {
  if (lineStart >= 2 && value.slice(lineStart - 2, lineStart) === '\r\n') return lineStart - 2
  if (lineStart >= 1 && value[lineStart - 1] === '\n') return lineStart - 1
  return lineStart
}

function canonicalMemoryNote(note: string, maxBytes: number): string {
  if (typeof note !== 'string') throw new MemoryBrokerError('empty-note')
  const normalized = note
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .trim()
  if (!normalized || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
    throw new MemoryBrokerError('empty-note')
  }
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new MemoryBrokerError('too-large')
  }
  return normalized
}

async function openRegularFile(path: string): Promise<OpenedFile> {
  let handle: FileHandle | undefined
  try {
    const beforeInfo = await lstat(path, { bigint: true })
    requireCurrentOwner(beforeInfo)
    const before = fileIdentity(beforeInfo)
    requireOwnedRegularFile(before)
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const afterInfo = await handle.stat({ bigint: true })
    requireCurrentOwner(afterInfo)
    const after = fileIdentity(afterInfo)
    requireOwnedRegularFile(after)
    if (!sameFileIdentity(before, after)) throw new MemoryBrokerError('changed')
    return { handle, identity: after }
  } catch (error) {
    await closeQuietly(handle)
    if (error instanceof MemoryBrokerError) throw error
    throw error
  }
}

async function bindDirectory(path: string): Promise<DirectoryIdentity> {
  let handle: FileHandle | undefined
  try {
    const before = await lstat(path, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new MemoryBrokerError('unavailable')
    }
    requireCurrentOwner(before)
    requireNonWritableByGroupOrOther(before)
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    )
    const after = await handle.stat({ bigint: true })
    if (!after.isDirectory()) throw new MemoryBrokerError('unavailable')
    requireCurrentOwner(after)
    requireNonWritableByGroupOrOther(after)
    const beforeIdentity = directoryIdentity(before)
    const afterIdentity = directoryIdentity(after)
    if (!sameDirectoryIdentity(beforeIdentity, afterIdentity)) {
      throw new MemoryBrokerError('changed')
    }
    return afterIdentity
  } catch (error) {
    if (error instanceof MemoryBrokerError) throw error
    throw error
  } finally {
    await closeQuietly(handle)
  }
}

async function optionalBoundDirectory(path: string): Promise<DirectoryIdentity | undefined> {
  try {
    return await bindDirectory(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw asMemoryBrokerError(error)
  }
}

async function optionalDirectoryIdentity(path: string): Promise<DirectoryIdentity | undefined> {
  return await optionalBoundDirectory(path)
}

async function readBoundedDirectory(
  path: string,
  maximumEntries: number
): Promise<{ entries: Dirent[]; consumed: number }> {
  let directory: Awaited<ReturnType<typeof opendir>> | undefined
  const entries: Dirent[] = []
  try {
    directory = await opendir(path)
    for await (const entry of directory) {
      if (entries.length >= maximumEntries) {
        throw new MemoryBrokerError('too-many-files')
      }
      entries.push(entry)
    }
    return { entries, consumed: entries.length }
  } catch (error) {
    throw asMemoryBrokerError(error)
  } finally {
    await directory?.close().catch(() => undefined)
  }
}

async function requireBoundDirectory(path: string): Promise<DirectoryIdentity> {
  try {
    return await bindDirectory(path)
  } catch (error) {
    if (isMissing(error)) throw new MemoryBrokerError('changed')
    throw asMemoryBrokerError(error)
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    throw new MemoryBrokerError('unavailable')
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) throw new MemoryBrokerError('unavailable')
    requireCurrentOwner(info)
    requireNonWritableByGroupOrOther(info)
  } catch (error) {
    if (!isMissing(error)) throw asMemoryBrokerError(error)
    try {
      await mkdir(path, { recursive: true, mode: 0o700 })
      const info = await lstat(path, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink()) throw new MemoryBrokerError('unavailable')
      requireCurrentOwner(info)
      requireNonWritableByGroupOrOther(info)
    } catch (mkdirError) {
      throw asMemoryBrokerError(mkdirError)
    }
  }
}

async function requireTargetIdentity(
  path: string,
  expected: FileIdentity | undefined
): Promise<void> {
  try {
    const info = await lstat(path, { bigint: true })
    requireCurrentOwner(info)
    const current = fileIdentity(info)
    requireOwnedRegularFile(current)
    if (!expected || !sameFileIdentity(current, expected)) {
      throw new MemoryBrokerError('changed')
    }
  } catch (error) {
    if (isMissing(error) && !expected) return
    throw asMemoryBrokerError(error)
  }
}

async function requirePathMatchesOpenHandle(path: string, handle: FileHandle): Promise<FileIdentity> {
  try {
    const openIdentity = fileIdentity(await handle.stat({ bigint: true }))
    const pathIdentity = fileIdentity(await lstat(path, { bigint: true }))
    if (!sameFileIdentity(openIdentity, pathIdentity)) {
      throw new MemoryBrokerError('changed')
    }
    return openIdentity
  } catch (error) {
    throw asMemoryBrokerError(error)
  }
}

async function unlinkIfIdentityMatches(path: string, expected: FileIdentity): Promise<void> {
  try {
    const info = await lstat(path, { bigint: true })
    requireCurrentOwner(info)
    const current = fileIdentity(info)
    if (sameFileIdentity(current, expected)) await unlink(path)
  } catch {
    // Never remove an unknown replacement while cleaning an owned temp file.
  }
}

async function unlinkIfObjectMatches(path: string, expected: FileIdentity): Promise<void> {
  try {
    const info = await lstat(path, { bigint: true })
    requireCurrentOwner(info)
    const current = fileIdentity(info)
    if (sameDirectoryIdentity(current, expected) && current.links === 1n) await unlink(path)
  } catch {
    // Never remove an unknown replacement while cleaning an owned lock file.
  }
}

async function removeDirectoryIfIdentityMatches(
  path: string,
  expected: DirectoryIdentity
): Promise<boolean> {
  try {
    const current = await bindDirectory(path)
    if (!sameDirectoryIdentity(current, expected)) return false
    await rmdir(path)
    return true
  } catch {
    // Preserve a non-empty or replaced quarantine rather than removing unknown data.
    return false
  }
}

async function syncDirectory(path: string, onSynced?: (path: string) => void): Promise<void> {
  let handle: FileHandle | undefined
  try {
    const expected = await bindDirectory(path)
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    const info = await handle.stat({ bigint: true })
    if (!info.isDirectory()) throw new MemoryBrokerError('unavailable')
    requireCurrentOwner(info)
    requireNonWritableByGroupOrOther(info)
    if (!sameDirectoryIdentity(directoryIdentity(info), expected)) {
      throw new MemoryBrokerError('changed')
    }
    await handle.sync()
    onSynced?.(path)
  } catch {
    throw new MemoryBrokerError('unavailable')
  } finally {
    await closeQuietly(handle)
  }
}

function directoryIdentity(info: BigIntStats): DirectoryIdentity {
  return {
    device: info.dev,
    inode: info.ino,
    owner: info.uid,
    mode: info.mode
  }
}

function fileIdentity(info: BigIntStats): FileIdentity {
  if (!info.isFile() || info.isSymbolicLink()) throw new MemoryBrokerError('unavailable')
  requireCurrentOwner(info)
  requireNonWritableByGroupOrOther(info)
  return {
    device: info.dev,
    inode: info.ino,
    owner: info.uid,
    mode: info.mode,
    size: info.size,
    modifiedNs: info.mtimeNs,
    changedNs: info.ctimeNs,
    links: info.nlink
  }
}

function requireOwnedRegularFile(identity: FileIdentity): void {
  if (identity.links !== 1n) throw new MemoryBrokerError('unavailable')
}

function requireCurrentOwner(info: BigIntStats): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && info.uid !== BigInt(uid)) throw new MemoryBrokerError('unavailable')
}

function requireNonWritableByGroupOrOther(info: BigIntStats): void {
  if ((info.mode & 0o022n) !== 0n) throw new MemoryBrokerError('unavailable')
}

function sameDirectoryIdentity(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.device === b.device
    && a.inode === b.inode
    && a.owner === b.owner
    && a.mode === b.mode
}

function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return sameDirectoryIdentity(a, b)
    && a.size === b.size
    && a.modifiedNs === b.modifiedNs
    && a.changedNs === b.changedNs
    && a.links === b.links
}

/** Rename can advance ctime while preserving the exact regular-file object and content. */
function sameFileAfterRename(a: FileIdentity, b: FileIdentity): boolean {
  return sameDirectoryIdentity(a, b)
    && a.size === b.size
    && a.modifiedNs === b.modifiedNs
    && a.links === b.links
}

function compareSessions(a: DiscoveredMemoryFile, b: DiscoveredMemoryFile): number {
  if (a.identity.modifiedNs !== b.identity.modifiedNs) {
    return a.identity.modifiedNs > b.identity.modifiedNs ? -1 : 1
  }
  return compareNames(b.title, a.title)
}

function compareNames(a: string, b: string): number {
  const foldedA = a.toLocaleLowerCase('en-US')
  const foldedB = b.toLocaleLowerCase('en-US')
  if (foldedA < foldedB) return -1
  if (foldedA > foldedB) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function sanitizePublicLabel(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFC')
    .replace(/[\\/]+/gu, ' · ')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  let bounded = ''
  for (const character of cleaned) {
    if (bounded.length + character.length > 128) break
    bounded += character
  }
  bounded = bounded.trim()
  return bounded || fallback
}

function modifiedDate(nanoseconds: bigint): string | undefined {
  const milliseconds = Number(nanoseconds / 1_000_000n)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined
  const date = new Date(milliseconds)
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString()
}

function safeByteLength(size: bigint): number {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MemoryBrokerError('too-large')
  }
  return Number(size)
}

function requireBasePath(value: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\u0000')
    || !isAbsolute(value)
  ) {
    throw new MemoryBrokerError('unavailable')
  }
  const resolved = normalize(value)
  if (resolved === dirname(resolved)) throw new MemoryBrokerError('unavailable')
  assertBoundedPath(resolved)
  return resolved
}

function assertBoundedPath(path: string): void {
  if (Buffer.byteLength(path, 'utf8') > MEMORY_BROKER_HARD_LIMITS.pathBytes) {
    throw new MemoryBrokerError('unavailable')
  }
}

function isSafeComponent(value: string): boolean {
  return value !== '.'
    && value !== '..'
    && !value.includes('\u0000')
    && !value.includes('/')
    && !value.includes('\\')
    && Buffer.byteLength(value, 'utf8') <= MEMORY_BROKER_HARD_LIMITS.componentBytes
}

function boundedProductionLimit(value: number | undefined, maximum: number): number {
  return boundedInteger(value, maximum, 1, maximum)
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const candidate = value ?? fallback
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new MemoryBrokerError('unavailable')
  }
  return candidate
}

function safeExpiry(now: number, ttlMs: number): number {
  const expiry = now + ttlMs
  if (!Number.isSafeInteger(expiry)) throw new MemoryBrokerError('unavailable')
  return expiry
}

function randomCapability(): string {
  return randomBytes(32).toString('base64url')
}

function parseLockRecord(bytes: Buffer): LockRecord | undefined {
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(decoded)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join('\u0000') !== ['createdAt', 'nonce', 'pid', 'version'].join('\u0000')) {
    return undefined
  }
  if (
    record.version !== 1
    || typeof record.pid !== 'number'
    || !Number.isSafeInteger(record.pid)
    || record.pid < 1
    || record.pid > 2_147_483_647
    || typeof record.nonce !== 'string'
    || !TOKEN_PATTERN.test(record.nonce)
    || typeof record.createdAt !== 'number'
    || !Number.isSafeInteger(record.createdAt)
    || record.createdAt < 0
  ) return undefined
  return {
    version: 1,
    pid: record.pid,
    nonce: record.nonce,
    createdAt: record.createdAt
  }
}

function defaultProcessLiveness(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH'
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
}

function asMemoryBrokerError(error: unknown): MemoryBrokerError {
  return error instanceof MemoryBrokerError ? error : new MemoryBrokerError('unavailable')
}

function memoryBrokerErrorMessage(code: MemoryBrokerErrorCode): string {
  switch (code) {
  case 'unavailable': return 'Memory files are unavailable.'
  case 'changed': return 'Memory files changed. Refresh and try again.'
  case 'too-many-files': return 'There are too many memory files to display safely.'
  case 'too-large': return 'This memory file or note is too large.'
  case 'invalid-utf8': return 'This memory file is not valid UTF-8 Markdown.'
  case 'invalid-token': return 'This memory selection expired. Refresh and try again.'
  case 'not-deletable': return 'Only per-session memory logs can be deleted.'
  case 'empty-note': return 'The memory note is empty or contains unsupported controls.'
  case 'busy': return 'Memory is busy. Try again shortly.'
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return
  await handle.close().catch(() => undefined)
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}
