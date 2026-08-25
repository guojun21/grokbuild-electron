import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { IPC } from '../../src/shared/ipcChannels'

const HOSTILE_URL = 'https://release-assets.example/QA_UPDATE_URL_CANARY_7A31'
const HOSTILE_DIGEST = `sha256:${'a'.repeat(64)}QA_UPDATE_DIGEST_CANARY_4E20`
const HOSTILE_PATH = '/private/QA_UPDATE_PATH_CANARY_9C62/update.app.zip'
const FIXED_MARKER_CONTENT = 'trusted-app-update-install-requested\n'

test('checks, confirms, and records only the inert E2E app update request', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grokbuild-app-update-e2e-')))
  const profile = join(root, 'profile')
  const markerPath = join(profile, 'app-update-install.marker')
  await mkdir(profile, { mode: 0o700 })

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
        GROKBUILD_E2E_APP_UPDATE_MARKER: markerPath,
        TZ: 'UTC',
        LANG: 'en_US.UTF-8'
      }
    })
    const page = await app.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()

    await rejectHostileDirectInvocation(app, {
      url: HOSTILE_URL,
      digest: HOSTILE_DIGEST,
      path: HOSTILE_PATH,
      bundleId: 'com.attacker.replacement',
      teamId: 'ATTACKER123'
    })
    await expectMarkerAbsent(markerPath)

    await page.locator('.settings-row').click()
    await page.getByRole('button', { name: 'Updates', exact: true }).click()
    const settings = page.getByTestId('update-settings')
    await settings.getByRole('button', { name: 'Check now' }).click()
    await expect(settings).toContainText('Version 999.0.0 is available')
    const install = settings.getByRole('button', { name: 'Install and restart' })
    await expect(install).toBeVisible()

    await setNativeConfirmation(app, 0)
    await install.click()
    await expectNativeConfirmationContract(app)
    await expectMarkerAbsent(markerPath)
    await expect(install).toBeEnabled()

    await settings.getByRole('button', { name: 'Check now' }).click()
    await expect(settings).toContainText('Version 999.0.0 is available')
    await setNativeConfirmation(app, 1)
    await install.click()
    await expectNativeConfirmationContract(app)
    await expect.poll(() => readFile(markerPath, 'utf8')).toBe(FIXED_MARKER_CONTENT)
    await expect(settings.getByRole('button', { name: 'Restarting…' })).toBeDisabled()

    const publicSurface = await rendererSurface(page)
    for (const secret of [HOSTILE_URL, HOSTILE_DIGEST, HOSTILE_PATH, markerPath]) {
      expect(publicSurface).not.toContain(secret)
    }
    expect(publicSurface).not.toContain('release-assets.example')
    expect(publicSurface).not.toContain('update.app.zip')

    const marker = await readFile(markerPath, 'utf8')
    expect(marker).toBe(FIXED_MARKER_CONTENT)
    for (const secret of [HOSTILE_URL, HOSTILE_DIGEST, HOSTILE_PATH, markerPath]) {
      expect(marker).not.toContain(secret)
    }
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function rejectHostileDirectInvocation(
  app: ElectronApplication,
  hostile: Record<string, string>
): Promise<void> {
  const result = await app.evaluate(async ({ BrowserWindow, ipcMain }, request) => {
    type InvokeHandler = (
      event: { sender: Electron.WebContents; senderFrame: Electron.WebFrameMain | null },
      ...args: unknown[]
    ) => unknown
    const handlers = (
      ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> }
    )._invokeHandlers
    const handler = handlers?.get(request.channel)
    const contents = BrowserWindow.getAllWindows()[0]?.webContents
    if (!handler || !contents) return { rejected: false, reason: 'handler-unavailable' }
    try {
      await handler({ sender: contents, senderFrame: contents.mainFrame }, request.hostile)
      return { rejected: false, reason: 'accepted' }
    } catch {
      return { rejected: true }
    }
  }, { channel: IPC.installAppUpdate, hostile })
  expect(result).toEqual({ rejected: true })
}

async function setNativeConfirmation(
  app: ElectronApplication,
  response: 0 | 1
): Promise<void> {
  await app.evaluate(({ dialog }, selectedResponse) => {
    const mutableDialog = dialog as unknown as {
      showMessageBox: (...args: unknown[]) => Promise<{
        response: number
        checkboxChecked: boolean
      }>
    }
    mutableDialog.showMessageBox = async (...args: unknown[]) => {
      const options = args.at(-1)
      ;(globalThis as unknown as {
        __grokbuildE2EUpdateDialog?: unknown
      }).__grokbuildE2EUpdateDialog = options
      return {
        response: selectedResponse,
        checkboxChecked: false
      }
    }
  }, response)
}

async function expectNativeConfirmationContract(app: ElectronApplication): Promise<void> {
  const options = await app.evaluate(() => (
    globalThis as unknown as { __grokbuildE2EUpdateDialog?: Record<string, unknown> }
  ).__grokbuildE2EUpdateDialog)
  expect(options).toBeTruthy()
  expect(options?.message).toBe('Install GrokBuild Electron 999.0.0 and restart?')
  for (const key of Object.keys(options ?? {})) {
    expect(key).not.toMatch(/url|digest|path|team/i)
  }
  const serialized = JSON.stringify(options)
  expect(serialized).not.toContain('https://')
  expect(serialized).not.toContain('sha256:')
  expect(serialized).not.toContain('update.app.zip')
  expect(serialized).not.toContain('/private/')
}

async function expectMarkerAbsent(path: string): Promise<void> {
  await expect.poll(async () => {
    try {
      await access(path)
      return false
    } catch {
      return true
    }
  }).toBe(true)
}

async function rendererSurface(page: Page): Promise<string> {
  return page.evaluate(() => {
    const global = globalThis as unknown as {
      grokbuild: Record<string, unknown>
      document: { documentElement: { outerHTML: string }; body: { innerText: string } }
    }
    const bridge = Object.entries(global.grokbuild)
      .map(([name, value]) => `${name}:${String(value)}`)
      .join('\n')
    return `${global.document.documentElement.outerHTML}\n${global.document.body.innerText}\n${bridge}`
  })
}
