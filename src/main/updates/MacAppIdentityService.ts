import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep
} from 'node:path'

const CODESIGN_PATH = '/usr/bin/codesign'
const PLUTIL_PATH = '/usr/bin/plutil'
const LIPO_PATH = '/usr/bin/lipo'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TERMINATE_GRACE_MS = 250
const MAX_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_PATH_BYTES = 4_096
const MAX_DESIGNATED_REQUIREMENT_BYTES = 16 * 1024

export type MacAppArchitecture = 'arm64' | 'x86_64'

const ALLOWED_ARCHITECTURES: ReadonlySet<string> = new Set<MacAppArchitecture>([
  'arm64',
  'x86_64'
])

export type MacAppIdentityErrorCode =
  | 'not-packaged'
  | 'invalid-app-path'
  | 'signature-ineligible'
  | 'identity-invalid'
  | 'metadata-invalid'
  | 'tool-unavailable'
  | 'timeout'
  | 'output-limit'

export class MacAppIdentityError extends Error {
  constructor(readonly code: MacAppIdentityErrorCode) {
    super(publicErrorMessage(code))
    this.name = 'MacAppIdentityError'
  }
}

export interface MacAppIdentityRequest {
  executablePath: string
  isPackaged: boolean
}

/** Main-process-only identity. Never expose this object across IPC. */
export interface MacAppIdentity {
  appPath: string
  executablePath: string
  bundleId: string
  appName: string
  shortVersion: string
  bundleVersion: string
  teamId: string
  designatedRequirement: string
  architectures: readonly MacAppArchitecture[]
}

type MacAppToolFailure = 'spawn' | 'timeout' | 'output-limit'

interface MacAppToolRunRequest {
  executable: string
  args: readonly string[]
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  terminateGraceMs: number
}

interface MacAppToolRunResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number | null
  signal: NodeJS.Signals | null
  failure: MacAppToolFailure | null
}

interface MacAppToolRunner {
  run(request: MacAppToolRunRequest): Promise<MacAppToolRunResult>
}

export interface MacAppIdentityServiceOptions {
  /** Main-only deterministic test seam. Executables and argv remain fixed by this service. */
  runner?: MacAppToolRunner | undefined
  timeoutMs?: number | undefined
  maxOutputBytes?: number | undefined
  terminateGraceMs?: number | undefined
}

interface ProcessLimits {
  timeoutMs: number
  maxOutputBytes: number
  terminateGraceMs: number
}

interface CanonicalAppLocation {
  appPath: string
  executablePath: string
}

/**
 * Establishes whether the currently running packaged macOS app is eligible for
 * a future trusted update transaction. It performs no download, install, swap,
 * relaunch, or renderer communication.
 */
export class MacAppIdentityService {
  private readonly runner: MacAppToolRunner
  private readonly limits: ProcessLimits

