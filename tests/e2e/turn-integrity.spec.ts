import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Turn integrity: what the transcript proves about a completed turn. The
 * unbacked-work notice must fire exactly when a turn narrates in-progress
 * work without calling a tool, and a generated image must reach the tool
 * card only through a path that resolves inside the trusted root.
 */

const NOTICE = 'No tools were called this turn'

let application: ElectronApplication | undefined
let page: Page
let root: string
let workspace: string

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'grokbuild-turn-integrity-e2e-'))
  workspace = join(root, 'qa-workspace')
  await mkdir(workspace)
  application = await electron.launch({
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
  page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await application?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

async function sendInFreshChat(prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'New chat' }).last().click()
  await expect(page.getByTestId('empty-transcript')).toBeVisible()
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('send-prompt').click()
}

test('flags a turn that narrates work without calling any tool', async () => {
  await sendInFreshChat('please narrate without tools')

  const notice = page.locator('.notice-row', { hasText: NOTICE })
  await expect(notice).toBeVisible()
  // The notice states the fact and nothing more: the reply itself stays intact.
  await expect(page.getByText('Done: nothing matched.')).toBeVisible()
  await expect(notice).toHaveCount(1)
})

test('stays silent when the same narration is backed by a tool call', async () => {
  await sendInFreshChat('please narrate with tools')

  await expect(page.getByTestId('tool-card')).toBeVisible()
  await expect(page.getByText('Done: nothing matched.')).toBeVisible()
  await expect(page.locator('.notice-row', { hasText: NOTICE })).toHaveCount(0)
})

test('stays silent for a plain answer that claims no work', async () => {
  await sendInFreshChat('answer without narration please')

  await expect(page.getByText('A tuple is an ordered, fixed-length sequence.')).toBeVisible()
  await expect(page.locator('.notice-row', { hasText: NOTICE })).toHaveCount(0)
})

test('renders a generated image in its tool card and opens it in the lightbox', async () => {
  await sendInFreshChat('generate an image please')

  const thumbnail = page.locator('[data-testid="tool-images"] img').first()
  await expect(thumbnail).toBeVisible()
  // A real tool call ran, so the turn is backed and carries no notice.
  await expect(page.locator('.notice-row', { hasText: NOTICE })).toHaveCount(0)

  await thumbnail.click()
  const lightbox = page.getByTestId('image-lightbox')
  await expect(lightbox).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(lightbox).toBeHidden()
})

test('refuses a generated image whose path escapes the trusted root', async () => {
  await sendInFreshChat('generate an escaped image please')

  // The tool call itself is real and still renders; only the out-of-root
  // image is withheld, so a hostile path cannot preview an arbitrary file.
  await expect(page.getByText('Reported an out-of-root image.')).toBeVisible()
  await expect(page.getByTestId('tool-card')).toBeVisible()
  await expect(page.getByTestId('tool-images')).toHaveCount(0)
})
