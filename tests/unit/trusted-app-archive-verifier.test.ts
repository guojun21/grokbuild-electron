import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TrustedAppArchiveVerifier,
  TrustedAppArchiveVerifyError
} from '../../src/main/updates/TrustedAppArchiveVerifier'

const APP_NAME = 'GrokBuild Electron'
const APP_BUNDLE_NAME = `${APP_NAME}.app`
const BUNDLE_ID = 'com.oasmet.grokbuild-electron'
const VERSION = '0.2.0'
const BUNDLE_VERSION = '200'
const TEAM_ID = 'A1B2C3D4E5'
const DESIGNATED_REQUIREMENT =
  `anchor apple generic and identifier "${BUNDLE_ID}" and certificate leaf[subject.OU] = "${TEAM_ID}"`
const EXECUTABLE = 'GrokBuild Electron'
const ARCHITECTURES = ['arm64', 'x86_64'] as const
const ERROR_CANARY = 'archive-private-canary-746d19'

type VerifierOptions = ConstructorParameters<typeof TrustedAppArchiveVerifier>[0]
type ArchiveRunner = NonNullable<VerifierOptions['runner']>
type ArchiveRunRequest = Parameters<ArchiveRunner['run']>[0]
type ArchiveRunResult = Awaited<ReturnType<ArchiveRunner['run']>>
type ToolFailure = Exclude<ArchiveRunResult['failure'], null>

interface FixtureEntry {
  path: string
  kind: '-' | 'd' | 'l'
  bytes: number
  target?: string
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ))
})

