import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import {
  GROK_AGENT_CATALOG_LIMIT,
  GROK_AGENT_PLUGIN_DISPLAY_NAME_MAX_CHARS,
  GROK_AGENT_PUBLIC_DESCRIPTION_MAX_CHARS,
  GROK_AGENT_PUBLIC_NAME_MAX_CHARS,
  GROK_AGENT_VIEW_TOKEN_PATTERN,
  publicGrokAgentCatalogSchema,
  type GrokAgentSourceKind,
  type PublicGrokAgentCatalog,
  type PublicGrokAgentCatalogEntry
} from '../../shared/agentCatalog'
import { REDACTED_PATH, sanitizeDisplayTitle } from '../../shared/security/redaction'
import {
  GROK_CLI_INSPECT_AGENTS_MAX_OUTPUT_BYTES,
  GrokCliService
} from '../grok/GrokCliService'

const DEFAULT_CATALOG_TTL_MS = 5 * 60_000
const MAX_CATALOG_TTL_MS = 5 * 60_000
const MAX_CONTEXT_PATH_BYTES = 4_096
const MAX_SELECTOR_BYTES = 512
const MAX_RAW_NAME_BYTES = 2_048
const MAX_RAW_DESCRIPTION_BYTES = 16 * 1_024
const MAX_RAW_PLUGIN_NAME_BYTES = 2_048
const MAX_SOURCE_PATH_BYTES = 4_096
const TOKEN_ATTEMPTS = 8

export interface GrokAgentCatalogContext {
  /** Exact canonical workspace path resolved from trusted main-owned state. */
  canonicalCwd: string
  /** Configured absolute Grok CLI path resolved from trusted main-owned state. */
  cliPath: string
}

export interface GrokAgentCatalogSelectionInput extends GrokAgentCatalogContext {
  token: string
}

/** Main-only resolution for a future session/new or session/load integration. */
export interface MainGrokAgentCatalogResolution {
  selector: string
}

export interface GrokAgentCatalogCliService {
  inspectAgents(cwd: string): Promise<string>
}

export type GrokAgentCatalogCliServiceProvider = (
  cliPath: string
) => GrokAgentCatalogCliService

export interface GrokAgentCatalogServiceOptions {
  serviceProvider?: GrokAgentCatalogCliServiceProvider | undefined
  now?: (() => number) | undefined
  tokenFactory?: (() => string) | undefined
  ttlMs?: number | undefined
}

export type GrokAgentCatalogServiceErrorCode =
  | 'invalid-context'
  | 'catalog-unavailable'
  | 'invalid-catalog'
  | 'invalid-token'

export class GrokAgentCatalogServiceError extends Error {
  constructor(readonly code: GrokAgentCatalogServiceErrorCode) {
    super(errorMessage(code))
    this.name = 'GrokAgentCatalogServiceError'
  }
}

interface FileIdentityRevision {
  device: bigint
  inode: bigint
  size: bigint
  modifiedNs: bigint
  changedNs: bigint
  mode: bigint
}

interface DirectoryIdentity {
  device: bigint
  inode: bigint
}

interface BoundCatalogContext {
  canonicalCwd: string
  cwdIdentity: DirectoryIdentity
  resolvedCliPath: string
  cliIdentityRevision: FileIdentityRevision
  cacheKey: string
}

interface MainAgentDefinition {
  selector: string
  /** Exact bounded semantic record retained only for stability comparisons. */
  semanticKey: string
  name: string
  description: string
  sourceKind: GrokAgentSourceKind
  pluginDisplayName?: string
  /** Retained only in this main-process cache; never returned by resolve. */
  rawSourcePath?: string
  sourceIdentityRevision?: FileIdentityRevision
}

interface CachedAgentEntry {
  generation: symbol
  context: BoundCatalogContext
  selector: string
  semanticKey: string
  rawSourcePath?: string
  sourceIdentityRevision?: FileIdentityRevision
  catalogKey: string
  expiresAt: number
  publicValue: PublicGrokAgentCatalogEntry
}

interface CachedCatalog {
  generation: symbol
  context: BoundCatalogContext
  tokens: string[]
  tokenSet: Set<string>
  expiresAt: number
  lastAccess: number
}

interface InFlightCatalog {
  generation: symbol
  promise: Promise<PublicGrokAgentCatalog>
}

