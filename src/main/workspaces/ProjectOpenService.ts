import { spawn, type ChildProcess } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

export const PROJECT_OPEN_EXECUTABLE = '/usr/bin/open'
export const PROJECT_OPEN_DEFAULT_TIMEOUT_MS = 5_000
export const PROJECT_OPEN_DEFAULT_TERMINATE_GRACE_MS = 250

export const PROJECT_OPEN_TARGETS = Object.freeze([
  'finder',
  'cursor',
  'vsCode',
  'terminal',
  'iTerm',
  'zed'
] as const)

export type ProjectOpenTarget = (typeof PROJECT_OPEN_TARGETS)[number]
export type ProjectOpenDisposition = 'open-folder' | 'open-with-application'
export type ProjectOpenRunFailure = 'spawn' | 'timeout'
export type ProjectOpenErrorCode =
  | 'invalid-target'
  | 'invalid-project'
  | 'project-missing'
  | 'project-not-directory'
  | 'project-changed'
  | 'project-unreadable'
  | 'target-unavailable'
  | 'spawn-failed'
  | 'timeout'
  | 'command-failed'

export interface ProjectOpenTargetStatus {
  target: ProjectOpenTarget
  label: string
  installed: boolean
}

export interface ProjectOpenResult {
  target: ProjectOpenTarget
  disposition: ProjectOpenDisposition
  opened: true
}

export interface ProjectOpenRunRequest {
  executable: typeof PROJECT_OPEN_EXECUTABLE
  args: readonly string[]
  timeoutMs: number
  terminateGraceMs: number
  shell: false
}

export interface ProjectOpenRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  failure: ProjectOpenRunFailure | null
}

export interface ProjectOpenProcessRunner {
  run(request: ProjectOpenRunRequest): Promise<ProjectOpenRunResult>
}

export interface ProjectApplicationProbe {
  /** Receives only service-owned, fixed application candidates. */
  isDirectory(path: string): Promise<boolean>
}

export interface ProjectOpenServiceOptions {
  /** Main-only deterministic test seam; executable and argv remain service-owned. */
  runner?: ProjectOpenProcessRunner | undefined
  /** Main-only deterministic test seam; callers cannot supply probe paths. */
  applicationProbe?: ProjectApplicationProbe | undefined
  timeoutMs?: number | undefined
  terminateGraceMs?: number | undefined
}

interface ApplicationVariant {
  bundleId: string
  applicationNames: readonly string[]
}

interface ApplicationTargetSpec {
  target: Exclude<ProjectOpenTarget, 'finder'>
  label: string
  variants: readonly ApplicationVariant[]
}

interface FinderTargetSpec {
  target: 'finder'
  label: 'Finder'
}

type TargetSpec = FinderTargetSpec | ApplicationTargetSpec

interface ProjectIdentity {
  device: number
  inode: number
}

const MAX_PROJECT_PATH_CHARS = 4_096
const MAX_TIMEOUT_MS = 60_000
const MAX_TERMINATE_GRACE_MS = 10_000

/**
 * This is the target set and order shipped by the pinned Swift v0.3.2 UI.
 * Bundle identifiers and application names are service-owned constants: no
 * caller can turn this boundary into an arbitrary application launcher.
 */
