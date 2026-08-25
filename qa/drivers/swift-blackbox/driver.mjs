import { spawn, spawnSync } from 'node:child_process'
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import {
  PERMISSION_BLOCKED_EXIT,
  SWIFT_QA_BUNDLE_ID,
  blockedManifest,
  canonicalWindowMetadata,
  canonicalizeAxTree,
  canonicalizePreferences,
  canonicalizeRpcTranscript,
  classifyAccessibilityProbe,
  classifyScreenRecordingProbe,
  sha256
} from './lib.mjs'

const root = resolve(import.meta.dirname, '../../..')
const referenceRoot = resolve(root, '.reference/grok-build-desktop')
const axDriver = resolve(import.meta.dirname, 'ax-driver.jxa')
const macosProbe = resolve(import.meta.dirname, 'macos-probe.swift')
const defaultScenario = resolve(root, 'qa/scenarios/p0/stream-rich.json')

export async function runSwiftBlackbox(rawArguments = process.argv.slice(2)) {
  const options = parseArguments(rawArguments)
  if (options.help) {
    process.stdout.write(helpText())
    return 0
  }

  const upstream = JSON.parse(await readFile(resolve(root, 'reference/upstream.json'), 'utf8'))
  const outputRoot = options.output ?? resolve(
    root,
    'test-results/swift-blackbox',
    new Date().toISOString().replace(/[:.]/g, '-')
  )
  await ensureFreshOutput(outputRoot)
  await mkdir(outputRoot, { recursive: true })

  const reference = {
    tag: upstream.tag,
    commit: upstream.commit,
    version: '0.3.2',
    bundleId: SWIFT_QA_BUNDLE_ID
  }
  const preflight = await runPreflight()
  await writeJson(resolve(outputRoot, 'preflight.json'), preflight)
  const reasons = [preflight.accessibility, preflight.screenRecording]
    .filter((result, index, values) =>
      !result.granted && values.findIndex((candidate) => candidate.code === result.code) === index
    )

  if (reasons.length > 0) {
    const manifest = blockedManifest({
      reasons,
      reference,
      outputDirectory: outputRoot
    })
    await writeJson(resolve(outputRoot, 'manifest.json'), manifest)
    for (const reason of reasons) {
      process.stderr.write(`Swift black-box QA blocked [${reason.code}]: ${reason.reason}\n`)
      process.stderr.write(`${reason.remediation}\n`)
    }
    process.stderr.write(`Blocked evidence: ${resolve(outputRoot, 'manifest.json')}\n`)
    return PERMISSION_BLOCKED_EXIT
  }

  if (options.preflightOnly) {
    await writeJson(resolve(outputRoot, 'manifest.json'), {
      schemaVersion: 1,
      driver: 'swift-blackbox-ax',
      status: 'preflight-passed',
      evidence: 'permissions-only',
      reference,
      stages: [],
      outputDirectory: outputRoot
    })
    process.stdout.write(`Swift black-box permission preflight passed. Evidence: ${outputRoot}\n`)
    return 0
  }

  const scenarioPath = options.scenario ?? defaultScenario
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'))
  if (scenario.reference?.swiftCommit !== upstream.commit) {
    throw new Error(`Scenario ${scenario.id ?? '<unknown>'} is not pinned to ${upstream.commit}`)
  }
  const prompt = scenario.steps?.find((step) => step.action?.driver === 'sendPrompt')?.action?.text
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error(`Scenario ${scenario.id ?? '<unknown>'} has no sendPrompt action`)
  }

  const paths = await prepareRunDirectories(outputRoot)
  const roots = canonicalRoots(paths)
  let application
  let preferencesPrepared = false
  try {
    await verifyPinnedReference(upstream)
    const appBundle = await buildQaBundle(paths, reference)
    await installIsolatedMock(paths, scenarioPath)
    await prepareQaPreferences(paths)
    preferencesPrepared = true

    application = await launchApplication(appBundle, paths, scenarioPath)
    await waitForAxText(application.pid, 'Add Project', options.timeoutMs, 'boot-ready')
    await captureAxStage(application.pid, '01-boot-ready', paths, roots)

    await axCommand('click', application.pid, 'Add Project')
    await waitForAxText(application.pid, 'Choose Project Folder', options.timeoutMs, 'project picker')
    await axCommand('click', application.pid, 'Choose Folder')
    await waitForAxText(application.pid, 'Select the project folder', options.timeoutMs, 'native folder chooser')
    await axCommand('choose-folder', application.pid, paths.workspace)
    await waitForAxText(application.pid, paths.workspace, options.timeoutMs, 'selected project path')
    await axCommand('click', application.pid, 'Use Project')
    await waitForAxText(application.pid, basename(paths.workspace), options.timeoutMs, 'project added')
    await waitForAxText(application.pid, 'Plan, Build', options.timeoutMs, 'project composer')
    await captureAxStage(application.pid, '02-project-added', paths, roots)

    await axCommand('new-session', application.pid)
    await waitForAxText(application.pid, 'Plan, Build', options.timeoutMs, 'new session composer')
    await captureAxStage(application.pid, '03-new-session', paths, roots)

    await axCommand('set-text', application.pid, 'Plan, Build', prompt)
    await axCommand('submit', application.pid)
    await waitForRpcPrompt(paths.rpcTranscript, options.timeoutMs)
    await waitForAxText(application.pid, 'GROKBUILD_QA_OK', options.timeoutMs, 'prompt completion')
    await captureAxStage(application.pid, '04-prompt-complete', paths, roots)
    const screenshot = await captureWindow(application.pid, '04-prompt-complete', paths)

    await axCommand('quit', application.pid).catch(() => undefined)
    await waitForProcessExit(application.child, 8_000)
    application = undefined

    const rpc = await collectRpc(paths, roots)
    const preferences = await collectPreferences(paths, roots)
    const canonicalManifest = {
      schemaVersion: 1,
      driver: 'swift-blackbox-ax',
      status: 'passed',
      reference,
      scenario: scenario.id,
      stages: [
        '01-boot-ready',
        '02-project-added',
        '03-new-session',
        '04-prompt-complete'
      ],
      artifacts: {
        accessibility: 'canonical/*.ax.json',
        rpc: 'canonical/rpc.json',
        preferences: 'canonical/preferences.json',
        screenshot: 'canonical/04-prompt-complete.window.png',
        window: 'canonical/04-prompt-complete.window.json'
      },
      evidence: {
        rpcEntries: rpc.length,
        preferenceKeys: Object.keys(preferences ?? {}).length,
        screenshotSha256: screenshot.sha256
      }
    }
    await writeJson(resolve(paths.canonical, 'manifest.json'), canonicalManifest)
    await writeJson(resolve(outputRoot, 'manifest.json'), {
      ...canonicalManifest,
      outputDirectory: outputRoot,
      appBundle
    })
    process.stdout.write(`Swift black-box QA passed. Canonical artifacts: ${paths.canonical}\n`)
    return 0
  } catch (error) {
    await writeJson(resolve(outputRoot, 'manifest.json'), {
      schemaVersion: 1,
      driver: 'swift-blackbox-ax',
      status: 'failed',
      exitCode: 1,
      reference,
      outputDirectory: outputRoot,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  } finally {
    if (application) {
      application.child.kill('SIGTERM')
      await waitForProcessExit(application.child, 2_000).catch(() => undefined)
      if (application.child.exitCode === null) application.child.kill('SIGKILL')
    }
    if (preferencesPrepared) {
      await runCommand('/usr/bin/defaults', ['delete', SWIFT_QA_BUNDLE_ID], {
        allowFailure: true,
        env: isolatedProfileEnvironment(paths)
      })
    }
  }
}

async function runPreflight() {
  if (process.platform !== 'darwin') {
    const unavailable = {
      granted: false,
      code: 'macos-required',
      reason: `Swift AX black-box QA requires macOS; current platform is ${process.platform}.`,
      remediation: 'Run this opt-in command on a macOS host with a logged-in graphical session.'
    }
    return { platform: process.platform, accessibility: unavailable, screenRecording: unavailable }
  }
  const accessibilityProbe = spawnSync(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', axDriver, 'preflight'],
    { encoding: 'utf8', timeout: 15_000 }
  )
  const screenProbe = spawnSync(
    '/usr/bin/swift',
    [macosProbe, 'screen'],
    { encoding: 'utf8', timeout: 30_000 }
  )
  return {
    platform: process.platform,
    accessibility: classifyAccessibilityProbe(toProbe(accessibilityProbe)),
    screenRecording: classifyScreenRecordingProbe(toProbe(screenProbe))
  }
}

async function verifyPinnedReference(upstream) {
  await accessExecutable('/usr/bin/swift')
  const actual = (await runCommand('/usr/bin/git', ['-C', referenceRoot, 'rev-parse', 'HEAD'])).stdout.trim()
  if (actual !== upstream.commit) throw new Error(`Pinned Swift reference mismatch: expected ${upstream.commit}, got ${actual}`)
  const version = (await readFile(resolve(referenceRoot, 'VERSION'), 'utf8')).trim()
  if (version !== '0.3.2' || upstream.tag !== 'v0.3.2') {
    throw new Error(`Swift black-box driver requires pinned v0.3.2, found tag ${upstream.tag} version ${version}`)
  }
}

async function buildQaBundle(paths, reference) {
  await runCommand('/usr/bin/swift', ['build', '-c', 'release', '--package-path', referenceRoot], {
    timeoutMs: 20 * 60_000,
    logPrefix: 'swift build'
  })
  const binPath = (await runCommand(
    '/usr/bin/swift',
    ['build', '-c', 'release', '--show-bin-path', '--package-path', referenceRoot]
  )).stdout.trim()
  const binary = resolve(binPath, 'GrokBuild')
  await accessExecutable(binary)

  const appBundle = resolve(paths.app, 'GrokBuild Swift QA.app')
  const contents = resolve(appBundle, 'Contents')
  const macos = resolve(contents, 'MacOS')
  const resources = resolve(contents, 'Resources')
  await mkdir(macos, { recursive: true })
  await mkdir(resources, { recursive: true })
  await copyFile(binary, resolve(macos, 'GrokBuild'))
  await chmod(resolve(macos, 'GrokBuild'), 0o755)

  for (const entry of await readdir(binPath, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.bundle')) {
      await cp(resolve(binPath, entry.name), resolve(appBundle, entry.name), { recursive: true })
    }
  }
  const icon = resolve(referenceRoot, 'AppIcon.png')
  await copyFile(icon, resolve(resources, 'AppIcon.png')).catch(() => undefined)
  await writeFile(resolve(contents, 'Info.plist'), infoPlist(reference), 'utf8')
  await runCommand('/usr/bin/plutil', ['-lint', resolve(contents, 'Info.plist')])
  await runCommand('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--identifier',
    SWIFT_QA_BUNDLE_ID,
    appBundle
  ])
  return appBundle
}

