import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { createPackagedSmokeEnvironment } from './lib/packaged-smoke-environment.mjs'

const root = resolve(import.meta.dirname, '../..')
const executable = resolve(
  process.argv[2] ?? join(root, 'dist/mac-arm64/GrokBuild Electron.app/Contents/MacOS/GrokBuild Electron')
)
const temporary = await mkdtemp(join(tmpdir(), 'grokbuild-packaged-smoke-'))
const workspace = join(temporary, 'workspace')
const transcript = join(temporary, 'rpc.ndjson')
await Promise.all([
  mkdir(workspace),
  mkdir(join(temporary, 'home')),
  mkdir(join(temporary, 'tmp'))
])
const port = await availablePort()
let stderr = ''
const child = spawn(executable, [
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*'
], {
  env: createPackagedSmokeEnvironment({
    temporaryRoot: temporary,
    workspacePath: workspace,
    transcriptPath: transcript,
    cliPath: resolve(root, 'qa/mock-grok.mjs'),
    nodeExecutable: process.execPath
  }),
  stdio: ['ignore', 'ignore', 'pipe']
})
child.stderr.on('data', (chunk) => {
  stderr = `${stderr}${chunk.toString('utf8')}`.slice(-64 * 1024)
})

let browser
try {
  await waitForDebugger(port, 20_000)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser.contexts().flatMap((context) => context.pages())[0]
  if (!page) throw new Error('Packaged Electron renderer was not visible over CDP')
  await page.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: 'New chat' }).last().click()
  await page.getByTestId('prompt-input').fill('Run the packaged QA contract')
  await page.getByTestId('send-prompt').click()
  await page.getByText('GROKBUILD_QA_OK').waitFor({ state: 'visible', timeout: 15_000 })
  const rpc = await readFile(transcript, 'utf8')
  if (!rpc.includes('session/prompt') || !rpc.includes('GROKBUILD_QA_OK')) {
    throw new Error('Packaged ACP transcript did not contain the expected request and response')
  }
  await page.close()
  console.log('Packaged ASAR application completed a mock ACP turn through its utilityProcess.')
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`)
} finally {
  await browser?.close().catch(() => undefined)
  await stopProcess(child)
  await rm(temporary, { recursive: true, force: true })
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a debug port')
  await new Promise((resolveClose) => server.close(resolveClose))
  return address.port
}

async function waitForDebugger(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {
      // The packaged app is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the packaged renderer debug endpoint')
}

async function stopProcess(processHandle) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return
  const exited = new Promise((resolveExit) => processHandle.once('exit', resolveExit))
  processHandle.kill('SIGTERM')
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), 3_000))
  ])
  if (!stopped) processHandle.kill('SIGKILL')
}
