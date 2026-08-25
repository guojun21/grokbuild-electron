import { randomBytes } from 'node:crypto'
import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import {
  GROK_CLI_SESSION_HISTORY_LIMIT,
  GrokCliService,
  canonicalGrokCliSessionQuery,
  isCanonicalGrokCliSessionId,
  type GrokCliSessionHistoryRecord
} from '../grok/GrokCliService'
import type { PublicSessionHistoryRecord } from '../../shared/sessionHistory'
export type { PublicSessionHistoryRecord } from '../../shared/sessionHistory'

const DEFAULT_HISTORY_TTL_MS = 5 * 60_000
const MAX_HISTORY_TTL_MS = 5 * 60_000
const MAX_PROJECT_ID_BYTES = 256
const MAX_PATH_BYTES = 4_096
const MAX_SUMMARY_BYTES = 1_024
const MAX_STATUS_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const TOKEN_ATTEMPTS = 8

export interface SessionHistoryContext {
  /** Opaque id resolved from the trusted main-owned application snapshot. */
  projectId: string
  /** Exact canonical registered workspace path, never supplied by renderer state. */
  canonicalCwd: string
  /** Exact configured CLI path resolved by a trusted main caller. */
  cliPath: string
}

export interface SessionHistoryListInput extends SessionHistoryContext {
  /** Omit to list recent sessions; a present value performs the fixed CLI search. */
  query?: string | undefined
}

export interface SessionHistorySearchInput extends SessionHistoryContext {
  query: string
}

export interface SessionHistorySelectionInput extends SessionHistoryContext {
  token: string
}

/** Main-only result for a future ACP resume/delete integration. */
export interface MainSessionHistoryResolution {
  remoteId: string
  /** Validated, bounded display text retained only for main-owned actions. */
  summary: string
}

export interface SessionHistoryDeleteProtection {
  /** Must be derived from trusted main-owned session state. */
  isLive: boolean
  /** Must be derived from trusted main-owned selection state. */
  isSelected: boolean
}

/**
 * Read immediately before a destructive capability is consumed. Keeping this
 * as a callback lets the trusted main owner re-read its live state after the
 * broker's asynchronous filesystem/context checks have completed.
 */
export type SessionHistoryDeleteProtectionProvider = () => SessionHistoryDeleteProtection

export interface SessionHistoryCliService {
  listSessions(cwd: string): Promise<GrokCliSessionHistoryRecord[]>
  searchSessions(cwd: string, query: string): Promise<GrokCliSessionHistoryRecord[]>
  deleteSession(cwd: string, remoteId: string): Promise<void>
}

export type SessionHistoryCliServiceProvider = (cliPath: string) => SessionHistoryCliService

export interface SessionHistoryBrokerOptions {
  serviceProvider?: SessionHistoryCliServiceProvider | undefined
  now?: (() => number) | undefined
  tokenFactory?: (() => string) | undefined
  ttlMs?: number | undefined
}

export type SessionHistoryBrokerErrorCode =
  | 'invalid-project'
  | 'invalid-context'
  | 'invalid-query'
  | 'invalid-history'
  | 'history-unavailable'
  | 'refresh-superseded'
  | 'invalid-token'
  | 'delete-protected'
  | 'delete-failed'

export class SessionHistoryBrokerError extends Error {
  constructor(readonly code: SessionHistoryBrokerErrorCode) {
    super(publicErrorMessage(code))
    this.name = 'SessionHistoryBrokerError'
  }
}

interface FileIdentity {
  device: bigint
  inode: bigint
}

interface BoundHistoryContext extends SessionHistoryContext {
  cwdIdentity: FileIdentity
  resolvedCliPath: string
  cliIdentity: FileIdentity
}

interface CachedSession {
  context: BoundHistoryContext
  remoteId: string
  summary: string
  generation: symbol
  expiresAt: number
}

interface ResolvedCachedSession {
  token: string
  entry: CachedSession
}

/**
 * Main-process capability broker for Grok CLI history.
 *
 * Every refresh replaces the prior generation. Renderer-visible records carry
 * only a short-lived random capability; remote ids, workspace/CLI paths and
 * filesystem identities stay in this main-only cache.
 */