  constructor(options: MacAppIdentityServiceOptions = {}) {
    this.runner = options.runner ?? new NodeMacAppToolRunner()
    this.limits = {
      timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 50, MAX_TIMEOUT_MS),
      maxOutputBytes: boundedInteger(
        options.maxOutputBytes,
        DEFAULT_MAX_OUTPUT_BYTES,
        64,
        MAX_OUTPUT_BYTES
      ),
      terminateGraceMs: boundedInteger(
        options.terminateGraceMs,
        DEFAULT_TERMINATE_GRACE_MS,
        10,
        10_000
      )
    }
  }

  async inspect(request: MacAppIdentityRequest): Promise<MacAppIdentity> {
    if (request.isPackaged !== true) throw new MacAppIdentityError('not-packaged')
    const location = await canonicalAppLocation(request.executablePath)
    const context = { cwd: dirname(location.appPath), ...this.limits }

    await this.runChecked(
      context,
      CODESIGN_PATH,
      ['--verify', '--deep', '--strict', '--verbose=2', location.appPath],
      'signature-ineligible'
    )

    const identityResult = await this.runChecked(
      context,
      CODESIGN_PATH,
      ['-d', '--verbose=4', location.appPath],
      'signature-ineligible'
    )
    const identityOutput = decodeCombinedOutput(identityResult, 'identity-invalid')
    const signedIdentity = parseSignedIdentity(identityOutput)

    const requirementResult = await this.runChecked(
      context,
      CODESIGN_PATH,
      ['-d', '-r-', location.appPath],
      'identity-invalid'
    )
    const designatedRequirement = parseDesignatedRequirement(
      decodeCombinedOutput(requirementResult, 'identity-invalid'),
      signedIdentity.bundleId
    )

    const plistPath = join(location.appPath, 'Contents', 'Info.plist')
    const bundleId = await this.readPlistValue(context, plistPath, 'CFBundleIdentifier', 255)
    const appName = await this.readPlistValue(context, plistPath, 'CFBundleName', 256)
    const shortVersion = await this.readPlistValue(
      context,
      plistPath,
      'CFBundleShortVersionString',
      128
    )
    const bundleVersion = await this.readPlistValue(
      context,
      plistPath,
      'CFBundleVersion',
      128
    )
    const bundleExecutable = await this.readPlistValue(
      context,
      plistPath,
      'CFBundleExecutable',
      255
    )

    if (
      bundleId !== signedIdentity.bundleId ||
      !isBundleIdentifier(bundleId) ||
      !isSafeAppName(appName) ||
      !isSafeVersion(shortVersion) ||
      !isSafeVersion(bundleVersion) ||
      !isSafeExecutableName(bundleExecutable) ||
      bundleExecutable !== basename(location.executablePath)
    ) {
      throw new MacAppIdentityError('metadata-invalid')
    }
    const architectureResult = await this.runChecked(
      context,
      LIPO_PATH,
      ['-archs', location.executablePath],
      'metadata-invalid'
    )
    const architectures = parseArchitectures(architectureResult.stdout)

    return {
      appPath: location.appPath,
      executablePath: location.executablePath,
      bundleId,
      appName,
      shortVersion,
      bundleVersion,
      teamId: signedIdentity.teamId,
      designatedRequirement,
      architectures
    }
  }

  private async readPlistValue(
    context: ProcessLimits & { cwd: string },
    plistPath: string,
    key:
      | 'CFBundleIdentifier'
      | 'CFBundleName'
      | 'CFBundleShortVersionString'
      | 'CFBundleVersion'
      | 'CFBundleExecutable',
    maximumLength: number
  ): Promise<string> {
    const result = await this.runChecked(
      context,
      PLUTIL_PATH,
      ['-extract', key, 'raw', '-o', '-', plistPath],
      'metadata-invalid'
    )
    const value = decodeSingleValue(result.stdout, maximumLength)
    if (value === undefined) throw new MacAppIdentityError('metadata-invalid')
    return value
  }

  private async runChecked(
    context: ProcessLimits & { cwd: string },
    executable: string,
    args: readonly string[],
    nonzeroCode: Extract<MacAppIdentityErrorCode, 'signature-ineligible' | 'identity-invalid' | 'metadata-invalid'>
  ): Promise<MacAppToolRunResult> {
    let result: MacAppToolRunResult
    try {
      result = await this.runner.run({ executable, args, ...context })
    } catch {
      throw new MacAppIdentityError('tool-unavailable')
    }
    if (result.failure === 'spawn') throw new MacAppIdentityError('tool-unavailable')
    if (result.failure === 'timeout') throw new MacAppIdentityError('timeout')
    if (result.failure === 'output-limit') throw new MacAppIdentityError('output-limit')
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new MacAppIdentityError(nonzeroCode)
    }
    return result
  }
}