async function installIsolatedMock(paths, scenarioPath) {
  const grokDirectory = resolve(paths.home, '.grok')
  const binDirectory = resolve(grokDirectory, 'bin')
  await mkdir(binDirectory, { recursive: true })
  const mock = resolve(binDirectory, 'grok')
  await copyFile(resolve(root, 'qa/mock-grok.mjs'), mock)
  await chmod(mock, 0o755)
  await writeFile(resolve(grokDirectory, 'auth.json'), '{"blackBoxQa":true}\n', { mode: 0o600 })
  await writeJson(resolve(paths.raw, 'launch-contract.json'), {
    grok: '$GROK_HOME/bin/grok',
    scenario: relative(root, scenarioPath),
    home: '$QA_PROFILE/home',
    bundleId: SWIFT_QA_BUNDLE_ID
  })
}

async function prepareQaPreferences(paths) {
  const env = isolatedProfileEnvironment(paths)
  await mkdir(resolve(paths.home, 'Library/Preferences'), { recursive: true })
  await runCommand('/usr/bin/defaults', ['delete', SWIFT_QA_BUNDLE_ID], { allowFailure: true, env })
  await runCommand('/usr/bin/defaults', [
    'write', SWIFT_QA_BUNDLE_ID, 'grokbuild.updates.autoCheckEnabled', '-bool', 'false'
  ], { env })
  await runCommand('/usr/bin/defaults', [
    'write', SWIFT_QA_BUNDLE_ID, 'NSAutomaticWindowAnimationsEnabled', '-bool', 'false'
  ], { env })
}

