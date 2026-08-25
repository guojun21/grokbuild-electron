import { spawn, type ChildProcess } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z, type ZodType } from 'zod'

export const TERMINAL_DEFAULT_OUTPUT_BYTE_LIMIT = 2 * 1024 * 1024
export const TERMINAL_SESSION_OUTPUT_BYTE_LIMIT = 8 * 1024 * 1024
export const TERMINAL_MAX_COUNT = 32

const MAX_SESSION_ID_LENGTH = 256
const MAX_PATH_LENGTH = 4_096
const MAX_COMMAND_LENGTH = 128 * 1024
const MAX_ARGUMENT_COUNT = 256
const MAX_ARGUMENT_LENGTH = 32 * 1024
const MAX_ARGUMENT_BYTES = 256 * 1024
const MAX_ENVIRONMENT_ENTRIES = 128
const MAX_ENVIRONMENT_VALUE_LENGTH = 32 * 1024
const MAX_ENVIRONMENT_BYTES = 256 * 1024
const MAX_PATH_ENTRIES = 256
const DEFAULT_TERMINATION_GRACE_MS = 750
const DEFAULT_FORCE_KILL_GRACE_MS = 1_000
const MIN_TERMINATION_GRACE_MS = 25
const MAX_TERMINATION_GRACE_MS = 5_000
const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

const inheritedEnvironmentAllowlist = /^(PATH|HOME|USER|LOGNAME|TMPDIR|SHELL|LANG|LC_[A-Z_]+|TZ|TERM|COLORTERM|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i
const forbiddenEnvironmentNames = new Set([
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ELECTRON_RUN_AS_NODE',
  'LD_PRELOAD',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH'
])

const boundedString = (maximum: number, minimum = 0) => z
  .string()
  .min(minimum)
  .max(maximum)
  .refine((value) => !value.includes('\0'), 'must not contain NUL')

const sessionIdSchema = boundedString(MAX_SESSION_ID_LENGTH, 1)
const terminalIdSchema = boundedString(MAX_SESSION_ID_LENGTH, 1)
const argumentSchema = boundedString(MAX_ARGUMENT_LENGTH)
const environmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .refine((name) => !forbiddenEnvironmentNames.has(name.toUpperCase()), 'environment name is not allowed')
const environmentValueSchema = boundedString(MAX_ENVIRONMENT_VALUE_LENGTH)

const environmentListSchema = z.array(z.object({
  name: environmentNameSchema,
  value: environmentValueSchema
}).strict()).max(MAX_ENVIRONMENT_ENTRIES)

const environmentMapSchema = z.record(environmentNameSchema, environmentValueSchema)
  .refine((value) => Object.keys(value).length <= MAX_ENVIRONMENT_ENTRIES)

const commandSchema = z.union([
  boundedString(MAX_COMMAND_LENGTH, 1),
  z.array(argumentSchema).min(1).max(MAX_ARGUMENT_COUNT + 1)
    .refine((value) => (value[0]?.length ?? 0) > 0)
])

const createParamsSchema = z.object({
  sessionId: sessionIdSchema,
  command: commandSchema,
  args: z.array(argumentSchema).max(MAX_ARGUMENT_COUNT).optional(),
  cwd: boundedString(MAX_PATH_LENGTH).optional(),
  env: z.union([environmentListSchema, environmentMapSchema]).optional(),
  outputByteLimit: z.number().int().min(0).max(TERMINAL_DEFAULT_OUTPUT_BYTE_LIMIT).optional()
}).strict().superRefine((value, context) => {
  const commandTokens = Array.isArray(value.command) ? value.command : [value.command]
  const argumentBytes = [...commandTokens, ...(value.args ?? [])]
    .reduce((total, item) => total + Buffer.byteLength(item), 0)
  if (argumentBytes > MAX_ARGUMENT_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['args'],
      message: `command and args must not exceed ${MAX_ARGUMENT_BYTES} bytes`
    })
  }
  if (environmentByteLength(value.env) > MAX_ENVIRONMENT_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['env'],
      message: `environment must not exceed ${MAX_ENVIRONMENT_BYTES} bytes`
    })
  }
})

