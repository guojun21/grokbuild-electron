import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROJECT_OPEN_EXECUTABLE,
  PROJECT_OPEN_TARGETS,
  ProjectOpenService,
  ProjectOpenServiceError,
  type ProjectApplicationProbe,
  type ProjectOpenProcessRunner,
  type ProjectOpenRunRequest,
  type ProjectOpenRunResult,
  type ProjectOpenTarget
} from '../../src/main/workspaces/ProjectOpenService'

const roots: string[] = []
const PRIVATE_CANARY = 'private-project-open-canary-5d871f'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ProjectOpenService fixed target boundary', () => {
  it('reports the pinned Swift target order using only fixed, main-owned app probes', async () => {
    const runner = new RecordingRunner()
    const probe = new RecordingApplicationProbe([
      'Cursor.app',
      'Terminal.app',
      'Zed Preview.app'
    ])
    const service = new ProjectOpenService({ runner, applicationProbe: probe })

    const statuses = await service.listTargets()

    expect(PROJECT_OPEN_TARGETS).toEqual([
      'finder',
      'cursor',
      'vsCode',
      'terminal',
      'iTerm',
      'zed'
    ])
    expect(statuses).toEqual([
      { target: 'finder', label: 'Finder', installed: true },
      { target: 'cursor', label: 'Cursor', installed: true },
      { target: 'vsCode', label: 'VS Code', installed: false },
      { target: 'terminal', label: 'Terminal', installed: true },
      { target: 'iTerm', label: 'iTerm', installed: false },
      { target: 'zed', label: 'Zed', installed: true }
    ])
    expect(runner.requests).toEqual([])
    expect(probe.paths.length).toBeGreaterThan(0)
    expect(probe.paths.every(isFixedApplicationCandidate)).toBe(true)
    expect(JSON.stringify(statuses)).not.toContain('.app')
    expect(JSON.stringify(statuses)).not.toContain('com.')
  })

  it('rejects unknown and injected targets before touching the filesystem or process runner', async () => {
    const runner = new RecordingRunner()
    const probe = new RecordingApplicationProbe([])
    const service = new ProjectOpenService({ runner, applicationProbe: probe })
    const injectedTarget = `cursor; open -a Calculator; ${PRIVATE_CANARY}`
    const privateProject = `/private/${PRIVATE_CANARY}`

    const error = await rejection(service.openProject(
      privateProject,
      injectedTarget as ProjectOpenTarget
    ))

    expect(error).toBeInstanceOf(ProjectOpenServiceError)
    expect(error).toMatchObject({ code: 'invalid-target', target: null })
    expect(serializeError(error)).not.toContain(PRIVATE_CANARY)
    expect(serializeError(error)).not.toContain(privateProject)
    expect(runner.requests).toEqual([])
    expect(probe.paths).toEqual([])
    expect(Object.getOwnPropertyNames(ProjectOpenService.prototype)).not.toContain('run')
  })

  it('does not expose an arbitrary app path, bundle id, executable, or argv launcher', () => {
    const methods = Object.getOwnPropertyNames(ProjectOpenService.prototype)
    expect(methods).toEqual(expect.arrayContaining(['constructor', 'listTargets', 'openProject']))
    expect(methods).not.toEqual(expect.arrayContaining([
      'openApplication',
      'openBundle',
      'openPath',
      'spawn',
      'exec'
    ]))
  })
})

describe('ProjectOpenService project identity checks', () => {
  it('rejects missing, non-directory, symlink, and non-canonical project paths', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'directory')
    const file = join(root, 'file')
    const alias = join(root, 'alias')
    await mkdir(directory)
    await writeFile(file, 'not a directory')
    await symlink(directory, alias)
    const service = new ProjectOpenService({
      runner: new RecordingRunner(),
      applicationProbe: new RecordingApplicationProbe([])
    })

    await expect(service.openProject(join(root, 'missing'), 'finder')).rejects.toMatchObject({
      code: 'project-missing'
    })
    await expect(service.openProject(file, 'finder')).rejects.toMatchObject({
      code: 'project-not-directory'
    })
    await expect(service.openProject(alias, 'finder')).rejects.toMatchObject({
      code: 'project-changed'
    })
    await expect(service.openProject(`${directory}/../directory`, 'finder'))
      .rejects.toMatchObject({ code: 'invalid-project' })
    await expect(service.openProject('relative/project', 'finder')).rejects.toMatchObject({
      code: 'invalid-project'
    })
  })

  it('detects a project replaced after the initial check and never launches it', async () => {
    const root = await temporaryRoot()
    const project = join(root, 'project')
    const original = join(root, 'original-project')
    const replacement = join(root, 'replacement-project')
    await mkdir(project)
    await mkdir(replacement)
    const runner = new RecordingRunner()
    let replaced = false
    const probe = new RecordingApplicationProbe(['Cursor.app'], async () => {
      if (replaced) return
      replaced = true
      await rename(project, original)
      await rename(replacement, project)
    })
    const service = new ProjectOpenService({ runner, applicationProbe: probe })

    await expect(service.openProject(project, 'cursor')).rejects.toMatchObject({
      code: 'project-changed'
    })
    expect(runner.requests).toEqual([])
  })

  it('does not include private project paths in fixed validation failures', async () => {
    const root = await temporaryRoot()
    const missing = join(root, PRIVATE_CANARY)
    const service = new ProjectOpenService()

    const error = await rejection(service.openProject(missing, 'finder'))
    expect(serializeError(error)).not.toContain(missing)
    expect(serializeError(error)).not.toContain(PRIVATE_CANARY)
    expect(String(error)).toBe('ProjectOpenServiceError: The project folder is missing.')
  })
})