/**
 * Main-process, workspace-scoped projection of `grok inspect --json` agents.
 *
 * Raw selectors, source paths, workspace paths, and CLI file identities remain
 * inside this service. A renderer-facing record contains only sanitized text
 * plus a random, short-lived token that must be resolved against fresh context.
 */
export class GrokAgentCatalogService {
  private readonly serviceProvider: GrokAgentCatalogCliServiceProvider
  private readonly now: () => number
  private readonly tokenFactory: () => string
  private readonly ttlMs: number
  private readonly catalogs = new Map<string, CachedCatalog>()
  private readonly entries = new Map<string, CachedAgentEntry>()
  private readonly inFlight = new Map<string, InFlightCatalog>()
  private generation = Symbol('grok-agent-catalog-generation')

  constructor(options: GrokAgentCatalogServiceOptions = {}) {
    this.serviceProvider = options.serviceProvider
      ?? ((cliPath) => new GrokCliService({ cliPath }))
    this.now = options.now ?? Date.now
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'))
    this.ttlMs = requireTtl(options.ttlMs)
  }

  async list(contextInput: GrokAgentCatalogContext): Promise<PublicGrokAgentCatalog> {
    const generation = this.generation
    const now = safeNow(this.now)
    this.purgeExpired(now)
    const context = await readBoundContext(contextInput)
    this.requireGeneration(generation)
    const cached = this.catalogs.get(context.cacheKey)
    if (
      cached
      && cached.generation === generation
      && cached.expiresAt > now
      && sameContext(cached.context, context)
    ) {
      const sourcesAreFresh = await this.catalogSourcesAreFresh(cached)
      this.requireGeneration(generation)
      if (this.catalogs.get(context.cacheKey) === cached && sourcesAreFresh) {
        cached.lastAccess = now
        return this.publicCatalog(cached)
      }
      if (this.catalogs.get(context.cacheKey) === cached) {
        this.removeCatalog(context.cacheKey)
      }
    }
    const existingFlight = this.inFlight.get(context.cacheKey)
    if (existingFlight?.generation === generation) {
      const result = await existingFlight.promise
      this.requireGeneration(generation)
      return clonePublicCatalog(result)
    }

    const flight: InFlightCatalog = {
      generation,
      promise: this.refreshCatalog(contextInput, context, generation)
    }
    this.inFlight.set(context.cacheKey, flight)
    try {
      const result = await flight.promise
      this.requireGeneration(generation)
      return clonePublicCatalog(result)
    } finally {
      if (this.inFlight.get(context.cacheKey) === flight) {
        this.inFlight.delete(context.cacheKey)
      }
    }
  }

  private async refreshCatalog(
    contextInput: GrokAgentCatalogContext,
    context: BoundCatalogContext,
    generation: symbol
  ): Promise<PublicGrokAgentCatalog> {
    let service: GrokAgentCatalogCliService
    try {
      service = this.serviceProvider(context.resolvedCliPath)
    } catch {
      throw new GrokAgentCatalogServiceError('catalog-unavailable')
    }

    const firstDefinitions = await this.inspectAndBind(service, context, generation)
    const afterFirst = await readBoundContext(contextInput)
    this.requireGeneration(generation)
    if (
      !sameContext(context, afterFirst)
      || !await agentSourcesAreFresh(firstDefinitions)
    ) throw new GrokAgentCatalogServiceError('invalid-context')
    this.requireGeneration(generation)

    const secondDefinitions = await this.inspectAndBind(service, context, generation)
    const freshContext = await readBoundContext(contextInput)
    this.requireGeneration(generation)
    if (
      !sameContext(context, freshContext)
      || !sameDefinitionCatalog(firstDefinitions, secondDefinitions)
      || !await agentSourcesAreFresh(secondDefinitions)
    ) throw new GrokAgentCatalogServiceError('invalid-context')
    this.requireGeneration(generation)

    const committedAt = safeNow(this.now)
    this.purgeExpired(committedAt)
    this.requireGeneration(generation)
    const tokens = this.issueTokens(secondDefinitions.length)
    const expiresAt = expiryFrom(committedAt, this.ttlMs)
    const stagedEntries: CachedAgentEntry[] = []
    const publicValues: PublicGrokAgentCatalogEntry[] = []
    for (let index = 0; index < secondDefinitions.length; index += 1) {
      const definition = secondDefinitions[index]!
      const token = tokens[index]!
      const publicValue: PublicGrokAgentCatalogEntry = {
        token,
        name: definition.name,
        description: definition.description,
        sourceKind: definition.sourceKind,
        ...(definition.pluginDisplayName
          ? { pluginDisplayName: definition.pluginDisplayName }
          : {})
      }
      publicValues.push(publicValue)
      stagedEntries.push({
        generation,
        context,
        selector: definition.selector,
        semanticKey: definition.semanticKey,
        ...(definition.rawSourcePath ? { rawSourcePath: definition.rawSourcePath } : {}),
        ...(definition.sourceIdentityRevision
          ? { sourceIdentityRevision: definition.sourceIdentityRevision }
          : {}),
        catalogKey: context.cacheKey,
        expiresAt,
        publicValue
      })
    }
    const parsedPublic = publicGrokAgentCatalogSchema.safeParse(publicValues)
    if (!parsedPublic.success) {
      throw new GrokAgentCatalogServiceError('catalog-unavailable')
    }
    this.requireGeneration(generation)
    this.removeCatalog(context.cacheKey)
    this.makeCapacity(secondDefinitions.length)
    const catalog: CachedCatalog = {
      generation,
      context,
      tokens,
      tokenSet: new Set(tokens),
      expiresAt,
      lastAccess: committedAt
    }
    this.catalogs.set(context.cacheKey, catalog)
    for (let index = 0; index < stagedEntries.length; index += 1) {
      this.entries.set(tokens[index]!, stagedEntries[index]!)
    }
    return parsedPublic.data
  }

