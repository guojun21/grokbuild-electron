import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants as fsConstants, createReadStream } from 'node:fs'
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  readlink,
  rm
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ZIPINFO = '/usr/bin/zipinfo'
const UNZIP = '/usr/bin/unzip'
const DITTO = '/usr/bin/ditto'
const CODESIGN = '/usr/bin/codesign'
const SPCTL = '/usr/sbin/spctl'
const XCRUN = '/usr/bin/xcrun'
const PLUTIL = '/usr/bin/plutil'
const LIPO = '/usr/bin/lipo'
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_CHECKSUM_BYTES = 64 * 1024
const MAX_LIST_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 100_000
const MAX_EXTRACTED_BYTES = 8 * 1024 * 1024 * 1024
const MAX_PATH_BYTES = 4_096
const MAX_PATH_DEPTH = 64

export class ReleaseAppZipVerificationError extends Error {
  constructor(code) {
    super(`Release app archive verification failed: ${code}.`)
    this.name = 'ReleaseAppZipVerificationError'
    this.code = code
  }
}

/**
 * Verifies the exact .app.zip that release CI will upload. Tool execution is
 * injectable so deterministic tests never depend on a local signing identity.
 */
export async function verifyReleaseAppZip(options, dependencies = {}) {
  const expected = validateOptions(options)
  const run = dependencies.runTool ?? defaultRunTool
  const archive = await canonicalRegularFile(expected.archivePath, MAX_ARCHIVE_BYTES)
  const archivePath = archive.path
  if (basename(archivePath) !== expected.archiveName) fail('archive-name')
  const checksums = await canonicalRegularFile(
    expected.checksumsPath,
    MAX_CHECKSUM_BYTES
  )
  const checksumsPath = checksums.path
  if (
    basename(checksumsPath) !== 'SHA256SUMS' ||
    dirname(checksumsPath) !== dirname(archivePath)
  ) fail('checksums-path')
  const digest = await verifyChecksumEntry(
    archivePath,
    checksumsPath,
    expected.archiveName
  )

  const cwd = dirname(archivePath)
  const namesResult = await runChecked(run, ZIPINFO, ['-1', archivePath], cwd)
  const longResult = await runChecked(run, ZIPINFO, ['-l', archivePath], cwd)
  const entries = await validateArchiveManifest(
    run,
    cwd,
    archivePath,
    namesResult.stdout,
    longResult.stdout,
    expected.appBundleName
  )
  const extractionRoot = await mkdtemp(join(tmpdir(), 'grokbuild-release-zip-'))
  try {
    await runChecked(run, DITTO, ['-x', '-k', archivePath, extractionRoot], cwd)
    const appPath = await validateExtractedApp(
      extractionRoot,
      expected.appBundleName,
      entries.length
    )
    await verifyExtractedTrust(run, cwd, appPath, expected)
    await assertUnchanged(checksumsPath, checksums.identity)
    await assertUnchanged(archivePath, archive.identity)
    if (await sha256File(archivePath) !== digest) fail('artifact-changed')
    await assertUnchanged(archivePath, archive.identity)
    return Object.freeze({
      archivePath,
      archiveName: expected.archiveName,
      sha256: digest,
      bundleId: expected.bundleId,
      version: expected.version,
      teamId: expected.teamId,
      architectures: Object.freeze([...expected.architectures])
    })
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') fail('request')
  const appName = safeScalar(options.appName, 256, 'app-name')
  const archiveName = safeScalar(options.archiveName, 256, 'archive-name')
  const expectedArchiveName = `GrokBuild-Electron-v${options.version}.app.zip`
  if (archiveName !== expectedArchiveName) fail('archive-name')
  const bundleId = safeScalar(options.bundleId, 255, 'bundle-id')
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(bundleId)) {
    fail('bundle-id')
  }
  const version = safeVersion(options.version)
  const bundleVersion = safeVersion(options.bundleVersion)
  const teamId = safeScalar(options.teamId, 10, 'team-id')
  if (!/^[A-Z0-9]{10}$/.test(teamId)) fail('team-id')
  if (!Array.isArray(options.architectures) || options.architectures.length < 1) {
    fail('architectures')
  }
  const architectures = [...new Set(options.architectures)]
  if (
    architectures.length !== options.architectures.length ||
    architectures.some((value) => value !== 'arm64' && value !== 'x86_64')
  ) fail('architectures')
  const sourceAppPath = canonicalInputPath(options.sourceAppPath)
  if (basename(sourceAppPath) !== `${appName}.app`) fail('source-app')
  return {
    archivePath: canonicalInputPath(options.archivePath),
    checksumsPath: canonicalInputPath(options.checksumsPath),
    sourceAppPath,
    archiveName,
    appName,
    appBundleName: `${appName}.app`,
    bundleId,
    version,
    bundleVersion,
    teamId,
    architectures
  }
}