describe('ProjectOpenService /usr/bin/open contract', () => {
  it('opens Finder folders without -R reveal semantics', async () => {
    const project = await temporaryProject()
    const runner = new RecordingRunner()
    const service = new ProjectOpenService({
      runner,
      applicationProbe: new RecordingApplicationProbe([])
    })

    const result = await service.openProject(project, 'finder')

    expect(result).toEqual({ target: 'finder', disposition: 'open-folder', opened: true })
    expect(runner.requests).toEqual([expectedRequest([project])])
    expect(runner.requests[0]?.args).not.toContain('-R')
    expect(JSON.stringify(result)).not.toContain(project)
  })

  it.each([
    ['cursor', 'com.todesktop.230313mzl4w4u92'],
    ['vsCode', 'com.microsoft.VSCode'],
    ['terminal', 'com.apple.Terminal'],
    ['iTerm', 'com.googlecode.iterm2'],
    ['zed', 'dev.zed.Zed']
  ] as const)('uses one fixed -b argv for the installed %s target', async (target, bundleId) => {
    const project = await temporaryProject()
    const runner = new RecordingRunner()
    const service = new ProjectOpenService({
      runner,
      applicationProbe: new RecordingApplicationProbe([installedAppName(target)])
    })

    const result = await service.openProject(project, target)

    expect(result).toEqual({
      target,
      disposition: 'open-with-application',
      opened: true
    })
    expect(runner.requests).toEqual([expectedRequest(['-b', bundleId, project])])
    expect(JSON.stringify(result)).not.toContain(project)
    expect(JSON.stringify(result)).not.toContain(bundleId)
  })

  it('tries only the pinned Cursor bundle fallback when the first fixed id is unavailable', async () => {
    const project = await temporaryProject()
    const runner = new RecordingRunner()
    runner.results.push(
      { exitCode: 1, signal: null, failure: null },
      { exitCode: 0, signal: null, failure: null }
    )
    const service = new ProjectOpenService({
      runner,
      applicationProbe: new RecordingApplicationProbe(['Cursor.app'])
    })

    await expect(service.openProject(project, 'cursor')).resolves.toMatchObject({ opened: true })
    expect(runner.requests).toEqual([
      expectedRequest(['-b', 'com.todesktop.230313mzl4w4u92', project]),
      expectedRequest(['-b', 'com.cursor.Cursor', project])
    ])
  })

  it('refuses unavailable apps before invoking /usr/bin/open', async () => {
    const project = await temporaryProject()
    const runner = new RecordingRunner()
    const service = new ProjectOpenService({
      runner,
      applicationProbe: new RecordingApplicationProbe([])
    })

    await expect(service.openProject(project, 'cursor')).rejects.toMatchObject({
      code: 'target-unavailable',
      target: 'cursor'
    })
    expect(runner.requests).toEqual([])
  })
})

