import { z } from 'zod'

export const MCP_MAX_ARGUMENTS = 128
export const MCP_MAX_ENVIRONMENT_ENTRIES = 32
export const MCP_MAX_HEADER_ENTRIES = 32

const boundedCwd = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes('\0'), 'cwd contains an invalid character')

export const mcpScopeSchema = z.enum(['user', 'project'])
export const mcpTransportSchema = z.enum(['stdio', 'http', 'sse'])

export const mcpServerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'server name contains unsupported characters')

const commandSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.trim() === value, 'command must not have surrounding whitespace')
  .refine((value) => !/[\0\r\n]/u.test(value), 'command contains an invalid character')

const argumentSchema = z
  .string()
  .max(8_192)
  .refine((value) => !value.includes('\0'), 'argument contains an invalid character')

const environmentEntrySchema = z.object({
  name: z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  value: z.string().max(16_384).refine((value) => !value.includes('\0'))
}).strict()

const headerEntrySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'invalid HTTP header name'),
  value: z.string().max(16_384).refine((value) => !/[\0\r\n]/u.test(value))
}).strict()

const remoteUrlSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username === '' && url.password === ''
    } catch {
      return false
    }
  }, 'remote MCP URL must be HTTP(S) and must not contain credentials')

const namedRequestBase = { name: mcpServerNameSchema } as const

const stdioAddFields = {
  ...namedRequestBase,
  scope: mcpScopeSchema,
  transport: z.literal('stdio'),
  command: commandSchema,
  args: z.array(argumentSchema).max(MCP_MAX_ARGUMENTS).default([]),
  environment: z.array(environmentEntrySchema).max(MCP_MAX_ENVIRONMENT_ENTRIES).default([])
} as const

const remoteAddFields = {
  ...namedRequestBase,
  scope: mcpScopeSchema,
  transport: z.enum(['http', 'sse']),
  url: remoteUrlSchema,
  headers: z.array(headerEntrySchema).max(MCP_MAX_HEADER_ENTRIES).default([])
} as const

export const mcpListInputSchema = z.object({ cwd: boundedCwd }).strict()

export const mcpAddRequestSchema = z
  .discriminatedUnion('transport', [
    z.object(stdioAddFields).strict(),
    z.object(remoteAddFields).strict()
  ])
  .refine(addRequestSizeValid, 'MCP add request is too large')

export const mcpAddInputSchema = z
  .discriminatedUnion('transport', [
    z.object({ cwd: boundedCwd, ...stdioAddFields }).strict(),
    z.object({ cwd: boundedCwd, ...remoteAddFields }).strict()
  ])
  .refine(addRequestSizeValid, 'MCP add request is too large')

export const mcpRemoveRequestSchema = z.object({
  ...namedRequestBase,
  scope: mcpScopeSchema
}).strict()

export const mcpRemoveInputSchema = z.object({
  cwd: boundedCwd,
  ...namedRequestBase,
  scope: mcpScopeSchema
}).strict()

export const mcpToggleRequestSchema = z.object(namedRequestBase).strict()

export const mcpToggleInputSchema = z.object({
  cwd: boundedCwd,
  ...namedRequestBase
}).strict()

export const mcpDoctorRequestSchema = z.object({
  name: mcpServerNameSchema.optional(),
  confirmExternalLaunch: z.literal(true)
}).strict()

export const mcpDoctorInputSchema = z.object({
  cwd: boundedCwd,
  name: mcpServerNameSchema.optional(),
  confirmExternalLaunch: z.literal(true)
}).strict()

export type McpScope = z.infer<typeof mcpScopeSchema>
export type McpTransport = z.infer<typeof mcpTransportSchema>
export type McpListInput = z.infer<typeof mcpListInputSchema>
export type McpAddRequest = z.infer<typeof mcpAddRequestSchema>
export type McpAddInput = z.infer<typeof mcpAddInputSchema>
export type McpRemoveRequest = z.infer<typeof mcpRemoveRequestSchema>
export type McpRemoveInput = z.infer<typeof mcpRemoveInputSchema>
export type McpToggleRequest = z.infer<typeof mcpToggleRequestSchema>
export type McpToggleInput = z.infer<typeof mcpToggleInputSchema>
export type McpDoctorRequest = z.infer<typeof mcpDoctorRequestSchema>
export type McpDoctorInput = z.infer<typeof mcpDoctorInputSchema>

export type McpSummaryTransport = McpTransport | 'unknown'
export type McpSummaryScope = McpScope | 'unknown'
export type McpSourceKind =
  | 'grok-user'
  | 'grok-project'
  | 'claude'
  | 'cursor'
  | 'mcp-json'
  | 'plugin'
  | 'other'

export interface McpServerSummary {
  name: string
  scope: McpSummaryScope
  enabled: boolean
  transport: McpSummaryTransport
  targetRedacted: string
  hasEnvironment: boolean
  hasHeaders: boolean
}

export interface McpListResult {
  servers: McpServerSummary[]
}

export interface McpMutationResult {
  ok: true
}

export type McpDoctorSourceStatus = 'found' | 'not-found' | 'skipped' | 'unknown'

export interface McpDoctorSourceSummary {
  source: McpSourceKind
  status: McpDoctorSourceStatus
  serverCount?: number | undefined
}

export type McpDoctorCheckKind = 'command' | 'start' | 'handshake' | 'tools-list' | 'other'

export interface McpDoctorCheckSummary {
  kind: McpDoctorCheckKind
  passed: boolean
}

export interface McpDoctorServerSummary {
  name: string
  transport: McpSummaryTransport
  targetRedacted: string
  source: McpSourceKind
  checks: McpDoctorCheckSummary[]
  healthy: boolean
}

export interface McpDoctorResult {
  sources: McpDoctorSourceSummary[]
  servers: McpDoctorServerSummary[]
  healthyCount: number
  failingCount: number
}

function addRequestSizeValid(input: {
  transport: 'stdio'
  args: string[]
  environment: Array<{ name: string; value: string }>
} | {
  transport: 'http' | 'sse'
  headers: Array<{ name: string; value: string }>
}): boolean {
  if (input.transport === 'stdio') {
    return input.args.reduce((size, value) => size + value.length, 0) <= 128 * 1_024 &&
      input.environment.reduce((size, entry) => size + entry.name.length + entry.value.length, 0) <=
        128 * 1_024
  }
  return input.headers.reduce(
    (size, entry) => size + entry.name.length + entry.value.length,
    0
  ) <= 128 * 1_024
}
