import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import {
  modelApiBackendSchema,
  publicCustomModelCatalogSchema,
  type PublicCustomModelCatalog
} from '../../shared/modelProviders'

export const MANAGED_TOML_MARKER = 'grokbuild-electron-managed-v1'
export const MANAGED_TOML_BEGIN = `# ${MANAGED_TOML_MARKER}:begin`
export const MANAGED_TOML_END = `# ${MANAGED_TOML_MARKER}:end`
export const MAX_MANAGED_MODEL_PROVIDERS = 32
export const MAX_MANAGED_CUSTOM_MODELS = 128

const managedIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'identifier contains unsupported characters')

const endpointUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username === '' && url.password === '' &&
        url.hash === '' && url.search === ''
    } catch {
      return false
    }
  }, 'endpoint must be an HTTP(S) URL without credentials, query, or fragment')

const environmentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'environment variable name is invalid')

const environmentNamesSchema = z.union([
  environmentNameSchema,
  z.array(environmentNameSchema)
    .min(1)
    .max(8)
    .refine((values) => new Set(values).size === values.length,
      'environment variable names must be unique')
])

const boundedDisplayTextSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => value.trim() === value && !/[\0\r\n]/u.test(value))

const upstreamModelSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !/[\0\r\n]/u.test(value))

const contextWindowSchema = z.number().int().min(1).max(10_000_000)

export const managedModelProviderSchema = z.object({
  id: managedIdentifierSchema,
  baseUrl: endpointUrlSchema,
  apiBaseUrl: endpointUrlSchema.optional(),
  envKey: environmentNamesSchema.optional(),
  apiBackend: modelApiBackendSchema,
  contextWindow: contextWindowSchema
}).strict()

export const managedCustomModelSchema = z.object({
  id: managedIdentifierSchema,
  upstreamModel: upstreamModelSchema,
  name: boundedDisplayTextSchema,
  providerId: managedIdentifierSchema,
  contextWindow: contextWindowSchema,
  supportsReasoningEffort: z.boolean()
}).strict()

export const managedModelCatalogSchema = z.object({
  providers: z.array(managedModelProviderSchema).max(MAX_MANAGED_MODEL_PROVIDERS),
  models: z.array(managedCustomModelSchema).max(MAX_MANAGED_CUSTOM_MODELS)
}).strict()

export type ManagedModelProvider = z.infer<typeof managedModelProviderSchema>
export type ManagedCustomModel = z.infer<typeof managedCustomModelSchema>
export type ManagedModelCatalog = z.infer<typeof managedModelCatalogSchema>

export type ManagedModelConfigMutation =
  | { type: 'upsert-provider'; provider: ManagedModelProvider }
  | { type: 'delete-provider'; providerId: string }
  | { type: 'upsert-model'; model: ManagedCustomModel }
  | { type: 'delete-model'; modelId: string }

export type ManagedTomlErrorCode =
  | 'malformed-toml'
  | 'invalid-managed-block'
  | 'duplicate-managed-entry'
  | 'invalid-reference'
  | 'provider-in-use'
  | 'invalid-mutation'

export class ManagedTomlError extends Error {
  constructor(readonly code: ManagedTomlErrorCode) {
    super(managedTomlErrorMessage(code))
    this.name = 'ManagedTomlError'
  }
}

export interface ParsedManagedToml {
  /** Exact bytes before the managed suffix, represented as a UTF-8 string. */
  unmanagedPrefix: string
  catalog: ManagedModelCatalog
  hasManagedEnvelope: boolean
  newline: '\n' | '\r\n'
}

export interface RewrittenManagedToml {
  text: string
  catalog: ManagedModelCatalog
  changed: boolean
}

/**
 * Parse the whole document for TOML validity, but only interpret our strict,
 * versioned suffix. We deliberately do not deserialize or reserialize any
 * user-owned TOML. The reserved marker may occur only in the canonical suffix,
 * so a marker-shaped line inside a string or a user comment fails closed.
 */