async function canonicalRegularFile(path, maximumBytes) {
  try {
    const [entry, canonical] = await Promise.all([
      lstat(path, { bigint: true }),
      realpath(path)
    ])
    if (
      !entry.isFile() || entry.isSymbolicLink() || canonical !== path ||
      entry.size < 1n || entry.size > BigInt(maximumBytes)
    ) fail('artifact-path')
    return { path: canonical, identity: fileIdentity(entry) }
  } catch (error) {
    if (error instanceof ReleaseAppZipVerificationError) throw error
    fail('artifact-path')
  }
}

async function verifyChecksumEntry(archivePath, checksumsPath, archiveName) {
  const text = await readFile(checksumsPath, 'utf8')
  if (!text.endsWith('\n') || /[\0\r]/.test(text)) fail('checksums')
  const entries = new Map()
  for (const line of text.slice(0, -1).split('\n')) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/.exec(line)
    if (!match || entries.has(match[2])) fail('checksums')
    entries.set(match[2], match[1])
  }
  const claimed = entries.get(archiveName)
  if (!claimed) fail('checksum-entry')
  const actual = await sha256File(archivePath)
  if (actual !== claimed) fail('checksum-mismatch')
  return actual
}

async function sha256File(path) {
  const digest = createHash('sha256')
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path, {
      flags: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    })
    stream.on('data', (chunk) => digest.update(chunk))
    stream.once('error', rejectHash)
    stream.once('end', resolveHash)
  })
  return digest.digest('hex')
}

async function assertUnchanged(path, expected) {
  try {
    const entry = await lstat(path, { bigint: true })
    const actual = fileIdentity(entry)
    if (
      !entry.isFile() || entry.isSymbolicLink() ||
      Object.keys(expected).some((key) => actual[key] !== expected[key])
    ) fail('artifact-changed')
  } catch (error) {
    if (error instanceof ReleaseAppZipVerificationError) throw error
    fail('artifact-changed')
  }
}

function fileIdentity(entry) {
  return {
    device: entry.dev,
    inode: entry.ino,
    size: entry.size,
    modifiedNs: entry.mtimeNs,
    changedNs: entry.ctimeNs
  }
}

async function validateArchiveManifest(
  run,
  cwd,
  archivePath,
  namesOutput,
  longOutput,
  appBundleName
) {
  const names = parseArchiveNames(namesOutput)
  const entries = parseLongListing(longOutput)
  if (
    names.length !== entries.length ||
    names.some((name, index) => entries[index]?.path !== name)
  ) fail('archive-shape')

  validateArchiveEntries(entries, appBundleName)
  for (const entry of entries) {
    if (entry.kind !== 'l') continue
    if (/[*?\[\]]/.test(entry.path) || entry.bytes > MAX_PATH_BYTES) fail('archive-shape')
    const targetResult = await runChecked(
      run,
      UNZIP,
      ['-p', archivePath, entry.path],
      cwd
    )
    if (Buffer.byteLength(targetResult.stdout, 'utf8') !== entry.bytes) fail('archive-shape')
    validateArchiveSymlink(entry.path, targetResult.stdout, appBundleName)
    if (entries.some((candidate) => candidate.path.startsWith(`${entry.path}/`))) {
      fail('archive-shape')
    }
  }
  return entries
}

function parseArchiveNames(outputValue) {
  const output = boundedOutput(outputValue, MAX_LIST_BYTES)
  if (!output || !output.endsWith('\n') || /[\0\r]/.test(output)) fail('archive-shape')
  const names = output.slice(0, -1).split('\n')
  if (names.length < 2 || names.length > MAX_ENTRIES || names.some((name) => !name)) {
    fail('archive-shape')
  }
  return names
}

