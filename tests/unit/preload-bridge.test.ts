import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GrokBuildBridge } from '../../src/shared/bridge'
import { IPC } from '../../src/shared/ipcChannels'

const electron = vi.hoisted(() => ({
  exposed: undefined as unknown,
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  exposeInMainWorld: vi.fn((_name: string, value: unknown) => {
    electron.exposed = value
  })
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener
  }
}))

await import('../../src/preload/index')

describe('preload project-action bridge', () => {
  beforeEach(() => {
    electron.invoke.mockReset()
  })

  it('exposes only fixed project IDs, directions, and target IDs to IPC', async () => {
    const bridge = electron.exposed as GrokBuildBridge
    electron.invoke.mockResolvedValue(undefined)
    const agentId = '11111111-1111-4111-8111-111111111111'
    const draft = {
      name: 'Builder',
      mission: 'Implement focused changes.',
      glyph: 'hammer.fill',
      color: '#FF9F0A',
      isPinned: false
    }

    await bridge.moveProject({ projectId: 'p1', direction: 'down' })
    await bridge.inspectDashboardGit()
    await bridge.listProjectOpenTargets()
    await bridge.openProject({ projectId: 'p1', target: 'cursor' })
    await bridge.installAppUpdate()
    await bridge.installCliUpdate()
    await bridge.setSessionSettled({ sessionId: 's1', settled: true })
    await bridge.setSessionUnread({ sessionId: 's1', unread: false })
    await bridge.createSavedAgent({ expectedRevision: 0, draft })
    await bridge.updateSavedAgent({
      expectedRevision: 1,
      agentId,
      changes: { ...draft, isPinned: true }
    })
    await bridge.deleteSavedAgent({ expectedRevision: 2, agentId })
    await bridge.installStarterAgents({ expectedRevision: 3 })
    await bridge.recoverSavedAgentRoster({ expectedRevision: 0 })
    await bridge.bindSavedAgent({
      expectedRevision: 4,
      sessionId: 's1',
      agentId
    })
    await bridge.listGrokAgentCatalog({ projectId: 'p1' })
    const memoryToken = Buffer.alloc(32, 9).toString('base64url')
    await bridge.listMemory()
    await bridge.readMemory({ token: memoryToken })
    await bridge.rememberMemory({ note: 'Keep this preference.' })
    await bridge.deleteMemory({ token: memoryToken })

    expect(electron.invoke.mock.calls).toEqual([
      [IPC.moveProject, { projectId: 'p1', direction: 'down' }],
      [IPC.inspectDashboardGit],
      [IPC.listProjectOpenTargets],
      [IPC.openProject, { projectId: 'p1', target: 'cursor' }],
      [IPC.installAppUpdate],
      [IPC.installCliUpdate],
      [IPC.setSessionSettled, { sessionId: 's1', settled: true }],
      [IPC.setSessionUnread, { sessionId: 's1', unread: false }],
      [IPC.createSavedAgent, { expectedRevision: 0, draft }],
      [IPC.updateSavedAgent, {
        expectedRevision: 1,
        agentId,
        changes: { ...draft, isPinned: true }
      }],
      [IPC.deleteSavedAgent, { expectedRevision: 2, agentId }],
      [IPC.installStarterAgents, { expectedRevision: 3 }],
      [IPC.recoverSavedAgentRoster, { expectedRevision: 0 }],
      [IPC.bindSavedAgent, { expectedRevision: 4, sessionId: 's1', agentId }],
      [IPC.listGrokAgentCatalog, { projectId: 'p1' }],
      [IPC.listMemory],
      [IPC.readMemory, { token: memoryToken }],
      [IPC.rememberMemory, { note: 'Keep this preference.' }],
      [IPC.deleteMemory, { token: memoryToken }]
    ])
    expect(bridge).not.toHaveProperty('openPath')
    expect(bridge).not.toHaveProperty('openApplication')
    expect(bridge).not.toHaveProperty('exec')
    expect(bridge).not.toHaveProperty('resolveGrokAgent')
    expect(bridge).not.toHaveProperty('listAgentSourcePaths')
    expect(bridge).not.toHaveProperty('listMemoryPaths')
  })
})
