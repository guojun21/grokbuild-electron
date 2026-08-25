import { z } from 'zod'
import {
  mcpAddInputSchema,
  mcpDoctorInputSchema,
  mcpListInputSchema,
  mcpRemoveInputSchema,
  mcpServerNameSchema,
  mcpToggleInputSchema,
  type McpDoctorCheckKind,
  type McpDoctorResult,
  type McpDoctorSourceStatus,
  type McpListResult,
  type McpMutationResult,
  type McpServerSummary,
  type McpSourceKind,
  type McpSummaryScope,
  type McpSummaryTransport
} from '../../shared/mcp'
import { GrokCliService } from '../grok/GrokCliService'

const MAX_LIST_SERVERS = 512
const MAX_DOCTOR_SOURCES = 256
const MAX_DOCTOR_SERVERS = 512
const MAX_DOCTOR_CHECKS = 32

export type McpServiceErrorCode = 'invalid-input' | 'cli-failed' | 'invalid-cli-output'

export class McpServiceError extends Error {
  constructor(
    readonly code: McpServiceErrorCode,
    readonly operation: 'list' | 'add' | 'remove' | 'enable' | 'disable' | 'doctor'
  ) {
    super(code === 'invalid-input'
      ? `Invalid MCP ${operation} request`
      : code === 'invalid-cli-output'
        ? `Grok CLI returned an invalid MCP ${operation} response`
        : `Grok CLI MCP ${operation} failed`)
    this.name = 'McpServiceError'
  }
}

/**
 * Main-process-only MCP facade. Raw CLI JSON, stdout, stderr, environment
 * values, headers, OAuth metadata, arguments, and filesystem paths never
 * cross this class's public result boundary.
 */
export class McpService {
  constructor(private readonly cli: GrokCliService) {}

  async list(rawInput: unknown): Promise<McpListResult> {
    const input = parseInput(mcpListInputSchema, rawInput, 'list')
    const rawJson = await this.callCli('list', () => this.cli.listMcp(input.cwd))
    try {
      return sanitizeList(parseJson(rawJson))
    } catch {
      throw new McpServiceError('invalid-cli-output', 'list')
    }
  }

  async add(rawInput: unknown): Promise<McpMutationResult> {
    const input = parseInput(mcpAddInputSchema, rawInput, 'add')
    await this.callCli('add', () => this.cli.addMcp(input))
    return { ok: true }
  }

  async remove(rawInput: unknown): Promise<McpMutationResult> {
    const input = parseInput(mcpRemoveInputSchema, rawInput, 'remove')
    await this.callCli('remove', () => this.cli.removeMcp(input))
    return { ok: true }
  }

  async enable(rawInput: unknown): Promise<McpMutationResult> {
    const input = parseInput(mcpToggleInputSchema, rawInput, 'enable')
    await this.callCli('enable', () => this.cli.enableMcp(input))
    return { ok: true }
  }

  async disable(rawInput: unknown): Promise<McpMutationResult> {
    const input = parseInput(mcpToggleInputSchema, rawInput, 'disable')
    await this.callCli('disable', () => this.cli.disableMcp(input))
    return { ok: true }
  }

  async doctor(rawInput: unknown): Promise<McpDoctorResult> {
    // The literal true is intentionally part of the strict wire schema. Doctor
    // launches configured external commands and must never be an implicit probe.
    const input = parseInput(mcpDoctorInputSchema, rawInput, 'doctor')
    const rawJson = await this.callCli(
      'doctor',
      () => this.cli.doctorMcp(input.cwd, input.name)
    )
    try {
      return sanitizeDoctor(parseJson(rawJson))
    } catch {
      throw new McpServiceError('invalid-cli-output', 'doctor')
    }
  }

  private async callCli<T>(
    operation: McpServiceError['operation'],
    call: () => Promise<T>
  ): Promise<T> {
    try {
      return await call()
    } catch {
      // Do not preserve the cause: injected runners and CLI errors may carry
      // stderr, complete argv, environment values, or remote credentials.
      throw new McpServiceError('cli-failed', operation)
    }
  }
}

function parseInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  operation: McpServiceError['operation']
): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new McpServiceError('invalid-input', operation)
  return result.data
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

function sanitizeList(value: unknown): McpListResult {
  if (!Array.isArray(value) || value.length > MAX_LIST_SERVERS) throw new Error('invalid list')
  const servers: McpServerSummary[] = []
  for (const candidate of value) {
    const record = asRecord(candidate)
    if (!record) throw new Error('invalid server')
    servers.push(sanitizeServer(record))
  }
  return { servers }
}