function parseLongListing(outputValue) {
  const output = boundedOutput(outputValue, MAX_LIST_BYTES)
  if (!output || /[\0\r]/.test(output)) fail('archive-shape')
  const lines = output.endsWith('\n') ? output.slice(0, -1).split('\n') : output.split('\n')
  const headerIndex = lines.findIndex((line) => line.startsWith('Zip file size: '))
  const header = headerIndex >= 0
    ? /^Zip file size: (\d+) bytes, number of entries: (\d+)$/.exec(lines[headerIndex])
    : null
  const summaryIndex = lines.length - 1
  const summary = /^(\d+) files?, (\d+) bytes uncompressed, (\d+) bytes compressed:\s+-?[0-9.]+%$/.exec(
    lines[summaryIndex] ?? ''
  )
  if (!header || !summary || summaryIndex <= headerIndex) fail('archive-shape')
  const expectedCount = safeInteger(header[2])
  const summaryCount = safeInteger(summary[1])
  const summaryBytes = safeInteger(summary[2])
  const summaryCompressed = safeInteger(summary[3])
  if (
    expectedCount === undefined || summaryCount === undefined ||
    summaryBytes === undefined || summaryCompressed === undefined ||
    expectedCount > MAX_ENTRIES || summaryBytes > MAX_EXTRACTED_BYTES
  ) fail('archive-shape')

  const entries = []
  let totalBytes = 0
  let totalCompressed = 0
  for (const line of lines.slice(headerIndex + 1, summaryIndex)) {
    const match = /^(\S+)\s+\S+\s+\S+\s+(\d+)\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line)
    const kind = match?.[1]?.[0]
    const bytes = safeInteger(match?.[2])
    const compressed = safeInteger(match?.[3])
    if (
      !match || (kind !== '-' && kind !== 'd' && kind !== 'l') ||
      bytes === undefined || compressed === undefined
    ) fail('archive-shape')
    totalBytes = safeAdd(totalBytes, bytes)
    totalCompressed = safeAdd(totalCompressed, compressed)
    entries.push({ path: match[4], kind, bytes })
  }
  if (
    entries.length < 2 || entries.length !== expectedCount ||
    entries.length !== summaryCount || totalBytes !== summaryBytes ||
    totalCompressed !== summaryCompressed
  ) fail('archive-shape')
  return entries
}

function validateArchiveEntries(entries, appBundleName) {
  const exact = new Set()
  const filesystem = new Set()
  let hasRoot = false
  let hasInfoPlist = false
  for (const entry of entries) {
    const path = entry.path
    if (
      Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES || path.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(path) || posix.isAbsolute(path)
    ) fail('archive-shape')
    const isDirectory = path.endsWith('/')
    if ((entry.kind === 'd') !== isDirectory) fail('archive-shape')
    const normalizedPath = isDirectory ? path.slice(0, -1) : path
    if (!normalizedPath || posix.normalize(normalizedPath) !== normalizedPath) {
      fail('archive-shape')
    }
    const components = normalizedPath.split('/')
    if (
      components.length > MAX_PATH_DEPTH ||
      components.some((component) => !component || component === '.' || component === '..')
    ) fail('archive-shape')
    if (components[0] === appBundleName) {
      if (normalizedPath === appBundleName) {
        if (entry.kind !== 'd') fail('archive-shape')
        hasRoot = true
      }
      if (normalizedPath === `${appBundleName}/Contents/Info.plist`) {
        if (entry.kind !== '-') fail('archive-shape')
        hasInfoPlist = true
      }
    } else if (components[0] === '__MACOSX') {
      if (components.length === 1) {
        if (entry.kind !== 'd') fail('archive-shape')
      } else {
        if (components[1] !== appBundleName) fail('archive-shape')
        if (entry.kind === 'l') fail('archive-shape')
        if (entry.kind === '-' && !components.at(-1)?.startsWith('._')) fail('archive-shape')
      }
    } else {
      fail('archive-shape')
    }
    if (exact.has(path)) fail('archive-shape')
    exact.add(path)
    const collision = normalizedPath.normalize('NFC').toLowerCase()
    if (filesystem.has(collision)) fail('archive-shape')
    filesystem.add(collision)
  }
  if (!hasRoot || !hasInfoPlist) fail('archive-shape')
}

