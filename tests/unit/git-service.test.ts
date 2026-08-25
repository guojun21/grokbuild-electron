import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GIT_DEFAULT_EXECUTABLE,
  GitService,
  GitServiceError,
  parseNumstat,
  parsePorcelainStatus
} from '../../src/main/git/GitService'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
const ERROR_CANARY = 'git-private-canary-873f19'
type GitServiceOptions = NonNullable<ConstructorParameters<typeof GitService>[0]>
type GitProcessRunner = NonNullable<GitServiceOptions['runner']>
type GitRunRequest = Parameters<GitProcessRunner['run']>[0]
type GitRunResult = Awaited<ReturnType<GitProcessRunner['run']>>

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('GitService read-only repository inspection', () => {
  it('reports a slash-containing current branch and the primary worktree identity', async () => {
    const { repository } = await createRepository()
    await git(repository, ['checkout', '-b', 'feature/slash/name'])

    const snapshot = await new GitService().inspect(repository)

    expect(snapshot.branch).toMatchObject({
      name: 'feature/slash/name',
      detached: false
    })
    expect(snapshot.branch.head).toMatch(/^[0-9a-f]{12}$/)
    expect(snapshot.worktree).toEqual({
      root: repository,
      gitDirectory: await realpath(join(repository, '.git')),
      commonDirectory: await realpath(join(repository, '.git')),
      isLinkedWorktree: false
    })
    expect(snapshot.status).toEqual({
      clean: true,
      total: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0
    })
  })

  it('distinguishes a linked worktree and preserves its slash branch identity', async () => {
    const { root, repository } = await createRepository()
    const linked = join(root, 'linked-worktree')
    await git(repository, ['worktree', 'add', '-b', 'review/linked/slash', linked])
    const canonicalLinked = await realpath(linked)

    const main = await new GitService().inspect(repository)
    const worktree = await new GitService().inspect(canonicalLinked)

    expect(worktree.branch.name).toBe('review/linked/slash')
    expect(worktree.worktree.root).toBe(canonicalLinked)
    expect(worktree.worktree.isLinkedWorktree).toBe(true)
    expect(worktree.worktree.commonDirectory).toBe(main.worktree.commonDirectory)
    expect(worktree.worktree.gitDirectory).not.toBe(main.worktree.gitDirectory)
  })

  it('counts staged, unstaged, and untracked entries and returns fixed-scope diffs', async () => {
    const { repository } = await createRepository({
      'staged.txt': 'old\n',
      'unstaged.txt': 'old\n',
      'both.txt': 'old\n'
    })
    await writeFile(join(repository, 'staged.txt'), 'staged\n')
    await git(repository, ['add', 'staged.txt'])
    await writeFile(join(repository, 'unstaged.txt'), 'unstaged\n')
    await writeFile(join(repository, 'both.txt'), 'index\n')
    await git(repository, ['add', 'both.txt'])
    await writeFile(join(repository, 'both.txt'), 'worktree\n')
    await writeFile(join(repository, 'untracked.txt'), 'new\n')

    const service = new GitService()
    const snapshot = await service.inspect(repository)

    expect(snapshot.status).toEqual({
      clean: false,
      total: 4,
      staged: 2,
      unstaged: 2,
      untracked: 1,
      conflicted: 0
    })
    expect(snapshot.diff).toEqual({
      staged: { files: 2, insertions: 2, deletions: 2, binaryFiles: 0 },
      unstaged: { files: 2, insertions: 2, deletions: 2, binaryFiles: 0 }
    })

    const staged = await service.readDiff(repository, 'staged')
    expect(staged.scope).toBe('staged')
    expect(staged.patch).toContain('+staged')
    expect(staged.patch).toContain('+index')
    expect(staged.patch).not.toContain('+unstaged')

    const unstaged = await service.readDiff(repository, 'unstaged')
    expect(unstaged.scope).toBe('unstaged')
    expect(unstaged.patch).toContain('+unstaged')
    expect(unstaged.patch).toContain('+worktree')
    expect(unstaged.patch).not.toContain('+staged')
  })

  it('reports detached HEAD and binary diff summary without exposing file content in status', async () => {
    const { repository } = await createRepository({ 'binary.dat': Buffer.from([0, 1, 2]) })
    await git(repository, ['checkout', '--detach'])
    await writeFile(join(repository, 'binary.dat'), Buffer.from([0, 7, 9, 11]))
    await git(repository, ['add', 'binary.dat'])

    const snapshot = await new GitService().inspect(repository)
    expect(snapshot.branch).toMatchObject({ name: null, detached: true })
    expect(snapshot.branch.head).toMatch(/^[0-9a-f]{12}$/)
    expect(snapshot.status).toMatchObject({ staged: 1, total: 1 })
    expect(snapshot.diff.staged).toEqual({
      files: 1,
      insertions: 0,
      deletions: 0,
      binaryFiles: 1
    })
  })

  it('parses Git\'s real NUL-delimited rename records without double counting paths', async () => {
    const { repository } = await createRepository({ 'before.txt': 'rename me\n' })
    await git(repository, ['mv', 'before.txt', 'after.txt'])

    const snapshot = await new GitService().inspect(repository)
    expect(snapshot.status).toEqual({
      clean: false,
      total: 1,
      staged: 1,
      unstaged: 0,
      untracked: 0,
      conflicted: 0
    })
    expect(snapshot.diff.staged).toEqual({
      files: 1,
      insertions: 0,
      deletions: 0,
      binaryFiles: 0
    })
  })

  it('rejects non-repositories, relative paths, aliases, and non-canonical project paths', async () => {
    const root = await makeTemporaryDirectory()
    const { repository } = await createRepository()
    const repositoryAlias = join(root, 'repository-alias')
    await symlink(repository, repositoryAlias)
    const service = new GitService()

    await expect(service.inspect(root)).rejects.toMatchObject({ code: 'not-repository' })
    await expect(service.inspect('relative-project')).rejects.toMatchObject({ code: 'invalid-project' })
    await expect(service.inspect(repositoryAlias)).rejects.toMatchObject({ code: 'invalid-project' })
    await expect(service.inspect(`${repository}/`)).rejects.toMatchObject({ code: 'invalid-project' })
  })

  it('has no arbitrary argv entry and rejects unsupported diff scopes before running Git', async () => {
    const runner = new RecordingRunner()
    const service = new GitService({ gitPath: process.execPath, runner })

    expect(Object.getOwnPropertyNames(GitService.prototype)).not.toContain('run')
    await expect(service.readDiff(process.cwd(), 'HEAD~1' as never)).rejects.toMatchObject({
      code: 'invalid-request'
    })
    expect(runner.requests).toEqual([])
  })
})