export function parseManagedToml(source: string): ParsedManagedToml {
  if (source.includes('\0')) throw new ManagedTomlError('malformed-toml')
  assertValidToml(source)

  const newline = preferredNewline(source)
  const markerCount = countOccurrences(source, MANAGED_TOML_MARKER)
  if (markerCount === 0) {
    return {
      unmanagedPrefix: source,
      catalog: { providers: [], models: [] },
      hasManagedEnvelope: false,
      newline
    }
  }
  if (markerCount !== 2) throw new ManagedTomlError('invalid-managed-block')

  const lines = scanLines(source)
  const beginLines = lines.filter((line) => line.content === MANAGED_TOML_BEGIN)
  const endLines = lines.filter((line) => line.content === MANAGED_TOML_END)
  if (beginLines.length !== 1 || endLines.length !== 1) {
    throw new ManagedTomlError('invalid-managed-block')
  }
  const begin = beginLines[0]!
  const end = endLines[0]!
  if (begin.start >= end.start || end.end !== source.length || !begin.eol || !end.eol) {
    throw new ManagedTomlError('invalid-managed-block')
  }
  if (begin.eol !== end.eol) throw new ManagedTomlError('invalid-managed-block')

  const envelope = source.slice(begin.start)
  const catalog = parseManagedEnvelope(envelope, begin.eol)
  return {
    unmanagedPrefix: source.slice(0, begin.start),
    catalog,
    hasManagedEnvelope: true,
    newline: begin.eol
  }
}

export function rewriteManagedToml(
  source: string,
  mutation: ManagedModelConfigMutation
): RewrittenManagedToml {
  const current = parseManagedToml(source)
  const catalog = cloneCatalog(current.catalog)
  const unmanagedProviderReferences = collectUnmanagedProviderReferences(current.unmanagedPrefix)

  try {
    applyMutation(catalog, mutation, unmanagedProviderReferences)
  } catch (error) {
    if (error instanceof ManagedTomlError) throw error
    throw new ManagedTomlError('invalid-mutation')
  }
  const validated = validateCatalog(catalog)
  if (sameCatalog(current.catalog, validated)) {
    return { text: source, catalog: cloneCatalog(validated), changed: false }
  }
  const newline = current.newline
  const envelope = renderManagedEnvelope(validated, newline)
  const prefix = current.hasManagedEnvelope
    ? current.unmanagedPrefix
    : `${current.unmanagedPrefix}${separatorBeforeEnvelope(current.unmanagedPrefix, newline)}`
  const text = `${prefix}${envelope}`

  // This catches collisions with user-owned model/model_provider tables and
  // proves that our generated suffix remains a valid part of the whole file.
  assertValidToml(text)
  const verified = parseManagedToml(text)
  if (!sameCatalog(verified.catalog, validated)) {
    throw new ManagedTomlError('invalid-managed-block')
  }
  return { text, catalog: cloneCatalog(validated), changed: text !== source }
}

export function renderManagedEnvelope(
  catalog: ManagedModelCatalog,
  newline: '\n' | '\r\n' = '\n'
): string {
  const validated = validateCatalog(catalog)
  const sections = [
    ...validated.providers
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map(renderProviderSection),
    ...validated.models
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map(renderModelSection)
  ]
  const lines = [MANAGED_TOML_BEGIN]
  sections.forEach((section, index) => {
    if (index > 0) lines.push('')
    lines.push(...section)
  })
  lines.push(MANAGED_TOML_END, '')
  return lines.join(newline)
}

/**
 * Produce the only catalog shape that may cross the main/renderer boundary.
 * Environment variable names and every credential value are intentionally
 * absent. Callers can report availability without revealing the variable.
 */
