import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import {
  SavedAgentOperationUnavailableError,
  type AppController
} from '../../src/main/AppController'
import { IPC } from '../../src/shared/ipcChannels'
import type {
  PublicAgentRosterSnapshot,
  PublicSavedAgentSummary,
  PublicSessionSnapshot
} from '../../src/shared/models'

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
  ) => ({ response: 1 })),
  showOpenDialog: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: electron.showOpenDialog,
    showMessageBox: electron.showMessageBox
  },
  ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler },
  nativeTheme: { themeSource: 'system' },
  shell: { openExternal: vi.fn() }
}))

const { registerIpc } = await import('../../src/main/ipc')

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const TOKEN = Buffer.alloc(32, 23).toString('base64url')
const PRIVATE_PATH = '/private/agent-ipc-canary'
const RAW_SELECTOR = 'raw-private-agent-selector'
const CANARY = 'agent-ipc-private-canary-6bc2a4'

const EDITABLE = {
  name: 'Builder',
  mission: 'Implement focused changes.',
  glyph: 'hammer.fill',
  color: '#FF9F0A',
  isPinned: false
} as const

describe('main Saved Agent and Grok catalog IPC boundary', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.handle.mockClear()
    electron.removeHandler.mockClear()
    electron.showMessageBox.mockReset()
    electron.showMessageBox.mockResolvedValue({ response: 1 })
  })

  it('passes only narrow Saved Agent edits to the controller-owned private merge', async () => {
    const agent = publicAgent()
    const roster = readyRoster(agent)
    const methods = {
      snapshot: vi.fn(() => ({ agentRoster: roster })),
      createSavedAgent: vi.fn(async () => agent),
      updateSavedAgentEditor: vi.fn(async () => ({ ...agent, isPinned: true })),
      deleteSavedAgent: vi.fn(async () => undefined),
      installStarterAgents: vi.fn(async () => [agent]),
      recoverSavedAgentRoster: vi.fn(async () => ({
        status: 'ready' as const,
        revision: 0,
        agents: []
      })),
      bindSavedAgent: vi.fn(async () => publicSession()),
      listGrokAgentCatalog: vi.fn(async () => publicCatalog())
    }
    const { controller, window, event } = ipcHarness(methods)
    registerIpc(controller, window)

    await expect(handler(IPC.createSavedAgent)(event, {
      expectedRevision: 7,
      draft: EDITABLE
    })).resolves.toEqual(agent)
    expect(methods.createSavedAgent).toHaveBeenCalledWith(7, EDITABLE)

    await expect(handler(IPC.updateSavedAgent)(event, {
      expectedRevision: 7,
      agentId: AGENT_ID,
      changes: { ...EDITABLE, isPinned: true }
    })).resolves.toMatchObject({ id: AGENT_ID, isPinned: true })
    expect(methods.updateSavedAgentEditor).toHaveBeenCalledWith(
      7,
      AGENT_ID,
      { ...EDITABLE, isPinned: true }
    )

    await expect(handler(IPC.deleteSavedAgent)(event, {
      expectedRevision: 7,
      agentId: AGENT_ID
    })).resolves.toEqual({ state: 'deleted' })
    expect(methods.deleteSavedAgent).toHaveBeenCalledWith(7, AGENT_ID)

    await expect(handler(IPC.installStarterAgents)(event, {
      expectedRevision: 7
    })).resolves.toEqual([agent])
    expect(methods.installStarterAgents).toHaveBeenCalledWith(7)

    await expect(handler(IPC.bindSavedAgent)(event, {
      expectedRevision: 7,
      sessionId: 'local-session-1',
      agentId: AGENT_ID
    })).resolves.toEqual(publicSession())
    expect(methods.bindSavedAgent).toHaveBeenCalledWith('local-session-1', AGENT_ID, 7)

    await expect(handler(IPC.listGrokAgentCatalog)(event, {
      projectId: 'project-1'
    })).resolves.toEqual(publicCatalog())
    expect(methods.listGrokAgentCatalog).toHaveBeenCalledWith('project-1')
  })

  it('rejects renderer launch fields, paths, selectors, remote ids, and extra arguments', async () => {
    const methods = controllerMethods()
    const { controller, window, event } = ipcHarness(methods)
    registerIpc(controller, window)

    for (const payload of [
      { expectedRevision: 0, draft: { ...EDITABLE, roleName: RAW_SELECTOR } },
      { expectedRevision: 0, draft: { ...EDITABLE, promptBody: CANARY } },
      { expectedRevision: 0, draft: { ...EDITABLE, path: PRIVATE_PATH } },
      { expectedRevision: 0, draft: { ...EDITABLE, permissionProfile: 'workspaceWrite' } }
    ]) {
      await expect(handler(IPC.createSavedAgent)(event, payload)).rejects.toThrow(
        'The saved agent request could not be completed safely.'
      )
    }
    await expect(handler(IPC.updateSavedAgent)(event, {
      expectedRevision: 0,
      agentId: AGENT_ID,
      changes: { ...EDITABLE, preferredSkills: ['private'] }
    })).rejects.toThrow('The saved agent request could not be completed safely.')
    await expect(handler(IPC.bindSavedAgent)(event, {
      expectedRevision: 0,
      sessionId: 'local-session-1',
      agentId: AGENT_ID,
      remoteSessionId: 'remote-session',
      cwd: PRIVATE_PATH
    })).rejects.toThrow('The saved agent request could not be completed safely.')
    await expect(handler(IPC.recoverSavedAgentRoster)(event, {
      expectedRevision: 0,
      backupPath: PRIVATE_PATH
    })).rejects.toThrow('The saved agent request could not be completed safely.')
    await expect(handler(IPC.listGrokAgentCatalog)(event, {
      projectId: 'project-1',
      cwd: PRIVATE_PATH,
      cliPath: '/private/grok',
      selector: RAW_SELECTOR
    })).rejects.toThrow('The Grok agent catalog could not be loaded safely.')

    expect(methods.createSavedAgent).not.toHaveBeenCalled()
    expect(methods.updateSavedAgentEditor).not.toHaveBeenCalled()
    expect(methods.bindSavedAgent).not.toHaveBeenCalled()
    expect(methods.recoverSavedAgentRoster).not.toHaveBeenCalled()
    expect(methods.listGrokAgentCatalog).not.toHaveBeenCalled()
    expect(electron.showMessageBox).not.toHaveBeenCalled()
  })

  it('uses fixed native recovery confirmation and never returns the backup path', async () => {
    const recovered: PublicAgentRosterSnapshot = {
      status: 'ready',
      revision: 0,
      agents: []
    }
    const recoverSavedAgentRoster = vi.fn(async () => recovered)
    const { controller, window, event } = ipcHarness(controllerMethods({
      recoverSavedAgentRoster
    }))
    registerIpc(controller, window)

    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(handler(IPC.recoverSavedAgentRoster)(event, {
      expectedRevision: 0
    })).resolves.toEqual({ state: 'cancelled' })
    expect(recoverSavedAgentRoster).not.toHaveBeenCalled()

    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    const result = await handler(IPC.recoverSavedAgentRoster)(event, {
      expectedRevision: 0
    })
    expect(result).toEqual({ state: 'recovered', roster: recovered })
    expect(recoverSavedAgentRoster).toHaveBeenCalledWith(0)
    const options = electron.showMessageBox.mock.calls.at(-1)![1]
    expect(options).toMatchObject({
      title: 'Recover saved agents?',
      buttons: ['Cancel', 'Recover'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    const wire = JSON.stringify({ options, result })
    expect(wire).not.toContain('backupPath')
    expect(wire).not.toContain(PRIVATE_PATH)
    expect(wire).not.toContain(CANARY)
  })

  it('defaults Saved Agent deletion to Cancel and returns an explicit result', async () => {
    const deleteSavedAgent = vi.fn(async () => undefined)
    const { controller, window, event } = ipcHarness(controllerMethods({ deleteSavedAgent }))
    registerIpc(controller, window)

    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(handler(IPC.deleteSavedAgent)(event, {
      expectedRevision: 7,
      agentId: AGENT_ID
    })).resolves.toEqual({ state: 'cancelled' })
    expect(deleteSavedAgent).not.toHaveBeenCalled()

    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(handler(IPC.deleteSavedAgent)(event, {
      expectedRevision: 7,
      agentId: AGENT_ID
    })).resolves.toEqual({ state: 'deleted' })
    expect(deleteSavedAgent).toHaveBeenCalledWith(7, AGENT_ID)
    const options = electron.showMessageBox.mock.calls.at(-1)![1]
    expect(options).toMatchObject({
      title: 'Delete saved agent?',
      buttons: ['Cancel', 'Delete Agent'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    const wire = JSON.stringify(options)
    expect(wire).not.toContain(AGENT_ID)
    expect(wire).not.toContain(PRIVATE_PATH)
    expect(wire).not.toContain(CANARY)
  })

  it('strictly validates outputs and redacts controller diagnostics, source paths, and selectors', async () => {
    for (const methods of [
      controllerMethods({
        createSavedAgent: vi.fn(async () => {
          throw new Error(`${CANARY} ${PRIVATE_PATH} ${RAW_SELECTOR}`)
        })
      }),
      controllerMethods({
        createSavedAgent: vi.fn(async () => ({
          ...publicAgent(),
          path: PRIVATE_PATH,
          selector: RAW_SELECTOR,
          canary: CANARY
        }))
      })
    ]) {
      const { controller, window, event } = ipcHarness(methods)
      registerIpc(controller, window)
      const error = await rejection(handler(IPC.createSavedAgent)(event, {
        expectedRevision: 7,
        draft: EDITABLE
      }))
      expect(error.message).toBe('The saved agent request could not be completed safely.')
      expect(String(error)).not.toContain(CANARY)
      expect(String(error)).not.toContain(PRIVATE_PATH)
      expect(String(error)).not.toContain(RAW_SELECTOR)
    }

    for (const listGrokAgentCatalog of [
      vi.fn(async () => {
        throw new Error(`${CANARY} ${PRIVATE_PATH} ${RAW_SELECTOR}`)
      }),
      vi.fn(async () => [{
        ...publicCatalog()[0]!,
        path: PRIVATE_PATH,
        selector: RAW_SELECTOR,
        canary: CANARY
      }])
    ]) {
      const { controller, window, event } = ipcHarness(controllerMethods({
        listGrokAgentCatalog
      }))
      registerIpc(controller, window)
      const error = await rejection(handler(IPC.listGrokAgentCatalog)(event, {
        projectId: 'project-1'
      }))
      expect(error.message).toBe('The Grok agent catalog could not be loaded safely.')
      expect(String(error)).not.toContain(CANARY)
      expect(String(error)).not.toContain(PRIVATE_PATH)
      expect(String(error)).not.toContain(RAW_SELECTOR)
    }
  })

  it('rejects valid-looking cross-agent and cross-session output identities', async () => {
    const otherAgentId = '22222222-2222-4222-8222-222222222222'
    const { controller, window, event } = ipcHarness(controllerMethods({
      updateSavedAgentEditor: vi.fn(async () => ({ ...publicAgent(), id: otherAgentId })),
      bindSavedAgent: vi.fn(async () => ({ ...publicSession(), id: 'other-local-session' }))
    }))
    registerIpc(controller, window)

    await expect(handler(IPC.updateSavedAgent)(event, {
      expectedRevision: 7,
      agentId: AGENT_ID,
      changes: EDITABLE
    })).rejects.toThrow('Saved agents changed or are unavailable. Refresh and try again.')
    await expect(handler(IPC.bindSavedAgent)(event, {
      expectedRevision: 7,
      sessionId: 'local-session-1',
      agentId: AGENT_ID
    })).rejects.toThrow('Saved agents changed or are unavailable. Refresh and try again.')
  })

  it('does not expose diagnostics carried by recognized Saved Agent errors', async () => {
    const { controller, window, event } = ipcHarness(controllerMethods({
      createSavedAgent: vi.fn(async () => {
        throw new SavedAgentOperationUnavailableError(
          `${CANARY} ${PRIVATE_PATH} ${RAW_SELECTOR}`
        )
      })
    }))
    registerIpc(controller, window)

    const error = await rejection(handler(IPC.createSavedAgent)(event, {
      expectedRevision: 7,
      draft: EDITABLE
    }))
    expect(error.message).toBe('Saved agents changed or are unavailable. Refresh and try again.')
    expect(String(error)).not.toContain(CANARY)
    expect(String(error)).not.toContain(PRIVATE_PATH)
    expect(String(error)).not.toContain(RAW_SELECTOR)
  })
})

function controllerMethods(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const agent = publicAgent()
  return {
    snapshot: vi.fn(() => ({ agentRoster: readyRoster(agent) })),
    createSavedAgent: vi.fn(async () => agent),
    updateSavedAgentEditor: vi.fn(async () => agent),
    deleteSavedAgent: vi.fn(async () => undefined),
    installStarterAgents: vi.fn(async () => [agent]),
    recoverSavedAgentRoster: vi.fn(async () => ({
      status: 'ready' as const,
      revision: 0,
      agents: []
    })),
    bindSavedAgent: vi.fn(async () => publicSession()),
    listGrokAgentCatalog: vi.fn(async () => publicCatalog()),
    ...overrides
  }
}

function publicAgent(): PublicSavedAgentSummary {
  return {
    id: AGENT_ID,
    name: EDITABLE.name,
    mission: EDITABLE.mission,
    glyph: EDITABLE.glyph,
    color: EDITABLE.color,
    isPinned: EDITABLE.isPinned
  }
}

function readyRoster(agent: PublicSavedAgentSummary): PublicAgentRosterSnapshot {
  return { status: 'ready', revision: 7, agents: [agent] }
}

function publicCatalog(): Array<{
  token: string
  name: string
  description: string
  sourceKind: 'plugin'
  pluginDisplayName: string
}> {
  return [{
    token: TOKEN,
    name: 'Verifier',
    description: 'Review changes without exposing its definition source.',
    sourceKind: 'plugin',
    pluginDisplayName: 'Verified Plugin'
  }]
}

function publicSession(): PublicSessionSnapshot {
  return {
    id: 'local-session-1',
    projectId: 'project-1',
    title: 'Builder',
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
    pendingUserCount: 0,
    savedAgentId: AGENT_ID,
    savedAgent: {
      name: EDITABLE.name,
      glyph: EDITABLE.glyph,
      color: EDITABLE.color
    }
  }
}

function ipcHarness(methods: Record<string, unknown>): {
  controller: AppController
  window: BrowserWindow
  event: IpcMainInvokeEvent
} {
  const frame = { url: 'grokbuild://app/index.html' }
  const webContents = { mainFrame: frame }
  const window = { webContents } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return {
    controller: methods as unknown as AppController,
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
