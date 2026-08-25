import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { canonicalizeRpcSequence, canonicalizeSnapshot } from '../../src/shared/qa/canonicalState'
import { IPC } from '../../src/shared/ipcChannels'

let electronApp: ElectronApplication | undefined
let page: Page
let profilePath: string
let transcriptPath: string
let mcpStatePath: string
let mcpDoctorMarkerPath: string
let mcpCwdLogPath: string
let updateCwdLogPath: string
let updateStatePath: string
let sessionHistoryStatePath: string
let sessionHistoryLogPath: string
let doctorAuthPath: string
let doctorConfigPath: string
let workspacePath: string
const SWIFT_ACTIVITY_CANARY = 'QA_SWIFT_ACTIVITY_SECRET_5F29'

test.beforeEach(async () => {
  profilePath = await mkdtemp(join(tmpdir(), 'grokbuild-electron-e2e-'))
  workspacePath = join(profilePath, 'qa-workspace')
  transcriptPath = join(profilePath, 'rpc.ndjson')
  mcpStatePath = join(profilePath, 'mcp-state.json')
  mcpDoctorMarkerPath = join(profilePath, 'mcp-doctor-launched')
  mcpCwdLogPath = join(profilePath, 'mcp-cwd.ndjson')
  updateCwdLogPath = join(profilePath, 'update-cwd.ndjson')
  updateStatePath = join(profilePath, 'update-state.txt')
  sessionHistoryStatePath = join(profilePath, 'session-history.json')
  sessionHistoryLogPath = join(profilePath, 'session-history.ndjson')
  doctorAuthPath = join(profilePath, 'doctor-auth.json')
  doctorConfigPath = join(profilePath, 'doctor-config.toml')
  await mkdir(workspacePath)
  electronApp = await launchFixture()
  electronApp.process().stderr?.on('data', (chunk) => process.stderr.write(`[electron] ${chunk}`))
  page = await electronApp.firstWindow()
  page.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`))
  page.on('pageerror', (error) => console.error(`[renderer:error] ${error.message}`))
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterEach(async () => {
  await electronApp?.close()
  await rm(profilePath, { recursive: true, force: true })
})

test('keeps Node isolated and exposes only the named bridge', async () => {
  const rendererSurface = await page.evaluate(() => ({
    process: typeof (globalThis as unknown as { process?: unknown }).process,
    require: typeof (globalThis as unknown as { require?: unknown }).require,
    bridge: Object.keys((globalThis as unknown as { grokbuild: object }).grokbuild).sort()
  }))
  expect(rendererSurface).toEqual({
    process: 'undefined',
    require: 'undefined',
    bridge: [
      'addMcp',
      'answerInteraction',
      'answerPermission',
      'bindSavedAgent',
      'bootstrap',
      'cancelAttachments',
      'cancelSwiftImport',
      'cancelTurn',
      'captureClipboardImage',
      'checkAccount',
      'checkDoctor',
      'checkUpdates',
      'chooseAttachments',
      'chooseGrokCli',
      'chooseProject',
      'closeSession',
      'commitSwiftImport',
      'createSavedAgent',
      'createSession',
      'deleteMemory',
      'deleteSavedAgent',
      'deleteSessionHistory',
      'disableMcp',
      'doctorMcp',
      'duplicateSession',
      'enableMcp',
      'forkSession',
      'inspectDashboardGit',
      'installAppUpdate',
      'installCliUpdate',
      'installStarterAgents',
      'listGrokAgentCatalog',
      'listMcp',
      'listMemory',
      'listProjectOpenTargets',
      'listSessionHistory',
      'moveProject',
      'onOpenSettings',
      'onStateChanged',
      'openAppRelease',
      'openProject',
      'openSessionHistory',
      'previewSwiftImport',
      'readMemory',
      'recoverSavedAgentRoster',
      'rememberMemory',
      'removeMcp',
      'removeProject',
      'retrySession',
      'searchSessionHistory',
      'selectProject',
      'selectSession',
      'sendPrompt',
      'setProjectPinned',
      'setSessionPinned',
      'setSessionSettled',
      'setSessionUnread',
      'updateSavedAgent',
      'updateSession',
      'updateSettings'
    ]
  })

  const preferences = await electronApp!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const contents = window?.webContents as unknown as {
      getLastWebPreferences: () => Record<string, unknown>
    } | undefined
    return contents?.getLastWebPreferences()
  })
  expect(preferences).toMatchObject({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true
  })
  await expect(page.getByRole('button', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'History' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Workflows' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeDisabled()
  await expect(page.getByRole('searchbox', { name: 'Filter agents, projects, and sessions' })).toBeVisible()
  await expect.poll(() => electronApp!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getMinimumSize()
  )).toEqual([1100, 720])
})

test('applies appearance and reduce-motion settings to the document root', async () => {
  await page.evaluate(() =>
    (globalThis as unknown as {
      grokbuild: { updateSettings: (input: { appearance: 'dark'; reduceMotion: true }) => Promise<void> }
    }).grokbuild.updateSettings({ appearance: 'dark', reduceMotion: true })
  )
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true')
  const applied = await page.evaluate(() => {
    const browser = globalThis as unknown as {
      document: {
        documentElement: unknown
        body: { append: (node: unknown) => void }
        createElement: (tag: string) => { className: string; remove: () => void }
      }
      getComputedStyle: (node: unknown) => { colorScheme: string; animationName: string }
    }
    const probe = browser.document.createElement('span')
    probe.className = 'spinning'
    browser.document.body.append(probe)
    const result = {
      colorScheme: browser.getComputedStyle(browser.document.documentElement).colorScheme,
      animationName: browser.getComputedStyle(probe).animationName
    }
    probe.remove()
    return result
  })
  expect(applied).toEqual({ colorScheme: 'dark', animationName: 'none' })
})

test('projects Privacy Mode at DOM, input, AX, native-dialog, and restart boundaries', async () => {
  await startChat()
  const rawBefore = await page.evaluate(() => (
    globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }
  ).grokbuild.bootstrap())
  const project = rawBefore.projects[0]!
  const session = rawBefore.sessions[0]!

  await page.getByRole('button', { name: 'History' }).click()
  let history = page.getByRole('dialog', { name: 'Sessions History' })
  await expect(history.getByText('Archived release notes')).toBeVisible()
  const rawHistory = await page.evaluate(() => (
    globalThis as unknown as {
      grokbuild: { listSessionHistory: () => Promise<Array<{ summary: string }>> }
    }
  ).grokbuild.listSessionHistory())
  await history.getByRole('searchbox', { name: 'Search CLI session history' }).fill('release')
  await expect(history.getByText('Historical auth repair')).toHaveCount(0)
  await history.getByRole('button', { name: 'Close Sessions History' }).click()

  const sidebarSearch = page.getByRole('searchbox', {
    name: 'Filter agents, projects, and sessions'
  })
  await sidebarSearch.fill(project.name)
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Agents', exact: true }).click()
  await settings.getByRole('button', { name: 'Starter crew' }).click()
  await expect(settings.locator('.saved-agent-list')).toContainText('Chief')
  const rawWithAgents = await page.evaluate(() => (
    globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }
  ).grokbuild.bootstrap())
  if (rawWithAgents.agentRoster.status !== 'ready') throw new Error('Expected ready Saved Agent roster')
  const chief = rawWithAgents.agentRoster.agents.find((agent) => agent.name === 'Chief')!

  await settings.getByRole('button', { name: 'Application', exact: true }).click()
  const privacyToggle = settings.getByRole('checkbox', { name: 'Privacy Mode' })
  await privacyToggle.click()
  await expect(privacyToggle).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute('data-privacy', 'true')
  await expect(settings.getByLabel('Grok CLI path')).toHaveValue('••••')
  await settings.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(settings).toContainText('Saved Agent 1')
  await expect(settings).toContainText('Instructions hidden')
  await expect(settings).toContainText('Catalog details hidden')
  await expect(settings.getByRole('button', { name: 'New Agent' })).toBeDisabled()
  await expect(settings.getByRole('button', { name: 'Edit Saved Agent 1' })).toBeDisabled()

  const settingsInputValues = await page.locator('input, textarea, select').evaluateAll(
    (elements) => elements.map((element) => (element as HTMLInputElement).value)
  )
  const settingsSurface = `${await page.content()}\n${JSON.stringify(settingsInputValues)}\n${await fullAccessibilityTree()}`
  for (const canary of [
    project.name,
    project.path,
    session.title,
    rawBefore.settings.grokCliPath,
    chief.name,
    chief.mission,
    'general-purpose'
  ]) {
    expect(settingsSurface).not.toContain(canary)
  }

  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect(sidebarSearch).toBeDisabled()
  await expect(sidebarSearch).toHaveValue('')
  await expect(sidebarSearch).toHaveAttribute('placeholder', 'Search hidden while private')
  await expect(page.getByRole('button', { name: 'Open Project 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Session 1' })).toBeVisible()
  const savedAgentSelector = page.getByRole('combobox', { name: 'Saved Agent' })
  await expect(savedAgentSelector).toContainText('Saved Agent 1')
  await expect(savedAgentSelector).not.toContainText(chief.name)

  await page.getByRole('button', { name: 'History' }).click()
  history = page.getByRole('dialog', { name: 'Sessions History' })
  await expect(history).toContainText('Saved session 1')
  await expect(history.getByRole('button', { name: 'Open Saved session 1' })).toBeVisible()
  await expect(history.getByRole('button', { name: 'Delete history session Saved session 1' })).toBeVisible()
  await expect(history.getByRole('searchbox', { name: 'Search CLI session history' })).toBeDisabled()
  await expect(history.getByRole('searchbox', { name: 'Search CLI session history' })).toHaveValue('')
  await electronApp!.evaluate(({ dialog }) => {
    const scope = globalThis as unknown as {
      __grokbuildPrivacyConfirmation?: Record<string, unknown>
    }
    dialog.showMessageBox = (async (...args: unknown[]) => {
      scope.__grokbuildPrivacyConfirmation = (args.length > 1 ? args[1] : args[0]) as Record<string, unknown>
      return { response: 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
  await history.locator('.history-delete').first().click()
  const nativeConfirmation = await electronApp!.evaluate(() => (
    globalThis as unknown as { __grokbuildPrivacyConfirmation?: Record<string, unknown> }
  ).__grokbuildPrivacyConfirmation)
  expect(nativeConfirmation).toMatchObject({
    detail: 'This saved session will be deleted from Grok CLI history.'
  })

  const historySurface = `${await page.content()}\n${await fullAccessibilityTree()}\n${JSON.stringify(nativeConfirmation)}`
  for (const record of rawHistory) expect(historySurface).not.toContain(record.summary)
  expect(historySurface).not.toContain(project.name)
  expect(historySurface).not.toContain(project.path)

  await history.getByRole('button', { name: 'Close Sessions History' }).click()
  await page.getByRole('button', { name: 'Dashboard' }).click()
  const dashboard = page.getByRole('dialog', { name: 'Sessions Dashboard' })
  await expect(dashboard).toContainText('Project 1')
  await expect(dashboard).toContainText('Session 1')
  await expect(dashboard.getByRole('button', { name: 'Open Session 1' })).toBeVisible()
  await expect(dashboard).not.toContainText(project.name)
  await expect(dashboard).not.toContainText(session.title)
  await dashboard.getByRole('button', { name: 'Close Sessions Dashboard' }).click()

  const rawPrivate = await page.evaluate(() => (
    globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }
  ).grokbuild.bootstrap())
  expect(rawPrivate.settings.privacyMode).toBe(true)
  expect(rawPrivate.projects[0]).toMatchObject({ name: project.name, path: project.path })
  expect(rawPrivate.sessions[0]?.title).toBe(session.title)
  expect(JSON.stringify(rawPrivate.agentRoster)).toContain(chief.name)
  expect(JSON.stringify(rawPrivate.agentRoster)).toContain(chief.mission)

  await electronApp!.close()
  electronApp = await launchFixture()
  page = await electronApp.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-privacy', 'true')
  await expect(page.locator('.topbar-title')).toContainText('Project 1')
  const restartedDom = await page.content()
  expect(restartedDom).not.toContain(project.name)
  expect(restartedDom).not.toContain(project.path)
  expect(restartedDom).not.toContain(session.title)
})

test('reports signed-out Doctor state and rechecks without exposing credentials or paths', async () => {
  const credentialCanary = 'QA_DOCTOR_CREDENTIAL_CANARY_5D91'
  await page.locator('.settings-row').click()

  const doctor = page.getByTestId('grok-doctor')
  await expect(doctor).toBeVisible()
  await expect(doctor.locator('.doctor-check')).toHaveCount(4)
  await expect(page.getByTestId('doctor-check-auth')).toContainText(
    'Signed out — run grok login to authenticate.'
  )
  await expect(page.getByTestId('doctor-login-remediation')).toContainText('grok login')

  await writeFile(doctorAuthPath, JSON.stringify({ access_token: credentialCanary }))
  await writeFile(doctorConfigPath, `# ${credentialCanary}\n`)
  await doctor.getByRole('button', { name: 'Recheck' }).click()
  await expect(page.getByTestId('doctor-check-auth')).toContainText(
    'Cached sign-in credentials are present.'
  )
  await expect(page.getByTestId('doctor-check-config')).toContainText(
    'Present in your grok config directory.'
  )
  await expect(page.getByTestId('doctor-login-remediation')).toHaveCount(0)

  const snapshot = await page.evaluate(() =>
    (globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }).grokbuild.bootstrap()
  )
  const dom = await page.content()
  await expect.poll(async () => readFile(join(profilePath, 'profile/state.json'), 'utf8'))
    .toContain('qa-workspace')
  const persisted = await readFile(join(profilePath, 'profile/state.json'), 'utf8')
  for (const surface of [JSON.stringify(snapshot), dom, persisted]) {
    expect(surface).not.toContain(credentialCanary)
    expect(surface).not.toContain(doctorAuthPath)
    expect(surface).not.toContain(doctorConfigPath)
  }
})

