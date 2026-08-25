import { spawn, type ChildProcess } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

export const GIT_DEFAULT_EXECUTABLE = '/usr/bin/git'
export const GIT_DEFAULT_TIMEOUT_MS = 5_000
export const GIT_DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024
export const GIT_DEFAULT_TERMINATE_GRACE_MS = 250

const GIT_MAX_TIMEOUT_MS = 10 * 60_000
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_BRANCH_CHARS = 1_024
const SAFE_GIT_CONFIG_ARGS = Object.freeze([
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null'
])
const VALID_PORCELAIN_CODES = new Set([' ', 'M', 'A', 'D', 'R', 'C', 'U', 'T', '?'])
const CONFLICT_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export type GitDiffScope = 'staged' | 'unstaged'
export type GitOperation = 'inspect' | 'diff-staged' | 'diff-unstaged'
export type GitRunFailureKind = 'spawn' | 'timeout' | 'output-limit'
export type GitServiceErrorCode =
  | 'invalid-git'
  | 'invalid-project'
  | 'invalid-request'
  | 'not-repository'
  | 'spawn-failed'
  | 'timeout'
  | 'output-limit'
  | 'command-failed'
  | 'invalid-output'

interface GitRunRequest {
  executable: string
  args: readonly string[]
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  terminateGraceMs: number
}

interface GitRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

interface GitProcessRunner {
  run(request: GitRunRequest): Promise<GitRunResult>
}

export interface GitBranchState {
  name: string | null
  detached: boolean
  head: string | null
}

export interface GitWorktreeIdentity {
  root: string
  gitDirectory: string
  commonDirectory: string
  isLinkedWorktree: boolean
}

export interface GitDirtyStatus {
  clean: boolean
  total: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

export interface GitDiffStat {
  files: number
  insertions: number
  deletions: number
  binaryFiles: number
}

export interface GitDiffSummary {
  staged: GitDiffStat
  unstaged: GitDiffStat
}

export interface GitProjectSnapshot {
  branch: GitBranchState
  worktree: GitWorktreeIdentity
  status: GitDirtyStatus
  diff: GitDiffSummary
}

export interface GitDiffResult {
  scope: GitDiffScope
  patch: string
}

export interface GitServiceOptions {
  /** Absolute executable only. PATH lookup is deliberately unsupported. */
  gitPath?: string | undefined
  /** Test seam below the fixed service API; renderer/IPC callers never receive it. */
  runner?: GitProcessRunner | undefined
  timeoutMs?: number | undefined
  maxOutputBytes?: number | undefined
  terminateGraceMs?: number | undefined
}

class GitRunError extends Error {
  constructor(readonly kind: GitRunFailureKind) {
    super(
      kind === 'timeout'
        ? 'Git operation timed out.'
        : kind === 'output-limit'
          ? 'Git output exceeded the safety limit.'
          : 'Git could not be started.'
    )
    this.name = 'GitRunError'
  }
}

export class GitServiceError extends Error {
  constructor(
    readonly code: GitServiceErrorCode,
    readonly operation: GitOperation
  ) {
    super(publicErrorMessage(code))
    this.name = 'GitServiceError'
  }
}

/**
 * Bounded, shell-free runner used only by GitService's fixed read-only calls.
 * Environment values that can redirect Git, inject config, enable a pager, or
 * select an external diff are intentionally not inherited.
 */
class NodeGitProcessRunner implements GitProcessRunner {
  async run(request: GitRunRequest): Promise<GitRunResult> {
    return await new Promise<GitRunResult>((resolveResult, rejectResult) => {
      let child: ChildProcess
      try {
        child = spawn(request.executable, [...request.args], {
          cwd: request.cwd,
          detached: process.platform !== 'win32',
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: safeGitEnvironment()
        })
      } catch {
        rejectResult(new GitRunError('spawn'))
        return
      }

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let settled = false
      let terminationReason: Extract<GitRunFailureKind, 'timeout' | 'output-limit'> | undefined
      let killTimer: NodeJS.Timeout | undefined
      let failSafeTimer: NodeJS.Timeout | undefined
      const timeout = setTimeout(() => beginTermination('timeout'), request.timeoutMs)

      const clearTimers = (): void => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        if (failSafeTimer) clearTimeout(failSafeTimer)
      }

      const settleError = (error: GitRunError): void => {
        if (settled) return
        settled = true
        clearTimers()
        child.stdout?.destroy()
        child.stderr?.destroy()
        rejectResult(error)
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
        reason: Extract<GitRunFailureKind, 'timeout' | 'output-limit'>
      ): void {
        if (settled || terminationReason) return
        terminationReason = reason
        signalProcessTree(child, 'SIGTERM')
        killTimer = setTimeout(
          () => signalProcessTree(child, 'SIGKILL'),
          request.terminateGraceMs
        )
        failSafeTimer = setTimeout(
          () => settleError(new GitRunError(reason)),
          request.terminateGraceMs * 3
        )
      }

      child.stdout?.on('data', (chunk: unknown) => capture(stdout, chunk))
      child.stderr?.on('data', (chunk: unknown) => capture(stderr, chunk))
      child.once('error', () => settleError(new GitRunError('spawn')))
      child.once('close', (exitCode, signal) => {
        if (settled) return
        if (terminationReason) {
          settleError(new GitRunError(terminationReason))
          return
        }
        settled = true
        clearTimers()
        resolveResult({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode,
          signal
        })
      })
    })
  }
}

