import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AppController } from '../../src/main/AppController'
import { IPC } from '../../src/shared/ipcChannels'
import type { PublicSessionSnapshot } from '../../src/shared/models'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  handle: vi.fn((channel: string, handler: InvokeHandler) => {
    electron.handlers.set(channel, handler)
  }),
  removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
  showMessageBox: vi.fn(async (
    _window: unknown,
    _options: Record<string, unknown>
  ) => ({ response: 0 }))
}))

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
    showMessageBox: electron.showMessageBox
  },
  ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler },
  nativeTheme: { themeSource: 'system' },
  shell: { openExternal: vi.fn() }
}))

const { registerIpc } = await import('../../src/main/ipc')
const TOKEN = Buffer.alloc(32, 19).toString('base64url')
const REMOTE_ID = '01234567-89ab-cdef-0123-456789abcdef'
const PRIVATE_PATH = '/private/history-ipc-canary-project'
const CANARY = 'history-ipc-private-canary-03f18a'

describe('main session history IPC boundary', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.handle.mockClear()
    electron.removeHandler.mockClear()
    electron.showMessageBox.mockReset()
    electron.showMessageBox.mockResolvedValue({ response: 0 })
  })

  it('exposes only zero-input list, bounded query, and opaque-token operations', async () => {
    const records = [publicHistoryRecord()]
    const listSessionHistory = vi.fn(async () => records)
    const searchSessionHistory = vi.fn(async () => records)
    const openSessionHistory = vi.fn(async () => publicSession())
    const deleteSessionHistory = vi.fn(async () => ({ state: 'cancelled' as const }))
    const { controller, window, event } = ipcHarness({
      listSessionHistory,
      searchSessionHistory,
      openSessionHistory,
      deleteSessionHistory
    })
    registerIpc(controller, window)

    await expect(handler(IPC.listSessionHistory)(event)).resolves.toEqual(records)
    await expect(handler(IPC.searchSessionHistory)(event, { query: 'auth bug' }))
      .resolves.toEqual(records)
    await expect(handler(IPC.openSessionHistory)(event, { token: TOKEN }))
      .resolves.toEqual(publicSession())
    await expect(handler(IPC.deleteSessionHistory)(event, { token: TOKEN }))
      .resolves.toEqual({ state: 'cancelled' })
    expect(listSessionHistory).toHaveBeenCalledWith()
    expect(searchSessionHistory).toHaveBeenCalledWith('auth bug')
    expect(openSessionHistory).toHaveBeenCalledWith(TOKEN)
    expect(deleteSessionHistory).toHaveBeenCalledWith(TOKEN, expect.any(Function))
  })

  it('rejects extra arguments, paths, CLI fields, remote ids, and hostile tokens before main work', async () => {
    const calls = {
      listSessionHistory: vi.fn(),
      searchSessionHistory: vi.fn(),
      openSessionHistory: vi.fn(),
      deleteSessionHistory: vi.fn()
    }
    const { controller, window, event } = ipcHarness(calls)
    registerIpc(controller, window)

    await expect(handler(IPC.listSessionHistory)(event, { cwd: PRIVATE_PATH })).rejects.toThrow(
      'The session history request could not be completed safely.'
    )
    await expect(handler(IPC.searchSessionHistory)(event, {
      query: 'auth', cwd: PRIVATE_PATH, cliPath: '/tmp/grok', argv: ['sessions']
    })).rejects.toThrow('The session history request could not be completed safely.')
    await expect(handler(IPC.openSessionHistory)(event, {
      token: TOKEN, remoteId: REMOTE_ID
    })).rejects.toThrow('The session history request could not be completed safely.')
    await expect(handler(IPC.deleteSessionHistory)(event, {
      token: `${TOKEN}x`
    })).rejects.toThrow('The session history request could not be completed safely.')
    expect(calls.listSessionHistory).not.toHaveBeenCalled()
    expect(calls.searchSessionHistory).not.toHaveBeenCalled()
    expect(calls.openSessionHistory).not.toHaveBeenCalled()
    expect(calls.deleteSessionHistory).not.toHaveBeenCalled()
  })

  it('uses an Electron-native confirmation containing only bounded summary text', async () => {
    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    const deleteSessionHistory = vi.fn(async (
      _token: string,
      confirm: (summary: string) => Promise<boolean>
    ) => ({ state: await confirm('Restore the auth flow') ? 'deleted' as const : 'cancelled' as const }))
    const { controller, window, event } = ipcHarness({ deleteSessionHistory })
    registerIpc(controller, window)

    await expect(handler(IPC.deleteSessionHistory)(event, { token: TOKEN }))
      .resolves.toEqual({ state: 'deleted' })
    expect(electron.showMessageBox).toHaveBeenCalledOnce()
    const options = electron.showMessageBox.mock.calls[0]![1]
    expect(options).toMatchObject({
      title: 'Delete Grok session?',
      detail: 'Restore the auth flow',
      buttons: ['Cancel', 'Delete Session'],
      defaultId: 0,
      cancelId: 0
    })
    const wire = JSON.stringify(options)
    expect(wire).not.toContain(TOKEN)
    expect(wire).not.toContain(REMOTE_ID)
    expect(wire).not.toContain(PRIVATE_PATH)
  })

  it('uses fixed native confirmation copy when main-owned Privacy Mode is enabled', async () => {
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const deleteSessionHistory = vi.fn(async (
      _token: string,
      confirm: (summary: string) => Promise<boolean>
    ) => ({ state: await confirm(CANARY) ? 'deleted' as const : 'cancelled' as const }))
    const { controller, window, event } = ipcHarness({
      deleteSessionHistory,
      snapshot: () => ({ settings: { privacyMode: true } })
    })
    registerIpc(controller, window)

    await expect(handler(IPC.deleteSessionHistory)(event, { token: TOKEN }))
      .resolves.toEqual({ state: 'cancelled' })
    const options = electron.showMessageBox.mock.calls[0]![1]
    expect(options).toMatchObject({
      detail: 'This saved session will be deleted from Grok CLI history.'
    })
    expect(JSON.stringify(options)).not.toContain(CANARY)
  })

  it('redacts controller diagnostics and rejects output containing main-only fields or canaries', async () => {
    for (const overrides of [
      {
        listSessionHistory: vi.fn(async () => {
          throw new Error(`${CANARY} ${PRIVATE_PATH} ${REMOTE_ID}`)
        })
      },
      {
        listSessionHistory: vi.fn(async () => [{
          ...publicHistoryRecord(),
          remoteId: REMOTE_ID,
          cwd: PRIVATE_PATH,
          canary: CANARY
        }])
      }
    ]) {
      const { controller, window, event } = ipcHarness(overrides)
      registerIpc(controller, window)
      const error = await rejection(handler(IPC.listSessionHistory)(event))
      expect(error.message).toBe('The session history request could not be completed safely.')
      expect(String(error)).not.toContain(CANARY)
      expect(String(error)).not.toContain(PRIVATE_PATH)
      expect(String(error)).not.toContain(REMOTE_ID)
    }
  })
})

