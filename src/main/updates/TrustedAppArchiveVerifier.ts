import { spawn, type ChildProcess } from 'node:child_process'
import type { Stats } from 'node:fs'
import {
  chmod,
  lstat,
  mkdtemp,
  readlink,
  readdir,
  realpath,
  rm,
  stat
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep
} from 'node:path'

const ZIPINFO_PATH = '/usr/bin/zipinfo'
const UNZIP_PATH = '/usr/bin/unzip'
const DITTO_PATH = '/usr/bin/ditto'
const CODESIGN_PATH = '/usr/bin/codesign'
const SPCTL_PATH = '/usr/sbin/spctl'
const XCRUN_PATH = '/usr/bin/xcrun'
const PLUTIL_PATH = '/usr/bin/plutil'
const LIPO_PATH = '/usr/bin/lipo'

const STAGED_ARCHIVE_NAME = 'update.app.zip'
const STAGED_DIRECTORY_PREFIX = 'grokbuild-update-'
const VERIFIED_DIRECTORY_PREFIX = 'grokbuild-verify-'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_TERMINATE_GRACE_MS = 250
const DEFAULT_MAX_ENTRIES = 50_000
const DEFAULT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
const MAX_PATH_BYTES = 4_096
const MAX_PATH_DEPTH = 64
const MAX_SYMLINK_TARGET_BYTES = 4_096
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024
const MAX_DESIGNATED_REQUIREMENT_BYTES = 16 * 1024

export type TrustedAppArchitecture = 'arm64' | 'x86_64'

const ALLOWED_ARCHITECTURES: ReadonlySet<string> = new Set<TrustedAppArchitecture>([
  'arm64',
  'x86_64'
])

export type TrustedAppArchiveVerifyOperation =
  | 'request'
  | 'archive-list'
  | 'extract'
  | 'signature'
  | 'identity'
  | 'gatekeeper'
  | 'notarization'
  | 'metadata'
  | 'cleanup'

export type TrustedAppArchiveVerifyErrorCode =
  | 'invalid-request'
  | 'archive-unavailable'
  | 'unsafe-archive'
  | 'archive-too-large'
  | 'extraction-failed'
  | 'signature-invalid'
  | 'identity-mismatch'
  | 'gatekeeper-rejected'
  | 'notarization-invalid'
  | 'metadata-mismatch'
  | 'tool-unavailable'
  | 'timeout'
  | 'output-limit'
  | 'cleanup-failed'

export class TrustedAppArchiveVerifyError extends Error {
  constructor(
    readonly code: TrustedAppArchiveVerifyErrorCode,
    readonly operation: TrustedAppArchiveVerifyOperation
  ) {
    super(publicErrorMessage(code))
    this.name = 'TrustedAppArchiveVerifyError'
  }
}

export interface TrustedAppArchiveVerifyRequest {
  /** Canonical internal path returned by TrustedUpdateStager. */
  archivePath: string
  expectedBundleId: string
  expectedVersion: string
  expectedBundleVersion: string
  /** Bundle directory stem and CFBundleName, without the .app suffix. */
  expectedAppName: string
  expectedTeamId: string
  /** Current app DR expression, without the `designated =>` or leading `=` prefix. */
  expectedDesignatedRequirement: string
  expectedArchitectures: readonly TrustedAppArchitecture[]
}

export interface VerifiedAppArchive {
  directory: string
  appPath: string
  appName: string
  bundleId: string
  version: string
  teamId: string
}

type ArchiveToolFailure = 'spawn' | 'timeout' | 'output-limit'

interface ArchiveToolRunRequest {
  executable: string
  args: readonly string[]
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  terminateGraceMs: number
}

interface ArchiveToolRunResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number | null
  signal: NodeJS.Signals | null
  failure: ArchiveToolFailure | null
}

interface ArchiveToolRunner {
  run(request: ArchiveToolRunRequest): Promise<ArchiveToolRunResult>
}

export interface TrustedAppArchiveVerifierOptions {
  stagingRoot: string
  /** Main-only deterministic test seam. Executables and argv remain fixed here. */
  runner?: ArchiveToolRunner | undefined
  timeoutMs?: number | undefined
  maxOutputBytes?: number | undefined
  terminateGraceMs?: number | undefined
  maxEntries?: number | undefined
  maxArchiveBytes?: number | undefined
  maxUncompressedBytes?: number | undefined
}

interface ProcessLimits {
  timeoutMs: number
  maxOutputBytes: number
  terminateGraceMs: number
}

interface ArchiveContext extends ProcessLimits {
  cwd: string
  runner: ArchiveToolRunner
}