/**
 * Main-process-only, read-only Git boundary.
 *
 * There is intentionally no public method accepting an argv, revision, path,
 * or command. Callers may inspect a canonical project or request one of the two
 * fixed working-tree diff scopes.
 */
export class GitService {
  private readonly gitPath: string
  private readonly runner: GitProcessRunner
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly terminateGraceMs: number

  constructor(options: GitServiceOptions = {}) {
    this.gitPath = options.gitPath ?? GIT_DEFAULT_EXECUTABLE
    this.runner = options.runner ?? new NodeGitProcessRunner()
    this.timeoutMs = boundedInteger(
      options.timeoutMs,
      GIT_DEFAULT_TIMEOUT_MS,
      50,
      GIT_MAX_TIMEOUT_MS,
      'timeoutMs'
    )
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      GIT_DEFAULT_MAX_OUTPUT_BYTES,
      64,
      GIT_MAX_OUTPUT_BYTES,
      'maxOutputBytes'
    )
    this.terminateGraceMs = boundedInteger(
      options.terminateGraceMs,
      GIT_DEFAULT_TERMINATE_GRACE_MS,
      10,
      10_000,
      'terminateGraceMs'
    )
  }

  async inspect(projectDirectory: string): Promise<GitProjectSnapshot> {
    const context = await openRepository(
      projectDirectory,
      this.gitPath,
      this.runner,
      this.processLimits,
      'inspect'
    )
    const [branch, worktree, status, staged, unstaged] = await Promise.all([
      readBranch(context, 'inspect'),
      readWorktreeIdentity(context, 'inspect'),
      readStatus(context, 'inspect'),
      readDiffStat(context, 'staged', 'inspect'),
      readDiffStat(context, 'unstaged', 'inspect')
    ])
    return { branch, worktree, status, diff: { staged, unstaged } }
  }

  async readDiff(
    projectDirectory: string,
    scope: GitDiffScope
  ): Promise<GitDiffResult> {
    if (scope !== 'staged' && scope !== 'unstaged') {
      throw new GitServiceError('invalid-request', 'diff-unstaged')
    }
    const operation: GitOperation = scope === 'staged' ? 'diff-staged' : 'diff-unstaged'
    const context = await openRepository(
      projectDirectory,
      this.gitPath,
      this.runner,
      this.processLimits,
      operation
    )
    const result = await runChecked(context, diffArgs(scope, false), operation)
    return { scope, patch: result.stdout }
  }

  private get processLimits(): ProcessLimits {
    return {
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      terminateGraceMs: this.terminateGraceMs
    }
  }
}

interface ProcessLimits {
  timeoutMs: number
  maxOutputBytes: number
  terminateGraceMs: number
}

interface RepositoryContext extends ProcessLimits {
  executable: string
  cwd: string
  runner: GitProcessRunner
}

async function openRepository(
  projectDirectory: string,
  configuredGitPath: string,
  runner: GitProcessRunner,
  limits: ProcessLimits,
  operation: GitOperation
): Promise<RepositoryContext> {
  const executable = await validateGitExecutable(configuredGitPath, operation)
  const cwd = await validateCanonicalProjectDirectory(projectDirectory, operation)
  const context = { executable, cwd, runner, ...limits }
  const probe = await runRaw(context, ['rev-parse', '--is-inside-work-tree'], operation)
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
    throw new GitServiceError('not-repository', operation)
  }
  return context
}

