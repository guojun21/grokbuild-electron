import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  AGENT_ROSTER_VERSION,
  MAX_SAVED_AGENTS,
  agentRosterSchema,
  emptyAgentRoster,
  localAgentSessionIdSchema,
  materializeSavedAgent,
  materializeSavedAgentUpdate,
  missingStarterCrewTemplates,
  parseAgentRoster,
  type AgentRoster,
  type SavedAgent,
  type SavedAgentDraft,
  type SavedAgentUpdate
} from '../../shared/agents'

export const AGENT_ROSTER_FILE_NAME = 'agents.v1.json'
export const MAX_AGENT_ROSTER_BYTES = 1024 * 1024

const ROSTER_LOCK_VERSION = 1
const ROSTER_LOCK_MAX_BYTES = 1024
const ROSTER_LOCK_STALE_MS = 30_000
const ROSTER_LOCK_WAIT_MS = 5_000
const ROSTER_LOCK_RETRY_MS = 10

export type AgentRosterInvalidReason =
  | 'malformed'
  | 'non-regular'
  | 'symlink'
  | 'oversize'
  | 'unreadable'

export type AgentRosterLoadResult =
  | {
      status: 'ready'
      source: 'missing' | 'versioned' | 'swift-legacy'
      roster: AgentRoster
    }
  | {
      status: 'invalid'
      reason: AgentRosterInvalidReason
    }

export type AgentRosterStoreErrorCode =
  | 'invalid-roster'
  | 'revision-conflict'
  | 'revision-overflow'
  | 'agent-not-found'
  | 'agent-capacity'
  | 'binding-agent-not-found'
  | 'invalid-mutation'
  | 'persist-failed'
  | 'recovery-not-required'
  | 'recovery-failed'

export class AgentRosterStoreError extends Error {
  constructor(readonly code: AgentRosterStoreErrorCode) {
    super(errorMessage(code))
    this.name = 'AgentRosterStoreError'
  }
}

export interface AgentRosterStoreOptions {
  now?: (() => Date) | undefined
  idFactory?: (() => string) | undefined
  recoveryIdFactory?: (() => string) | undefined
  /** Test seam immediately before the path-identity recheck. */
  beforeIdentityCheck?: (() => Promise<void>) | undefined
  /** Test seam after the path-identity recheck, while the exclusive lock remains held. */
  afterIdentityCheck?: (() => Promise<void>) | undefined
}

export interface AgentRosterMutationResult<T> {
  roster: AgentRoster
  value: T
}

export interface AgentRosterRecoveryResult {
  roster: AgentRoster
  /** Main-process-only path retaining the invalid entry exactly as found. */
  backupPath: string
}

type RosterMutation<T> = (draft: AgentRoster) => T

/**
 * Main-process-only versioned roster store.
 *
 * This class deliberately does not write Grok TOML or prompt files. An upper
 * transaction coordinator changing role-linked agents MUST finish role staging
 * before calling a persistence mutation here, and must roll that staging back
 * if this optimistic commit fails. `path` must be derived by the main process
 * from Electron's trusted `app.getPath('userData')`; its parent is resolved to
 * a canonical target and identity-bound on first use. Renderer paths are
 * outside this API's authority.
 */
export class AgentRosterStore {
  private operationTail: Promise<void> = Promise.resolve()
  private boundLocationPromise: Promise<BoundRosterLocation> | undefined
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly recoveryIdFactory: () => string
  private readonly beforeIdentityCheck: (() => Promise<void>) | undefined
  private readonly afterIdentityCheck: (() => Promise<void>) | undefined
  private readonly requestedPath: string

  constructor(
    path: string,
    options: AgentRosterStoreOptions = {}
  ) {
    this.requestedPath = resolve(path)
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
    this.recoveryIdFactory = options.recoveryIdFactory ?? randomUUID
    this.beforeIdentityCheck = options.beforeIdentityCheck
    this.afterIdentityCheck = options.afterIdentityCheck
  }

  load(): Promise<AgentRosterLoadResult> {
    return this.enqueue(async () => {
      try {
        return await this.withExclusiveLock(async (location) =>
          cloneLoadResult(await this.readAt(location))
        )
      } catch {
        return { status: 'invalid', reason: 'unreadable' }
      }
    })
  }

  /**
   * Optimistic pure mutation. Role/TOML staging belongs to the caller and must
   * be complete before invoking this method.
   */
  mutate(
    expectedRevision: number,
    mutation: (draft: AgentRoster) => void
  ): Promise<AgentRoster> {
    return this.commit(expectedRevision, (draft) => {
      mutation(draft)
      return undefined
    }).then(({ roster }) => roster)
  }

