import { spawn, type ChildProcess } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  McpAddInput,
  McpRemoveInput,
  McpToggleInput
} from '../../shared/mcp'

export const GROK_CLI_DEFAULT_TIMEOUT_MS = 20_000
export const GROK_CLI_DOCTOR_TIMEOUT_MS = 120_000
export const GROK_CLI_UPDATE_INSTALL_TIMEOUT_MS = 10 * 60_000
export const GROK_CLI_DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
export const GROK_CLI_INSPECT_AGENTS_MAX_OUTPUT_BYTES = 256 * 1024
export const GROK_CLI_DEFAULT_TERMINATE_GRACE_MS = 1_000
export const GROK_CLI_SESSION_HISTORY_LIMIT = 50

const GROK_CLI_SESSION_QUERY_MAX_BYTES = 256
const GROK_CLI_SESSION_SUMMARY_MAX_BYTES = 1_024
const GROK_CLI_SESSION_STATUS_MAX_BYTES = 32
const GROK_CLI_SESSION_HISTORY_MAX_OUTPUT_BYTES = 256 * 1_024
const GROK_CLI_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const GROK_CLI_SESSION_HEADER_PATTERN = /^SESSION ID +CREATED +UPDATED +STATUS +SUMMARY *$/
const GROK_CLI_SESSION_ROW_PATTERN = /^([^\s]+) {2,}(\S+) {2,}(\S+) {2,}(\S+) {2,}(.*)$/u

export type GrokCliOperation =
  | 'version-check'
  | 'update-check'
  | 'update-install'
  | 'sessions-list'
  | 'sessions-search'
  | 'sessions-delete'
  | 'inspect-agents'
  | 'mcp-list'
  | 'mcp-add'
  | 'mcp-remove'
  | 'mcp-enable'
  | 'mcp-disable'
  | 'mcp-doctor'

export type GrokCliRunFailureKind = 'spawn' | 'timeout' | 'output-limit'

export interface GrokCliRunRequest {
  executable: string
  args: readonly string[]
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  terminateGraceMs: number
}

export interface GrokCliRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface GrokCliProcessRunner {
  run(request: GrokCliRunRequest): Promise<GrokCliRunResult>
}

export class GrokCliRunError extends Error {
  constructor(readonly kind: GrokCliRunFailureKind) {
    super(kind === 'timeout'
      ? 'Grok CLI operation timed out'
      : kind === 'output-limit'
        ? 'Grok CLI output limit exceeded'
        : 'Grok CLI process could not be started')
    this.name = 'GrokCliRunError'
  }
}

export type GrokCliServiceErrorCode =
  | 'invalid-cli'
  | 'invalid-cwd'
  | 'invalid-version'
  | 'invalid-query'
  | 'invalid-session-id'
  | 'invalid-output'
  | 'spawn-failed'
  | 'timeout'
  | 'output-limit'
  | 'command-failed'

export class GrokCliServiceError extends Error {
  constructor(
    readonly code: GrokCliServiceErrorCode,
    readonly operation: GrokCliOperation,
    readonly exitCode?: number | undefined
  ) {
    super(serviceErrorMessage(code, operation, exitCode))
    this.name = 'GrokCliServiceError'
  }
}

export interface GrokCliServiceOptions {
  cliPath: string
  runner?: GrokCliProcessRunner | undefined
  timeoutMs?: number | undefined
  doctorTimeoutMs?: number | undefined
  updateInstallTimeoutMs?: number | undefined
  maxOutputBytes?: number | undefined
  terminateGraceMs?: number | undefined
}

/** Bounded data projected from the human-readable Grok 1.0.5 sessions table. */
export interface GrokCliSessionHistoryRecord {
  remoteId: string
  summary: string
  status: string
  created: string
  updated: string
}

/**
 * Runs a bounded child process without a shell. This is exported so tests and
 * integration layers can inject the same narrow process boundary; callers
 * should use GrokCliService's fixed methods rather than invoking it directly.
 */
