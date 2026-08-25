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

const TOKEN = Buffer.alloc(32, 23).toString('base64url')
const PRIVATE_PATH = '/private/grok/memory/workspace-secret/sessions/private.md'
const CANARY = 'MEMORY_IPC_PRIVATE_CANARY_78A1'

describe('main memory IPC boundary', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.handle.mockClear()
    electron.removeHandler.mockClear()
    electron.showMessageBox.mockReset()
    electron.showMessageBox.mockResolvedValue({ response: 0 })
  })

  it('exposes only zero-input list, opaque-token read/delete, and bounded notes', async () => {
    const listMemory = vi.fn(async () => [summary()])
    const readMemory = vi.fn(async () => ({ ...summary(), contents: 'Remember this.' }))
    const rememberMemory = vi.fn(async () => undefined)
    const deleteMemory = vi.fn(async () => undefined)
    const { controller, window, event } = ipcHarness({
      listMemory,
      readMemory,
      rememberMemory,
      deleteMemory
    })
    registerIpc(controller, window)

    await expect(handler(IPC.listMemory)(event)).resolves.toEqual([summary()])
    await expect(handler(IPC.readMemory)(event, { token: TOKEN })).resolves.toEqual({
      ...summary(),
      contents: 'Remember this.'
    })
    await expect(handler(IPC.rememberMemory)(event, { note: 'Prefer focused QA.' }))
      .resolves.toBeUndefined()
    await expect(handler(IPC.deleteMemory)(event, { token: TOKEN }))
      .resolves.toEqual({ state: 'cancelled' })

    expect(listMemory).toHaveBeenCalledWith()
    expect(readMemory).toHaveBeenCalledWith(TOKEN)
    expect(rememberMemory).toHaveBeenCalledWith('Prefer focused QA.')
    expect(deleteMemory).not.toHaveBeenCalled()
  })

  it('rejects extra arguments, paths, scopes, and hostile tokens before main work', async () => {
    const calls = {
      listMemory: vi.fn(),
      readMemory: vi.fn(),
      rememberMemory: vi.fn(),
      deleteMemory: vi.fn()
    }
    const { controller, window, event } = ipcHarness(calls)
    registerIpc(controller, window)

    const attempts = [
      handler(IPC.listMemory)(event, { path: PRIVATE_PATH }),
      handler(IPC.readMemory)(event, { token: TOKEN, path: PRIVATE_PATH }),
      handler(IPC.readMemory)(event, { token: TOKEN }, { token: TOKEN }),
      handler(IPC.readMemory)(event, { token: PRIVATE_PATH }),
      handler(IPC.rememberMemory)(event, { note: 'x', scope: 'workspace' }),
      handler(IPC.rememberMemory)(event, { note: 'x' }, { path: PRIVATE_PATH }),
      handler(IPC.deleteMemory)(event, { token: `${TOKEN}x` }),
      handler(IPC.deleteMemory)(event, { token: TOKEN }, { path: PRIVATE_PATH })
    ]
    for (const attempt of attempts) {
      const error = await rejection(attempt)
      expect(error.message).toBe('The memory request could not be completed safely.')
      expect(String(error)).not.toContain(PRIVATE_PATH)
    }
    expect(calls.listMemory).not.toHaveBeenCalled()
    expect(calls.readMemory).not.toHaveBeenCalled()
    expect(calls.rememberMemory).not.toHaveBeenCalled()
    expect(calls.deleteMemory).not.toHaveBeenCalled()
  })

  it('uses generic Cancel-default native confirmation and consumes only after confirmation', async () => {
    const deleteMemory = vi.fn(async () => undefined)
    const { controller, window, event } = ipcHarness({ deleteMemory })
    registerIpc(controller, window)

    await expect(handler(IPC.deleteMemory)(event, { token: TOKEN }))
      .resolves.toEqual({ state: 'cancelled' })
    expect(deleteMemory).not.toHaveBeenCalled()
    expect(electron.showMessageBox).toHaveBeenCalledOnce()
    const cancelledCopy = electron.showMessageBox.mock.calls[0]![1]
    expect(cancelledCopy).toMatchObject({
      type: 'warning',
      buttons: ['Cancel', 'Delete Memory'],
      defaultId: 0,
      cancelId: 0
    })
    expect(JSON.stringify(cancelledCopy)).not.toContain(TOKEN)
    expect(JSON.stringify(cancelledCopy)).not.toContain(PRIVATE_PATH)

    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(handler(IPC.deleteMemory)(event, { token: TOKEN }))
      .resolves.toEqual({ state: 'deleted' })
    expect(deleteMemory).toHaveBeenCalledOnce()
    expect(deleteMemory).toHaveBeenCalledWith(TOKEN)
  })

  it('rejects malformed outputs and redacts controller diagnostics', async () => {
    for (const overrides of [
      {
        listMemory: vi.fn(async () => [{
          ...summary(),
          path: PRIVATE_PATH,
          canary: CANARY
        }])
      },
      {
        readMemory: vi.fn(async () => {
          throw new Error(`${CANARY} ${PRIVATE_PATH} ${TOKEN}`)
        })
      }
    ]) {
      const { controller, window, event } = ipcHarness(overrides)
      registerIpc(controller, window)
      const attempt = 'listMemory' in overrides
        ? handler(IPC.listMemory)(event)
        : handler(IPC.readMemory)(event, { token: TOKEN })
      const error = await rejection(attempt)
      expect(error.message).toBe('The memory request could not be completed safely.')
      expect(String(error)).not.toContain(CANARY)
      expect(String(error)).not.toContain(PRIVATE_PATH)
      expect(String(error)).not.toContain(TOKEN)
    }
  })
})

function summary(): {
  token: string
  scope: 'session'
  title: string
  workspaceLabel: string
  modifiedAt: string
  byteLength: number
  canDelete: true
} {
  return {
    token: TOKEN,
    scope: 'session',
    title: 'Session memory 1',
    workspaceLabel: 'Workspace 1',
    modifiedAt: '2026-08-25T00:00:00.000Z',
    byteLength: 14,
    canDelete: true
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
      snapshot: () => ({ settings: { privacyMode: false, memoryEnabled: false } }),
      listMemory: vi.fn(async () => []),
      readMemory: vi.fn(),
      rememberMemory: vi.fn(),
      deleteMemory: vi.fn(),
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
