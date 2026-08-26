import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppSnapshot } from '../../src/shared/models'

test('forks once from the sidebar and only loads the child after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-fork-e2e-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const transcript = join(root, 'rpc.ndjson')
  await mkdir(workspace)

  let app: ElectronApplication | undefined
  try {
    ;({ app } = await launch(profile, workspace, transcript))
    let page = await app.firstWindow()
    await page.getByRole('button', { name: 'New chat' }).last().click()
    await sendAndWait(page, 'seed the fork', 1)

    const source = selectedSession(await bootstrap(page))
    await page.getByRole('button', { name: `Open ${source.title}` }).click({ button: 'right' })
    const forkAction = page.getByRole('menuitem', { name: 'Fork Session' })
    await expect(forkAction).toBeEnabled()
    await forkAction.click()

    await expect.poll(async () => {
      const snapshot = await bootstrap(page)
      const selected = snapshot.sessions.find((session) => session.id === snapshot.selectedSessionId)
      return selected && selected.id !== source.id ? selected : undefined
    }).toBeTruthy()
    const forked = selectedSession(await bootstrap(page))
    expect(forked.title).toBe(`Fork of ${source.title}`)

    const firstFrames = await clientFrames(transcript)
    const forkFrames = firstFrames.filter((frame) => frame.method === 'x.ai/session/fork')
    expect(forkFrames).toHaveLength(1)
    const sourceRemoteId = stringParam(forkFrames[0], 'sourceSessionId')
    const childRemoteId = stringParam(forkFrames[0], 'newSessionId')
    expect(childRemoteId).not.toBe(sourceRemoteId)
    expect(firstFrames.filter((frame) =>
      frame.method === 'session/load' && stringParam(frame, 'sessionId') === childRemoteId
    )).toHaveLength(1)

    const publicBeforeRestart = await bootstrap(page)
    const publicSurface = `${JSON.stringify(publicBeforeRestart)}\n${await page.content()}`
    expect(publicSurface).not.toContain(sourceRemoteId)
    expect(publicSurface).not.toContain(childRemoteId)

    await app.close()
    app = undefined

    ;({ app } = await launch(profile, workspace, transcript))
    page = await app.firstWindow()
    const restored = selectedSession(await bootstrap(page))
    expect(restored.id).toBe(forked.id)
    expect(restored.title).toBe(forked.title)
    expect(JSON.stringify(await bootstrap(page))).not.toContain(childRemoteId)

    await sendAndWait(page, 'continue the child', 2)
    const restartedFrames = await clientFrames(transcript)
    expect(restartedFrames.filter((frame) => frame.method === 'x.ai/session/fork')).toHaveLength(1)
    expect(restartedFrames.filter((frame) =>
      frame.method === 'session/load' && stringParam(frame, 'sessionId') === childRemoteId
    )).toHaveLength(2)
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function launch(
  profile: string,
  workspace: string,
  transcript: string
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
      TZ: 'UTC',
      LANG: 'en_US.UTF-8'
    }
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return { app }
}

async function bootstrap(page: Page): Promise<AppSnapshot> {
  return page.evaluate(() => (
    globalThis as unknown as { grokbuild: { bootstrap: () => Promise<AppSnapshot> } }
  ).grokbuild.bootstrap())
}

function selectedSession(snapshot: AppSnapshot): AppSnapshot['sessions'][number] {
  const session = snapshot.sessions.find((candidate) => candidate.id === snapshot.selectedSessionId)
  if (!session) throw new Error('Expected a selected session')
  return session
}

async function sendAndWait(page: Page, prompt: string, expectedResponses: number): Promise<void> {
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('send-prompt').click()
  await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(expectedResponses)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
}

interface ClientFrame {
  method?: string
  params?: Record<string, unknown>
}

async function clientFrames(path: string): Promise<ClientFrame[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: string; frame: ClientFrame })
    .filter((entry) => entry.direction === 'client->agent')
    .map((entry) => entry.frame)
}

function stringParam(frame: ClientFrame | undefined, name: string): string {
  const value = frame?.params?.[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${name} in the ACP frame`)
  }
  return value
}