export function projectPublicModelCatalog(
  catalog: ManagedModelCatalog,
  options: {
    environmentAvailable?: ((name: string) => boolean) | undefined
    defaultModelId?: string | undefined
  } = {}
): PublicCustomModelCatalog {
  const validated = validateCatalog(catalog)
  const providersById = new Map(validated.providers.map((provider) => [provider.id, provider]))
  const modelsPerProvider = new Map<string, number>()
  for (const model of validated.models) {
    modelsPerProvider.set(model.providerId, (modelsPerProvider.get(model.providerId) ?? 0) + 1)
  }
  return publicCustomModelCatalogSchema.parse({
    providers: validated.providers
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((provider) => {
        const environmentNames = provider.envKey === undefined
          ? []
          : Array.isArray(provider.envKey) ? provider.envKey : [provider.envKey]
        const credentialAvailable = environmentNames.length === 0 ||
          (options.environmentAvailable !== undefined &&
            environmentNames.some((name) => options.environmentAvailable!(name)))
        return {
          id: provider.id,
          name: provider.id,
          endpointClass: classifyEndpoint(provider.baseUrl),
          originRedacted: redactedOrigin(provider.baseUrl),
          backend: provider.apiBackend,
          credentialState: environmentNames.length > 0 ? 'environment' : 'none',
          isManagedCursor: provider.id === 'cursor',
          modelCount: modelsPerProvider.get(provider.id) ?? 0,
          status: credentialAvailable ? 'configured' : 'unavailable'
        }
      }),
    models: validated.models
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((model) => ({
        id: model.id,
        upstreamModel: model.upstreamModel,
        name: model.name,
        providerId: model.providerId,
        backend: providersById.get(model.providerId)!.apiBackend,
        contextWindow: model.contextWindow,
        supportsReasoningEffort: model.supportsReasoningEffort,
        isDefault: model.id === options.defaultModelId
      }))
  })
}

function parseManagedEnvelope(envelope: string, newline: '\n' | '\r\n'): ManagedModelCatalog {
  // Reject mixed line endings and an unterminated marker line by requiring the
  // envelope to round-trip through our exact line representation.
  const lines = envelope.split(newline)
  if (lines.at(0) !== MANAGED_TOML_BEGIN || lines.at(-2) !== MANAGED_TOML_END ||
      lines.at(-1) !== '') {
    throw new ManagedTomlError('invalid-managed-block')
  }
  const body = lines.slice(1, -2)
  const sections: string[][] = []
  let current: string[] = []
  for (const line of body) {
    if (line === '') {
      if (current.length === 0) throw new ManagedTomlError('invalid-managed-block')
      sections.push(current)
      current = []
      continue
    }
    current.push(line)
  }
  if (current.length > 0) sections.push(current)

  const providers: ManagedModelProvider[] = []
  const models: ManagedCustomModel[] = []
  const identities = new Set<string>()
  for (const section of sections) {
    const header = section[0]
    const providerMatch = /^\[model_providers\.([a-z0-9][a-z0-9_-]*)\]$/u.exec(header ?? '')
    const modelMatch = /^\[model\.([a-z0-9][a-z0-9_-]*)\]$/u.exec(header ?? '')
    if (!providerMatch && !modelMatch) throw new ManagedTomlError('invalid-managed-block')
    const kind = providerMatch ? 'provider' : 'model'
    const id = (providerMatch ?? modelMatch)![1]!
    const identity = `${kind}:${id}`
    if (identities.has(identity)) throw new ManagedTomlError('duplicate-managed-entry')
    identities.add(identity)
    if (kind === 'provider') providers.push(parseProviderSection(id, section.slice(1)))
    else models.push(parseModelSection(id, section.slice(1)))
  }

  const catalog = validateCatalog({ providers, models })
  if (renderManagedEnvelope(catalog, newline) !== envelope) {
    throw new ManagedTomlError('invalid-managed-block')
  }
  return catalog
}