  create(
    expectedRevision: number,
    draft: SavedAgentDraft
  ): Promise<AgentRosterMutationResult<SavedAgent>> {
    return this.commit(expectedRevision, (roster) => {
      if (roster.agents.length >= MAX_SAVED_AGENTS) {
        throw new AgentRosterStoreError('agent-capacity')
      }
      const agent = materializeSavedAgent(draft, {
        id: draft.id ?? this.idFactory(),
        now: this.timestamp()
      })
      roster.agents.push(agent)
      return agent
    })
  }

  update(
    expectedRevision: number,
    update: SavedAgentUpdate
  ): Promise<AgentRosterMutationResult<SavedAgent>> {
    return this.commit(expectedRevision, (roster) => {
      const index = roster.agents.findIndex((agent) => agent.id === update.id.toLowerCase())
      if (index < 0) throw new AgentRosterStoreError('agent-not-found')
      const existing = roster.agents[index]!
      const agent = materializeSavedAgentUpdate(update, existing, this.timestamp())
      roster.agents[index] = agent
      return agent
    })
  }

  delete(
    expectedRevision: number,
    agentId: string
  ): Promise<AgentRosterMutationResult<string>> {
    return this.commit(expectedRevision, (roster) => {
      const normalizedId = normalizedUuid(agentId)
      const index = roster.agents.findIndex((agent) => agent.id === normalizedId)
      if (index < 0) throw new AgentRosterStoreError('agent-not-found')
      roster.agents.splice(index, 1)
      roster.sessionBindings = Object.fromEntries(
        Object.entries(roster.sessionBindings)
          .filter(([, boundAgentId]) => boundAgentId !== normalizedId)
      )
      return normalizedId
    })
  }

  setSessionBinding(
    expectedRevision: number,
    localSessionId: string,
    agentId: string | null
  ): Promise<AgentRosterMutationResult<string | null>> {
    return this.commit(expectedRevision, (roster) => {
      const sessionId = localAgentSessionIdSchema.parse(localSessionId)
      if (agentId === null) {
        delete roster.sessionBindings[sessionId]
        return null
      }
      const normalizedId = normalizedUuid(agentId)
      if (!roster.agents.some((agent) => agent.id === normalizedId)) {
        throw new AgentRosterStoreError('binding-agent-not-found')
      }
      roster.sessionBindings[sessionId] = normalizedId
      return normalizedId
    })
  }

  installStarterCrew(
    expectedRevision: number
  ): Promise<AgentRosterMutationResult<SavedAgent[]>> {
    return this.commit(expectedRevision, (roster) => {
      const missing = missingStarterCrewTemplates(roster.agents)
      if (roster.agents.length + missing.length > MAX_SAVED_AGENTS) {
        throw new AgentRosterStoreError('agent-capacity')
      }
      const now = this.timestamp()
      const created = missing.map((template) => materializeSavedAgent({
        ...template,
        browserEnabled: template.browserEnabled ?? false,
        computerUseEnabled: template.computerUseEnabled ?? false
      }, { id: this.idFactory(), now }))
      roster.agents.push(...created)
      return created
    })
  }

  /**
   * Explicitly recover an invalid path. The original malformed file, symlink,
   * directory, or other entry is atomically moved aside in the same directory;
   * symlink targets are never followed or modified.
   */
  recover(replacement: AgentRoster = emptyAgentRoster()): Promise<AgentRosterRecoveryResult> {
    return this.enqueue(async () => {
      try {
        return await this.withExclusiveLock(async (location) => {
          const current = await this.readAt(location)
          if (current.status !== 'invalid') {
            throw new AgentRosterStoreError('recovery-not-required')
          }
          if (!current.identity) throw new AgentRosterStoreError('recovery-failed')
          const recovered = agentRosterSchema.parse({
            ...structuredClone(replacement),
            version: AGENT_ROSTER_VERSION,
            revision: 0
          })
          const backupPath = await this.availableRecoveryPath(location)
          try {
            await this.beforeIdentityCheck?.()
            await assertBoundParent(location)
            await assertPathIdentity(location.rosterPath, current.identity)
            await this.afterIdentityCheck?.()
            await assertBoundParent(location)
            await rename(location.rosterPath, backupPath)
            await syncBoundParent(location)
          } catch {
            throw new AgentRosterStoreError('recovery-failed')
          }
          try {
            await this.write(location, recovered, { kind: 'missing' })
          } catch {
            // There is no portable no-replace rename in Node. Never roll the
            // backup over this path: a non-cooperating writer may have claimed
            // it after the failed replacement. Keeping both entries is the
            // only fail-closed outcome that preserves every owner's bytes.
            throw new AgentRosterStoreError('recovery-failed')
          }
          return { roster: cloneRoster(recovered), backupPath }
        })
      } catch (error) {
        if (error instanceof AgentRosterStoreError) throw error
        throw new AgentRosterStoreError('recovery-failed')
      }
    })
  }

