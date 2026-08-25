import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('keeps Dashboard sessions and Git status isolated to the selected project', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grokbuild-dashboard-isolation-e2e-')))
  const profile = join(root, 'profile')
  const projectA = join(root, 'alpha-repository')
  const projectB = join(root, 'beta-plain-folder')
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(projectA),
    mkdir(projectB)
  ])

  // Exercise the same fixed Git executable as the production inspector. An
  // unborn branch is enough for branch/status inspection and avoids commits.
  await execFileAsync('/usr/bin/git', ['init'], { cwd: projectA })
  await execFileAsync(
    '/usr/bin/git',
    ['symbolic-ref', 'HEAD', 'refs/heads/qa-dashboard-alpha'],
    { cwd: projectA }
  )
  await writeFile(join(projectA, 'one-untracked-file.txt'), 'dashboard fixture\n')
  await writePersistedFixture(profile, projectA, projectB)

  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: ['.'],
      cwd: resolve('.'),
      env: {
        ...process.env,
        GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
        GROKBUILD_USER_DATA_DIR: profile,
        GROKBUILD_E2E: '1',
        TZ: 'UTC',
        LANG: 'en_US.UTF-8'
      }
    })
    app.process().stderr?.on('data', (chunk) => process.stderr.write(`[electron] ${chunk}`))
    const page = await app.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()

    const dashboardTrigger = page.getByRole('button', { name: 'Dashboard' })
    await dashboardTrigger.click()
    const dashboard = page.getByRole('dialog', { name: 'Sessions Dashboard' })
    await expect(dashboard).toBeVisible()

    // ModalSurface must remain a native top-layer dialog and put initial focus
    // on its explicit close affordance.
    expect(await dashboard.evaluate((node) => {
      const dialogElement = node as unknown as {
        tagName: string
        open: boolean
        matches: (selector: string) => boolean
      }
      return {
        tagName: dialogElement.tagName,
        open: dialogElement.open,
        topLayer: dialogElement.matches(':modal')
      }
    })).toEqual({ tagName: 'DIALOG', open: true, topLayer: true })
    const closeDashboard = dashboard.getByRole('button', { name: 'Close Sessions Dashboard' })
    await expect(closeDashboard).toBeFocused()

    const needsReview = dashboard.getByRole('region', { name: 'Needs review' })
    await expect(needsReview).toContainText('Alpha-only local session')
    await expect(needsReview).toContainText('qa-dashboard-alpha')
    await expect(needsReview).toContainText('1 changed')
    await expect(dashboard.getByText('Beta-only local session')).toHaveCount(0)

    await closeDashboard.click()
    await expect(dashboard).toBeHidden()
    await page.getByTestId('project-project-b').locator('.project-row').click()
    await expect(page.locator('.topbar-title')).toContainText('Beta Plain Folder')
    await expect(page.locator('.topbar-title')).toContainText('Beta-only local session')

    await page.getByRole('button', { name: 'Dashboard' }).click()
    const projectBDashboard = page.getByRole('dialog', { name: 'Sessions Dashboard' })
    await expect(projectBDashboard).toBeVisible()
    const idle = projectBDashboard.getByRole('region', { name: 'Idle' })
    await expect(idle).toContainText('Beta-only local session')
    await expect(projectBDashboard.getByText('Alpha-only local session')).toHaveCount(0)
    await expect(projectBDashboard.getByText('qa-dashboard-alpha')).toHaveCount(0)
    await expect(projectBDashboard.getByText(/\d+ changed/)).toHaveCount(0)

    const projectBStatus = await inspectDashboard(page)
    expect(projectBStatus).toEqual({
      projectId: 'project-b',
      isRepository: false,
      isWorktree: false,
      dirtyCount: 0
    })
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function writePersistedFixture(
  profile: string,
  projectA: string,
  projectB: string
): Promise<void> {
  const createdAt = '2026-08-25T00:00:00.000Z'
  const localSession = (
    id: string,
    projectId: string,
    title: string,
    messageId: string
  ): Record<string, unknown> => ({
    id,
    projectId,
    title,
    status: 'idle',
    model: 'grok-4.6',
    mode: 'default',
    reasoningEffort: 'xhigh',
    permissionMode: 'ask',
    contextUsed: 0,
    contextLimit: 500_000,
    transcript: [{
      id: messageId,
      kind: 'message',
      role: 'user',
      text: 'Local persisted fixture',
      createdAt
    }],
    createdAt,
    updatedAt: createdAt
  })

  await writeFile(join(profile, 'state.json'), `${JSON.stringify({
    version: 4,
    projects: [
      {
        id: 'project-a',
        name: 'Alpha Repository',
        path: projectA,
        sessionIds: ['session-a'],
        createdAt
      },
      {
        id: 'project-b',
        name: 'Beta Plain Folder',
        path: projectB,
        sessionIds: ['session-b'],
        createdAt
      }
    ],
    sessions: [
      localSession('session-a', 'project-a', 'Alpha-only local session', 'message-a'),
      localSession('session-b', 'project-b', 'Beta-only local session', 'message-b')
    ],
    pinnedProjectIds: [],
    pinnedSessionIds: [],
    settledSessionIds: [],
    selectedSessionIdByProject: {
      'project-a': 'session-a',
      'project-b': 'session-b'
    },
    selectedProjectId: 'project-a',
    selectedSessionId: 'session-a',
    settings: {
      appearance: 'system',
      reduceMotion: false,
      grokCliPath: resolve('qa/mock-grok.mjs'),
      maxLiveSessions: 4
    }
  }, null, 2)}\n`, { mode: 0o600 })
}

async function inspectDashboard(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (
    globalThis as unknown as {
      grokbuild: { inspectDashboardGit: () => Promise<Record<string, unknown>> }
    }
  ).grokbuild.inspectDashboardGit())
}
