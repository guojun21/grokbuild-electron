import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AppController } from '../../src/main/AppController'
import type { ProjectOpenService } from '../../src/main/workspaces/ProjectOpenService'
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

describe('main project-action IPC boundary', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.handle.mockClear()
    electron.removeHandler.mockClear()
  })

  it('resolves the project path in main and strips launcher internals from the result', async () => {
    const moveProject = vi.fn()
    const listTargets = vi.fn(async () => [
      { target: 'finder' as const, label: 'Finder', installed: true },
      { target: 'cursor' as const, label: 'Cursor', installed: false }
    ])
    const openProject = vi.fn(async () => ({
      target: 'cursor' as const,
      disposition: 'open-with-application' as const,
      opened: true as const
    }))
    const { controller, window, event } = ipcHarness(moveProject)
    registerIpc(controller, window, undefined, {
      projectOpenService: { listTargets, openProject } as Pick<
        ProjectOpenService,
        'listTargets' | 'openProject'
      >
    })

    const move = handler(IPC.moveProject)
    await move(event, { projectId: 'project-1', direction: 'down' })
    expect(moveProject).toHaveBeenCalledWith('project-1', 'down')

    const list = handler(IPC.listProjectOpenTargets)
    await expect(list(event)).resolves.toEqual([
      { target: 'finder', label: 'Finder', installed: true },
      { target: 'cursor', label: 'Cursor', installed: false }
    ])

    const open = handler(IPC.openProject)
    await expect(open(event, { projectId: 'project-1', target: 'cursor' })).resolves.toEqual({
      target: 'cursor',
      opened: true
    })
    expect(openProject).toHaveBeenCalledWith('/canonical/main-owned/project', 'cursor')
  })

  it('rejects renderer paths, bundles, argv, targets, and list arguments before launching', async () => {
    const openProject = vi.fn()
    const { controller, window, event } = ipcHarness(vi.fn())
    registerIpc(controller, window, undefined, {
      projectOpenService: {
        listTargets: vi.fn(async () => []),
        openProject
      } as Pick<ProjectOpenService, 'listTargets' | 'openProject'>
    })
    const open = handler(IPC.openProject)

    await expect(open(event, {
      projectId: 'project-1',
      target: 'cursor',
      path: '/renderer/path',
      bundleId: 'attacker.bundle',
      argv: ['--arbitrary']
    })).rejects.toThrow()
    await expect(open(event, {
      projectId: 'project-1',
      target: 'custom-application'
    })).rejects.toThrow()
    await expect(handler(IPC.listProjectOpenTargets)(event, '/renderer/path')).rejects.toThrow()
    expect(openProject).not.toHaveBeenCalled()
  })

  it('accepts only local session id and boolean for settled and unread mutations', async () => {
    const setSessionSettled = vi.fn()
    const setSessionUnread = vi.fn()
    const { controller, window, event } = ipcHarness(vi.fn())
    Object.assign(controller, { setSessionSettled, setSessionUnread })
    registerIpc(controller, window)

    await handler(IPC.setSessionSettled)(event, { sessionId: 'session-1', settled: true })
    await handler(IPC.setSessionUnread)(event, { sessionId: 'session-1', unread: false })
    expect(setSessionSettled).toHaveBeenCalledWith('session-1', true)
    expect(setSessionUnread).toHaveBeenCalledWith('session-1', false)

    expect(() => handler(IPC.setSessionSettled)(event, {
      sessionId: 'session-1', settled: true, remoteSessionId: 'remote-secret'
    })).toThrow()
    expect(() => handler(IPC.setSessionUnread)(event, {
      sessionId: 'session-1', unread: true, cwd: '/renderer/path'
    })).toThrow()
  })
})

function ipcHarness(moveProject: ReturnType<typeof vi.fn>): {
  controller: AppController
  window: BrowserWindow
  event: IpcMainInvokeEvent
} {
  const frame = { url: 'grokbuild://app/index.html' }
  const webContents = { mainFrame: frame }
  const window = { webContents } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const controller = {
    moveProject,
    snapshot: () => ({
      projects: [{ id: 'project-1', path: '/canonical/main-owned/project' }]
    })
  } as unknown as AppController
  return { controller, window, event }
}

function handler(channel: string): InvokeHandler {
  const registered = electron.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}
