import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GrokModelConfigStore,
  MAX_GROK_CONFIG_BYTES
} from '../../src/main/models/GrokModelConfigStore'
import {
  MANAGED_TOML_BEGIN,
  MANAGED_TOML_END,
  projectPublicModelCatalog,
  type ManagedModelProvider
} from '../../src/main/models/managedToml'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GrokModelConfigStore', () => {
  it('creates a restrictive config and preserves an existing CRLF prefix byte-for-byte', async () => {
    const missing = await makeFixture()
    const missingStore = new GrokModelConfigStore(missing.path)
    const initial = await ready(missingStore)
    expect(initial.source).toBe('missing')

    const created = await missingStore.mutate(initial.snapshot.revision, {
      type: 'upsert-provider', provider: provider()
    })
    expect(created.catalog.providers).toEqual([provider()])
    expect((await stat(missing.path)).mode & 0o777).toBe(0o600)
    expect(await readFile(missing.path, 'utf8')).toContain(MANAGED_TOML_BEGIN)

    const existing = await makeFixture()
    await chmod(existing.root, 0o755)
    const unmanaged = [
      '# user bytes stay exact',
      'theme = "system"',
      '',
      '[models]',
      'default = "grok-4.6"',
      ''
    ].join('\r\n')
    await writeFile(existing.path, unmanaged)
    await chmod(existing.path, 0o644)
    const store = new GrokModelConfigStore(existing.path)
    const loaded = await ready(store)
    const committed = await store.mutate(loaded.snapshot.revision, {
      type: 'upsert-provider', provider: provider()
    })
    const bytes = await readFile(existing.path)

    expect(bytes.subarray(0, Buffer.byteLength(unmanaged))).toEqual(Buffer.from(unmanaged))
    const managedSuffix = bytes.toString('utf8').slice(unmanaged.length)
    expect(managedSuffix.startsWith(`${MANAGED_TOML_BEGIN}\r\n`)).toBe(true)
    expect(managedSuffix.replaceAll('\r\n', '')).not.toContain('\n')
    expect(committed.revision).toMatch(/^[a-f0-9]{64}$/u)
    expect((await stat(existing.path)).mode & 0o777).toBe(0o600)
    expect((await readdir(existing.root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('returns bounded invalid reasons for malformed TOML and a tampered managed envelope', async () => {
    const malformed = await makeFixture()
    await secureWrite(malformed.path, 'value = "unterminated')
    await expect(new GrokModelConfigStore(malformed.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'malformed' })

    const tampered = await makeFixture()
    await secureWrite(tampered.path, [
      MANAGED_TOML_BEGIN,
      '[model_providers.local]',
      'base_url = "http://127.0.0.1:9911/v1"',
      'unknown_option = true',
      'api_backend = "chat_completions"',
      'context_window = 128000',
      MANAGED_TOML_END,
      ''
    ].join('\n'))
    await expect(new GrokModelConfigStore(tampered.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'managed-block' })

    const bom = await makeFixture()
    await writeFile(bom.path, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('value = true\n')
    ]), { mode: 0o600 })
    await expect(new GrokModelConfigStore(bom.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'malformed' })

    const invalidUtf8 = await makeFixture()
    await writeFile(invalidUtf8.path, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 })
    await expect(new GrokModelConfigStore(invalidUtf8.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'malformed' })
  })

  it('rejects symlinks, hardlinks, directories, writable files, and oversized files untouched', async () => {
    const linked = await makeFixture()
    const target = join(linked.root, 'target.toml')
    await secureWrite(target, 'target = true\n')
    await symlink(target, linked.path)
    await expect(new GrokModelConfigStore(linked.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'symlink' })
    expect(await readFile(target, 'utf8')).toBe('target = true\n')

    const hardlinked = await makeFixture()
    const hardlinkTarget = join(hardlinked.root, 'target.toml')
    await secureWrite(hardlinkTarget, 'target = true\n')
    await link(hardlinkTarget, hardlinked.path)
    await expect(new GrokModelConfigStore(hardlinked.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'hardlink' })

    const directory = await makeFixture()
    await mkdir(directory.path)
    await expect(new GrokModelConfigStore(directory.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'non-regular' })

    const writable = await makeFixture()
    await secureWrite(writable.path, 'value = true\n')
    await chmod(writable.path, 0o660)
    await expect(new GrokModelConfigStore(writable.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'permissions' })

    const oversized = await makeFixture()
    await writeFile(oversized.path, Buffer.alloc(MAX_GROK_CONFIG_BYTES + 1, 0x20), { mode: 0o600 })
    await expect(new GrokModelConfigStore(oversized.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'oversize' })

    const unsafeParent = await makeFixture()
    await chmod(unsafeParent.root, 0o775)
    await expect(new GrokModelConfigStore(unsafeParent.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'unreadable' })
  })

  it('rechecks the full digest before rename and preserves a racing replacement', async () => {
    const fixture = await makeFixture()
    const initialStore = new GrokModelConfigStore(fixture.path)
    const initial = await ready(initialStore)
    const committed = await initialStore.mutate(initial.snapshot.revision, {
      type: 'upsert-provider', provider: provider()
    })
    const displaced = join(fixture.root, 'displaced.toml')
    const replacement = Buffer.from('external_owner = true\n')
    let replaced = false
    const racing = new GrokModelConfigStore(fixture.path, {
      beforeIdentityCheck: async () => {
        if (replaced) return
        replaced = true
        await rename(fixture.path, displaced)
        await writeFile(fixture.path, replacement, { mode: 0o600 })
      }
    })

    await expect(racing.mutate(committed.revision, {
      type: 'upsert-provider', provider: provider({ contextWindow: 256_000 })
    })).rejects.toMatchObject({ code: 'persist-failed' })
    expect(await readFile(fixture.path)).toEqual(replacement)
    expect((await readdir(fixture.root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('holds a live cross-instance lock across both CAS checks and rejects a stale revision', async () => {
    const fixture = await makeFixture()
    const seed = new GrokModelConfigStore(fixture.path)
    const initial = await ready(seed)
    const firstRevision = await seed.mutate(initial.snapshot.revision, {
      type: 'upsert-provider', provider: provider()
    })
    const checked = deferred<void>()
    const release = deferred<void>()
    const first = new GrokModelConfigStore(fixture.path, {
      afterIdentityCheck: async () => {
        checked.resolve(undefined)
        await release.promise
      }
    })
    const second = new GrokModelConfigStore(fixture.path)

    const firstCommit = first.mutate(firstRevision.revision, {
      type: 'upsert-provider', provider: provider({ contextWindow: 256_000 })
    })
    await checked.promise
    let secondSettled = false
    const secondCommit = second.mutate(firstRevision.revision, {
      type: 'upsert-provider', provider: provider({ contextWindow: 512_000 })
    })
    void secondCommit.then(
      () => { secondSettled = true },
      () => { secondSettled = true }
    )
    await delay(40)
    expect(secondSettled).toBe(false)

    release.resolve(undefined)
    await expect(firstCommit).resolves.toMatchObject({
      catalog: { providers: [{ contextWindow: 256_000 }] }
    })
    await expect(secondCommit).rejects.toMatchObject({ code: 'revision-conflict' })
  })

  it('leaves a crash-safe empty lock inode after first creation and reuses it', async () => {
    const fixture = await makeFixture()
    const lockPath = configLockPath(fixture)
    const interrupted = new GrokModelConfigStore(fixture.path, {
      advisoryLockRunner: {
        acquire: async () => { throw new Error('simulated process loss after create') }
      }
    })

    await expect(interrupted.load()).resolves.toEqual({ status: 'invalid', reason: 'unreadable' })
    const residue = await lstat(lockPath)
    expect(residue.isFile()).toBe(true)
    expect(residue.mode & 0o777).toBe(0o600)
    expect(residue.nlink).toBe(1)
    expect(residue.size).toBe(0)

    await expect(new GrokModelConfigStore(fixture.path).load()).resolves.toMatchObject({
      status: 'ready', source: 'missing'
    })
    const reused = await lstat(lockPath)
    expect(reused.ino).toBe(residue.ino)
    expect(await readFile(lockPath)).toEqual(Buffer.alloc(0))
  })

  it('rejects unsafe persistent lock entries without repairing or deleting them', async () => {
    const nonempty = await makeFixture()
    await secureWrite(configLockPath(nonempty), 'partial-record')
    await expect(new GrokModelConfigStore(nonempty.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'unreadable' })
    expect(await readFile(configLockPath(nonempty), 'utf8')).toBe('partial-record')

    const writable = await makeFixture()
    await writeFile(configLockPath(writable), '', { mode: 0o644 })
    await chmod(configLockPath(writable), 0o644)
    await expect(new GrokModelConfigStore(writable.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'unreadable' })
    expect((await lstat(configLockPath(writable))).mode & 0o777).toBe(0o644)

    const hardlinked = await makeFixture()
    const hardlinkTarget = join(hardlinked.root, 'lock-target')
    await secureWrite(hardlinkTarget, '')
    await link(hardlinkTarget, configLockPath(hardlinked))
    await expect(new GrokModelConfigStore(hardlinked.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'unreadable' })
    expect((await lstat(hardlinkTarget)).nlink).toBe(2)

    const aliased = await makeFixture()
    const aliasTarget = join(aliased.root, 'lock-target')
    await secureWrite(aliasTarget, '')
    await symlink(aliasTarget, configLockPath(aliased))
    await expect(new GrokModelConfigStore(aliased.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'unreadable' })
    expect((await lstat(configLockPath(aliased))).isSymbolicLink()).toBe(true)

    const directory = await makeFixture()
    await mkdir(configLockPath(directory), { mode: 0o600 })
    await expect(new GrokModelConfigStore(directory.path).load())
      .resolves.toEqual({ status: 'invalid', reason: 'unreadable' })
    expect((await lstat(configLockPath(directory))).isDirectory()).toBe(true)
  })

  it('fails closed if the persistent lock path is replaced while acquisition is in flight', async () => {
    const fixture = await makeFixture()
    await ready(new GrokModelConfigStore(fixture.path))
    const lockPath = configLockPath(fixture)
    const original = await lstat(lockPath)
    const displaced = join(fixture.root, 'displaced-lock')
    let replaced = false
    const racing = new GrokModelConfigStore(fixture.path, {
      advisoryLockRunner: {
        acquire: async () => {
          if (replaced) return
          replaced = true
          await rename(lockPath, displaced)
          await secureWrite(lockPath, '')
        }
      }
    })

    await expect(racing.load()).resolves.toEqual({ status: 'invalid', reason: 'unreadable' })
    expect((await lstat(displaced)).ino).toBe(original.ino)
    expect((await lstat(lockPath)).ino).not.toBe(original.ino)
    expect(await readFile(displaced)).toEqual(Buffer.alloc(0))
    expect(await readFile(lockPath)).toEqual(Buffer.alloc(0))
  })

  ;(process.platform === 'darwin' ? it : it.skip)(
    'recovers the advisory lease automatically after the holder process is SIGKILLed',
    async () => {
      const fixture = await makeFixture()
      const lockPath = configLockPath(fixture)
      await secureWrite(lockPath, '')
      const holder = spawnLockHolder(lockPath)
      try {
        await waitForChildLine(holder, 'LOCKED')
        let settled = false
        const load = new GrokModelConfigStore(fixture.path).load()
        void load.finally(() => { settled = true })
        await delay(40)
        expect(settled).toBe(false)

        const closed = waitForChildClose(holder)
        expect(holder.kill('SIGKILL')).toBe(true)
        await expect(closed).resolves.toMatchObject({ signal: 'SIGKILL' })
        await expect(load).resolves.toMatchObject({ status: 'ready', source: 'missing' })
        expect((await lstat(lockPath)).size).toBe(0)
      } finally {
        if (holder.exitCode === null && holder.signalCode === null) {
          holder.kill('SIGKILL')
          await waitForChildClose(holder).catch(() => undefined)
        }
      }
    }
  )

  it('binds the canonical parent identity and fails closed after directory replacement', async () => {
    const fixture = await makeFixture()
    const store = new GrokModelConfigStore(fixture.path)
    const loaded = await ready(store)
    const displaced = `${fixture.root}-displaced`
    roots.push(displaced)
    await rename(fixture.root, displaced)
    await mkdir(fixture.root, { mode: 0o700 })

    await expect(store.mutate(loaded.snapshot.revision, {
      type: 'upsert-provider', provider: provider()
    })).rejects.toMatchObject({ code: 'persist-failed' })
    await expect(lstat(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(displaced, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a requested parent containing a direct or intermediate symlink alias', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'grokbuild-model-alias-')))
    roots.push(root)
    const target = join(root, 'target')
    const nested = join(target, 'nested')
    await mkdir(nested, { recursive: true, mode: 0o700 })

    const directAlias = join(root, 'direct-alias')
    await symlink(nested, directAlias)
    await expect(new GrokModelConfigStore(join(directAlias, 'config.toml')).load())
      .resolves.toEqual({ status: 'invalid', reason: 'unreadable' })

    const componentAlias = join(root, 'component-alias')
    await symlink(target, componentAlias)
    await expect(new GrokModelConfigStore(join(componentAlias, 'nested', 'config.toml')).load())
      .resolves.toEqual({ status: 'invalid', reason: 'unreadable' })
    await expect(lstat(join(nested, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' })

    const missingThroughAlias = join(target, 'must-not-be-created')
    await expect(new GrokModelConfigStore(
      join(componentAlias, 'must-not-be-created', 'config.toml')
    ).load()).resolves.toEqual({ status: 'invalid', reason: 'unreadable' })
    await expect(lstat(missingThroughAlias)).rejects.toMatchObject({ code: 'ENOENT' })

    const missingParent = join(root, 'plain-missing-parent')
    await expect(new GrokModelConfigStore(join(missingParent, 'config.toml')).load())
      .resolves.toEqual({ status: 'invalid', reason: 'unreadable' })
    await expect(lstat(missingParent)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('domain-separates missing and empty revisions in both transition directions', async () => {
    const fixture = await makeFixture()
    const store = new GrokModelConfigStore(fixture.path)
    const missing = await ready(store)
    await secureWrite(fixture.path, '')
    const empty = await ready(new GrokModelConfigStore(fixture.path))

    expect(missing.snapshot.revision).toMatch(/^[a-f0-9]{64}$/u)
    expect(empty.snapshot.revision).toMatch(/^[a-f0-9]{64}$/u)
    expect(missing.snapshot.revision).not.toBe(empty.snapshot.revision)
    await expect(store.mutate(missing.snapshot.revision, {
      type: 'upsert-provider', provider: provider()
    })).rejects.toMatchObject({ code: 'revision-conflict' })
    expect(await readFile(fixture.path)).toEqual(Buffer.alloc(0))

    await unlink(fixture.path)
    await expect(store.mutate(empty.snapshot.revision, {
      type: 'upsert-provider', provider: provider()
    })).rejects.toMatchObject({ code: 'revision-conflict' })
    await expect(lstat(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks provider deletion when quoted or dotted unmanaged model tables reference it', async () => {
    const fixture = await makeFixture()
    const unmanaged = [
      '[model."quoted.id"]',
      'model_provider = "local-compatible"',
      '',
      '[model.dotted.id]',
      'model_provider = "local-compatible"',
      ''
    ].join('\n')
    await secureWrite(fixture.path, unmanaged)
    const store = new GrokModelConfigStore(fixture.path)
    const loaded = await ready(store)
    const withProvider = await store.mutate(loaded.snapshot.revision, {
      type: 'upsert-provider', provider: provider()
    })
    const beforeDelete = await readFile(fixture.path)

    await expect(store.mutate(withProvider.revision, {
      type: 'delete-provider', providerId: 'local-compatible'
    })).rejects.toMatchObject({ code: 'provider-in-use' })
    expect(await readFile(fixture.path)).toEqual(beforeDelete)
  })

  it('rejects unknown mutation discriminants without changing user bytes', async () => {
    const fixture = await makeFixture()
    const canary = 'unknown-mutation-private-canary'
    await secureWrite(fixture.path, `private_value = ${JSON.stringify(canary)}\n`)
    const store = new GrokModelConfigStore(fixture.path)
    const loaded = await ready(store)
    const before = await readFile(fixture.path)

    await expect(store.mutate(loaded.snapshot.revision, {
      type: 'future-unknown-mutation', secret: canary
    } as never)).rejects.toMatchObject({
      code: 'invalid-mutation', message: 'The model configuration change is invalid.'
    })
    expect(await readFile(fixture.path)).toEqual(before)
  })

  it('supports bounded env-key arrays without projecting names and normalizes endpoint classes', async () => {
    const privateEnvironmentNames = ['PRIVATE_PRIMARY_TOKEN', 'PRIVATE_FALLBACK_TOKEN']
    const catalog = {
      providers: [
        provider({ id: 'localhost-dot', baseUrl: 'http://localhost.:9911/v1' }),
        provider({
          id: 'mapped-loopback',
          baseUrl: 'http://[::ffff:127.0.0.1]:9911/v1',
          envKey: privateEnvironmentNames
        }),
        provider({ id: 'mapped-lan', baseUrl: 'http://[::ffff:192.168.1.5]:9911/v1' })
      ],
      models: []
    }
    const projected = projectPublicModelCatalog(catalog, {
      environmentAvailable: (name) => name === 'PRIVATE_FALLBACK_TOKEN'
    })

    expect(projected.providers.map(({ id, endpointClass }) => [id, endpointClass])).toEqual([
      ['localhost-dot', 'loopback'],
      ['mapped-lan', 'lan'],
      ['mapped-loopback', 'loopback']
    ])
    expect(projected.providers.find((item) => item.id === 'mapped-loopback')).toMatchObject({
      credentialState: 'environment', status: 'configured'
    })
    const publicBytes = JSON.stringify(projected)
    for (const name of privateEnvironmentNames) expect(publicBytes).not.toContain(name)

    const fixture = await makeFixture()
    const store = new GrokModelConfigStore(fixture.path)
    const initial = await ready(store)
    await store.mutate(initial.snapshot.revision, {
      type: 'upsert-provider',
      provider: provider({ envKey: privateEnvironmentNames })
    })
    expect(await readFile(fixture.path, 'utf8'))
      .toContain('env_key = ["PRIVATE_PRIMARY_TOKEN","PRIVATE_FALLBACK_TOKEN"]')

    const loaded = await ready(new GrokModelConfigStore(fixture.path))
    expect(loaded.snapshot.catalog.providers[0]?.envKey).toEqual(privateEnvironmentNames)
    await expect(store.mutate(loaded.snapshot.revision, {
      type: 'upsert-provider',
      provider: provider({ envKey: Array(9).fill('DUPLICATE') })
    })).rejects.toMatchObject({ code: 'invalid-mutation' })
  })

  it('fsyncs the bound parent directory after the atomic rename', async () => {
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
    const store = new GrokModelConfigStore(fixture.path)
    const loaded = await ready(store)
    const beforeMutation = directorySyncs

    await store.mutate(loaded.snapshot.revision, {
      type: 'upsert-provider', provider: provider()
    })

    expect(directorySyncs - beforeMutation).toBe(1)
  })

  it('never includes unknown private values in public errors', async () => {
    const fixture = await makeFixture()
    const privateCanary = 'private-value-must-stay-in-file'
    await secureWrite(fixture.path, `private_value = ${JSON.stringify(privateCanary)}\n`)
    const store = new GrokModelConfigStore(fixture.path)
    const loaded = await ready(store)

    let message = ''
    try {
      await store.mutate(loaded.snapshot.revision, {
        type: 'upsert-provider',
        provider: { ...provider(), extraPrivateValue: privateCanary } as ManagedModelProvider
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toBe('The model configuration change is invalid.')
    expect(message).not.toContain(privateCanary)
    expect(await readFile(fixture.path, 'utf8')).toContain(privateCanary)
  })
})

async function makeFixture(): Promise<{ root: string; path: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grokbuild-model-config-')))
  roots.push(root)
  return { root, path: join(root, 'config.toml') }
}

async function secureWrite(path: string, text: string): Promise<void> {
  await writeFile(path, text, { mode: 0o600 })
  await chmod(path, 0o600)
}

async function ready(store: GrokModelConfigStore): Promise<
  Extract<Awaited<ReturnType<GrokModelConfigStore['load']>>, { status: 'ready' }>
> {
  const result = await store.load()
  if (result.status !== 'ready') throw new Error(`fixture failed: ${result.reason}`)
  return result
}

function provider(overrides: Partial<ManagedModelProvider> = {}): ManagedModelProvider {
  return {
    id: 'local-compatible',
    baseUrl: 'http://127.0.0.1:9911/v1',
    envKey: 'LOCAL_PROVIDER_TOKEN',
    apiBackend: 'chat_completions',
    contextWindow: 128_000,
    ...overrides
  }
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

function configLockPath(fixture: { root: string }): string {
  return join(fixture.root, '.config.toml.grokbuild-electron.lock')
}

function spawnLockHolder(lockPath: string): ChildProcess {
  const script = [
    "import { spawn } from 'node:child_process'",
    "import { constants } from 'node:fs'",
    "import { open } from 'node:fs/promises'",
    'const handle = await open(process.argv[1], constants.O_RDWR | constants.O_NOFOLLOW)',
    "const helper = spawn('/usr/bin/lockf', ['-s', '-t', '2', '3'], {",
    "  shell: false, env: { LANG: 'C', LC_ALL: 'C' },",
    "  stdio: ['ignore', 'ignore', 'ignore', handle.fd]",
    '})',
    "helper.once('error', () => process.exit(91))",
    "helper.once('close', (code, signal) => {",
    "  if (signal || code !== 0) process.exit(92)",
    "  process.stdout.write('LOCKED\\n')",
    '  setInterval(() => undefined, 10_000)',
    '})'
  ].join('\n')
  return spawn(process.execPath, ['--input-type=module', '-e', script, lockPath], {
    shell: false,
    env: { LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function waitForChildLine(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => finish(new Error('holder readiness timed out')), 2_000)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.split(/\r?\n/u).includes(expected)) finish()
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`holder exited before readiness (${String(code)}/${String(signal)})`))
    }
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('close', onClose)
      if (error) reject(error)
      else resolve()
    }
    child.stdout?.on('data', onData)
    child.once('close', onClose)
  })
}

function waitForChildClose(child: ChildProcess): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}
