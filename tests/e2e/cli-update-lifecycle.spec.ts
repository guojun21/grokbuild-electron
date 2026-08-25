import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('waits for an in-flight CLI updater and exact verification before quitting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-cli-update-lifecycle-'))
  const profile = join(root, 'profile')
  const workspace = join(root, 'workspace')
  const updateState = join(root, 'updated-version.txt')
  const updateStarted = join(root, 'update-started.marker')
  const updateLog = join(root, 'update.ndjson')
  const transcript = join(root, 'rpc.ndjson')
  await mkdir(profile, { mode: 0o700 })
  await mkdir(workspace, { mode: 0o700 })

  let application: ElectronApplication | undefined
  let closed = false
  try {
    application = await electron.launch({
      args: ['.'],
      cwd: resolve('.'),
      env: {
        ...process.env,
        GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
        GROKBUILD_USER_DATA_DIR: profile,
        GROKBUILD_E2E_PROJECT_PATH: workspace,
        GROKBUILD_E2E: '1',
        GROKBUILD_MOCK_TRANSCRIPT: transcript,
        GROKBUILD_MOCK_UPDATE_CWD_LOG: updateLog,
        GROKBUILD_MOCK_UPDATE_STATE: updateState,
        GROKBUILD_MOCK_UPDATE_STARTED_MARKER: updateStarted,
        GROKBUILD_MOCK_UPDATE_DELAY_MS: '1500',
        TZ: 'UTC',
        LANG: 'en_US.UTF-8'
      }
    })
    const page = await application.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await createSettledSession(page)
    await expect.poll(() => selectedSessionStatus(page)).toBe('idle')
    await confirmCliUpdate(application)

    await page.locator('.settings-row').click()
    await page.getByRole('button', { name: 'Updates', exact: true }).click()
    const settings = page.getByTestId('update-settings')
    await settings.getByRole('button', { name: 'Check now' }).click()
    await expect(settings.getByRole('button', { name: 'Install CLI update' })).toBeVisible()
    await settings.getByRole('button', { name: 'Install CLI update' }).click()

    await expect.poll(async () => {
      try {
        return await readFile(updateStarted, 'utf8')
      } catch {
        return undefined
      }
    }).toBe('started\n')
    const closePromise = new Promise<void>((resolveClose) => {
      application!.once('close', () => {
        closed = true
        resolveClose()
      })
    })
    await application.evaluate(({ app }) => app.quit())

    // The updater is still inside its deterministic delay. before-quit must
    // keep the Electron main process alive instead of orphaning the detached
    // child or reconnecting through an unverified executable.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    expect(application.process().exitCode).toBeNull()
    await expectPathAbsent(updateState)

    await closePromise
    await expect.poll(() => readFile(updateState, 'utf8')).toBe('1.0.6\n')
    const calls = (await readFile(updateLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[] })
    expect(calls.map((entry) => entry.args)).toEqual([
      ['update', '--check', '--json'],
      ['update', '--check', '--json'],
      ['update', '--version', '1.0.6'],
      ['update', '--check', '--json']
    ])

    const rpc = (await readFile(transcript, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { frame?: { method?: string } })
    expect(rpc.filter((entry) => entry.frame?.method === 'initialize')).toHaveLength(1)
  } finally {
    if (!closed) await application?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

async function createSettledSession(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const bridge = (globalThis as unknown as {
      grokbuild: {
        bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot>
        createSession: (input: { projectId: string }) => Promise<{ id: string }>
        sendPrompt: (input: { sessionId: string; text: string }) => Promise<void>
      }
    }).grokbuild
    const snapshot = await bridge.bootstrap()
    if (!snapshot.selectedProjectId) throw new Error('Expected a selected E2E project.')
    const session = await bridge.createSession({ projectId: snapshot.selectedProjectId })
    await bridge.sendPrompt({ sessionId: session.id, text: 'settle before CLI update' })
  })
}

async function selectedSessionStatus(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const bridge = (globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }).grokbuild
    const snapshot = await bridge.bootstrap()
    return snapshot.sessions.find((session) => session.id === snapshot.selectedSessionId)?.status
  })
}

async function confirmCliUpdate(application: ElectronApplication): Promise<void> {
  await application.evaluate(({ dialog }) => {
    const mutableDialog = dialog as unknown as {
      showMessageBox: (...args: unknown[]) => Promise<{
        response: number
        checkboxChecked: boolean
      }>
    }
    mutableDialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
}

async function expectPathAbsent(path: string): Promise<void> {
  try {
    await access(path)
    throw new Error('Expected path to remain absent.')
  } catch (error) {
    if (error instanceof Error && error.message === 'Expected path to remain absent.') throw error
  }
}
