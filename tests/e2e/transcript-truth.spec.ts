import { _electron as electron, expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppSnapshot } from '../../src/shared/models'

test('carries bounded metering and authoritative mode updates through the utility worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-transcript-truth-e2e-'))
  const workspace = join(root, 'qa-workspace')
  await mkdir(workspace)
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
      GROKBUILD_USER_DATA_DIR: join(root, 'profile'),
      GROKBUILD_E2E_PROJECT_PATH: workspace,
      GROKBUILD_E2E: '1',
      TZ: 'UTC',
      LANG: 'en_US.UTF-8'
    }
  })

  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByRole('button', { name: 'New chat' }).last().click()
    await page.getByTestId('prompt-input').fill('exercise usage sources please')
    await page.getByTestId('send-prompt').click()
    await expect(page.getByText('Metering sources received.')).toBeVisible()

    await expect.poll(async () => selectedSession(await snapshot(page))).toMatchObject({
      status: 'idle',
      contextUsed: 32_100,
      contextLimit: 500_000,
      lastTurnUsage: {
        inputTokens: 200,
        outputTokens: 7,
        cachedReadTokens: 50,
        reasoningTokens: 3
      }
    })
    const meteredSnapshot = await snapshot(page)
    expect(JSON.stringify(meteredSnapshot)).not.toContain('QA_USAGE_SECRET_CANARY_73D2')

    const contextMeter = page.getByRole('button', { name: 'Context usage' })
    await contextMeter.click()
    const usageDialog = page.getByRole('dialog', { name: 'Context Usage' })
    await expect(usageDialog.getByLabel('Input: 200')).toBeVisible()
    await expect(usageDialog.getByLabel('Cached: 50 cached (25%)')).toBeVisible()
    await expect(usageDialog.getByLabel('Output: 7')).toBeVisible()
    await expect(usageDialog.getByLabel('Reasoning: 3')).toBeVisible()
    await expect(usageDialog.locator('.usage-row', { hasText: 'Total' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByTestId('prompt-input').fill('exercise mode update please')
    await page.getByTestId('send-prompt').click()
    await expect.poll(async () => selectedSession(await snapshot(page))).toMatchObject({
      status: 'idle',
      mode: 'plan',
      permissionMode: 'auto'
    })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function snapshot(page: Page): Promise<AppSnapshot> {
  return page.evaluate(() =>
    (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<AppSnapshot> } })
      .grokbuild.bootstrap()
  )
}

function selectedSession(snapshotValue: AppSnapshot): AppSnapshot['sessions'][number] | undefined {
  return snapshotValue.sessions.find((session) => session.id === snapshotValue.selectedSessionId)
}