describe('GitService process and output boundaries', () => {
  it('maps runner timeout, output, and arbitrary failures to fixed public errors', async () => {
    const { repository } = await createRepository()
    const outputExecutable = await fakeGitExecutable(
      'printf "%0256d" 0\nwhile :; do /bin/sleep 1; done'
    )
    await expectFixedError(new GitService({
      gitPath: outputExecutable,
      maxOutputBytes: 64,
      timeoutMs: 5_000,
      terminateGraceMs: 20
    }).inspect(repository), 'output-limit')

    const timeoutExecutable = await fakeGitExecutable(
      "trap '' TERM\nwhile :; do /bin/sleep 1; done"
    )
    await expectFixedError(new GitService({
      gitPath: timeoutExecutable,
      maxOutputBytes: 1_024,
      timeoutMs: 75,
      terminateGraceMs: 20
    }).inspect(repository), 'timeout')

    const runner = new RecordingRunner()
    const service = new GitService({ gitPath: process.execPath, runner })
    runner.thrown = new Error(`must not leak ${ERROR_CANARY} ${repository}`)
    const error = await rejection(service.inspect(repository))
    expect(error).toMatchObject({ code: 'spawn-failed' })
    expect(serializeError(error)).not.toContain(ERROR_CANARY)
    expect(serializeError(error)).not.toContain(repository)
  })

  it('never forwards stderr, stdout, argv, or project paths from command failures', async () => {
    const { repository } = await createRepository()
    const runner = new RecordingRunner()
    runner.result = {
      stdout: '',
      stderr: `${ERROR_CANARY} ${repository} --password private`,
      exitCode: 128,
      signal: null
    }
    const service = new GitService({ gitPath: process.execPath, runner })

    const error = await rejection(service.inspect(repository))
    expect(error).toMatchObject({ code: 'not-repository', operation: 'inspect' })
    expect(serializeError(error)).not.toContain(ERROR_CANARY)
    expect(serializeError(error)).not.toContain(repository)
    expect(String(error)).toBe('GitServiceError: The project is not a Git repository.')
  })

  it('enforces the service output budget against a real repository', async () => {
    const { repository } = await createRepository()
    for (let index = 0; index < 20; index += 1) {
      await writeFile(
        join(repository, `untracked-${String(index).padStart(2, '0')}-${'x'.repeat(24)}.txt`),
        'content\n'
      )
    }
    const service = new GitService({ maxOutputBytes: 128 })

    await expect(service.inspect(repository)).rejects.toMatchObject({ code: 'output-limit' })
  })

  it('requires an absolute executable and bounds constructor options', async () => {
    const { repository } = await createRepository()
    await expect(new GitService({ gitPath: 'git' }).inspect(repository)).rejects.toMatchObject({
      code: 'invalid-git'
    })
    expect(() => new GitService({ timeoutMs: 49 })).toThrow(RangeError)
    expect(() => new GitService({ maxOutputBytes: 63 })).toThrow(RangeError)
    expect(() => new GitService({ terminateGraceMs: 9 })).toThrow(RangeError)
  })
})