export class NodeGrokCliProcessRunner implements GrokCliProcessRunner {
  async run(request: GrokCliRunRequest): Promise<GrokCliRunResult> {
    return await new Promise<GrokCliRunResult>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(request.executable, [...request.args], {
          cwd: request.cwd,
          detached: process.platform !== 'win32',
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch {
        reject(new GrokCliRunError('spawn'))
        return
      }

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let settled = false
      let terminationReason: Extract<GrokCliRunFailureKind, 'timeout' | 'output-limit'> | undefined
      let killTimer: NodeJS.Timeout | undefined
      let failSafeTimer: NodeJS.Timeout | undefined

      const timeout = setTimeout(() => beginTermination('timeout'), request.timeoutMs)

      const clearTimers = (): void => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        if (failSafeTimer) clearTimeout(failSafeTimer)
      }

      const settleError = (error: GrokCliRunError): void => {
        if (settled) return
        settled = true
        clearTimers()
        child.stdout?.destroy()
        child.stderr?.destroy()
        reject(error)
      }

      const capture = (destination: Buffer[], chunk: unknown): void => {
        if (settled || terminationReason) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        if (outputBytes + bytes.length > request.maxOutputBytes) {
          beginTermination('output-limit')
          return
        }
        outputBytes += bytes.length
        destination.push(bytes)
      }

      function beginTermination(
        reason: Extract<GrokCliRunFailureKind, 'timeout' | 'output-limit'>
      ): void {
        if (settled || terminationReason) return
        terminationReason = reason
        signalProcessTree(child, 'SIGTERM')
        killTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), request.terminateGraceMs)
        failSafeTimer = setTimeout(
          () => settleError(new GrokCliRunError(reason)),
          request.terminateGraceMs * 3
        )
      }

      child.stdout?.on('data', (chunk: unknown) => capture(stdout, chunk))
      child.stderr?.on('data', (chunk: unknown) => capture(stderr, chunk))
      child.once('error', () => settleError(new GrokCliRunError('spawn')))
      child.once('close', (exitCode, signal) => {
        if (settled) return
        if (terminationReason) {
          settleError(new GrokCliRunError(terminationReason))
          return
        }
        settled = true
        clearTimers()
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode,
          signal
        })
      })
    })
  }
}

export class GrokCliService {
  private readonly cliPath: string
  private readonly runner: GrokCliProcessRunner
  private readonly timeoutMs: number
  private readonly doctorTimeoutMs: number
  private readonly updateInstallTimeoutMs: number
  private readonly maxOutputBytes: number
  private readonly terminateGraceMs: number

