import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MemoryBroker,
  MemoryBrokerError,
  appendMemoryNote
} from '../../src/main/memory/MemoryBroker'
import {
  grokMemoryLaunchArgument,
  memoryTokenInputSchema,
  publicMemoryFileContentsSchema,
  publicMemoryFileSummariesSchema,
  rememberMemoryInputSchema
} from '../../src/shared/memory'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function memoryFixture(): Promise<{ root: string; base: string }> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-memory-broker-'))
  roots.push(root)
  const base = join(root, '.grok', 'memory')
  await mkdir(base, { recursive: true, mode: 0o700 })
  return { root, base }
}

async function writeMemory(base: string, relative: string, contents: string | Buffer): Promise<string> {
  const path = join(base, relative)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, contents, { mode: 0o600 })
  return path
}

function capabilityFactory(seed = 1): () => string {
  let counter = seed
  return () => {
    const bytes = Buffer.alloc(32)
    bytes.writeUInt32BE(counter, 28)
    counter += 1
    return bytes.toString('base64url')
  }
}

function broker(base: string, options: Partial<ConstructorParameters<typeof MemoryBroker>[0]> = {}): MemoryBroker {
  return new MemoryBroker({
    basePath: base,
    tokenFactory: capabilityFactory(1),
    nonceFactory: capabilityFactory(10_000),
    ...options
  })
}

