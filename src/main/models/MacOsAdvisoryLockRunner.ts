import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'

export const MACOS_LOCKF_PATH = '/usr/bin/lockf'
export const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 5_000

const LOCKF_CHILD_FD = 3
const LOCKF_TIMEOUT_EXIT = 75
const MAX_HELPER_OUTPUT_BYTES = 4 * 1024
const MAX_LOCK_TIMEOUT_MS = 30_000
const DEFAULT_WATCHDOG_GRACE_MS = 1_000
const TERMINATION_GRACE_MS = 250

export type AdvisoryLockRunnerErrorCode =
  | 'unsupported-platform'
  | 'unsafe-helper'
  | 'invalid-request'
  | 'timeout'
  | 'aborted'
  | 'output-overflow'
  | 'helper-signaled'
  | 'helper-failed'
  | 'watchdog-timeout'

export class AdvisoryLockRunnerError extends Error {
  constructor(readonly code: AdvisoryLockRunnerErrorCode) {
    super(errorMessage(code))
    this.name = 'AdvisoryLockRunnerError'
  }
}

export interface AdvisoryLockAcquireRequest {
  fd: number
  timeoutMs: number
  signal?: AbortSignal | undefined
}

export interface AdvisoryLockRunner {
  acquire(request: AdvisoryLockAcquireRequest): Promise<void>
}

export interface MacOsAdvisoryLockRunnerOptions {
  /** Test-only platform seam. Production always uses process.platform. */
  platform?: NodeJS.Platform | undefined
  /** Test-only process seam. Production always uses node:child_process.spawn. */
  spawnProcess?: typeof spawn | undefined
  /** Test-only watchdog tuning. */
  watchdogGraceMs?: number | undefined
}

/**
 * Acquires a Darwin BSD flock on an already-open parent file descriptor.
 *
 * Node duplicates the parent descriptor into child fd 3. In descriptor mode,
 * `/usr/bin/lockf` applies flock directly to that shared open-file-description
 * and exits. The parent's still-open FileHandle therefore retains the lock;
 * its last close (including process death) is the release operation.
 */
export class MacOsAdvisoryLockRunner implements AdvisoryLockRunner {
  private readonly platform: NodeJS.Platform
  private readonly spawnProcess: typeof spawn
  private readonly watchdogGraceMs: number

  constructor(options: MacOsAdvisoryLockRunnerOptions = {}) {
    if (options.watchdogGraceMs !== undefined &&
        (!Number.isSafeInteger(options.watchdogGraceMs) ||
          options.watchdogGraceMs < 0 || options.watchdogGraceMs > MAX_LOCK_TIMEOUT_MS)) {
      throw new AdvisoryLockRunnerError('invalid-request')
    }
    this.platform = options.platform ?? process.platform
    this.spawnProcess = options.spawnProcess ?? spawn
    this.watchdogGraceMs = options.watchdogGraceMs ?? DEFAULT_WATCHDOG_GRACE_MS
  }

  async acquire(request: AdvisoryLockAcquireRequest): Promise<void> {
    assertAcquireRequest(request)
    if (this.platform !== 'darwin') {
      throw new AdvisoryLockRunnerError('unsupported-platform')
    }
    await assertTrustedSystemLockf()
    if (request.signal?.aborted) throw new AdvisoryLockRunnerError('aborted')

    const timeoutSeconds = Math.ceil(request.timeoutMs / 1_000)
    let child: ChildProcess
    try {
      child = this.spawnProcess(
        MACOS_LOCKF_PATH,
        ['-s', '-t', String(timeoutSeconds), String(LOCKF_CHILD_FD)],
        {
          shell: false,
          detached: false,
          env: { LANG: 'C', LC_ALL: 'C' },
          stdio: ['ignore', 'pipe', 'pipe', request.fd]
        }
      )
    } catch {
      throw new AdvisoryLockRunnerError('helper-failed')
    }

    await waitForLockf(child, request, this.watchdogGraceMs)
  }
}