function sanitizeServer(record: Record<string, unknown>): McpServerSummary {
  const command = stringValue(record.command)
  const url = stringValue(record.url)
  const transport: McpSummaryTransport = command !== undefined
    ? 'stdio'
    : url !== undefined
      ? stringValue(record.type)?.toLowerCase() === 'sse' ? 'sse' : 'http'
      : 'unknown'
  return {
    name: safeServerName(record.name),
    scope: safeScope(record.scope),
    enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
    transport,
    targetRedacted: redactTarget(transport, transport === 'stdio' ? command : url),
    hasEnvironment: hasOwnEntries(record.env),
    hasHeaders: hasOwnEntries(record.headers)
  }
}

function sanitizeDoctor(value: unknown): McpDoctorResult {
  const report = asRecord(value)
  if (!report) throw new Error('invalid doctor report')
  const rawSources = arrayValue(report.sources, MAX_DOCTOR_SOURCES)
  const rawServers = arrayValue(report.servers, MAX_DOCTOR_SERVERS)

  const sources = rawSources.map((candidate) => {
    const record = asRecord(candidate)
    if (!record) throw new Error('invalid doctor source')
    const statusRecord = asRecord(record.status)
    const sourceStatus = stringValue(statusRecord?.status) ?? stringValue(record.status)
    const serverCount = safeCount(statusRecord?.server_count)
    return {
      source: sourceKind(stringValue(record.path)),
      status: doctorSourceStatus(sourceStatus),
      ...(serverCount === undefined ? {} : { serverCount })
    }
  })

  const servers = rawServers.map((candidate) => {
    const record = asRecord(candidate)
    if (!record) throw new Error('invalid doctor server')
    const transport = doctorTransport(record.transport)
    const rawChecks = arrayValue(record.checks, MAX_DOCTOR_CHECKS)
    return {
      name: safeServerName(record.name),
      transport,
      targetRedacted: redactTarget(transport, stringValue(record.target)),
      source: sourceKind(stringValue(record.source)),
      checks: rawChecks.map((rawCheck) => {
        const check = asRecord(rawCheck)
        if (!check) throw new Error('invalid doctor check')
        return {
          kind: doctorCheckKind(stringValue(check.label)),
          passed: check.passed === true
        }
      }),
      healthy: record.healthy === true
    }
  })

  return {
    sources,
    servers,
    healthyCount: servers.filter((server) => server.healthy).length,
    failingCount: servers.filter((server) => !server.healthy).length
  }
}

function redactTarget(
  transport: McpSummaryTransport,
  rawTarget: string | undefined
): string {
  if (transport === 'stdio') return '[stdio command]'
  if (transport !== 'http' && transport !== 'sse') return '[MCP target]'
  if (rawTarget === undefined) return '[remote endpoint]'
  try {
    const url = new URL(rawTarget)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[remote endpoint]'
    // URL.origin excludes credentials, pathname, query, and fragment. Paths can
    // contain bearer material just as readily as query strings.
    return url.origin
  } catch {
    return '[remote endpoint]'
  }
}

function doctorTransport(value: unknown): McpSummaryTransport {
  const normalized = stringValue(value)?.toLowerCase()
  if (normalized?.includes('stdio')) return 'stdio'
  if (normalized?.includes('sse')) return 'sse'
  if (normalized?.includes('http')) return 'http'
  return 'unknown'
}

function sourceKind(rawSource: string | undefined): McpSourceKind {
  if (!rawSource) return 'other'
  const source = rawSource.toLowerCase()
  if (source.includes('claude')) return 'claude'
  if (source.includes('cursor')) return 'cursor'
  if (source.includes('.mcp.json') || source === 'mcp.json') return 'mcp-json'
  if (source.includes('plugin')) return 'plugin'
  if (source.includes('~/.grok/config.toml') || source === 'config.toml') return 'grok-user'
  if (source.includes('project') || source.includes('/.grok/config.toml')) return 'grok-project'
  return 'other'
}

function doctorSourceStatus(rawStatus: string | undefined): McpDoctorSourceStatus {
  switch (rawStatus?.toLowerCase()) {
    case 'found':
      return 'found'
    case 'not_found':
    case 'not-found':
      return 'not-found'
    case 'skipped':
      return 'skipped'
    default:
      return 'unknown'
  }
}

function doctorCheckKind(rawLabel: string | undefined): McpDoctorCheckKind {
  const label = rawLabel?.toLowerCase() ?? ''
  if (label.includes('command')) return 'command'
  if (label.includes('server start') || label.includes('failed to start')) return 'start'
  if (label.includes('handshake')) return 'handshake'
  if (label.includes('tool')) return 'tools-list'
  return 'other'
}

function safeServerName(value: unknown): string {
  const result = mcpServerNameSchema.safeParse(value)
  return result.success ? result.data : '[invalid-name]'
}

function safeScope(value: unknown): McpSummaryScope {
  return value === 'user' || value === 'project' ? value : 'unknown'
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function hasOwnEntries(value: unknown): boolean {
  const record = asRecord(value)
  return record !== undefined && Object.keys(record).length > 0
}

function arrayValue(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('invalid array')
  return value
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
