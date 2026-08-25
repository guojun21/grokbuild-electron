import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const WORKSPACE_SLUG_CANARY = 'PRIVATE_MEMORY_WORKSPACE_SLUG_5A71'
const SESSION_TITLE_CANARY = 'SESSION_TITLE_CANARY_7C92'
const GLOBAL_CONTENT_CANARY = 'GLOBAL_MEMORY_CONTENT_CANARY_8E43'
const WORKSPACE_CONTENT_CANARY = 'WORKSPACE_MEMORY_CONTENT_CANARY_29B6'
const REMEMBERED_NOTE_CANARY = 'REMEMBERED_NOTE_CANARY_4F18'
const NOTE_DRAFT_CANARY = 'MEMORY_NOTE_DRAFT_CANARY_B037'
const LATE_FEEDBACK_CANARY = 'MEMORY_LATE_FEEDBACK_CANARY_C941'
const HOSTILE_HTML_CANARY = 'MEMORY_HTML_CANARY_630D'
const FIXED_TIME = new Date('2026-08-25T09:30:00.000Z')

test('browses CLI memory and preserves staged, native-confirmed, privacy-safe behavior', async () => {
  test.setTimeout(90_000)
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-electron-memory-e2e-'))
  const profile = join(root, 'profile')
  const memoryRoot = join(profile, 'e2e-grok-memory')
  const workspaceMemoryRoot = join(memoryRoot, WORKSPACE_SLUG_CANARY)
  const sessionsRoot = join(workspaceMemoryRoot, 'sessions')
  const globalMemoryPath = join(memoryRoot, 'MEMORY.md')
  const workspaceMemoryPath = join(workspaceMemoryRoot, 'MEMORY.md')
  const sessionMemoryPath = join(sessionsRoot, `${SESSION_TITLE_CANARY}.md`)
  const indexPath = join(memoryRoot, 'index.sqlite')
  const memoryLockPath = join(memoryRoot, '.grokbuild-memory.lock')
  const workspace = join(root, 'qa-workspace')
  const transcript = join(root, 'rpc.ndjson')
  const statePath = join(profile, 'state.json')
  let app: ElectronApplication | undefined

  await mkdir(profile, { mode: 0o700 })
  await mkdir(memoryRoot, { mode: 0o700 })
  await mkdir(workspaceMemoryRoot, { mode: 0o700 })
  await mkdir(sessionsRoot, { mode: 0o700 })
  await mkdir(workspace, { mode: 0o700 })
  await writeSecureFile(
    globalMemoryPath,
    `# Global compass\n\n${GLOBAL_CONTENT_CANARY}\n\n<script>${HOSTILE_HTML_CANARY}</script>\n`
  )
  await writeSecureFile(
    workspaceMemoryPath,
    `# Workspace conventions\n\n${WORKSPACE_CONTENT_CANARY}\n`
  )
  await writeSecureFile(
    sessionMemoryPath,
    `# Session handoff\n\nA bounded session-only note.\n`
  )
  await writeFile(indexPath, Buffer.from('not-a-real-sqlite-index'), { mode: 0o600 })
  for (const path of [globalMemoryPath, workspaceMemoryPath, sessionMemoryPath, indexPath]) {
    await utimes(path, FIXED_TIME, FIXED_TIME)
    await chmod(path, 0o600)
  }

  try {
    app = await launchFixture({ profile, workspace, transcript })
    let page = await readyPage(app)
    let settings = await openMemorySettings(page)

    await expect(settings.getByRole('region', { name: 'Global memory' })).toContainText('Global memory')
    await expect(settings.getByRole('region', { name: 'Workspaces memory' })).toContainText('Workspace memory')
    await expect(settings.getByRole('region', { name: 'Sessions memory' })).toContainText(SESSION_TITLE_CANARY)
    await expect(settings).not.toContainText('index.sqlite')
    await expect(settings.getByRole('button', { name: 'Remember', exact: true })).toBeDisabled()
    await expect(settings.getByRole('checkbox', { name: 'Use memory in Grok sessions' })).not.toBeChecked()

    const directSummaries = await page.evaluate(() => (
      globalThis as unknown as {
        grokbuild: { listMemory: () => Promise<import('../../src/shared/memory').PublicMemoryFileSummary[]> }
      }
    ).grokbuild.listMemory())
    expect(directSummaries).toHaveLength(3)
    expect(Object.keys(directSummaries[0] ?? {}).sort()).toEqual([
      'byteLength', 'canDelete', 'modifiedAt', 'scope', 'title', 'token'
    ])
    expect(JSON.stringify(directSummaries)).not.toContain(memoryRoot)
    expect(JSON.stringify(directSummaries)).not.toContain(WORKSPACE_SLUG_CANARY)
    expect(JSON.stringify(directSummaries)).not.toContain(GLOBAL_CONTENT_CANARY)
    await settings.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(settings.getByRole('region', { name: 'Sessions memory' })).toContainText(SESSION_TITLE_CANARY)

    const beforePreview = await page.content()
    expect(beforePreview).not.toContain(memoryRoot)
    expect(beforePreview).not.toContain(WORKSPACE_SLUG_CANARY)
    expect(beforePreview).not.toContain(GLOBAL_CONTENT_CANARY)
    for (const summary of directSummaries) expect(beforePreview).not.toContain(summary.token)

    await settings.getByRole('button', { name: 'Open Global memory' }).click()
    let preview = settings.getByRole('article', { name: 'Global memory preview' })
    await expect(preview).toContainText(GLOBAL_CONTENT_CANARY)
    await expect(preview).not.toContainText(HOSTILE_HTML_CANARY)

    await settings.getByRole('button', { name: 'Close settings' }).click()
    await page.getByRole('button', { name: 'New chat' }).last().click()
    await page.getByTestId('prompt-input').fill('Start with memory disabled')
    await page.getByTestId('send-prompt').click()
    await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(1)
    await expect.poll(() => memoryLaunchArguments(transcript)).toEqual([['--no-memory']])

    settings = await openMemorySettings(page)
    const memoryToggle = settings.getByRole('checkbox', { name: 'Use memory in Grok sessions' })
    const applyButton = settings.getByRole('button', { name: 'Apply & Restart Sessions' })
    await memoryToggle.click()
    await expect(memoryToggle).toBeChecked()
    await expect(applyButton).toBeEnabled()
    expect((await bootstrap(page)).settings.memoryEnabled).toBe(false)
    expect(await memoryLaunchArguments(transcript)).toEqual([['--no-memory']])

    const mainProcessId = app.process().pid
    if (!mainProcessId) throw new Error('Expected an Electron main-process pid')
    const temporaryStateBlocker = `${statePath}.${mainProcessId}.tmp`
    await mkdir(temporaryStateBlocker, { mode: 0o700 })
    await applyButton.click()
    await expect(settings.getByRole('alert')).toContainText(
      'The launch policy could not be changed safely. Your staged choice is still here.'
    )
    await expect(memoryToggle).toBeChecked()
    await expect(applyButton).toBeEnabled()
    expect((await bootstrap(page)).settings.memoryEnabled).toBe(false)
    expect(await memoryLaunchArguments(transcript)).toEqual([['--no-memory']])
    await rm(temporaryStateBlocker, { recursive: true, force: true })

    await applyButton.click()
    await expect(settings.locator('.memory-feedback')).toContainText('Memory enabled')
    await expect(applyButton).toBeDisabled()
    await expect.poll(async () => (await bootstrap(page)).settings.memoryEnabled).toBe(true)
    await expect.poll(() => memoryLaunchArguments(transcript)).toEqual([
      ['--no-memory'],
      ['--experimental-memory']
    ])

    await app.close()
    app = await launchFixture({ profile, workspace, transcript })
    page = await readyPage(app)
    settings = await openMemorySettings(page)
    await expect(settings.getByRole('checkbox', { name: 'Use memory in Grok sessions' })).toBeChecked()
    await expect(settings.getByLabel('Applied memory policy: on')).toBeVisible()
    await expect(settings.getByRole('button', { name: 'Apply & Restart Sessions' })).toBeDisabled()

    await settings.getByRole('button', { name: 'Close settings' }).click()
    await page.getByTestId('prompt-input').fill('Confirm the persisted memory launch policy')
    await page.getByTestId('send-prompt').click()
    await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(2)
    await expect.poll(async () => (await memoryLaunchArguments(transcript)).at(-1)).toEqual([
      '--experimental-memory'
    ])
    const allLaunchArguments = await memoryLaunchArguments(transcript)
    for (const launch of allLaunchArguments) {
      expect(launch).toHaveLength(1)
      expect(launch).not.toEqual(expect.arrayContaining(['--no-memory', '--experimental-memory']))
    }

    settings = await openMemorySettings(page)
    const note = settings.getByLabel('Note')
    await expect(note).toBeEnabled()
    await note.fill('记'.repeat(3_000))
    await expect(note).toHaveAttribute('aria-invalid', 'true')
    await expect(settings.locator('#memory-note-count')).toHaveClass(/over-limit/u)
    await expect(settings.locator('#memory-note-count')).toContainText('9,000 / 8,192 bytes')
    await expect(settings.getByRole('button', { name: 'Remember', exact: true })).toBeDisabled()
    await note.fill(REMEMBERED_NOTE_CANARY)
    await settings.getByRole('button', { name: 'Remember', exact: true }).click()
    await expect(settings.locator('.memory-feedback')).toContainText('Note saved to global memory')
    await expect(note).toHaveValue('')
    await expect.poll(async () => readFile(globalMemoryPath, 'utf8')).toContain(REMEMBERED_NOTE_CANARY)
    await settings.getByRole('button', { name: 'Open Global memory' }).click()
    preview = settings.getByRole('article', { name: 'Global memory preview' })
    await expect(preview).toContainText(REMEMBERED_NOTE_CANARY)

    // A request that settles after the user leaves Memory and enables Privacy
    // must not repopulate hidden component state with a late error or draft.
    await writeSecureFile(memoryLockPath, '{"version":1,"partial":')
    await note.fill(LATE_FEEDBACK_CANARY)
    await settings.getByRole('button', { name: 'Remember', exact: true }).click()
    await settings.getByRole('button', { name: 'Application', exact: true }).click()
    const transientPrivacyToggle = settings.getByRole('checkbox', { name: 'Privacy Mode' })
    await transientPrivacyToggle.click()
    await expect(page.locator('html')).toHaveAttribute('data-privacy', 'true')
    await page.waitForTimeout(3_500)
    await rm(memoryLockPath, { force: true })
    await transientPrivacyToggle.click()
    await expect(page.locator('html')).toHaveAttribute('data-privacy', 'false')
    await settings.getByRole('button', { name: 'Memory', exact: true }).click()
    await expect(settings.getByRole('heading', { name: 'Memory', exact: true })).toBeVisible()
    await expect(settings.locator('.memory-feedback.error')).toHaveCount(0)
    await expect(settings.getByLabel('Note')).toHaveValue('')
    expect(await readFile(globalMemoryPath, 'utf8')).not.toContain(LATE_FEEDBACK_CANARY)

    await setNativeDeleteResponse(app, 0)
    await settings.getByRole('button', { name: `Delete ${SESSION_TITLE_CANARY}` }).click()
    await expect(settings.locator('.memory-feedback')).toContainText('Deletion cancelled')
    expect(await pathExists(sessionMemoryPath)).toBe(true)
    await expect(settings.getByRole('button', { name: `Delete ${SESSION_TITLE_CANARY}` })).toBeVisible()

    await setNativeDeleteResponse(app, 1)
    await settings.getByRole('button', { name: `Delete ${SESSION_TITLE_CANARY}` }).click()
    await expect(settings.locator('.memory-feedback')).toContainText('Session memory deleted')
    await expect.poll(() => pathExists(sessionMemoryPath)).toBe(false)
    await expect(settings.getByRole('button', { name: `Delete ${SESSION_TITLE_CANARY}` })).toHaveCount(0)

    await settings.getByRole('button', { name: 'Open Global memory' }).click()
    await expect(settings.getByRole('article', { name: 'Global memory preview' })).toContainText(GLOBAL_CONTENT_CANARY)
    await settings.getByLabel('Note').fill(NOTE_DRAFT_CANARY)
    const rawGlobalBeforePrivacy = await readFile(globalMemoryPath)
    const rawWorkspaceBeforePrivacy = await readFile(workspaceMemoryPath)
    const snapshotBeforePrivacy = await bootstrap(page)

    await page.evaluate(() => (
      globalThis as unknown as {
        grokbuild: { updateSettings: (input: { privacyMode: boolean }) => Promise<void> }
      }
    ).grokbuild.updateSettings({ privacyMode: true }))
    await expect(page.locator('html')).toHaveAttribute('data-privacy', 'true')
    await expect(settings.getByRole('region', { name: 'Memory details hidden' })).toBeVisible()
    await expect(settings.getByLabel('Note')).toHaveCount(0)
    await expect(settings.getByRole('button', { name: /Delete/ })).toHaveCount(0)

    const privateSurface = `${await page.content()}\n${await fullAccessibilityTree(page)}`
    for (const canary of [
      memoryRoot,
      WORKSPACE_SLUG_CANARY,
      SESSION_TITLE_CANARY,
      GLOBAL_CONTENT_CANARY,
      WORKSPACE_CONTENT_CANARY,
      REMEMBERED_NOTE_CANARY,
      NOTE_DRAFT_CANARY,
      HOSTILE_HTML_CANARY,
      ...directSummaries.map((summary) => summary.token)
    ]) expect(privateSurface).not.toContain(canary)

    expect(await readFile(globalMemoryPath)).toEqual(rawGlobalBeforePrivacy)
    expect(await readFile(workspaceMemoryPath)).toEqual(rawWorkspaceBeforePrivacy)
    const snapshotAfterPrivacy = await bootstrap(page)
    expect(snapshotAfterPrivacy.projects).toEqual(snapshotBeforePrivacy.projects)
    expect(snapshotAfterPrivacy.sessions).toEqual(snapshotBeforePrivacy.sessions)
    expect(snapshotAfterPrivacy.agentRoster).toEqual(snapshotBeforePrivacy.agentRoster)
    expect(snapshotAfterPrivacy.settings).toEqual({
      ...snapshotBeforePrivacy.settings,
      privacyMode: true
    })

    const persisted = await readFile(statePath, 'utf8')
    for (const canary of [
      memoryRoot,
      WORKSPACE_SLUG_CANARY,
      SESSION_TITLE_CANARY,
      GLOBAL_CONTENT_CANARY,
      WORKSPACE_CONTENT_CANARY,
      REMEMBERED_NOTE_CANARY,
      NOTE_DRAFT_CANARY,
      ...directSummaries.map((summary) => summary.token)
    ]) expect(persisted).not.toContain(canary)
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function launchFixture({
  profile,
  workspace,
  transcript
}: {
  profile: string
  workspace: string
  transcript: string
}): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
      GROKBUILD_USER_DATA_DIR: profile,
      GROKBUILD_E2E_PROJECT_PATH: workspace,
      GROKBUILD_E2E: '1',
      GROKBUILD_MOCK_TRANSCRIPT: transcript,
      TZ: 'UTC',
      LANG: 'en_US.UTF-8'
    }
  })
}