test('sends bounded multimodal blocks without exposing attachment capabilities or bytes', async () => {
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const imagePath = join(workspacePath, 'pixel.png')
  const notePath = join(workspacePath, 'notes.txt')
  const fileContentCanary = 'ATTACHMENT_FILE_CONTENT_CANARY_73B4'
  await writeFile(imagePath, Buffer.from(imageBase64, 'base64'))
  await writeFile(notePath, fileContentCanary)
  await electronApp!.evaluate(({ dialog }, selectedPaths) => {
    const mutableDialog = dialog as unknown as {
      showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>
    }
    mutableDialog.showOpenDialog = async () => ({ canceled: false, filePaths: selectedPaths })
  }, [imagePath, notePath])

  await startChat()
  await page.getByTestId('attach-files').click()
  const attachments = page.getByTestId('attachment-strip')
  // Images render as preview thumbnails (name in the tooltip), files as chips.
  await expect(attachments.locator('.attachment-thumb[title="pixel.png"] img')).toBeVisible()
  await expect(attachments).toContainText('notes.txt')
  await expect(attachments).not.toContainText(workspacePath)
  await electronApp!.evaluate(({ dialog }) => {
    const mutableDialog = dialog as unknown as {
      showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>
    }
    mutableDialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })
  await page.getByTestId('attach-files').click()
  await expect(attachments).toBeHidden()
  await electronApp!.evaluate(({ dialog }, selectedPaths) => {
    const mutableDialog = dialog as unknown as {
      showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>
    }
    mutableDialog.showOpenDialog = async () => ({ canceled: false, filePaths: selectedPaths })
  }, [imagePath, notePath])
  await page.getByTestId('attach-files').click()
  await expect(attachments.locator('.attachment-thumb[title="pixel.png"] img')).toBeVisible()
  await expect(attachments).toContainText('notes.txt')
  await page.getByTestId('prompt-input').fill('Inspect selected attachments')
  await page.getByTestId('send-prompt').click()
  await expect(page.getByText('GROKBUILD_QA_OK')).toBeVisible()
  await expect(attachments).toBeHidden()

  const entries = (await readFile(transcriptPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as {
      direction: string
      frame: {
        method?: string
        params?: { prompt?: Array<Record<string, string>> }
      }
    })
  const prompt = entries.find((entry) =>
    entry.direction === 'client->agent' && entry.frame.method === 'session/prompt'
  )?.frame.params?.prompt
  expect(prompt).toEqual([
    { type: 'text', text: 'Attached file: notes.txt' },
    { type: 'text', text: 'Inspect selected attachments' },
    { type: 'text', text: 'Attached image: pixel.png' },
    { type: 'image', data: imageBase64, mimeType: 'image/png' }
  ])
  expect(JSON.stringify(entries)).not.toContain(fileContentCanary)

  const snapshot = await page.evaluate(() =>
    (globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }).grokbuild.bootstrap()
  )
  const serializedSnapshot = JSON.stringify(snapshot)
  const dom = await page.content()
  await expect.poll(async () => readFile(join(profilePath, 'profile/state.json'), 'utf8'))
    .toContain('Inspect selected attachments')
  const persisted = await readFile(join(profilePath, 'profile/state.json'), 'utf8')
  for (const surface of [serializedSnapshot, persisted, dom]) {
    expect(surface).not.toContain(imageBase64)
    expect(surface).not.toContain(imagePath)
    expect(surface).not.toContain(notePath)
    expect(surface).not.toContain(fileContentCanary)
  }
})