const terminalParamsSchema = z.object({
  sessionId: sessionIdSchema,
  terminalId: terminalIdSchema
}).strict()

type ParsedCreateParams = z.infer<typeof createParamsSchema>
type ParsedTerminalParams = z.infer<typeof terminalParamsSchema>

export interface TerminalHostOptions {
  sessionId: string
  defaultCwd: string
  environment?: NodeJS.ProcessEnv | undefined
  /** May lower, but can never raise, the hard 32-terminal limit. */
  maxTerminals?: number | undefined
  /** May lower, but can never raise, the hard 8 MiB retained-output budget. */
  maxRetainedOutputBytes?: number | undefined
  terminationGraceMs?: number | undefined
  forceKillGraceMs?: number | undefined
}

export interface TerminalCreateResult {
  terminalId: string
}

export interface TerminalExitStatus {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface TerminalOutputResult {
  output: string
  truncated: boolean
  exitStatus?: TerminalExitStatus | undefined
}

export type TerminalHostMethod =
  | 'terminal/create'
  | 'terminal/output'
  | 'terminal/wait_for_exit'
  | 'terminal/kill'
  | 'terminal/release'

export interface TerminalRpcError {
  code: number
  message: string
}

export class TerminalHostError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'TerminalHostError'
  }

  get rpcError(): TerminalRpcError {
    return { code: this.rpcCode, message: this.message }
  }

  static invalidParams(message: string): TerminalHostError {
    return new TerminalHostError(-32602, message)
  }

  static methodNotFound(method: string): TerminalHostError {
    return new TerminalHostError(-32601, `Method not found: ${method.slice(0, 256)}`)
  }

  static operationFailed(message: string, cause?: unknown): TerminalHostError {
    return new TerminalHostError(-32603, message, cause === undefined ? undefined : { cause })
  }
}

interface TerminalSession {
  id: string
  child: ChildProcess
  output: Buffer
  outputByteLimit: number
  truncated: boolean
  exitStatus: TerminalExitStatus | undefined
  exitPromise: Promise<TerminalExitStatus>
  settleExit: (status: TerminalExitStatus) => void
  lastOutputSequence: number
}

interface TerminalLaunch {
  executable: string
  args: string[]
  cwd: string
  environment: Record<string, string>
}

/**
 * Bounded ACP reverse terminal host.
 *
 * The class is intended to live inside the per-session Electron utility process.
 * It never evaluates a command itself: a wire command line is tokenized into an
 * executable and argv, then launched with `shell: false`.
 */
export class TerminalHost {
  static readonly defaultOutputByteLimit = TERMINAL_DEFAULT_OUTPUT_BYTE_LIMIT
  static readonly maxTerminalCount = TERMINAL_MAX_COUNT

  private readonly sessionId: string
  private readonly defaultCwd: string
  private readonly baseEnvironment: Record<string, string>
  private readonly maxTerminals: number
  private readonly maxRetainedOutputBytes: number
  private readonly terminationGraceMs: number
  private readonly forceKillGraceMs: number
  private readonly terminals = new Map<string, TerminalSession>()
  private readonly retainedSessions = new Set<TerminalSession>()
  private retainedOutputBytes = 0
  private outputSequence = 0
  private stopped = false
  private stopPromise: Promise<void> | undefined

