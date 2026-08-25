import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('loads the persisted ACP session after an app restart without replaying local transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-resume-e2e-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const transcript = join(root, 'rpc.ndjson')
  await mkdir(workspace)

  let app: ElectronApplication | undefined
  try {
    ;({ app } = await launch(profile, workspace, transcript))
    let page = await app.firstWindow()
    await page.getByRole('button', { name: 'New chat' }).last().click()
    await sendAndWait(page, 'first turn')
    await app.close()
    app = undefined

    ;({ app } = await launch(profile, workspace, transcript, 'ok'))
    page = await app.firstWindow()
    await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(1)
    await sendAndWait(page, 'second turn', 2)
    await expect(page.getByText('REPLAY_MUST_NOT_RENDER')).toHaveCount(0)

    const methods = await clientMethods(transcript)
    expect(methods).toContain('session/load')
    expect(methods.lastIndexOf('session/load')).toBeGreaterThan(methods.lastIndexOf('session/new'))
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps local transcript and shows a notice when the persisted ACP session is stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-stale-e2e-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const transcript = join(root, 'rpc.ndjson')
  await mkdir(workspace)

  let app: ElectronApplication | undefined
  try {
    ;({ app } = await launch(profile, workspace, transcript))
    let page = await app.firstWindow()
    await page.getByRole('button', { name: 'New chat' }).last().click()
    await sendAndWait(page, 'first turn')
    await app.close()
    app = undefined

    ;({ app } = await launch(profile, workspace, transcript, 'stale'))
    page = await app.firstWindow()
    await sendAndWait(page, 'continue stale session', 2)
    await expect(page.getByText(/Previous Grok session expired/)).toBeVisible()
    await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(2)

    const methods = await clientMethods(transcript)
    const loadIndex = methods.lastIndexOf('session/load')
    expect(loadIndex).toBeGreaterThan(-1)
    expect(methods.slice(loadIndex, loadIndex + 2)).toEqual(['session/load', 'session/new'])
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function launch(
  profile: string,
  workspace: string,
  transcript: string,
  loadMode?: 'ok' | 'stale'
): Promise<{ app: ElectronApplication }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
      GROKBUILD_USER_DATA_DIR: profile,
      GROKBUILD_E2E_PROJECT_PATH: workspace,
      GROKBUILD_E2E: '1',
      GROKBUILD_MOCK_TRANSCRIPT: transcript,
      ...(loadMode ? { GROKBUILD_MOCK_LOAD_MODE: loadMode } : {}),
      TZ: 'UTC',
      LANG: 'en_US.UTF-8'
    }
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return { app }
}

async function sendAndWait(page: Page, prompt: string, expectedResponses = 1): Promise<void> {
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('send-prompt').click()
  await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(expectedResponses)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
}

async function clientMethods(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: string; frame: { method?: string } })
    .filter((entry) => entry.direction === 'client->agent' && entry.frame.method)
    .map((entry) => entry.frame.method!)
}
