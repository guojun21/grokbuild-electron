import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppSnapshot } from '../../src/shared/models'

const PATH_CANARY = 'QA_AGENT_PATH_CANARY_51D8'
const SELECTOR_CANARY = 'QA_AGENT_SELECTOR_CANARY_4E2A'
const CHIEF_PROFILE = {
  name: 'chief',
  description: 'Route work, keep scope, synthesize final answer',
  promptBody: 'You are Chief.\n\nInstructions: Route work, keep scope, synthesize final answer'
}

test('keeps Saved Agent catalog, binding, resume, and deletion truthful end to end', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-saved-agents-e2e-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const transcript = join(root, 'rpc.ndjson')
  await mkdir(workspace)
  const rawSourcePath = join(workspace, `${PATH_CANARY}.md`)
  await writeFile(rawSourcePath, 'deterministic agent source\n')
  const sourcePath = await realpath(rawSourcePath)

  let app: ElectronApplication | undefined
  let page: Page
  let selectedSessionId: string
  try {
    ;({ app, page } = await launch({ profile, workspace, transcript, sourcePath }))

    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings.getByLabel('Built-in Grok agents')).toContainText('general-purpose')
    await expect(settings.getByLabel('Project Grok agents')).toContainText('Reviews the selected workspace.')
    await expect(settings.getByLabel('User Grok agents')).toContainText('personal-researcher')
    await expect(settings.getByLabel('Plug-ins Grok agents')).toContainText('QA Review Tools')

    const catalog = await page.evaluate(async () => {
      const bridge = (globalThis as unknown as {
        grokbuild: {
          bootstrap: () => Promise<AppSnapshot>
          listGrokAgentCatalog: (input: { projectId: string }) => Promise<Array<{ token: string }>>
        }
      }).grokbuild
      const snapshot = await bridge.bootstrap()
      return {
        snapshot,
        catalog: await bridge.listGrokAgentCatalog({ projectId: snapshot.selectedProjectId! })
      }
    })
    const documentMarkup = await page.locator('body').innerHTML()
    for (const entry of catalog.catalog) expect(documentMarkup).not.toContain(entry.token)
    expect(documentMarkup).not.toContain(PATH_CANARY)
    expect(documentMarkup).not.toContain(SELECTOR_CANARY)
    expect(documentMarkup).not.toContain('agentProfile')
    const publicSnapshot = JSON.stringify(catalog.snapshot)
    expect(publicSnapshot).not.toContain(PATH_CANARY)
    expect(publicSnapshot).not.toContain(SELECTOR_CANARY)
    expect(publicSnapshot).not.toContain('agentProfile')
    for (const entry of catalog.catalog) expect(publicSnapshot).not.toContain(entry.token)
    const publicCatalog = JSON.stringify(catalog.catalog)
    expect(publicCatalog).not.toContain(PATH_CANARY)
    expect(publicCatalog).not.toContain(SELECTOR_CANARY)
    expect(publicCatalog).not.toContain(sourcePath)
    for (const entry of catalog.catalog) {
      expect(entry).not.toHaveProperty('path')
      expect(entry).not.toHaveProperty('selector')
    }

    await expect(settings.getByText('No Saved Agents yet')).toBeVisible()
    await settings.getByRole('button', { name: 'New Agent' }).click()
    const editor = page.locator('.agent-editor')
    await expect(editor.getByRole('heading', { name: 'New Saved Agent' })).toBeVisible()
    const nameInput = editor.getByLabel('Name', { exact: true })
    await expect(nameInput).toBeFocused()
    await nameInput.fill('Plan')
    await editor.getByLabel('Mission', { exact: true }).fill('Own the planning boundary')
    await expect(editor.getByText('This name is reserved by Grok. Choose a more specific name.')).toBeVisible()
    await expect(editor.getByRole('button', { name: 'Save Agent' })).toBeDisabled()
    await editor.getByLabel('Name', { exact: true }).fill('Temporary')
    await page.keyboard.press('Escape')
    await expect(editor.getByText('Discard unsaved changes?')).toBeVisible()
    await editor.getByRole('button', { name: 'Discard' }).click()
    await expect(editor).toHaveCount(0)

    await settings.getByRole('button', { name: 'Starter crew' }).click()
    await expect(settings.locator('.saved-agent-list').getByText('Chief', { exact: true })).toBeVisible()
    await settings.getByRole('button', { name: 'Close settings' }).click()

    await page.locator('.workspace-empty').getByRole('button', { name: 'New chat' }).click()
    const selector = page.getByRole('combobox', { name: 'Saved Agent' })
    await expect(selector).toBeEnabled()
    await selector.selectOption({ label: 'Chief' })
    await expect(selector).toHaveValue('agent-0')
    await expect(page.locator('.session-row.selected').getByRole('img', { name: 'Saved Agent Chief' })).toBeVisible()
    await expect(selector).toBeEnabled()
    await expect(page.getByLabel('Agent mode')).toBeEnabled()

    await page.getByTestId('prompt-input').fill('saved agent vertical QA')
    await page.getByTestId('send-prompt').click()
    await expect(page.getByText('GROKBUILD_QA_OK')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()

    let frames = await clientFrames(transcript)
    const profiledNew = frames.filter((frame) =>
      frame.method === 'session/new' && frame.params?._meta?.agentProfile !== undefined
    )
    expect(profiledNew).toHaveLength(1)
    expect(profiledNew[0]?.params?._meta?.agentProfile).toEqual(CHIEF_PROFILE)
    const beforeRestart = await bootstrap(page)
    selectedSessionId = beforeRestart.selectedSessionId!
    expect(beforeRestart.sessions.find((session) => session.id === selectedSessionId)?.savedAgent?.name)
      .toBe('Chief')

    await app.close()
    app = undefined
    ;({ app, page } = await launch({
      profile,
      workspace,
      transcript,
      sourcePath,
      loadMode: 'ok'
    }))

    await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(1)
    await expect(page.locator('.session-row.selected').getByRole('img', { name: 'Saved Agent Chief' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Saved Agent' })).toHaveValue('agent-0')
    const resumed = await bootstrap(page)
    expect(resumed.sessions).toHaveLength(1)
    expect(resumed.sessions[0]).toMatchObject({ id: selectedSessionId, savedAgent: { name: 'Chief' } })
    expect(resumed.agentRoster.status).toBe('ready')
    if (resumed.agentRoster.status === 'ready') {
      expect(resumed.agentRoster.agents).toHaveLength(5)
      const chiefId = resumed.agentRoster.agents.find((agent) => agent.name === 'Chief')?.id
      expect(resumed.sessions.filter((session) => session.savedAgentId === chiefId)).toHaveLength(1)
    }

    await page.getByTestId('prompt-input').fill('resume saved agent vertical QA')
    await page.getByTestId('send-prompt').click()
    await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()

    frames = await clientFrames(transcript)
    expect(frames.filter((frame) =>
      frame.method === 'session/new' && frame.params?._meta?.agentProfile !== undefined
    )).toHaveLength(1)
    const profiledLoads = frames.filter((frame) =>
      frame.method === 'session/load' && frame.params?._meta?.agentProfile !== undefined
    )
    expect(profiledLoads).toHaveLength(1)
    expect(profiledLoads[0]?.params?._meta?.agentProfile).toEqual(CHIEF_PROFILE)

    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    const resumedSettings = page.getByRole('dialog', { name: 'Settings' })
    const deleteChief = resumedSettings.getByRole('button', { name: 'Delete Chief' })
    await expect(deleteChief).toBeEnabled()
    await deleteChief.click()
    await expect(resumedSettings.locator('.saved-agent-list').getByText('Chief', { exact: true })).toHaveCount(0)
    await resumedSettings.getByRole('button', { name: 'Close settings' }).click()

    await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(2)
    await expect(page.getByRole('img', { name: 'Saved Agent Chief' })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Saved Agent' })).toHaveValue('none')
    const afterDelete = await bootstrap(page)
    expect(afterDelete.sessions).toHaveLength(1)
    expect(afterDelete.sessions[0]?.id).toBe(selectedSessionId)
    expect(afterDelete.sessions[0]?.savedAgentId).toBeUndefined()
    expect(afterDelete.sessions[0]?.savedAgent).toBeUndefined()
    expect(afterDelete.sessions[0]?.transcript.some((item) =>
      item.kind === 'message' && item.text.includes('GROKBUILD_QA_OK')
    )).toBe(true)

    // Deletion recycles only this worker to the default profile. Prove the
    // next turn resumes without leaking the deleted inline profile.
    await page.getByTestId('prompt-input').fill('post-delete default agent QA')
    await page.getByTestId('send-prompt').click()
    await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(3)
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
    frames = await clientFrames(transcript)
    expect(frames.filter((frame) =>
      frame.method === 'session/load' && frame.params?._meta?.agentProfile === undefined
    )).toHaveLength(1)

    // Restart with the same profile directory: the chat/transcript survives,
    // while neither the binding badge nor the removed ACP profile returns.
    await app.close()
    app = undefined
    ;({ app, page } = await launch({
      profile,
      workspace,
      transcript,
      sourcePath,
      loadMode: 'ok'
    }))
    await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(3)
    await expect(page.getByRole('img', { name: 'Saved Agent Chief' })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Saved Agent' })).toHaveValue('none')
    const afterDeleteRestart = await bootstrap(page)
    expect(afterDeleteRestart.sessions).toHaveLength(1)
    expect(afterDeleteRestart.sessions[0]).toMatchObject({ id: selectedSessionId })
    expect(afterDeleteRestart.sessions[0]?.savedAgentId).toBeUndefined()

    await page.getByTestId('prompt-input').fill('post-delete restart QA')
    await page.getByTestId('send-prompt').click()
    await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(4)
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
    frames = await clientFrames(transcript)
    expect(frames.filter((frame) => frame.method === 'session/new')).toHaveLength(1)
    expect(frames.filter((frame) =>
      frame.method === 'session/load' && frame.params?._meta?.agentProfile !== undefined
    )).toHaveLength(1)
    expect(frames.filter((frame) =>
      frame.method === 'session/load' && frame.params?._meta?.agentProfile === undefined
    )).toHaveLength(2)
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})

interface LaunchOptions {
  profile: string
  workspace: string
  transcript: string
  sourcePath: string
  loadMode?: 'ok'
}

async function launch(options: LaunchOptions): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
      GROKBUILD_USER_DATA_DIR: options.profile,
      GROKBUILD_E2E_PROJECT_PATH: options.workspace,
      GROKBUILD_E2E: '1',
      GROKBUILD_MOCK_TRANSCRIPT: options.transcript,
      GROKBUILD_MOCK_AGENT_SOURCE_PATH: options.sourcePath,
      GROKBUILD_MOCK_AGENT_SELECTOR_CANARY: SELECTOR_CANARY,
      ...(options.loadMode ? { GROKBUILD_MOCK_LOAD_MODE: options.loadMode } : {}),
      TZ: 'UTC',
      LANG: 'en_US.UTF-8'
    }
  })
  app.process().stderr?.on('data', (chunk) => process.stderr.write(`[electron] ${chunk}`))
  const page = await app.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return { app, page }
}

interface ClientFrame {
  method?: string
  params?: {
    _meta?: {
      agentProfile?: {
        name: string
        description: string
        promptBody: string
      }
    }
  }
}

async function clientFrames(path: string): Promise<ClientFrame[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: string; frame: ClientFrame })
    .filter((entry) => entry.direction === 'client->agent')
    .map((entry) => entry.frame)
}

async function bootstrap(page: Page): Promise<AppSnapshot> {
  return page.evaluate(() => (
    globalThis as unknown as { grokbuild: { bootstrap: () => Promise<AppSnapshot> } }
  ).grokbuild.bootstrap())
}