const TARGET_SPECS: readonly TargetSpec[] = Object.freeze([
  { target: 'finder', label: 'Finder' },
  {
    target: 'cursor',
    label: 'Cursor',
    variants: [
      {
        bundleId: 'com.todesktop.230313mzl4w4u92',
        applicationNames: ['Cursor']
      },
      {
        bundleId: 'com.cursor.Cursor',
        applicationNames: ['Cursor']
      }
    ]
  },
  {
    target: 'vsCode',
    label: 'VS Code',
    variants: [
      {
        bundleId: 'com.microsoft.VSCode',
        applicationNames: ['Visual Studio Code']
      },
      {
        bundleId: 'com.microsoft.VSCodeInsiders',
        applicationNames: ['Visual Studio Code - Insiders']
      }
    ]
  },
  {
    target: 'terminal',
    label: 'Terminal',
    variants: [
      {
        bundleId: 'com.apple.Terminal',
        applicationNames: ['Terminal']
      }
    ]
  },
  {
    target: 'iTerm',
    label: 'iTerm',
    variants: [
      {
        bundleId: 'com.googlecode.iterm2',
        applicationNames: ['iTerm', 'iTerm2']
      }
    ]
  },
  {
    target: 'zed',
    label: 'Zed',
    variants: [
      {
        bundleId: 'dev.zed.Zed',
        applicationNames: ['Zed']
      },
      {
        bundleId: 'dev.zed.Zed-Preview',
        applicationNames: ['Zed Preview']
      },
      {
        bundleId: 'com.zed.Zed',
        applicationNames: ['Zed']
      }
    ]
  }
])

const TARGET_SPEC_BY_ID = new Map<ProjectOpenTarget, TargetSpec>(
  TARGET_SPECS.map((spec) => [spec.target, spec])
)

export class ProjectOpenServiceError extends Error {
  constructor(
    readonly code: ProjectOpenErrorCode,
    readonly target: ProjectOpenTarget | null
  ) {
    super(publicErrorMessage(code))
    this.name = 'ProjectOpenServiceError'
  }
}

/**
 * Main-only, shell-free project launcher.
 *
 * Finder deliberately receives `open <folder>`: the pinned Swift app opens the
 * directory. `open -R <folder>` would instead select it in its parent Finder
 * window and is a different user-visible action. All other calls are the fixed
 * macOS contract `open -b <allowlisted bundle id> <folder>`.
 */
export class ProjectOpenService {
  private readonly runner: ProjectOpenProcessRunner
  private readonly applicationProbe: ProjectApplicationProbe
  private readonly timeoutMs: number
  private readonly terminateGraceMs: number

  constructor(options: ProjectOpenServiceOptions = {}) {
    this.runner = options.runner ?? new NodeProjectOpenProcessRunner()
    this.applicationProbe = options.applicationProbe ?? new FixedPathApplicationProbe()
    this.timeoutMs = boundedInteger(
      options.timeoutMs,
      PROJECT_OPEN_DEFAULT_TIMEOUT_MS,
      50,
      MAX_TIMEOUT_MS,
      'timeoutMs'
    )
    this.terminateGraceMs = boundedInteger(
      options.terminateGraceMs,
      PROJECT_OPEN_DEFAULT_TERMINATE_GRACE_MS,
      10,
      MAX_TERMINATE_GRACE_MS,
      'terminateGraceMs'
    )
  }

  /** Returns only the fixed target identity and availability; never app paths or bundle ids. */
  async listTargets(): Promise<ProjectOpenTargetStatus[]> {
    return await Promise.all(TARGET_SPECS.map(async (spec) => ({
      target: spec.target,
      label: spec.label,
      installed: spec.target === 'finder' || await this.isApplicationInstalled(spec)
    })))
  }

  /**
   * Opens one already-registered, main-resolved canonical project directory in
   * one fixed target. There is no arbitrary executable, argv, bundle, or app
   * path entry point.
   */
  async openProject(
    projectPath: string,
    target: ProjectOpenTarget
  ): Promise<ProjectOpenResult> {
    const spec = resolveTarget(target)
    const identity = await inspectProject(projectPath, spec.target)

    if (spec.target === 'finder') {
      await assertUnchangedProject(projectPath, identity, spec.target)
      await this.runOpen([projectPath], spec.target)
      return { target: spec.target, disposition: 'open-folder', opened: true }
    }

    if (!(await this.isApplicationInstalled(spec))) {
      throw new ProjectOpenServiceError('target-unavailable', spec.target)
    }

    for (const variant of spec.variants) {
      await assertUnchangedProject(projectPath, identity, spec.target)
      const result = await this.runOpen(
        ['-b', variant.bundleId, projectPath],
        spec.target,
        true
      )
      if (result) {
        return {
          target: spec.target,
          disposition: 'open-with-application',
          opened: true
        }
      }
    }

    throw new ProjectOpenServiceError('command-failed', spec.target)
  }

