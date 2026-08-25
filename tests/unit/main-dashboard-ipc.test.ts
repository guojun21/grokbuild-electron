import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AppController } from '../../src/main/AppController'
import { IPC } from '../../src/shared/ipcChannels'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  handle: vi.fn((channel: string, handler: InvokeHandler) => {
    electron.handlers.set(channel, handler)
  }),
  removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel))
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler },
  nativeTheme: { themeSource: 'system' },
  shell: { openExternal: vi.fn() }
}))

const { registerIpc } = await import('../../src/main/ipc')
const PRIVATE_CANARY = 'dashboard-ipc-private-canary-e87c7a'

describe('main dashboard IPC boundary', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.handle.mockClear()
    electron.removeHandler.mockClear()
  })

  it('is strictly argument-free and returns only the bounded dashboard projection', async () => {
    const inspectDashboardGit = vi.fn(async () => ({
      projectId: 'project-1',
      isRepository: true,
      isWorktree: false,
      branch: 'main',
      dirtyCount: 3
    }))
    const { controller, window, event } = ipcHarness(inspectDashboardGit)
    registerIpc(controller, window)
    const inspect = handler(IPC.inspectDashboardGit)

    await expect(inspect(event)).resolves.toEqual({
      projectId: 'project-1',
      isRepository: true,
      isWorktree: false,
      branch: 'main',
      dirtyCount: 3
    })
    expect(inspectDashboardGit).toHaveBeenCalledTimes(1)
    expect(inspectDashboardGit).toHaveBeenCalledWith()

    await expect(inspect(event, { projectId: 'renderer-project' }))
      .rejects.toThrow('Could not inspect the selected project.')
    const argumentError = await rejection(inspect(event, `/private/${PRIVATE_CANARY}`))
    expect(argumentError.message).toBe('Could not inspect the selected project.')
    expect(String(argumentError)).not.toContain(PRIVATE_CANARY)
    expect(String(argumentError)).not.toContain('/private/')
    expect(inspectDashboardGit).toHaveBeenCalledTimes(1)
  })

  it('replaces inspector diagnostics and invalid output with one canary-free error', async () => {
    for (const inspectDashboardGit of [
      vi.fn(async () => {
        throw new Error(`/private/${PRIVATE_CANARY} stderr --argv diff`)
      }),
      vi.fn(async () => ({
        projectId: 'project-1',
        isRepository: true,
        isWorktree: false,
        branch: 'main',
        dirtyCount: 0,
        path: `/private/${PRIVATE_CANARY}`
      }))
    ]) {
      const { controller, window, event } = ipcHarness(inspectDashboardGit)
      registerIpc(controller, window)

      const error = await rejection(handler(IPC.inspectDashboardGit)(event))
      expect(error.message).toBe('Could not inspect the selected project.')
      expect(String(error)).not.toContain(PRIVATE_CANARY)
      expect(String(error)).not.toContain('/private/')
    }
  })
})

function ipcHarness(inspectDashboardGit: ReturnType<typeof vi.fn>): {
  controller: AppController
  window: BrowserWindow
  event: IpcMainInvokeEvent
} {
  const frame = { url: 'grokbuild://app/index.html' }
  const webContents = { mainFrame: frame }
  const window = { webContents } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const controller = { inspectDashboardGit } as unknown as AppController
  return { controller, window, event }
}

function handler(channel: string): InvokeHandler {
  const registered = electron.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

async function rejection(promise: Promise<unknown> | unknown): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('Expected promise to reject')
}