test('persists pin order and keeps project/session lifecycle worker-scoped', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('Run the QA contract')
  await page.getByTestId('send-prompt').click()
  await expect(page.getByText('GROKBUILD_QA_OK')).toBeVisible()
  await expect.poll(acpWorkerCount).toBe(1)

  await page.getByRole('button', { name: 'Actions for session New chat 1', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Duplicate Session' }).click()
  await expect(page.locator('.topbar-title')).toContainText('New chat 1 (copy)')
  await expect(page.getByTestId('empty-transcript')).toBeVisible()

  await page.getByTestId('prompt-input').fill('Run the QA contract')
  await page.getByTestId('send-prompt').click()
  await expect(page.getByText('GROKBUILD_QA_OK')).toHaveCount(1)
  await expect.poll(acpWorkerCount).toBe(2)

  await page.getByRole('button', { name: 'Actions for session New chat 1 (copy)' }).click()
  await page.getByRole('menuitem', { name: 'Pin Session' }).click()
  await expect(page.getByRole('region', { name: 'Pinned sessions' })).toContainText('New chat 1 (copy)')
  let current = await page.evaluate(() =>
    (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> } })
      .grokbuild.bootstrap()
  )
  expect(current.pinnedSessionIds).toEqual([current.selectedSessionId])

  await page.getByRole('button', { name: 'Actions for session New chat 1 (copy)' }).click()
  await page.getByRole('menuitem', { name: 'Close Session' }).click()
  await expect(page.locator('.topbar-title')).toContainText('New chat 1')
  await expect.poll(acpWorkerCount).toBe(1)
  current = await page.evaluate(() =>
    (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> } })
      .grokbuild.bootstrap()
  )
  expect(current.sessions.map((session) => session.title)).toEqual(['New chat 1'])
  expect(current.pinnedSessionIds).toEqual([])

  await page.getByRole('button', { name: /Actions for project/ }).click()
  await page.getByRole('menuitem', { name: 'Pin to Top' }).click()
  current = await page.evaluate(() =>
    (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> } })
      .grokbuild.bootstrap()
  )
  expect(current.pinnedProjectIds).toEqual([current.selectedProjectId])

  await page.getByRole('button', { name: /Actions for project/ }).click()
  await page.getByRole('menuitem', { name: 'Remove Project' }).click()
  const confirmation = page.getByRole('alertdialog', { name: /Remove project/ })
  await expect(confirmation).toContainText('Files stay on disk')
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('project-list').locator('.project-group')).toHaveCount(1)

  await page.getByRole('button', { name: /Actions for project/ }).click()
  await page.getByRole('menuitem', { name: 'Remove Project' }).click()
  await page.getByRole('alertdialog', { name: /Remove project/ })
    .getByRole('button', { name: 'Remove Project' }).click()
  await expect(page.getByText('Bring a project into focus')).toBeVisible()
  await expect.poll(acpWorkerCount).toBe(0)
  await expect.poll(async () => {
    const state = JSON.parse(await readFile(join(profilePath, 'profile/state.json'), 'utf8')) as {
      version: number
      projects: unknown[]
      pinnedProjectIds: unknown[]
      pinnedSessionIds: unknown[]
    }
    return [state.version, state.projects.length, state.pinnedProjectIds.length, state.pinnedSessionIds.length]
  }).toEqual([5, 0, 0, 0])
})

