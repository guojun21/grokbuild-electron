import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GROK_CLI_UPDATE_INSTALL_TIMEOUT_MS,
  canonicalGrokCliUpdateVersionOutput,
  compareCanonicalGrokCliVersions,
  GrokCliRunError,
  GrokCliService,
  NodeGrokCliProcessRunner,
  type GrokCliProcessRunner,
  type GrokCliRunRequest,
  type GrokCliRunResult
} from '../../src/main/grok/GrokCliService'

const CANARY = 'mcp-secret-canary-73c817'
const UPDATE_CANARY = 'update-private-canary-42d18a'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

class RecordingRunner implements GrokCliProcessRunner {
  readonly requests: GrokCliRunRequest[] = []
  result: GrokCliRunResult = {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null
  }
  thrown: unknown

  async run(request: GrokCliRunRequest): Promise<GrokCliRunResult> {
    this.requests.push(request)
    if (this.thrown !== undefined) throw this.thrown
    return this.result
  }
}

describe('GrokCliService', () => {
  it('builds only the fixed Grok 1.0.5 update and MCP argv shapes', async () => {
    const runner = new RecordingRunner()
    runner.result.stdout = '[]'
    const cli = makeCli(runner)

    await cli.checkForUpdate(process.cwd())
    await cli.readVersion(process.cwd())
    await cli.installUpdate(process.cwd(), '1.0.6')
    await cli.listMcp(process.cwd())
    await cli.addMcp({
      cwd: process.cwd(),
      scope: 'project',
      transport: 'stdio',
      name: 'stdio-server',
      command: 'npx',
      args: ['-y', '@example/server', 'value with spaces'],
      environment: [{ name: 'TOKEN', value: CANARY }]
    })
    await cli.addMcp({
      cwd: process.cwd(),
      scope: 'user',
      transport: 'sse',
      name: 'remote-server',
      url: `https://example.test/private/${CANARY}?token=${CANARY}#${CANARY}`,
      headers: [{ name: 'Authorization', value: `Bearer ${CANARY}` }]
    })
    await cli.removeMcp({ cwd: process.cwd(), scope: 'project', name: 'stdio-server' })
    await cli.enableMcp({ cwd: process.cwd(), name: 'stdio-server' })
    await cli.disableMcp({ cwd: process.cwd(), name: 'stdio-server' })
    await cli.doctorMcp(process.cwd(), 'stdio-server')

    expect(runner.requests.map((request) => request.args)).toEqual([
      ['update', '--check', '--json'],
      ['--version'],
      ['update', '--version', '1.0.6'],
      ['mcp', 'list', '--json'],
      [
        'mcp', 'add', '--transport', 'stdio', '--scope', 'project',
        '-e', `TOKEN=${CANARY}`,
        'stdio-server', '--', 'npx', '-y', '@example/server', 'value with spaces'
      ],
      [
        'mcp', 'add', '--transport', 'sse', '--scope', 'user',
        '-H', `Authorization: Bearer ${CANARY}`,
        'remote-server', `https://example.test/private/${CANARY}?token=${CANARY}#${CANARY}`
      ],
      ['mcp', 'remove', 'stdio-server', '--scope', 'project'],
      ['mcp', 'enable', 'stdio-server'],
      ['mcp', 'disable', 'stdio-server'],
      ['mcp', 'doctor', '--json', 'stdio-server']
    ])
    expect(runner.requests.every((request) => request.executable === process.execPath)).toBe(true)
  })

  it('installs one exact checked version with a separate bounded ten-minute timeout', async () => {
    const runner = new RecordingRunner()
    const cli = new GrokCliService({ cliPath: process.execPath, runner })
    const cwd = await realpath(process.cwd())

    await expect(cli.installUpdate(cwd, 'v1.0.6')).resolves.toBeUndefined()

    expect(runner.requests).toEqual([{
      executable: await realpath(process.execPath),
      args: ['update', '--version', '1.0.6'],
      cwd,
      timeoutMs: GROK_CLI_UPDATE_INSTALL_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
      terminateGraceMs: 1_000
    }])
    expect(GROK_CLI_UPDATE_INSTALL_TIMEOUT_MS).toBe(10 * 60_000)
  })

  it('preserves prerelease identity and compares hyphenated semantic versions', () => {
    expect(canonicalGrokCliUpdateVersionOutput(
      'grok 0.1.151-alpha-feature.2 (5115b46bc909)\n'
    )).toBe('0.1.151-alpha-feature.2')
    expect(compareCanonicalGrokCliVersions(
      '0.1.151-alpha-feature.2',
      '0.1.151-alpha-feature.10'
    )).toBeLessThan(0)
    expect(compareCanonicalGrokCliVersions('0.1.151-alpha.2', '0.1.151')).toBeLessThan(0)
    expect(canonicalGrokCliUpdateVersionOutput('grok 0.1.151-alpha.2\nsecret'))
      .toBe('0.1.151-alpha.2')
    expect(canonicalGrokCliUpdateVersionOutput('grok 0.1.151-alpha.2 --force'))
      .toBeUndefined()
  })

  it('redacts nonzero update output, argv, and paths from the fixed public error', async () => {
    const directory = await temporaryDirectory(`grokbuild-${UPDATE_CANARY}-`)
    const runner = new RecordingRunner()
    runner.result = {
      stdout: `stdout ${UPDATE_CANARY} ${directory}`,
      stderr: `stderr ${UPDATE_CANARY} --token private`,
      exitCode: 9,
      signal: null
    }
    const cli = makeCli(runner)

    const error = await rejection(cli.installUpdate(directory, '1.0.6'))

    expect(error).toMatchObject({
      code: 'command-failed',
      operation: 'update-install',
      exitCode: 9
    })
    expect(String(error)).toBe('GrokCliServiceError: Grok CLI update-install failed (exit 9)')
    expect(serializeError(error)).not.toContain(UPDATE_CANARY)
    expect(serializeError(error)).not.toContain(directory)
    expect(serializeError(error)).not.toContain('stdout')
    expect(serializeError(error)).not.toContain('stderr')
    expect(serializeError(error)).not.toContain('--token')
  })

  it.each([
    ['timeout', new GrokCliRunError('timeout'), 'timeout'],
    ['output limit', new GrokCliRunError('output-limit'), 'output-limit'],
    [
      'spawn failure',
      new Error(`spawn ${UPDATE_CANARY} --update-argv private stderr`),
      'spawn-failed'
    ]
  ] as const)('maps update %s to a redacted fixed error', async (_label, thrown, code) => {
    const directory = await temporaryDirectory(`grokbuild-${UPDATE_CANARY}-`)
    const runner = new RecordingRunner()
    runner.thrown = thrown
    const cli = makeCli(runner)

    const error = await rejection(cli.installUpdate(directory, '1.0.6'))

    expect(error).toMatchObject({ code, operation: 'update-install' })
    expect(serializeError(error)).not.toContain(UPDATE_CANARY)
    expect(serializeError(error)).not.toContain(directory)
    expect(serializeError(error)).not.toContain('--update-argv')
    expect(serializeError(error)).not.toContain('private stderr')
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]?.args).toEqual(['update', '--version', '1.0.6'])
  })

  it('validates update CLI and cwd before spawn and bounds its dedicated timeout', async () => {
    const runner = new RecordingRunner()
    const missingCli = join(tmpdir(), `missing-cli-${UPDATE_CANARY}`)
    const invalidCli = new GrokCliService({ cliPath: missingCli, runner })
    const cliError = await rejection(invalidCli.installUpdate(process.cwd(), '1.0.6'))
    expect(cliError).toMatchObject({ code: 'invalid-cli', operation: 'update-install' })
    expect(serializeError(cliError)).not.toContain(missingCli)
    expect(serializeError(cliError)).not.toContain(UPDATE_CANARY)

    const cli = makeCli(runner)
    const missingCwd = join(tmpdir(), `missing-cwd-${UPDATE_CANARY}`)
    const cwdError = await rejection(cli.installUpdate(missingCwd, '1.0.6'))
    expect(cwdError).toMatchObject({ code: 'invalid-cwd', operation: 'update-install' })
    expect(serializeError(cwdError)).not.toContain(missingCwd)
    expect(serializeError(cwdError)).not.toContain(UPDATE_CANARY)
    expect(runner.requests).toEqual([])

    const versionError = await rejection(cli.installUpdate(process.cwd(), '1.0.6\n--force'))
    expect(versionError).toMatchObject({ code: 'invalid-version', operation: 'update-install' })
    expect(runner.requests).toEqual([])

    expect(() => new GrokCliService({
      cliPath: process.execPath,
      updateInstallTimeoutMs: GROK_CLI_UPDATE_INSTALL_TIMEOUT_MS + 1
    })).toThrow(TypeError)
    expect(() => new GrokCliService({
      cliPath: process.execPath,
      updateInstallTimeoutMs: 99
    })).toThrow(TypeError)
  })

  it('validates an absolute executable file and an existing absolute cwd before invoking runner', async () => {
    const runner = new RecordingRunner()
    const invalidCli = new GrokCliService({ cliPath: 'grok', runner })
    await expect(invalidCli.listMcp(process.cwd())).rejects.toMatchObject({ code: 'invalid-cli' })
    expect(runner.requests).toEqual([])

    const cli = makeCli(runner)
    await expect(cli.listMcp('relative-project')).rejects.toMatchObject({ code: 'invalid-cwd' })
    expect(runner.requests).toEqual([])
  })

  it('never includes runner errors, stdout, stderr, or complete argv in public errors', async () => {
    const runner = new RecordingRunner()
    const cli = makeCli(runner)
    runner.result = {
      stdout: `stdout ${CANARY}`,
      stderr: `stderr ${CANARY}`,
      exitCode: 7,
      signal: null
    }

    const nonzeroError = await rejection(cli.addMcp({
      cwd: process.cwd(),
      scope: 'user',
      transport: 'stdio',
      name: 'safe-name',
      command: 'npx',
      args: ['--token', CANARY],
      environment: []
    }))
    expect(serializeError(nonzeroError)).not.toContain(CANARY)
    expect(nonzeroError).toMatchObject({ code: 'command-failed', operation: 'mcp-add' })

    runner.thrown = new Error(`injected runner leaked ${CANARY}`)
    const runnerError = await rejection(cli.listMcp(process.cwd()))
    expect(serializeError(runnerError)).not.toContain(CANARY)
    expect(runnerError).toMatchObject({ code: 'spawn-failed' })
  })
})