describe('Git porcelain parsers', () => {
  it('counts conflicts and consumes the second rename path without double counting', () => {
    expect(parsePorcelainStatus('R  renamed.txt\0old.txt\0UU conflict.txt\0?? new.txt\0')).toEqual({
      clean: false,
      total: 3,
      staged: 1,
      unstaged: 0,
      untracked: 1,
      conflicted: 1
    })
  })

  it('counts text and binary numstat records while ignoring rename path continuations', () => {
    const output = [
      '2\t1\ttext.txt',
      '-\t-\tbinary.dat',
      '0\t0\t',
      'old.txt',
      'new.txt',
      ''
    ].join('\0')
    expect(parseNumstat(output)).toEqual({
      files: 3,
      insertions: 2,
      deletions: 1,
      binaryFiles: 1
    })
  })

  it('rejects malformed porcelain records with fixed output errors', () => {
    expect(() => parsePorcelainStatus('malformed\0')).toThrow(GitServiceError)
  })
})

class RecordingRunner implements GitProcessRunner {
  readonly requests: GitRunRequest[] = []
  result: GitRunResult = { stdout: '', stderr: '', exitCode: 0, signal: null }
  thrown: unknown

  async run(request: GitRunRequest): Promise<GitRunResult> {
    this.requests.push(request)
    if (this.thrown !== undefined) throw this.thrown
    return this.result
  }
}

async function createRepository(
  files: Record<string, string | Buffer> = { 'tracked.txt': 'initial\n' }
): Promise<{ root: string; repository: string }> {
  const root = await makeTemporaryDirectory()
  const repositoryPath = join(root, 'repository')
  await mkdir(repositoryPath)
  const repository = await realpath(repositoryPath)
  await git(repository, ['init', '-b', 'main'])
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(repository, name), content)
  }
  await git(repository, ['add', '--', ...Object.keys(files)])
  await git(repository, [
    '-c', 'user.name=GrokBuild QA',
    '-c', 'user.email=qa@example.test',
    'commit', '-m', 'initial'
  ])
  return { root, repository }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'grokbuild-git-service-'))
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

async function fakeGitExecutable(body: string): Promise<string> {
  const directory = await makeTemporaryDirectory()
  const executable = join(directory, 'controlled-git')
  await writeFile(executable, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  await chmod(executable, 0o700)
  return await realpath(executable)
}

async function expectFixedError(
  promise: Promise<unknown>,
  code: 'timeout' | 'output-limit'
): Promise<void> {
  const error = await rejection(promise)
  expect(error).toMatchObject({ code, operation: 'inspect' })
  expect(serializeError(error)).not.toContain(ERROR_CANARY)
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