interface ExpectedIdentity {
  appName: string
  appBundleName: string
  bundleId: string
  version: string
  bundleVersion: string
  teamId: string
  designatedRequirement: string
  architectures: readonly TrustedAppArchitecture[]
}

interface ArchiveEntry {
  path: string
  kind: '-' | 'd' | 'l'
  uncompressedBytes: number
}

interface ArchiveManifest {
  symlinkTargets: Map<string, string>
}

/**
 * Main-only trust boundary for an inert, already SHA-256-checked update asset.
 * This class lists, extracts, and verifies one app bundle. It never installs,
 * swaps, launches, or restarts the application.
 */
export class TrustedAppArchiveVerifier {
  private readonly runner: ArchiveToolRunner
  private readonly limits: ProcessLimits
  private readonly maxEntries: number
  private readonly maxArchiveBytes: number
  private readonly maxUncompressedBytes: number
  private readonly ownedDirectories = new Set<string>()

  constructor(private readonly options: TrustedAppArchiveVerifierOptions) {
    this.runner = options.runner ?? new NodeArchiveToolRunner()
    this.limits = {
      timeoutMs: boundedInteger(
        options.timeoutMs,
        DEFAULT_TIMEOUT_MS,
        50,
        MAX_TIMEOUT_MS,
        'timeoutMs'
      ),
      maxOutputBytes: boundedInteger(
        options.maxOutputBytes,
        DEFAULT_MAX_OUTPUT_BYTES,
        64,
        MAX_OUTPUT_BYTES,
        'maxOutputBytes'
      ),
      terminateGraceMs: boundedInteger(
        options.terminateGraceMs,
        DEFAULT_TERMINATE_GRACE_MS,
        10,
        10_000,
        'terminateGraceMs'
      )
    }
    this.maxEntries = boundedInteger(
      options.maxEntries,
      DEFAULT_MAX_ENTRIES,
      1,
      MAX_ARCHIVE_ENTRIES,
      'maxEntries'
    )
    this.maxArchiveBytes = boundedInteger(
      options.maxArchiveBytes,
      DEFAULT_MAX_ARCHIVE_BYTES,
      1,
      MAX_ARCHIVE_BYTES,
      'maxArchiveBytes'
    )
    this.maxUncompressedBytes = boundedInteger(
      options.maxUncompressedBytes,
      DEFAULT_MAX_UNCOMPRESSED_BYTES,
      1,
      MAX_UNCOMPRESSED_BYTES,
      'maxUncompressedBytes'
    )
  }

  async verify(request: TrustedAppArchiveVerifyRequest): Promise<VerifiedAppArchive> {
    const expected = validateExpectedIdentity(request)
    const root = await canonicalExistingStagingRoot(this.options.stagingRoot)
    const archivePath = await validateStagedArchive(
      request.archivePath,
      root,
      this.maxArchiveBytes
    )
    const context: ArchiveContext = { cwd: root, runner: this.runner, ...this.limits }
    const manifest = await readArchiveManifest(
      context,
      archivePath,
      expected.appBundleName,
      this.maxEntries,
      this.maxUncompressedBytes
    )
    const extractionDirectory = await this.createOwnedDirectory(root)

    try {
      await runChecked(
        context,
        DITTO_PATH,
        ['-x', '-k', archivePath, extractionDirectory],
        'extract',
        'extraction-failed'
      )
      const appPath = await validateExtractedApplication(
        extractionDirectory,
        expected.appBundleName,
        manifest,
        this.maxEntries,
        this.maxUncompressedBytes
      )
      await verifyApplicationTrust(context, appPath, expected)
      return {
        directory: extractionDirectory,
        appPath,
        appName: expected.appName,
        bundleId: expected.bundleId,
        version: expected.version,
        teamId: expected.teamId
      }
    } catch (error) {
      await this.removeOwnedDirectory(extractionDirectory).catch(() => undefined)
      if (error instanceof TrustedAppArchiveVerifyError) throw error
      throw new TrustedAppArchiveVerifyError('unsafe-archive', 'extract')
    }
  }

  async discard(verified: VerifiedAppArchive): Promise<void> {
    await this.removeOwnedDirectory(verified.directory)
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.ownedDirectories].map(async (directory) => {
      await this.removeOwnedDirectory(directory)
    }))
  }

  private async createOwnedDirectory(root: string): Promise<string> {
    let directory: string | undefined
    try {
      directory = await mkdtemp(join(root, VERIFIED_DIRECTORY_PREFIX))
      this.ownedDirectories.add(directory)
      await chmod(directory, 0o700)
      return directory
    } catch {
      if (directory) {
        this.ownedDirectories.delete(directory)
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      }
      throw new TrustedAppArchiveVerifyError('extraction-failed', 'extract')
    }
  }

  private async removeOwnedDirectory(directory: string): Promise<void> {
    if (!this.ownedDirectories.has(directory)) return
    try {
      await rm(directory, { recursive: true, force: true })
      this.ownedDirectories.delete(directory)
    } catch {
      throw new TrustedAppArchiveVerifyError('cleanup-failed', 'cleanup')
    }
  }
}