  private async isApplicationInstalled(spec: ApplicationTargetSpec): Promise<boolean> {
    const checked = new Set<string>()
    for (const variant of spec.variants) {
      for (const name of variant.applicationNames) {
        for (const candidate of fixedApplicationCandidates(name)) {
          if (checked.has(candidate)) continue
          checked.add(candidate)
          try {
            if (await this.applicationProbe.isDirectory(candidate)) return true
          } catch {
            // Availability is renderer-safe and best-effort. Probe diagnostics
            // and filesystem paths never cross this service boundary.
          }
        }
      }
    }
    return false
  }

  private async runOpen(
    args: readonly string[],
    target: ProjectOpenTarget,
    allowCommandFailure = false
  ): Promise<boolean> {
    let result: ProjectOpenRunResult
    try {
      result = await this.runner.run({
        executable: PROJECT_OPEN_EXECUTABLE,
        args: [...args],
        timeoutMs: this.timeoutMs,
        terminateGraceMs: this.terminateGraceMs,
        shell: false
      })
    } catch {
      throw new ProjectOpenServiceError('spawn-failed', target)
    }

    if (result.failure === 'timeout') {
      throw new ProjectOpenServiceError('timeout', target)
    }
    if (result.failure === 'spawn') {
      throw new ProjectOpenServiceError('spawn-failed', target)
    }
    if (result.exitCode !== 0 || result.signal !== null) {
      if (allowCommandFailure) return false
      throw new ProjectOpenServiceError('command-failed', target)
    }
    return true
  }
}

class FixedPathApplicationProbe implements ProjectApplicationProbe {
  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  }
}

class NodeProjectOpenProcessRunner implements ProjectOpenProcessRunner {
  async run(request: ProjectOpenRunRequest): Promise<ProjectOpenRunResult> {
    return await new Promise<ProjectOpenRunResult>((resolveResult) => {
      let child: ChildProcess
      try {
        child = spawn(request.executable, [...request.args], {
          shell: request.shell,
          detached: false,
          stdio: 'ignore',
          env: safeOpenEnvironment()
        })
      } catch {
        resolveResult({ exitCode: null, signal: null, failure: 'spawn' })
        return
      }

      let settled = false
      let timedOut = false
      let killTimer: NodeJS.Timeout | undefined
      let failSafeTimer: NodeJS.Timeout | undefined
      const timeout = setTimeout(() => {
        if (settled) return
        timedOut = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), request.terminateGraceMs)
        failSafeTimer = setTimeout(() => settle({
          exitCode: null,
          signal: null,
          failure: 'timeout'
        }), request.terminateGraceMs * 3)
      }, request.timeoutMs)

      const clearTimers = (): void => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        if (failSafeTimer) clearTimeout(failSafeTimer)
      }

      const settle = (result: ProjectOpenRunResult): void => {
        if (settled) return
        settled = true
        clearTimers()
        resolveResult(result)
      }

      child.once('error', () => settle({
        exitCode: null,
        signal: null,
        failure: 'spawn'
      }))
      child.once('close', (exitCode, signal) => settle({
        exitCode,
        signal,
        failure: timedOut ? 'timeout' : null
      }))
    })
  }
}

function resolveTarget(target: unknown): TargetSpec {
  if (typeof target !== 'string') {
    throw new ProjectOpenServiceError('invalid-target', null)
  }
  const spec = TARGET_SPEC_BY_ID.get(target as ProjectOpenTarget)
  if (!spec) throw new ProjectOpenServiceError('invalid-target', null)
  return spec
}