async function readyPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return page
}

async function openMemorySettings(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Memory', exact: true }).click()
  await expect(settings.getByRole('heading', { name: 'Memory', exact: true })).toBeVisible()
  await expect(settings.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  return settings
}

async function bootstrap(page: Page): Promise<import('../../src/shared/models').AppSnapshot> {
  return page.evaluate(() => (
    globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }
  ).grokbuild.bootstrap())
}

async function memoryLaunchArguments(path: string): Promise<string[][]> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch {
    return []
  }
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: string; frame: { argv?: string[] } })
    .filter((entry) => entry.direction === 'process')
    .map((entry) => (entry.frame.argv ?? []).filter((argument) =>
      argument === '--no-memory' || argument === '--experimental-memory'
    ))
}

async function setNativeDeleteResponse(app: ElectronApplication, response: 0 | 1): Promise<void> {
  await app.evaluate(({ dialog }, selectedResponse) => {
    const mutable = dialog as unknown as {
      showMessageBox: (...arguments_: unknown[]) => Promise<{
        response: number
        checkboxChecked: boolean
      }>
    }
    mutable.showMessageBox = async () => ({
      response: selectedResponse,
      checkboxChecked: false
    })
  }, response)
}

async function fullAccessibilityTree(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page)
  try {
    return JSON.stringify(await session.send('Accessibility.getFullAXTree'))
  } finally {
    await session.detach()
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function writeSecureFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 })
}