  private commit<T>(
    expectedRevision: number,
    mutation: RosterMutation<T>
  ): Promise<AgentRosterMutationResult<T>> {
    return this.enqueue(async () => {
      try {
        return await this.withExclusiveLock(async (location) => {
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            throw new AgentRosterStoreError('revision-conflict')
          }
          const loaded = await this.readAt(location)
          if (loaded.status !== 'ready') throw new AgentRosterStoreError('invalid-roster')
          const current = loaded.roster
          if (current.revision !== expectedRevision) {
            throw new AgentRosterStoreError('revision-conflict')
          }
          if (current.revision === Number.MAX_SAFE_INTEGER) {
            throw new AgentRosterStoreError('revision-overflow')
          }

          const draft = cloneRoster(current)
          let value: T
          try {
            value = mutation(draft)
          } catch (error) {
            if (error instanceof AgentRosterStoreError) throw error
            throw new AgentRosterStoreError('invalid-mutation')
          }

          let candidate: AgentRoster
          try {
            candidate = agentRosterSchema.parse({
              version: AGENT_ROSTER_VERSION,
              revision: current.revision + 1,
              agents: draft.agents,
              sessionBindings: draft.sessionBindings
            })
          } catch {
            throw new AgentRosterStoreError('invalid-mutation')
          }

          if (loaded.source !== 'swift-legacy' && sameRosterContents(current, candidate)) {
            return { roster: cloneRoster(current), value: structuredClone(value) }
          }
          await this.write(location, candidate, loaded.identity)
          return { roster: cloneRoster(candidate), value: structuredClone(value) }
        })
      } catch (error) {
        if (error instanceof AgentRosterStoreError) throw error
        throw new AgentRosterStoreError('persist-failed')
      }
    })
  }

  private async readAt(location: BoundRosterLocation): Promise<InternalAgentRosterLoadResult> {
    await assertBoundParent(location)
    const file = await readRosterFile(location.rosterPath)
    await assertBoundParent(location)
    if (file.status === 'missing') {
      return {
        status: 'ready',
        source: 'missing',
        roster: emptyAgentRoster(),
        identity: { kind: 'missing' }
      }
    }
    if (file.status === 'invalid') return file
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
      const parsed = parseAgentRoster(JSON.parse(text) as unknown)
      return {
        status: 'ready',
        source: parsed.source,
        roster: parsed.roster,
        identity: file.identity
      }
    } catch {
      return { status: 'invalid', reason: 'malformed', identity: file.identity }
    }
  }

  private async write(
    location: BoundRosterLocation,
    roster: AgentRoster,
    expectedIdentity: RosterPathIdentity
  ): Promise<void> {
    const validated = agentRosterSchema.parse(roster)
    const bytes = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, 'utf8')
    if (bytes.byteLength > MAX_AGENT_ROSTER_BYTES) {
      throw new AgentRosterStoreError('persist-failed')
    }
    const parent = location.parentPath
    await assertBoundParent(location)
    await chmod(parent, 0o700)
    await assertBoundParent(location)
    const temporary = join(
      parent,
      `.${basename(location.rosterPath)}.${process.pid}.${randomUUID()}.tmp`
    )
    let handle: FileHandle | undefined
    try {
      handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.chmod(0o600)
      await handle.close()
      handle = undefined
      await this.beforeIdentityCheck?.()
      await assertBoundParent(location)
      await assertPathIdentity(location.rosterPath, expectedIdentity)
      await this.afterIdentityCheck?.()
      await assertBoundParent(location)
      await rename(temporary, location.rosterPath)
      await syncBoundParent(location)
    } finally {
      await handle?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }

  private async availableRecoveryPath(location: BoundRosterLocation): Promise<string> {
    const parent = location.parentPath
    const name = basename(location.rosterPath)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const suffix = this.recoveryIdFactory().replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 64)
      if (!suffix) continue
      const candidate = join(parent, `${name}.recovered-${suffix}`)
      try {
        await lstat(candidate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
        throw new AgentRosterStoreError('recovery-failed')
      }
    }
    throw new AgentRosterStoreError('recovery-failed')
  }

  private async withExclusiveLock<T>(
    operation: (location: BoundRosterLocation) => Promise<T>
  ): Promise<T> {
    const location = await this.boundLocation()
    const lease = await acquireRosterLock(location)
    try {
      await assertBoundParent(location)
      return await operation(location)
    } finally {
      await releaseRosterLock(location, lease)
    }
  }

  private async boundLocation(): Promise<BoundRosterLocation> {
    this.boundLocationPromise ??= bindRosterLocation(this.requestedPath)
    const location = await this.boundLocationPromise
    await assertBoundParent(location)
    return location
  }

  private timestamp(): string {
    const value = this.now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new AgentRosterStoreError('invalid-mutation')
    }
    return value.toISOString()
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
}