async function launchApplication(appBundle, paths, scenarioPath) {
  const stdoutHandle = await open(resolve(paths.logs, 'app.stdout.log'), 'w')
  const stderrHandle = await open(resolve(paths.logs, 'app.stderr.log'), 'w')
  const executable = resolve(appBundle, 'Contents/MacOS/GrokBuild')
  const child = spawn(executable, [], {
    cwd: paths.workspace,
    env: {
      ...process.env,
      HOME: paths.home,
      CFFIXED_USER_HOME: paths.home,
      PATH: `${resolve(paths.home, '.grok/bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      GROK_CLI_PATH: resolve(paths.home, '.grok/bin/grok'),
      GROKBUILD_MOCK_SCENARIO: scenarioPath,
      GROKBUILD_MOCK_TRANSCRIPT: paths.rpcTranscript,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TZ: 'UTC'
    },
    stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd]
  })
  child.once('exit', () => {
    void stdoutHandle.close()
    void stderrHandle.close()
  })
  if (!child.pid) throw new Error('Swift QA application did not produce a pid')
  return { child, pid: child.pid }
}

async function captureAxStage(pid, name, paths, roots) {
  const tree = await axCommand('snapshot', pid, '3000')
  await writeJson(resolve(paths.raw, `${name}.ax.json`), tree)
  await writeJson(resolve(paths.canonical, `${name}.ax.json`), canonicalizeAxTree(tree, roots))
}

async function captureWindow(pid, name, paths) {
  const result = await runCommand('/usr/bin/swift', [macosProbe, 'windows', String(pid)], { timeoutMs: 30_000 })
  const windows = JSON.parse(result.stdout)
  const target = windows
    .filter((window) => window.layer === 0 && window.onScreen === true)
    .sort((left, right) => area(right) - area(left))[0]
  if (!target?.id) throw new Error(`No on-screen layer-0 window found for Swift app pid ${pid}`)
  await writeJson(resolve(paths.raw, `${name}.window.json`), windows)
  await writeJson(resolve(paths.canonical, `${name}.window.json`), canonicalWindowMetadata(windows))
  const rawScreenshot = resolve(paths.raw, `${name}.window.png`)
  const canonicalScreenshot = resolve(paths.canonical, `${name}.window.png`)
  await runCommand('/usr/sbin/screencapture', ['-x', '-l', String(target.id), rawScreenshot])
  await copyFile(rawScreenshot, canonicalScreenshot)
  const data = await readFile(rawScreenshot)
  return { sha256: sha256(data), bytes: data.length }
}

async function collectRpc(paths, roots) {
  const transcript = await readFile(paths.rpcTranscript, 'utf8')
  const canonical = canonicalizeRpcTranscript(transcript, roots)
  await writeJson(resolve(paths.canonical, 'rpc.json'), canonical)
  return canonical
}

async function collectPreferences(paths, roots) {
  const plist = resolve(paths.raw, 'preferences.plist')
  const json = resolve(paths.raw, 'preferences.json')
  await runCommand('/usr/bin/defaults', ['export', SWIFT_QA_BUNDLE_ID, plist], {
    env: isolatedProfileEnvironment(paths)
  })
  await runCommand('/usr/bin/plutil', ['-convert', 'json', '-o', json, plist])
  const preferences = JSON.parse(await readFile(json, 'utf8'))
  const canonical = canonicalizePreferences(preferences, roots)
  await writeJson(resolve(paths.canonical, 'preferences.json'), canonical)
  return canonical
}

async function axCommand(command, pid, ...arguments_) {
  const result = await runCommand(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', axDriver, command, String(pid), ...arguments_],
    { timeoutMs: 30_000 }
  )
  const text = result.stdout.trim()
  return text ? JSON.parse(text) : {}
}

async function waitForAxText(pid, text, timeoutMs, label) {
  await poll(async () => {
    const result = await axCommand('contains', pid, text)
    return result.found === true
  }, timeoutMs, `Timed out waiting for Swift ${label} AX barrier: ${text}`)
}

async function waitForRpcPrompt(path, timeoutMs) {
  await poll(async () => {
    try {
      const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
      return lines.some((line) => {
        const entry = JSON.parse(line)
        return entry.direction === 'client->agent' && entry.frame?.method === 'session/prompt'
      })
    } catch {
      return false
    }
  }, timeoutMs, 'Timed out waiting for the request-driven mock to receive session/prompt')
}

async function poll(predicate, timeoutMs, timeoutMessage) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(lastError instanceof Error ? `${timeoutMessage}; last error: ${lastError.message}` : timeoutMessage)
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit)
      rejectExit(new Error(`Process ${child.pid ?? '<unknown>'} did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolveExit()
    }
    child.once('exit', onExit)
  })
}