  private async inspectAndBind(
    service: GrokAgentCatalogCliService,
    context: BoundCatalogContext,
    generation: symbol
  ): Promise<MainAgentDefinition[]> {
    let output: string
    try {
      output = await service.inspectAgents(context.canonicalCwd)
    } catch {
      throw new GrokAgentCatalogServiceError('catalog-unavailable')
    }
    this.requireGeneration(generation)
    return await bindAgentSources(parseInspectCatalog(output))
  }

  async resolve(
    input: GrokAgentCatalogSelectionInput
  ): Promise<MainGrokAgentCatalogResolution> {
    const generation = this.generation
    const now = safeNow(this.now)
    this.purgeExpired(now)
    const token = requireToken(input)
    const entry = this.entries.get(token)
    if (!entry || entry.expiresAt <= now) {
      throw new GrokAgentCatalogServiceError('invalid-token')
    }

    let currentContext: BoundCatalogContext
    try {
      currentContext = await readBoundContext(input)
    } catch {
      throw new GrokAgentCatalogServiceError('invalid-token')
    }
    const checkedAt = safeNow(this.now)
    this.purgeExpired(checkedAt)
    const catalog = this.catalogs.get(entry.catalogKey)
    if (
      this.entries.get(token) !== entry
      || !catalog
      || catalog.generation !== generation
      || entry.generation !== generation
      || catalog.expiresAt <= checkedAt
      || !catalog.tokenSet.has(token)
      || !sameContext(entry.context, currentContext)
    ) {
      throw new GrokAgentCatalogServiceError('invalid-token')
    }
    await this.requireFreshEntry(entry, input, generation)
    const finalAt = safeNow(this.now)
    this.purgeExpired(finalAt)
    const finalCatalog = this.catalogs.get(entry.catalogKey)
    if (
      this.generation !== generation
      || this.entries.get(token) !== entry
      || finalCatalog !== catalog
      || entry.expiresAt <= finalAt
      || catalog.expiresAt <= finalAt
      || !catalog.tokenSet.has(token)
    ) throw new GrokAgentCatalogServiceError('invalid-token')
    catalog.lastAccess = finalAt
    return { selector: entry.selector }
  }

  clear(): void {
    this.generation = Symbol('grok-agent-catalog-generation')
    this.inFlight.clear()
    this.entries.clear()
    this.catalogs.clear()
  }