interface BoundRosterLocation {
  parentPath: string
  rosterPath: string
  lockPath: string
  parentIdentity: ParentDirectoryIdentity
}

interface RosterLockLease {
  identity: RosterFileIdentity
}

interface RosterLockRecord {
  version: typeof ROSTER_LOCK_VERSION
  pid: number
  nonce: string
  createdAtMs: number
}

interface RosterFileIdentity {
  kind: 'entry'
  device: number
  inode: number
  size: number
  modifiedMs: number
  changedMs: number
}

type RosterPathIdentity = RosterFileIdentity | { kind: 'missing' }

type InternalAgentRosterLoadResult =
  | (Extract<AgentRosterLoadResult, { status: 'ready' }> & { identity: RosterPathIdentity })
  | (Extract<AgentRosterLoadResult, { status: 'invalid' }> & { identity?: RosterFileIdentity })

type RosterFileReadResult =
  | { status: 'missing' }
  | { status: 'ready'; bytes: Uint8Array; identity: RosterFileIdentity }
  | { status: 'invalid'; reason: AgentRosterInvalidReason; identity?: RosterFileIdentity }

async function bindRosterLocation(requestedPath: string): Promise<BoundRosterLocation> {
  const requestedParent = dirname(requestedPath)
  await mkdir(requestedParent, { recursive: true, mode: 0o700 })
  const parentPath = await realpath(requestedParent)
  const stats = await lstat(parentPath, { bigint: true })
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Agent roster parent is not a canonical directory')
  }
  const location: BoundRosterLocation = {
    parentPath,
    rosterPath: join(parentPath, basename(requestedPath)),
    lockPath: join(parentPath, `.${basename(requestedPath)}.lock`),
    parentIdentity: { device: stats.dev, inode: stats.ino }
  }
  await assertBoundParent(location)
  return location
}

async function assertBoundParent(location: BoundRosterLocation): Promise<void> {
  const before = await lstat(location.parentPath, { bigint: true })
  if (before.isSymbolicLink() || !before.isDirectory() ||
      before.dev !== location.parentIdentity.device ||
      before.ino !== location.parentIdentity.inode) {
    throw new Error('Agent roster parent identity changed')
  }
  if (await realpath(location.parentPath) !== location.parentPath) {
    throw new Error('Agent roster parent is no longer canonical')
  }
  const after = await lstat(location.parentPath, { bigint: true })
  if (after.isSymbolicLink() || !after.isDirectory() ||
      after.dev !== location.parentIdentity.device ||
      after.ino !== location.parentIdentity.inode ||
      before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Agent roster parent identity changed')
  }
}