export class SessionHistoryBroker {
  private readonly entries = new Map<string, CachedSession>()
  private readonly serviceProvider: SessionHistoryCliServiceProvider
  private readonly now: () => number
  private readonly tokenFactory: () => string
  private readonly ttlMs: number
  private generation = Symbol('session-history-generation')

  constructor(options: SessionHistoryBrokerOptions = {}) {
    this.serviceProvider = options.serviceProvider
      ?? ((cliPath) => new GrokCliService({ cliPath }))
    this.now = options.now ?? Date.now
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'))
    this.ttlMs = requireTtl(options.ttlMs)
  }

  async list(input: SessionHistoryListInput): Promise<PublicSessionHistoryRecord[]> {
    const generation = this.beginGeneration()
    const query = readCanonicalQuery(input)
    const context = await readBoundContext(input)
    this.requireCurrentGeneration(generation)

    let rawRecords: GrokCliSessionHistoryRecord[]
    try {
      const service = this.serviceProvider(context.cliPath)
      rawRecords = query === undefined
        ? await service.listSessions(context.canonicalCwd)
        : await service.searchSessions(context.canonicalCwd, query)
    } catch {
      this.requireCurrentGeneration(generation)
      throw new SessionHistoryBrokerError('history-unavailable')
    }

    this.requireCurrentGeneration(generation)
    const records = safeHistoryRecords(rawRecords)
    const currentContext = await readBoundContext(input)
    this.requireCurrentGeneration(generation)
    if (!sameContext(context, currentContext)) {
      throw new SessionHistoryBrokerError('invalid-context')
    }

    const tokens = this.issueTokens(records.length)
    const expiresAt = expiryFrom(safeNow(this.now), this.ttlMs)
    const publicRecords = records.map((record, index) => {
      const token = tokens[index]!
      this.entries.set(token, {
        context,
        remoteId: record.remoteId,
        summary: record.summary,
        generation,
        expiresAt
      })
      return {
        token,
        projectId: context.projectId,
        summary: record.summary,
        status: record.status,
        created: record.created,
        updated: record.updated
      }
    })
    return publicRecords
  }

  async search(input: SessionHistorySearchInput): Promise<PublicSessionHistoryRecord[]> {
    return await this.list(input)
  }

  /** Resolves without consuming, suitable for a future main-owned resume flow. */
  async resolve(input: SessionHistorySelectionInput): Promise<MainSessionHistoryResolution> {
    const resolved = await this.resolveEntry(input)
    return {
      remoteId: resolved.entry.remoteId,
      summary: resolved.entry.summary
    }
  }

  /**
   * Consumes a destructive capability exactly once. Protected live/selected
   * sessions are denied without burning the capability so callers may retry
   * after main-owned state has safely changed.
   */
  async consume(
    input: SessionHistorySelectionInput,
    protection: SessionHistoryDeleteProtection
  ): Promise<MainSessionHistoryResolution> {
    const entry = await this.consumeEntry(input, protection)
    return { remoteId: entry.remoteId, summary: entry.summary }
  }

  /** Deletes by cached remote id only; callers never pass a Grok session id. */
  async delete(
    input: SessionHistorySelectionInput,
    protection: SessionHistoryDeleteProtectionProvider
  ): Promise<void> {
    const resolved = await this.resolveEntry(input)
    const currentProtection = readDeleteProtection(protection)
    requireUnprotected(currentProtection)
    this.entries.delete(resolved.token)
    const entry = resolved.entry
    try {
      await this.serviceProvider(entry.context.cliPath).deleteSession(
        entry.context.canonicalCwd,
        entry.remoteId
      )
    } catch {
      throw new SessionHistoryBrokerError('delete-failed')
    }
  }

  clear(): void {
    this.beginGeneration()
  }

  private beginGeneration(): symbol {
    this.entries.clear()
    this.generation = Symbol('session-history-generation')
    return this.generation
  }

  private requireCurrentGeneration(generation: symbol): void {
    if (generation !== this.generation) {
      throw new SessionHistoryBrokerError('refresh-superseded')
    }
  }