class NodeArchiveToolRunner implements ArchiveToolRunner {
  async run(request: ArchiveToolRunRequest): Promise<ArchiveToolRunResult> {
    return await new Promise<ArchiveToolRunResult>((resolveResult) => {
      let child: ChildProcess
      try {
        child = spawn(request.executable, [...request.args], {
          cwd: request.cwd,
          detached: process.platform !== 'win32',
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: safeToolEnvironment()
        })
      } catch {
        resolveResult(failedRun('spawn'))
        return
      }

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let settled = false
      let failure: Extract<ArchiveToolFailure, 'timeout' | 'output-limit'> | undefined
      let killTimer: NodeJS.Timeout | undefined
      let failSafeTimer: NodeJS.Timeout | undefined
      const timeout = setTimeout(() => beginTermination('timeout'), request.timeoutMs)

      const clearTimers = (): void => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        if (failSafeTimer) clearTimeout(failSafeTimer)
      }

      const settle = (result: ArchiveToolRunResult): void => {
        if (settled) return
        settled = true
        clearTimers()
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolveResult(result)
      }

      const capture = (destination: Buffer[], chunk: unknown): void => {
        if (settled || failure) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        if (outputBytes + bytes.length > request.maxOutputBytes) {
          beginTermination('output-limit')
          return
        }
        outputBytes += bytes.length
        destination.push(bytes)
      }

      function beginTermination(
        reason: Extract<ArchiveToolFailure, 'timeout' | 'output-limit'>
      ): void {
        if (settled || failure) return
        failure = reason
        signalProcessTree(child, 'SIGTERM')
        killTimer = setTimeout(
          () => signalProcessTree(child, 'SIGKILL'),
          request.terminateGraceMs
        )
        failSafeTimer = setTimeout(
          () => settle(failedRun(reason)),
          request.terminateGraceMs * 3
        )
      }

      child.stdout?.on('data', (chunk: unknown) => capture(stdout, chunk))
      child.stderr?.on('data', (chunk: unknown) => capture(stderr, chunk))
      child.once('error', () => settle(failedRun('spawn')))
      child.once('close', (exitCode, signal) => {
        if (failure) {
          settle(failedRun(failure))
          return
        }
        settle({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode,
          signal,
          failure: null
        })
      })
    })
  }
}

async function readArchiveManifest(
  context: ArchiveContext,
  archivePath: string,
  expectedAppBundleName: string,
  maxEntries: number,
  maxUncompressedBytes: number
): Promise<ArchiveManifest> {
  const [namesResult, longResult] = await Promise.all([
    runChecked(
      context,
      ZIPINFO_PATH,
      ['-1', archivePath],
      'archive-list',
      'unsafe-archive'
    ),
    runChecked(
      context,
      ZIPINFO_PATH,
      ['-l', archivePath],
      'archive-list',
      'unsafe-archive'
    )
  ])
  const names = parseZipNames(decodeToolOutput(namesResult.stdout, 'archive-list'))
  const records = parseZipLongListing(
    decodeToolOutput(longResult.stdout, 'archive-list'),
    maxEntries,
    maxUncompressedBytes
  )
  if (names.length !== records.length) unsafeArchive()
  for (let index = 0; index < names.length; index += 1) {
    if (records[index]?.path !== names[index]) unsafeArchive()
  }
  validateArchiveEntries(records, expectedAppBundleName)

  const symlinkTargets = new Map<string, string>()
  for (const entry of records) {
    if (entry.kind !== 'l') continue
    if (/[*?\[\]]/.test(entry.path) || entry.uncompressedBytes > MAX_SYMLINK_TARGET_BYTES) {
      unsafeArchive()
    }
    const result = await runChecked(
      context,
      UNZIP_PATH,
      ['-p', archivePath, entry.path],
      'archive-list',
      'unsafe-archive',
      Math.min(context.maxOutputBytes, MAX_SYMLINK_TARGET_BYTES + 1)
    )
    if (result.stdout.byteLength !== entry.uncompressedBytes) unsafeArchive()
    const target = decodeToolOutput(result.stdout, 'archive-list')
    validateSymlinkTarget(entry.path, target, expectedAppBundleName)
    symlinkTargets.set(entry.path, target)
  }
  for (const symlinkPath of symlinkTargets.keys()) {
    const prefix = `${symlinkPath}/`
    if (records.some((entry) => entry.path.startsWith(prefix))) unsafeArchive()
  }
  return { symlinkTargets }
}