async function acquireRosterLock(location: BoundRosterLocation): Promise<RosterLockLease> {
  // This coordinates cooperating Store instances and makes their CAS sequence
  // indivisible. The identity checks still fail closed around ordinary path
  // replacement, but cannot promise protection from a malicious same-UID ABA
  // attacker that can rewrite directory entries between arbitrary syscalls.
  const maxAttempts = Math.ceil(ROSTER_LOCK_WAIT_MS / ROSTER_LOCK_RETRY_MS) + 1
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await assertBoundParent(location)
    let handle: FileHandle | undefined
    let createdIdentity: RosterFileIdentity | undefined
    try {
      handle = await open(
        location.lockPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600
      )
      createdIdentity = identityFromStats(await handle.stat())
      const record: RosterLockRecord = {
        version: ROSTER_LOCK_VERSION,
        pid: process.pid,
        nonce: randomUUID(),
        createdAtMs: Date.now()
      }
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      await handle.sync()
      await handle.chmod(0o600)
      createdIdentity = identityFromStats(await handle.stat())
      await handle.close()
      handle = undefined
      await assertBoundParent(location)
      return { identity: createdIdentity }
    } catch (error) {
      if (handle) {
        try {
          createdIdentity = identityFromStats(await handle.stat())
        } catch {
          // Keep the last identity captured from our O_EXCL-created entry.
        }
      }
      await handle?.close().catch(() => undefined)
      if (createdIdentity) {
        await unlinkIfIdentity(location.lockPath, createdIdentity).catch(() => false)
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    if (await recoverStaleRosterLock(location)) continue
    if (attempt + 1 >= maxAttempts) break
    await delay(ROSTER_LOCK_RETRY_MS)
  }
  throw new Error('Agent roster lock is unavailable')
}

async function releaseRosterLock(
  location: BoundRosterLocation,
  lease: RosterLockLease
): Promise<void> {
  await unlinkIfIdentity(location.lockPath, lease.identity).catch(() => false)
}

async function recoverStaleRosterLock(location: BoundRosterLocation): Promise<boolean> {
  let entry: Awaited<ReturnType<typeof lstat>>
  try {
    entry = await lstat(location.lockPath)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > ROSTER_LOCK_MAX_BYTES) {
    return false
  }
  if (Date.now() - Math.max(entry.mtimeMs, entry.ctimeMs) <= ROSTER_LOCK_STALE_MS) {
    return false
  }

  const entryIdentity = identityFromStats(entry)
  let handle: FileHandle | undefined
  try {
    handle = await open(
      location.lockPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    )
    const openedIdentity = identityFromStats(await handle.stat())
    if (!sameIdentity(entryIdentity, openedIdentity)) return false
    const bytes = await readLockBounded(handle)
    if (!bytes) return false
    const afterRead = identityFromStats(await handle.stat())
    if (!sameIdentity(openedIdentity, afterRead)) return false
    const ownerPid = parseRosterLockOwner(bytes)
    // An empty or partially-written lock can still belong to a live process
    // paused between O_EXCL creation and the durable record write. Reclaim only
    // when a complete record identifies an owner that is definitively gone;
    // malformed/unknown ownership must fail closed instead of creating two
    // concurrent CAS writers.
    if (ownerPid === undefined || isProcessAlive(ownerPid)) return false
    await assertBoundParent(location)
    return await unlinkIfIdentity(location.lockPath, afterRead)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readLockBounded(handle: FileHandle): Promise<Uint8Array | undefined> {
  const buffer = Buffer.allocUnsafe(ROSTER_LOCK_MAX_BYTES + 1)
  let total = 0
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  if (total > ROSTER_LOCK_MAX_BYTES) return undefined
  return buffer.subarray(0, total)
}

function parseRosterLockOwner(bytes: Uint8Array): number | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const candidate = parsed as Partial<RosterLockRecord>
    return candidate.version === ROSTER_LOCK_VERSION &&
      Number.isSafeInteger(candidate.pid) &&
      typeof candidate.pid === 'number' && candidate.pid > 0 &&
      typeof candidate.nonce === 'string' && candidate.nonce.length > 0 &&
      Number.isSafeInteger(candidate.createdAtMs) &&
      typeof candidate.createdAtMs === 'number' && candidate.createdAtMs >= 0
      ? candidate.pid
      : undefined
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function unlinkIfIdentity(
  path: string,
  expectedIdentity: RosterFileIdentity
): Promise<boolean> {
  let entry: Awaited<ReturnType<typeof lstat>>
  try {
    entry = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (!sameIdentity(expectedIdentity, identityFromStats(entry))) return false
  await unlink(path)
  return true
}

async function syncBoundParent(location: BoundRosterLocation): Promise<void> {
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
      throw new Error('Agent roster parent identity changed')
    }
    await handle.sync()
  } finally {
    await handle?.close().catch(() => undefined)
  }
  await assertBoundParent(location)
}

async function readRosterFile(path: string): Promise<RosterFileReadResult> {
  let entry: Awaited<ReturnType<typeof lstat>>
  try {
    entry = await lstat(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'invalid', reason: 'unreadable' }
  }
  const entryIdentity = identityFromStats(entry)
  if (entry.isSymbolicLink()) {
    return { status: 'invalid', reason: 'symlink', identity: entryIdentity }
  }
  if (!entry.isFile()) {
    return { status: 'invalid', reason: 'non-regular', identity: entryIdentity }
  }
  if (entry.size > MAX_AGENT_ROSTER_BYTES) {
    return { status: 'invalid', reason: 'oversize', identity: entryIdentity }
  }

  let handle: FileHandle | undefined
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    )
    const opened = await handle.stat()
    const openedIdentity = identityFromStats(opened)
    if (!sameIdentity(entryIdentity, openedIdentity)) {
      return { status: 'invalid', reason: 'unreadable', identity: openedIdentity }
    }
    if (!opened.isFile()) {
      return { status: 'invalid', reason: 'non-regular', identity: openedIdentity }
    }
    if (opened.size > MAX_AGENT_ROSTER_BYTES) {
      return { status: 'invalid', reason: 'oversize', identity: openedIdentity }
    }
    const bytes = await readBounded(handle)
    const afterRead = identityFromStats(await handle.stat())
    if (!sameIdentity(openedIdentity, afterRead)) {
      return { status: 'invalid', reason: 'unreadable', identity: afterRead }
    }
    return bytes
      ? { status: 'ready', bytes, identity: afterRead }
      : { status: 'invalid', reason: 'oversize', identity: afterRead }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 'missing' }
    if (code === 'ELOOP') {
      return { status: 'invalid', reason: 'symlink', identity: entryIdentity }
    }
    return { status: 'invalid', reason: 'unreadable' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readBounded(handle: FileHandle): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= MAX_AGENT_ROSTER_BYTES) {
    const remaining = MAX_AGENT_ROSTER_BYTES + 1 - total
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    total += bytesRead
    chunks.push(buffer.subarray(0, bytesRead))
  }
  if (total > MAX_AGENT_ROSTER_BYTES) return undefined
  return Buffer.concat(chunks, total)
}

