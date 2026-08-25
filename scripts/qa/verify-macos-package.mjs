import { execFile } from 'node:child_process'
import { access, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { verifyReleaseAppZip } from './lib/release-app-zip-verifier.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (
  typeof manifest.version !== 'string' ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(manifest.version)
) {
  throw new Error('Package manifest contains an invalid release version')
}
const appPath = resolve(process.argv[2] ?? join(root, 'dist/mac-arm64/GrokBuild Electron.app'))
const dmgPath = resolve(
  process.argv[3] ?? join(root, `dist/GrokBuild-Electron-${manifest.version}-arm64.dmg`)
)
const releaseZipPath = process.argv[4] ? resolve(process.argv[4]) : undefined
const checksumsPath = process.argv[5] ? resolve(process.argv[5]) : undefined
const executablePath = join(appPath, 'Contents/MacOS/GrokBuild Electron')
const plistPath = join(appPath, 'Contents/Info.plist')
const updateFeedPath = join(appPath, 'Contents/Resources/update-feed.json')

await Promise.all([
  access(executablePath),
  access(join(appPath, 'Contents/Resources/app.asar')),
  access(join(appPath, 'Contents/Resources/LICENSE')),
  access(join(appPath, 'Contents/Resources/NOTICE')),
  access(join(appPath, 'Contents/Resources/THIRD_PARTY_NOTICES.md')),
  access(updateFeedPath),
  access(dmgPath)
])

const asarInfo = await stat(join(appPath, 'Contents/Resources/app.asar'))
if (asarInfo.size > 16 * 1024 * 1024) {
  throw new Error(`Packaged ASAR is unexpectedly large: ${asarInfo.size} bytes`)
}

const updateFeed = JSON.parse(await readFile(updateFeedPath, 'utf8'))
if (
  !updateFeed || typeof updateFeed !== 'object' || Array.isArray(updateFeed) ||
  Object.keys(updateFeed).some((key) => key !== 'releasesUrl') ||
  !(updateFeed.releasesUrl === null || (
    typeof updateFeed.releasesUrl === 'string' &&
    /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/releases$/.test(updateFeed.releasesUrl)
  ))
) {
  throw new Error('Packaged production update feed is invalid')
}

const expectedFuses = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE]
])
const fuseWire = await getCurrentFuseWire(executablePath)
for (const [option, expected] of expectedFuses) {
  if (fuseWire[option] !== expected) {
    throw new Error(`Unexpected ${FuseV1Options[option]} fuse: ${String(fuseWire[option])}`)
  }
}

for (const key of [
  'NSAppTransportSecurity',
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription'
]) {
  const result = await execFileResult('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plistPath])
  if (result.ok) throw new Error(`Unused or over-broad Info.plist capability remains: ${key}`)
}

const identifier = await execFileAsync('/usr/bin/plutil', [
  '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plistPath
])
if (identifier.stdout.trim() !== 'com.oasmet.grokbuild-electron') {
  throw new Error(`Unexpected bundle identifier: ${identifier.stdout.trim()}`)
}
for (const [key, expected] of [
  ['CFBundleName', 'GrokBuild Electron'],
  ['CFBundleExecutable', 'GrokBuild Electron'],
  ['CFBundleShortVersionString', manifest.version],
  ['CFBundleVersion', manifest.version]
]) {
  const value = await execFileAsync('/usr/bin/plutil', [
    '-extract', key, 'raw', '-o', '-', plistPath
  ])
  if (value.stdout.trim() !== expected) {
    throw new Error(`Unexpected ${key}: ${value.stdout.trim()}`)
  }
}
const integrity = await execFileResult('/usr/bin/plutil', [
  '-extract', 'ElectronAsarIntegrity', 'json', '-o', '-', plistPath
])
if (!integrity.ok) throw new Error('Electron ASAR integrity metadata is missing')

const architecture = await execFileAsync('/usr/bin/lipo', ['-archs', executablePath])
if (architecture.stdout.trim() !== 'arm64') {
  throw new Error(`Unexpected packaged architectures: ${architecture.stdout.trim()}`)
}
await execFileAsync('/usr/bin/hdiutil', ['verify', dmgPath], { maxBuffer: 8 * 1024 * 1024 })

if (process.env.GROKBUILD_REQUIRE_SIGNED === '1') {
  if (!releaseZipPath || !checksumsPath) {
    throw new Error('Signed verification requires the exact release .app.zip and SHA256SUMS paths')
  }
  await Promise.all([access(releaseZipPath), access(checksumsPath)])
  const releaseRepository = process.env.GITHUB_REPOSITORY
  if (
    !releaseRepository ||
    updateFeed.releasesUrl !== `https://api.github.com/repos/${releaseRepository}/releases`
  ) {
    throw new Error('Signed package does not contain its release repository feed')
  }
  await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', dmgPath])
  const signature = await execFileAsync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath])
  const signatureDetail = `${signature.stdout ?? ''}\n${signature.stderr ?? ''}`
  if (!/flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/i.test(signatureDetail)) {
    throw new Error('Signed application does not have the hardened runtime flag')
  }
  const expectedTeamId = process.env.GROKBUILD_EXPECTED_TEAM_ID
  if (!expectedTeamId || !/^[A-Z0-9]{10}$/.test(expectedTeamId)) {
    throw new Error('GROKBUILD_EXPECTED_TEAM_ID is required for signed verification')
  }
  if (!signatureDetail.includes(`TeamIdentifier=${expectedTeamId}`)) {
    throw new Error('Signed application Team ID does not match the release identity')
  }
  const entitlements = await execFileAsync('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath])
  const entitlementDetail = `${entitlements.stdout ?? ''}\n${entitlements.stderr ?? ''}`
  if (entitlementDetail.includes('com.apple.security.device.audio-input')) {
    throw new Error('Unexpected microphone entitlement in a build without voice input')
  }
  await execFileAsync('/usr/sbin/spctl', ['-a', '-vv', '-t', 'exec', appPath])
  await execFileAsync('/usr/bin/xcrun', ['stapler', 'validate', appPath])
  await execFileAsync('/usr/bin/xcrun', ['stapler', 'validate', dmgPath])
  const releaseArchive = await verifyReleaseAppZip({
    archivePath: releaseZipPath,
    archiveName: `GrokBuild-Electron-v${manifest.version}.app.zip`,
    checksumsPath,
    sourceAppPath: appPath,
    appName: 'GrokBuild Electron',
    bundleId: 'com.oasmet.grokbuild-electron',
    version: manifest.version,
    bundleVersion: manifest.version,
    teamId: expectedTeamId,
    architectures: ['arm64']
  })
  console.log(
    `Exact signed update archive verified: ${releaseArchive.archiveName} (${releaseArchive.sha256})`
  )
}

console.log(`macOS package shape, all 9 Electron fuses, ASAR integrity, resources and DMG verified: ${appPath}`)

async function execFileResult(file, args) {
  try {
    const result = await execFileAsync(file, args)
    return { ok: true, stdout: result.stdout }
  } catch (error) {
    return { ok: false, stdout: error?.stdout ?? '' }
  }
}