function validateArchiveSymlink(path, target, appBundleName) {
  if (
    !target || Buffer.byteLength(target, 'utf8') > MAX_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/.test(target) || target.includes('\\') ||
    posix.isAbsolute(target)
  ) fail('archive-shape')
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(path), target))
  if (
    resolvedTarget !== appBundleName &&
    !resolvedTarget.startsWith(`${appBundleName}/`)
  ) fail('archive-shape')
}

async function validateExtractedApp(extractionRoot, appBundleName, archiveEntries) {
  try {
    const topLevel = await readdir(extractionRoot)
    if (topLevel.length !== 1 || topLevel[0] !== appBundleName) fail('extracted-shape')
    const unresolvedAppPath = join(extractionRoot, appBundleName)
    const appEntry = await lstat(unresolvedAppPath)
    if (!appEntry.isDirectory() || appEntry.isSymbolicLink()) fail('extracted-shape')
    const appPath = await realpath(unresolvedAppPath)
    const pending = [appPath]
    let count = 0
    let bytes = 0
    while (pending.length > 0) {
      const directory = pending.pop()
      for (const child of await readdir(directory)) {
        count += 1
        if (count > Math.max(archiveEntries, MAX_ENTRIES)) fail('extracted-shape')
        const childPath = join(directory, child)
        const entry = await lstat(childPath)
        if (entry.isSymbolicLink()) {
          const linkTarget = await readlink(childPath)
          if (
            !linkTarget || posix.isAbsolute(linkTarget) || linkTarget.includes('\\') ||
            /[\u0000-\u001f\u007f]/.test(linkTarget)
          ) fail('extracted-shape')
          const target = await realpath(childPath)
          if (target !== appPath && !isDescendant(appPath, target)) fail('extracted-shape')
        } else if (entry.isDirectory()) {
          const target = await realpath(childPath)
          if (!isDescendant(appPath, target)) fail('extracted-shape')
          pending.push(childPath)
        } else if (entry.isFile()) {
          bytes += entry.size
          if (!Number.isSafeInteger(bytes) || bytes > MAX_EXTRACTED_BYTES) fail('extracted-size')
        } else {
          fail('extracted-shape')
        }
      }
    }
    const plist = await lstat(join(appPath, 'Contents', 'Info.plist'))
    if (!plist.isFile() || plist.isSymbolicLink()) fail('extracted-shape')
    return appPath
  } catch (error) {
    if (error instanceof ReleaseAppZipVerificationError) throw error
    fail('extracted-shape')
  }
}

async function verifyExtractedTrust(run, cwd, appPath, expected) {
  const sourceRequirementResult = await runChecked(
    run,
    CODESIGN,
    ['-d', '-r-', expected.sourceAppPath],
    cwd
  )
  const requirement = parseDesignatedRequirement(
    `${sourceRequirementResult.stdout}\n${sourceRequirementResult.stderr}`
  )
  await runChecked(run, CODESIGN, ['--verify', '--deep', '--strict', '--verbose=2', appPath], cwd)
  await runChecked(run, CODESIGN, [
    '--verify', '--deep', '--strict', '--verbose=2', '-R', `=${requirement}`, appPath
  ], cwd)
  const signature = await runChecked(run, CODESIGN, ['-d', '--verbose=4', appPath], cwd)
  const signatureDetail = `${signature.stdout}\n${signature.stderr}`
  assertSignedIdentity(signatureDetail, expected)
  await runChecked(run, SPCTL, ['-a', '-vv', '-t', 'exec', appPath], cwd)
  await runChecked(run, XCRUN, ['stapler', 'validate', appPath], cwd)

  const plistPath = join(appPath, 'Contents', 'Info.plist')
  const values = {}
  for (const key of [
    'CFBundleIdentifier',
    'CFBundleName',
    'CFBundleShortVersionString',
    'CFBundleVersion',
    'CFBundleExecutable'
  ]) {
    const result = await runChecked(
      run,
      PLUTIL,
      ['-extract', key, 'raw', '-o', '-', plistPath],
      cwd
    )
    values[key] = singleToolValue(result.stdout)
  }
  if (
    values.CFBundleIdentifier !== expected.bundleId ||
    values.CFBundleName !== expected.appName ||
    values.CFBundleShortVersionString !== expected.version ||
    values.CFBundleVersion !== expected.bundleVersion ||
    !isSafeExecutable(values.CFBundleExecutable)
  ) fail('metadata')
  const executablePath = join(appPath, 'Contents', 'MacOS', values.CFBundleExecutable)
  const architecture = await runChecked(run, LIPO, ['-archs', executablePath], cwd)
  const actualArchitectures = singleToolValue(architecture.stdout).split(' ')
  if (!sameSet(actualArchitectures, expected.architectures)) fail('architectures')
}