function normalizedUuid(value: string): string {
  const parsed = zUuid(value)
  return parsed.toLowerCase()
}

function zUuid(value: string): string {
  const result = agentRosterSchema.shape.agents.element.shape.id.safeParse(value)
  if (!result.success) throw new AgentRosterStoreError('invalid-mutation')
  return result.data
}

function sameRosterContents(left: AgentRoster, right: AgentRoster): boolean {
  return JSON.stringify({ agents: left.agents, sessionBindings: left.sessionBindings }) ===
    JSON.stringify({ agents: right.agents, sessionBindings: right.sessionBindings })
}

function cloneRoster(roster: AgentRoster): AgentRoster {
  return structuredClone(roster)
}

function cloneLoadResult(result: AgentRosterLoadResult): AgentRosterLoadResult {
  return result.status === 'ready'
    ? { status: 'ready', source: result.source, roster: cloneRoster(result.roster) }
    : { status: 'invalid', reason: result.reason }
}

function identityFromStats(stats: {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}): RosterFileIdentity {
  return {
    kind: 'entry',
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedMs: stats.mtimeMs,
    changedMs: stats.ctimeMs
  }
}

function sameIdentity(left: RosterFileIdentity, right: RosterFileIdentity): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs &&
    left.changedMs === right.changedMs
}

async function assertPathIdentity(path: string, expected: RosterPathIdentity): Promise<void> {
  let current: Awaited<ReturnType<typeof lstat>>
  try {
    current = await lstat(path)
  } catch (error) {
    if (expected.kind === 'missing' && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('Agent roster path identity changed')
  }
  if (expected.kind === 'missing' || !sameIdentity(expected, identityFromStats(current))) {
    throw new Error('Agent roster path identity changed')
  }
}

function errorMessage(code: AgentRosterStoreErrorCode): string {
  switch (code) {
    case 'invalid-roster': return 'Agent roster is invalid; explicit recovery is required.'
    case 'revision-conflict': return 'Agent roster changed before this mutation could be committed.'
    case 'revision-overflow': return 'Agent roster revision limit was reached.'
    case 'agent-not-found': return 'Saved agent was not found.'
    case 'agent-capacity': return `Agent roster can contain at most ${MAX_SAVED_AGENTS} agents.`
    case 'binding-agent-not-found': return 'Session binding must reference an existing saved agent.'
    case 'invalid-mutation': return 'Agent roster mutation was invalid.'
    case 'persist-failed': return 'Agent roster could not be saved.'
    case 'recovery-not-required': return 'Agent roster recovery is only available for an invalid roster.'
    case 'recovery-failed': return 'Agent roster recovery failed safely.'
  }
}