function parseZipNames(output: string): string[] {
  if (!output || output.includes('\0') || output.includes('\r')) unsafeArchive()
  const normalized = output.endsWith('\n') ? output.slice(0, -1) : output
  const names = normalized.split('\n')
  if (names.length === 0 || names.some((name) => !name)) unsafeArchive()
  return names
}

function parseZipLongListing(
  output: string,
  maxEntries: number,
  maxUncompressedBytes: number
): ArchiveEntry[] {
  if (!output || output.includes('\0') || output.includes('\r')) unsafeArchive()
  const lines = output.endsWith('\n') ? output.slice(0, -1).split('\n') : output.split('\n')
  const headerIndex = lines.findIndex((line) => line.startsWith('Zip file size: '))
  if (headerIndex < 1 || headerIndex !== lines.lastIndexOf(lines[headerIndex]!)) unsafeArchive()
  const header = /^Zip file size: (\d+) bytes, number of entries: (\d+)$/.exec(lines[headerIndex]!)
  const summaryIndex = lines.length - 1
  const summary = /^(\d+) files?, (\d+) bytes uncompressed, (\d+) bytes compressed:\s+-?[0-9.]+%$/.exec(
    lines[summaryIndex] ?? ''
  )
  if (!header || !summary || summaryIndex <= headerIndex) unsafeArchive()
  const headerCount = safeUnsignedInteger(header[2])
  const summaryCount = safeUnsignedInteger(summary[1])
  const summaryUncompressed = safeUnsignedInteger(summary[2])
  const summaryCompressed = safeUnsignedInteger(summary[3])
  if (
    headerCount === undefined || summaryCount === undefined ||
    summaryUncompressed === undefined || summaryCompressed === undefined
  ) unsafeArchive()
  if (summaryCount > maxEntries || summaryUncompressed > maxUncompressedBytes) {
    throw new TrustedAppArchiveVerifyError('archive-too-large', 'archive-list')
  }

  const records: ArchiveEntry[] = []
  let uncompressedBytes = 0
  let compressedBytes = 0
  for (const line of lines.slice(headerIndex + 1, summaryIndex)) {
    const match = /^(\S+)\s+\S+\s+\S+\s+(\d+)\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line)
    if (!match) unsafeArchive()
    const kind = match[1]?.[0]
    if (kind !== '-' && kind !== 'd' && kind !== 'l') unsafeArchive()
    const entryBytes = safeUnsignedInteger(match[2])
    const entryCompressedBytes = safeUnsignedInteger(match[3])
    if (entryBytes === undefined || entryCompressedBytes === undefined) unsafeArchive()
    uncompressedBytes = safeAdd(uncompressedBytes, entryBytes)
    compressedBytes = safeAdd(compressedBytes, entryCompressedBytes)
    records.push({
      path: match[4]!,
      kind,
      uncompressedBytes: entryBytes
    })
  }
  if (
    records.length === 0 || records.length !== headerCount || records.length !== summaryCount ||
    uncompressedBytes !== summaryUncompressed || compressedBytes !== summaryCompressed
  ) unsafeArchive()
  return records
}

function validateArchiveEntries(entries: readonly ArchiveEntry[], expectedAppBundleName: string): void {
  const exactPaths = new Set<string>()
  const filesystemPaths = new Set<string>()
  let hasAppRoot = false
  let hasInfoPlist = false

  for (const entry of entries) {
    const path = entry.path
    if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) unsafeArchive()
    if (
      !path || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path) ||
      posix.isAbsolute(path)
    ) unsafeArchive()
    const isDirectory = path.endsWith('/')
    if ((entry.kind === 'd') !== isDirectory) unsafeArchive()
    const withoutTrailingSlash = isDirectory ? path.slice(0, -1) : path
    if (!withoutTrailingSlash || posix.normalize(withoutTrailingSlash) !== withoutTrailingSlash) {
      unsafeArchive()
    }
    const components = withoutTrailingSlash.split('/')
    if (
      components.length > MAX_PATH_DEPTH ||
      components.some((component) => !component || component === '.' || component === '..')
    ) unsafeArchive()

    if (components[0] === expectedAppBundleName) {
      if (withoutTrailingSlash === expectedAppBundleName) {
        if (entry.kind !== 'd') unsafeArchive()
        hasAppRoot = true
      }
      if (`${withoutTrailingSlash}${isDirectory ? '/' : ''}` === `${expectedAppBundleName}/Contents/Info.plist`) {
        if (entry.kind !== '-') unsafeArchive()
        hasInfoPlist = true
      }
    } else if (components[0] === '__MACOSX') {
      if (components.length === 1) {
        if (entry.kind !== 'd') unsafeArchive()
      } else {
        if (components[1] !== expectedAppBundleName || entry.kind === 'l') unsafeArchive()
        if (entry.kind === '-' && !components.at(-1)?.startsWith('._')) unsafeArchive()
      }
    } else {
      unsafeArchive()
    }

    if (exactPaths.has(path)) unsafeArchive()
    exactPaths.add(path)
    const collisionKey = withoutTrailingSlash.normalize('NFC').toLowerCase()
    if (filesystemPaths.has(collisionKey)) unsafeArchive()
    filesystemPaths.add(collisionKey)
  }
  if (!hasAppRoot || !hasInfoPlist) unsafeArchive()
}