function parseProviderSection(id: string, lines: string[]): ManagedModelProvider {
  const values = parseAssignments(lines, new Set([
    'base_url', 'api_base_url', 'env_key', 'api_backend', 'context_window'
  ]))
  const candidate: Record<string, unknown> = {
    id,
    baseUrl: parseCanonicalString(required(values, 'base_url')),
    apiBackend: parseCanonicalString(required(values, 'api_backend')),
    contextWindow: parseCanonicalInteger(required(values, 'context_window'))
  }
  const apiBaseUrl = values.get('api_base_url')
  const envKey = values.get('env_key')
  if (apiBaseUrl !== undefined) candidate.apiBaseUrl = parseCanonicalString(apiBaseUrl)
  if (envKey !== undefined) candidate.envKey = parseCanonicalEnvironmentNames(envKey)
  try {
    return managedModelProviderSchema.parse(candidate)
  } catch {
    throw new ManagedTomlError('invalid-managed-block')
  }
}

function parseModelSection(id: string, lines: string[]): ManagedCustomModel {
  const values = parseAssignments(lines, new Set([
    'model', 'name', 'model_provider', 'context_window', 'supports_reasoning_effort'
  ]))
  try {
    return managedCustomModelSchema.parse({
      id,
      upstreamModel: parseCanonicalString(required(values, 'model')),
      name: parseCanonicalString(required(values, 'name')),
      providerId: parseCanonicalString(required(values, 'model_provider')),
      contextWindow: parseCanonicalInteger(required(values, 'context_window')),
      supportsReasoningEffort: parseCanonicalBoolean(required(values, 'supports_reasoning_effort'))
    })
  } catch (error) {
    if (error instanceof ManagedTomlError) throw error
    throw new ManagedTomlError('invalid-managed-block')
  }
}

function parseAssignments(lines: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of lines) {
    const match = /^([a-z_]+) = (.+)$/u.exec(line)
    if (!match) throw new ManagedTomlError('invalid-managed-block')
    const key = match[1]!
    if (!allowed.has(key) || values.has(key)) {
      throw new ManagedTomlError(values.has(key)
        ? 'duplicate-managed-entry'
        : 'invalid-managed-block')
    }
    values.set(key, match[2]!)
  }
  return values
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)
  if (value === undefined) throw new ManagedTomlError('invalid-managed-block')
  return value
}

function parseCanonicalString(source: string): string {
  try {
    const parsed = JSON.parse(source) as unknown
    if (typeof parsed !== 'string' || JSON.stringify(parsed) !== source) {
      throw new ManagedTomlError('invalid-managed-block')
    }
    return parsed
  } catch (error) {
    if (error instanceof ManagedTomlError) throw error
    throw new ManagedTomlError('invalid-managed-block')
  }
}

function parseCanonicalEnvironmentNames(source: string): string | string[] {
  try {
    const parsed = JSON.parse(source) as unknown
    if ((typeof parsed !== 'string' && !Array.isArray(parsed)) ||
        JSON.stringify(parsed) !== source) {
      throw new ManagedTomlError('invalid-managed-block')
    }
    return environmentNamesSchema.parse(parsed)
  } catch (error) {
    if (error instanceof ManagedTomlError) throw error
    throw new ManagedTomlError('invalid-managed-block')
  }
}

function parseCanonicalInteger(source: string): number {
  if (!/^[1-9][0-9]*$/u.test(source)) throw new ManagedTomlError('invalid-managed-block')
  const value = Number(source)
  if (!Number.isSafeInteger(value)) throw new ManagedTomlError('invalid-managed-block')
  return value
}

function parseCanonicalBoolean(source: string): boolean {
  if (source === 'true') return true
  if (source === 'false') return false
  throw new ManagedTomlError('invalid-managed-block')
}

function renderProviderSection(provider: ManagedModelProvider): string[] {
  const lines = [
    `[model_providers.${provider.id}]`,
    `base_url = ${JSON.stringify(provider.baseUrl)}`
  ]
  if (provider.apiBaseUrl) lines.push(`api_base_url = ${JSON.stringify(provider.apiBaseUrl)}`)
  if (provider.envKey) lines.push(`env_key = ${JSON.stringify(provider.envKey)}`)
  lines.push(
    `api_backend = ${JSON.stringify(provider.apiBackend)}`,
    `context_window = ${provider.contextWindow}`
  )
  return lines
}