function parseDesignatedRequirement(outputValue) {
  const output = boundedOutput(outputValue, 64 * 1024)
  const matches = output.split('\n').filter((line) => line.startsWith('designated => '))
  if (matches.length !== 1) fail('designated-requirement')
  const requirement = matches[0].slice('designated => '.length)
  if (
    !requirement || requirement.length > 16 * 1024 ||
    /[\0\r\n]/.test(requirement) || requirement.startsWith('=')
  ) fail('designated-requirement')
  return requirement
}

function assertSignedIdentity(detail, expected) {
  if (
    singleDetail(detail, 'Identifier') !== expected.bundleId ||
    singleDetail(detail, 'TeamIdentifier') !== expected.teamId
  ) fail('signed-identity')
  const flags = detailValues(detail, 'flags')
  const flagNames = flags.length === 1
    ? /^0x[0-9a-f]+\(([^)]*)\)/i.exec(flags[0])?.[1]
    ?.split(/[\s,]+/).filter(Boolean) ?? []
    : []
  const timestamps = detailValues(detail, 'Timestamp')
  const timestamp = timestamps.length === 1 ? timestamps[0] : undefined
  const authorities = detailValues(detail, 'Authority').filter((value) =>
    value.startsWith('Developer ID Application: ')
  )
  const authorityTeam = authorities.length === 1
    ? /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(authorities[0])?.[1]
    : undefined
  if (
    !flagNames.includes('runtime') || !timestamp || /^none$/i.test(timestamp) ||
    authorityTeam !== expected.teamId
  ) fail('distribution-signature')
}

async function runChecked(run, executable, args, cwd) {
  try {
    const result = await run(executable, args, {
      cwd,
      timeout: 120_000,
      maxBuffer: MAX_LIST_BYTES,
      windowsHide: true
    })
    return {
      stdout: boundedOutput(result?.stdout ?? '', MAX_LIST_BYTES),
      stderr: boundedOutput(result?.stderr ?? '', MAX_LIST_BYTES)
    }
  } catch {
    fail('tool')
  }
}

async function defaultRunTool(executable, args, options) {
  return await execFileAsync(executable, args, options)
}

function detailValues(detail, key) {
  return detail.split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1))
}

function singleDetail(detail, key) {
  const values = detailValues(detail, key)
  if (values.length !== 1 || !values[0]) fail('signed-identity')
  return values[0]
}

function singleToolValue(outputValue) {
  const output = boundedOutput(outputValue, 4 * 1024)
  const value = output.endsWith('\n') ? output.slice(0, -1) : output
  if (!value || /[\0\r\n]/.test(value)) fail('metadata')
  return value
}

function boundedOutput(value, maximumBytes) {
  const output = Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
  if (Buffer.byteLength(output, 'utf8') > maximumBytes) fail('tool-output')
  return output
}

function canonicalInputPath(value) {
  if (
    typeof value !== 'string' || !value || value.length > MAX_PATH_BYTES ||
    value.includes('\0') || !isAbsolute(value) || resolve(value) !== value
  ) fail('request-path')
  return value
}

function safeScalar(value, maximumLength, code) {
  if (
    typeof value !== 'string' || !value || value.length > maximumLength ||
    /[\0\r\n/\\]/.test(value)
  ) fail(code)
  return value
}

function safeVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) fail('version')
  return value
}

function isSafeExecutable(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    value !== '.' && value !== '..' && !/[\0\r\n/\\]/.test(value)
}

function sameSet(actual, expected) {
  return actual.length === expected.length && new Set(actual).size === actual.length &&
    actual.every((value) => expected.includes(value))
}

function safeInteger(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function safeAdd(left, right) {
  const total = left + right
  if (!Number.isSafeInteger(total)) fail('archive-shape')
  return total
}

function isDescendant(parent, child) {
  const value = relative(parent, child)
  return value.length > 0 && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

function fail(code) {
  throw new ReleaseAppZipVerificationError(code)
}
