import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ReleaseAppZipVerificationError,
  verifyReleaseAppZip
} from '../../scripts/qa/lib/release-app-zip-verifier.mjs'
import type {
  ReleaseAppZipToolResult,
  ReleaseAppZipVerifierOptions
} from '../../scripts/qa/lib/release-app-zip-verifier.mjs'

const APP_NAME = 'GrokBuild Electron'
const APP_BUNDLE = `${APP_NAME}.app`
const BUNDLE_ID = 'com.oasmet.grokbuild-electron'
const VERSION = '0.2.0'
const TEAM_ID = 'A1B2C3D4E5'
const ARCHIVE_NAME = `GrokBuild-Electron-v${VERSION}.app.zip`
const DESIGNATED_REQUIREMENT =
  `anchor apple generic and identifier "${BUNDLE_ID}" and certificate leaf[subject.OU] = "${TEAM_ID}"`
const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('release app ZIP verifier', () => {
  it('verifies the exact checksum, archive shape, extracted identity and macOS trust commands', async () => {
    const fixture = await createFixture()
    const tools = new FakeReleaseTools()

    const verified = await verifyReleaseAppZip(fixture.options, {
      runTool: tools.run
    })

    expect(verified).toMatchObject({
      archivePath: fixture.options.archivePath,
      archiveName: ARCHIVE_NAME,
      sha256: fixture.digest,
      bundleId: BUNDLE_ID,
      version: VERSION,
      teamId: TEAM_ID,
      architectures: ['arm64']
    })
    expect(tools.requests.map((request) => request.executable)).toEqual([
      '/usr/bin/zipinfo',
      '/usr/bin/zipinfo',
      '/usr/bin/ditto',
      '/usr/bin/codesign',
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
    expect(tools.requests[0]?.args).toEqual(['-1', fixture.options.archivePath])
    expect(tools.requests[1]?.args).toEqual(['-l', fixture.options.archivePath])
    expect(tools.requests[3]?.args).toEqual(['-d', '-r-', fixture.options.sourceAppPath])
    expect(tools.requests[5]?.args.slice(0, 7)).toEqual([
      '--verify', '--deep', '--strict', '--verbose=2', '-R', `=${DESIGNATED_REQUIREMENT}`,
      expect.stringContaining(APP_BUNDLE)
    ])
    expect(tools.requests[7]?.args.slice(0, 4)).toEqual(['-a', '-vv', '-t', 'exec'])
    expect(tools.requests[8]?.args.slice(0, 2)).toEqual(['stapler', 'validate'])
  })

  it.skipIf(process.platform !== 'darwin')(
    'accepts the real ditto ZIP shape while macOS trust commands remain deterministic',
    async () => {
      const fixture = await createDittoFixture()
      const tools = new FakeReleaseTools()
      const verified = await verifyReleaseAppZip(fixture.options, {
        runTool: async (executable, args, options) => {
          if (
            executable === '/usr/bin/zipinfo' || executable === '/usr/bin/unzip' ||
            executable === '/usr/bin/ditto'
          ) {
            return await execFileAsync(executable, [...args], options)
          }
          return await tools.run(executable, args)
        }
      })
      expect(verified.sha256).toBe(fixture.digest)
      expect(tools.requests.map((request) => request.executable)).toContain('/usr/bin/codesign')
    }
  )

  it('rejects a missing or mismatched exact ZIP checksum before invoking macOS tools', async () => {
    const fixture = await createFixture()
    const tools = new FakeReleaseTools()
    await writeFile(fixture.options.checksumsPath, `${'0'.repeat(64)}  ${ARCHIVE_NAME}\n`)

    await expect(verifyReleaseAppZip(fixture.options, { runTool: tools.run }))
      .rejects.toMatchObject({ code: 'checksum-mismatch' })
    expect(tools.requests).toHaveLength(0)

    await writeFile(
      fixture.options.checksumsPath,
      `${fixture.digest}  GrokBuild-Electron-v0.2.0-arm64.dmg\n`
    )
    await expect(verifyReleaseAppZip(fixture.options, { runTool: tools.run }))
      .rejects.toMatchObject({ code: 'checksum-entry' })
    expect(tools.requests).toHaveLength(0)
  })

  it.each([
    `Replacement.app/\nReplacement.app/Contents/Info.plist\n`,
    `${APP_BUNDLE}/\n${APP_BUNDLE}/Contents/Info.plist\n../escape\n`,
    `${APP_BUNDLE}/\n${APP_BUNDLE}/Contents/Info.plist\n${APP_BUNDLE}\\evil\n`,
    `${APP_BUNDLE}/\n${APP_BUNDLE}/Contents/Info.plist\n${APP_BUNDLE}/contents/info.plist\n`
  ])('rejects a non-exact archive shape before extraction', async (archiveNames) => {
    const fixture = await createFixture()
    const tools = new FakeReleaseTools({ archiveNames })

    await expect(verifyReleaseAppZip(fixture.options, { runTool: tools.run }))
      .rejects.toMatchObject({ code: 'archive-shape' })
    expect(tools.requests.map((request) => request.executable)).toEqual([
      '/usr/bin/zipinfo',
      '/usr/bin/zipinfo'
    ])
  })

  it('fails closed when the extracted signature or architecture differs', async () => {
    const fixture = await createFixture()
    const unsigned = new FakeReleaseTools({ signatureDetail: validSignature().replace('Timestamp=', 'NoTimestamp=') })
    await expect(verifyReleaseAppZip(fixture.options, { runTool: unsigned.run }))
      .rejects.toMatchObject({ code: 'distribution-signature' })

    const wrongArchitecture = new FakeReleaseTools({ architectures: 'x86_64\n' })
    await expect(verifyReleaseAppZip(fixture.options, { runTool: wrongArchitecture.run }))
      .rejects.toMatchObject({ code: 'architectures' })
  })

  it('rejects an extracted symlink that is absolute or escapes the app bundle', async () => {
    const fixture = await createFixture()
    const tools = new FakeReleaseTools({ escapingSymlink: true })
    await expect(verifyReleaseAppZip(fixture.options, { runTool: tools.run }))
      .rejects.toMatchObject({ code: 'extracted-shape' })
    expect(tools.requests.some((request) => request.executable === '/usr/bin/codesign'))
      .toBe(false)
  })

  it('rejects replacement of the verified ZIP while trust checks are running', async () => {
    const fixture = await createFixture()
    const tools = new FakeReleaseTools({ mutateArchive: true })
    await expect(verifyReleaseAppZip(fixture.options, { runTool: tools.run }))
      .rejects.toMatchObject({ code: 'artifact-changed' })
  })

  it('keeps create, checksum, exact verifier arguments, and publish in one workflow path', async () => {
    const workflow = await readFile(resolve('.github/workflows/release.yml'), 'utf8')
    const createIndex = workflow.indexOf('Create exact signed app update asset')
    const checksumIndex = workflow.indexOf('shasum -a 256')
    const verifyIndex = workflow.indexOf('Verify signed release artifacts')
    const publishIndex = workflow.indexOf('Publish immutable GitHub release assets')
    const publishChecksumIndex = workflow.indexOf('shasum -a 256 -c SHA256SUMS')
    const uploadIndex = workflow.indexOf('gh release create "$RELEASE_TAG"')
    expect(createIndex).toBeGreaterThan(-1)
    expect(checksumIndex).toBeGreaterThan(createIndex)
    expect(verifyIndex).toBeGreaterThan(checksumIndex)
    expect(publishIndex).toBeGreaterThan(verifyIndex)
    expect(publishChecksumIndex).toBeGreaterThan(publishIndex)
    expect(uploadIndex).toBeGreaterThan(publishChecksumIndex)
    expect(workflow).toContain('npm run verify:package --')
    expect(workflow).toContain('"dist/GrokBuild-Electron-${RELEASE_TAG}.app.zip"')
    expect(workflow).toContain('"dist/SHA256SUMS"')
    expect(workflow.match(/GrokBuild-Electron-\$\{RELEASE_TAG\}\.app\.zip/g)?.length)
      .toBeGreaterThanOrEqual(4)
  })

  it('runs packaged smoke on a separate secret-free runner and scrubs signing material', async () => {
    const workflow = await readFile(resolve('.github/workflows/release.yml'), 'utf8')
    const smokeJobIndex = workflow.indexOf('unsigned-package-smoke:')
    const releaseJobIndex = workflow.indexOf('\n  release:')
    const smokeIndex = workflow.indexOf('npm run smoke:package')
    const signingIndex = workflow.indexOf('Sign, notarize, and staple release artifacts')
    expect(smokeJobIndex).toBeGreaterThan(-1)
    expect(releaseJobIndex).toBeGreaterThan(smokeJobIndex)
    expect(smokeIndex).toBeGreaterThan(smokeJobIndex)
    expect(smokeIndex).toBeLessThan(releaseJobIndex)
    expect(signingIndex).toBeGreaterThan(releaseJobIndex)
    expect(workflow.match(/npm run smoke:package/g)).toHaveLength(1)
    expect(workflow.slice(releaseJobIndex)).not.toContain('npm run smoke:package')
    expect(workflow).toContain('needs: unsigned-package-smoke')
    expect(workflow).toContain("APP_BUILDER_TMP_DIR: ${{ runner.temp }}/grokbuild-signing")
    expect(workflow).toContain('if: always()')
    expect(workflow).toContain('security delete-keychain')
    expect(workflow).toContain('rm -f -- "$RUNNER_TEMP/AuthKey.p8"')
    expect(workflow).toContain('test ! -e "$RUNNER_TEMP/AuthKey.p8"')
    expect(workflow).toContain('test ! -e "$signing_dir"')
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2)
    expect(workflow).toContain('permissions:\n  contents: read')
  })

  it('derives the unsigned DMG verifier path from the package version', async () => {
    const verifier = await readFile(resolve('scripts/qa/verify-macos-package.mjs'), 'utf8')
    expect(verifier).toContain('GrokBuild-Electron-${manifest.version}-arm64.dmg')
    expect(verifier).not.toContain('GrokBuild-Electron-0.1.0-arm64.dmg')
  })
})

class FakeReleaseTools {
  readonly requests: Array<{ executable: string; args: readonly string[] }> = []
  private readonly archiveNames: string
  private readonly archiveLongListing: string
  private readonly signatureDetail: string
  private readonly architectures: string

  constructor(options: {
    archiveNames?: string
    signatureDetail?: string
    architectures?: string
    escapingSymlink?: boolean
    mutateArchive?: boolean
  } = {}) {
    const entries = defaultArchiveEntries()
    this.archiveNames = options.archiveNames ?? entries
      .map((entry) => entry.path)
      .join('\n').concat('\n')
    this.archiveLongListing = longListing(entries)
    this.signatureDetail = options.signatureDetail ?? validSignature()
    this.architectures = options.architectures ?? 'arm64\n'
    this.escapingSymlink = options.escapingSymlink ?? false
    this.mutateArchive = options.mutateArchive ?? false
  }

  readonly run = async (
    executable: string,
    args: readonly string[]
  ): Promise<ReleaseAppZipToolResult> => {
    this.requests.push({ executable, args: [...args] })
    if (executable === '/usr/bin/zipinfo') {
      return { stdout: args[0] === '-l' ? this.archiveLongListing : this.archiveNames }
    }
    if (executable === '/usr/bin/ditto') {
      const destination = args[3]
      if (!destination) throw new Error('missing destination')
      const appPath = join(destination, APP_BUNDLE)
      await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true })
      await writeFile(join(appPath, 'Contents', 'Info.plist'), 'fixture')
      await writeFile(join(appPath, 'Contents', 'MacOS', APP_NAME), 'fixture')
      if (this.escapingSymlink) {
        await symlink(tmpdir(), join(appPath, 'Contents', 'escape'))
      }
      return { stdout: '' }
    }
    if (executable === '/usr/bin/codesign' && args[0] === '-d' && args[1] === '-r-') {
      return { stderr: `designated => ${DESIGNATED_REQUIREMENT}\n` }
    }
    if (executable === '/usr/bin/codesign' && args[0] === '-d') {
      return { stderr: this.signatureDetail }
    }
    if (executable === '/usr/bin/plutil') {
      const key = args[1]
      const values: Record<string, string> = {
        CFBundleIdentifier: BUNDLE_ID,
        CFBundleName: APP_NAME,
        CFBundleShortVersionString: VERSION,
        CFBundleVersion: VERSION,
        CFBundleExecutable: APP_NAME
      }
      return { stdout: `${values[key ?? ''] ?? ''}\n` }
    }
    if (executable === '/usr/bin/lipo') {
      if (this.mutateArchive) {
        const archivePath = this.requests.find((request) =>
          request.executable === '/usr/bin/zipinfo' && request.args[0] === '-1'
        )?.args[1]
        if (!archivePath) throw new Error('missing archive path')
        await writeFile(archivePath, 'replaced during verification')
      }
      return { stdout: this.architectures }
    }
    return { stdout: '', stderr: '' }
  }

  private readonly escapingSymlink: boolean
  private readonly mutateArchive: boolean
}