  private issueTokens(count: number): string[] {
    const issued = new Set<string>()
    const tokens: string[] = []
    for (let index = 0; index < count; index += 1) {
      let token: string | undefined
      for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
        let candidate: unknown
        try {
          candidate = this.tokenFactory()
        } catch {
          throw new SessionHistoryBrokerError('history-unavailable')
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
      if (!token) throw new SessionHistoryBrokerError('history-unavailable')
      issued.add(token)
      tokens.push(token)
    }
    return tokens
  }

  private async resolveEntry(input: SessionHistorySelectionInput): Promise<ResolvedCachedSession> {
    this.purgeExpired()
    const token = readValidToken(input)
    const entry = this.entries.get(token)
    if (!entry || entry.generation !== this.generation) {
      throw new SessionHistoryBrokerError('invalid-token')
    }

    let currentContext: BoundHistoryContext
    try {
      currentContext = await readBoundContext(input)
    } catch {
      throw new SessionHistoryBrokerError('invalid-token')
    }

    this.purgeExpired()
    if (
      this.entries.get(token) !== entry
      || entry.generation !== this.generation
      || !sameContext(entry.context, currentContext)
    ) {
      throw new SessionHistoryBrokerError('invalid-token')
    }
    return { token, entry }
  }

  private async consumeEntry(
    input: SessionHistorySelectionInput,
    protection: SessionHistoryDeleteProtection
  ): Promise<CachedSession> {
    requireUnprotected(protection)
    const resolved = await this.resolveEntry(input)
    this.entries.delete(resolved.token)
    return resolved.entry
  }

  private purgeExpired(): void {
    const now = safeNow(this.now)
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token)
    }
  }
}

function readCanonicalQuery(input: SessionHistoryListInput): string | undefined {
  let value: unknown
  try {
    value = input?.query
  } catch {
    throw new SessionHistoryBrokerError('invalid-query')
  }
  if (value === undefined) return undefined
  const query = canonicalGrokCliSessionQuery(value)
  if (!query) throw new SessionHistoryBrokerError('invalid-query')
  return query
}

async function readBoundContext(input: SessionHistoryContext): Promise<BoundHistoryContext> {
  if (!input || typeof input !== 'object') {
    throw new SessionHistoryBrokerError('invalid-context')
  }
  let projectId: string
  let canonicalCwd: string
  let cliPath: string
  try {
    projectId = requireProjectId(input.projectId)
    canonicalCwd = requireCanonicalPath(input.canonicalCwd)
    cliPath = requireCanonicalPath(input.cliPath)
  } catch (error) {
    if (error instanceof SessionHistoryBrokerError) throw error
    throw new SessionHistoryBrokerError('invalid-context')
  }
  try {
    const cwdInfo = await lstat(canonicalCwd, { bigint: true })
    if (cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory()) throw new Error('invalid cwd')
    if (await realpath(canonicalCwd) !== canonicalCwd) throw new Error('non-canonical cwd')

    const resolvedCliPath = await realpath(cliPath)
    const cliInfo = await stat(resolvedCliPath, { bigint: true })
    if (!cliInfo.isFile()) throw new Error('invalid cli')
    return {
      projectId,
      canonicalCwd,
      cwdIdentity: { device: cwdInfo.dev, inode: cwdInfo.ino },
      cliPath,
      resolvedCliPath,
      cliIdentity: { device: cliInfo.dev, inode: cliInfo.ino }
    }
  } catch {
    throw new SessionHistoryBrokerError('invalid-context')
  }
}

