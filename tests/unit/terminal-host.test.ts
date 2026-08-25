import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TERMINAL_DEFAULT_OUTPUT_BYTE_LIMIT,
  TERMINAL_MAX_COUNT,
  TERMINAL_SESSION_OUTPUT_BYTE_LIMIT,
  TerminalHost,
  TerminalHostError,
  splitTerminalCommandLine,
  truncateTerminalOutput
} from '../../src/main/acp/TerminalHost'

const hosts: TerminalHost[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stopAll()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('TerminalHost', () => {
  it('runs the real wire bash -lc command with shell:false semantics and merges output', async () => {
    const host = makeHost()
    const created = await host.create({
      sessionId: 'session-1',
      command: "/bin/bash -lc 'printf stdout-marker; printf stderr-marker >&2'"
    })

    await expect(host.waitForExit(scoped(created.terminalId))).resolves.toEqual({
      exitCode: 0,
      signal: null
    })
    const output = host.output(scoped(created.terminalId))
    expect(output.output).toContain('stdout-marker')
    expect(output.output).toContain('stderr-marker')
    expect(output.truncated).toBe(false)
    expect(output.exitStatus).toEqual({ exitCode: 0, signal: null })
  })

  it('supports an executable plus args, bounded cwd, and ACP env list', async () => {
    const directory = await makeTemporaryDirectory()
    const host = makeHost(directory)
    const script = 'process.stdout.write(`${process.cwd()}|${process.env.QA_VALUE ?? ""}`)'
    const created = await host.create({
      sessionId: 'session-1',
      command: process.execPath,
      args: ['-e', script],
      cwd: '.',
      env: [{ name: 'QA_VALUE', value: 'env-ok' }]
    })

    await host.waitForExit(scoped(created.terminalId))
    const output = host.output(scoped(created.terminalId)).output
    expect(output).toContain(directory.split('/').at(-1) ?? directory)
    expect(output.endsWith('|env-ok')).toBe(true)
  })

  it('accepts the ACP command-array compatibility shape and an env map', async () => {
    const host = makeHost()
    const created = await host.create({
      sessionId: 'session-1',
      command: [process.execPath, '-e', 'process.stdout.write(process.env.QA_MAP ?? "")'],
      env: { QA_MAP: 'map-ok' }
    })

    await host.waitForExit(scoped(created.terminalId))
    expect(host.output(scoped(created.terminalId)).output).toBe('map-ok')
  })

  it('keeps only a UTF-8-safe suffix within outputByteLimit', async () => {
    const host = makeHost()
    const created = await host.create({
      sessionId: 'session-1',
      command: process.execPath,
      args: ['-e', "process.stdout.write('ééé')"],
      outputByteLimit: 3
    })

    await host.waitForExit(scoped(created.terminalId))
    const snapshot = host.output(scoped(created.terminalId))
    expect(snapshot.output).toBe('é')
    expect(Buffer.byteLength(snapshot.output)).toBeLessThanOrEqual(3)
    expect(snapshot.truncated).toBe(true)
  })

  it('honors a zero outputByteLimit without retaining output', async () => {
    const host = makeHost()
    const created = await host.create({
      sessionId: 'session-1',
      command: '/bin/echo',
      args: ['must-not-be-retained'],
      outputByteLimit: 0
    })

    await host.waitForExit(scoped(created.terminalId))
    expect(host.output(scoped(created.terminalId))).toMatchObject({
      output: '',
      truncated: true
    })
    expect(host.retainedOutputByteCount).toBe(0)
  })

  it('enforces a session-wide retained-output budget across terminals', async () => {
    const host = makeHost(undefined, { maxRetainedOutputBytes: 8 })
    const first = await host.create({
      sessionId: 'session-1',
      command: process.execPath,
      args: ['-e', "process.stdout.write('ééé')"]
    })
    await host.waitForExit(scoped(first.terminalId))
    const second = await host.create({
      sessionId: 'session-1',
      command: '/bin/echo',
      args: ['abcd']
    })
    await host.waitForExit(scoped(second.terminalId))

    const firstOutput = host.output(scoped(first.terminalId))
    const secondOutput = host.output(scoped(second.terminalId))
    expect(firstOutput.output).toBe('é')
    expect(firstOutput.truncated).toBe(true)
    expect(secondOutput.output).toBe('abcd\n')
    expect(Buffer.byteLength(firstOutput.output) + Buffer.byteLength(secondOutput.output))
      .toBeLessThanOrEqual(8)
    expect(host.retainedOutputByteCount).toBeLessThanOrEqual(8)
  })

  it('requires an exact sessionId before looking up a terminal', async () => {
    const host = makeHost()
    const created = await host.create({
      sessionId: 'session-1',
      command: '/bin/sleep',
      args: ['30']
    })

    expectTerminalError(
      () => host.output({ sessionId: 'different-session', terminalId: created.terminalId }),
      -32602,
      'does not match'
    )
    expectTerminalError(
      () => host.output({ sessionId: 'session-1', terminalId: 'missing' }),
      -32602,
      'Unknown terminalId'
    )
    expectTerminalError(
      () => host.output({ terminalId: created.terminalId }),
      -32602,
      'requires sessionId'
    )
    expectTerminalError(
      () => host.output({ sessionId: 'session-1' }),
      -32602,
      'requires terminalId'
    )
    await expect(host.create({ sessionId: 'session-1' })).rejects.toMatchObject({
      rpcCode: -32602,
      message: 'terminal/create requires command'
    })
  })

  it('fails closed for unknown methods and invalid or unknown executables', async () => {
    const host = makeHost()
    await expect(host.handle('terminal/not_real', { sessionId: 'session-1' }))
      .rejects.toMatchObject({ rpcCode: -32601 })
    await expect(host.create({
      sessionId: 'session-1',
      command: 'definitely-not-an-executable-grokbuild'
    })).rejects.toMatchObject({
      rpcCode: -32603,
      message: 'Terminal executable was not found or is not executable'
    })
  })

  it('enforces the hard terminal count and reaps on release and stopAll', async () => {
    const host = makeHost(undefined, { maxTerminals: 2 })
    const first = await host.create({
      sessionId: 'session-1',
      command: '/bin/sleep',
      args: ['30']
    })
    const firstExit = host.waitForExit(scoped(first.terminalId))
    const second = await host.create({
      sessionId: 'session-1',
      command: '/bin/sleep',
      args: ['30']
    })
    await expect(host.create({
      sessionId: 'session-1',
      command: '/bin/echo'
    })).rejects.toMatchObject({ rpcCode: -32603 })

    await host.release(scoped(first.terminalId))
    await expect(firstExit).resolves.toMatchObject({ exitCode: null, signal: 'SIGTERM' })
    expect(host.activeTerminalCount).toBe(1)
    expect(() => host.output(scoped(first.terminalId))).toThrow('Unknown terminalId')

    await host.stopAll()
    expect(host.activeTerminalCount).toBe(0)
    await expect(host.create({
      sessionId: 'session-1',
      command: '/bin/echo'
    })).rejects.toThrow('Terminal host is stopped')
    expect(second.terminalId).toMatch(/^term_[a-f0-9]{24}$/)
  })

  it('reserves capacity safely across concurrent creates and coalesces stopAll', async () => {
    const host = makeHost(undefined, { maxTerminals: 1 })
    const attempts = await Promise.allSettled([
      host.create({ sessionId: 'session-1', command: '/bin/sleep', args: ['30'] }),
      host.create({ sessionId: 'session-1', command: '/bin/sleep', args: ['30'] })
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    expect(host.activeTerminalCount).toBe(1)

    const firstStop = host.stopAll()
    const secondStop = host.stopAll()
    expect(secondStop).toBe(firstStop)
    await firstStop
    expect(host.activeTerminalCount).toBe(0)
  })

  it('kills a running process but retains its output record until release', async () => {
    const host = makeHost()
    const created = await host.create({
      sessionId: 'session-1',
      command: '/bin/sleep',
      args: ['30']
    })

    await expect(host.kill(scoped(created.terminalId))).resolves.toEqual({})
    await expect(host.waitForExit(scoped(created.terminalId))).resolves.toEqual({
      exitCode: null,
      signal: 'SIGTERM'
    })
    expect(host.output(scoped(created.terminalId)).exitStatus).toEqual({
      exitCode: null,
      signal: 'SIGTERM'
    })
    await host.release(scoped(created.terminalId))
  })

  it.runIf(process.platform !== 'win32')('reaps an exited command\'s detached process group on release', async () => {
    const host = makeHost()
    const created = await host.create({
      sessionId: 'session-1',
      command: '/bin/bash',
      args: ['-lc', "trap '' HUP; /bin/sleep 30 </dev/null >/dev/null 2>&1 & printf %s $!"]
    })
    await host.waitForExit(scoped(created.terminalId))
    const backgroundPid = Number(host.output(scoped(created.terminalId)).output)
    expect(Number.isInteger(backgroundPid)).toBe(true)
    expect(processExists(backgroundPid)).toBe(true)

    try {
      await host.release(scoped(created.terminalId))
      expect(await processDisappears(backgroundPid)).toBe(true)
    } finally {
      if (processExists(backgroundPid)) {
        try {
          process.kill(backgroundPid, 'SIGKILL')
        } catch {
          // The release won the race.
        }
      }
    }
  })

  it('rejects oversized output, environment injection variables, and non-directory cwd', async () => {
    const host = makeHost()
    await expect(host.create({
      sessionId: 'session-1',
      command: '/bin/echo',
      outputByteLimit: TERMINAL_DEFAULT_OUTPUT_BYTE_LIMIT + 1
    })).rejects.toMatchObject({ rpcCode: -32602 })
    await expect(host.create({
      sessionId: 'session-1',
      command: '/bin/echo',
      env: { NODE_OPTIONS: '--require=/tmp/not-allowed' }
    })).rejects.toMatchObject({ rpcCode: -32602 })
    await expect(host.create({
      sessionId: 'session-1',
      command: '/bin/echo',
      cwd: '/definitely/missing/grokbuild-terminal'
    })).rejects.toMatchObject({ rpcCode: -32602 })
    expect(() => new TerminalHost({
      sessionId: 'session-1',
      defaultCwd: process.cwd(),
      maxTerminals: TERMINAL_MAX_COUNT + 1
    })).toThrow('maxTerminals')
    expect(() => new TerminalHost({
      sessionId: 'session-1',
      defaultCwd: process.cwd(),
      maxRetainedOutputBytes: TERMINAL_SESSION_OUTPUT_BYTE_LIMIT + 1
    })).toThrow('maxRetainedOutputBytes')
  })
})

describe('terminal command and output primitives', () => {
  it('splits quoted bash scripts without interpreting shell operators itself', () => {
    expect(splitTerminalCommandLine("/bin/bash -lc 'echo SHELL_OK && pwd'"))
      .toEqual(['/bin/bash', '-lc', 'echo SHELL_OK && pwd'])
    expect(splitTerminalCommandLine('/bin/bash -lc "printf \\\"hello world\\\""'))
      .toEqual(['/bin/bash', '-lc', 'printf "hello world"'])
    expect(() => splitTerminalCommandLine("/bin/bash -lc 'unterminated"))
      .toThrow('unterminated quoting')
  })

  it('truncates at a UTF-8 leading-byte boundary', () => {
    const result = truncateTerminalOutput(Buffer.from('ééé'), 3)
    expect(result.output.toString('utf8')).toBe('é')
    expect(result.output.length).toBeLessThanOrEqual(3)
    expect(result.truncated).toBe(true)
  })
})

function makeHost(
  defaultCwd = process.cwd(),
  options: Partial<ConstructorParameters<typeof TerminalHost>[0]> = {}
): TerminalHost {
  const host = new TerminalHost({
    sessionId: 'session-1',
    defaultCwd,
    ...options
  })
  hosts.push(host)
  return host
}

function scoped(terminalId: string): { sessionId: string; terminalId: string } {
  return { sessionId: 'session-1', terminalId }
}

function expectTerminalError(
  action: () => unknown,
  rpcCode: number,
  message: string
): void {
  try {
    action()
    throw new Error('Expected action to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(TerminalHostError)
    expect(error).toMatchObject({ rpcCode })
    expect(String(error)).toContain(message)
  }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'grokbuild-terminal-'))
  temporaryDirectories.push(directory)
  return directory
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
  }
}

async function processDisappears(pid: number): Promise<boolean> {
  const deadline = Date.now() + 1_000
  do {
    if (!processExists(pid)) return true
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10))
  } while (Date.now() < deadline)
  return false
}
