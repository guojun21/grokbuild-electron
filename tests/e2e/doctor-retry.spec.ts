import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppSnapshot } from '../../src/shared/models'

test('retries a failed initialization once without replaying or leaking diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-retry-e2e-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const transcriptPath = join(root, 'rpc.ndjson')
  const retryMarker = join(root, 'retry.marker')
  const canary = 'QA_RETRY_SECRET_CANARY_8A31'
  await mkdir(workspace)

  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
      GROKBUILD_USER_DATA_DIR: profile,
      GROKBUILD_E2E_PROJECT_PATH: workspace,
      GROKBUILD_E2E: '1',
      GROKBUILD_MOCK_PROFILE: 'auth-required-once',
      GROKBUILD_MOCK_TRANSCRIPT: transcriptPath,
      GROKBUILD_MOCK_RETRY_MARKER: retryMarker,
      GROKBUILD_MOCK_FAILURE_CANARY: canary,
      TZ: 'UTC',
      LANG: 'en_US.UTF-8'
    }
  })

  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByRole('button', { name: 'New chat' }).last().click()
    await page.getByTestId('prompt-input').fill('Do not replay this prompt')
    await page.getByTestId('send-prompt').click()

    await expect(page.getByTestId('retry-banner')).toBeVisible()
    await expect(page.getByText('Grok authentication failed. Sign in again and retry.'))
      .toBeVisible()
    await expect(page.locator('body')).not.toContainText(canary)
    await page.getByTestId('retry-session').click()
    await expect(page.getByTestId('retry-banner')).toBeHidden()

    await expect.poll(async () => {
      const snapshot = await page.evaluate(() =>
        (globalThis as unknown as {
          grokbuild: { bootstrap: () => Promise<AppSnapshot> }
        }).grokbuild.bootstrap()
      )
      const session = snapshot.sessions.find((candidate) => candidate.id === snapshot.selectedSessionId)
      return {
        status: session?.status,
        lastError: session?.lastError,
        pendingPermission: session?.pendingPermission,
        pendingInteraction: session?.pendingInteraction
      }
    }).toEqual({
      status: 'idle',
      lastError: undefined,
      pendingPermission: undefined,
      pendingInteraction: undefined
    })

    const entries = (await readFile(transcriptPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        direction: string
        frame: { method?: string }
      })
    const clientMethods = entries
      .filter((entry) => entry.direction === 'client->agent')
      .flatMap((entry) => entry.frame.method ? [entry.frame.method] : [])
    expect(clientMethods.filter((method) => method === 'initialize')).toHaveLength(2)
    expect(clientMethods.filter((method) => method === 'session/new')).toHaveLength(1)
    expect(clientMethods.filter((method) => method === 'session/prompt')).toHaveLength(0)

    const snapshot = await page.evaluate(() =>
      (globalThis as unknown as {
        grokbuild: { bootstrap: () => Promise<AppSnapshot> }
      }).grokbuild.bootstrap()
    )
    await expect.poll(async () => readFile(join(profile, 'state.json'), 'utf8'))
      .toContain('Do not replay this prompt')
    const state = await readFile(join(profile, 'state.json'), 'utf8')
    const dom = await page.content()
    for (const surface of [JSON.stringify(snapshot), state, dom]) {
      expect(surface).not.toContain(canary)
      expect(surface).not.toContain(`/private/${canary}`)
      expect(surface).not.toContain('Bearer')
    }
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