  constructor(options: GrokCliServiceOptions) {
    this.cliPath = options.cliPath
    this.runner = options.runner ?? new NodeGrokCliProcessRunner()
    this.timeoutMs = boundedInteger(
      options.timeoutMs,
      GROK_CLI_DEFAULT_TIMEOUT_MS,
      100,
      10 * 60_000,
      'timeoutMs'
    )
    this.doctorTimeoutMs = boundedInteger(
      options.doctorTimeoutMs,
      GROK_CLI_DOCTOR_TIMEOUT_MS,
      100,
      10 * 60_000,
      'doctorTimeoutMs'
    )
    this.updateInstallTimeoutMs = boundedInteger(
      options.updateInstallTimeoutMs,
      GROK_CLI_UPDATE_INSTALL_TIMEOUT_MS,
      100,
      GROK_CLI_UPDATE_INSTALL_TIMEOUT_MS,
      'updateInstallTimeoutMs'
    )
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      GROK_CLI_DEFAULT_MAX_OUTPUT_BYTES,
      1,
      16 * 1024 * 1024,
      'maxOutputBytes'
    )
    this.terminateGraceMs = boundedInteger(
      options.terminateGraceMs,
      GROK_CLI_DEFAULT_TERMINATE_GRACE_MS,
      10,
      10_000,
      'terminateGraceMs'
    )
  }

  async listMcp(cwd: string): Promise<string> {
    return (await this.execute('mcp-list', ['mcp', 'list', '--json'], cwd, this.timeoutMs)).stdout
  }

  async checkForUpdate(cwd: string): Promise<string> {
    return (await this.execute(
      'update-check',
      ['update', '--check', '--json'],
      cwd,
      this.timeoutMs
    )).stdout
  }

  async readVersion(cwd: string): Promise<string> {
    return (await this.execute(
      'version-check',
      ['--version'],
      cwd,
      this.timeoutMs
    )).stdout
  }

  /** Reads the fixed workspace-scoped agent definition catalog. */
  async inspectAgents(cwd: string): Promise<string> {
    return (await this.execute(
      'inspect-agents',
      ['inspect', '--json'],
      cwd,
      this.timeoutMs,
      [0],
      Math.min(this.maxOutputBytes, GROK_CLI_INSPECT_AGENTS_MAX_OUTPUT_BYTES)
    )).stdout
  }

  /** Lists at most 50 recent Grok sessions using the fixed 1.0.5 CLI contract. */
  async listSessions(cwd: string): Promise<GrokCliSessionHistoryRecord[]> {
    const output = (await this.execute(
      'sessions-list',
      ['sessions', 'list', '--limit', String(GROK_CLI_SESSION_HISTORY_LIMIT)],
      cwd,
      this.timeoutMs
    )).stdout
    return parseGrokCliSessionHistory(output, 'sessions-list')
  }

  /** Searches summaries and first prompts with one bounded positional query. */
  async searchSessions(cwd: string, query: string): Promise<GrokCliSessionHistoryRecord[]> {
    const safeQuery = canonicalGrokCliSessionQuery(query)
    if (!safeQuery) throw new GrokCliServiceError('invalid-query', 'sessions-search')
    const output = (await this.execute(
      'sessions-search',
      [
        'sessions', 'search', '--limit', String(GROK_CLI_SESSION_HISTORY_LIMIT), safeQuery
      ],
      cwd,
      this.timeoutMs
    )).stdout
    return parseGrokCliSessionHistory(output, 'sessions-search')
  }

  /** Permanently deletes one exact canonical Grok session id. Confirmation belongs to callers. */
  async deleteSession(cwd: string, remoteId: string): Promise<void> {
    if (!isCanonicalGrokCliSessionId(remoteId)) {
      throw new GrokCliServiceError('invalid-session-id', 'sessions-delete')
    }
    await this.execute(
      'sessions-delete',
      ['sessions', 'delete', remoteId],
      cwd,
      this.timeoutMs
    )
  }

  /**
   * Runs the fixed Grok 1.0.5 CLI self-update command. Session shutdown,
   * confirmation, post-update verification, and UI state belong to callers;
   * this main-only boundary only executes `grok update` with bounded resources.
   */
  async installUpdate(cwd: string, version: string): Promise<void> {
    const targetVersion = canonicalGrokCliUpdateVersion(version)
    if (!targetVersion) throw new GrokCliServiceError('invalid-version', 'update-install')
    await this.execute(
      'update-install',
      ['update', '--version', targetVersion],
      cwd,
      this.updateInstallTimeoutMs
    )
  }

  async addMcp(input: McpAddInput): Promise<void> {
    const args = ['mcp', 'add', '--transport', input.transport, '--scope', input.scope]
    if (input.transport === 'stdio') {
      for (const entry of input.environment) args.push('-e', `${entry.name}=${entry.value}`)
      args.push(input.name, '--', input.command, ...input.args)
    } else {
      for (const header of input.headers) args.push('-H', `${header.name}: ${header.value}`)
      args.push(input.name, input.url)
    }
    await this.execute('mcp-add', args, input.cwd, this.timeoutMs)
  }

  async removeMcp(input: McpRemoveInput): Promise<void> {
    await this.execute(
      'mcp-remove',
      ['mcp', 'remove', input.name, '--scope', input.scope],
      input.cwd,
      this.timeoutMs
    )
  }

  async enableMcp(input: McpToggleInput): Promise<void> {
    await this.execute('mcp-enable', ['mcp', 'enable', input.name], input.cwd, this.timeoutMs)
  }

  async disableMcp(input: McpToggleInput): Promise<void> {
    await this.execute('mcp-disable', ['mcp', 'disable', input.name], input.cwd, this.timeoutMs)
  }

  async doctorMcp(cwd: string, name?: string | undefined): Promise<string> {
    const args = ['mcp', 'doctor', '--json']
    if (name) args.push(name)
    // Grok 1.0.5 exits 1 when the report contains unhealthy servers. The JSON
    // report is still the successful diagnostic result; other codes are command failures.
    return (await this.execute('mcp-doctor', args, cwd, this.doctorTimeoutMs, [0, 1])).stdout
  }

  private async execute(
    operation: GrokCliOperation,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    allowedExitCodes: readonly number[] = [0],
    maxOutputBytes = this.maxOutputBytes
  ): Promise<GrokCliRunResult> {
    const executable = await validateCliPath(this.cliPath, operation)
    const resolvedCwd = await validateCwd(cwd, operation)
    let result: GrokCliRunResult
    try {
      result = await this.runner.run({
        executable,
        args,
        cwd: resolvedCwd,
        timeoutMs,
        maxOutputBytes,
        terminateGraceMs: this.terminateGraceMs
      })
    } catch (error) {
      if (error instanceof GrokCliRunError) {
        const code = error.kind === 'timeout'
          ? 'timeout'
          : error.kind === 'output-limit'
            ? 'output-limit'
            : 'spawn-failed'
        throw new GrokCliServiceError(code, operation)
      }
      // An injected runner may throw arbitrary data. Never forward its message,
      // because it may contain argv, stderr, environment values, or credentials.
      throw new GrokCliServiceError('spawn-failed', operation)
    }
    if (result.exitCode === null || !allowedExitCodes.includes(result.exitCode)) {
      // stdout/stderr intentionally stay inside this boundary.
      throw new GrokCliServiceError('command-failed', operation, result.exitCode ?? undefined)
    }
    return result
  }
}