  constructor(options: TerminalHostOptions) {
    const parsedSessionId = sessionIdSchema.safeParse(options.sessionId)
    if (!parsedSessionId.success) {
      throw TerminalHostError.invalidParams('TerminalHost requires a valid sessionId')
    }
    if (
      typeof options.defaultCwd !== 'string' ||
      options.defaultCwd.length === 0 ||
      options.defaultCwd.length > MAX_PATH_LENGTH ||
      options.defaultCwd.includes('\0')
    ) {
      throw TerminalHostError.invalidParams('TerminalHost requires a valid defaultCwd')
    }
    this.sessionId = parsedSessionId.data
    this.defaultCwd = resolve(options.defaultCwd)
    this.baseEnvironment = safeInheritedEnvironment(options.environment ?? process.env)
    this.maxTerminals = boundedIntegerOption(
      options.maxTerminals,
      TERMINAL_MAX_COUNT,
      1,
      TERMINAL_MAX_COUNT,
      'maxTerminals'
    )
    this.maxRetainedOutputBytes = boundedIntegerOption(
      options.maxRetainedOutputBytes,
      TERMINAL_SESSION_OUTPUT_BYTE_LIMIT,
      0,
      TERMINAL_SESSION_OUTPUT_BYTE_LIMIT,
      'maxRetainedOutputBytes'
    )
    this.terminationGraceMs = boundedIntegerOption(
      options.terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS,
      MIN_TERMINATION_GRACE_MS,
      MAX_TERMINATION_GRACE_MS,
      'terminationGraceMs'
    )
    this.forceKillGraceMs = boundedIntegerOption(
      options.forceKillGraceMs,
      DEFAULT_FORCE_KILL_GRACE_MS,
      MIN_TERMINATION_GRACE_MS,
      MAX_TERMINATION_GRACE_MS,
      'forceKillGraceMs'
    )
  }
  get activeTerminalCount(): number {
    return this.terminals.size
  }

