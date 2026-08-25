import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron') as string

test.describe('macOS application shell', () => {
  test.skip(process.platform !== 'darwin', 'The status-item and Dock lifecycle are macOS-specific')

  let electronApp: ElectronApplication
  let page: Page
  let profilePath: string
  let launchEnvironment: Record<string, string>

  test.beforeEach(async () => {
    profilePath = await mkdtemp(join(tmpdir(), 'grokbuild-shell-e2e-'))
    const workspace = join(profilePath, 'qa-workspace')
    await mkdir(workspace)
    launchEnvironment = {
      ...concreteEnvironment(),
      GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
      GROKBUILD_USER_DATA_DIR: join(profilePath, 'profile'),
      GROKBUILD_E2E_PROJECT_PATH: workspace,
      GROKBUILD_E2E: '1',
      TZ: 'UTC',
      LANG: 'en_US.UTF-8'
    }
    delete launchEnvironment.ELECTRON_RUN_AS_NODE
    electronApp = await electron.launch({
      args: ['.'],
      cwd: resolve('.'),
      env: launchEnvironment
    })
    page = await electronApp.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterEach(async () => {
    await electronApp.close()
    await rm(profilePath, { recursive: true, force: true })
  })

  test('hides on close and reopens from Dock activation or a second launch', async () => {
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect.poll(() => windowVisibility(electronApp)).toBe(false)
    expect(electronApp.process().exitCode).toBeNull()

    await electronApp.evaluate(({ app }) => {
      ;(app as unknown as { emit: (name: string) => void }).emit('activate')
    })
    await expect.poll(() => windowVisibility(electronApp)).toBe(true)

    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect.poll(() => windowVisibility(electronApp)).toBe(false)
    const secondInstance = spawn(electronExecutable, ['.'], {
      cwd: resolve('.'),
      env: launchEnvironment,
      stdio: 'ignore'
    })
    expect(await waitForExit(secondInstance)).toBe(0)
    await expect.poll(() => windowVisibility(electronApp)).toBe(true)
  })

  test('opens Settings from the native Cmd+, application menu item', async () => {
    const menuItem = await electronApp.evaluate(({ Menu }) => {
      const appMenu = Menu.getApplicationMenu()
      const grokBuild = appMenu?.items.find((item) => item.label === 'GrokBuild')
      const settings = grokBuild?.submenu?.items.find((item) => item.label === 'Settings…')
      if (!settings) throw new Error('Settings menu item was not installed')
      ;(settings.click as unknown as (() => void) | undefined)?.()
      return { label: settings.label, accelerator: settings.accelerator }
    })

    expect(menuItem).toEqual({ label: 'Settings…', accelerator: 'CommandOrControl+,' })
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  })
})

async function windowVisibility(electronApp: ElectronApplication): Promise<boolean | undefined> {
  return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Second Electron instance did not exit after lock handoff'))
    }, 5_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })
}

function concreteEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}