test('shows a current-project Dashboard with live status truth and a bounded Git projection', async () => {
  await startChat()
  await page.getByRole('button', { name: 'Actions for session New chat 1', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Duplicate Session' }).click()
  await expect(page.locator('.topbar-title')).toContainText('New chat 1 (copy)')

  await page.getByRole('button', { name: 'Actions for session New chat 1', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Mark as Unread' }).click()
  await page.getByRole('button', { name: 'Actions for session New chat 1 (copy)' }).click()
  await expect(page.getByRole('menuitem', { name: 'Duplicate Session' })).toBeVisible()
  const dashboardTrigger = page.getByRole('button', { name: 'Dashboard' })
  await dashboardTrigger.click()

  const dashboard = page.getByRole('dialog', { name: 'Sessions Dashboard' })
  await expect(dashboard).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Duplicate Session' })).toHaveCount(0)
  await expect(dashboard.getByRole('button', { name: 'Close Sessions Dashboard' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dashboard).toBeHidden()
  await expect(dashboardTrigger).toBeFocused()
  await dashboardTrigger.click()
  await expect(dashboard).toBeVisible()
  await expect(dashboard).toContainText('live and restored chats')
  await expect(dashboard.getByRole('region', { name: 'Needs you' })).toContainText('New chat 1')
  await expect(dashboard.getByRole('region', { name: 'Idle' })).toContainText('New chat 1 (copy)')
  await expect(dashboard).toContainText(
    'Dashboard shows current-project tabs. CLI Sessions History is a separate data source.'
  )

  const hostileCanary = 'DASHBOARD_PRIVATE_PATH_CANARY_0D3E'
  const status = await page.evaluate(async (canary) => {
    const bridge = (globalThis as unknown as {
      grokbuild: { inspectDashboardGit: (...args: unknown[]) => Promise<Record<string, unknown>> }
    }).grokbuild
    return await bridge.inspectDashboardGit({ cwd: `/private/${canary}`, extra: canary })
  }, hostileCanary)
  expect(Object.keys(status).sort()).toEqual(['dirtyCount', 'isRepository', 'isWorktree', 'projectId'])
  expect(JSON.stringify(status)).not.toContain(hostileCanary)

  await dashboard.getByRole('region', { name: 'Needs you' })
    .getByRole('button', { name: /New chat 1/ })
    .click()
  await expect(dashboard).toBeHidden()
  await expect(page.locator('.topbar-title')).toContainText('New chat 1')
})

test('projects CLI-owned Tasks, Workflows, and Goal state without exposing raw identities', async () => {
  await startChat()
  const tasksTrigger = page.getByRole('button', { name: /^Tasks/ })
  await expect(tasksTrigger).toBeDisabled()
  await page.getByTestId('prompt-input').fill('exercise activity projection please')
  await page.getByTestId('send-prompt').click()
  await expect(page.getByText('Session activity projection received.')).toBeVisible()
  await expect(tasksTrigger).toBeEnabled()

  const current = await page.evaluate(() =>
    (globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }).grokbuild.bootstrap()
  )
  const selected = current.sessions.find((session) => session.id === current.selectedSessionId)
  expect(selected?.activities).toMatchObject({
    version: 1,
    syncState: 'live',
    unknownEventCount: 1,
    schedules: [expect.objectContaining({ label: 'Run focused checks', schedule: 'Every hour' })],
    background: [expect.objectContaining({ label: 'QA reviewer', kind: 'subagent' })],
    workflows: [expect.objectContaining({ name: 'Release confidence', status: 'active' })],
    goal: expect.objectContaining({ objective: 'Ship the verified desktop app', status: 'active' })
  })
  const publicJson = JSON.stringify(current)
  expect(publicJson).not.toContain('QA_ACTIVITY_PRIVATE_CANARY_4E19')
  expect(publicJson).not.toContain('STALE ACTIVITY LABEL')
  expect(publicJson).not.toContain('STALE WORKFLOW LABEL')
  expect(publicJson).not.toContain('WRONG SESSION')

  await tasksTrigger.click()
  const panel = page.getByRole('dialog', { name: 'Tasks & Workflows' })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Close Tasks and Workflows' })).toBeFocused()
  await expect(panel.getByRole('region', { name: 'Scheduled' })).toContainText('Run focused checks')
  await expect(panel.getByRole('region', { name: 'Background' })).toContainText('Observed in this session')
  await expect(panel.getByRole('region', { name: 'Workflow runs' })).toContainText('3 / 8 calls')
  await expect(panel.getByRole('region', { name: 'Goal' })).toContainText('42K / 120K tokens')
  await expect(panel).toContainText('1 unsupported update ignored')
  await expect(panel).toContainText(
    "Scheduled work runs only while GrokBuild is open and this session's Grok process remains active."
  )
  expect(await page.content()).not.toContain('QA_ACTIVITY_PRIVATE_CANARY_4E19')
  const persisted = await readFile(join(profilePath, 'profile/state.json'), 'utf8')
  expect(persisted).not.toContain('QA_ACTIVITY_PRIVATE_CANARY_4E19')
  expect(persisted).not.toContain('"activities":')

  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(tasksTrigger).toBeFocused()
  await page.getByRole('button', { name: 'Dashboard' }).click()
  const dashboard = page.getByRole('dialog', { name: 'Sessions Dashboard' })
  await expect(dashboard.getByRole('region', { name: 'Scheduled' })).toContainText('New chat 1')
})

test('searches, restores, and natively confirms deletion of opaque CLI history entries', async () => {
  const firstRemoteId = '11111111-1111-4111-8111-111111111111'
  const secondRemoteId = '22222222-2222-4222-8222-222222222222'
  const hostileCanary = 'HISTORY_PRIVATE_PATH_CANARY_D725'
  const projection = await page.evaluate(async (canary) => {
    const bridge = (globalThis as unknown as {
      grokbuild: { listSessionHistory: (...args: unknown[]) => Promise<Array<Record<string, unknown>>> }
    }).grokbuild
    return await bridge.listSessionHistory({ cwd: `/private/${canary}`, remoteId: canary })
  }, hostileCanary)
  expect(projection).toHaveLength(2)
  expect(Object.keys(projection[0] ?? {}).sort()).toEqual([
    'created', 'projectId', 'status', 'summary', 'token', 'updated'
  ])
  expect(JSON.stringify(projection)).not.toContain(hostileCanary)
  expect(JSON.stringify(projection)).not.toContain(firstRemoteId)
  expect(JSON.stringify(projection)).not.toContain(secondRemoteId)

  await page.getByRole('button', { name: 'History' }).click()
  const history = page.getByRole('dialog', { name: 'Sessions History' })
  await expect(history).toBeVisible()
  await expect(history.getByText('Historical auth repair')).toBeVisible()
  await expect(history.getByText('Archived release notes')).toBeVisible()
  await expect(history.getByRole('searchbox', { name: 'Search CLI session history' })).toBeFocused()
  await expect(page.locator('body')).not.toContainText(firstRemoteId)
  await expect(page.locator('body')).not.toContainText(secondRemoteId)

  const search = history.getByRole('searchbox', { name: 'Search CLI session history' })
  await search.fill('release')
  await expect(history.getByText('Archived release notes')).toBeVisible()
  await expect(history.getByText('Historical auth repair')).toHaveCount(0)
  await history.getByRole('button', { name: 'Clear history search' }).click()
  await expect(history.getByText('Historical auth repair')).toBeVisible()

  await electronApp!.evaluate(({ dialog }) => {
    const scope = globalThis as unknown as {
      __grokbuildHistoryConfirmations?: Array<Record<string, unknown>>
    }
    scope.__grokbuildHistoryConfirmations = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as {
        message?: unknown
        detail?: unknown
        buttons?: unknown
      }
      scope.__grokbuildHistoryConfirmations?.push({
        message: options.message,
        detail: options.detail,
        buttons: options.buttons
      })
      return { response: 1, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
  await history.getByRole('button', {
    name: 'Delete history session Archived release notes'
  }).click()
  await expect(history.getByText('Archived release notes')).toHaveCount(0)
  const confirmations = await electronApp!.evaluate(() => (
    globalThis as unknown as {
      __grokbuildHistoryConfirmations?: Array<Record<string, unknown>>
    }
  ).__grokbuildHistoryConfirmations ?? [])
  expect(confirmations).toHaveLength(1)
  expect(JSON.stringify(confirmations)).toContain('Archived release notes')
  expect(JSON.stringify(confirmations)).not.toContain(secondRemoteId)
  expect(JSON.stringify(confirmations)).not.toContain(workspacePath)

  await history.locator('.history-open').filter({ hasText: 'Historical auth repair' }).click()
  await expect(history).toBeHidden()
  await expect(page.locator('.topbar-title')).toContainText('Historical auth repair')
  await expect.poll(() => historyLoadRpcCount(firstRemoteId)).toBe(1)

  await page.getByRole('button', { name: 'History' }).click()
  await expect(history.getByText('Historical auth repair')).toBeVisible()
  await history.locator('.history-open').filter({ hasText: 'Historical auth repair' }).click()
  await expect(history).toBeHidden()
  await expect.poll(() => historyLoadRpcCount(firstRemoteId)).toBe(1)
  const snapshot = await page.evaluate(() => (
    globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }
  ).grokbuild.bootstrap())
  expect(snapshot.sessions).toHaveLength(1)
  expect(JSON.stringify(snapshot)).not.toContain(firstRemoteId)
})

test('filters active chats and keeps unread and settled shelves distinct', async () => {
  await startChat()
  await page.getByRole('button', { name: 'Actions for session New chat 1' }).click()
  await page.getByRole('menuitem', { name: 'Duplicate Session' }).click()
  await expect(page.locator('.topbar-title')).toContainText('New chat 1 (copy)')
  const sessionIds = await page.evaluate(() => {
    const bridge = (globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }).grokbuild
    return bridge.bootstrap().then((snapshot) => Object.fromEntries(
      snapshot.sessions.map((session) => [session.title, session.id])
    ))
  })
  const originalSessionId = sessionIds['New chat 1']
  const copiedSessionId = sessionIds['New chat 1 (copy)']
  expect(originalSessionId).toBeTruthy()
  expect(copiedSessionId).toBeTruthy()
  if (!originalSessionId || !copiedSessionId) throw new Error('Expected duplicate session ids')

  await page.getByTestId(`session-${originalSessionId}`).click()
  await expect(page.locator('.topbar-title')).toContainText('New chat 1')
  await page.getByRole('button', { name: 'Actions for session New chat 1 (copy)' }).click()
  await page.getByRole('menuitem', { name: 'Mark as Unread' }).click()
  await expect(page.getByTestId(`session-${copiedSessionId}`)).toContainText('Completed')

  const filter = page.getByRole('searchbox', { name: 'Filter agents, projects, and sessions' })
  await filter.fill('COPY')
  await expect(page.getByTestId(`session-${copiedSessionId}`)).toBeVisible()
  await expect(page.getByTestId(`session-${originalSessionId}`)).toHaveCount(0)

  await page.getByRole('button', { name: 'Actions for session New chat 1 (copy)' }).click()
  await page.getByRole('menuitem', { name: 'Settle Session' }).click()
  const settled = page.getByRole('region', { name: 'Settled sessions' })
  await expect(settled).toContainText('New chat 1 (copy)')
  await expect(page.getByTestId(`settled-session-${copiedSessionId}`)).toBeVisible()

  await page.getByRole('button', { name: 'Clear filter' }).click()
  await expect(page.getByRole('button', { name: 'Show 1 settled session' })).toBeVisible()
  await page.getByRole('button', { name: 'Show 1 settled session' }).click()
  await expect(settled).toContainText('New chat 1 (copy)')
  await page.getByRole('button', { name: 'Actions for session New chat 1 (copy)' }).click()
  await page.getByRole('menuitem', { name: 'Mark as Read' }).click()
  await page.getByRole('button', { name: 'Actions for session New chat 1 (copy)' }).click()
  await page.getByRole('menuitem', { name: 'Return to Active' }).click()
  await expect(page.getByRole('region', { name: 'Settled sessions' })).toHaveCount(0)
  await expect(page.getByTestId(`session-${copiedSessionId}`)).not.toContainText('Completed')
})

test('blocks unavailable workspaces without losing transcripts and recovers after a real folder returns', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('Run the QA contract')
  await page.getByTestId('send-prompt').click()
  await expect(page.getByText('GROKBUILD_QA_OK')).toBeVisible()
  await expect.poll(acpWorkerCount).toBe(1)
  expect(await promptRpcCount()).toBe(1)

  const projectRow = page.locator('.project-row').first()
  const registeredPath = await realpath(workspacePath)
  await expect(projectRow).toHaveAttribute('title', registeredPath)
  await rm(workspacePath, { recursive: true })
  await projectRow.click()

  const unavailable = page.getByTestId('workspace-unavailable-banner')
  await expect(unavailable).toContainText('Workspace folder is missing')
  await expect(page.locator('[data-testid^="workspace-health-"]')).toContainText('Folder missing')
  await expect(page.getByRole('button', { name: 'New chat' }).last()).toBeDisabled()
  await expect(page.getByTestId('prompt-input')).toBeDisabled()
  await expect(page.getByTestId('attach-files')).toBeDisabled()
  await expect(page.getByLabel('Agent mode')).toHaveCount(0)
  await expect(page.getByLabel('Model')).toBeDisabled()
  await expect(page.getByLabel('Tool permissions')).toBeDisabled()
  await expect(page.getByLabel('Reasoning effort')).toBeDisabled()
  await expect(page.getByTestId('retry-banner')).toHaveCount(0)
  await expect(page.getByText('GROKBUILD_QA_OK')).toBeVisible()
  await expect.poll(acpWorkerCount).toBe(0)

  const blockedMessage = await page.evaluate(async () => {
    const bridge = (globalThis as unknown as {
      grokbuild: {
        bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot>
        sendPrompt: (input: { sessionId: string; text: string }) => Promise<void>
      }
    }).grokbuild
    const snapshot = await bridge.bootstrap()
    try {
      await bridge.sendPrompt({ sessionId: snapshot.selectedSessionId!, text: 'must not spawn' })
      return 'unexpected success'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  expect(blockedMessage).toContain('The workspace folder is missing. Restore it, then check again.')
  expect(blockedMessage).not.toContain(workspacePath)
  expect(blockedMessage).not.toContain(registeredPath)
  expect(await promptRpcCount()).toBe(1)
  await expect.poll(acpWorkerCount).toBe(0)

  const replacement = join(profilePath, 'QA_SYMLINK_TARGET_CANARY')
  await mkdir(replacement)
  await symlink(replacement, workspacePath)
  await unavailable.getByRole('button', { name: 'Check again' }).click()
  await expect(unavailable).toContainText('Workspace location changed')
  expect(await unavailable.textContent()).not.toContain(workspacePath)
  expect(await unavailable.textContent()).not.toContain(registeredPath)
  expect(await unavailable.textContent()).not.toContain(replacement)
  expect(await promptRpcCount()).toBe(1)
  await expect.poll(acpWorkerCount).toBe(0)

  await rm(workspacePath)
  await mkdir(workspacePath)
  await unavailable.getByRole('button', { name: 'Check again' }).click()
  await expect(unavailable).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New chat' }).last()).toBeEnabled()
  await expect(page.getByTestId('prompt-input')).toBeEnabled()
  await page.getByTestId('prompt-input').fill('Workspace restored')
  await page.getByTestId('send-prompt').click()
  await expect(page.getByText('GROKBUILD_QA_OK').last()).toBeVisible()
  await expect.poll(promptRpcCount).toBe(2)
  await expect.poll(acpWorkerCount).toBe(1)

  const snapshot = await page.evaluate(() =>
    (globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }).grokbuild.bootstrap()
  )
  expect(snapshot.workspaceHealth).toEqual([{
    projectId: snapshot.selectedProjectId,
    state: 'ready'
  }])
  expect(JSON.stringify(snapshot.workspaceHealth)).not.toContain(workspacePath)
  expect(JSON.stringify(snapshot.workspaceHealth)).not.toContain(registeredPath)
  const persisted = JSON.parse(await readFile(join(profilePath, 'profile/state.json'), 'utf8')) as Record<string, unknown>
  expect(persisted).not.toHaveProperty('workspaceHealth')
})

test('previews and commits a count-only, idempotent Swift import without changing its source', async () => {
  const sourcePath = resolve('tests/fixtures/swift-state/sanitized.plist')
  const before = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
  await electronApp!.evaluate(({ dialog }, selectedPath) => {
    const mutableDialog = dialog as unknown as {
      showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>
    }
    mutableDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
  }, sourcePath)

  await page.locator('.settings-row').click()
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const importer = page.getByTestId('swift-import-settings')
  await importer.getByRole('button', { name: 'Choose plist…' }).click()

  let preview = page.getByTestId('swift-import-preview')
  await expect(preview).toBeVisible()
  await expect(preview.locator('[data-import-count="Projects to add"] strong')).toHaveText('1')
  await expect(preview.locator('[data-import-count="Sessions to add"] strong')).toHaveText('1')
  await expect(importer).not.toContainText(sourcePath)
  await expect(importer).not.toContainText('/tmp')
  await expect(importer).not.toContainText('Sanitized fixture prompt')
  await expect(importer).not.toContainText(SWIFT_ACTIVITY_CANARY)

  let current = await page.evaluate(() =>
    (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> } })
      .grokbuild.bootstrap()
  )
  expect(current.projects).toHaveLength(1)

  await preview.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByTestId('swift-import-complete')).toContainText('1 projects and 1 sessions added')
  await expect.poll(async () => {
    const snapshot = await page.evaluate(() =>
      (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> } })
        .grokbuild.bootstrap()
    )
    return [snapshot.projects.length, snapshot.sessions.length, snapshot.pinnedProjectIds.length, snapshot.pinnedSessionIds.length]
  }).toEqual([2, 1, 0, 0])
  const persisted = JSON.parse(await readFile(join(profilePath, 'profile/state.json'), 'utf8')) as {
    version: number
    projects: unknown[]
    sessions: unknown[]
  }
  expect([persisted.version, persisted.projects.length, persisted.sessions.length]).toEqual([5, 2, 1])
  current = await page.evaluate(() =>
    (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> } })
      .grokbuild.bootstrap()
  )
  expect(current.sessions[0]?.transcript.filter((item) => item.kind === 'activity')).toEqual([
    expect.objectContaining({
      entries: [
        { kind: 'read_skill', count: 1 },
        { kind: 'read_file', count: 2 },
        { kind: 'listed', count: 1 }
      ],
      hookCount: 2,
      isLead: true
    }),
    expect.objectContaining({
      entries: [{ kind: 'ran', count: 1 }],
      hookCount: 10_000,
      isLead: false
    }),
    expect.objectContaining({
      entries: [{ kind: 'other', count: 1 }],
      hookCount: 0,
      isLead: false
    })
  ])
  for (const surface of [JSON.stringify(current), JSON.stringify(persisted), await page.content()]) {
    expect(surface).not.toContain(SWIFT_ACTIVITY_CANARY)
    expect(surface).not.toContain(`/private/${SWIFT_ACTIVITY_CANARY}`)
    expect(surface).not.toContain(`xai-${SWIFT_ACTIVITY_CANARY}`)
    expect(surface).not.toContain(`bash /private/${SWIFT_ACTIVITY_CANARY}`)
  }

  await importer.getByRole('button', { name: 'Choose plist…' }).click()
  preview = page.getByTestId('swift-import-preview')
  await expect(preview.locator('[data-import-count="Projects to add"] strong')).toHaveText('0')
  await expect(preview.locator('[data-import-count="Sessions to add"] strong')).toHaveText('0')
  await preview.getByRole('button', { name: 'Cancel preview' }).click()
  await expect(preview).toBeHidden()

  current = await page.evaluate(() =>
    (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> } })
      .grokbuild.bootstrap()
  )
  expect([current.projects.length, current.sessions.length]).toEqual([2, 1])
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByTitle('Sanitized imported chat', { exact: true }).click()
  const importedActivities = page.getByTestId('activity-line')
  await expect(importedActivities).toHaveCount(3)
  await expect(importedActivities.nth(0)).toHaveAccessibleName(
    'Activity: Read 1 skill, Read 2 files, Listed 1 dir  [hooks: 2]'
  )
  await expect(importedActivities.nth(1)).toHaveAccessibleName(
    'Activity: Ran 1 command  [hooks: 10000]'
  )
  await expect(importedActivities.nth(2)).toHaveAccessibleName('Activity: Used 1 tool')
  expect(await page.content()).not.toContain(SWIFT_ACTIVITY_CANARY)
  expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(before)
})

