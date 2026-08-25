import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppSnapshot } from '../../src/shared/models'

test('reorders projects within pin groups, persists the order, and opens only allowlisted targets', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grokbuild-project-actions-e2e-')))
  const profile = join(root, 'profile')
  const openLog = join(root, 'project-open.ndjson')
  const projects = [
    { id: 'p1', name: 'Pinned One', path: join(root, 'pinned-one') },
    { id: 'p2', name: 'Pinned Two', path: join(root, 'pinned-two') },
    { id: 'u1', name: 'Regular One', path: join(root, 'regular-one') },
    { id: 'u2', name: 'Regular Two', path: join(root, 'regular-two') }
  ]
  await mkdir(profile, { recursive: true })
  await Promise.all(projects.map((project) => mkdir(project.path)))
  await writeFile(join(profile, 'state.json'), `${JSON.stringify({
    version: 3,
    projects: projects.map((project, index) => ({
      ...project,
      sessionIds: [],
      createdAt: `2026-08-25T00:00:0${index}.000Z`
    })),
    sessions: [],
    pinnedProjectIds: ['p1', 'p2'],
    pinnedSessionIds: [],
    selectedSessionIdByProject: {},
    selectedProjectId: 'p1',
    settings: {
      appearance: 'system',
      reduceMotion: false,
      grokCliPath: resolve('qa/mock-grok.mjs'),
      maxLiveSessions: 4
    }
  }, null, 2)}\n`, { mode: 0o600 })

  let app: ElectronApplication | undefined
  try {
    ;({ app } = await launch(profile, openLog))
    let page = await app.firstWindow()
    await expectProjectOrder(page, ['p1', 'p2', 'u1', 'u2'])

    await openProjectMenu(page, 'Pinned Two')
    await page.getByRole('menuitem', { name: 'Move Up' }).click()
    await expectProjectOrder(page, ['p2', 'p1', 'u1', 'u2'])

    await openProjectMenu(page, 'Regular Two')
    await page.getByRole('menuitem', { name: 'Move Up' }).click()
    await expectProjectOrder(page, ['p2', 'p1', 'u2', 'u1'])

    await openProjectMenu(page, 'Pinned Two')
    await expect(page.getByRole('menuitem', { name: 'Move Up' })).toBeDisabled()
    await page.getByRole('button', { name: 'Actions for project Pinned Two' }).click()
    await openProjectMenu(page, 'Regular Two')
    await expect(page.getByRole('menuitem', { name: 'Move Up' })).toBeDisabled()
    await page.getByRole('button', { name: 'Actions for project Regular Two' }).click()

    const beforeRestart = await bootstrap(page)
    expect(beforeRestart.pinnedProjectIds).toEqual(['p2', 'p1'])
    expect(beforeRestart.selectedProjectId).toBe('p1')
    await app.close()
    app = undefined

    ;({ app } = await launch(profile, openLog))
    page = await app.firstWindow()
    await expectProjectOrder(page, ['p2', 'p1', 'u2', 'u1'])
    expect((await bootstrap(page)).selectedProjectId).toBe('p1')

    await page.getByRole('button', { name: 'Open in' }).click()
    const openMenu = page.getByRole('menu', { name: 'Open Pinned One in' })
    await expect(openMenu.getByRole('menuitem')).toHaveText(['Finder', 'Cursor'])
    await expect(openMenu).not.toContainText('VS Code')
    await openMenu.getByRole('menuitem', { name: 'Cursor' }).click()
    await expect.poll(async () => {
      try {
        return (await readFile(openLog, 'utf8')).trim().split('\n').filter(Boolean)
      } catch {
        return []
      }
    }).toEqual([JSON.stringify({ target: 'cursor' })])

    const rejected = await page.evaluate(async () => {
      try {
        await (globalThis as unknown as {
          grokbuild: { openProject: (input: unknown) => Promise<unknown> }
        }).grokbuild.openProject({
          projectId: 'p1',
          target: 'calculator',
          path: '/private/QA_PROJECT_OPEN_SECRET',
          argv: ['--unsafe']
        })
        return false
      } catch {
        return true
      }
    })
    expect(rejected).toBe(true)
    expect(await readFile(openLog, 'utf8')).not.toContain('QA_PROJECT_OPEN_SECRET')
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function launch(
  profile: string,
  openLog: string
): Promise<{ app: ElectronApplication }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
      GROKBUILD_USER_DATA_DIR: profile,
      GROKBUILD_E2E: '1',
      GROKBUILD_E2E_PROJECT_OPEN_LOG: openLog,
      TZ: 'UTC',
      LANG: 'en_US.UTF-8'
    }
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return { app }
}

async function openProjectMenu(page: Page, projectName: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for project ${projectName}` }).click()
  await expect(page.getByRole('menu', { name: `Project actions for ${projectName}` })).toBeVisible()
}

async function expectProjectOrder(page: Page, ids: string[]): Promise<void> {
  await expect.poll(async () => {
    const rows = page.getByTestId('project-list').locator('.project-group')
    return Promise.all(Array.from({ length: await rows.count() }, async (_, index) =>
      (await rows.nth(index).getAttribute('data-testid'))?.replace('project-', '')
    ))
  }).toEqual(ids)
}

async function bootstrap(page: Page): Promise<AppSnapshot> {
  return page.evaluate(() => (
    globalThis as unknown as { grokbuild: { bootstrap: () => Promise<AppSnapshot> } }
  ).grokbuild.bootstrap())
}