async function assertTrustedSystemLockf(): Promise<void> {
  try {
    if (await realpath(MACOS_LOCKF_PATH) !== MACOS_LOCKF_PATH) {
      throw new AdvisoryLockRunnerError('unsafe-helper')
    }
    const stats = await lstat(MACOS_LOCKF_PATH)
    if (stats.isSymbolicLink() || !stats.isFile() || stats.uid !== 0 ||
        (stats.mode & 0o022) !== 0 || (stats.mode & 0o111) === 0) {
      throw new AdvisoryLockRunnerError('unsafe-helper')
    }
  } catch (error) {
    if (error instanceof AdvisoryLockRunnerError) throw error
    throw new AdvisoryLockRunnerError('unsafe-helper')
  }
}

function waitForLockf(
  child: ChildProcess,
  request: AdvisoryLockAcquireRequest,
  watchdogGraceMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let outputBytes = 0
    let overflow = false
    let aborted = false
    let watchdogExpired = false
    let spawnFailed = false
    let settled = false
    let terminationTimer: NodeJS.Timeout | undefined

    const consumeOutput = (chunk: Buffer | string): void => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes <= MAX_HELPER_OUTPUT_BYTES || overflow) return
      overflow = true
      terminateChild(child)
    }
    child.stdout?.on('data', consumeOutput)
    child.stderr?.on('data', consumeOutput)

    const abort = (): void => {
      aborted = true
      terminateChild(child)
      terminationTimer ??= setTimeout(() => terminateChild(child, 'SIGKILL'), TERMINATION_GRACE_MS)
    }
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) abort()

    const watchdog = setTimeout(() => {
      watchdogExpired = true
      terminateChild(child)
      terminationTimer ??= setTimeout(() => terminateChild(child, 'SIGKILL'), TERMINATION_GRACE_MS)
    }, request.timeoutMs + watchdogGraceMs)

    const finish = (error?: AdvisoryLockRunnerError): void => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      if (terminationTimer) clearTimeout(terminationTimer)
      request.signal?.removeEventListener('abort', abort)
      child.stdout?.off('data', consumeOutput)
      child.stderr?.off('data', consumeOutput)
      if (error) reject(error)
      else resolve()
    }

    child.once('error', () => {
      spawnFailed = true
    })
    child.once('close', (code, signal) => {
      if (aborted) return finish(new AdvisoryLockRunnerError('aborted'))
      if (overflow) return finish(new AdvisoryLockRunnerError('output-overflow'))
      if (watchdogExpired) return finish(new AdvisoryLockRunnerError('watchdog-timeout'))
      if (spawnFailed) return finish(new AdvisoryLockRunnerError('helper-failed'))
      if (signal) return finish(new AdvisoryLockRunnerError('helper-signaled'))
      if (code === LOCKF_TIMEOUT_EXIT) return finish(new AdvisoryLockRunnerError('timeout'))
      if (code !== 0) return finish(new AdvisoryLockRunnerError('helper-failed'))
      finish()
    })
  })
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    child.kill(signal)
  } catch {
    // The close/error event decides the bounded public failure code.
  }
}

function assertAcquireRequest(request: AdvisoryLockAcquireRequest): void {
  if (!Number.isSafeInteger(request.fd) || request.fd < 0 ||
      !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0 ||
      request.timeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw new AdvisoryLockRunnerError('invalid-request')
  }
}

function errorMessage(code: AdvisoryLockRunnerErrorCode): string {
  switch (code) {
    case 'unsupported-platform': return 'The system advisory lock helper is unavailable.'
    case 'unsafe-helper': return 'The system advisory lock helper is not trusted.'
    case 'invalid-request': return 'The advisory lock request is invalid.'
    case 'timeout': return 'The configuration lock is busy.'
    case 'aborted': return 'The advisory lock request was cancelled.'
    case 'output-overflow': return 'The system advisory lock helper produced invalid output.'
    case 'helper-signaled': return 'The system advisory lock helper terminated unexpectedly.'
    case 'helper-failed': return 'The system advisory lock helper failed.'
    case 'watchdog-timeout': return 'The system advisory lock helper did not exit in time.'
  }
}