function renderModelSection(model: ManagedCustomModel): string[] {
  return [
    `[model.${model.id}]`,
    `model = ${JSON.stringify(model.upstreamModel)}`,
    `name = ${JSON.stringify(model.name)}`,
    `model_provider = ${JSON.stringify(model.providerId)}`,
    `context_window = ${model.contextWindow}`,
    `supports_reasoning_effort = ${model.supportsReasoningEffort}`
  ]
}

function validateCatalog(input: ManagedModelCatalog): ManagedModelCatalog {
  let catalog: ManagedModelCatalog
  try {
    catalog = managedModelCatalogSchema.parse(input)
  } catch {
    throw new ManagedTomlError('invalid-mutation')
  }
  const providers = new Set<string>()
  for (const provider of catalog.providers) {
    if (providers.has(provider.id)) throw new ManagedTomlError('duplicate-managed-entry')
    providers.add(provider.id)
  }
  const models = new Set<string>()
  for (const model of catalog.models) {
    if (models.has(model.id)) throw new ManagedTomlError('duplicate-managed-entry')
    models.add(model.id)
    if (!providers.has(model.providerId)) throw new ManagedTomlError('invalid-reference')
  }
  return cloneCatalog(catalog)
}

function applyMutation(
  catalog: ManagedModelCatalog,
  mutation: ManagedModelConfigMutation,
  unmanagedProviderReferences: ReadonlySet<string>
): void {
  switch (mutation.type) {
    case 'upsert-provider': {
      let provider: ManagedModelProvider
      try {
        provider = managedModelProviderSchema.parse(mutation.provider)
      } catch {
        throw new ManagedTomlError('invalid-mutation')
      }
      const index = catalog.providers.findIndex((candidate) => candidate.id === provider.id)
      if (index < 0) catalog.providers.push(provider)
      else catalog.providers[index] = provider
      return
    }
    case 'delete-provider': {
      const id = parseManagedIdentifier(mutation.providerId)
      const isManagedProvider = catalog.providers.some((provider) => provider.id === id)
      if (isManagedProvider &&
          (catalog.models.some((model) => model.providerId === id) ||
            unmanagedProviderReferences.has(id))) {
        throw new ManagedTomlError('provider-in-use')
      }
      catalog.providers = catalog.providers.filter((provider) => provider.id !== id)
      return
    }
    case 'upsert-model': {
      let model: ManagedCustomModel
      try {
        model = managedCustomModelSchema.parse(mutation.model)
      } catch {
        throw new ManagedTomlError('invalid-mutation')
      }
      if (!catalog.providers.some((provider) => provider.id === model.providerId)) {
        throw new ManagedTomlError('invalid-reference')
      }
      const index = catalog.models.findIndex((candidate) => candidate.id === model.id)
      if (index < 0) catalog.models.push(model)
      else catalog.models[index] = model
      return
    }
    case 'delete-model': {
      const id = parseManagedIdentifier(mutation.modelId)
      catalog.models = catalog.models.filter((model) => model.id !== id)
      return
    }
    default:
      throw new ManagedTomlError('invalid-mutation')
  }
}

function parseManagedIdentifier(value: string): string {
  try {
    return managedIdentifierSchema.parse(value)
  } catch {
    throw new ManagedTomlError('invalid-mutation')
  }
}

function assertValidToml(source: string): void {
  try {
    parseToml(source, { maxDepth: 128 })
  } catch {
    throw new ManagedTomlError('malformed-toml')
  }
}

function collectUnmanagedProviderReferences(source: string): ReadonlySet<string> {
  let parsed: unknown
  try {
    parsed = parseToml(source, { maxDepth: 128 }) as unknown
  } catch {
    throw new ManagedTomlError('malformed-toml')
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, 'model')) return new Set()

  const references = new Set<string>()
  const pending: unknown[] = [parsed.model]
  while (pending.length > 0) {
    const value = pending.pop()
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    if (!isRecord(value)) continue
    if (typeof value.model_provider === 'string') references.add(value.model_provider)
    pending.push(...Object.values(value))
  }
  return references
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function separatorBeforeEnvelope(source: string, newline: '\n' | '\r\n'): string {
  if (source.length === 0 || source.endsWith('\n')) return ''
  return newline
}