async function inspectProject(
  projectPath: string,
  target: ProjectOpenTarget
): Promise<ProjectIdentity> {
  if (
    typeof projectPath !== 'string' ||
    projectPath.length === 0 ||
    projectPath.length > MAX_PROJECT_PATH_CHARS ||
    !isAbsolute(projectPath) ||
    normalize(projectPath) !== projectPath
  ) {
    throw new ProjectOpenServiceError('invalid-project', target)
  }

  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(projectPath)
  } catch (error) {
    throw new ProjectOpenServiceError(
      isMissingError(error) ? 'project-missing' : 'project-unreadable',
      target
    )
  }

  if (info.isSymbolicLink()) {
    throw new ProjectOpenServiceError('project-changed', target)
  }
  if (!info.isDirectory()) {
    throw new ProjectOpenServiceError('project-not-directory', target)
  }

  let canonical: string
  try {
    canonical = await realpath(projectPath)
  } catch (error) {
    throw new ProjectOpenServiceError(
      isMissingError(error) ? 'project-missing' : 'project-unreadable',
      target
    )
  }
  if (canonical !== projectPath) {
    throw new ProjectOpenServiceError('project-changed', target)
  }

  try {
    await access(canonical, fsConstants.R_OK | fsConstants.X_OK)
  } catch {
    throw new ProjectOpenServiceError('project-unreadable', target)
  }

  return { device: info.dev, inode: info.ino }
}

async function assertUnchangedProject(
  projectPath: string,
  expected: ProjectIdentity,
  target: ProjectOpenTarget
): Promise<void> {
  const current = await inspectProject(projectPath, target)
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new ProjectOpenServiceError('project-changed', target)
  }
}

function fixedApplicationCandidates(applicationName: string): readonly string[] {
  const names = fixedApplicationNames(applicationName)
  const userHome = homedir()
  const candidates = names.flatMap((name) => [
    join('/Applications', `${name}.app`),
    ...(isAbsolute(userHome) ? [join(userHome, 'Applications', `${name}.app`)] : [])
  ])

  if (applicationName === 'Terminal') {
    candidates.unshift(
      '/System/Applications/Utilities/Terminal.app',
      '/Applications/Utilities/Terminal.app'
    )
  }

  return candidates
}

function fixedApplicationNames(applicationName: string): readonly string[] {
  // Fail closed if this private helper is ever called outside TARGET_SPECS.
  switch (applicationName) {
    case 'Cursor':
    case 'Visual Studio Code':
    case 'Visual Studio Code - Insiders':
    case 'Terminal':
    case 'iTerm':
    case 'iTerm2':
    case 'Zed':
    case 'Zed Preview':
      return [applicationName]
    default:
      return []
  }
}

function safeOpenEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C'
  }
  for (const key of ['HOME', 'TMPDIR', 'USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING'] as const) {
    const value = process.env[key]
    if (value && !value.includes('\0')) environment[key] = value
  }
  return environment
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} is outside the supported range.`)
  }
  return resolved
}

function isMissingError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 'ENOTDIR')
  )
}

function publicErrorMessage(code: ProjectOpenErrorCode): string {
  switch (code) {
    case 'invalid-target':
      return 'That project-open target is not supported.'
    case 'invalid-project':
      return 'The registered project folder is invalid.'
    case 'project-missing':
      return 'The project folder is missing.'
    case 'project-not-directory':
      return 'The project location is no longer a folder.'
    case 'project-changed':
      return 'The project folder changed. Check the workspace and try again.'
    case 'project-unreadable':
      return 'The project folder is not accessible.'
    case 'target-unavailable':
      return 'The selected application is not installed.'
    case 'spawn-failed':
      return 'macOS could not start the project-open request.'
    case 'timeout':
      return 'The project-open request timed out.'
    case 'command-failed':
      return 'macOS could not open the project in that application.'
  }
}