function safeHistoryRecords(value: unknown): GrokCliSessionHistoryRecord[] {
  try {
    if (!Array.isArray(value) || value.length > GROK_CLI_SESSION_HISTORY_LIMIT) {
      throw new SessionHistoryBrokerError('invalid-history')
    }
    const seen = new Set<string>()
    return value.map((record: unknown) => {
      if (!record || typeof record !== 'object') {
        throw new SessionHistoryBrokerError('invalid-history')
      }
      const candidate = record as Partial<GrokCliSessionHistoryRecord>
      if (
        !isCanonicalGrokCliSessionId(candidate.remoteId)
        || seen.has(candidate.remoteId)
        || !isSafeField(candidate.summary, MAX_SUMMARY_BYTES, true)
        || !isSafeField(candidate.status, MAX_STATUS_BYTES, false)
        || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(candidate.status)
        || !isCanonicalCalendarDate(candidate.created)
        || !isCanonicalCalendarDate(candidate.updated)
      ) {
        throw new SessionHistoryBrokerError('invalid-history')
      }
      seen.add(candidate.remoteId)
      return {
        remoteId: candidate.remoteId,
        summary: candidate.summary,
        status: candidate.status,
        created: candidate.created,
        updated: candidate.updated
      }
    })
  } catch (error) {
    if (error instanceof SessionHistoryBrokerError) throw error
    throw new SessionHistoryBrokerError('invalid-history')
  }
}

function requireProjectId(value: unknown): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > MAX_PROJECT_ID_BYTES
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new SessionHistoryBrokerError('invalid-project')
  }
  return value
}

function requireCanonicalPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || !isAbsolute(value)
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
    || normalize(value) !== value
  ) {
    throw new SessionHistoryBrokerError('invalid-context')
  }
  return value
}

function requireUnprotected(value: SessionHistoryDeleteProtection): void {
  let protectedSession = true
  try {
    protectedSession = !value || value.isLive !== false || value.isSelected !== false
  } catch {
    protectedSession = true
  }
  if (protectedSession) {
    throw new SessionHistoryBrokerError('delete-protected')
  }
}

function readDeleteProtection(
  provider: SessionHistoryDeleteProtectionProvider
): SessionHistoryDeleteProtection {
  if (typeof provider !== 'function') {
    throw new SessionHistoryBrokerError('delete-protected')
  }
  try {
    return provider()
  } catch (error) {
    if (error instanceof SessionHistoryBrokerError) throw error
    throw error
  }
}

function readValidToken(input: SessionHistorySelectionInput): string {
  let value: unknown
  try {
    value = input?.token
  } catch {
    throw new SessionHistoryBrokerError('invalid-token')
  }
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new SessionHistoryBrokerError('invalid-token')
  }
  return value
}

function sameContext(left: BoundHistoryContext, right: BoundHistoryContext): boolean {
  return left.projectId === right.projectId
    && left.canonicalCwd === right.canonicalCwd
    && sameFileIdentity(left.cwdIdentity, right.cwdIdentity)
    && left.cliPath === right.cliPath
    && left.resolvedCliPath === right.resolvedCliPath
    && sameFileIdentity(left.cliIdentity, right.cliIdentity)
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function isSafeField(value: unknown, maximumBytes: number, allowEmpty: boolean): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function isCanonicalCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function requireTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_TTL_MS
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HISTORY_TTL_MS) {
    throw new TypeError('Session history TTL must be between 1 ms and 5 minutes.')
  }
  return value
}

function safeNow(now: () => number): number {
  let value: unknown
  try {
    value = now()
  } catch {
    throw new SessionHistoryBrokerError('history-unavailable')
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionHistoryBrokerError('history-unavailable')
  }
  return value
}

function expiryFrom(now: number, ttlMs: number): number {
  const expiresAt = now + ttlMs
  if (!Number.isSafeInteger(expiresAt)) {
    throw new SessionHistoryBrokerError('history-unavailable')
  }
  return expiresAt
}

function publicErrorMessage(code: SessionHistoryBrokerErrorCode): string {
  switch (code) {
    case 'invalid-project':
      return 'The session history project identity is invalid.'
    case 'invalid-context':
      return 'The session history workspace or CLI context is invalid.'
    case 'invalid-query':
      return 'The session history query is invalid.'
    case 'invalid-history':
      return 'The session history response is invalid.'
    case 'history-unavailable':
      return 'Session history is unavailable.'
    case 'refresh-superseded':
      return 'The session history refresh was superseded.'
    case 'invalid-token':
      return 'The session history selection expired; refresh history and try again.'
    case 'delete-protected':
      return 'Close and deselect the live session before deleting it.'
    case 'delete-failed':
      return 'The session history entry could not be deleted.'
  }
}