class NodeMacAppToolRunner implements MacAppToolRunner {
  async run(request: MacAppToolRunRequest): Promise<MacAppToolRunResult> {
    return await new Promise<MacAppToolRunResult>((resolveResult) => {
      let child: ChildProcess
      try {
        child = spawn(request.executable, [...request.args], {
          cwd: request.cwd,
          detached: process.platform !== 'win32',
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: safeToolEnvironment()
        })
      } catch {
        resolveResult(failedRun('spawn'))
        return
      }

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let settled = false
      let failure: Extract<MacAppToolFailure, 'timeout' | 'output-limit'> | undefined
      let killTimer: NodeJS.Timeout | undefined
      let failSafeTimer: NodeJS.Timeout | undefined
      const timeout = setTimeout(() => beginTermination('timeout'), request.timeoutMs)

      const clearTimers = (): void => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        if (failSafeTimer) clearTimeout(failSafeTimer)
      }
      const settle = (result: MacAppToolRunResult): void => {
        if (settled) return
        settled = true
        clearTimers()
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolveResult(result)
      }
      const capture = (destination: Buffer[], chunk: unknown): void => {
        if (settled || failure) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        if (outputBytes + bytes.byteLength > request.maxOutputBytes) {
          beginTermination('output-limit')
          return
        }
        outputBytes += bytes.byteLength
        destination.push(bytes)
      }
      function beginTermination(
        reason: Extract<MacAppToolFailure, 'timeout' | 'output-limit'>
      ): void {
        if (settled || failure) return
        failure = reason
        signalProcessTree(child, 'SIGTERM')
        killTimer = setTimeout(
          () => signalProcessTree(child, 'SIGKILL'),
          request.terminateGraceMs
        )
        failSafeTimer = setTimeout(
          () => settle(failedRun(reason)),
          request.terminateGraceMs * 3
        )
      }

      child.stdout?.on('data', (chunk: unknown) => capture(stdout, chunk))
      child.stderr?.on('data', (chunk: unknown) => capture(stderr, chunk))
      child.once('error', () => settle(failedRun(failure ?? 'spawn')))
      child.once('close', (exitCode, signal) => {
        if (failure) {
          settle(failedRun(failure))
          return
        }
        settle({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode,
          signal,
          failure: null
        })
      })
    })
  }
}

async function canonicalAppLocation(executablePath: string): Promise<CanonicalAppLocation> {
  try {
    if (
      !executablePath ||
      executablePath.includes('\0') ||
      Buffer.byteLength(executablePath, 'utf8') > MAX_PATH_BYTES ||
      !isAbsolute(executablePath) ||
      normalize(resolve(executablePath)) !== executablePath
    ) throw new Error('invalid-path')

    const executableStats = await lstat(executablePath)
    if (!executableStats.isFile() || executableStats.isSymbolicLink()) throw new Error('invalid-file')
    const canonicalExecutable = await realpath(executablePath)
    if (canonicalExecutable !== executablePath) throw new Error('non-canonical')

    let cursor = dirname(canonicalExecutable)
    let appPath: string | undefined
    const filesystemRoot = parse(cursor).root
    while (cursor !== filesystemRoot) {
      if (basename(cursor).endsWith('.app')) {
        appPath = cursor
        break
      }
      cursor = dirname(cursor)
    }
    if (!appPath) throw new Error('not-app')

    const relativeExecutable = relative(appPath, canonicalExecutable)
    const executableComponents = relativeExecutable.split(sep)
    if (
      relativeExecutable.startsWith('..') || isAbsolute(relativeExecutable) ||
      executableComponents.length !== 3 ||
      executableComponents[0] !== 'Contents' || executableComponents[1] !== 'MacOS' ||
      !executableComponents[2]
    ) throw new Error('unexpected-layout')

    for (const path of [appPath, join(appPath, 'Contents'), join(appPath, 'Contents', 'MacOS')]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
        throw new Error('unsafe-component')
      }
    }
    return { appPath, executablePath: canonicalExecutable }
  } catch {
    throw new MacAppIdentityError('invalid-app-path')
  }
}

function parseSignedIdentity(output: string): { bundleId: string; teamId: string } {
  if (/^Signature=adhoc$/m.test(output)) throw new MacAppIdentityError('signature-ineligible')
  const bundleId = uniqueDetailValue(output, 'Identifier')
  const teamId = uniqueDetailValue(output, 'TeamIdentifier')
  const timestamps = detailValues(output, 'Timestamp')
  const timestamp = timestamps[0]
  const developerAuthorities = output
    .split('\n')
    .filter((line) => line.startsWith('Authority=Developer ID Application: '))
    .map((line) => line.slice('Authority='.length))
  const authorityTeam = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(
    developerAuthorities[0] ?? ''
  )?.[1]
  const hasRuntime = /\bflags=0x[0-9a-f]+\([^\n)]*\bruntime\b[^\n)]*\)/i.test(output)
  if (
    !isBundleIdentifier(bundleId) ||
    !/^[A-Z0-9]{10}$/.test(teamId) ||
    timestamps.length !== 1 || !timestamp || timestamp.toLowerCase() === 'none' ||
    developerAuthorities.length !== 1 || authorityTeam !== teamId ||
    !hasRuntime
  ) throw new MacAppIdentityError('signature-ineligible')
  return { bundleId, teamId }
}