  private async requireFreshEntry(
    entry: CachedAgentEntry,
    input: GrokAgentCatalogSelectionInput,
    generation: symbol
  ): Promise<void> {
    try {
      if (!await cachedEntrySourceIsFresh(entry)) throw new Error('stale source')
      this.requireGeneration(generation)
      const output = await this.serviceProvider(entry.context.resolvedCliPath)
        .inspectAgents(entry.context.canonicalCwd)
      this.requireGeneration(generation)
      const definitions = parseInspectCatalog(output)
      const selected = definitions.find((definition) =>
        definition.selector === entry.selector
        && definition.semanticKey === entry.semanticKey
      )
      if (!selected) throw new Error('agent definition changed')
      const finalContext = await readBoundContext(input)
      this.requireGeneration(generation)
      if (
        !sameContext(entry.context, finalContext)
        || !await cachedEntrySourceIsFresh(entry)
      ) throw new Error('agent context changed')
      this.requireGeneration(generation)
    } catch {
      throw new GrokAgentCatalogServiceError('invalid-token')
    }
  }

  private requireGeneration(generation: symbol): void {
    if (this.generation !== generation) {
      throw new GrokAgentCatalogServiceError('catalog-unavailable')
    }
  }

  private publicCatalog(catalog: CachedCatalog): PublicGrokAgentCatalog {
    const values: PublicGrokAgentCatalogEntry[] = []
    for (const token of catalog.tokens) {
      const entry = this.entries.get(token)
      if (
        !entry
        || entry.generation !== catalog.generation
        || entry.catalogKey !== catalog.context.cacheKey
        || !catalog.tokenSet.has(token)
      ) {
        throw new GrokAgentCatalogServiceError('catalog-unavailable')
      }
      values.push({ ...entry.publicValue })
    }
    const parsed = publicGrokAgentCatalogSchema.safeParse(values)
    if (!parsed.success) throw new GrokAgentCatalogServiceError('catalog-unavailable')
    return parsed.data
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
          throw new GrokAgentCatalogServiceError('catalog-unavailable')
        }
        if (
          typeof candidate === 'string'
          && GROK_AGENT_VIEW_TOKEN_PATTERN.test(candidate)
          && !issued.has(candidate)
          && !this.entries.has(candidate)
        ) {
          token = candidate
          break
        }
      }
      if (!token) throw new GrokAgentCatalogServiceError('catalog-unavailable')
      issued.add(token)
      tokens.push(token)
    }
    return tokens
  }

  private makeCapacity(incoming: number): void {
    while (this.entries.size + incoming > GROK_AGENT_CATALOG_LIMIT) {
      const oldest = [...this.catalogs.entries()].sort((left, right) =>
        left[1].lastAccess - right[1].lastAccess
      )[0]
      if (!oldest) throw new GrokAgentCatalogServiceError('catalog-unavailable')
      this.removeCatalog(oldest[0])
    }
  }

  private purgeExpired(now: number): void {
    for (const [key, catalog] of this.catalogs) {
      if (catalog.expiresAt <= now) this.removeCatalog(key)
    }
    for (const [token, entry] of this.entries) {
      const catalog = this.catalogs.get(entry.catalogKey)
      if (
        entry.expiresAt <= now
        || !catalog
        || catalog.generation !== entry.generation
        || !catalog.tokenSet.has(token)
      ) this.entries.delete(token)
    }
  }

  private removeCatalog(key: string): void {
    const catalog = this.catalogs.get(key)
    if (!catalog) return
    this.catalogs.delete(key)
    for (const token of catalog.tokens) {
      const entry = this.entries.get(token)
      if (entry?.catalogKey === key && entry.generation === catalog.generation) {
        this.entries.delete(token)
      }
    }
  }

  private async catalogSourcesAreFresh(catalog: CachedCatalog): Promise<boolean> {
    for (const token of catalog.tokens) {
      const entry = this.entries.get(token)
      if (
        !entry
        || entry.generation !== catalog.generation
        || !catalog.tokenSet.has(token)
        || !await cachedEntrySourceIsFresh(entry)
      ) return false
    }
    return true
  }
}

