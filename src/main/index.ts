import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  nativeImage,
  net,
  Notification,
  protocol,
  session,
  Tray,
  type MenuItemConstructorOptions
} from 'electron'
import { execFile } from 'node:child_process'
import { access, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { canonicalCliVersion } from './grok/cliVersion'
import { AppController } from './AppController'
import { AppStateStore } from './persistence/AppStateStore'
import { registerIpc } from './ipc'
import { IPC } from '../shared/ipcChannels'
import { AcpWorkerClient } from './acp/AcpWorkerClient'
import { appSnapshotSchema } from '../shared/schemas'
import { createTrayMenuTemplate } from './shell/trayMenu'
import { SessionNotificationCoordinator } from './notifications/SessionNotificationCoordinator'
import { TargetOnlyNotificationAdapter } from './notifications/TargetOnlyNotificationAdapter'
import { revealWindowTarget } from './shell/revealWindowTarget'
import { GrokDoctorService, type GrokDoctorServiceOptions } from './grok/GrokDoctorService'
import { GrokCliService } from './grok/GrokCliService'
import type { ProjectOpenService } from './workspaces/ProjectOpenService'
import { UpdateCoordinator } from './updates/UpdateCoordinator'
import { UpdateOperationLock } from './updates/UpdateOperationLock'
import { TrustedUpdateStager } from './updates/TrustedUpdateStager'
import { TrustedAppArchiveVerifier } from './updates/TrustedAppArchiveVerifier'
import { MacAppIdentityService } from './updates/MacAppIdentityService'
import {
  TrustedSquirrelUpdater,
  type SquirrelAutoUpdaterAdapter
} from './updates/TrustedSquirrelUpdater'
import {
  AppUpdateInstallCoordinator,
  PRODUCTION_APP_BUNDLE_ID,
  PRODUCTION_APP_NAME
} from './updates/AppUpdateInstallCoordinator'
import { createE2EAppUpdateCoordinator } from './updates/E2EAppUpdateCoordinator'
import { resolveReleaseFeedUrl } from './updates/ReleaseFeedConfig'
import { CliUpdateInstallCoordinator } from './updates/CliUpdateInstallCoordinator'
import { DashboardInspector } from './git/DashboardInspector'
import {
  AGENT_ROSTER_FILE_NAME,
  AgentRosterStore
} from './agents/AgentRosterStore'
import { GrokAgentCatalogService } from './agents/GrokAgentCatalogService'
import { MemoryBroker } from './memory/MemoryBroker'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'grokbuild',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
  }
])

const execFileAsync = promisify(execFile)
let mainWindow: BrowserWindow | undefined
let controller: AppController | undefined
let unregisterIpc: (() => void) | undefined
let quitCleanup: Promise<void> | undefined
let quitAfterCleanup = false
let activeCliUpdateBarrier: Promise<void> | undefined
let statusItem: Tray | undefined
const presentedNotifications = new Set<Notification>()

const isolatedUserData = process.env.GROKBUILD_USER_DATA_DIR
if (isolatedUserData) app.setPath('userData', isolatedUserData)

const ownsSingleInstanceLock = app.requestSingleInstanceLock()
if (!ownsSingleInstanceLock) app.quit()
app.enableSandbox()

app.on('second-instance', () => {
  revealMainWindow()
})

app.on('activate', () => revealMainWindow())