/** Strict, renderer-safe version accepted by `grok update --version`. */
export function canonicalGrokCliUpdateVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const candidate = value.trim().replace(/^[vV]/, '')
  if (candidate.length === 0 || candidate.length > 128) return undefined
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(candidate)
    ? candidate
    : undefined
}

/** Parses the exact first line emitted by `grok --version`, preserving prerelease identity. */
export function canonicalGrokCliUpdateVersionOutput(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine || firstLine.length > 256) return undefined
  const match = /^(?:grok\s+)?(v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?:\s+\([A-Za-z0-9._-]{1,128}\))?$/.exec(firstLine)
  return canonicalGrokCliUpdateVersion(match?.[1])
}

export function compareCanonicalGrokCliVersions(left: string, right: string): number {
  const leftVersion = canonicalGrokCliUpdateVersion(left)
  const rightVersion = canonicalGrokCliUpdateVersion(right)
  if (!leftVersion || !rightVersion) throw new TypeError('Invalid Grok CLI version comparison.')
  const [leftCore, leftPrerelease] = splitCoreAndPrerelease(leftVersion)
  const [rightCore, rightPrerelease] = splitCoreAndPrerelease(rightVersion)
  const leftParts = leftCore!.split('.').map(Number)
  const rightParts = rightCore!.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index]! < rightParts[index]! ? -1 : 1
    }
  }
  if (leftPrerelease === undefined && rightPrerelease === undefined) return 0
  if (leftPrerelease === undefined) return 1
  if (rightPrerelease === undefined) return -1
  const leftIdentifiers = leftPrerelease.split('.')
  const rightIdentifiers = rightPrerelease.split('.')
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
    const leftIdentifier = leftIdentifiers[index]
    const rightIdentifier = rightIdentifiers[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^\d+$/.test(leftIdentifier)
    const rightNumeric = /^\d+$/.test(rightIdentifier)
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) < Number(rightIdentifier) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

/**
 * Parses only the stable table rows emitted by Grok CLI 1.0.5. Group labels and
 * table headers are deliberately discarded so project paths/labels never cross
 * this main-only boundary as accidental diagnostics.
 */