async function prepareRunDirectories(outputRoot) {
  const paths = {
    output: outputRoot,
    raw: resolve(outputRoot, 'raw'),
    canonical: resolve(outputRoot, 'canonical'),
    logs: resolve(outputRoot, 'logs'),
    app: resolve(outputRoot, 'app'),
    home: resolve(outputRoot, 'profile/home'),
    workspace: resolve(outputRoot, 'workspace'),
    rpcTranscript: resolve(outputRoot, 'raw/rpc.ndjson')
  }
  await Promise.all([
    mkdir(paths.raw, { recursive: true }),
    mkdir(paths.canonical, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.app, { recursive: true }),
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.workspace, { recursive: true })
  ])
  await writeFile(resolve(paths.workspace, 'README.md'), '# Swift black-box QA workspace\n', 'utf8')
  await writeFile(resolve(paths.workspace, 'package.json'), '{"name":"swift-black-box-fixture","private":true}\n', 'utf8')
  return paths
}

function canonicalRoots(paths) {
  return {
    '$GROK_HOME': resolve(paths.home, '.grok'),
    '$APP_SUPPORT': resolve(paths.home, 'Library/Application Support/GrokBuild'),
    '$WORKSPACE': paths.workspace,
    '$QA_PROFILE': resolve(paths.output, 'profile'),
    '$REFERENCE': referenceRoot,
    '$TMP': paths.output
  }
}

