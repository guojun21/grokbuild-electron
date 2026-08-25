import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AdvisoryLockRunnerError,
  MacOsAdvisoryLockRunner
} from '../../src/main/models/MacOsAdvisoryLockRunner'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const darwinIt = process.platform === 'darwin' ? it : it.skip
const darwinDescribe = process.platform === 'darwin' ? describe : describe.skip

describe('MacOsAdvisoryLockRunner platform and request validation', () => {
  it('rejects unsupported platforms before attempting to spawn a helper', async () => {
    const spawnSpy = vi.fn()
    const runner = new MacOsAdvisoryLockRunner({
      platform: 'linux',
      spawnProcess: spawnSpy as unknown as typeof spawn
    })

    await expect(runner.acquire({ fd: 7, timeoutMs: 0 })).rejects.toMatchObject({
      name: 'AdvisoryLockRunnerError',
      code: 'unsupported-platform'
    })
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it.each([
    { fd: -1, timeoutMs: 0 },
    { fd: 1.5, timeoutMs: 0 },
    { fd: Number.MAX_SAFE_INTEGER + 1, timeoutMs: 0 },
    { fd: 7, timeoutMs: -1 },
    { fd: 7, timeoutMs: 1.5 },
    { fd: 7, timeoutMs: 30_001 }
  ])('rejects an invalid acquire request without spawning: %o', async (request) => {
    const spawnSpy = vi.fn()
    const runner = new MacOsAdvisoryLockRunner({
      platform: 'darwin',
      spawnProcess: spawnSpy as unknown as typeof spawn
    })

    await expect(runner.acquire(request)).rejects.toMatchObject({
      name: 'AdvisoryLockRunnerError',
      code: 'invalid-request'
    })
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it.each([-1, 1.5, 30_001])('rejects an invalid watchdog grace: %s', (watchdogGraceMs) => {
    expect(() => new MacOsAdvisoryLockRunner({ watchdogGraceMs })).toThrowError(
      expect.objectContaining({
        name: 'AdvisoryLockRunnerError',
        code: 'invalid-request'
      })
    )
  })
})

describe('MacOsAdvisoryLockRunner FD mode', () => {
  darwinIt('retains the flock after lockf exits and releases it on the parent FileHandle last close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-lockf-runner-'))
    const lockPath = join(root, 'config.lock')
    let first: FileHandle | undefined
    let second: FileHandle | undefined

    try {
      first = await open(
        lockPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      second = await open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW)
      const runner = new MacOsAdvisoryLockRunner()

      // acquire() resolves only after lockf's `close` event, so the helper has
      // exited here while the inherited open-file-description remains locked.
      await expect(runner.acquire({ fd: first.fd, timeoutMs: 1_000 })).resolves.toBeUndefined()
      await expect(runner.acquire({ fd: second.fd, timeoutMs: 0 })).rejects.toMatchObject({
        name: 'AdvisoryLockRunnerError',
        code: 'timeout'
      })

      await first.close()
      first = undefined
      await expect(runner.acquire({ fd: second.fd, timeoutMs: 1_000 })).resolves.toBeUndefined()
    } finally {
      await Promise.allSettled([first?.close(), second?.close()])
      await rm(root, { recursive: true, force: true })
    }
  })
})

darwinDescribe('MacOsAdvisoryLockRunner helper supervision', () => {
  it('uses only the fixed helper, fixed argv, minimal environment, and inherited fd 3', async () => {
    const child = makeFakeChild()
    const spawnSpy = makeSpawnSpy(child)
    const runner = new MacOsAdvisoryLockRunner({
      platform: 'darwin',
      spawnProcess: spawnSpy as unknown as typeof spawn
    })

    const acquisition = runner.acquire({ fd: 41, timeoutMs: 1_001 })
    await waitForSpawn(spawnSpy)

    expect(spawnSpy.mock.calls).toEqual([[
      '/usr/bin/lockf',
      ['-s', '-t', '2', '3'],
      {
        shell: false,
        detached: false,
        env: { LANG: 'C', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe', 41]
      }
    ]])

    child.emit('close', 0, null)
    await expect(acquisition).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('maps a nonzero helper exit to a bounded failure', async () => {
    const child = makeFakeChild()
    const spawnSpy = makeSpawnSpy(child)
    const runner = runnerWith(spawnSpy)

    const acquisition = runner.acquire({ fd: 7, timeoutMs: 1_000 })
    await waitForSpawn(spawnSpy)
    child.emit('close', 7, null)

    await expect(acquisition).rejects.toEqual(
      new AdvisoryLockRunnerError('helper-failed')
    )
  })

  it('maps a signaled helper exit to a bounded failure', async () => {
    const child = makeFakeChild()
    const spawnSpy = makeSpawnSpy(child)
    const runner = runnerWith(spawnSpy)

    const acquisition = runner.acquire({ fd: 7, timeoutMs: 1_000 })
    await waitForSpawn(spawnSpy)
    child.emit('close', null, 'SIGTERM')

    await expect(acquisition).rejects.toEqual(
      new AdvisoryLockRunnerError('helper-signaled')
    )
  })

  it('maps a synchronous spawn failure to a bounded failure', async () => {
    const spawnSpy = vi.fn((_file: string, _args: readonly string[], _options: SpawnOptions) => {
      throw new Error('private spawn detail')
    })
    const runner = runnerWith(spawnSpy)

    await expect(runner.acquire({ fd: 7, timeoutMs: 1_000 })).rejects.toEqual(
      new AdvisoryLockRunnerError('helper-failed')
    )
  })

  it('aborts an in-flight helper, waits for close, and reports only aborted', async () => {
    const child = makeFakeChild({ closeOnKill: true })
    const spawnSpy = makeSpawnSpy(child)
    const runner = runnerWith(spawnSpy)
    const controller = new AbortController()

    const acquisition = runner.acquire({ fd: 7, timeoutMs: 5_000, signal: controller.signal })
    await waitForSpawn(spawnSpy)
    controller.abort()

    await expect(acquisition).rejects.toEqual(new AdvisoryLockRunnerError('aborted'))
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.closeEmitted).toBe(true)
  })

  it('kills a helper that exceeds the outer watchdog and waits for close', async () => {
    const child = makeFakeChild({ closeOnKill: true })
    const spawnSpy = makeSpawnSpy(child)
    const runner = runnerWith(spawnSpy, 0)

    const acquisition = runner.acquire({ fd: 7, timeoutMs: 0 })
    const assertion = expect(acquisition).rejects.toEqual(
      new AdvisoryLockRunnerError('watchdog-timeout')
    )
    await waitForSpawn(spawnSpy)
    await assertion

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.closeEmitted).toBe(true)
  })

  it('caps combined helper output, terminates the helper, and reports overflow', async () => {
    const child = makeFakeChild({ closeOnKill: true })
    const spawnSpy = makeSpawnSpy(child)
    const runner = runnerWith(spawnSpy)

    const acquisition = runner.acquire({ fd: 7, timeoutMs: 5_000 })
    await waitForSpawn(spawnSpy)
    child.stdout.emit('data', Buffer.alloc(2_049))
    child.stderr.emit('data', Buffer.alloc(2_048))

    await expect(acquisition).rejects.toEqual(
      new AdvisoryLockRunnerError('output-overflow')
    )
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.closeEmitted).toBe(true)
  })
})

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn<(signal?: number | NodeJS.Signals) => boolean>>
  closeEmitted: boolean
}

function makeFakeChild(options: { closeOnKill?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.closeEmitted = false
  child.once('close', () => {
    child.closeEmitted = true
    child.stdout.destroy()
    child.stderr.destroy()
  })
  child.kill = vi.fn((signal: number | NodeJS.Signals = 'SIGTERM') => {
    if (options.closeOnKill && !child.closeEmitted) {
      const closeSignal = typeof signal === 'string' ? signal : 'SIGTERM'
      queueMicrotask(() => child.emit('close', null, closeSignal))
    }
    return true
  })
  return child
}

function makeSpawnSpy(child: FakeChild) {
  return vi.fn((_file: string, _args: readonly string[], _options: SpawnOptions) => (
    child as unknown as ChildProcess
  ))
}

function runnerWith(
  spawnSpy: ReturnType<typeof makeSpawnSpy>,
  watchdogGraceMs = 100
): MacOsAdvisoryLockRunner {
  return new MacOsAdvisoryLockRunner({
    platform: 'darwin',
    spawnProcess: spawnSpy as unknown as typeof spawn,
    watchdogGraceMs
  })
}

async function waitForSpawn(spawnSpy: ReturnType<typeof makeSpawnSpy>): Promise<void> {
  await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledOnce())
}