async function readBranch(
  context: RepositoryContext,
  operation: GitOperation
): Promise<GitBranchState> {
  const [symbolic, head] = await Promise.all([
    runChecked(context, ['symbolic-ref', '--quiet', '--short', 'HEAD'], operation, [0, 1]),
    runChecked(context, ['rev-parse', '--verify', '--short=12', 'HEAD'], operation, [0, 128])
  ])
  const name = symbolic.exitCode === 0
    ? boundedSingleValue(symbolic.stdout, MAX_BRANCH_CHARS, operation)
    : null
  const headValue = head.exitCode === 0 ? stripOneLineEnding(head.stdout) : ''
  if (headValue && !/^[0-9a-fA-F]{4,64}$/.test(headValue)) {
    throw new GitServiceError('invalid-output', operation)
  }
  return {
    name: name || null,
    detached: name === null,
    head: headValue || null
  }
}

async function readWorktreeIdentity(
  context: RepositoryContext,
  operation: GitOperation
): Promise<GitWorktreeIdentity> {
  const [rootResult, gitResult, commonResult] = await Promise.all([
    runChecked(context, ['rev-parse', '--path-format=absolute', '--show-toplevel'], operation),
    runChecked(context, ['rev-parse', '--path-format=absolute', '--git-dir'], operation),
    runChecked(context, ['rev-parse', '--path-format=absolute', '--git-common-dir'], operation)
  ])
  const [root, gitDirectory, commonDirectory] = await Promise.all([
    canonicalGitPath(rootResult.stdout, operation),
    canonicalGitPath(gitResult.stdout, operation),
    canonicalGitPath(commonResult.stdout, operation)
  ])
  return {
    root,
    gitDirectory,
    commonDirectory,
    isLinkedWorktree: gitDirectory !== commonDirectory
  }
}

async function readStatus(
  context: RepositoryContext,
  operation: GitOperation
): Promise<GitDirtyStatus> {
  const result = await runChecked(
    context,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    operation
  )
  return parsePorcelainStatus(result.stdout, operation)
}

async function readDiffStat(
  context: RepositoryContext,
  scope: GitDiffScope,
  operation: GitOperation
): Promise<GitDiffStat> {
  const result = await runChecked(context, diffArgs(scope, true), operation)
  return parseNumstat(result.stdout, operation)
}

function diffArgs(scope: GitDiffScope, summary: boolean): string[] {
  return [
    'diff',
    ...(scope === 'staged' ? ['--cached'] : []),
    ...(summary ? ['--numstat', '-z'] : ['--unified=3']),
    '--no-ext-diff',
    '--no-textconv',
    '--'
  ]
}

async function runChecked(
  context: RepositoryContext,
  args: readonly string[],
  operation: GitOperation,
  allowedExitCodes: readonly number[] = [0]
): Promise<GitRunResult> {
  const result = await runRaw(context, args, operation)
  if (result.exitCode === null || !allowedExitCodes.includes(result.exitCode)) {
    throw new GitServiceError('command-failed', operation)
  }
  return result
}

async function runRaw(
  context: RepositoryContext,
  args: readonly string[],
  operation: GitOperation
): Promise<GitRunResult> {
  try {
    return await context.runner.run({
      executable: context.executable,
      args: [...SAFE_GIT_CONFIG_ARGS, ...args],
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
      maxOutputBytes: context.maxOutputBytes,
      terminateGraceMs: context.terminateGraceMs
    })
  } catch (error) {
    if (error instanceof GitRunError) {
      throw new GitServiceError(
        error.kind === 'timeout'
          ? 'timeout'
          : error.kind === 'output-limit'
            ? 'output-limit'
            : 'spawn-failed',
        operation
      )
    }
    // Runner messages can contain argv, paths, config, or diff content.
    throw new GitServiceError('spawn-failed', operation)
  }
}

export function parsePorcelainStatus(
  output: string,
  operation: GitOperation = 'inspect'
): GitDirtyStatus {
  const records = output.split('\0')
  let total = 0
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.length < 3 || record[2] !== ' ') {
      throw new GitServiceError('invalid-output', operation)
    }
    const x = record[0]!
    const y = record[1]!
    if (!VALID_PORCELAIN_CODES.has(x) || !VALID_PORCELAIN_CODES.has(y)) {
      throw new GitServiceError('invalid-output', operation)
    }
    total += 1
    if (x === '?' && y === '?') {
      untracked += 1
    } else if (x === '?' || y === '?') {
      throw new GitServiceError('invalid-output', operation)
    } else if (isConflictPair(x, y)) {
      conflicted += 1
    } else {
      if (x !== ' ') staged += 1
      if (y !== ' ') unstaged += 1
    }
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      index += 1
      if (index >= records.length || !records[index]) {
        throw new GitServiceError('invalid-output', operation)
      }
    }
  }
  return {
    clean: total === 0,
    total,
    staged,
    unstaged,
    untracked,
    conflicted
  }
}