app.on('before-quit', (event) => {
  if (quitAfterCleanup) return
  event.preventDefault()
  if (!quitCleanup) {
    const pendingCliUpdate = activeCliUpdateBarrier ?? Promise.resolve()
    quitCleanup = Promise.allSettled([
      controller?.stop() ?? Promise.resolve(),
      pendingCliUpdate
    ]).then(() => undefined)
      .finally(() => {
        quitAfterCleanup = true
        app.quit()
      })
  }
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

if (ownsSingleInstanceLock) void app.whenReady().then(async () => {
  const cliPath = await locateGrokCli()
  controller = new AppController({
    appVersion: app.getVersion(),
    cliPath,
    store: new AppStateStore(join(app.getPath('userData'), 'state.json'), cliPath),
    agentRosterStore: new AgentRosterStore(
      join(app.getPath('userData'), AGENT_ROSTER_FILE_NAME)
    ),
    agentCatalogService: new GrokAgentCatalogService(),
    memoryBroker: new MemoryBroker({
      basePath: process.env.GROKBUILD_E2E === '1'
        ? join(app.getPath('userData'), 'e2e-grok-memory')
        : join(homedir(), '.grok', 'memory')
    }),
    ...(process.env.GROKBUILD_E2E_PROJECT_PATH
      ? { seedProjectPath: process.env.GROKBUILD_E2E_PROJECT_PATH }
      : {}),
    dashboardInspector: new DashboardInspector(),
    acpFactory: (options) => new AcpWorkerClient(join(__dirname, 'acp-worker.js'), options)
  })
  await controller.initialize()
  nativeTheme.themeSource = controller.snapshot().settings.appearance

  const notificationAdapter = new TargetOnlyNotificationAdapter(
    {
      isSupported: () => process.platform === 'darwin' && Notification.isSupported(),
      show: (options, onClick) => {
        const notification = new Notification(options)
        const release = (): void => {
          presentedNotifications.delete(notification)
        }
        presentedNotifications.add(notification)
        notification.once('click', () => {
          release()
          onClick()
        })
        notification.once('close', release)
        notification.once('failed', release)
        notification.show()
      }
    },
    (sessionId) => revealMainWindow(sessionId)
  )
  const notificationCoordinator = new SessionNotificationCoordinator({
    isForeground: () => Boolean(
      quitCleanup || (mainWindow?.isVisible() && mainWindow.isFocused())
    ),
    publish: (target) => notificationAdapter.publish(target)
  })
  controller.on('sessionLifecycle', (event) => notificationCoordinator.handle(event))

  await registerAppProtocol()
  const developmentRendererUrl = validatedDevelopmentRendererUrl()
  const window = createWindow()
  mainWindow = window
  const doctorOptions: GrokDoctorServiceOptions = {}
  if (process.env.GROKBUILD_E2E === '1') {
    const authPath = process.env.GROKBUILD_E2E_DOCTOR_AUTH_PATH?.trim()
    const configPath = process.env.GROKBUILD_E2E_DOCTOR_CONFIG_PATH?.trim()
    if (authPath) doctorOptions.authPath = authPath
    if (configPath) doctorOptions.configPath = configPath
  }
  const projectOpenService = createE2EProjectOpenService()
  const e2eMode = process.env.GROKBUILD_E2E === '1'
  const updateFeedUrl = await resolveReleaseFeedUrl({
    isPackaged: app.isPackaged,
    isE2E: e2eMode,
    resourcesPath: process.resourcesPath,
    environmentUrl: process.env.GROKBUILD_UPDATE_FEED_URL
  })
  const confirmAppInstall = async (latestVersion: string): Promise<boolean> => {
    const confirmation = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Install GrokBuild update?',
      message: `Install GrokBuild Electron ${latestVersion} and restart?`,
      detail: 'Active sessions must be idle. GrokBuild will verify the signed app, stop local agent processes, save its state, and then hand replacement to macOS.',
      buttons: ['Cancel', 'Install and Restart'],
      defaultId: 1,
      cancelId: 0,
      noLink: true
    })
    return confirmation.response === 1
  }
  const e2eAppUpdateCoordinator = createE2EAppUpdateCoordinator({
    enabled: e2eMode,
    markerPath: process.env.GROKBUILD_E2E_APP_UPDATE_MARKER,
    userDataPath: app.getPath('userData'),
    installedVersion: app.getVersion(),
    confirmInstall: confirmAppInstall
  })
  const updateOperationLock = new UpdateOperationLock()
  const appUpdateCoordinator = e2eAppUpdateCoordinator ??
    await createProductionAppUpdateCoordinator(
      updateFeedUrl,
      confirmAppInstall,
      updateOperationLock
    )
  const cliUpdateCoordinator = new CliUpdateInstallCoordinator({
    runtimeProvider: () => {
      const currentController = controller
      const snapshot = currentController?.snapshot()
      if (!currentController || !snapshot?.cli.available) return undefined
      const project = snapshot.projects.find(
        (candidate) => candidate.id === snapshot.selectedProjectId
      )
      return {
        cliPath: snapshot.settings.grokCliPath,
        cwd: project?.path ?? homedir(),
        cli: new GrokCliService({ cliPath: snapshot.settings.grokCliPath })
      }
    },
    controller,
    operationLock: updateOperationLock,
    confirmInstall: async (currentVersion, latestVersion) => {
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Install Grok CLI update?',
        message: `Update Grok CLI from ${currentVersion} to ${latestVersion}?`,
        detail: 'Active sessions must be idle. GrokBuild will stop local agent processes, save its state, run the fixed grok update command, verify the installed version, and reconnect the selected session.',
        buttons: ['Cancel', 'Install CLI Update'],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      })
      return confirmation.response === 1
    },
    recordInstalledVersion: (cliPath, version) => {
      if (!quitCleanup) controller?.setCliVersion(cliPath, version)
    },
    handleAmbiguousFailure: () => app.quit()
  })
  const trackedCliUpdateCoordinator = {
    installCli: () => {
      if (activeCliUpdateBarrier) {
        return Promise.reject(new Error('A Grok CLI update is already in progress.'))
      }
      const operation = cliUpdateCoordinator.installCli()
      const barrier = operation.then(
        () => undefined,
        () => undefined
      ).finally(() => {
        if (activeCliUpdateBarrier === barrier) activeCliUpdateBarrier = undefined
      })
      activeCliUpdateBarrier = barrier
      return operation
    }
  }
  // Resolve the initial CLI identity before renderer IPC becomes reachable.
  // This prevents an old --version child from racing a self-update or writing
  // a stale display version after the verified update completes.
  const initialCliPath = controller.snapshot().settings.grokCliPath
  const initialCliVersion = await readCliVersion(initialCliPath)
  controller.setCliVersion(initialCliPath, initialCliVersion)
  unregisterIpc = registerIpc(
    controller,
    window,
    developmentRendererUrl ? new URL(developmentRendererUrl).origin : undefined,
    {
      ...(updateFeedUrl
        ? { updateFeedUrl }
        : {}),
      ...(Object.keys(doctorOptions).length > 0
        ? { doctorService: new GrokDoctorService(doctorOptions) }
        : {}),
      ...(projectOpenService
        ? { projectOpenService }
        : {}),
      appUpdateCoordinator,
      cliUpdateCoordinator: trackedCliUpdateCoordinator,
      readCliVersion
    }
  )
  controller.on('changed', (snapshot) => {
    const currentWindow = mainWindow
    if (currentWindow && !currentWindow.isDestroyed()) {
      const validated = appSnapshotSchema.safeParse(snapshot)
      if (validated.success) currentWindow.webContents.send(IPC.stateChanged, validated.data)
      else console.error('Refused to publish an invalid application snapshot.')
    }
    refreshStatusItemMenu()
  })
  installMenu()
  installStatusItem()
  await loadRenderer(window, developmentRendererUrl)
})