async function createFixture(): Promise<{
  options: ReleaseAppZipVerifierOptions
  digest: string
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grokbuild-release-zip-test-')))
  roots.push(root)
  const archivePath = join(root, ARCHIVE_NAME)
  const archiveBytes = Buffer.from('exact release archive bytes')
  await writeFile(archivePath, archiveBytes)
  const digest = createHash('sha256').update(archiveBytes).digest('hex')
  const checksumsPath = join(root, 'SHA256SUMS')
  await writeFile(
    checksumsPath,
    `${digest}  ${ARCHIVE_NAME}\n${'b'.repeat(64)}  GrokBuild-Electron-${VERSION}-arm64.dmg\n`
  )
  const sourceAppPath = join(root, 'source', APP_BUNDLE)
  await mkdir(sourceAppPath, { recursive: true })
  return {
    options: {
      archivePath,
      archiveName: ARCHIVE_NAME,
      checksumsPath,
      sourceAppPath,
      appName: APP_NAME,
      bundleId: BUNDLE_ID,
      version: VERSION,
      bundleVersion: VERSION,
      teamId: TEAM_ID,
      architectures: ['arm64']
    },
    digest
  }
}

async function createDittoFixture(): Promise<{
  options: ReleaseAppZipVerifierOptions
  digest: string
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grokbuild-release-ditto-test-')))
  roots.push(root)
  const sourceAppPath = join(root, 'source', APP_BUNDLE)
  await mkdir(join(sourceAppPath, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(sourceAppPath, 'Contents', 'Info.plist'), 'fixture')
  await writeFile(join(sourceAppPath, 'Contents', 'MacOS', APP_NAME), 'fixture')
  await symlink(APP_NAME, join(sourceAppPath, 'Contents', 'MacOS', 'current'))
  const archivePath = join(root, ARCHIVE_NAME)
  await execFileAsync('/usr/bin/ditto', [
    '-c', '-k', '--sequesterRsrc', '--keepParent', sourceAppPath, archivePath
  ])
  const archiveBytes = await readFile(archivePath)
  const digest = createHash('sha256').update(archiveBytes).digest('hex')
  const checksumsPath = join(root, 'SHA256SUMS')
  await writeFile(checksumsPath, `${digest}  ${ARCHIVE_NAME}\n`)
  return {
    options: {
      archivePath,
      archiveName: ARCHIVE_NAME,
      checksumsPath,
      sourceAppPath,
      appName: APP_NAME,
      bundleId: BUNDLE_ID,
      version: VERSION,
      bundleVersion: VERSION,
      teamId: TEAM_ID,
      architectures: ['arm64']
    },
    digest
  }
}

function validSignature(): string {
  return [
    `Identifier=${BUNDLE_ID}`,
    'flags=0x10000(runtime)',
    `Authority=Developer ID Application: QA Fixture (${TEAM_ID})`,
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    'Timestamp=Aug 25, 2026 at 12:00:00',
    `TeamIdentifier=${TEAM_ID}`,
    ''
  ].join('\n')
}

function defaultArchiveEntries(): Array<{
  path: string
  kind: '-' | 'd' | 'l'
  bytes: number
}> {
  return [
    { path: `${APP_BUNDLE}/`, kind: 'd', bytes: 0 },
    { path: `${APP_BUNDLE}/Contents/`, kind: 'd', bytes: 0 },
    { path: `${APP_BUNDLE}/Contents/Info.plist`, kind: '-', bytes: 7 },
    { path: `${APP_BUNDLE}/Contents/MacOS/`, kind: 'd', bytes: 0 },
    { path: `${APP_BUNDLE}/Contents/MacOS/${APP_NAME}`, kind: '-', bytes: 7 }
  ]
}

function longListing(entries: ReturnType<typeof defaultArchiveEntries>): string {
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  return [
    'Archive:  release.app.zip',
    `Zip file size: 1024 bytes, number of entries: ${entries.length}`,
    ...entries.map((entry) => {
      const permissions = entry.kind === 'd'
        ? 'drwxr-xr-x'
        : entry.kind === 'l'
          ? 'lrwxr-xr-x'
          : '-rw-r--r--'
      return `${permissions}  2.1 unx ${entry.bytes} b- ${entry.bytes} stor 26-Aug-25 03:47 ${entry.path}`
    }),
    `${entries.length} files, ${bytes} bytes uncompressed, ${bytes} bytes compressed:  0.0%`,
    ''
  ].join('\n')
}

expect(ReleaseAppZipVerificationError).toBeTypeOf('function')