test('manages CLI-owned MCP configuration through narrow, redacted settings IPC', async () => {
  await page.locator('.settings-row').click()
  await page.getByRole('button', { name: 'MCP Servers' }).click()

  const settings = page.getByTestId('mcp-settings')
  const serverList = page.getByTestId('mcp-server-list')
  await expect(settings).toBeVisible()
  await expect(serverList.getByText('qa-seeded', { exact: true })).toBeVisible()
  await expect(settings).not.toContainText('QA_MCP_SECRET_CANARY_41F7')
  await expect(access(mcpDoctorMarkerPath)).rejects.toMatchObject({ code: 'ENOENT' })

  await serverList.getByRole('button', { name: 'Disable qa-seeded' }).click()
  let seededRow = serverList.getByRole('listitem').filter({ hasText: 'qa-seeded' })
  await expect(seededRow).toContainText('disabled')
  await seededRow.getByRole('button', { name: 'Enable qa-seeded' }).click()
  seededRow = serverList.getByRole('listitem').filter({ hasText: 'qa-seeded' })
  await expect(seededRow.getByText('disabled', { exact: true })).toBeHidden()

  await settings.getByRole('button', { name: /Add server/ }).click()
  const addForm = page.getByTestId('mcp-add-form')
  await addForm.getByLabel('Name', { exact: true }).fill('qa-remote')
  await addForm.getByLabel('Scope', { exact: true }).selectOption('project')
  await addForm.getByLabel('Transport', { exact: true }).selectOption('http')
  await addForm.getByLabel('URL', { exact: true }).fill(
    'https://example.test/private/QA_MCP_SECRET_CANARY_41F7?token=QA_MCP_SECRET_CANARY_41F7#secret'
  )
  await addForm.getByRole('button', { name: 'Add server', exact: true }).click()

  const remoteRow = serverList.getByRole('listitem').filter({ hasText: 'qa-remote' })
  await expect(remoteRow).toContainText('https://example.test')
  await expect(settings).not.toContainText('QA_MCP_SECRET_CANARY_41F7')

  await remoteRow.getByRole('button', { name: 'Remove qa-remote from project scope' }).click()
  await remoteRow.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(serverList.getByText('qa-remote', { exact: true })).toBeHidden()

  await settings.getByRole('button', { name: 'Run diagnostics' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('launches external MCP commands')
  await expect(access(mcpDoctorMarkerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await page.getByRole('button', { name: 'Run external checks' }).click()
  await expect(page.getByTestId('mcp-doctor-result')).toContainText('healthy')
  await expect.poll(async () => readFile(mcpDoctorMarkerPath, 'utf8')).toBe('doctor launched')
  await expect(settings).not.toContainText('QA_MCP_SECRET_CANARY_41F7')

  const snapshot = await page.evaluate(() =>
    (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<unknown> } })
      .grokbuild.bootstrap()
  )
  expect(JSON.stringify(snapshot)).not.toMatch(/qa-seeded|qa-remote|QA_MCP_SECRET_CANARY_41F7/)
  const persistedState = await readFile(join(profilePath, 'profile/state.json'), 'utf8')
  expect(persistedState).not.toMatch(/qa-seeded|qa-remote|QA_MCP_SECRET_CANARY_41F7/)
  const mcpCwds = (await readFile(mcpCwdLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { cwd: string }).cwd)
  expect(mcpCwds.length).toBeGreaterThan(0)
  expect(new Set(mcpCwds)).toEqual(new Set([await realpath(workspacePath)]))
})

test('runs a deterministic streaming turn and renders canonical activity', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('Run the QA contract')
  await page.getByTestId('send-prompt').click()

  await expect(page.getByText('GROKBUILD_QA_OK')).toBeVisible()
  await expect(page.getByText('Read package.json')).toBeVisible()
  await expect(page.getByText('Report a deterministic result')).toBeVisible()
  await expect(page.getByText('28K/500K')).toBeVisible()
  const activityLines = page.getByTestId('activity-line')
  await expect(activityLines).toHaveCount(2)
  await expect(activityLines.nth(0)).toHaveAccessibleName(
    'Activity: Read 1 file  [hooks: 2]'
  )
  await expect(activityLines.nth(1)).toHaveAccessibleName('Activity: stop  [hooks: 3]')

  const contextMeter = page.getByRole('button', { name: 'Context usage' })
  await expect(contextMeter).toHaveAttribute('aria-expanded', 'false')
  await contextMeter.click()
  const contextDialog = page.getByRole('dialog', { name: 'Context Usage' })
  await expect(contextDialog).toBeVisible()
  await expect(contextDialog).toContainText('28,000 / 500,000 tokens')
  await expect(contextDialog.getByRole('progressbar', { name: 'Model context window used' }))
    .toHaveAttribute('aria-valuenow', '6')
  await expect(contextDialog.getByLabel('Input: 11,954')).toBeVisible()
  await expect(contextDialog.getByLabel('Cached: 7,639 cached (64%)')).toBeVisible()
  await expect(contextDialog.getByLabel('Output: 36')).toBeVisible()
  await expect(contextDialog.getByLabel('Reasoning: 0')).toBeVisible()
  await expect(contextDialog.getByLabel('Total: 11,990')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(contextDialog).toBeHidden()
  await expect(contextMeter).toBeFocused()

  const acpWorkers = await electronApp!.evaluate(({ app }) =>
    app.getAppMetrics().filter((metric) =>
      metric.type === 'Utility' &&
      (metric.name === 'GrokBuild ACP Session' || metric.serviceName === 'GrokBuild ACP Session')
    ).length
  )
  expect(acpWorkers).toBe(1)

  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
  await expect.poll(async () => {
    const current = await page.evaluate(() => (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<unknown> } }).grokbuild.bootstrap()) as import('../../src/shared/models').AppSnapshot
    return current.cli.version
  }).toBe('1.0.5')

  const current = await page.evaluate(() => (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<unknown> } }).grokbuild.bootstrap()) as import('../../src/shared/models').AppSnapshot
  expect(JSON.stringify(current)).not.toContain('QA_HOOK_SECRET_CANARY_2E77')
  expect(await page.content()).not.toContain('QA_HOOK_SECRET_CANARY_2E77')
  expect(await readFile(join(profilePath, 'profile/state.json'), 'utf8'))
    .not.toContain('QA_HOOK_SECRET_CANARY_2E77')
  const rpc = canonicalizeRpcSequence(await readFile(transcriptPath, 'utf8'))
  const expectedRpc = JSON.parse(await readFile(resolve('qa/baselines/electron/stream-rich.rpc.json'), 'utf8'))
  expect(rpc).toEqual(expectedRpc)
  const mode = ((await stat(join(profilePath, 'profile/state.json'))).mode & 0o777).toString(8).padStart(4, '0')
  const canonical = canonicalizeSnapshot(current, await realpath(join(profilePath, 'qa-workspace')), rpc, [{ path: 'state.json', mode }])
  const expectedState = JSON.parse(await readFile(resolve('qa/baselines/electron/stream-rich.state.json'), 'utf8'))
  expect(canonical).toEqual(expectedState)
})