describe('ProjectOpenService process failures', () => {
  it('maps thrown diagnostics to one fixed spawn error without leaking path, argv, or stderr', async () => {
    const project = await temporaryProject(PRIVATE_CANARY)
    const runner = new RecordingRunner()
    runner.thrown = new Error(
      `${PRIVATE_CANARY} ${project} -b com.todesktop.230313mzl4w4u92 private stderr`
    )
    const service = new ProjectOpenService({
      runner,
      applicationProbe: new RecordingApplicationProbe(['Cursor.app'])
    })

    const error = await rejection(service.openProject(project, 'cursor'))

    expect(error).toMatchObject({ code: 'spawn-failed', target: 'cursor' })
    expect(String(error)).toBe(
      'ProjectOpenServiceError: macOS could not start the project-open request.'
    )
    expect(serializeError(error)).not.toContain(PRIVATE_CANARY)
    expect(serializeError(error)).not.toContain(project)
    expect(serializeError(error)).not.toContain('com.todesktop')
    expect(serializeError(error)).not.toContain('private stderr')
  })

  it('maps timeout without trying another bundle and bounds process options', async () => {
    const project = await temporaryProject()
    const runner = new RecordingRunner()
    runner.results.push({ exitCode: null, signal: 'SIGKILL', failure: 'timeout' })
    const service = new ProjectOpenService({
      runner,
      applicationProbe: new RecordingApplicationProbe(['Cursor.app']),
      timeoutMs: 75,
      terminateGraceMs: 20
    })

    await expect(service.openProject(project, 'cursor')).rejects.toMatchObject({
      code: 'timeout',
      target: 'cursor'
    })
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]).toMatchObject({
      executable: PROJECT_OPEN_EXECUTABLE,
      timeoutMs: 75,
      terminateGraceMs: 20,
      shell: false
    })
    expect(() => new ProjectOpenService({ timeoutMs: 49 })).toThrow(RangeError)
    expect(() => new ProjectOpenService({ terminateGraceMs: 9 })).toThrow(RangeError)
  })

  it('maps nonzero exit after fixed bundle fallbacks to a redacted command failure', async () => {
    const project = await temporaryProject(PRIVATE_CANARY)
    const runner = new RecordingRunner()
    runner.result = { exitCode: 1, signal: null, failure: null }
    const service = new ProjectOpenService({
      runner,
      applicationProbe: new RecordingApplicationProbe(['Cursor.app'])
    })

    const error = await rejection(service.openProject(project, 'cursor'))

    expect(error).toMatchObject({ code: 'command-failed', target: 'cursor' })
    expect(String(error)).toBe(
      'ProjectOpenServiceError: macOS could not open the project in that application.'
    )
    expect(serializeError(error)).not.toContain(project)
    expect(serializeError(error)).not.toContain(PRIVATE_CANARY)
    expect(serializeError(error)).not.toContain('com.todesktop')
    expect(serializeError(error)).not.toContain('com.cursor')
    expect(runner.requests).toHaveLength(2)
  })
})

class RecordingRunner implements ProjectOpenProcessRunner {
  readonly requests: ProjectOpenRunRequest[] = []
  readonly results: ProjectOpenRunResult[] = []
  result: ProjectOpenRunResult = { exitCode: 0, signal: null, failure: null }
  thrown: unknown

  async run(request: ProjectOpenRunRequest): Promise<ProjectOpenRunResult> {
    this.requests.push(request)
    if (this.thrown !== undefined) throw this.thrown
    return this.results.shift() ?? this.result
  }
}

class RecordingApplicationProbe implements ProjectApplicationProbe {
  readonly paths: string[] = []

  constructor(
    private readonly installedBasenames: readonly string[],
    private readonly beforeFirstProbe?: (() => Promise<void>) | undefined
  ) {}

  async isDirectory(path: string): Promise<boolean> {
    this.paths.push(path)
    if (this.paths.length === 1) await this.beforeFirstProbe?.()
    return this.installedBasenames.includes(basename(path))
  }
}

function expectedRequest(args: readonly string[]): ProjectOpenRunRequest {
  return {
    executable: PROJECT_OPEN_EXECUTABLE,
    args,
    timeoutMs: 5_000,
    terminateGraceMs: 250,
    shell: false
  }
}

function installedAppName(target: Exclude<ProjectOpenTarget, 'finder'>): string {
  switch (target) {
    case 'cursor':
      return 'Cursor.app'
    case 'vsCode':
      return 'Visual Studio Code.app'
    case 'terminal':
      return 'Terminal.app'
    case 'iTerm':
      return 'iTerm.app'
    case 'zed':
      return 'Zed.app'
  }
}

function isFixedApplicationCandidate(path: string): boolean {
  const allowedBasenames = new Set([
    'Cursor.app',
    'Visual Studio Code.app',
    'Visual Studio Code - Insiders.app',
    'Terminal.app',
    'iTerm.app',
    'iTerm2.app',
    'Zed.app',
    'Zed Preview.app'
  ])
  if (!allowedBasenames.has(basename(path))) return false
  const parent = dirname(path)
  return parent === '/Applications' ||
    parent === '/System/Applications/Utilities' ||
    parent === '/Applications/Utilities' ||
    parent === join(homedir(), 'Applications')
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grokbuild-project-open-')))
  roots.push(root)
  return root
}

async function temporaryProject(suffix = 'project'): Promise<string> {
  const root = await temporaryRoot()
  const project = join(root, suffix)
  await mkdir(project)
  return await realpath(project)
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject.')
}

function serializeError(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error)
  const enumerableDetails = { ...error }
  return JSON.stringify({
    ...enumerableDetails,
    name: error.name,
    message: error.message,
    stack: error.stack
  })
}
