import { _electron as electron, expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { chmod, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The canonical baselines are honest only at their recorded viewport. A display that
// cannot host that viewport (for example GitHub-hosted macOS runners clamp windows to
// the runner's small work area) must report blocked, never a false red or green.
async function skipUnlessViewport(page: Page, width: number, height: number): Promise<void> {
  const matched = await page
    .waitForFunction(
      (size) => window.innerWidth === size.width && window.innerHeight === size.height,
      { width, height },
      { timeout: 5000 }
    )
    .then(() => true)
    .catch(() => false)
  if (matched) return
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  test.skip(
    true,
    `Viewport is ${size.width}x${size.height}, not the canonical ${width}x${height}; run on the pinned macOS visual runner`
  )
}

test('matches the canonical 1200x800 conversation surface', async () => {
  test.skip(process.env.GROKBUILD_VISUAL !== '1', 'Run with GROKBUILD_VISUAL=1 on the pinned macOS visual runner')
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-electron-visual-'))
  const workspace = join(root, 'visual-workspace')
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
    await skipUnlessViewport(page, 1200, 800)
    await page.getByRole('button', { name: 'New chat' }).last().click()
    await page.getByTestId('prompt-input').fill('Run the QA contract')
    await page.getByTestId('send-prompt').click()
    await expect(page.getByText('GROKBUILD_QA_OK')).toBeVisible()
    await expect(page).toHaveScreenshot('conversation-1200x800.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.003
    })
    await page.getByRole('button', { name: 'Context usage' }).click()
    await expect(page.getByRole('dialog', { name: 'Context Usage' })).toBeVisible()
    await expect(page).toHaveScreenshot('context-usage-popover-1200x800.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.003
    })
    await page.getByRole('button', { name: 'Context usage' }).click()
    await page.getByRole('button', { name: 'Dashboard' }).click()
    await expect(page.getByRole('dialog', { name: 'Sessions Dashboard' })).toBeVisible()
    await expect(page).toHaveScreenshot('sessions-dashboard-1200x800.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.003
    })
    await page.getByRole('button', { name: 'Close Sessions Dashboard' }).click()
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.getByRole('dialog', { name: 'Sessions History' })).toContainText(
      'Historical auth repair'
    )
    await expect(page).toHaveScreenshot('sessions-history-1200x800.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.003
    })
    await page.getByRole('button', { name: 'Close Sessions History' }).click()
    await page.getByTestId('prompt-input').fill('exercise activity projection please')
    await page.getByTestId('send-prompt').click()
    await expect(page.getByText('Session activity projection received.')).toBeVisible()
    await page.getByRole('button', { name: /^Tasks/ }).click()
    await expect(page.getByRole('dialog', { name: 'Tasks & Workflows' })).toBeVisible()
    await expect(page).toHaveScreenshot('tasks-workflows-1200x800.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.003
    })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('matches the canonical 1200x800 Saved Agents settings surface', async () => {
  test.skip(process.env.GROKBUILD_VISUAL !== '1', 'Run with GROKBUILD_VISUAL=1 on the pinned macOS visual runner')
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-electron-agents-visual-'))
  const workspace = join(root, 'agents-workspace')
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
    await skipUnlessViewport(page, 1200, 800)
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings.getByLabel('Built-in Grok agents')).toContainText('general-purpose')
    await settings.getByRole('button', { name: 'Starter crew' }).click()
    await expect(settings.locator('.saved-agent-list').getByText('Chief', { exact: true })).toBeVisible()
    await expect(page).toHaveScreenshot('settings-agents-1200x800.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.003
    })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('matches the private reduced-motion core at 1100x720 in light and dark', async () => {
  test.skip(process.env.GROKBUILD_VISUAL !== '1', 'Run with GROKBUILD_VISUAL=1 on the pinned macOS visual runner')
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-electron-privacy-visual-'))
  const workspace = join(root, 'PRIVATE_PROJECT_CANARY_8C41')
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 720)
    })
    await skipUnlessViewport(page, 1100, 720)
    await page.getByRole('button', { name: 'New chat' }).last().click()
    await page.evaluate(() => (
      globalThis as unknown as {
        grokbuild: {
          updateSettings: (input: {
            appearance: 'light' | 'dark'
            privacyMode: boolean
            reduceMotion: boolean
          }) => Promise<void>
        }
      }
    ).grokbuild.updateSettings({
      appearance: 'light',
      privacyMode: true,
      reduceMotion: true
    }))
    await expect(page.locator('html')).toHaveAttribute('data-privacy', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true')
    await expect(page.getByRole('searchbox', {
      name: 'Filter agents, projects, and sessions'
    })).toHaveAttribute('placeholder', 'Search hidden while private')
    await expect(page.locator('.topbar-title')).toContainText('Project 1')
    await expect(page.locator('.topbar-title')).toContainText('Session 1')
    const reducedMotionState = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.className = 'spinning'
      document.body.append(probe)
      const style = getComputedStyle(probe)
      const state = {
        animationName: style.animationName,
        transitionDuration: style.transitionDuration,
        runningAnimations: document.getAnimations().filter((animation) => animation.playState === 'running').length
      }
      probe.remove()
      return state
    })
    expect(reducedMotionState).toEqual({
      animationName: 'none',
      transitionDuration: '0s',
      runningAnimations: 0
    })
    await expect(page).toHaveScreenshot('privacy-core-1100x720-light.png', {
      animations: 'allow',
      caret: 'hide',
      maxDiffPixelRatio: 0.003
    })

    await page.evaluate(() => (
      globalThis as unknown as {
        grokbuild: { updateSettings: (input: { appearance: 'dark' }) => Promise<void> }
      }
    ).grokbuild.updateSettings({ appearance: 'dark' }))
    await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
    await expect(page).toHaveScreenshot('privacy-core-1100x720-dark.png', {
      animations: 'allow',
      caret: 'hide',
      maxDiffPixelRatio: 0.003
    })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('matches the canonical 1200x800 Memory settings surfaces', async () => {
  test.skip(process.env.GROKBUILD_VISUAL !== '1', 'Run with GROKBUILD_VISUAL=1 on the pinned macOS visual runner')
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-electron-memory-visual-'))
  const profile = join(root, 'profile')
  const memoryRoot = join(profile, 'e2e-grok-memory')
  const workspaceMemory = join(memoryRoot, 'visual-workspace-a8f31d20')
  const sessionsMemory = join(workspaceMemory, 'sessions')
  const workspace = join(root, 'visual-workspace')
  const fixedTime = new Date('2026-08-25T09:30:00.000Z')
  await mkdir(profile, { mode: 0o700 })
  await mkdir(memoryRoot, { mode: 0o700 })
  await mkdir(workspaceMemory, { mode: 0o700 })
  await mkdir(sessionsMemory, { mode: 0o700 })
  await mkdir(workspace, { mode: 0o700 })
  const fixtures = [
    [
      join(memoryRoot, 'MEMORY.md'),
      '# Working compass\n\n- Prefer focused parity checks.\n- Keep privileged operations in the main process.\n\n> Grok CLI owns this durable memory.\n'
    ],
    [
      join(workspaceMemory, 'MEMORY.md'),
      '# Workspace conventions\n\nUse the cold mineral macOS design system.\n'
    ],
    [
      join(sessionsMemory, 'Release handoff.md'),
      '# Release handoff\n\nPackage verification is still required.\n'
    ],
    [join(memoryRoot, 'index.sqlite'), 'visual-index-placeholder']
  ] as const
  for (const [path, contents] of fixtures) {
    await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 })
    await chmod(path, 0o600)
    await utimes(path, fixedTime, fixedTime)
  }

  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
      GROKBUILD_USER_DATA_DIR: profile,
      GROKBUILD_E2E_PROJECT_PATH: workspace,
      GROKBUILD_E2E: '1',
      TZ: 'UTC',
      LANG: 'en_US.UTF-8'
    }
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1200, 800)
    })
    await skipUnlessViewport(page, 1200, 800)
    await page.getByRole('button', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Memory', exact: true }).click()
    await expect(settings.getByRole('region', { name: 'Sessions memory' })).toContainText('Release handoff')
    await settings.getByRole('button', { name: 'Open Global memory' }).click()
    await expect(settings.getByRole('article', { name: 'Global memory preview' })).toContainText('Working compass')
    await expect(page).toHaveScreenshot('settings-memory-1200x800.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.003
    })

    await page.evaluate(() => (
      globalThis as unknown as {
        grokbuild: { updateSettings: (input: { privacyMode: boolean }) => Promise<void> }
      }
    ).grokbuild.updateSettings({ privacyMode: true }))
    await expect(settings.getByRole('region', { name: 'Memory details hidden' })).toBeVisible()
    await expect(page).toHaveScreenshot('settings-memory-private-1200x800.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.003
    })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