function validateSymlinkTarget(
  entryPath: string,
  target: string,
  expectedAppBundleName: string
): void {
  if (
    !target || Buffer.byteLength(target, 'utf8') > MAX_SYMLINK_TARGET_BYTES ||
    /[\u0000-\u001f\u007f]/.test(target) || target.includes('\\') || posix.isAbsolute(target)
  ) unsafeArchive()
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(entryPath), target))
  if (
    resolvedTarget !== expectedAppBundleName &&
    !resolvedTarget.startsWith(`${expectedAppBundleName}/`)
  ) unsafeArchive()
}

async function validateExtractedApplication(
  extractionDirectory: string,
  expectedAppBundleName: string,
  manifest: ArchiveManifest,
  maxEntries: number,
  maxUncompressedBytes: number
): Promise<string> {
  try {
    const canonicalExtraction = await realpath(extractionDirectory)
    const topLevel = await readdir(canonicalExtraction)
    if (topLevel.length !== 1 || topLevel[0] !== expectedAppBundleName) unsafeArchive('extract')
    const unresolvedAppPath = join(canonicalExtraction, expectedAppBundleName)
    const appStats = await lstat(unresolvedAppPath)
    if (!appStats.isDirectory() || appStats.isSymbolicLink()) unsafeArchive('extract')
    const appPath = await realpath(unresolvedAppPath)
    if (!isStrictDescendant(canonicalExtraction, appPath)) unsafeArchive('extract')

    const pending = [appPath]
    const seenSymlinks = new Set<string>()
    let entryCount = 0
    let regularBytes = 0
    while (pending.length > 0) {
      const directory = pending.pop()!
      for (const child of await readdir(directory)) {
        entryCount += 1
        if (entryCount > maxEntries) {
          throw new TrustedAppArchiveVerifyError('archive-too-large', 'extract')
        }
        const childPath = join(directory, child)
        const childStats = await lstat(childPath)
        const relativeChild = relative(canonicalExtraction, childPath).split(sep).join('/')
        if (childStats.isSymbolicLink()) {
          const expectedTarget = manifest.symlinkTargets.get(relativeChild)
          if (expectedTarget === undefined || await readlink(childPath) !== expectedTarget) {
            unsafeArchive('extract')
          }
          const canonicalTarget = await realpath(childPath)
          if (!isStrictDescendant(appPath, canonicalTarget) && canonicalTarget !== appPath) {
            unsafeArchive('extract')
          }
          seenSymlinks.add(relativeChild)
          continue
        }
        const canonicalChild = await realpath(childPath)
        if (!isStrictDescendant(appPath, canonicalChild)) unsafeArchive('extract')
        if (childStats.isDirectory()) {
          pending.push(childPath)
        } else if (childStats.isFile()) {
          regularBytes = safeAdd(regularBytes, childStats.size, 'extract')
          if (regularBytes > maxUncompressedBytes) {
            throw new TrustedAppArchiveVerifyError('archive-too-large', 'extract')
          }
        } else {
          unsafeArchive('extract')
        }
      }
    }
    if (seenSymlinks.size !== manifest.symlinkTargets.size) unsafeArchive('extract')
    const plistPath = join(appPath, 'Contents', 'Info.plist')
    if (!(await lstat(plistPath)).isFile()) unsafeArchive('extract')
    return appPath
  } catch (error) {
    if (error instanceof TrustedAppArchiveVerifyError) throw error
    throw new TrustedAppArchiveVerifyError('unsafe-archive', 'extract')
  }
}