function preferredNewline(source: string): '\n' | '\r\n' {
  const first = source.indexOf('\n')
  return first > 0 && source[first - 1] === '\r' ? '\r\n' : '\n'
}

interface ScannedLine {
  start: number
  end: number
  content: string
  eol: '' | '\n' | '\r\n'
}

function scanLines(source: string): ScannedLine[] {
  const lines: ScannedLine[] = []
  let start = 0
  while (start < source.length) {
    const newline = source.indexOf('\n', start)
    if (newline < 0) {
      lines.push({ start, end: source.length, content: source.slice(start), eol: '' })
      break
    }
    const crlf = newline > start && source[newline - 1] === '\r'
    lines.push({
      start,
      end: newline + 1,
      content: source.slice(start, crlf ? newline - 1 : newline),
      eol: crlf ? '\r\n' : '\n'
    })
    start = newline + 1
  }
  return lines
}

function countOccurrences(source: string, value: string): number {
  let count = 0
  let offset = 0
  while (true) {
    const found = source.indexOf(value, offset)
    if (found < 0) return count
    count += 1
    offset = found + value.length
  }
}

function cloneCatalog(catalog: ManagedModelCatalog): ManagedModelCatalog {
  return structuredClone(catalog)
}

function sameCatalog(left: ManagedModelCatalog, right: ManagedModelCatalog): boolean {
  return JSON.stringify(normalizedCatalog(left)) === JSON.stringify(normalizedCatalog(right))
}

function normalizedCatalog(catalog: ManagedModelCatalog): ManagedModelCatalog {
  return {
    providers: catalog.providers.toSorted((left, right) => left.id.localeCompare(right.id)),
    models: catalog.models.toSorted((left, right) => left.id.localeCompare(right.id))
  }
}

function redactedOrigin(value: string): string {
  const url = new URL(value)
  return `${url.protocol}//${url.hostname}`
}

function classifyEndpoint(value: string): 'loopback' | 'lan' | 'remote' {
  let hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  hostname = hostname.replace(/\.+$/u, '')
  const mappedIpv4 = ipv4FromMappedIpv6(hostname)
  if (mappedIpv4) hostname = mappedIpv4
  if (hostname === 'localhost' || hostname === '::1' || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)) {
    return 'loopback'
  }
  if (/^10(?:\.[0-9]{1,3}){3}$/u.test(hostname) ||
      /^192\.168(?:\.[0-9]{1,3}){2}$/u.test(hostname) ||
      /^172\.(?:1[6-9]|2[0-9]|3[01])(?:\.[0-9]{1,3}){2}$/u.test(hostname) ||
      /^169\.254(?:\.[0-9]{1,3}){2}$/u.test(hostname) ||
      /^f[cd][0-9a-f:]+$/u.test(hostname) || /^fe[89ab][0-9a-f:]+$/u.test(hostname)) {
    return 'lan'
  }
  return 'remote'
}

function ipv4FromMappedIpv6(hostname: string): string | undefined {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(hostname)
  if (!match) return undefined
  const high = Number.parseInt(match[1]!, 16)
  const low = Number.parseInt(match[2]!, 16)
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}

function managedTomlErrorMessage(code: ManagedTomlErrorCode): string {
  switch (code) {
    case 'malformed-toml': return 'The Grok configuration is malformed.'
    case 'invalid-managed-block': return 'The managed model block is invalid.'
    case 'duplicate-managed-entry': return 'The managed model block contains a duplicate entry.'
    case 'invalid-reference': return 'A managed model references an unavailable provider.'
    case 'provider-in-use': return 'The provider is still used by a managed model.'
    case 'invalid-mutation': return 'The managed model change is invalid.'
  }
}