test('executes reverse terminal requests without exposing a renderer terminal API', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('Run the terminal host QA contract')
  await page.getByTestId('send-prompt').click()

  await expect(page.getByText('Terminal host returned TERMINAL_HOST_QA_OK.')).toBeVisible()
  const bridgeKeys = await page.evaluate(() =>
    Object.keys((globalThis as unknown as { grokbuild: object }).grokbuild)
  )
  expect(bridgeKeys).not.toContain('terminal')
})

test('confines reverse filesystem requests to the selected project', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('Run the filesystem host QA contract')
  await page.getByTestId('send-prompt').click()

  await expect(page.getByText('Filesystem host returned FILESYSTEM_HOST_QA_OK.')).toBeVisible()
  await expect(readFile(join(profilePath, 'qa-workspace', 'grokbuild-fs-host-qa.txt'), 'utf8'))
    .resolves.toBe('FILESYSTEM_HOST_QA_OK')
})

test('round-trips a permission decision through main and ACP', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('permission please')
  await page.getByTestId('send-prompt').click()

  const card = page.getByTestId('permission-card')
  await expect(card).toContainText('Allow writing qa-result.txt?')
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(page.getByText('Permission qa-permission-1 resolved with allow_once.')).toBeVisible()
  await expect(card).toBeHidden()
})