describe('TrustedAppArchiveVerifier', () => {
  it('unpacks one expected app and verifies every fixed macOS trust boundary', async () => {
    const fixture = await stagedFixture()
    const runner = new FixtureRunner()
    const verifier = new TrustedAppArchiveVerifier({ stagingRoot: fixture.root, runner })

    const verified = await verifier.verify(request(fixture.archivePath))

    expect(verified).toEqual({
      directory: expect.stringContaining('grokbuild-verify-'),
      appPath: join(verified.directory, APP_BUNDLE_NAME),
      appName: APP_NAME,
      bundleId: BUNDLE_ID,
      version: VERSION,
      teamId: TEAM_ID
    })
    expect(runner.requests.map((item) => item.executable)).toEqual([
      '/usr/bin/zipinfo',
      '/usr/bin/zipinfo',
      '/usr/bin/unzip',
      '/usr/bin/ditto',
      '/usr/bin/codesign',
      '/usr/bin/codesign',
      '/usr/bin/codesign',
      '/usr/sbin/spctl',
      '/usr/bin/xcrun',
      '/usr/bin/plutil',
      '/usr/bin/plutil',
      '/usr/bin/plutil',
      '/usr/bin/plutil',
      '/usr/bin/plutil',
      '/usr/bin/lipo'
    ])
    expect(runner.requests[0]?.args).toEqual(['-1', fixture.archivePath])
    expect(runner.requests[1]?.args).toEqual(['-l', fixture.archivePath])
    expect(runner.requests[3]?.args.slice(0, 3)).toEqual(['-x', '-k', fixture.archivePath])
    expect(runner.requests[4]?.args.slice(0, 4)).toEqual([
      '--verify', '--deep', '--strict', '--verbose=2'
    ])
    expect(runner.requests[5]?.args).toEqual([
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      '-R',
      `=${DESIGNATED_REQUIREMENT}`,
      verified.appPath
    ])
    expect(runner.requests[6]?.args).toEqual(['-d', '--verbose=4', verified.appPath])
    expect(runner.requests[7]?.args.slice(0, 5)).toEqual(['-a', '-vv', '-t', 'exec', verified.appPath])
    expect(runner.requests[8]?.args).toEqual(['stapler', 'validate', verified.appPath])
    expect(runner.requests[14]?.args).toEqual([
      '-archs',
      join(verified.appPath, 'Contents', 'MacOS', EXECUTABLE)
    ])
    expect(Object.getOwnPropertyNames(TrustedAppArchiveVerifier.prototype)).not.toContain('run')

    await verifier.discard(verified)
    expect(await readdir(fixture.root)).toEqual([basename(fixture.directory)])
  })

  it.each([
    '../escape.app/payload',
    '/private/tmp/escape.app/payload',
    `${APP_BUNDLE_NAME}\\Contents\\payload`,
    `${APP_BUNDLE_NAME}/Contents/../escape`,
    `${APP_BUNDLE_NAME}/Contents/evil\0payload`
  ])('rejects traversal or ambiguous ZIP entry %j before extraction', async (maliciousPath) => {
    const fixture = await stagedFixture()
    const runner = new FixtureRunner({
      entries: [...defaultEntries(), { path: maliciousPath, kind: '-', bytes: 1 }]
    })
    const verifier = new TrustedAppArchiveVerifier({ stagingRoot: fixture.root, runner })

    await expect(verifier.verify(request(fixture.archivePath))).rejects.toMatchObject({
      code: 'unsafe-archive',
      operation: 'archive-list'
    })
    expect(runner.requests.some((item) => item.executable === '/usr/bin/ditto')).toBe(false)
  })

  it('rejects excessive entry counts and total uncompressed size before extraction', async () => {
    const fixture = await stagedFixture()
    const entries = defaultEntries()

    await expect(new TrustedAppArchiveVerifier({
      stagingRoot: fixture.root,
      runner: new FixtureRunner({ entries }),
      maxEntries: entries.length - 1
    }).verify(request(fixture.archivePath))).rejects.toMatchObject({
      code: 'archive-too-large',
      operation: 'archive-list'
    })

    await expect(new TrustedAppArchiveVerifier({
      stagingRoot: fixture.root,
      runner: new FixtureRunner({ entries }),
      maxUncompressedBytes: 5
    }).verify(request(fixture.archivePath))).rejects.toMatchObject({
      code: 'archive-too-large',
      operation: 'archive-list'
    })
  })

  it('rejects a second top-level bundle and a symlink target that escapes the expected app', async () => {
    const fixture = await stagedFixture()
    const secondBundle = new FixtureRunner({
      entries: [...defaultEntries(), { path: 'Replacement.app/', kind: 'd', bytes: 0 }]
    })
    await expect(new TrustedAppArchiveVerifier({
      stagingRoot: fixture.root,
      runner: secondBundle
    }).verify(request(fixture.archivePath))).rejects.toMatchObject({ code: 'unsafe-archive' })
    expect(secondBundle.requests.some((item) => item.executable === '/usr/bin/ditto')).toBe(false)

    const symlinkEscapeEntries = defaultEntries().map((entry) =>
      entry.kind === 'l' ? { ...entry, target: '../../../outside' } : entry
    )
    const symlinkEscape = new FixtureRunner({ entries: symlinkEscapeEntries })
    await expect(new TrustedAppArchiveVerifier({
      stagingRoot: fixture.root,
      runner: symlinkEscape
    }).verify(request(fixture.archivePath))).rejects.toMatchObject({ code: 'unsafe-archive' })
    expect(symlinkEscape.requests.some((item) => item.executable === '/usr/bin/ditto')).toBe(false)
  })

  it.each([
    [{ bundleId: 'com.attacker.replacement' }, 'identity-mismatch'],
    [{ teamId: 'Z9Y8X7W6V5' }, 'identity-mismatch'],
    [{ plistBundleId: 'com.attacker.replacement' }, 'metadata-mismatch'],
    [{ version: '9.9.9' }, 'metadata-mismatch'],
    [{ bundleVersion: '201' }, 'metadata-mismatch']
  ] as const)('rejects wrong signed identity or plist metadata %#', async (overrides, code) => {
    const fixture = await stagedFixture()
    const runner = new FixtureRunner(overrides)
    const verifier = new TrustedAppArchiveVerifier({ stagingRoot: fixture.root, runner })

    await expect(verifier.verify(request(fixture.archivePath))).rejects.toMatchObject({ code })
    expect(await readdir(fixture.root)).toEqual([basename(fixture.directory)])
  })

  it('rejects a candidate that does not satisfy the current designated requirement', async () => {
    const fixture = await stagedFixture()
    const runner = new FixtureRunner({
      designatedRequirement: 'identifier "com.attacker.replacement" and anchor apple'
    })
    const verifier = new TrustedAppArchiveVerifier({ stagingRoot: fixture.root, runner })

    await expect(verifier.verify(request(fixture.archivePath))).rejects.toMatchObject({
      code: 'signature-invalid',
      operation: 'signature'
    })
    const requirementRequest = runner.requests.find((item) => item.args.includes('-R'))
    expect(requirementRequest?.args[5]).toBe(`=${DESIGNATED_REQUIREMENT}`)
    expect(requirementRequest?.args).toHaveLength(7)
    expect(await readdir(fixture.root)).toEqual([basename(fixture.directory)])
  })

  it.each([
    ['missing runtime', { runtime: false }],
    ['missing timestamp', { timestamps: [] }],
    ['none timestamp', { timestamps: ['none'] }],
    ['duplicate timestamp', {
      timestamps: ['Aug 25, 2026 at 09:00:00', 'Aug 25, 2026 at 09:00:01']
    }],
    ['missing Developer ID Application authority', {
      authorities: ['Developer ID Certification Authority', 'Apple Root CA']
    }],
    ['duplicate Developer ID Application authority', {
      authorities: [
        `Developer ID Application: GrokBuild (${TEAM_ID})`,
        `Developer ID Application: GrokBuild Backup (${TEAM_ID})`,
        'Developer ID Certification Authority',
        'Apple Root CA'
      ]
    }],
    ['wrong Developer ID Application team', { authorityTeamId: 'Z9Y8X7W6V5' }]
  ] as const)('rejects a distribution signature with %s', async (_label, overrides) => {
    const fixture = await stagedFixture()
    const runner = new FixtureRunner(overrides)
    const verifier = new TrustedAppArchiveVerifier({ stagingRoot: fixture.root, runner })

    await expect(verifier.verify(request(fixture.archivePath))).rejects.toMatchObject({
      code: 'signature-invalid',
      operation: 'signature'
    })
    expect(await readdir(fixture.root)).toEqual([basename(fixture.directory)])
  })

  it('requires the lipo architecture set to exactly match the trusted allowlist', async () => {
    const fixture = await stagedFixture()

    await expect(new TrustedAppArchiveVerifier({
      stagingRoot: fixture.root,
      runner: new FixtureRunner({ architectures: ['arm64'] })
    }).verify(request(fixture.archivePath))).rejects.toMatchObject({
      code: 'metadata-mismatch',
      operation: 'metadata'
    })

    await expect(new TrustedAppArchiveVerifier({
      stagingRoot: fixture.root,
      runner: new FixtureRunner({ architectures: ['arm64', 'i386'] })
    }).verify(request(fixture.archivePath))).rejects.toMatchObject({
      code: 'metadata-mismatch',
      operation: 'metadata'
    })
  })

  it.each(['timeout', 'output-limit'] as const)(
    'maps injected %s failures to fixed errors and removes the extracted bundle',
    async (failure) => {
      const fixture = await stagedFixture()
      const runner = new FixtureRunner({ toolFailure: failure })
      const verifier = new TrustedAppArchiveVerifier({ stagingRoot: fixture.root, runner })

      const error = await rejection(verifier.verify(request(fixture.archivePath)))
      expect(error).toMatchObject({ code: failure, operation: 'signature' })
      expect(serializeError(error)).not.toContain(fixture.root)
      expect(await readdir(fixture.root)).toEqual([basename(fixture.directory)])
    }
  )

  it('never exposes raw output, the designated requirement, argv, or paths in errors', async () => {
    const fixture = await stagedFixture()
    const privateRequirement = `${DESIGNATED_REQUIREMENT} and info[Canary] = "${ERROR_CANARY}"`
    const runner = new FixtureRunner({ directRequirementFailureCanary: ERROR_CANARY })
    const verifier = new TrustedAppArchiveVerifier({ stagingRoot: fixture.root, runner })

    const error = await rejection(verifier.verify({
      ...request(fixture.archivePath),
      expectedDesignatedRequirement: privateRequirement
    }))
    expect(error).toBeInstanceOf(TrustedAppArchiveVerifyError)
    expect(error).toMatchObject({ code: 'signature-invalid', operation: 'signature' })
    expect(String(error)).toBe(
      'TrustedAppArchiveVerifyError: The app update signature is invalid.'
    )
    expect(serializeError(error)).not.toContain(ERROR_CANARY)
    expect(serializeError(error)).not.toContain(privateRequirement)
    expect(serializeError(error)).not.toContain(fixture.root)
    expect(await readdir(fixture.root)).toEqual([basename(fixture.directory)])
  })

  it('rejects non-internal archives and invalid expected identities before any tool runs', async () => {
    const fixture = await stagedFixture()
    const runner = new FixtureRunner()
    const verifier = new TrustedAppArchiveVerifier({ stagingRoot: fixture.root, runner })

    await expect(verifier.verify(request(join(fixture.root, 'outside.zip')))).rejects.toMatchObject({
      code: 'invalid-request',
      operation: 'request'
    })
    await expect(verifier.verify({
      ...request(fixture.archivePath),
      expectedTeamId: 'not-a-team'
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(verifier.verify({
      ...request(fixture.archivePath),
      expectedBundleVersion: 'bad\nbuild'
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(verifier.verify({
      ...request(fixture.archivePath),
      expectedDesignatedRequirement: `=${DESIGNATED_REQUIREMENT}`
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(verifier.verify({
      ...request(fixture.archivePath),
      expectedArchitectures: ['arm64', 'arm64']
    })).rejects.toMatchObject({ code: 'invalid-request' })
    expect(runner.requests).toEqual([])
  })
})

class FixtureRunner implements ArchiveRunner {
  readonly requests: ArchiveRunRequest[] = []
  private readonly entries: FixtureEntry[]
  private readonly bundleId: string
  private readonly plistBundleId: string
  private readonly teamId: string
  private readonly version: string
  private readonly bundleVersion: string
  private readonly executable: string
  private readonly designatedRequirement: string
  private readonly runtime: boolean
  private readonly timestamps: readonly string[]
  private readonly authorities: readonly string[]
  private readonly architectures: readonly string[]
  private readonly toolFailure: ToolFailure | undefined
  private readonly directRequirementFailureCanary: string | undefined

  constructor(options: {
    entries?: readonly FixtureEntry[]
    bundleId?: string
    plistBundleId?: string
    teamId?: string
    version?: string
    bundleVersion?: string
    executable?: string
    designatedRequirement?: string
    runtime?: boolean
    timestamps?: readonly string[]
    authorities?: readonly string[]
    authorityTeamId?: string
    architectures?: readonly string[]
    toolFailure?: ToolFailure
    directRequirementFailureCanary?: string
  } = {}) {
    this.entries = [...(options.entries ?? defaultEntries())]
    this.bundleId = options.bundleId ?? BUNDLE_ID
    this.plistBundleId = options.plistBundleId ?? BUNDLE_ID
    this.teamId = options.teamId ?? TEAM_ID
    this.version = options.version ?? VERSION
    this.bundleVersion = options.bundleVersion ?? BUNDLE_VERSION
    this.executable = options.executable ?? EXECUTABLE
    this.designatedRequirement = options.designatedRequirement ?? DESIGNATED_REQUIREMENT
    this.runtime = options.runtime ?? true
    this.timestamps = options.timestamps ?? ['Aug 25, 2026 at 09:00:00']
    const authorityTeamId = options.authorityTeamId ?? this.teamId
    this.authorities = options.authorities ?? [
      `Developer ID Application: GrokBuild (${authorityTeamId})`,
      'Developer ID Certification Authority',
      'Apple Root CA'
    ]
    this.architectures = options.architectures ?? ARCHITECTURES
    this.toolFailure = options.toolFailure
    this.directRequirementFailureCanary = options.directRequirementFailureCanary
  }

  async run(tool: ArchiveRunRequest): Promise<ArchiveRunResult> {
    this.requests.push(tool)
    if (tool.executable === '/usr/bin/zipinfo' && tool.args[0] === '-1') {
      return ok(`${this.entries.map((entry) => entry.path).join('\n')}\n`)
    }
    if (tool.executable === '/usr/bin/zipinfo' && tool.args[0] === '-l') {
      return ok(longListing(this.entries))
    }
    if (tool.executable === '/usr/bin/unzip') {
      const entry = this.entries.find((candidate) => candidate.path === tool.args[2])
      return entry?.kind === 'l' && entry.target !== undefined
        ? ok(entry.target)
        : failed(2, 'missing archive entry')
    }
    if (tool.executable === '/usr/bin/ditto') {
      const destination = tool.args[3]
      if (!destination) return failed(2, 'missing destination')
      await extractFixture(destination, this.entries)
      return ok()
    }
    if (
      tool.executable === '/usr/bin/codesign' && tool.args[0] === '--verify' &&
      this.toolFailure !== undefined
    ) {
      return processFailure(this.toolFailure)
    }
    if (tool.executable === '/usr/bin/codesign' && tool.args.includes('-R')) {
      if (this.directRequirementFailureCanary !== undefined) {
        const privateOutput = `${this.directRequirementFailureCanary} ${tool.args.join(' ')}`
        return failed(1, privateOutput, privateOutput)
      }
      const requirementIndex = tool.args.indexOf('-R') + 1
      return tool.args[requirementIndex] === `=${this.designatedRequirement}`
        ? ok()
        : failed(1, 'candidate did not satisfy the explicit requirement')
    }
    if (tool.executable === '/usr/bin/codesign' && tool.args[0] === '-d') {
      const flags = this.runtime ? '0x10000(runtime) count=5 size=64' : '0x0(none) count=5 size=64'
      const detail = [
        `Identifier=${this.bundleId}`,
        `TeamIdentifier=${this.teamId}`,
        `flags=${flags}`,
        ...this.timestamps.map((timestamp) => `Timestamp=${timestamp}`),
        ...this.authorities.map((authority) => `Authority=${authority}`)
      ]
      return ok('', `${detail.join('\n')}\n`)
    }
    if (tool.executable === '/usr/bin/plutil') {
      const value = tool.args[1] === 'CFBundleIdentifier'
        ? this.plistBundleId
        : tool.args[1] === 'CFBundleShortVersionString'
          ? this.version
          : tool.args[1] === 'CFBundleVersion'
            ? this.bundleVersion
            : tool.args[1] === 'CFBundleExecutable'
              ? this.executable
              : APP_NAME
      return ok(`${value}\n`)
    }
    if (tool.executable === '/usr/bin/lipo') {
      return ok(`${this.architectures.join(' ')}\n`)
    }
    return ok()
  }
}

function defaultEntries(): FixtureEntry[] {
  return [
    { path: `${APP_BUNDLE_NAME}/`, kind: 'd', bytes: 0 },
    { path: `${APP_BUNDLE_NAME}/Contents/`, kind: 'd', bytes: 0 },
    { path: `${APP_BUNDLE_NAME}/Contents/Info.plist`, kind: '-', bytes: 5 },
    { path: `${APP_BUNDLE_NAME}/Contents/Versions/`, kind: 'd', bytes: 0 },
    { path: `${APP_BUNDLE_NAME}/Contents/Versions/A/`, kind: 'd', bytes: 0 },
    {
      path: `${APP_BUNDLE_NAME}/Contents/Versions/Current`,
      kind: 'l',
      bytes: 1,
      target: 'A'
    },
    { path: '__MACOSX/', kind: 'd', bytes: 0 },
    { path: `__MACOSX/${APP_BUNDLE_NAME}/`, kind: 'd', bytes: 0 },
    { path: `__MACOSX/${APP_BUNDLE_NAME}/Contents/`, kind: 'd', bytes: 0 },
    { path: `__MACOSX/${APP_BUNDLE_NAME}/Contents/._Info.plist`, kind: '-', bytes: 2 }
  ]
}

function longListing(entries: readonly FixtureEntry[]): string {
  const uncompressed = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const records = entries.map((entry) => {
    const permissions = entry.kind === 'd'
      ? 'drwxr-xr-x'
      : entry.kind === 'l'
        ? 'lrwxr-xr-x'
        : '-rw-r--r--'
    return `${permissions}  2.1 unx ${entry.bytes} b- ${entry.bytes} stor 26-Aug-25 03:47 ${entry.path}`
  })
  return [
    'Archive:  internal-stage/update.app.zip',
    `Zip file size: 1024 bytes, number of entries: ${entries.length}`,
    ...records,
    `${entries.length} files, ${uncompressed} bytes uncompressed, ${uncompressed} bytes compressed:  0.0%`,
    ''
  ].join('\n')
}

async function extractFixture(
  destination: string,
  entries: readonly FixtureEntry[]
): Promise<void> {
  const hasExpectedRoot = entries.some((entry) => entry.path === `${APP_BUNDLE_NAME}/`)
  if (!hasExpectedRoot) return
  const versions = join(destination, APP_BUNDLE_NAME, 'Contents', 'Versions')
  await mkdir(join(versions, 'A'), { recursive: true })
  await writeFile(join(destination, APP_BUNDLE_NAME, 'Contents', 'Info.plist'), 'plist', {
    mode: 0o600
  })
  if (entries.some((entry) => entry.path.endsWith('/Versions/Current') && entry.kind === 'l')) {
    await symlink('A', join(versions, 'Current'))
  }
}

async function stagedFixture(): Promise<{
  root: string
  directory: string
  archivePath: string
}> {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'grokbuild-verify-test-')))
  temporaryRoots.push(root)
  const directory = await mkdtemp(join(root, 'grokbuild-update-'))
  const archivePath = join(directory, 'update.app.zip')
  await writeFile(archivePath, 'inert archive fixture', { mode: 0o600 })
  return { root, directory, archivePath }
}

function request(archivePath: string) {
  return {
    archivePath,
    expectedBundleId: BUNDLE_ID,
    expectedVersion: VERSION,
    expectedBundleVersion: BUNDLE_VERSION,
    expectedAppName: APP_NAME,
    expectedTeamId: TEAM_ID,
    expectedDesignatedRequirement: DESIGNATED_REQUIREMENT,
    expectedArchitectures: ARCHITECTURES
  }
}

function ok(stdout = '', stderr = ''): ArchiveRunResult {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode: 0,
    signal: null,
    failure: null
  }
}

function failed(exitCode: number, stderr: string, stdout = ''): ArchiveRunResult {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
    signal: null,
    failure: null
  }
}

function processFailure(failure: ToolFailure): ArchiveRunResult {
  return {
    stdout: Buffer.from(ERROR_CANARY),
    stderr: Buffer.from(ERROR_CANARY),
    exitCode: null,
    signal: null,
    failure
  }
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
