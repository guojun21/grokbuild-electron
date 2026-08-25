const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const productName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${productName}.app`)
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  const executablePath = join(appPath, 'Contents', 'MacOS', productName)

  for (const key of [
    'NSAppTransportSecurity',
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription'
  ]) {
    spawnSync('/usr/bin/plutil', ['-remove', key, plistPath], { stdio: 'ignore' })
  }

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Electron 43's stock macOS distribution has no browser-specific snapshot file.
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true
  })
}