function createE2EProjectOpenService(): Pick<
  ProjectOpenService,
  'listTargets' | 'openProject'
> | undefined {
  const logPath = process.env.GROKBUILD_E2E_PROJECT_OPEN_LOG?.trim()
  if (process.env.GROKBUILD_E2E !== '1' || !logPath) return undefined
  return {
    listTargets: async () => [
      { target: 'finder', label: 'Finder', installed: true },
      { target: 'cursor', label: 'Cursor', installed: true },
      { target: 'vsCode', label: 'VS Code', installed: false },
      { target: 'terminal', label: 'Terminal', installed: false },
      { target: 'iTerm', label: 'iTerm', installed: false },
      { target: 'zed', label: 'Zed', installed: false }
    ],
    openProject: async (_projectPath, target) => {
      await appendFile(logPath, `${JSON.stringify({ target })}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      return {
        target,
        disposition: target === 'finder' ? 'open-folder' : 'open-with-application',
        opened: true
      }
    }
  }
}

async function createProductionAppUpdateCoordinator(
  releasesUrl: string | undefined,
  confirmInstall: (latestVersion: string) => Promise<boolean>,
  operationLock: UpdateOperationLock
): Promise<AppUpdateInstallCoordinator> {
  const currentController = controller
  if (!currentController) throw new Error('The application controller is unavailable.')

  const updateCoordinator = new UpdateCoordinator({
    appVersion: app.getVersion(),
    productAssetStem: 'GrokBuild-Electron',
    ...(releasesUrl ? { releasesUrl } : {}),
    cliProvider: () => {
      const snapshot = controller?.snapshot()
      return snapshot?.cli.available
        ? new GrokCliService({ cliPath: snapshot.settings.grokCliPath })
        : undefined
    }
  })
  const stagingRoot = join(app.getPath('userData'), 'updates')
  const stager = new TrustedUpdateStager({ stagingRoot })
  if (app.isPackaged && process.platform === 'darwin') {
    try {
      await stager.cleanupStale()
    } catch {
      // An unsafe or unavailable staging root disables cleanup and will also
      // fail closed if installation is attempted. It must not block app launch.
      console.error('Could not safely clean stale app update staging data.')
    }
  }
  const verifier = new TrustedAppArchiveVerifier({ stagingRoot })
  const identityService = new MacAppIdentityService()
  const squirrel = new TrustedSquirrelUpdater({
    autoUpdater: squirrelAutoUpdaterAdapter()
  })

  return new AppUpdateInstallCoordinator({
    updateCoordinator,
    identityService,
    stager,
    verifier,
    squirrel,
    operationLock,
    controller: currentController,
    executablePath: process.execPath,
    isPackaged: app.isPackaged,
    expectedBundleId: PRODUCTION_APP_BUNDLE_ID,
    expectedAppName: PRODUCTION_APP_NAME,
    confirmInstall,
    startUpdateQuit: (install) => {
      quitAfterCleanup = true
      try {
        install()
      } catch {
        // Squirrel may already own a pending update. Keep the quit gate and
        // leases retained, then leave through the ordinary Electron path.
        app.quit()
      }
    },
    quitApplication: () => app.quit()
  })
}

function squirrelAutoUpdaterAdapter(): SquirrelAutoUpdaterAdapter {
  return {
    setFeedURL: (options) => autoUpdater.setFeedURL(options),
    getFeedURL: () => autoUpdater.getFeedURL(),
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    on: (event, listener) => (
      autoUpdater as unknown as SquirrelAutoUpdaterAdapter
    ).on(event, listener),
    removeListener: (event, listener) => (
      autoUpdater as unknown as SquirrelAutoUpdaterAdapter
    ).removeListener(event, listener)
  }
}

app.on('will-quit', () => {
  unregisterIpc?.()
  statusItem?.destroy()
  statusItem = undefined
  for (const notification of presentedNotifications) notification.close()
  presentedNotifications.clear()
})

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1100,
    minHeight: 720,
    title: 'GrokBuild',
    backgroundColor: '#eef0f4',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (!isSameRendererOrigin(current, url)) event.preventDefault()
  })
  window.on('close', (event) => {
    if (quitAfterCleanup) return
    event.preventDefault()
    window.hide()
  })
  window.on('show', () => refreshStatusItemMenu())
  window.on('hide', () => refreshStatusItemMenu())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.once('ready-to-show', () => window.show())
  return window
}

async function loadRenderer(window: BrowserWindow, developmentRendererUrl?: string): Promise<void> {
  if (developmentRendererUrl) {
    await window.loadURL(developmentRendererUrl)
  } else {
    await window.loadURL('grokbuild://app/index.html')
  }
}

async function registerAppProtocol(): Promise<void> {
  const rendererRoot = resolve(dirname(__dirname), 'renderer')
  protocol.handle('grokbuild', (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 })
    const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, '') || 'index.html')
    const filePath = normalize(resolve(rendererRoot, relativePath))
    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${sep}`)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString()).then(async (response) => {
      const headers = new Headers(response.headers)
      if (filePath.endsWith('.html')) {
        headers.set(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        )
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      })
    })
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
}

