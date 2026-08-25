import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DASHBOARD_MAX_BRANCH_CHARS,
  DASHBOARD_MAX_DIRTY_COUNT,
  DashboardInspector,
  DashboardInspectorError
} from '../../src/main/git/DashboardInspector'
import {
  GIT_DEFAULT_EXECUTABLE,
  GitServiceError,
  type GitProjectSnapshot
} from '../../src/main/git/GitService'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
const PRIVATE_CANARY = 'dashboard-private-canary-42f719'

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('DashboardInspector repository projection', () => {
  it('returns only bounded dashboard state for a primary repository', async () => {
    const { repository } = await createRepository()
    await writeFile(join(repository, 'tracked.txt'), 'modified\n')
    await writeFile(join(repository, PRIVATE_CANARY), 'untracked\n')

    const result = await new DashboardInspector().inspect({
      projectId: 'project-primary',
      canonicalProjectPath: repository
    })

    expect(result).toEqual({
      projectId: 'project-primary',
      isRepository: true,
      isWorktree: false,
      branch: 'main',
      dirtyCount: 2
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(repository)
    expect(serialized).not.toContain(PRIVATE_CANARY)
    expect(serialized).not.toContain('tracked.txt')
    expect(Object.keys(result).sort()).toEqual([
      'branch',
      'dirtyCount',
      'isRepository',
      'isWorktree',
      'projectId'
    ])
  })

  it('identifies a linked worktree without returning its filesystem identity', async () => {
    const { root, repository } = await createRepository()
    const linkedPath = join(root, 'linked-worktree')
    await git(repository, ['worktree', 'add', '-b', 'review/linked', linkedPath])
    const linked = await realpath(linkedPath)

    const result = await new DashboardInspector().inspect({
      projectId: 'project-worktree',
      canonicalProjectPath: linked
    })

    expect(result).toEqual({
      projectId: 'project-worktree',
      isRepository: true,
      isWorktree: true,
      branch: 'review/linked',
      dirtyCount: 0
    })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('.git')
  })

  it('uses one fixed neutral status for non-Git and missing registered folders', async () => {
    const root = await makeTemporaryDirectory()
    const nonRepositoryPath = join(root, 'ordinary-folder')
    await mkdir(nonRepositoryPath)
    const nonRepository = await realpath(nonRepositoryPath)

    const inspector = new DashboardInspector()
    await expect(inspector.inspect({
      projectId: 'ordinary-project',
      canonicalProjectPath: nonRepository
    })).resolves.toEqual({
      projectId: 'ordinary-project',
      isRepository: false,
      isWorktree: false,
      dirtyCount: 0
    })
    await expect(inspector.inspect({
      projectId: 'missing-project',
      canonicalProjectPath: join(root, PRIVATE_CANARY)
    })).resolves.toEqual({
      projectId: 'missing-project',
      isRepository: false,
      isWorktree: false,
      dirtyCount: 0
    })
  })

  it('caps branch and dirty-count display data from the privileged service', async () => {
    const branch = `feature/${'x'.repeat(DASHBOARD_MAX_BRANCH_CHARS * 2)}`
    const inspector = new DashboardInspector({
      gitService: { inspect: async () => snapshot({ branch, dirtyCount: 2_000_000 }) }
    })

    const result = await inspector.inspect({
      projectId: 'bounded-project',
      canonicalProjectPath: '/trusted/canonical/project'
    })

    expect(result.branch).toBe(branch.slice(0, DASHBOARD_MAX_BRANCH_CHARS))
    expect(result.branch).toHaveLength(DASHBOARD_MAX_BRANCH_CHARS)
    expect(result.dirtyCount).toBe(DASHBOARD_MAX_DIRTY_COUNT)
  })
})

describe('DashboardInspector failure and command boundaries', () => {
  it('maps unknown diagnostics and Git failures to fixed typed errors without leaks', async () => {
    const privatePath = `/private/${PRIVATE_CANARY}`
    const unknownFailure = new DashboardInspector({
      gitService: {
        inspect: async () => {
          throw new Error(`${PRIVATE_CANARY} ${privatePath} --password secret stderr diff`)
        }
      }
    })
    const unknownError = await rejection(unknownFailure.inspect({
      projectId: 'canary-project',
      canonicalProjectPath: privatePath
    }))

    expect(unknownError).toBeInstanceOf(DashboardInspectorError)
    expect(unknownError).toMatchObject({ code: 'inspection-failed' })
    expect(String(unknownError)).toBe(
      'DashboardInspectorError: The dashboard could not inspect the repository state.'
    )
    expect(serializeError(unknownError)).not.toContain(PRIVATE_CANARY)
    expect(serializeError(unknownError)).not.toContain(privatePath)
    expect(serializeError(unknownError)).not.toContain('stderr')

    const timeoutFailure = new DashboardInspector({
      gitService: {
        inspect: async () => {
          throw new GitServiceError('timeout', 'inspect')
        }
      }
    })
    await expect(timeoutFailure.inspect({
      projectId: 'timeout-project',
      canonicalProjectPath: privatePath
    })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects an unsafe project identity before Git and never echoes it', async () => {
    let inspectCount = 0
    const inspector = new DashboardInspector({
      gitService: {
        inspect: async () => {
          inspectCount += 1
          return snapshot()
        }
      }
    })
    const unsafeId = `../${PRIVATE_CANARY}`
    const error = await rejection(inspector.inspect({
      projectId: unsafeId,
      canonicalProjectPath: `/private/${PRIVATE_CANARY}`
    }))

    expect(error).toMatchObject({ code: 'invalid-project-id' })
    expect(serializeError(error)).not.toContain(PRIVATE_CANARY)
    expect(inspectCount).toBe(0)
  })

  it('offers no arbitrary command or diff entry and calls only fixed Git inspection', async () => {
    const inspectedPaths: string[] = []
    let diffCalls = 0
    const reader = {
      inspect: async (path: string) => {
        inspectedPaths.push(path)
        return snapshot()
      },
      readDiff: async () => {
        diffCalls += 1
        throw new Error('must not be called')
      }
    }
    const inspector = new DashboardInspector({ gitService: reader })

    await inspector.inspect({
      projectId: 'fixed-inspection',
      canonicalProjectPath: '/trusted/canonical/project'
    })

    expect(inspectedPaths).toEqual(['/trusted/canonical/project'])
    expect(diffCalls).toBe(0)
    expect(Object.getOwnPropertyNames(DashboardInspector.prototype)).toEqual([
      'constructor',
      'inspect'
    ])
    expect(Object.getOwnPropertyNames(DashboardInspector.prototype)).not.toEqual(
      expect.arrayContaining(['run', 'exec', 'spawn', 'readDiff', 'command'])
    )
  })

  it('returns project identity so a refresh owner can drop stale completion', async () => {
    let resolveInspection!: (value: GitProjectSnapshot) => void
    const inspector = new DashboardInspector({
      gitService: {
        inspect: async () => await new Promise<GitProjectSnapshot>((resolve) => {
          resolveInspection = resolve
        })
      }
    })
    const pending = inspector.inspect({
      projectId: 'previous-selection',
      canonicalProjectPath: '/trusted/previous-project'
    })
    const currentProjectId = 'current-selection'
    resolveInspection(snapshot())

    const completed = await pending
    expect(completed.projectId).toBe('previous-selection')
    expect(completed.projectId).not.toBe(currentProjectId)
    expect(Object.keys(inspector)).not.toContain('timer')
  })
})

function snapshot(options: {
  branch?: string | null
  dirtyCount?: number
  isWorktree?: boolean
} = {}): GitProjectSnapshot {
  const dirtyCount = options.dirtyCount ?? 0
  return {
    branch: {
      name: options.branch === undefined ? 'main' : options.branch,
      detached: options.branch === null,
      head: '0123456789ab'
    },
    worktree: {
      root: `/private/${PRIVATE_CANARY}/worktree`,
      gitDirectory: `/private/${PRIVATE_CANARY}/git-dir`,
      commonDirectory: `/private/${PRIVATE_CANARY}/common-dir`,
      isLinkedWorktree: options.isWorktree ?? false
    },
    status: {
      clean: dirtyCount === 0,
      total: dirtyCount,
      staged: 0,
      unstaged: 0,
      untracked: dirtyCount,
      conflicted: 0
    },
    diff: {
      staged: { files: 0, insertions: 0, deletions: 0, binaryFiles: 0 },
      unstaged: { files: 0, insertions: 0, deletions: 0, binaryFiles: 0 }
    }
  }
}

async function createRepository(): Promise<{ root: string; repository: string }> {
  const root = await makeTemporaryDirectory()
  const repositoryPath = join(root, 'repository')
  await mkdir(repositoryPath)
  const repository = await realpath(repositoryPath)
  await git(repository, ['init', '-b', 'main'])
  await writeFile(join(repository, 'tracked.txt'), 'initial\n')
  await git(repository, ['add', '--', 'tracked.txt'])
  await git(repository, [
    '-c', 'user.name=GrokBuild QA',
    '-c', 'user.email=qa@example.test',
    'commit', '-m', 'initial'
  ])
  return { root, repository }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'grokbuild-dashboard-'))
  const canonical = await realpath(directory)
  temporaryDirectories.push(canonical)
  return canonical
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync(GIT_DEFAULT_EXECUTABLE, [...args], {
    cwd,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0'
    }
  })
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

function serializeError(error: unknown): string {
  return `${String(error)} ${JSON.stringify(error)}`
}