  get retainedOutputByteCount(): number {
    return this.retainedOutputBytes
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'terminal/create':
        return this.create(params)
      case 'terminal/output':
        return this.output(params)
      case 'terminal/wait_for_exit':
        return this.waitForExit(params)
      case 'terminal/kill':
        return this.kill(params)
      case 'terminal/release':
        return this.release(params)
      default:
        throw TerminalHostError.methodNotFound(method)
    }
  }

  async create(params: unknown): Promise<TerminalCreateResult> {
    if (this.stopped) throw TerminalHostError.operationFailed('Terminal host is stopped')
    this.assertRequestSession(params)
    if (!hasUsableCommand(params)) {
      throw TerminalHostError.invalidParams('terminal/create requires command')
    }
    const request = parseParams(createParamsSchema, params, 'Invalid terminal/create request')
    this.assertTerminalCapacity()

    const launch = await this.resolveLaunch(request)
    if (this.stopped) throw TerminalHostError.operationFailed('Terminal host is stopped')
    // `resolveLaunch` is asynchronous, so capacity must be rechecked after it to
    // prevent concurrent creates from all passing the first count snapshot.
    this.assertTerminalCapacity()
    const terminalId = `term_${randomBytes(12).toString('hex')}`
    const child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.environment,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const session = createSession(
      terminalId,
      child,
      request.outputByteLimit ?? TERMINAL_DEFAULT_OUTPUT_BYTE_LIMIT
    )
    this.terminals.set(terminalId, session)
    this.retainedSessions.add(session)
    this.attachSession(session)

    try {
      await waitForSpawn(child)
      if (this.stopped || this.terminals.get(terminalId) !== session) {
        await this.terminate(session)
        throw TerminalHostError.operationFailed('Terminal host stopped during command launch')
      }
      return { terminalId }
    } catch (error) {
      if (this.terminals.get(terminalId) === session) this.terminals.delete(terminalId)
      await this.terminate(session).catch(() => undefined)
      this.detachSession(session)
      this.discardSessionOutput(session)
      if (error instanceof TerminalHostError) throw error
      throw TerminalHostError.operationFailed('Unable to launch terminal command', error)
    }
  }

  output(params: unknown): TerminalOutputResult {
    const session = this.getSession(params)
    return {
      output: session.output.toString('utf8'),
      truncated: session.truncated,
      ...(session.exitStatus ? { exitStatus: { ...session.exitStatus } } : {})
    }
  }

  async waitForExit(params: unknown): Promise<TerminalExitStatus> {
    const session = this.getSession(params)
    const status = session.exitStatus ?? await session.exitPromise
    return { ...status }
  }

  async kill(params: unknown): Promise<Record<string, never>> {
    const session = this.getSession(params)
    await this.terminate(session)
    return {}
  }

  async release(params: unknown): Promise<Record<string, never>> {
    const request = this.parseTerminalRequest(params)
    const session = this.terminals.get(request.terminalId)
    if (!session) throw TerminalHostError.invalidParams('Unknown terminalId')
    this.terminals.delete(request.terminalId)
    try {
      await this.terminate(session)
    } finally {
      this.detachSession(session)
      this.discardSessionOutput(session)
    }
    return {}
  }

  stopAll(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true
    const sessions = [...this.retainedSessions]
    this.terminals.clear()
    this.stopPromise = Promise.allSettled(sessions.map(async (session) => {
      try {
        await this.terminate(session)
      } finally {
        this.detachSession(session)
        this.discardSessionOutput(session)
      }
    })).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length > 0) {
        throw new AggregateError(failures, 'One or more terminal processes could not be reaped')
      }
    })
    return this.stopPromise
  }

  private getSession(params: unknown): TerminalSession {
    const request = this.parseTerminalRequest(params)
    const session = this.terminals.get(request.terminalId)
    if (!session) throw TerminalHostError.invalidParams('Unknown terminalId')
    return session
  }

  private parseTerminalRequest(params: unknown): ParsedTerminalParams {
    this.assertRequestSession(params)
    const record = asRecord(params)
    if (typeof record?.terminalId !== 'string' || record.terminalId.length === 0) {
      throw TerminalHostError.invalidParams('terminal request requires terminalId')
    }
    const request = parseParams(terminalParamsSchema, params, 'Invalid terminal request')
    return request
  }

  private assertRequestSession(params: unknown): void {
    const record = asRecord(params)
    if (typeof record?.sessionId !== 'string' || record.sessionId.length === 0) {
      throw TerminalHostError.invalidParams('terminal request requires sessionId')
    }
    this.assertSession(record.sessionId)
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.sessionId) {
      throw TerminalHostError.invalidParams(
        'terminal request sessionId does not match the active ACP session'
      )
    }
  }

  private assertTerminalCapacity(): void {
    if (this.terminals.size >= this.maxTerminals) {
      throw TerminalHostError.operationFailed(
        `Too many active terminals (maximum ${this.maxTerminals})`
      )
    }
  }

  private async resolveLaunch(request: ParsedCreateParams): Promise<TerminalLaunch> {
    const cwd = resolveTerminalCwd(request.cwd, this.defaultCwd)
    let cwdStats: Awaited<ReturnType<typeof stat>>
    try {
      cwdStats = await stat(cwd)
    } catch (error) {
      throw TerminalHostError.invalidParams('terminal/create cwd does not exist')
    }
    if (!cwdStats.isDirectory()) {
      throw TerminalHostError.invalidParams('terminal/create cwd is not a directory')
    }

    const commandTokens = Array.isArray(request.command)
      ? [...request.command]
      : splitTerminalCommandLine(request.command)
    if (commandTokens.length === 0 || commandTokens[0] === undefined || commandTokens[0].length === 0) {
      throw TerminalHostError.invalidParams('terminal/create requires command')
    }
    const args = [...commandTokens.slice(1), ...(request.args ?? [])]
    if (args.length > MAX_ARGUMENT_COUNT) {
      throw TerminalHostError.invalidParams(
        `terminal/create accepts at most ${MAX_ARGUMENT_COUNT} arguments`
      )
    }

    const environment = mergeEnvironment(this.baseEnvironment, request.env)
    const executable = await resolveExecutable(commandTokens[0], cwd, environment.PATH ?? DEFAULT_PATH)
    if (!executable) {
      throw TerminalHostError.operationFailed('Terminal executable was not found or is not executable')
    }
    return { executable, args, cwd, environment }
  }

  private attachSession(session: TerminalSession): void {
    const append = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const next = Buffer.concat([session.output, bytes])
      const truncated = truncateTerminalOutput(next, session.outputByteLimit)
      this.retainedOutputBytes += truncated.output.length - session.output.length
      session.output = truncated.output
      session.truncated ||= truncated.truncated
      session.lastOutputSequence = ++this.outputSequence
      this.enforceRetainedOutputBudget()
    }
    session.child.stdout?.on('data', append)
    session.child.stderr?.on('data', append)
    session.child.once('error', () => {
      settleSessionExit(session, { exitCode: null, signal: null })
    })
    session.child.once('close', (code, signal) => {
      settleSessionExit(session, {
        exitCode: typeof code === 'number' ? code : null,
        signal: isNodeSignal(signal) ? signal : null
      })
    })
  }

  private detachSession(session: TerminalSession): void {
    session.child.stdout?.removeAllListeners('data')
    session.child.stderr?.removeAllListeners('data')
    session.child.stdout?.destroy()
    session.child.stderr?.destroy()
  }

  private discardSessionOutput(session: TerminalSession): void {
    this.retainedOutputBytes = Math.max(0, this.retainedOutputBytes - session.output.length)
    session.output = Buffer.alloc(0)
    this.retainedSessions.delete(session)
  }

  private enforceRetainedOutputBudget(): void {
    if (this.retainedOutputBytes <= this.maxRetainedOutputBytes) return
    const oldestFirst = [...this.retainedSessions]
      .filter((session) => session.output.length > 0)
      .sort((left, right) => left.lastOutputSequence - right.lastOutputSequence)
    for (const session of oldestFirst) {
      const excess = this.retainedOutputBytes - this.maxRetainedOutputBytes
      if (excess <= 0) break
      const targetByteLimit = Math.max(0, session.output.length - excess)
      const truncated = truncateTerminalOutput(session.output, targetByteLimit)
      this.retainedOutputBytes -= session.output.length - truncated.output.length
      session.output = truncated.output
      session.truncated = true
    }
  }

  private async terminate(session: TerminalSession): Promise<void> {
    const pid = session.child.pid
    if (session.exitStatus && (process.platform === 'win32' || pid === undefined || !processGroupExists(pid))) {
      return
    }
    try {
      signalProcessTree(session.child, 'SIGTERM')
      if (await processTreeSettlesWithin(session, this.terminationGraceMs)) return
      signalProcessTree(session.child, 'SIGKILL')
      if (await processTreeSettlesWithin(session, this.forceKillGraceMs)) return
    } catch (error) {
      throw TerminalHostError.operationFailed('Unable to terminate terminal process', error)
    }
    throw TerminalHostError.operationFailed('Terminal process did not exit after SIGKILL')
  }
}