function installMenu(): void {
  const viewItems: MenuItemConstructorOptions[] = [
    ...(!app.isPackaged
      ? [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }, { type: 'separator' as const }]
      : []),
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'GrokBuild',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Settings…',
            accelerator: 'CommandOrControl+,',
            click: () => requestOpenSettings()
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: viewItems },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
    ])
  )
}

function installStatusItem(): void {
  if (process.platform !== 'darwin' || statusItem) return
  statusItem = new Tray(nativeImage.createEmpty())
  statusItem.setTitle('GrokBuild')
  statusItem.setToolTip('GrokBuild')
  refreshStatusItemMenu()
}

function refreshStatusItemMenu(): void {
  if (!statusItem) return
  const snapshot = controller?.snapshot()
  const selectedProjectId = snapshot?.selectedProjectId
  const selectedProjectReady = Boolean(
    selectedProjectId && snapshot?.workspaceHealth.some((health) =>
      health.projectId === selectedProjectId && health.state === 'ready'
    )
  )
  statusItem.setContextMenu(
    Menu.buildFromTemplate(
      createTrayMenuTemplate(
        {
          windowVisible: Boolean(mainWindow?.isVisible()),
          canCreateSession: selectedProjectReady
        },
        {
          toggleWindow: () => {
            const window = mainWindow
            if (window?.isVisible()) window.hide()
            else revealMainWindow()
          },
          createSession: () => {
            const currentController = controller
            const projectId = currentController?.snapshot().selectedProjectId
            if (!currentController || !projectId) return
            void currentController.createSession(projectId).catch(() => undefined)
            revealMainWindow()
          },
          quit: () => app.quit()
        }
      )
    )
  )
}

