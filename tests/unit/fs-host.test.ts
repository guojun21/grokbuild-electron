import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FS_MAX_FILE_BYTES,
  FS_MAX_REQUEST_BYTES,
  FsHost,
  FsHostError,
  sliceTextByLines
} from '../../src/main/acp/FsHost'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('FsHost', () => {
  it('implements the ACP read/write wire, creates parents, and slices 1-based lines', async () => {
    const root = await makeTemporaryDirectory()
    const target = join(root, 'nested', 'wire.txt')
    const host = makeHost()
    const content = 'one\ntwo\nthree\nfour\n'

    await expect(host.handle('fs/write_text_file', {
      sessionId: 'session-1',
      path: target,
      content,
      _meta: { traceId: 'ignored-by-contract' }
    })).resolves.toEqual({})
    await expect(readFile(target, 'utf8')).resolves.toBe(content)

    await expect(host.handle('fs/read_text_file', {
      sessionId: 'session-1',
      path: target,
      line: 2,
      limit: 2,
      _meta: null
    })).resolves.toEqual({ content: 'two\nthree' })

    const parentMode = (await stat(join(root, 'nested'))).mode & 0o777
    const fileMode = (await stat(target)).mode & 0o777
    expect(parentMode & 0o077).toBe(0)
    expect(fileMode).toBe(0o600)
  })

  it('requires the exact sessionId, absolute paths, and strict official fields', async () => {
    const root = await makeTemporaryDirectory()
    const target = join(root, 'strict.txt')
    await writeFile(target, 'strict')
    const host = makeHost()

    await expectFsError(host.readTextFile({
      sessionId: 'different-session',
      path: target
    }), -32602, 'does not match')
    await expectFsError(host.readTextFile({
      sessionId: 'session-1',
      path: 'relative.txt'
    }), -32602, 'absolute path')
    await expectFsError(host.readTextFile({
      sessionId: 'session-1',
      path: target,
      unexpected: true
    }), -32602, 'Unrecognized key')
    await expectFsError(host.readTextFile({
      sessionId: 'session-1',
      path: target,
      line: -1
    }), -32602, 'line')
  })

  it('enforces independent hard request and file byte limits', async () => {
    const root = await makeTemporaryDirectory()
    const target = join(root, 'bounded.txt')
    const fileBoundedHost = makeHost({ maxFileBytes: 4 })

    await expectFsError(fileBoundedHost.writeTextFile({
      sessionId: 'session-1',
      path: target,
      content: 'ééé'
    }), -32602, '4-byte write limit')

    await writeFile(target, '12345')
    await expectFsError(fileBoundedHost.readTextFile({
      sessionId: 'session-1',
      path: target
    }), -32602, '4-byte read limit')

    const requestBoundedHost = makeHost({ maxRequestBytes: 128 })
    await expectFsError(requestBoundedHost.readTextFile({
      sessionId: 'session-1',
      path: target,
      _meta: { padding: 'x'.repeat(512) }
    }), -32602, '128-byte limit')

    expect(() => makeHost({ maxFileBytes: FS_MAX_FILE_BYTES + 1 })).toThrow(FsHostError)
    expect(() => makeHost({ maxRequestBytes: FS_MAX_REQUEST_BYTES + 1 })).toThrow(FsHostError)
  })

  it('accepts only regular final targets and never follows a final symlink', async () => {
    const root = await makeTemporaryDirectory()
    const target = join(root, 'ordinary.txt')
    const linkPath = join(root, 'ordinary-link.txt')
    const directoryPath = join(root, 'directory')
    await writeFile(target, 'ordinary')
    await symlink(target, linkPath)
    await mkdir(directoryPath)
    const host = makeHost()

    await expectFsError(host.readTextFile({
      sessionId: 'session-1',
      path: linkPath
    }), -32602, 'symbolic link')
    await expectFsError(host.writeTextFile({
      sessionId: 'session-1',
      path: linkPath,
      content: 'must-not-follow'
    }), -32602, 'symbolic link')
    await expectFsError(host.readTextFile({
      sessionId: 'session-1',
      path: directoryPath
    }), -32602, 'regular file')
    await expect(readFile(target, 'utf8')).resolves.toBe('ordinary')
  })

  it('strictly decodes UTF-8 and rejects unpaired UTF-16 on writes', async () => {
    const root = await makeTemporaryDirectory()
    const invalidUtf8 = join(root, 'invalid-utf8.txt')
    const target = join(root, 'invalid-surrogate.txt')
    await writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]))
    const host = makeHost()

    await expectFsError(host.readTextFile({
      sessionId: 'session-1',
      path: invalidUtf8
    }), -32603, 'not valid UTF-8')
    await expectFsError(host.writeTextFile({
      sessionId: 'session-1',
      path: target,
      content: '\ud800'
    }), -32602, 'unpaired UTF-16')
  })

  it('atomically replaces existing files while preserving safe mode bits', async () => {
    const root = await makeTemporaryDirectory()
    const existingPath = join(root, 'existing.txt')
    const newPath = join(root, 'new.txt')
    await writeFile(existingPath, 'old')
    await chmod(existingPath, 0o6755)
    const before = await stat(existingPath)
    const host = makeHost()

    await host.writeTextFile({
      sessionId: 'session-1',
      path: existingPath,
      content: 'new-content'
    })
    const after = await stat(existingPath)
    expect(after.ino).not.toBe(before.ino)
    expect(after.mode & 0o7777).toBe(0o755)
    await expect(readFile(existingPath, 'utf8')).resolves.toBe('new-content')

    await host.writeTextFile({
      sessionId: 'session-1',
      path: newPath,
      content: 'new-file'
    })
    expect((await stat(newPath)).mode & 0o777).toBe(0o600)
    expect((await readdir(root)).filter((name) => name.startsWith('.grokbuild-'))).toEqual([])
  })

  it('preserves ACP absolute-path semantics by default and offers explicit root confinement', async () => {
    const root = await makeTemporaryDirectory()
    const allowed = join(root, 'allowed')
    const outside = join(root, 'outside')
    await mkdir(allowed)
    await mkdir(outside)
    const outsideFile = join(outside, 'outside.txt')
    await writeFile(outsideFile, 'outside')

    const unrestricted = makeHost()
    expect(unrestricted.pathPolicy).toBe('absolute-paths')
    await expect(unrestricted.readTextFile({
      sessionId: 'session-1',
      path: outsideFile
    })).resolves.toEqual({ content: 'outside' })

    const exactPlan = join(root, 'grok-session', 'current-session', 'plan.md')
    const confined = makeHost({ allowedRoots: [allowed], allowedFiles: [exactPlan] })
    expect(confined.pathPolicy).toBe('allowlist')
    await expectFsError(confined.readTextFile({
      sessionId: 'session-1',
      path: outsideFile
    }), -32602, 'outside the filesystem allowlist')

    await expect(confined.writeTextFile({
      sessionId: 'session-1',
      path: exactPlan,
      content: '# exact plan'
    })).resolves.toEqual({})
    await expect(readFile(exactPlan, 'utf8')).resolves.toBe('# exact plan')
    await expect(confined.readTextFile({
      sessionId: 'session-1',
      path: exactPlan
    })).resolves.toEqual({ content: '# exact plan' })
    await expectFsError(confined.writeTextFile({
      sessionId: 'session-1',
      path: join(dirname(exactPlan), 'sibling.md'),
      content: 'must stay blocked'
    }), -32602, 'outside the filesystem allowlist')
    await expectFsError(confined.readTextFile({
      sessionId: 'session-1',
      path: join(dirname(exactPlan), 'sibling.md')
    }), -32602, 'outside the filesystem allowlist')

    const escapingDirectoryLink = join(allowed, 'escape')
    const escapedTarget = join(outside, 'must-not-exist.txt')
    await symlink(outside, escapingDirectoryLink)
    await expectFsError(confined.writeTextFile({
      sessionId: 'session-1',
      path: join(escapingDirectoryLink, 'must-not-exist.txt'),
      content: 'blocked'
    }), -32602, 'outside the filesystem allowlist')
    await expect(lstat(escapedTarget)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses only standard JSON-RPC error codes for routing and operation failures', async () => {
    const root = await makeTemporaryDirectory()
    const host = makeHost()

    await expectFsError(host.handle('fs/not_real', {
      sessionId: 'session-1'
    }), -32601, 'Method not found')
    await expectFsError(host.readTextFile({
      sessionId: 'session-1',
      path: join(root, 'missing.txt')
    }), -32603, 'Filesystem read failed')
  })
})

describe('sliceTextByLines', () => {
  it('treats line zero as the documented first line and limit zero as empty', () => {
    expect(sliceTextByLines('a\nb\n', 0, 1)).toBe('a')
    expect(sliceTextByLines('a\nb\n', 2, undefined)).toBe('b\n')
    expect(sliceTextByLines('a\nb\n', undefined, 0)).toBe('')
    expect(sliceTextByLines('a\nb\n', 99, 4)).toBe('')
  })
})

function makeHost(options: Partial<ConstructorParameters<typeof FsHost>[0]> = {}): FsHost {
  return new FsHost({
    sessionId: 'session-1',
    ...options
  })
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'grokbuild-fs-host-'))
  temporaryDirectories.push(directory)
  return directory
}

async function expectFsError(
  promise: Promise<unknown>,
  rpcCode: number,
  message: string
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ rpcCode })
  await expect(promise).rejects.toThrow(message)
}