describe('NodeGrokCliProcessRunner', () => {
  it('enforces a combined stdout/stderr byte cap', async () => {
    const runner = new NodeGrokCliProcessRunner()
    const promise = runner.run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxOutputBytes: 32,
      terminateGraceMs: 20
    })

    const error = await rejection(promise)
    expect(error).toBeInstanceOf(GrokCliRunError)
    expect(error).toMatchObject({ kind: 'output-limit' })
  })

  it('uses TERM followed by KILL when a child ignores TERM', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'grokbuild-cli-runner-'))
    temporaryDirectories.push(directory)
    const marker = join(directory, 'received-term')
    const runner = new NodeGrokCliProcessRunner()
    const script = [
      'const fs = require("node:fs")',
      `process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(marker)}, "term"))`,
      'setInterval(() => {}, 1000)'
    ].join(';')

    const error = await rejection(runner.run({
      executable: process.execPath,
      args: ['-e', script],
      cwd: directory,
      timeoutMs: 150,
      maxOutputBytes: 1_024,
      terminateGraceMs: 50
    }))

    expect(error).toMatchObject({ kind: 'timeout' })
    await expect(readFile(marker, 'utf8')).resolves.toBe('term')
  })
})

function makeCli(runner: GrokCliProcessRunner): GrokCliService {
  return new GrokCliService({
    cliPath: process.execPath,
    runner,
    timeoutMs: 1_000,
    doctorTimeoutMs: 2_000,
    updateInstallTimeoutMs: 3_000,
    maxOutputBytes: 64 * 1_024,
    terminateGraceMs: 20
  })
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
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