async function ensureFreshOutput(path) {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error(`Output path exists and is not a directory: ${path}`)
    const entries = await readdir(path)
    if (entries.length > 0) throw new Error(`Refusing to overwrite non-empty output directory: ${path}`)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return
    throw error
  }
}

async function accessExecutable(path) {
  await access(path, fsConstants.X_OK)
}

function isolatedProfileEnvironment(paths) {
  return {
    ...process.env,
    HOME: paths.home,
    CFFIXED_USER_HOME: paths.home
  }
}

async function runCommand(command, arguments_, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, arguments_, { cwd: options.cwd ?? root, env: options.env ?? process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectCommand(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      const result = { status: code, signal, stdout, stderr }
      if (code === 0 || options.allowFailure) {
        resolveCommand(result)
      } else {
        const detail = stderr.trim() || stdout.trim() || `signal ${signal ?? 'none'}`
        rejectCommand(new Error(`${options.logPrefix ?? basename(command)} exited ${code}: ${detail.slice(0, 4_000)}`))
      }
    })
  })
}

function parseArguments(arguments_) {
  const options = { timeoutMs: 45_000 }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--preflight-only') options.preflightOnly = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--output') options.output = resolve(requiredValue(arguments_, ++index, '--output'))
    else if (argument === '--scenario') options.scenario = resolve(requiredValue(arguments_, ++index, '--scenario'))
    else if (argument === '--timeout-seconds') {
      const seconds = Number(requiredValue(arguments_, ++index, '--timeout-seconds'))
      if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) throw new Error('--timeout-seconds must be between 5 and 600')
      options.timeoutMs = seconds * 1_000
    } else {
      throw new Error(`Unknown Swift black-box QA argument: ${argument}`)
    }
  }
  return options
}

function requiredValue(arguments_, index, flag) {
  const value = arguments_[index]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function toProbe(result) {
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? ''
  }
}

function area(window) {
  return Number(window.bounds?.width ?? 0) * Number(window.bounds?.height ?? 0)
}

function infoPlist(reference) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>GrokBuild</string>
  <key>CFBundleIdentifier</key><string>${SWIFT_QA_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>GrokBuild Swift QA</string>
  <key>CFBundleDisplayName</key><string>GrokBuild Swift QA</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${reference.version}</string>
  <key>CFBundleVersion</key><string>${reference.version}</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>QA reference build does not exercise microphone input.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>QA reference build does not exercise speech recognition.</string>
</dict>
</plist>
`
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function helpText() {
  return `Usage: npm run qa:swift-blackbox -- [options]

Options:
  --preflight-only         Check Accessibility and Screen Recording only
  --output PATH            Fresh artifact directory (default: test-results/swift-blackbox/<time>)
  --scenario PATH          Request-driven mock scenario (default: stream-rich)
  --timeout-seconds N      Per-barrier timeout, 5..600 (default: 45)
  --help                   Show this help

Exit codes: 0 passed, 1 failed, ${PERMISSION_BLOCKED_EXIT} permission/platform blocked.
`
}