async function verifyApplicationTrust(
  context: ArchiveContext,
  appPath: string,
  expected: ExpectedIdentity
): Promise<void> {
  await runChecked(
    context,
    CODESIGN_PATH,
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    'signature',
    'signature-invalid'
  )
  await runChecked(
    context,
    CODESIGN_PATH,
    [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      '-R',
      `=${expected.designatedRequirement}`,
      appPath
    ],
    'signature',
    'signature-invalid'
  )
  const identityResult = await runChecked(
    context,
    CODESIGN_PATH,
    ['-d', '--verbose=4', appPath],
    'identity',
    'signature-invalid'
  )
  const identityDetail = `${decodeToolOutput(identityResult.stdout, 'identity')}\n${decodeToolOutput(identityResult.stderr, 'identity')}`
  if (
    singleDetailValue(identityDetail, 'Identifier') !== expected.bundleId ||
    singleDetailValue(identityDetail, 'TeamIdentifier') !== expected.teamId
  ) {
    throw new TrustedAppArchiveVerifyError('identity-mismatch', 'identity')
  }
  assertDistributionSignature(identityDetail, expected.teamId)

  await runChecked(
    context,
    SPCTL_PATH,
    ['-a', '-vv', '-t', 'exec', appPath],
    'gatekeeper',
    'gatekeeper-rejected'
  )
  await runChecked(
    context,
    XCRUN_PATH,
    ['stapler', 'validate', appPath],
    'notarization',
    'notarization-invalid'
  )

  const plistPath = join(appPath, 'Contents', 'Info.plist')
  const [bundleId, version, bundleVersion, appName, executable] = await Promise.all([
    readPlistScalar(context, plistPath, 'CFBundleIdentifier'),
    readPlistScalar(context, plistPath, 'CFBundleShortVersionString'),
    readPlistScalar(context, plistPath, 'CFBundleVersion'),
    readPlistScalar(context, plistPath, 'CFBundleName'),
    readPlistScalar(context, plistPath, 'CFBundleExecutable')
  ])
  if (
    bundleId !== expected.bundleId || version !== expected.version ||
    bundleVersion !== expected.bundleVersion || appName !== expected.appName ||
    !isSafeExecutableName(executable)
  ) {
    throw new TrustedAppArchiveVerifyError('metadata-mismatch', 'metadata')
  }
  const executablePath = join(appPath, 'Contents', 'MacOS', executable)
  const architectureResult = await runChecked(
    context,
    LIPO_PATH,
    ['-archs', executablePath],
    'metadata',
    'metadata-mismatch'
  )
  const architectures = parseArchitectures(
    decodeToolOutput(architectureResult.stdout, 'metadata')
  )
  if (!sameArchitectureSet(architectures, expected.architectures)) {
    throw new TrustedAppArchiveVerifyError('metadata-mismatch', 'metadata')
  }
}

async function readPlistScalar(
  context: ArchiveContext,
  plistPath: string,
  key:
    | 'CFBundleIdentifier'
    | 'CFBundleShortVersionString'
    | 'CFBundleVersion'
    | 'CFBundleName'
    | 'CFBundleExecutable'
): Promise<string> {
  const result = await runChecked(
    context,
    PLUTIL_PATH,
    ['-extract', key, 'raw', '-o', '-', plistPath],
    'metadata',
    'metadata-mismatch'
  )
  const output = decodeToolOutput(result.stdout, 'metadata')
  const value = output.endsWith('\n') ? output.slice(0, -1) : output
  if (!value || value.length > 1_024 || /[\r\n\0]/.test(value)) {
    throw new TrustedAppArchiveVerifyError('metadata-mismatch', 'metadata')
  }
  return value
}

function assertDistributionSignature(detail: string, expectedTeamId: string): void {
  const flags = detailValues(detail, 'flags')
  const flagMatch = flags.length === 1
    ? /^0x[0-9a-f]+\(([^)]*)\)(?:\s|$)/i.exec(flags[0]!)
    : null
  const flagNames = flagMatch?.[1]?.split(/[\s,]+/).filter(Boolean) ?? []
  const timestamps = detailValues(detail, 'Timestamp')
  const timestamp = timestamps.length === 1 ? timestamps[0] : undefined
  const developerAuthorities = detailValues(detail, 'Authority').filter((value) =>
    value.startsWith('Developer ID Application: ')
  )
  const authority = developerAuthorities.length === 1 ? developerAuthorities[0] : undefined
  const authorityMatch = authority === undefined
    ? null
    : /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(authority)

  if (
    !flagNames.includes('runtime') || timestamp === undefined ||
    !timestamp || timestamp !== timestamp.trim() || /^none$/i.test(timestamp) ||
    authorityMatch?.[1] !== expectedTeamId
  ) {
    throw new TrustedAppArchiveVerifyError('signature-invalid', 'signature')
  }
}

function isSafeExecutableName(value: string): boolean {
  return value.length <= 255 && value !== '.' && value !== '..' &&
    !/[\/\\\u0000-\u001f\u007f]/.test(value)
}

