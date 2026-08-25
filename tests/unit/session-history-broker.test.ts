import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SessionHistoryBroker,
  type SessionHistoryCliService,
  type SessionHistoryContext
} from '../../src/main/history/SessionHistoryBroker'
import type { GrokCliSessionHistoryRecord } from '../../src/main/grok/GrokCliService'

const FIRST_ID = '01234567-89ab-cdef-0123-456789abcdef'
const SECOND_ID = 'fedcba98-7654-3210-fedc-ba9876543210'
const CANARY = 'broker-private-canary-81d4f3'
const temporaryRoots: string[] = []

class StubHistoryService implements SessionHistoryCliService {
  records: GrokCliSessionHistoryRecord[] = [record(FIRST_ID, 'First history entry')]
  listFailure: unknown
  deleteFailure: unknown
  readonly listCalls: string[] = []
  readonly searchCalls: Array<{ cwd: string; query: string }> = []
  readonly deleteCalls: Array<{ cwd: string; remoteId: string }> = []

  async listSessions(cwd: string): Promise<GrokCliSessionHistoryRecord[]> {
    this.listCalls.push(cwd)
    if (this.listFailure !== undefined) throw this.listFailure
    return this.records
  }

  async searchSessions(cwd: string, query: string): Promise<GrokCliSessionHistoryRecord[]> {
    this.searchCalls.push({ cwd, query })
    if (this.listFailure !== undefined) throw this.listFailure
    return this.records
  }

  async deleteSession(cwd: string, remoteId: string): Promise<void> {
    this.deleteCalls.push({ cwd, remoteId })
    if (this.deleteFailure !== undefined) throw this.deleteFailure
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true })
  }))
})

