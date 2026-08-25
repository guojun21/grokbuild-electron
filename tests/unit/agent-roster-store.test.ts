import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRosterStore,
  MAX_AGENT_ROSTER_BYTES
} from '../../src/main/agents/AgentRosterStore'
import { SAVED_AGENT_STARTER_CREW } from '../../src/shared/agents'

const NOW = new Date('2026-08-25T00:00:00.000Z')
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AgentRosterStore', () => {
  it('loads a missing file as revision zero and commits a restrictive versioned file', async () => {
    const fixture = await makeFixture()
    const store = makeStore(fixture.path)

    await expect(store.load()).resolves.toEqual({
      status: 'ready',
      source: 'missing',
      roster: { version: 1, revision: 0, agents: [], sessionBindings: {} }
    })

    const created = await store.create(0, { name: 'Chief', mission: 'Route work', roleName: 'chief' })
    expect(created.roster.revision).toBe(1)
    expect(created.value).toMatchObject({
      id: uuid(1), name: 'Chief', mission: 'Route work', roleName: 'chief'
    })
    expect(JSON.parse(await readFile(fixture.path, 'utf8'))).toEqual(created.roster)
    expect((await stat(fixture.path)).mode & 0o777).toBe(0o600)
    expect((await stat(fixture.root)).mode & 0o777).toBe(0o700)
    expect((await readdir(fixture.root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('reads the Swift raw array without rewriting it, then migrates on the first explicit mutation', async () => {
    const fixture = await makeFixture()
    const legacyBytes = Buffer.from(JSON.stringify([legacyAgent(1, 'Scout', 'scout')]))
    await writeFile(fixture.path, legacyBytes)
    const store = makeStore(fixture.path)

    const loaded = await store.load()
    expect(loaded).toMatchObject({ status: 'ready', source: 'swift-legacy' })
    expect(await readFile(fixture.path)).toEqual(legacyBytes)

    const bound = await store.setSessionBinding(0, 'local-session', uuid(1))
    expect(bound.roster).toMatchObject({
      version: 1,
      revision: 1,
      sessionBindings: { 'local-session': uuid(1) }
    })
    expect(Array.isArray(JSON.parse(await readFile(fixture.path, 'utf8')))).toBe(false)
  })

  it('preserves malformed bytes, fails every normal mutation closed, and recovers only explicitly', async () => {
    const fixture = await makeFixture()
    const malformed = Buffer.from('{"private-canary":')
    await writeFile(fixture.path, malformed)
    const store = makeStore(fixture.path, { recoveryIdFactory: () => 'backup-1' })

    await expect(store.load()).resolves.toEqual({ status: 'invalid', reason: 'malformed' })
    await expect(store.create(0, { name: 'Chief', mission: 'Route', roleName: 'chief' }))
      .rejects.toMatchObject({ code: 'invalid-roster' })
    await expect(store.mutate(0, () => undefined))
      .rejects.toMatchObject({ code: 'invalid-roster' })
    expect(await readFile(fixture.path)).toEqual(malformed)

    const recovered = await store.recover()
    expect(recovered.roster).toEqual({ version: 1, revision: 0, agents: [], sessionBindings: {} })
    expect(await readFile(recovered.backupPath)).toEqual(malformed)
    await expect(store.load()).resolves.toMatchObject({ status: 'ready', source: 'versioned' })
    await expect(store.recover()).rejects.toMatchObject({ code: 'recovery-not-required' })
  })

  it('treats symlinks, directories, and oversized files as invalid without touching them', async () => {
    const symlinkFixture = await makeFixture()
    const target = join(symlinkFixture.root, 'target.json')
    const targetBytes = Buffer.from('{"target":"unchanged"}')
    await writeFile(target, targetBytes)
    await symlink(target, symlinkFixture.path)
    const symlinkStore = makeStore(symlinkFixture.path)
    await expect(symlinkStore.load()).resolves.toEqual({ status: 'invalid', reason: 'symlink' })
    await expect(symlinkStore.installStarterCrew(0)).rejects.toMatchObject({ code: 'invalid-roster' })
    expect(await readFile(target)).toEqual(targetBytes)
    expect((await lstat(symlinkFixture.path)).isSymbolicLink()).toBe(true)

    const directoryFixture = await makeFixture()
    await mkdir(directoryFixture.path)
    const directoryStore = makeStore(directoryFixture.path)
    await expect(directoryStore.load()).resolves.toEqual({ status: 'invalid', reason: 'non-regular' })
    await expect(directoryStore.create(0, { name: 'Chief', mission: 'Route' }))
      .rejects.toMatchObject({ code: 'invalid-roster' })
    expect((await lstat(directoryFixture.path)).isDirectory()).toBe(true)

    const oversizeFixture = await makeFixture()
    const oversized = Buffer.alloc(MAX_AGENT_ROSTER_BYTES + 1, 0x61)
    await writeFile(oversizeFixture.path, oversized)
    const oversizeStore = makeStore(oversizeFixture.path)
    await expect(oversizeStore.load()).resolves.toEqual({ status: 'invalid', reason: 'oversize' })
    await expect(oversizeStore.mutate(0, () => undefined))
      .rejects.toMatchObject({ code: 'invalid-roster' })
    expect(await readFile(oversizeFixture.path)).toEqual(oversized)
  })

  it('explicit symlink recovery moves the link aside without modifying its target', async () => {
    const fixture = await makeFixture()
    const target = join(fixture.root, 'target.json')
    const targetBytes = Buffer.from('target bytes')
    await writeFile(target, targetBytes)
    await symlink(target, fixture.path)
    const store = makeStore(fixture.path, { recoveryIdFactory: () => 'symlink-backup' })

    const recovered = await store.recover()

    expect((await lstat(recovered.backupPath)).isSymbolicLink()).toBe(true)
    expect((await lstat(fixture.path)).isFile()).toBe(true)
    expect(await readFile(target)).toEqual(targetBytes)
  })

  it('serializes mutations and rejects a stale optimistic revision', async () => {
    const fixture = await makeFixture()
    let nextId = 1
    const store = new AgentRosterStore(fixture.path, {
      now: () => NOW,
      idFactory: () => uuid(nextId++)
    })

    const results = await Promise.allSettled([
      store.create(0, { name: 'Chief', mission: 'Route', roleName: 'chief' }),
      store.create(0, { name: 'Scout', mission: 'Research', roleName: 'scout' })
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find((result) => result.status === 'rejected')
    expect(rejection).toMatchObject({ reason: { code: 'revision-conflict' } })
    const loaded = await store.load()
    expect(loaded).toMatchObject({ status: 'ready', roster: { revision: 1 } })
  })

  it('updates a complete agent optimistically while preserving creation identity', async () => {
    const fixture = await makeFixture()
    let now = NOW
    const store = new AgentRosterStore(fixture.path, {
      now: () => now,
      idFactory: () => uuid(1)
    })
    const created = await store.create(0, {
      name: 'Builder', mission: 'Implement', roleName: 'builder', isPinned: false
    })
    now = new Date(NOW.getTime() + 60_000)
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...update } = created.value

    const updated = await store.update(1, {
      ...update,
      mission: 'Implement and integrate',
      isPinned: true
    })

    expect(updated.roster.revision).toBe(2)
    expect(updated.value.createdAt).toBe(NOW.toISOString())
    expect(updated.value.updatedAt).toBe(now.toISOString())
    expect(updated.value).toMatchObject({ mission: 'Implement and integrate', isPinned: true })
    await expect(store.update(1, update)).rejects.toMatchObject({ code: 'revision-conflict' })
  })

  it('enforces unique names and effective roles without changing the committed revision', async () => {
    const fixture = await makeFixture()
    const store = makeStore(fixture.path)
    const first = await store.create(0, { name: 'Scout', mission: 'Research', roleName: 'scout' })

    await expect(store.create(1, { name: 'sCoUt', mission: 'Other', roleName: 'other' }))
      .rejects.toMatchObject({ code: 'invalid-mutation' })
    await expect(store.create(1, { name: 'Other', mission: 'Other', roleName: 'SCOUT' }))
      .rejects.toMatchObject({ code: 'invalid-mutation' })
    expect(await store.load()).toMatchObject({
      status: 'ready', roster: { revision: 1, agents: [first.value] }
    })
  })

  it('installs the exact starter crew idempotently', async () => {
    const fixture = await makeFixture()
    const store = makeStore(fixture.path)

    const first = await store.installStarterCrew(0)
    expect(first.value.map((agent) => agent.name)).toEqual(
      SAVED_AGENT_STARTER_CREW.map((agent) => agent.name)
    )
    expect(first.roster.revision).toBe(1)

    const second = await store.installStarterCrew(1)
    expect(second.value).toEqual([])
    expect(second.roster.revision).toBe(1)
    expect(second.roster.agents).toHaveLength(5)
  })

  it('deletes an agent and all of its session bindings in one revision', async () => {
    const fixture = await makeFixture()
    const store = makeStore(fixture.path)
    const first = await store.create(0, { name: 'Chief', mission: 'Route', roleName: 'chief' })
    const second = await store.create(1, { name: 'Scout', mission: 'Research', roleName: 'scout' })
    await store.setSessionBinding(2, 'session-chief-1', first.value.id)
    await store.setSessionBinding(3, 'session-scout', second.value.id)
    await store.setSessionBinding(4, 'session-chief-2', first.value.id)

    const deleted = await store.delete(5, first.value.id)

    expect(deleted.roster.revision).toBe(6)
    expect(deleted.roster.agents.map((agent) => agent.id)).toEqual([second.value.id])
    expect(deleted.roster.sessionBindings).toEqual({ 'session-scout': second.value.id })
    expect(JSON.parse(await readFile(fixture.path, 'utf8'))).toEqual(deleted.roster)
  })

  it('rechecks existing-file identity before commit and preserves a racing replacement', async () => {
    const fixture = await makeFixture()
    const initial = makeStore(fixture.path)
    await initial.create(0, { name: 'Chief', mission: 'Route', roleName: 'chief' })
    const displaced = join(fixture.root, 'displaced.json')
    const replacement = Buffer.from('{"external":"replacement"}')
    let replaced = false
    const racing = makeStore(fixture.path, {
      idFactory: () => uuid(2),
      beforeIdentityCheck: async () => {
        if (replaced) return
        replaced = true
        await rename(fixture.path, displaced)
        await writeFile(fixture.path, replacement)
      }
    })

    await expect(racing.create(1, { name: 'Scout', mission: 'Research', roleName: 'scout' }))
      .rejects.toMatchObject({ code: 'persist-failed' })
    expect(await readFile(fixture.path)).toEqual(replacement)
    expect((await readdir(fixture.root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('rechecks missing-path absence before commit and never overwrites a racing file', async () => {
    const fixture = await makeFixture()
    const replacement = Buffer.from('new owner')
    let replaced = false
    const store = makeStore(fixture.path, {
      beforeIdentityCheck: async () => {
        if (replaced) return
        replaced = true
        await writeFile(fixture.path, replacement)
        await chmod(fixture.path, 0o640)
      }
    })

    await expect(store.create(0, { name: 'Chief', mission: 'Route', roleName: 'chief' }))
      .rejects.toMatchObject({ code: 'persist-failed' })
    expect(await readFile(fixture.path)).toEqual(replacement)
  })

  it('preserves both the recovery backup and a target claimed while replacement writing fails', async () => {
    const fixture = await makeFixture()
    const malformed = Buffer.from('{"original-malformed":')
    const racingTarget = Buffer.from('{"racing-owner":true}')
    const backupPath = join(fixture.root, 'agents.v1.json.recovered-race-backup')
    await writeFile(fixture.path, malformed)
    let identityChecks = 0
    const store = makeStore(fixture.path, {
      recoveryIdFactory: () => 'race-backup',
      beforeIdentityCheck: async () => {
        identityChecks += 1
        if (identityChecks === 2) await writeFile(fixture.path, racingTarget)
      }
    })

    await expect(store.recover()).rejects.toMatchObject({ code: 'recovery-failed' })

    expect(await readFile(fixture.path)).toEqual(racingTarget)
    expect(await readFile(backupPath)).toEqual(malformed)
    expect((await readdir(fixture.root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('holds a live-PID same-directory lock across identity-check and rename for separate Store instances', async () => {
    const fixture = await makeFixture()
    await makeStore(fixture.path).create(0, {
      name: 'Chief', mission: 'Route', roleName: 'chief'
    })
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const checked = deferred<void>()
    const releaseRename = deferred<void>()
    const first = makeStore(fixture.path, {
      idFactory: () => uuid(2),
      afterIdentityCheck: async () => {
        checked.resolve(undefined)
        await releaseRename.promise
      }
    })
    let secondReachedMutation = false
    const second = makeStore(fixture.path, { idFactory: () => uuid(3) })

    const firstCommit = first.create(1, {
      name: 'Scout', mission: 'Research', roleName: 'scout'
    })
    await checked.promise
    // Make the held lock older than the stale threshold. Its live owner PID
    // must keep the second Store from reclaiming it.
    clock += 31_000
    const secondCommit = second.mutate(1, () => {
      secondReachedMutation = true
    })
    await delay(40)

    expect(secondReachedMutation).toBe(false)
    releaseRename.resolve(undefined)
    await expect(firstCommit).resolves.toMatchObject({ roster: { revision: 2 } })
    await expect(secondCommit).rejects.toMatchObject({ code: 'revision-conflict' })
    expect(secondReachedMutation).toBe(false)
    await expect(makeStore(fixture.path).load()).resolves.toMatchObject({
      status: 'ready',
      roster: { revision: 2, agents: [{ name: 'Chief' }, { name: 'Scout' }] }
    })
  })

  it('fsyncs the bound parent directory after committing the roster rename', async () => {
    const fixture = await makeFixture()
    const probe = await open(fixture.root, 'r')
    const prototype = Object.getPrototypeOf(probe) as {
      sync: (this: FileHandle) => Promise<void>
    }
    const originalSync = prototype.sync
    let directorySyncs = 0
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      if ((await this.stat()).isDirectory()) directorySyncs += 1
      await originalSync.call(this)
    })
    await probe.close()

    await makeStore(fixture.path).create(0, {
      name: 'Chief', mission: 'Route', roleName: 'chief'
    })

    expect(directorySyncs).toBe(1)
  })

  it('keeps using the bound canonical parent if the requested parent symlink is repointed', async () => {
    const fixture = await makeFixture()
    const aliases = await makeFixture()
    await unlink(aliases.path).catch(() => undefined)
    const alias = join(aliases.root, 'user-data-link')
    await symlink(fixture.root, alias)
    const requestedPath = join(alias, 'agents.v1.json')
    const store = makeStore(requestedPath)
    await store.create(0, { name: 'Chief', mission: 'Route', roleName: 'chief' })
    const replacement = await makeFixture()

    await unlink(alias)
    await symlink(replacement.root, alias)
    await store.create(1, { name: 'Scout', mission: 'Research', roleName: 'scout' })

    expect(JSON.parse(await readFile(fixture.path, 'utf8'))).toMatchObject({
      revision: 2,
      agents: [{ name: 'Chief' }, { name: 'Scout' }]
    })
    await expect(lstat(replacement.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed if the bound canonical parent directory is replaced', async () => {
    const fixture = await makeFixture()
    const store = makeStore(fixture.path)
    await store.create(0, { name: 'Chief', mission: 'Route', roleName: 'chief' })
    const displacedRoot = `${fixture.root}-displaced`
    roots.push(displacedRoot)

    await rename(fixture.root, displacedRoot)
    await mkdir(fixture.root, { mode: 0o700 })

    await expect(store.create(1, {
      name: 'Scout', mission: 'Research', roleName: 'scout'
    })).rejects.toMatchObject({ code: 'persist-failed' })
    await expect(lstat(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(displacedRoot, 'agents.v1.json'), 'utf8')))
      .toMatchObject({ revision: 1, agents: [{ name: 'Chief' }] })
  })

  it('recovers an abandoned stale same-directory lock before reading', async () => {
    const fixture = await makeFixture()
    const lockPath = join(fixture.root, '.agents.v1.json.lock')
    const createdAtMs = Date.now()
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: 2_000_000_000,
      nonce: 'abandoned-test-lock',
      createdAtMs
    })}\n`)
    vi.spyOn(Date, 'now').mockReturnValue(createdAtMs + 31_000)

    await expect(makeStore(fixture.path).load()).resolves.toEqual({
      status: 'ready',
      source: 'missing',
      roster: { version: 1, revision: 0, agents: [], sessionBindings: {} }
    })
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never reclaims an old partial lock whose owner cannot be proven dead', async () => {
    const fixture = await makeFixture()
    const lockPath = join(fixture.root, '.agents.v1.json.lock')
    const createdAtMs = Date.now()
    await writeFile(lockPath, '{"version":1,"pid":')
    vi.spyOn(Date, 'now').mockReturnValue(createdAtMs + 31_000)

    let settled = false
    const loading = makeStore(fixture.path).load()
    void loading.then(
      () => { settled = true },
      () => { settled = true }
    )
    await delay(60)

    expect(settled).toBe(false)
    expect((await lstat(lockPath)).isFile()).toBe(true)
    await unlink(lockPath)
    await expect(loading).resolves.toEqual({
      status: 'ready',
      source: 'missing',
      roster: { version: 1, revision: 0, agents: [], sessionBindings: {} }
    })
  })
})

async function makeFixture(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-agent-roster-'))
  roots.push(root)
  return { root, path: join(root, 'agents.v1.json') }
}

function makeStore(
  path: string,
  overrides: ConstructorParameters<typeof AgentRosterStore>[1] = {}
): AgentRosterStore {
  let nextId = 1
  return new AgentRosterStore(path, {
    now: () => NOW,
    idFactory: () => uuid(nextId++),
    ...overrides
  })
}

function legacyAgent(index: number, name: string, roleName: string): Record<string, unknown> {
  return {
    id: uuid(index),
    name,
    mission: `${name} mission`,
    glyph: 'person.fill',
    color: '#5E5CE6',
    roleName,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  }
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}