export function splitTerminalCommandLine(line: string): string[] {
  const tokens: string[] = []
  let token = ''
  let tokenStarted = false
  let quote: "'" | '"' | undefined
  let escaping = false

  for (const character of line.trim()) {
    if (escaping) {
      token += character
      tokenStarted = true
      escaping = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaping = true
      tokenStarted = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      else token += character
      tokenStarted = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
      continue
    }
    if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(token)
        token = ''
        tokenStarted = false
      }
      continue
    }
    token += character
    tokenStarted = true
  }

  if (escaping || quote) {
    throw TerminalHostError.invalidParams('terminal/create command has unterminated quoting')
  }
  if (tokenStarted) tokens.push(token)
  return tokens
}

export function truncateTerminalOutput(
  output: Buffer,
  byteLimit: number
): { output: Buffer; truncated: boolean } {
  if (output.length <= byteLimit) return { output, truncated: false }
  let start = output.length - byteLimit
  while (start < output.length && (output[start] ?? 0) >>> 6 === 0b10) start += 1
  return { output: Buffer.from(output.subarray(start)), truncated: true }
}

function parseParams<T>(schema: ZodType<T>, params: unknown, message: string): T {
  const parsed = schema.safeParse(params)
  if (!parsed.success) throw TerminalHostError.invalidParams(message)
  return parsed.data
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function hasUsableCommand(params: unknown): boolean {
  const command = asRecord(params)?.command
  if (typeof command === 'string') return command.trim().length > 0
  return Array.isArray(command) && typeof command[0] === 'string' && command[0].trim().length > 0
}

function createSession(
  id: string,
  child: ChildProcess,
  outputByteLimit: number
): TerminalSession {
  let settleExit!: (status: TerminalExitStatus) => void
  const exitPromise = new Promise<TerminalExitStatus>((resolveExit) => {
    settleExit = resolveExit
  })
  return {
    id,
    child,
    output: Buffer.alloc(0),
    outputByteLimit,
    truncated: false,
    exitStatus: undefined,
    exitPromise,
    settleExit,
    lastOutputSequence: 0
  }
}

function settleSessionExit(session: TerminalSession, status: TerminalExitStatus): void {
  if (session.exitStatus) return
  session.exitStatus = status
  session.settleExit(status)
}

function environmentByteLength(
  raw: ParsedCreateParams['env'] | undefined
): number {
  if (!raw) return 0
  const entries: Array<[string, string]> = Array.isArray(raw)
    ? raw.map(({ name, value }) => [name, value])
    : Object.entries(raw)
  return entries.reduce(
    (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value),
    0
  )
}

function mergeEnvironment(
  base: Record<string, string>,
  raw: ParsedCreateParams['env'] | undefined
): Record<string, string> {
  const environment = { ...base }
  if (!raw) return environment
  const entries: Array<[string, string]> = Array.isArray(raw)
    ? raw.map(({ name, value }) => [name, value])
    : Object.entries(raw)
  for (const [name, value] of entries) environment[name] = value
  return environment
}

function safeInheritedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && inheritedEnvironmentAllowlist.test(entry[0])
    )
  )
  if (!environment.PATH) environment.PATH = DEFAULT_PATH
  return environment
}