test('serializes concurrent permission requests in FIFO order and ignores duplicates', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('permission queue please')
  await page.getByTestId('send-prompt').click()

  const card = page.getByTestId('permission-card')
  await expect(card).toContainText('Allow writing qa-result.txt?')
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(card).toContainText('Allow running the QA check?')
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(card).toBeHidden()
  await expect(page.getByText('Permission qa-permission-1 resolved with allow_once.')).toBeVisible()
  await expect(page.getByText('Permission qa-permission-2 resolved with allow_once.')).toBeVisible()

  const responses = (await readFile(transcriptPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: string; frame: { id?: string; result?: unknown } })
    .filter((entry) => entry.direction === 'client->agent' && entry.frame.result)
  expect(responses.filter((entry) => entry.frame.id === 'qa-permission-1')).toHaveLength(1)
  expect(responses.filter((entry) => entry.frame.id === 'qa-permission-2')).toHaveLength(1)
})

test('auto-accepts queued tool permissions using the safest offered allow priority', async () => {
  await startChat()
  await page.getByLabel('Tool permissions').selectOption('auto')
  await page.getByTestId('prompt-input').fill('permission queue please')
  await page.getByTestId('send-prompt').click()

  await expect(page.getByText('Permission qa-permission-1 resolved with allow_always.')).toBeVisible()
  await expect(page.getByText('Permission qa-permission-2 resolved with allow_always.')).toBeVisible()
  await expect(page.getByTestId('permission-card')).toBeHidden()
})

test('approves a plan through the opaque interaction bridge', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('plan approve please')
  await page.getByTestId('send-prompt').click()

  const card = page.getByTestId('plan-review-card')
  await expect(card).toContainText('# QA plan')
  await card.getByRole('button', { name: 'Approve & implement' }).click()
  await expect(page.getByText('Plan resolved: approved.')).toBeVisible()
  await expect(card).toBeHidden()
})

test('returns plan revision feedback as cancelled instead of a JSON-RPC error', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('plan changes please')
  await page.getByTestId('send-prompt').click()

  const card = page.getByTestId('plan-review-card')
  await card.getByTestId('plan-feedback').fill('Add rollback coverage')
  await card.getByRole('button', { name: 'Request changes' }).click()
  await expect(page.getByText('Plan resolved: cancelled (Add rollback coverage).')).toBeVisible()
})

test('abandons a plan without implementing it', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('plan abandon please')
  await page.getByTestId('send-prompt').click()

  const card = page.getByTestId('plan-review-card')
  await card.getByRole('button', { name: 'Abandon plan' }).click()
  await expect(page.getByText('Plan resolved: abandoned.')).toBeVisible()
  await expect(card).toBeHidden()
})

test('submits a single-choice question with its preview annotation', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('question choice please')
  await page.getByTestId('send-prompt').click()

  const card = page.getByTestId('question-card')
  await expect(card.getByTestId('question-progress')).toHaveText('Answered 0/1')
  await card.getByRole('radio', { name: /React/ }).check()
  await expect(card.getByTestId('question-progress')).toHaveText('Answered 1/1')
  await expect(card.getByText('<ReactPreview />', { exact: true })).toBeVisible()
  await expect(card.locator('reactpreview')).toHaveCount(0)
  await card.getByRole('button', { name: 'Submit answers' }).click()
  await expect(page.getByText(/Question resolved:.*React.*preview/)).toBeVisible()
  // The mock echoes result JSON through SafeMarkdown, which intentionally strips
  // raw HTML-looking text. Assert the protocol value at the wire boundary so a
  // security-safe rendering cannot turn a real annotation regression green.
  await expect.poll(async () => {
    const entries = (await readFile(transcriptPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        direction: string
        frame: {
          id?: string
          result?: {
            annotations?: Record<string, { preview?: string }>
          }
        }
      })
    return entries.find((entry) =>
      entry.direction === 'client->agent' &&
      entry.frame.id === 'qa-question-1' &&
      entry.frame.result !== undefined
    )?.frame.result?.annotations?.['Which implementation should Grok use?']?.preview
  }).toBe('<ReactPreview />')
})

