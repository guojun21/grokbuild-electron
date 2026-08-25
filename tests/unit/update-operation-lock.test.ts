import { describe, expect, it } from 'vitest'
import {
  UPDATE_OPERATIONS,
  UpdateOperationBusyError,
  UpdateOperationLock,
  type UpdateOperation
} from '../../src/main/updates/UpdateOperationLock'

const PRIVATE_CANARY = 'update-lock-private-canary-a90c7f'

describe('UpdateOperationLock', () => {
  it('uses one fixed app/cli lock and rejects concurrent same- and cross-operation calls', async () => {
    const lock = new UpdateOperationLock()
    const appStarted = deferred<void>()
    const appFinish = deferred<string>()
    let appRuns = 0
    let contenderRuns = 0

    const app = lock.runExclusive('app', async () => {
      appRuns += 1
      appStarted.resolve()
      return await appFinish.promise
    })
    await appStarted.promise

    expect(UPDATE_OPERATIONS).toEqual(['app', 'cli'])
    expect(lock.snapshot()).toEqual({ busy: true, operation: 'app' })
    await expect(lock.runExclusive('app', () => {
      contenderRuns += 1
    })).rejects.toBeInstanceOf(UpdateOperationBusyError)
    await expect(lock.runExclusive('cli', () => {
      contenderRuns += 1
    })).rejects.toMatchObject({ code: 'update-operation-busy' })
    expect(appRuns).toBe(1)
    expect(contenderRuns).toBe(0)

    appFinish.resolve('installed')
    await expect(app).resolves.toBe('installed')
    expect(lock.snapshot()).toEqual({ busy: false })
  })

  it('does not permit re-entry, even for the current operation and call stack', async () => {
    const lock = new UpdateOperationLock()
    let nestedRan = false

    await lock.runExclusive('cli', async () => {
      await expect(lock.runExclusive('cli', () => {
        nestedRan = true
      })).rejects.toBeInstanceOf(UpdateOperationBusyError)
      expect(lock.snapshot()).toEqual({ busy: true, operation: 'cli' })
    })

    expect(nestedRan).toBe(false)
    expect(lock.snapshot()).toEqual({ busy: false })
  })

  it('offers an opaque idempotent lease for operations that span process quit', async () => {
    const lock = new UpdateOperationLock()
    const first = lock.acquire('app')
    expect(Object.keys(first)).toEqual(['release'])
    expect(lock.snapshot()).toEqual({ busy: true, operation: 'app' })
    expect(() => lock.acquire('cli')).toThrow(UpdateOperationBusyError)

    first.release()
    first.release()
    expect(lock.snapshot()).toEqual({ busy: false })

    const second = lock.acquire('cli')
    first.release()
    expect(lock.snapshot()).toEqual({ busy: true, operation: 'cli' })
    second.release()
    expect(lock.snapshot()).toEqual({ busy: false })
  })

  it('releases after synchronous throws and asynchronous rejections', async () => {
    const lock = new UpdateOperationLock()
    const syncFailure = new Error('sync failure')
    const asyncFailure = new Error('async failure')

    await expect(lock.runExclusive('app', () => {
      throw syncFailure
    })).rejects.toBe(syncFailure)
    expect(lock.snapshot()).toEqual({ busy: false })

    await expect(lock.runExclusive('cli', async () => {
      throw asyncFailure
    })).rejects.toBe(asyncFailure)
    expect(lock.snapshot()).toEqual({ busy: false })

    await expect(lock.runExclusive('app', () => 42)).resolves.toBe(42)
  })

  it('releases when an in-flight operation is cancelled by its caller', async () => {
    const lock = new UpdateOperationLock()
    const controller = new AbortController()
    const started = deferred<void>()
    const cancellation = new Error('cancelled')

    const running = lock.runExclusive('cli', async () => {
      started.resolve()
      await new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(cancellation), { once: true })
      })
    })
    await started.promise
    expect(lock.snapshot()).toEqual({ busy: true, operation: 'cli' })

    controller.abort()
    await expect(running).rejects.toBe(cancellation)
    expect(lock.snapshot()).toEqual({ busy: false })
    await expect(lock.runExclusive('app', () => 'next')).resolves.toBe('next')
  })

  it('ignores stale and double release tokens after a new owner acquires the lock', async () => {
    const lock = new UpdateOperationLock()
    const firstFinish = deferred<void>()
    const first = lock.runExclusive('app', () => firstFinish.promise)
    const firstOwnerId = lockInternals(lock).owner?.id
    expect(firstOwnerId).toBeTypeOf('symbol')

    firstFinish.resolve()
    await first
    expect(lock.snapshot()).toEqual({ busy: false })

    const secondFinish = deferred<void>()
    const second = lock.runExclusive('cli', () => secondFinish.promise)
    expect(lock.snapshot()).toEqual({ busy: true, operation: 'cli' })

    lockInternals(lock).release(firstOwnerId!)
    lockInternals(lock).release(firstOwnerId!)
    expect(lock.snapshot()).toEqual({ busy: true, operation: 'cli' })
    await expect(lock.runExclusive('app', () => undefined))
      .rejects.toBeInstanceOf(UpdateOperationBusyError)

    secondFinish.resolve()
    await second
    expect(lock.snapshot()).toEqual({ busy: false })
  })

  it('returns only renderer-safe snapshot fields and never leaks contender content', async () => {
    const lock = new UpdateOperationLock()
    const finish = deferred<void>()
    const running = lock.runExclusive('app', () => finish.promise)
    const injected = `${PRIVATE_CANARY}; cli; /private/path; https://secret.example/update`

    const error = await rejection(lock.runExclusive('cli', () => {
      throw new Error(injected)
    }))
    const publicData = JSON.stringify({
      snapshot: lock.snapshot(),
      error: serializeError(error)
    })

    expect(error).toBeInstanceOf(UpdateOperationBusyError)
    expect(publicData).not.toContain(PRIVATE_CANARY)
    expect(publicData).not.toContain('/private/path')
    expect(publicData).not.toContain('https://')
    expect(lock.snapshot()).toEqual({ busy: true, operation: 'app' })

    finish.resolve()
    await running
    expect(Object.keys(lock.snapshot())).toEqual(['busy'])

    const invalid = await rejection(lock.runExclusive(
      injected as UpdateOperation,
      () => undefined
    ))
    expect(invalid).toBeInstanceOf(TypeError)
    expect(serializeError(invalid)).not.toContain(PRIVATE_CANARY)
  })
})

interface LockInternals {
  owner: { id: symbol; operation: UpdateOperation } | null
  release(ownerId: symbol): void
}

function lockInternals(lock: UpdateOperationLock): LockInternals {
  return lock as unknown as LockInternals
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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
  return JSON.stringify({ ...error, name: error.name, message: error.message })
}