function parseInspectCatalog(output: unknown): MainAgentDefinition[] {
  if (
    typeof output !== 'string'
    || Buffer.byteLength(output, 'utf8') > GROK_CLI_INSPECT_AGENTS_MAX_OUTPUT_BYTES
  ) {
    throw new GrokAgentCatalogServiceError('invalid-catalog')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new GrokAgentCatalogServiceError('invalid-catalog')
  }
  const root = strictRecord(parsed, undefined)
  const rawAgents = readOwn(root, 'agents')
  if (
    !Array.isArray(rawAgents)
    || rawAgents.length < 1
    || rawAgents.length > GROK_AGENT_CATALOG_LIMIT
  ) {
    throw new GrokAgentCatalogServiceError('invalid-catalog')
  }

  const seenSelectors = new Set<string>()
  return rawAgents.map((rawAgent) => {
    const agent = strictRecord(rawAgent, ['name', 'description', 'source'])
    const selector = requireRawText(readOwn(agent, 'name'), MAX_SELECTOR_BYTES, false)
    const rawName = requireRawText(readOwn(agent, 'name'), MAX_RAW_NAME_BYTES, false)
    const rawDescription = requireRawText(
      readOwn(agent, 'description'),
      MAX_RAW_DESCRIPTION_BYTES,
      true
    )
    if (seenSelectors.has(selector)) throw new GrokAgentCatalogServiceError('invalid-catalog')
    seenSelectors.add(selector)

    const source = parseSource(readOwn(agent, 'source'))
    const name = sanitizeCatalogDisplayText(
      rawName,
      GROK_AGENT_PUBLIC_NAME_MAX_CHARS,
      source.rawSourcePath
    ) || 'Agent'
    const description = sanitizeCatalogDisplayText(
      rawDescription,
      GROK_AGENT_PUBLIC_DESCRIPTION_MAX_CHARS,
      source.rawSourcePath
    )
    return {
      selector,
      semanticKey: definitionSemanticKey(selector, rawDescription, source),
      name,
      description,
      sourceKind: source.sourceKind,
      ...(source.pluginDisplayName ? { pluginDisplayName: source.pluginDisplayName } : {}),
      ...(source.rawSourcePath ? { rawSourcePath: source.rawSourcePath } : {})
    }
  })
}

async function bindAgentSources(
  definitions: readonly MainAgentDefinition[]
): Promise<MainAgentDefinition[]> {
  try {
    return await Promise.all(definitions.map(async (definition) => {
      if (!definition.rawSourcePath) return { ...definition }
      return {
        ...definition,
        sourceIdentityRevision: await readSourceIdentityRevision(definition.rawSourcePath)
      }
    }))
  } catch (error) {
    if (error instanceof GrokAgentCatalogServiceError) throw error
    throw new GrokAgentCatalogServiceError('invalid-catalog')
  }
}

async function agentSourcesAreFresh(
  definitions: readonly MainAgentDefinition[]
): Promise<boolean> {
  for (const definition of definitions) {
    if (!definition.rawSourcePath || !definition.sourceIdentityRevision) continue
    try {
      const current = await readSourceIdentityRevision(definition.rawSourcePath)
      if (!sameFileIdentityRevision(definition.sourceIdentityRevision, current)) return false
    } catch {
      return false
    }
  }
  return true
}

async function cachedEntrySourceIsFresh(entry: CachedAgentEntry): Promise<boolean> {
  if (!entry.rawSourcePath && !entry.sourceIdentityRevision) return true
  if (!entry.rawSourcePath || !entry.sourceIdentityRevision) return false
  try {
    const current = await readSourceIdentityRevision(entry.rawSourcePath)
    return sameFileIdentityRevision(entry.sourceIdentityRevision, current)
  } catch {
    return false
  }
}

async function readSourceIdentityRevision(path: string): Promise<FileIdentityRevision> {
  try {
    const info = await lstat(path, { bigint: true })
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('invalid agent source')
    if (await realpath(path) !== path) throw new Error('non-canonical agent source')
    return {
      device: info.dev,
      inode: info.ino,
      size: info.size,
      modifiedNs: info.mtimeNs,
      changedNs: info.ctimeNs,
      mode: info.mode
    }
  } catch {
    throw new GrokAgentCatalogServiceError('invalid-catalog')
  }
}

function sameFileIdentityRevision(
  left: FileIdentityRevision,
  right: FileIdentityRevision
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNs === right.modifiedNs
    && left.changedNs === right.changedNs
    && left.mode === right.mode
}

function sameDefinitionCatalog(
  left: readonly MainAgentDefinition[],
  right: readonly MainAgentDefinition[]
): boolean {
  return left.length === right.length && left.every((definition, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && definition.semanticKey === candidate.semanticKey
      && sameOptionalFileIdentityRevision(
        definition.sourceIdentityRevision,
        candidate.sourceIdentityRevision
      )
  })
}