function resolveTerminalCwd(cwd: string | undefined, defaultCwd: string): string {
  if (!cwd) return defaultCwd
  return isAbsolute(cwd) ? resolve(cwd) : resolve(defaultCwd, cwd)
}

async function resolveExecutable(
  command: string,
  cwd: string,
  pathValue: string
): Promise<string | undefined> {
  const candidates = command.includes('/')
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : pathValue.split(delimiter).slice(0, MAX_PATH_ENTRIES).map((directory) =>
      resolve(directory || cwd, command)
    )
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK)
      const candidateStats = await stat(candidate)
      if (candidateStats.isFile()) return candidate
    } catch {
      // Try the next PATH entry. Unknown executables never fall back to a shell.
    }
  }
  return undefined
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve()
  return new Promise((resolveSpawn, rejectSpawn) => {
    const onSpawn = (): void => {
      child.removeListener('error', onError)
      resolveSpawn()
    }
    const onError = (error: Error): void => {
      child.removeListener('spawn', onSpawn)
      rejectSpawn(error)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal)
    else child.kill(signal)
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : ''
    if (code !== 'ESRCH') throw error
  }
}

async function processTreeSettlesWithin(
  session: TerminalSession,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    const pid = session.child.pid
    const childSettled = session.exitStatus !== undefined
    const processGroupSettled =
      process.platform === 'win32' || pid === undefined || !processGroupExists(pid)
    if (childSettled && processGroupSettled) return true
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10))
  } while (Date.now() < deadline)
  return false
}

function processGroupExists(pid: number): boolean {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : ''
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function isNodeSignal(value: string | null): value is NodeJS.Signals {
  return value !== null && /^SIG[A-Z0-9]+$/.test(value)
}

function boundedIntegerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw TerminalHostError.invalidParams(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}