function publicHistoryRecord(): {
  token: string
  projectId: string
  summary: string
  status: string
  created: string
  updated: string
} {
  return {
    token: TOKEN,
    projectId: 'project-1',
    summary: 'Restore the auth flow',
    status: 'local',
    created: '2026-08-20',
    updated: '2026-08-25'
  }
}

function publicSession(): PublicSessionSnapshot {
  return {
    id: 'local-session-1',
    projectId: 'project-1',
    title: 'Restore the auth flow',
    status: 'idle',
    model: 'grok-4.6',
    mode: 'default',
    reasoningEffort: 'xhigh',
    permissionMode: 'ask',
    contextUsed: 0,
    contextLimit: 500_000,
    transcript: [],
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    canFork: false,
    activityStatus: 'idle',
    hasUnreadCompletion: false,
    pendingUserCount: 0
  }
}

function ipcHarness(overrides: Record<string, unknown>): {
  controller: AppController
  window: BrowserWindow
  event: IpcMainInvokeEvent
} {
  const frame = { url: 'grokbuild://app/index.html' }
  const webContents = { mainFrame: frame }
  const window = { webContents } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return {
    controller: {
      snapshot: () => ({ settings: { privacyMode: false } }),
      ...overrides
    } as unknown as AppController,
    window,
    event
  }
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