function sameOptionalFileIdentityRevision(
  left: FileIdentityRevision | undefined,
  right: FileIdentityRevision | undefined
): boolean {
  if (!left || !right) return left === right
  return sameFileIdentityRevision(left, right)
}

function parseSource(value: unknown): {
  sourceKind: GrokAgentSourceKind
  pluginDisplayName?: string
  rawPluginName?: string
  rawSourcePath?: string
} {
  const loose = strictRecord(value, undefined)
  const type = readOwn(loose, 'type')
  if (type === 'builtin') {
    strictRecord(value, ['type'])
    return { sourceKind: 'builtin' }
  }
  if (type === 'user' || type === 'project') {
    const source = strictRecord(value, ['type', 'path'])
    return {
      sourceKind: type,
      rawSourcePath: requireSourcePath(readOwn(source, 'path'))
    }
  }
  if (type === 'plugin') {
    const source = strictRecord(value, ['type', 'plugin_name', 'path'])
    const rawSourcePath = requireSourcePath(readOwn(source, 'path'))
    const rawPluginName = requireRawText(
      readOwn(source, 'plugin_name'),
      MAX_RAW_PLUGIN_NAME_BYTES,
      false
    )
    const pluginDisplayName = sanitizeCatalogDisplayText(
      rawPluginName,
      GROK_AGENT_PLUGIN_DISPLAY_NAME_MAX_CHARS,
      rawSourcePath
    )
    if (!pluginDisplayName) throw new GrokAgentCatalogServiceError('invalid-catalog')
    return {
      sourceKind: 'plugin',
      pluginDisplayName,
      rawPluginName,
      rawSourcePath
    }
  }
  throw new GrokAgentCatalogServiceError('invalid-catalog')
}

/**
 * Catalog text is CLI-controlled, but the exact definition source path is
 * already available in main. Remove that authority first (including common
 * Unicode normalization variants) so spaces in a path cannot defeat the
 * generic display sanitizer's conservative token heuristics.
 */
function sanitizeCatalogDisplayText(
  value: string,
  maxChars: number,
  rawSourcePath?: string
): string {
  let scrubbed = value
  if (rawSourcePath) {
    for (const candidate of new Set([
      rawSourcePath,
      rawSourcePath.normalize('NFC'),
      rawSourcePath.normalize('NFD')
    ])) {
      if (candidate) scrubbed = scrubbed.split(candidate).join(REDACTED_PATH)
    }
  }
  return sanitizeDisplayTitle(scrubbed, maxChars)
}

function definitionSemanticKey(
  selector: string,
  rawDescription: string,
  source: {
    sourceKind: GrokAgentSourceKind
    rawPluginName?: string
    rawSourcePath?: string
  }
): string {
  return JSON.stringify([
    selector,
    rawDescription,
    source.sourceKind,
    source.rawPluginName ?? null,
    source.rawSourcePath ?? null
  ])
}

async function readBoundContext(
  input: GrokAgentCatalogContext
): Promise<BoundCatalogContext> {
  if (!input || typeof input !== 'object') {
    throw new GrokAgentCatalogServiceError('invalid-context')
  }
  let canonicalCwd: string
  let cliPath: string
  try {
    canonicalCwd = requireContextPath(input.canonicalCwd)
    cliPath = requireContextPath(input.cliPath)
  } catch {
    throw new GrokAgentCatalogServiceError('invalid-context')
  }
  try {
    const cwdInfo = await lstat(canonicalCwd, { bigint: true })
    if (cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory()) throw new Error('invalid cwd')
    if (await realpath(canonicalCwd) !== canonicalCwd) throw new Error('non-canonical cwd')

    const resolvedCliPath = await realpath(cliPath)
    const cliInfo = await stat(resolvedCliPath, { bigint: true })
    if (!cliInfo.isFile()) throw new Error('invalid cli')
    await access(resolvedCliPath, fsConstants.X_OK)
    const cwdIdentity = { device: cwdInfo.dev, inode: cwdInfo.ino }
    const cliIdentityRevision = {
      device: cliInfo.dev,
      inode: cliInfo.ino,
      size: cliInfo.size,
      modifiedNs: cliInfo.mtimeNs,
      changedNs: cliInfo.ctimeNs,
      mode: cliInfo.mode
    }
    return {
      canonicalCwd,
      cwdIdentity,
      resolvedCliPath,
      cliIdentityRevision,
      cacheKey: contextCacheKey(canonicalCwd, cwdIdentity, resolvedCliPath, cliIdentityRevision)
    }
  } catch {
    throw new GrokAgentCatalogServiceError('invalid-context')
  }
}