describe('MemoryBroker discovery and public capabilities', () => {
  it('groups global, workspace, and newest-first session Markdown without exposing paths or slugs', async () => {
    const { root, base } = await memoryFixture()
    await writeMemory(base, 'MEMORY.md', '# Global Memory\n')
    await writeMemory(base, 'private-project-deadbeef/MEMORY.md', '# Project Memory\n')
    const older = await writeMemory(
      base,
      'private-project-deadbeef/sessions/2026-08-24-old.md',
      '# Old\n'
    )
    const newer = await writeMemory(
      base,
      'private-project-deadbeef/sessions/2026-08-25-new.md',
      '# New\n'
    )
    await utimes(older, new Date(1_000), new Date(1_000))
    await utimes(newer, new Date(2_000), new Date(2_000))
    await writeMemory(base, 'private-project-deadbeef/sessions/index.sqlite', 'private index')
    await writeMemory(base, 'private-project-deadbeef/sessions/ignore.txt', 'ignore')

    const summaries = await broker(base).list()

    expect(summaries.map(({ scope, title, workspaceLabel, canDelete }) => ({
      scope,
      title,
      workspaceLabel,
      canDelete
    }))).toEqual([
      { scope: 'global', title: 'Global memory', workspaceLabel: undefined, canDelete: false },
      { scope: 'workspace', title: 'Workspace memory', workspaceLabel: 'Workspace 1', canDelete: false },
      { scope: 'session', title: '2026-08-25-new', workspaceLabel: 'Workspace 1', canDelete: true },
      { scope: 'session', title: '2026-08-24-old', workspaceLabel: 'Workspace 1', canDelete: true }
    ])
    expect(publicMemoryFileSummariesSchema.parse(summaries)).toEqual(summaries)
    const serialized = JSON.stringify(summaries)
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain(base)
    expect(serialized).not.toContain('private-project-deadbeef')
    expect(serialized).not.toContain('index.sqlite')
  })

  it('returns empty when the main-owned memory root is absent', async () => {
    const { root } = await memoryFixture()
    const absent = join(root, 'another-home', '.grok', 'memory')
    await expect(broker(absent).list()).resolves.toEqual([])
  })

  it('sanitizes control characters in renderer-visible session titles', async () => {
    const { base } = await memoryFixture()
    await writeMemory(base, 'repo-deadbeef/sessions/a\u0001c.md', 'safe')
    const [summary] = await broker(base).list()
    expect(summary?.title).toBe('a c')
    expect(JSON.stringify(summary)).not.toContain('\\u0001')
  })

  it('bounds the number of renderer-visible files', async () => {
    const { base } = await memoryFixture()
    await writeMemory(base, 'MEMORY.md', 'global')
    await writeMemory(base, 'repo-deadbeef/MEMORY.md', 'workspace')
    await expect(broker(base, { limits: { files: 1 } }).list())
      .rejects.toMatchObject({ code: 'too-many-files' })
  })

  it('bounds directory scanning even when entries are not renderer-visible Markdown', async () => {
    const { base } = await memoryFixture()
    for (let index = 0; index < 65; index += 1) {
      await writeMemory(base, `ignored-${String(index).padStart(2, '0')}.txt`, 'ignored')
    }
    await expect(broker(base, { limits: { files: 1 } }).list())
      .rejects.toMatchObject({ code: 'too-many-files' })
  })

  it('bounds labels by the shared UTF-16 schema limit', async () => {
    const { base } = await memoryFixture()
    await writeMemory(base, `repo-deadbeef/sessions/${'a'.repeat(200)}.md`, 'safe')
    const summaries = await broker(base).list()
    expect(summaries[0]?.title).toBe('a'.repeat(128))
    expect(publicMemoryFileSummariesSchema.parse(summaries)).toEqual(summaries)
  })

  it('does not follow workspace directory symlinks', async () => {
    const { root, base } = await memoryFixture()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeMemory(outside, 'MEMORY.md', 'PATH-CANARY')
    await symlink(outside, join(base, 'linked-workspace'))
    const summaries = await broker(base).list()
    expect(summaries).toEqual([])
    expect(JSON.stringify(summaries)).not.toContain('PATH-CANARY')
  })

  it('rejects recognized symlink and hardlink files instead of following them', async () => {
    const symlinkFixture = await memoryFixture()
    const outside = await writeMemory(symlinkFixture.root, 'outside.md', 'outside')
    await symlink(outside, join(symlinkFixture.base, 'MEMORY.md'))
    await expect(broker(symlinkFixture.base).list())
      .rejects.toMatchObject({ code: 'unavailable' })

    const hardlinkFixture = await memoryFixture()
    const source = await writeMemory(hardlinkFixture.base, 'source.md', 'source')
    await mkdir(join(hardlinkFixture.base, 'repo-deadbeef', 'sessions'), { recursive: true })
    await link(source, join(hardlinkFixture.base, 'repo-deadbeef', 'sessions', 'linked.md'))
    await expect(broker(hardlinkFixture.base).list())
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('allows ordinary 0644 Markdown but rejects writable parent/base/workspace/session/file modes', async () => {
    const safeFixture = await memoryFixture()
    const safeFile = await writeMemory(safeFixture.base, 'MEMORY.md', 'safe')
    await chmod(safeFile, 0o644)
    await chmod(dirname(safeFixture.base), 0o755)
    await chmod(safeFixture.base, 0o755)
    const safeMemory = broker(safeFixture.base)
    const [safeSummary] = await safeMemory.list()
    await expect(safeMemory.read(safeSummary!.token)).resolves.toMatchObject({ contents: 'safe' })

    const cases: Array<{
      name: string
      prepare: (base: string) => Promise<string>
      mode: number
    }> = [
      {
        name: 'parent',
        prepare: async (base) => {
          await writeMemory(base, 'MEMORY.md', 'unsafe parent')
          return dirname(base)
        },
        mode: 0o777
      },
      {
        name: 'base',
        prepare: async (base) => {
          await writeMemory(base, 'MEMORY.md', 'unsafe base')
          return base
        },
        mode: 0o777
      },
      {
        name: 'workspace',
        prepare: async (base) => {
          await writeMemory(base, 'repo-deadbeef/MEMORY.md', 'unsafe workspace')
          return join(base, 'repo-deadbeef')
        },
        mode: 0o777
      },
      {
        name: 'sessions',
        prepare: async (base) => {
          await writeMemory(base, 'repo-deadbeef/sessions/log.md', 'unsafe sessions')
          return join(base, 'repo-deadbeef', 'sessions')
        },
        mode: 0o777
      },
      {
        name: 'file',
        prepare: async (base) => await writeMemory(base, 'MEMORY.md', 'unsafe file'),
        mode: 0o666
      }
    ]
    for (const candidate of cases) {
      const fixture = await memoryFixture()
      const unsafePath = await candidate.prepare(fixture.base)
      await chmod(unsafePath, candidate.mode)
      await expect(broker(fixture.base).list(), candidate.name)
        .rejects.toMatchObject({ code: 'unavailable' })
    }
  })

  it('revalidates file mode after a token is minted', async () => {
    const { base } = await memoryFixture()
    const file = await writeMemory(base, 'MEMORY.md', 'safe then unsafe')
    const memory = broker(base)
    const [summary] = await memory.list()
    await chmod(file, 0o666)
    await expect(memory.read(summary!.token)).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('MemoryBroker read capabilities', () => {
  it('reads bounded UTF-8 content through an opaque token only', async () => {
    const { base } = await memoryFixture()
    await writeMemory(base, 'MEMORY.md', '# Global\n\nA fact.\n')
    const memory = broker(base)
    const [summary] = await memory.list()
    const result = await memory.read(summary!.token)
    expect(result.contents).toBe('# Global\n\nA fact.\n')
    expect(publicMemoryFileContentsSchema.parse(result)).toEqual(result)
    expect(Object.keys(result)).not.toContain('path')
  })

  it('invalidates old tokens on refresh and expiry', async () => {
    const { base } = await memoryFixture()
    await writeMemory(base, 'MEMORY.md', 'fact')
    let now = 1_000
    const memory = broker(base, { now: () => now, ttlMs: 10 })
    const [first] = await memory.list()
    await memory.list()
    await expect(memory.read(first!.token)).rejects.toMatchObject({ code: 'invalid-token' })

    const [second] = await memory.list()
    now += 10
    await expect(memory.read(second!.token)).rejects.toMatchObject({ code: 'invalid-token' })
  })

  it('rejects file replacement, root replacement, and parent replacement after listing', async () => {
    const fileFixture = await memoryFixture()
    const filePath = await writeMemory(fileFixture.base, 'MEMORY.md', 'old')
    const fileBroker = broker(fileFixture.base)
    const [fileSummary] = await fileBroker.list()
    await unlink(filePath)
    await writeFile(filePath, 'new', { mode: 0o600 })
    await expect(fileBroker.read(fileSummary!.token)).rejects.toMatchObject({ code: 'changed' })

    const rootFixture = await memoryFixture()
    await writeMemory(rootFixture.base, 'MEMORY.md', 'old root')
    const rootBroker = broker(rootFixture.base)
    const [rootSummary] = await rootBroker.list()
    await rename(rootFixture.base, `${rootFixture.base}-old`)
    await mkdir(rootFixture.base)
    await writeMemory(rootFixture.base, 'MEMORY.md', 'new root')
    await expect(rootBroker.read(rootSummary!.token)).rejects.toMatchObject({ code: 'changed' })

    const parentFixture = await memoryFixture()
    await writeMemory(parentFixture.base, 'MEMORY.md', 'old parent')
    const parentBroker = broker(parentFixture.base)
    const [parentSummary] = await parentBroker.list()
    const grokParent = dirname(parentFixture.base)
    await rename(grokParent, `${grokParent}-old`)
    await mkdir(parentFixture.base, { recursive: true })
    await writeMemory(parentFixture.base, 'MEMORY.md', 'new parent')
    await expect(parentBroker.read(parentSummary!.token)).rejects.toMatchObject({ code: 'changed' })
  })

  it('rejects oversized and invalid UTF-8 previews', async () => {
    const oversizedFixture = await memoryFixture()
    await writeMemory(oversizedFixture.base, 'MEMORY.md', '12345')
    const oversized = broker(oversizedFixture.base, { limits: { previewBytes: 4 } })
    const [oversizedSummary] = await oversized.list()
    await expect(oversized.read(oversizedSummary!.token))
      .rejects.toMatchObject({ code: 'too-large' })

    const utf8Fixture = await memoryFixture()
    await writeMemory(utf8Fixture.base, 'MEMORY.md', Buffer.from([0xff, 0xfe]))
    const invalidUtf8 = broker(utf8Fixture.base)
    const [invalidSummary] = await invalidUtf8.list()
    await expect(invalidUtf8.read(invalidSummary!.token))
      .rejects.toMatchObject({ code: 'invalid-utf8' })
  })
})

describe('MemoryBroker remember', () => {
  it('creates global MEMORY.md and appends under one Notes heading without returning a path', async () => {
    const { root } = await memoryFixture()
    const base = join(root, 'fresh', '.grok', 'memory')
    const memory = broker(base)

    await expect(memory.remember('staging uses eu-west')).resolves.toBeUndefined()
    await expect(memory.remember('deploys happen on Fridays')).resolves.toBeUndefined()

    const contents = await readFile(join(base, 'MEMORY.md'), 'utf8')
    expect(contents.match(/^## Notes$/gmu)).toHaveLength(1)
    expect(contents).toContain('- staging uses eu-west')
    expect(contents).toContain('- deploys happen on Fridays')
    expect((await lstat(join(base, 'MEMORY.md'))).nlink).toBe(1)
  })

  it('preserves existing sections and inserts multiline notes before the next H2', async () => {
    const { base } = await memoryFixture()
    await writeMemory(
      base,
      'MEMORY.md',
      '# Global Memory\n\n## Notes\n\n- old\n\n## Other\n\nkeep me\n'
    )
    await broker(base).remember('line one\nline two')
    const contents = await readFile(join(base, 'MEMORY.md'), 'utf8')
    expect(contents.indexOf('- line one\n  line two')).toBeGreaterThan(contents.indexOf('- old'))
    expect(contents.indexOf('- line one\n  line two')).toBeLessThan(contents.indexOf('## Other'))
    expect(contents).toContain('keep me')
  })

  it('rejects empty, control-bearing, oversized, and global-overflow notes', async () => {
    const { base } = await memoryFixture()
    const limited = broker(base, { limits: { noteBytes: 4, globalBytes: 32 } })
    await expect(limited.remember('   ')).rejects.toMatchObject({ code: 'empty-note' })
    await expect(limited.remember('a\u0000b')).rejects.toMatchObject({ code: 'empty-note' })
    await expect(limited.remember('hello')).rejects.toMatchObject({ code: 'too-large' })

    await writeMemory(base, 'MEMORY.md', 'x'.repeat(30))
    await expect(limited.remember('ok')).rejects.toMatchObject({ code: 'too-large' })
    expect(await readFile(join(base, 'MEMORY.md'), 'utf8')).toBe('x'.repeat(30))
  })

  it('serializes cross-instance appends with a same-directory lock', async () => {
    const { base } = await memoryFixture()
    const first = broker(base, {
      tokenFactory: capabilityFactory(1),
      nonceFactory: capabilityFactory(1_000),
      lockWaitMs: 1_000
    })
    const second = broker(base, {
      tokenFactory: capabilityFactory(2),
      nonceFactory: capabilityFactory(2_000),
      lockWaitMs: 1_000
    })
    await Promise.all([
      first.remember('first concurrent note'),
      second.remember('second concurrent note')
    ])
    const contents = await readFile(join(base, 'MEMORY.md'), 'utf8')
    expect(contents).toContain('- first concurrent note')
    expect(contents).toContain('- second concurrent note')
    expect(contents.match(/^## Notes$/gmu)).toHaveLength(1)
    expect((await readdir(base)).filter((name) => name.startsWith('.grokbuild-memory'))).toEqual([])
  })

  it('never steals an unknown or symlink lock and leaves CLI-owned files intact', async () => {
    const regularFixture = await memoryFixture()
    const lockPath = await writeMemory(
      regularFixture.base,
      '.grokbuild-memory.lock',
      'unknown owner'
    )
    await writeMemory(regularFixture.base, 'repo-deadbeef/index.sqlite', 'CLI INDEX')
    await expect(broker(regularFixture.base, { lockWaitMs: 20 }).remember('note'))
      .rejects.toMatchObject({ code: 'busy' })
    expect(await readFile(lockPath, 'utf8')).toBe('unknown owner')
    expect(await readFile(join(regularFixture.base, 'repo-deadbeef', 'index.sqlite'), 'utf8'))
      .toBe('CLI INDEX')
    await expect(readFile(join(regularFixture.base, 'MEMORY.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const symlinkFixture = await memoryFixture()
    const outside = await writeMemory(symlinkFixture.root, 'outside.lock', 'outside')
    await symlink(outside, join(symlinkFixture.base, '.grokbuild-memory.lock'))
    await expect(broker(symlinkFixture.base, { lockWaitMs: 0 }).remember('note'))
      .rejects.toMatchObject({ code: 'busy' })
    expect(await readFile(outside, 'utf8')).toBe('outside')
  })

  it('never reclaims empty, partial, malformed, unsafe-mode, or not-yet-stale locks', async () => {
    const now = 100_000
    const records = [
      '',
      '{"version":1',
      JSON.stringify({ version: 1, pid: 42, createdAt: 0 }),
      JSON.stringify({
        version: 1,
        pid: 42,
        nonce: capabilityFactory(42)(),
        createdAt: now - 100
      })
    ]
    for (const [index, contents] of records.entries()) {
      const fixture = await memoryFixture()
      const lockPath = await writeMemory(fixture.base, '.grokbuild-memory.lock', contents)
      const memory = broker(fixture.base, {
        now: () => now,
        isProcessAlive: () => false,
        lockWaitMs: 0
      })
      await expect(memory.remember(`note ${index}`)).rejects.toMatchObject({ code: 'busy' })
      expect(await readFile(lockPath, 'utf8')).toBe(contents)
    }

    const unsafeFixture = await memoryFixture()
    const unsafeLock = await writeMemory(
      unsafeFixture.base,
      '.grokbuild-memory.lock',
      JSON.stringify({
        version: 1,
        pid: 42,
        nonce: capabilityFactory(43)(),
        createdAt: 0
      })
    )
    await chmod(unsafeLock, 0o666)
    await expect(broker(unsafeFixture.base, {
      now: () => now,
      isProcessAlive: () => false,
      lockWaitMs: 0
    }).remember('note')).rejects.toMatchObject({ code: 'busy' })
    expect((await lstat(unsafeLock)).mode & 0o777).toBe(0o666)
  })

  it('keeps a complete old lock owned by a live PID', async () => {
    const { base } = await memoryFixture()
    const now = 100_000
    const record = JSON.stringify({
      version: 1,
      pid: 4242,
      nonce: capabilityFactory(50)(),
      createdAt: 0
    })
    const lockPath = await writeMemory(base, '.grokbuild-memory.lock', record)
    const observedPids: number[] = []
    const memory = broker(base, {
      now: () => now,
      isProcessAlive: (pid) => {
        observedPids.push(pid)
        return true
      },
      lockWaitMs: 0
    })
    await expect(memory.remember('note')).rejects.toMatchObject({ code: 'busy' })
    expect(observedPids).toEqual([4242])
    expect(await readFile(lockPath, 'utf8')).toBe(record)
  })

  it('identity-safely reclaims only a complete stale lock whose PID is dead', async () => {
    const { base } = await memoryFixture()
    const now = 100_000
    await writeMemory(
      base,
      '.grokbuild-memory.lock',
      `${JSON.stringify({
        version: 1,
        pid: 4242,
        nonce: capabilityFactory(60)(),
        createdAt: 0
      })}\n`
    )
    const memory = broker(base, {
      now: () => now,
      isProcessAlive: (pid) => pid !== 4242,
      lockWaitMs: 0,
      nonceFactory: capabilityFactory(5_000)
    })
    await expect(memory.remember('recovered after a crash')).resolves.toBeUndefined()
    expect(await readFile(join(base, 'MEMORY.md'), 'utf8')).toContain('- recovered after a crash')
    expect((await readdir(base)).filter((name) => name.startsWith('.grokbuild-memory'))).toEqual([])
  })

  it('refuses a symlink or hardlinked global MEMORY.md without modifying its target', async () => {
    const symlinkFixture = await memoryFixture()
    const outside = await writeMemory(symlinkFixture.root, 'outside.md', 'outside')
    await symlink(outside, join(symlinkFixture.base, 'MEMORY.md'))
    await expect(broker(symlinkFixture.base).remember('note'))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(await readFile(outside, 'utf8')).toBe('outside')

    const hardlinkFixture = await memoryFixture()
    const original = await writeMemory(hardlinkFixture.root, 'original.md', 'original')
    await link(original, join(hardlinkFixture.base, 'MEMORY.md'))
    await expect(broker(hardlinkFixture.base).remember('note'))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(await readFile(original, 'utf8')).toBe('original')
  })
})

describe('MemoryBroker scoped deletion', () => {
  it('allows only session tokens and preserves global, workspace, and index files', async () => {
    const { base } = await memoryFixture()
    const globalPath = await writeMemory(base, 'MEMORY.md', 'global')
    const workspacePath = await writeMemory(base, 'repo-deadbeef/MEMORY.md', 'workspace')
    const sessionPath = await writeMemory(base, 'repo-deadbeef/sessions/log.md', 'session')
    const indexPath = await writeMemory(base, 'repo-deadbeef/index.sqlite', 'index')
    const memory = broker(base)
    const summaries = await memory.list()
    const global = summaries.find((entry) => entry.scope === 'global')!
    const workspace = summaries.find((entry) => entry.scope === 'workspace')!
    const session = summaries.find((entry) => entry.scope === 'session')!

    await expect(memory.deleteSession(global.token)).rejects.toMatchObject({ code: 'not-deletable' })
    await expect(memory.deleteSession(workspace.token)).rejects.toMatchObject({ code: 'not-deletable' })
    await expect(memory.deleteSession(session.token)).resolves.toBeUndefined()

    await expect(readFile(sessionPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(globalPath, 'utf8')).toBe('global')
    expect(await readFile(workspacePath, 'utf8')).toBe('workspace')
    expect(await readFile(indexPath, 'utf8')).toBe('index')
  })

  it('fsyncs the bound sessions parent after durable session deletion', async () => {
    const { base } = await memoryFixture()
    const sessionPath = await writeMemory(base, 'repo-deadbeef/sessions/log.md', 'session')
    const synced: string[] = []
    const memory = broker(base, {
      onDirectorySynced: (path) => {
        synced.push(path)
      }
    })
    const [summary] = await memory.list()
    await memory.deleteSession(summary!.token)
    expect(synced).toEqual([await realpath(dirname(sessionPath))])
  })

  it('does not delete a file that was replaced after the token was minted', async () => {
    const { base } = await memoryFixture()
    const path = await writeMemory(base, 'repo-deadbeef/sessions/log.md', 'original')
    const memory = broker(base)
    const [summary] = await memory.list()
    await unlink(path)
    await writeFile(path, 'replacement', { mode: 0o600 })
    await expect(memory.deleteSession(summary!.token)).rejects.toMatchObject({ code: 'changed' })
    expect(await readFile(path, 'utf8')).toBe('replacement')
  })
})

describe('memory shared schemas and pure note builder', () => {
  it('accepts only strict opaque token and note inputs', () => {
    const token = capabilityFactory()()
    expect(memoryTokenInputSchema.parse({ token })).toEqual({ token })
    expect(() => memoryTokenInputSchema.parse({ token, path: '/private/CANARY' })).toThrow()
    expect(rememberMemoryInputSchema.parse({ note: 'remember this' })).toEqual({ note: 'remember this' })
    expect(() => rememberMemoryInputSchema.parse({ note: 'x', path: '/private/CANARY' })).toThrow()
  })

  it('maps the app setting to exactly one Grok 1.0.5 compatibility flag', () => {
    expect(grokMemoryLaunchArgument(true)).toBe('--experimental-memory')
    expect(grokMemoryLaunchArgument(false)).toBe('--no-memory')
  })

  it('adds one Notes heading, reuses it, and inserts before later H2 sections', () => {
    expect(appendMemoryNote('', 'first')).toBe('## Notes\n\n- first\n')
    const existing = '# Memory\n\n## Notes\n\n- old\n\n## Other\n\nkeep\n'
    const result = appendMemoryNote(existing, 'new')
    expect(result.match(/^## Notes$/gmu)).toHaveLength(1)
    expect(result.indexOf('- new')).toBeGreaterThan(result.indexOf('- old'))
    expect(result.indexOf('- new')).toBeLessThan(result.indexOf('## Other'))
    expect(result).toContain('keep')
  })

  it('recognizes an existing Notes heading in CRLF Markdown', () => {
    const existing = '# Memory\r\n\r\n## Notes\r\n\r\n- old\r\n'
    const result = appendMemoryNote(existing, 'new')
    expect(result.match(/## Notes/gu)).toHaveLength(1)
    expect(result).toContain('- old')
    expect(result).toContain('- new')
  })

  it('uses fixed public errors that never contain paths or raw filesystem details', () => {
    for (const code of [
      'unavailable',
      'changed',
      'too-many-files',
      'too-large',
      'invalid-utf8',
      'invalid-token',
      'not-deletable',
      'empty-note',
      'busy'
    ] as const) {
      const error = new MemoryBrokerError(code)
      expect(error.code).toBe(code)
      expect(error.message).not.toContain('/')
      expect(error.message).not.toContain('ENOENT')
    }
  })
})
