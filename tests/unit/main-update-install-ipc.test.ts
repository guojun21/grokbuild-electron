import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AppController } from '../../src/main/AppController'
import type { UpdateCheckResult } from '../../src/main/updates/UpdateCoordinator'
import { IPC } from '../../src/shared/ipcChannels'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const PRIVATE_CANARY = 'update-ipc-private-canary-f349d8'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  handle: vi.fn((channel: string, handler: InvokeHandler) => {
    electron.handlers.set(channel, handler)
  }),
  removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel))
}))

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn()
  },
  ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler },
  nativeTheme: { themeSource: 'system' },
  shell: { openExternal: vi.fn() }
}))

const { registerIpc } = await import('../../src/main/ipc')

const CHECK_RESULT: UpdateCheckResult = Object.freeze({
  overview: Object.freeze({
    checkedAt: '2026-08-25T01:02:03.000Z',
    app: Object.freeze({
      state: 'update-available' as const,
      installed: '1.0.0',
      latest: '1.1.0',
      assetAvailable: true
    }),
    cli: Object.freeze({ state: 'unavailable' as const })
  }),
  appReleaseUrl: 'https://example.com/releases/v1.1.0'
})

describe('trusted app update IPC boundary', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.handle.mockClear()
    electron.removeHandler.mockClear()
  })

  it('keeps check/install authority and confirmation outcome in one main-owned coordinator', async () => {
    const check = vi.fn(async () => CHECK_RESULT)
    const installApp = vi.fn()
      .mockResolvedValueOnce('cancelled' as const)
      .mockResolvedValueOnce('restarting' as const)
    const { controller, window, event } = ipcHarness()
    registerIpc(controller, window, undefined, {
      appUpdateCoordinator: { check, installApp }
    })

    await expect(handler(IPC.checkUpdates)(event)).resolves.toEqual(CHECK_RESULT.overview)
    expect(check).toHaveBeenCalledWith('/canonical/project')

    await expect(handler(IPC.installAppUpdate)(event)).resolves.toEqual({ state: 'cancelled' })
    await expect(handler(IPC.installAppUpdate)(event)).resolves.toEqual({ state: 'restarting' })
    expect(installApp).toHaveBeenCalledTimes(2)
    expect(installApp.mock.calls).toEqual([[], []])
  })

  it('rejects every renderer-supplied install field before confirmation', async () => {
    const installApp = vi.fn()
    const { controller, window, event } = ipcHarness()
    registerIpc(controller, window, undefined, {
      appUpdateCoordinator: { check: vi.fn(async () => CHECK_RESULT), installApp }
    })

    await expect(handler(IPC.installAppUpdate)(event, {
      url: `https://attacker.example/${PRIVATE_CANARY}.zip`,
      path: `/private/${PRIVATE_CANARY}.app`,
      digest: PRIVATE_CANARY,
      teamId: PRIVATE_CANARY
    })).rejects.toThrow()
    expect(installApp).not.toHaveBeenCalled()
  })

  it('projects install failures as one fixed message without private diagnostics', async () => {
    const { controller, window, event } = ipcHarness()
    registerIpc(controller, window, undefined, {
      appUpdateCoordinator: {
        check: vi.fn(async () => CHECK_RESULT),
        installApp: vi.fn(async (): Promise<'restarting'> => {
          throw new Error(`${PRIVATE_CANARY} /private/update https://secret.example`)
        })
      }
    })
    let thrown: unknown
    try {
      await handler(IPC.installAppUpdate)(event)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('The app update could not be installed safely.')
    expect(JSON.stringify(thrown)).not.toContain(PRIVATE_CANARY)
  })

  it('exposes a separate zero-argument CLI install result without path or command authority', async () => {
    const installCli = vi.fn()
      .mockResolvedValueOnce({ state: 'cancelled' as const })
      .mockResolvedValueOnce({
        state: 'installed' as const,
        current: '1.0.6',
        latest: '1.0.6',
        updateAvailable: false
      })
    const { controller, window, event } = ipcHarness()
    registerIpc(controller, window, undefined, {
      cliUpdateCoordinator: { installCli }
    })

    await expect(handler(IPC.installCliUpdate)(event)).resolves.toEqual({ state: 'cancelled' })
    await expect(handler(IPC.installCliUpdate)(event)).resolves.toEqual({
      state: 'installed',
      current: '1.0.6',
      latest: '1.0.6',
      updateAvailable: false
    })
    expect(installCli.mock.calls).toEqual([[], []])

    await expect(handler(IPC.installCliUpdate)(event, {
      cliPath: `/private/${PRIVATE_CANARY}/grok`,
      command: ['update', '--force'],
      cwd: `/private/${PRIVATE_CANARY}`
    })).rejects.toThrow()
    expect(installCli).toHaveBeenCalledTimes(2)
  })

  it('projects CLI installer diagnostics as one fixed message', async () => {
    const { controller, window, event } = ipcHarness()
    registerIpc(controller, window, undefined, {
      cliUpdateCoordinator: {
        installCli: vi.fn(async () => {
          throw new Error(`${PRIVATE_CANARY} xai-secret /private/cli`)
        })
      }
    })

    await expect(handler(IPC.installCliUpdate)(event))
      .rejects.toThrow('The Grok CLI update could not be installed safely.')
  })
})

function ipcHarness(): {
  controller: AppController
  window: BrowserWindow
  event: IpcMainInvokeEvent
} {
  const frame = { url: 'grokbuild://app/index.html' }
  const webContents = { mainFrame: frame }
  const window = { webContents } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const controller = {
    snapshot: () => ({
      appVersion: '1.0.0',
      selectedProjectId: 'project-1',
      projects: [{ id: 'project-1', path: '/canonical/project' }],
      settings: { grokCliPath: '/usr/local/bin/grok' },
      cli: { available: false }
    })
  } as unknown as AppController
  return { controller, window, event }
}

function handler(channel: string): InvokeHandler {
  const registered = electron.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}