describe('SessionHistoryBroker', () => {
  it('projects opaque renderer-safe records and keeps remote/path identities main-only', async () => {
    const fixture = await makeFixture()
    const service = new StubHistoryService()
    service.records = [
      record(FIRST_ID, 'First history entry'),
      record(SECOND_ID, '第二条会话')
    ]
    const providedPaths: string[] = []
    const broker = new SessionHistoryBroker({
      serviceProvider: (cliPath) => {
        providedPaths.push(cliPath)
        return service
      }
    })

    const result = await broker.list(fixture.context)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      projectId: 'project-a',
      summary: 'First history entry',
      status: 'local',
      created: '2026-08-20',
      updated: '2026-08-25'
    })
    expect(result[0]!.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result[1]!.token).not.toBe(result[0]!.token)
    expect(Object.keys(result[0]!).sort()).toEqual([
      'created', 'projectId', 'status', 'summary', 'token', 'updated'
    ])
    const wire = JSON.stringify(result)
    expect(wire).not.toContain(FIRST_ID)
    expect(wire).not.toContain(SECOND_ID)
    expect(wire).not.toContain(fixture.context.canonicalCwd)
    expect(wire).not.toContain(fixture.context.cliPath)
    expect(providedPaths).toEqual([fixture.context.cliPath])
    expect(service.listCalls).toEqual([fixture.context.canonicalCwd])

    await expect(broker.resolve({ ...fixture.context, token: result[0]!.token }))
      .resolves.toEqual({ remoteId: FIRST_ID, summary: 'First history entry' })
    await expect(broker.resolve({ ...fixture.context, token: result[0]!.token }))
      .resolves.toEqual({ remoteId: FIRST_ID, summary: 'First history entry' })
  })

  it('expires capabilities within five minutes and rejects out-of-range TTL configuration', async () => {
    const fixture = await makeFixture()
    const service = new StubHistoryService()
    let now = 10_000
    const broker = new SessionHistoryBroker({
      serviceProvider: () => service,
      tokenFactory: tokenFactory(),
      now: () => now,
      ttlMs: 25
    })
    const [entry] = await broker.list(fixture.context)

    now += 24
    await expect(broker.resolve({ ...fixture.context, token: entry!.token }))
      .resolves.toEqual({ remoteId: FIRST_ID, summary: 'First history entry' })
    now += 1
    await expect(broker.resolve({ ...fixture.context, token: entry!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })

    expect(() => new SessionHistoryBroker({ ttlMs: 5 * 60_000 + 1 })).toThrow(/5 minutes/)
    expect(() => new SessionHistoryBroker({ ttlMs: 0 })).toThrow(/5 minutes/)
  })

  it('invalidates the prior query generation and binds tokens to project, cwd, and CLI', async () => {
    const fixture = await makeFixture()
    const service = new StubHistoryService()
    const broker = new SessionHistoryBroker({
      serviceProvider: () => service,
      tokenFactory: tokenFactory()
    })

    const [listed] = await broker.list(fixture.context)
    const [searched] = await broker.search({ ...fixture.context, query: 'auth bug' })
    expect(service.searchCalls).toEqual([{ cwd: fixture.context.canonicalCwd, query: 'auth bug' }])
    await expect(broker.resolve({ ...fixture.context, token: listed!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })

    for (const stale of [
      { ...fixture.context, projectId: 'project-b' },
      { ...fixture.context, canonicalCwd: fixture.otherCwd },
      { ...fixture.context, cliPath: fixture.otherCliPath }
    ]) {
      await expect(broker.resolve({ ...stale, token: searched!.token }))
        .rejects.toMatchObject({ code: 'invalid-token' })
    }
    // Cross-context attempts do not burn the valid capability.
    await expect(broker.resolve({ ...fixture.context, token: searched!.token }))
      .resolves.toEqual({ remoteId: FIRST_ID, summary: 'First history entry' })
  })

  it('detects replacement of the canonical cwd at the same path by filesystem identity', async () => {
    const fixture = await makeFixture()
    const service = new StubHistoryService()
    const broker = new SessionHistoryBroker({
      serviceProvider: () => service,
      tokenFactory: tokenFactory()
    })
    const [entry] = await broker.list(fixture.context)

    const moved = `${fixture.context.canonicalCwd}-old`
    await rename(fixture.context.canonicalCwd, moved)
    await mkdir(fixture.context.canonicalCwd)

    await expect(broker.resolve({ ...fixture.context, token: entry!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })
  })

  it('makes destructive consumption one-shot and denies live or selected deletion first', async () => {
    const fixture = await makeFixture()
    const service = new StubHistoryService()
    const broker = new SessionHistoryBroker({
      serviceProvider: () => service,
      tokenFactory: tokenFactory()
    })
    const [entry] = await broker.list(fixture.context)
    const input = { ...fixture.context, token: entry!.token }

    await expect(broker.delete(input, () => ({ isLive: true, isSelected: false })))
      .rejects.toMatchObject({ code: 'delete-protected' })
    await expect(broker.delete(input, () => ({ isLive: false, isSelected: true })))
      .rejects.toMatchObject({ code: 'delete-protected' })
    expect(service.deleteCalls).toEqual([])

    await expect(broker.delete(input, () => ({ isLive: false, isSelected: false })))
      .resolves.toBeUndefined()
    expect(service.deleteCalls).toEqual([{
      cwd: fixture.context.canonicalCwd,
      remoteId: FIRST_ID
    }])
    await expect(broker.delete(input, () => ({ isLive: false, isSelected: false })))
      .rejects.toMatchObject({ code: 'invalid-token' })
    expect(service.deleteCalls).toHaveLength(1)

    const [consumable] = await broker.list(fixture.context)
    await expect(broker.consume(
      { ...fixture.context, token: consumable!.token },
      { isLive: false, isSelected: false }
    )).resolves.toEqual({ remoteId: FIRST_ID, summary: 'First history entry' })
    await expect(broker.consume(
      { ...fixture.context, token: consumable!.token },
      { isLive: false, isSelected: false }
    )).rejects.toMatchObject({ code: 'invalid-token' })
  })

  it('reads deletion protection after asynchronous token context validation', async () => {
    const fixture = await makeFixture()
    const service = new StubHistoryService()
    const broker = new SessionHistoryBroker({
      serviceProvider: () => service,
      tokenFactory: tokenFactory()
    })
    const [entry] = await broker.list(fixture.context)
    const input = { ...fixture.context, token: entry!.token }
    let protection = { isLive: false, isSelected: false }

    const deletion = broker.delete(input, () => protection)
    // resolveEntry always crosses the async filesystem identity boundary first.
    protection = { isLive: true, isSelected: false }

    await expect(deletion).rejects.toMatchObject({ code: 'delete-protected' })
    expect(service.deleteCalls).toEqual([])
    protection = { isLive: false, isSelected: false }
    await expect(broker.delete(input, () => protection)).resolves.toBeUndefined()
    expect(service.deleteCalls).toHaveLength(1)
  })

  it('caps a generation at 50 unique records and fails closed on overflow', async () => {
    const fixture = await makeFixture()
    const service = new StubHistoryService()
    service.records = Array.from({ length: 50 }, (_, index) => record(
      remoteId(index),
      `History ${index}`
    ))
    const broker = new SessionHistoryBroker({
      serviceProvider: () => service,
      tokenFactory: tokenFactory()
    })

    const result = await broker.list(fixture.context)
    expect(result).toHaveLength(50)
    expect(new Set(result.map(({ token }) => token))).toHaveLength(50)
    await expect(Promise.all(result.map(async ({ token }, index) => {
      return await broker.resolve({ ...fixture.context, token }).then(({ remoteId: id }) => {
        expect(id).toBe(remoteId(index))
      })
    }))).resolves.toBeDefined()

    service.records = Array.from({ length: 51 }, (_, index) => record(remoteId(index), 'Overflow'))
    await expect(broker.list(fixture.context)).rejects.toMatchObject({ code: 'invalid-history' })
    await expect(broker.resolve({ ...fixture.context, token: result[0]!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })
  })

  it('maps service and deletion diagnostics to fixed redacted errors', async () => {
    const fixture = await makeFixture()
    const service = new StubHistoryService()
    const broker = new SessionHistoryBroker({
      serviceProvider: () => service,
      tokenFactory: tokenFactory()
    })
    service.listFailure = new Error(`${CANARY} ${fixture.context.canonicalCwd} --token private`)
    const listError = await rejection(broker.list(fixture.context))
    expect(listError).toMatchObject({ code: 'history-unavailable' })
    expect(serializeError(listError)).not.toContain(CANARY)
    expect(serializeError(listError)).not.toContain(fixture.context.canonicalCwd)
    expect(serializeError(listError)).not.toContain('--token')

    service.listFailure = undefined
    const [entry] = await broker.list(fixture.context)
    service.deleteFailure = new Error(`${CANARY} ${FIRST_ID} ${fixture.context.cliPath}`)
    const deleteError = await rejection(broker.delete(
      { ...fixture.context, token: entry!.token },
      () => ({ isLive: false, isSelected: false })
    ))
    expect(deleteError).toMatchObject({ code: 'delete-failed' })
    expect(serializeError(deleteError)).not.toContain(CANARY)
    expect(serializeError(deleteError)).not.toContain(FIRST_ID)
    expect(serializeError(deleteError)).not.toContain(fixture.context.cliPath)
    // A failed destructive command remains one-shot because the process may have mutated state.
    await expect(broker.resolve({ ...fixture.context, token: entry!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })
  })
})

async function makeFixture(): Promise<{
  context: SessionHistoryContext
  otherCwd: string
  otherCliPath: string
}> {
  const base = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'grok-history-broker-')))
  temporaryRoots.push(base)
  const cwd = join(base, 'project-a')
  const otherCwd = join(base, 'project-b')
  const cliPath = join(base, 'grok-a')
  const otherCliPath = join(base, 'grok-b')
  await mkdir(cwd)
  await mkdir(otherCwd)
  await writeFile(cliPath, '#!/bin/sh\nexit 0\n')
  await writeFile(otherCliPath, '#!/bin/sh\nexit 0\n')
  await chmod(cliPath, 0o700)
  await chmod(otherCliPath, 0o700)
  return {
    context: { projectId: 'project-a', canonicalCwd: cwd, cliPath },
    otherCwd,
    otherCliPath
  }
}

function record(remoteIdValue: string, summary: string): GrokCliSessionHistoryRecord {
  return {
    remoteId: remoteIdValue,
    summary,
    status: 'local',
    created: '2026-08-20',
    updated: '2026-08-25'
  }
}

function remoteId(index: number): string {
  return `${index.toString(16).padStart(8, '0')}-1111-2222-3333-444444444444`
}

function tokenFactory(): () => string {
  let index = 0
  return () => Buffer.alloc(32, (index += 1) % 256).toString('base64url')
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