function parseArchitectures(output: string): readonly TrustedAppArchitecture[] {
  const value = output.endsWith('\n') ? output.slice(0, -1) : output
  const architectures = value.split(' ')
  if (
    !value || /[\r\n\0\t]/.test(value) || architectures.length < 1 ||
    architectures.length > 2 || architectures.some((architecture) =>
      !ALLOWED_ARCHITECTURES.has(architecture)
    ) || new Set(architectures).size !== architectures.length
  ) {
    throw new TrustedAppArchiveVerifyError('metadata-mismatch', 'metadata')
  }
  return architectures as TrustedAppArchitecture[]
}

function sameArchitectureSet(
  actual: readonly TrustedAppArchitecture[],
  expected: readonly TrustedAppArchitecture[]
): boolean {
  return actual.length === expected.length && actual.every((value) => expected.includes(value))
}

async function runChecked(
  context: ArchiveContext,
  executable: string,
  args: readonly string[],
  operation: TrustedAppArchiveVerifyOperation,
  nonzeroCode: TrustedAppArchiveVerifyErrorCode,
  maxOutputBytes = context.maxOutputBytes
): Promise<ArchiveToolRunResult> {
  let result: ArchiveToolRunResult
  try {
    result = await context.runner.run({
      executable,
      args,
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
      maxOutputBytes,
      terminateGraceMs: context.terminateGraceMs
    })
  } catch {
    throw new TrustedAppArchiveVerifyError('tool-unavailable', operation)
  }
  if (result.failure) {
    throw new TrustedAppArchiveVerifyError(
      result.failure === 'timeout'
        ? 'timeout'
        : result.failure === 'output-limit'
          ? 'output-limit'
          : 'tool-unavailable',
      operation
    )
  }
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new TrustedAppArchiveVerifyError(nonzeroCode, operation)
  }
  return result
}

async function canonicalExistingStagingRoot(configuredPath: string): Promise<string> {
  if (
    typeof configuredPath !== 'string' || !configuredPath || configuredPath.length > MAX_PATH_BYTES ||
    !isAbsolute(configuredPath) || configuredPath.includes('\0') || resolve(configuredPath) !== configuredPath
  ) {
    throw new TrustedAppArchiveVerifyError('invalid-request', 'request')
  }
  try {
    const canonical = await realpath(configuredPath)
    if (!(await stat(canonical)).isDirectory()) throw new Error('not-directory')
    return canonical
  } catch {
    throw new TrustedAppArchiveVerifyError('invalid-request', 'request')
  }
}

async function validateStagedArchive(
  configuredPath: string,
  stagingRoot: string,
  maxArchiveBytes: number
): Promise<string> {
  if (
    typeof configuredPath !== 'string' || !configuredPath || configuredPath.length > MAX_PATH_BYTES ||
    !isAbsolute(configuredPath) || configuredPath.includes('\0') || resolve(configuredPath) !== configuredPath ||
    basename(configuredPath) !== STAGED_ARCHIVE_NAME
  ) {
    throw new TrustedAppArchiveVerifyError('invalid-request', 'request')
  }
  const internalPath = relative(stagingRoot, configuredPath)
  const components = internalPath.split(sep)
  if (
    components.length !== 2 || !components[0]?.startsWith(STAGED_DIRECTORY_PREFIX) ||
    components[1] !== STAGED_ARCHIVE_NAME || internalPath.startsWith(`..${sep}`)
  ) {
    throw new TrustedAppArchiveVerifyError('invalid-request', 'request')
  }
  try {
    const canonicalParent = await realpath(dirname(configuredPath))
    const canonicalArchive = await realpath(configuredPath)
    const archiveStats = await lstat(configuredPath)
    const parentStats = await lstat(canonicalParent)
    if (
      canonicalArchive !== configuredPath || canonicalParent !== dirname(configuredPath) ||
      !archiveStats.isFile() || archiveStats.isSymbolicLink() || archiveStats.size < 1 ||
      !parentStats.isDirectory() || !isOwnedPrivatePath(archiveStats) ||
      !isOwnedPrivatePath(parentStats)
    ) throw new Error('invalid archive')
    if (archiveStats.size > maxArchiveBytes) {
      throw new TrustedAppArchiveVerifyError('archive-too-large', 'archive-list')
    }
    return canonicalArchive
  } catch (error) {
    if (error instanceof TrustedAppArchiveVerifyError) throw error
    throw new TrustedAppArchiveVerifyError('archive-unavailable', 'request')
  }
}