export function parseGrokCliSessionHistory(
  raw: unknown,
  operation: Extract<GrokCliOperation, 'sessions-list' | 'sessions-search'> = 'sessions-list'
): GrokCliSessionHistoryRecord[] {
  if (
    typeof raw !== 'string'
    || Buffer.byteLength(raw, 'utf8') > GROK_CLI_SESSION_HISTORY_MAX_OUTPUT_BYTES
  ) {
    throw new GrokCliServiceError('invalid-output', operation)
  }

  const records: GrokCliSessionHistoryRecord[] = []
  const seen = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0 || GROK_CLI_SESSION_HEADER_PATTERN.test(line)) continue
    if (isSafeSessionGroupLabel(line)) continue

    const match = GROK_CLI_SESSION_ROW_PATTERN.exec(line)
    if (!match) throw new GrokCliServiceError('invalid-output', operation)
    const [, remoteId, created, updated, status, summary] = match
    if (
      !isCanonicalGrokCliSessionId(remoteId)
      || !isCanonicalCalendarDate(created)
      || !isCanonicalCalendarDate(updated)
      || !isBoundedSafeSessionField(status, GROK_CLI_SESSION_STATUS_MAX_BYTES, false)
      || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(status)
      || !isBoundedSafeSessionField(summary, GROK_CLI_SESSION_SUMMARY_MAX_BYTES, true)
      || seen.has(remoteId)
      || records.length >= GROK_CLI_SESSION_HISTORY_LIMIT
    ) {
      throw new GrokCliServiceError('invalid-output', operation)
    }
    seen.add(remoteId)
    records.push({ remoteId, summary, status, created, updated })
  }
  return records
}

export function canonicalGrokCliSessionQuery(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value.startsWith('-')
    || !isBoundedSafeSessionField(value, GROK_CLI_SESSION_QUERY_MAX_BYTES, false)
  ) return undefined
  return value
}

export function isCanonicalGrokCliSessionId(value: unknown): value is string {
  return typeof value === 'string' && GROK_CLI_SESSION_ID_PATTERN.test(value)
}

function splitCoreAndPrerelease(version: string): [string, string | undefined] {
  const withoutBuild = version.split('+', 1)[0]!
  const separator = withoutBuild.indexOf('-')
  return separator < 0
    ? [withoutBuild, undefined]
    : [withoutBuild.slice(0, separator), withoutBuild.slice(separator + 1)]
}

async function validateCliPath(
  configuredPath: string,
  operation: GrokCliOperation
): Promise<string> {
  if (typeof configuredPath !== 'string' || !isAbsolute(configuredPath) || configuredPath.includes('\0')) {
    throw new GrokCliServiceError('invalid-cli', operation)
  }
  try {
    const resolved = await realpath(configuredPath)
    const info = await stat(resolved)
    if (!info.isFile()) throw new Error('not a file')
    await access(resolved, fsConstants.X_OK)
    return resolved
  } catch {
    throw new GrokCliServiceError('invalid-cli', operation)
  }
}

async function validateCwd(cwd: string, operation: GrokCliOperation): Promise<string> {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) {
    throw new GrokCliServiceError('invalid-cwd', operation)
  }
  try {
    const resolved = await realpath(cwd)
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory')
    return resolved
  } catch {
    throw new GrokCliServiceError('invalid-cwd', operation)
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through to the direct child when process-group signaling is not available.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // A concurrent exit is harmless; close/error or the fail-safe timer settles the run.
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const candidate = value ?? fallback
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${label} is outside the supported range`)
  }
  return candidate
}

function serviceErrorMessage(
  code: GrokCliServiceErrorCode,
  operation: GrokCliOperation,
  exitCode?: number | undefined
): string {
  switch (code) {
    case 'invalid-cli':
      return 'The configured Grok CLI is unavailable or not executable'
    case 'invalid-cwd':
      return 'The project directory is unavailable'
    case 'invalid-version':
      return 'The Grok CLI update version is invalid'
    case 'invalid-query':
      return 'The Grok session search query is invalid'
    case 'invalid-session-id':
      return 'The Grok session id is invalid'
    case 'invalid-output':
      return `Grok CLI ${operation} returned an invalid response`
    case 'timeout':
      return `Grok CLI ${operation} timed out`
    case 'output-limit':
      return `Grok CLI ${operation} exceeded its output limit`
    case 'command-failed':
      return `Grok CLI ${operation} failed${exitCode === undefined ? '' : ` (exit ${exitCode})`}`
    case 'spawn-failed':
      return `Grok CLI ${operation} could not be started`
  }
}

function isSafeSessionGroupLabel(line: string): boolean {
  return line.startsWith('(')
    && line.endsWith(')')
    && isBoundedSafeSessionField(line, 512, false)
}

function isBoundedSafeSessionField(
  value: unknown,
  maximumBytes: number,
  allowEmpty: boolean
): value is string {
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