function revealMainWindow(sessionId?: string): void {
  revealWindowTarget(
    {
      window: mainWindow,
      selectSession: (targetSessionId) => {
        void controller?.selectSession(targetSessionId).catch(() => undefined)
      },
      focusApplication: () => app.focus({ steal: true })
    },
    sessionId
  )
}

function requestOpenSettings(): void {
  revealMainWindow()
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  const send = (): void => {
    if (!window.isDestroyed()) window.webContents.send(IPC.openSettings)
  }
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', send)
  else send()
}

async function locateGrokCli(): Promise<string> {
  const candidates = [
    process.env.GROK_CLI_PATH,
    join(homedir(), '.grok/bin/grok'),
    '/opt/homebrew/bin/grok',
    '/usr/local/bin/grok'
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next explicit, non-shell-resolved location.
    }
  }
  return candidates[0] ?? join(homedir(), '.grok/bin/grok')
}

async function readCliVersion(cliPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cliPath, ['--version'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    })
    return canonicalCliVersion(stdout)
  } catch {
    return undefined
  }
}

function validatedDevelopmentRendererUrl(): string | undefined {
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) return undefined
  const url = new URL(process.env.ELECTRON_RENDERER_URL)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('ELECTRON_RENDERER_URL must be an unauthenticated loopback HTTP URL')
  }
  return url.toString()
}

function isSameRendererOrigin(currentValue: string, targetValue: string): boolean {
  try {
    const current = new URL(currentValue)
    const target = new URL(targetValue)
    if (current.protocol === 'grokbuild:') {
      return target.protocol === 'grokbuild:' && target.hostname === 'app'
    }
    return current.origin === target.origin
  } catch {
    return false
  }
}