test('submits only answered interview questions and exposes both plan interview actions', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('question plan please')
  await page.getByTestId('send-prompt').click()

  let card = page.getByTestId('question-card')
  await expect(card.getByTestId('question-progress')).toHaveText('Answered 0/2')
  await expect(card.getByRole('button', { name: 'Chat about this' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Skip interview' })).toBeVisible()
  await card.getByRole('radio', { name: /React/ }).check()
  await expect(card.getByTestId('question-progress')).toHaveText('Answered 1/2')
  await card.getByRole('button', { name: 'Submit answers' }).click()
  const accepted = page.getByText(/Question resolved:.*accepted.*React/)
  await expect(accepted).toBeVisible()
  await expect(accepted).not.toContainText('Which checks should Grok run?')

  await startChat()
  await page.getByTestId('prompt-input').fill('question plan please')
  await page.getByTestId('send-prompt').click()
  card = page.getByTestId('question-card')
  await card.getByRole('checkbox', { name: /Tests/ }).check()
  await card.getByRole('checkbox', { name: /Lint/ }).check()
  await card.getByRole('button', { name: 'Chat about this' }).click()
  await expect(page.getByText(/Question resolved:.*chat_about_this.*Tests, Lint/)).toBeVisible()

  await startChat()
  await page.getByTestId('prompt-input').fill('question plan please')
  await page.getByTestId('send-prompt').click()
  card = page.getByTestId('question-card')
  await card.getByRole('button', { name: 'Skip interview' }).click()
  await expect(page.getByText(/Question resolved:.*skip_interview/)).toBeVisible()
})

test('removes direct, underscored, and wrapped interactions when another client answers first', async () => {
  for (const style of ['direct', 'underscored', 'wrapped']) {
    await startChat()
    await page.getByTestId('prompt-input').fill('question remote ' + style + ' please')
    await page.getByTestId('send-prompt').click()
    await expect(page.getByText('Question ' + style + ' was resolved remotely.')).toBeVisible()
    await expect(page.getByTestId('question-card')).toBeHidden()
  }

  const responses = (await readFile(transcriptPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: string; frame: { id?: string; result?: unknown } })
    .filter((entry) =>
      entry.direction === 'client->agent' &&
      String(entry.frame.id ?? '').startsWith('qa-question-remote-') &&
      entry.frame.result !== undefined
    )
  expect(responses).toHaveLength(0)
})

test('reconnects and replays a pending interaction once after reasoning changes', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('question reconnect please')
  await page.getByTestId('send-prompt').click()
  await expect(page.getByTestId('question-card')).toBeVisible()
  const originalInteractionId = await currentInteractionId()

  await page.getByLabel('Reasoning effort').selectOption('max')
  await expect.poll(currentInteractionId).not.toBe(originalInteractionId)

  const card = page.getByTestId('question-card')
  await card.getByRole('radio', { name: /React/ }).check()
  await card.getByRole('button', { name: 'Submit answers' }).click()
  await expect(page.getByText(/Question resolved:.*accepted.*React/)).toBeVisible()

  const entries = (await readFile(transcriptPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      direction: string
      frame: { id?: string; method?: string; result?: unknown }
    })
    .filter((entry) => entry.direction === 'client->agent')
  expect(entries.filter((entry) => entry.frame.method === 'session/prompt')).toHaveLength(1)
  expect(entries.filter((entry) => entry.frame.method === 'session/load')).toHaveLength(1)
  expect(entries.filter((entry) =>
    entry.frame.id === 'qa-question-reconnect' &&
    entry.frame.result !== undefined
  )).toHaveLength(1)
})

test('submits an Other answer as string-array plus notes', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('question other please')
  await page.getByTestId('send-prompt').click()

  const card = page.getByTestId('question-card')
  await card.getByRole('radio', { name: 'Other' }).check()
  await card.getByTestId('other-question-1').fill('Use SolidJS')
  await card.getByRole('button', { name: 'Submit answers' }).click()
  await expect(page.getByText(/Question resolved:.*Other.*Use SolidJS/)).toBeVisible()
})

test('cancels a waiting interaction before cancelling the turn', async () => {
  await startChat()
  await page.getByTestId('prompt-input').fill('question cancel please')
  await page.getByTestId('send-prompt').click()

  await expect(page.getByTestId('question-card')).toBeVisible()
  await page.getByRole('button', { name: 'Stop response' }).click()
  await expect(page.getByText(/Question resolved:.*cancelled/)).toBeVisible()
  await expect(page.getByTestId('question-card')).toBeHidden()
})

async function startChat(): Promise<void> {
  await page.getByRole('button', { name: 'New chat' }).last().click()
  await expect(page.getByTestId('empty-transcript')).toBeVisible()
}

async function launchFixture(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
      GROKBUILD_USER_DATA_DIR: join(profilePath, 'profile'),
      GROKBUILD_E2E_PROJECT_PATH: workspacePath,
      GROKBUILD_E2E: '1',
      GROKBUILD_MOCK_TRANSCRIPT: transcriptPath,
      GROKBUILD_MOCK_PENDING_STATE: join(profilePath, 'pending-interaction.json'),
      GROKBUILD_MOCK_MCP_STATE: mcpStatePath,
      GROKBUILD_MOCK_MCP_DOCTOR_MARKER: mcpDoctorMarkerPath,
      GROKBUILD_MOCK_MCP_CWD_LOG: mcpCwdLogPath,
      GROKBUILD_MOCK_UPDATE_CWD_LOG: updateCwdLogPath,
      GROKBUILD_MOCK_UPDATE_STATE: updateStatePath,
      GROKBUILD_MOCK_SESSION_HISTORY_STATE: sessionHistoryStatePath,
      GROKBUILD_MOCK_SESSION_HISTORY_LOG: sessionHistoryLogPath,
      GROKBUILD_E2E_DOCTOR_AUTH_PATH: doctorAuthPath,
      GROKBUILD_E2E_DOCTOR_CONFIG_PATH: doctorConfigPath,
      GROKBUILD_MOCK_MCP_CANARY: 'QA_MCP_SECRET_CANARY_41F7',
      TZ: 'UTC',
      LANG: 'en_US.UTF-8'
    }
  })
}

async function fullAccessibilityTree(): Promise<string> {
  const session = await page.context().newCDPSession(page)
  try {
    return JSON.stringify(await session.send('Accessibility.getFullAXTree'))
  } finally {
    await session.detach()
  }
}

async function acpWorkerCount(): Promise<number> {
  return electronApp!.evaluate(({ app }) =>
    app.getAppMetrics().filter((metric) =>
      metric.type === 'Utility' &&
      (metric.name === 'GrokBuild ACP Session' || metric.serviceName === 'GrokBuild ACP Session')
    ).length
  )
}

async function promptRpcCount(): Promise<number> {
  try {
    return (await readFile(transcriptPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { direction: string; frame: { method?: string } })
      .filter((entry) =>
        entry.direction === 'client->agent' && entry.frame.method === 'session/prompt'
      ).length
  } catch {
    return 0
  }
}

async function historyLoadRpcCount(remoteId: string): Promise<number> {
  try {
    return (await readFile(transcriptPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        direction: string
        frame: { method?: string; params?: { sessionId?: string } }
      })
      .filter((entry) =>
        entry.direction === 'client->agent' &&
        entry.frame.method === 'session/load' &&
        entry.frame.params?.sessionId === remoteId
      ).length
  } catch {
    return 0
  }
}

async function currentInteractionId(): Promise<string | undefined> {
  return page.evaluate(async () => {
    const bridge = (globalThis as unknown as {
      grokbuild: { bootstrap: () => Promise<import('../../src/shared/models').AppSnapshot> }
    }).grokbuild
    const snapshot = await bridge.bootstrap()
    const selected = snapshot.sessions.find((session) => session.id === snapshot.selectedSessionId)
    return selected?.pendingInteraction?.interactionId
  })
}