function parseDesignatedRequirement(output: string, bundleId: string): string {
  const values = output
    .split('\n')
    .filter((line) => line.startsWith('designated => '))
    .map((line) => line.slice('designated => '.length))
  const requirement = values[0]
  if (
    values.length !== 1 || !requirement ||
    Buffer.byteLength(requirement, 'utf8') > MAX_DESIGNATED_REQUIREMENT_BYTES ||
    /[\0\r\n]/.test(requirement) ||
    !requirement.includes(`identifier "${bundleId}"`)
  ) throw new MacAppIdentityError('identity-invalid')
  return requirement
}

function uniqueDetailValue(output: string, key: string): string {
  const values = detailValues(output, key)
  if (values.length !== 1 || !values[0] || /[\0\r\n]/.test(values[0])) {
    throw new MacAppIdentityError('identity-invalid')
  }
  return values[0]
}

function detailValues(output: string, key: string): string[] {
  const prefix = `${key}=`
  return output
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
}

function decodeCombinedOutput(
  result: Pick<MacAppToolRunResult, 'stdout' | 'stderr'>,
  code: Extract<MacAppIdentityErrorCode, 'identity-invalid'>
): string {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const stdout = decoder.decode(result.stdout)
    const stderr = decoder.decode(result.stderr)
    const combined = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`
    if (combined.includes('\0') || combined.includes('\r')) throw new Error('invalid-output')
    return combined.endsWith('\n') ? combined.slice(0, -1) : combined
  } catch {
    throw new MacAppIdentityError(code)
  }
}

function decodeSingleValue(bytes: Uint8Array, maximumLength: number): string | undefined {
  try {
    const output = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value = output.endsWith('\n') ? output.slice(0, -1) : output
    if (
      !value || value.length > maximumLength ||
      Buffer.byteLength(value, 'utf8') > maximumLength * 4 ||
      /[\0\r\n]/.test(value)
    ) return undefined
    return value
  } catch {
    return undefined
  }
}

function isBundleIdentifier(value: string): boolean {
  return value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value)
}

function isSafeAppName(value: string): boolean {
  return value.length <= 256 && !/[\0\r\n/]/.test(value) && value !== '.' && value !== '..'
}

function isSafeExecutableName(value: string): boolean {
  return value.length <= 255 && value !== '.' && value !== '..' &&
    !/[\/\\\u0000-\u001f\u007f]/.test(value)
}

function parseArchitectures(bytes: Uint8Array): readonly MacAppArchitecture[] {
  const value = decodeSingleValue(bytes, 64)
  const architectures = value?.split(' ') ?? []
  if (
    architectures.length < 1 || architectures.length > 2 ||
    architectures.some((architecture) => !ALLOWED_ARCHITECTURES.has(architecture)) ||
    new Set(architectures).size !== architectures.length
  ) {
    throw new MacAppIdentityError('metadata-invalid')
  }
  return Object.freeze([...architectures]) as readonly MacAppArchitecture[]
}

function isSafeVersion(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MacAppIdentityError('identity-invalid')
  }
  return value
}

function safeToolEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C'
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The bounded fail-safe timer settles even if the process vanished.
    }
  }
}

function failedRun(failure: MacAppToolFailure): MacAppToolRunResult {
  return {
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    exitCode: null,
    signal: null,
    failure
  }
}

function publicErrorMessage(code: MacAppIdentityErrorCode): string {
  switch (code) {
    case 'not-packaged':
      return 'App updates are available only in a packaged macOS application.'
    case 'invalid-app-path':
      return 'The running application bundle could not be identified safely.'
    case 'signature-ineligible':
      return 'The running application is not eligible for trusted updates.'
    case 'identity-invalid':
      return 'The running application identity could not be verified.'
    case 'metadata-invalid':
      return 'The running application metadata could not be verified.'
    case 'tool-unavailable':
      return 'The application identity could not be checked on this Mac.'
    case 'timeout':
      return 'The application identity check timed out.'
    case 'output-limit':
      return 'The application identity check returned too much data.'
  }
}