function validateExpectedIdentity(request: TrustedAppArchiveVerifyRequest): ExpectedIdentity {
  const appName = request.expectedAppName
  const bundleId = request.expectedBundleId
  const version = request.expectedVersion
  const bundleVersion = request.expectedBundleVersion
  const teamId = request.expectedTeamId
  const designatedRequirement = request.expectedDesignatedRequirement
  const architectures = request.expectedArchitectures
  if (
    typeof appName !== 'string' || appName !== appName.trim() || !appName ||
    Buffer.byteLength(appName, 'utf8') > 255 || appName.endsWith('.app') ||
    appName === '.' || appName === '..' || /[\/\\\u0000-\u001f\u007f]/.test(appName) ||
    typeof bundleId !== 'string' || bundleId.length > 255 ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId) ||
    typeof version !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(version) || version.length > 64 ||
    typeof bundleVersion !== 'string' || bundleVersion !== bundleVersion.trim() ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(bundleVersion) ||
    typeof teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(teamId) ||
    typeof designatedRequirement !== 'string' ||
    designatedRequirement !== designatedRequirement.trim() || !designatedRequirement ||
    Buffer.byteLength(designatedRequirement, 'utf8') > MAX_DESIGNATED_REQUIREMENT_BYTES ||
    /[\u0000-\u001f\u007f]/.test(designatedRequirement) ||
    designatedRequirement.startsWith('=') || designatedRequirement.startsWith('designated =>') ||
    !Array.isArray(architectures) || architectures.length < 1 || architectures.length > 2 ||
    architectures.some((architecture) =>
      typeof architecture !== 'string' || !ALLOWED_ARCHITECTURES.has(architecture)
    ) || new Set(architectures).size !== architectures.length
  ) {
    throw new TrustedAppArchiveVerifyError('invalid-request', 'request')
  }
  return {
    appName,
    appBundleName: `${appName}.app`,
    bundleId,
    version,
    bundleVersion,
    teamId,
    designatedRequirement,
    architectures: [...architectures]
  }
}

function isOwnedPrivatePath(stats: Stats): boolean {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stats.uid
  return stats.uid === currentUid && (stats.mode & 0o077) === 0
}

function isStrictDescendant(root: string, target: string): boolean {
  const child = relative(root, target)
  return Boolean(child) && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function decodeToolOutput(
  output: Uint8Array,
  operation: TrustedAppArchiveVerifyOperation
): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(output)
  } catch {
    throw new TrustedAppArchiveVerifyError(
      operation === 'metadata'
        ? 'metadata-mismatch'
        : operation === 'identity'
          ? 'identity-mismatch'
          : 'unsafe-archive',
      operation
    )
  }
}

function detailValues(
  detail: string,
  key: 'Identifier' | 'TeamIdentifier' | 'flags' | 'Timestamp' | 'Authority'
): string[] {
  return [...detail.matchAll(new RegExp(`(?:^|\\n)${key}=([^\\r\\n]+)`, 'g'))]
    .map((match) => match[1]!)
}

function singleDetailValue(
  detail: string,
  key: 'Identifier' | 'TeamIdentifier'
): string | undefined {
  const values = detailValues(detail, key)
  return values.length === 1 ? values[0] : undefined
}

function safeUnsignedInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function safeAdd(
  current: number,
  next: number,
  operation: 'archive-list' | 'extract' = 'archive-list'
): number {
  const value = current + next
  if (!Number.isSafeInteger(next) || next < 0 || !Number.isSafeInteger(value)) {
    unsafeArchive(operation)
  }
  return value
}

function unsafeArchive(operation: 'archive-list' | 'extract' = 'archive-list'): never {
  throw new TrustedAppArchiveVerifyError('unsafe-archive', operation)
}

function failedRun(failure: ArchiveToolFailure): ArchiveToolRunResult {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: null,
    signal: null,
    failure
  }
}

function safeToolEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin',
    LANG: 'C',
    LC_ALL: 'C'
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through when process-group signaling is unavailable.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // A concurrent process exit is harmless.
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return candidate
}

function publicErrorMessage(code: TrustedAppArchiveVerifyErrorCode): string {
  switch (code) {
    case 'invalid-request': return 'The app update verification request is invalid.'
    case 'archive-unavailable': return 'The staged app update is unavailable.'
    case 'unsafe-archive': return 'The app update archive has an unsafe structure.'
    case 'archive-too-large': return 'The app update archive exceeded its safety limits.'
    case 'extraction-failed': return 'The app update could not be unpacked safely.'
    case 'signature-invalid': return 'The app update signature is invalid.'
    case 'identity-mismatch': return 'The app update signing identity does not match.'
    case 'gatekeeper-rejected': return 'The app update was rejected by Gatekeeper.'
    case 'notarization-invalid': return 'The app update notarization ticket is invalid.'
    case 'metadata-mismatch': return 'The app update metadata does not match.'
    case 'tool-unavailable': return 'A required macOS verification tool is unavailable.'
    case 'timeout': return 'App update verification timed out.'
    case 'output-limit': return 'App update verification exceeded its output limit.'
    case 'cleanup-failed': return 'The verified app update could not be cleaned up.'
  }
}