function contextCacheKey(
  cwd: string,
  cwdIdentity: DirectoryIdentity,
  cliPath: string,
  cli: FileIdentityRevision
): string {
  return [
    cwd,
    cwdIdentity.device,
    cwdIdentity.inode,
    cliPath,
    cli.device,
    cli.inode,
    cli.size,
    cli.modifiedNs,
    cli.changedNs,
    cli.mode
  ].join('\u0000')
}

function sameContext(left: BoundCatalogContext, right: BoundCatalogContext): boolean {
  return left.cacheKey === right.cacheKey
}

function requireContextPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || !isAbsolute(value)
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > MAX_CONTEXT_PATH_BYTES
    || normalize(value) !== value
  ) {
    throw new GrokAgentCatalogServiceError('invalid-context')
  }
  return value
}

function requireSourcePath(value: unknown): string {
  if (
    typeof value !== 'string'
    || !isAbsolute(value)
    || normalize(value) !== value
    || !isSafeRawText(value, MAX_SOURCE_PATH_BYTES, false)
  ) {
    throw new GrokAgentCatalogServiceError('invalid-catalog')
  }
  return value
}

function requireRawText(value: unknown, maxBytes: number, allowEmpty: boolean): string {
  if (!isSafeRawText(value, maxBytes, allowEmpty)) {
    throw new GrokAgentCatalogServiceError('invalid-catalog')
  }
  return value
}

function isSafeRawText(
  value: unknown,
  maxBytes: number,
  allowEmpty: boolean
): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function strictRecord(value: unknown, exactKeys: readonly string[] | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GrokAgentCatalogServiceError('invalid-catalog')
  }
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    throw new GrokAgentCatalogServiceError('invalid-catalog')
  }
  if (exactKeys) {
    const expected = [...exactKeys].sort()
    if (keys.length !== expected.length ||
        !keys.sort().every((key, index) => key === expected[index])) {
      throw new GrokAgentCatalogServiceError('invalid-catalog')
    }
  }
  return value as Record<string, unknown>
}

function readOwn(record: Record<string, unknown>, key: string): unknown {
  try {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
  } catch {
    throw new GrokAgentCatalogServiceError('invalid-catalog')
  }
}

function requireToken(input: GrokAgentCatalogSelectionInput): string {
  let token: unknown
  try {
    token = input?.token
  } catch {
    throw new GrokAgentCatalogServiceError('invalid-token')
  }
  if (typeof token !== 'string' || !GROK_AGENT_VIEW_TOKEN_PATTERN.test(token)) {
    throw new GrokAgentCatalogServiceError('invalid-token')
  }
  return token
}

function requireTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CATALOG_TTL_MS
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CATALOG_TTL_MS) {
    throw new TypeError('Agent catalog TTL must be between 1 ms and 5 minutes.')
  }
  return value
}

function safeNow(now: () => number): number {
  let value: unknown
  try {
    value = now()
  } catch {
    throw new GrokAgentCatalogServiceError('catalog-unavailable')
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GrokAgentCatalogServiceError('catalog-unavailable')
  }
  return value
}

function expiryFrom(now: number, ttlMs: number): number {
  const expiry = now + ttlMs
  if (!Number.isSafeInteger(expiry)) {
    throw new GrokAgentCatalogServiceError('catalog-unavailable')
  }
  return expiry
}

function errorMessage(code: GrokAgentCatalogServiceErrorCode): string {
  switch (code) {
    case 'invalid-context':
      return 'The agent catalog workspace or CLI context is invalid.'
    case 'catalog-unavailable':
      return 'The Grok agent catalog is unavailable.'
    case 'invalid-catalog':
      return 'The Grok agent catalog response is invalid.'
    case 'invalid-token':
      return 'The agent selection expired; refresh the catalog and try again.'
  }
}

function clonePublicCatalog(catalog: PublicGrokAgentCatalog): PublicGrokAgentCatalog {
  const parsed = publicGrokAgentCatalogSchema.safeParse(catalog)
  if (!parsed.success) throw new GrokAgentCatalogServiceError('catalog-unavailable')
  return parsed.data
}