export function parseNumstat(
  output: string,
  operation: GitOperation = 'inspect'
): GitDiffStat {
  let files = 0
  let insertions = 0
  let deletions = 0
  let binaryFiles = 0
  const records = output.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    if (!record) continue
    const match = record.match(/^([0-9]+|-)\t([0-9]+|-)\t([\s\S]*)$/)
    if (!match) throw new GitServiceError('invalid-output', operation)
    files += 1
    if (match[3] === '') {
      const oldPath = records[index + 1]
      const newPath = records[index + 2]
      if (!oldPath || !newPath) throw new GitServiceError('invalid-output', operation)
      index += 2
    }
    if (match[1] === '-' || match[2] === '-') {
      binaryFiles += 1
      continue
    }
    insertions = safeCountAdd(insertions, Number.parseInt(match[1]!, 10), operation)
    deletions = safeCountAdd(deletions, Number.parseInt(match[2]!, 10), operation)
  }
  return { files, insertions, deletions, binaryFiles }
}

async function validateGitExecutable(
  configuredPath: string,
  operation: GitOperation
): Promise<string> {
  if (
    typeof configuredPath !== 'string' ||
    !isAbsolute(configuredPath) ||
    configuredPath.includes('\0')
  ) {
    throw new GitServiceError('invalid-git', operation)
  }
  try {
    const canonical = await realpath(configuredPath)
    if (!(await stat(canonical)).isFile()) throw new Error('not a file')
    await access(canonical, fsConstants.X_OK)
    return canonical
  } catch {
    throw new GitServiceError('invalid-git', operation)
  }
}

async function validateCanonicalProjectDirectory(
  projectDirectory: string,
  operation: GitOperation
): Promise<string> {
  if (
    typeof projectDirectory !== 'string' ||
    !isAbsolute(projectDirectory) ||
    projectDirectory.includes('\0') ||
    resolve(projectDirectory) !== projectDirectory
  ) {
    throw new GitServiceError('invalid-project', operation)
  }
  try {
    const canonical = await realpath(projectDirectory)
    if (canonical !== projectDirectory || !(await stat(canonical)).isDirectory()) {
      throw new Error('project is not an already-canonical directory')
    }
    return canonical
  } catch {
    throw new GitServiceError('invalid-project', operation)
  }
}

async function canonicalGitPath(output: string, operation: GitOperation): Promise<string> {
  const value = stripOneLineEnding(output)
  if (!value || !isAbsolute(value) || value.includes('\0')) {
    throw new GitServiceError('invalid-output', operation)
  }
  try {
    return await realpath(value)
  } catch {
    throw new GitServiceError('invalid-output', operation)
  }
}

function boundedSingleValue(
  output: string,
  maximumChars: number,
  operation: GitOperation
): string {
  const value = stripOneLineEnding(output)
  if (!value || value.length > maximumChars || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new GitServiceError('invalid-output', operation)
  }
  return value
}

function stripOneLineEnding(value: string): string {
  return value.endsWith('\r\n')
    ? value.slice(0, -2)
    : value.endsWith('\n')
      ? value.slice(0, -1)
      : value
}

function isConflictPair(x: string, y: string): boolean {
  return CONFLICT_PAIRS.has(`${x}${y}`)
}

function safeCountAdd(current: number, next: number, operation: GitOperation): number {
  const value = current + next
  if (!Number.isSafeInteger(next) || next < 0 || !Number.isSafeInteger(value)) {
    throw new GitServiceError('invalid-output', operation)
  }
  return value
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0'
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through when process-group signaling is unavailable.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // A concurrent process exit is harmless.
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
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return candidate
}

function publicErrorMessage(code: GitServiceErrorCode): string {
  switch (code) {
    case 'invalid-git':
      return 'Git is unavailable.'
    case 'invalid-project':
      return 'The project directory is unavailable.'
    case 'invalid-request':
      return 'The Git request is not supported.'
    case 'not-repository':
      return 'The project is not a Git repository.'
    case 'spawn-failed':
      return 'Git could not be started.'
    case 'timeout':
      return 'The Git operation timed out.'
    case 'output-limit':
      return 'Git output exceeded the safety limit.'
    case 'command-failed':
      return 'Git could not read the repository state.'
    case 'invalid-output':
      return 'Git returned an unsupported response.'
  }
}
