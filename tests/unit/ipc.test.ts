import { describe, expect, it } from 'vitest'
import {
  addMcpInput,
  cancelAttachmentsInput,
  chooseAttachmentsInput,
  closeSessionInput,
  createSavedAgentInput,
  updateSavedAgentInput,
  deleteSavedAgentInput,
  installStarterAgentsInput,
  recoverSavedAgentRosterInput,
  bindSavedAgentInput,
  listGrokAgentCatalogInput,
  savedAgentRosterRecoveryResultSchema,
  savedAgentDeleteResultSchema,
  doctorMcpInput,
  duplicateSessionInput,
  forkSessionInput,
  moveProjectInput,
  noArgumentsInput,
  openProjectInput,
  projectOpenResultSchema,
  projectOpenTargetStatusSchema,
  removeMcpInput,
  removeProjectInput,
  retrySessionInput,
  searchSessionHistoryInput,
  openSessionHistoryInput,
  deleteSessionHistoryInput,
  readMemoryInput,
  rememberMemoryInput,
  deleteMemoryInput,
  selectProjectInput,
  sendPromptInput,
  setProjectPinnedInput,
  setSessionPinnedInput,
  setSessionSettledInput,
  setSessionUnreadInput,
  swiftImportTokenInput,
  updateSettingsInput
} from '../../src/shared/ipc'
import { dashboardProjectStatusSchema } from '../../src/shared/dashboard'
import {
  appUpdateInstallResultSchema,
  updateOverviewSchema
} from '../../src/shared/updates'

describe('renderer-to-main input contracts', () => {
  it('rejects empty and oversized prompts', () => {
    expect(() => sendPromptInput.parse({ sessionId: 's1', text: '   ' })).toThrow()
    expect(() => sendPromptInput.parse({ sessionId: 's1', text: 'x'.repeat(200_001) })).toThrow()
    expect(sendPromptInput.parse({
      sessionId: 's1',
      text: '',
      attachmentToken: 'opaque_attachment_token_0001'
    })).toEqual({
      sessionId: 's1',
      text: '',
      attachmentToken: 'opaque_attachment_token_0001'
    })
    expect(() => sendPromptInput.parse({ sessionId: 's1', text: '', attachmentToken: '/tmp/file' }))
      .toThrow()
  })

  it('keeps attachment IPC session/token-only and never accepts renderer paths or bytes', () => {
    expect(chooseAttachmentsInput.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' })
    expect(cancelAttachmentsInput.parse({
      sessionId: 's1', token: 'opaque_attachment_token_0001'
    })).toEqual({ sessionId: 's1', token: 'opaque_attachment_token_0001' })
    expect(() => chooseAttachmentsInput.parse({ sessionId: 's1', paths: ['/private/input.png'] }))
      .toThrow()
    expect(() => cancelAttachmentsInput.parse({
      sessionId: 's1', token: 'opaque_attachment_token_0001', data: 'base64'
    })).toThrow()
  })

  it('bounds live session resource usage', () => {
    expect(() => updateSettingsInput.parse({ maxLiveSessions: 9 })).toThrow()
    expect(updateSettingsInput.parse({ maxLiveSessions: 4 })).toEqual({ maxLiveSessions: 4 })
  })

  it('accepts only strict boolean privacy and memory updates and rejects empty settings', () => {
    expect(updateSettingsInput.parse({ privacyMode: true })).toEqual({ privacyMode: true })
    expect(updateSettingsInput.parse({ privacyMode: false })).toEqual({ privacyMode: false })
    expect(() => updateSettingsInput.parse({})).toThrow()
    expect(() => updateSettingsInput.parse({ privacyMode: 'true' })).toThrow()
    expect(() => updateSettingsInput.parse({ privacyMode: 1 })).toThrow()
    expect(() => updateSettingsInput.parse({ privacyMode: null })).toThrow()
    expect(() => updateSettingsInput.parse({ privacyMode: true, redactedSnapshot: {} })).toThrow()
    expect(updateSettingsInput.parse({ memoryEnabled: true })).toEqual({ memoryEnabled: true })
    expect(updateSettingsInput.parse({ memoryEnabled: false })).toEqual({ memoryEnabled: false })
    expect(() => updateSettingsInput.parse({ memoryEnabled: 'true' })).toThrow()
  })

  it('keeps memory IPC note/token-only and rejects paths or extra capabilities', () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    expect(readMemoryInput.parse({ token })).toEqual({ token })
    expect(deleteMemoryInput.parse({ token })).toEqual({ token })
    expect(rememberMemoryInput.parse({ note: 'Prefer focused QA.' }))
      .toEqual({ note: 'Prefer focused QA.' })
    expect(() => readMemoryInput.parse({ token, path: '/private/memory/MEMORY.md' })).toThrow()
    expect(() => deleteMemoryInput.parse({ token: '/private/memory/MEMORY.md' })).toThrow()
    expect(() => rememberMemoryInput.parse({ note: 'x', scope: 'workspace' })).toThrow()
  })

  it('rejects unknown renderer-controlled settings', () => {
    expect(() =>
      updateSettingsInput.parse({
        appearance: 'dark',
        grokCliPath: '/tmp/untrusted-grok'
      })
    ).toThrow()
    expect(() =>
      sendPromptInput.parse({
        sessionId: 's1',
        text: 'hello',
        unexpectedCapability: true
      })
    ).toThrow()
  })

  it('keeps project and session lifecycle IPC identifier-only and bounded', () => {
    expect(selectProjectInput.parse({ projectId: 'p1' })).toEqual({ projectId: 'p1' })
    expect(removeProjectInput.parse({ projectId: 'p1' })).toEqual({ projectId: 'p1' })
    expect(closeSessionInput.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' })
    expect(retrySessionInput.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' })
    expect(duplicateSessionInput.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' })
    expect(forkSessionInput.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' })
    expect(setProjectPinnedInput.parse({ projectId: 'p1', pinned: true })).toEqual({ projectId: 'p1', pinned: true })
    expect(setSessionPinnedInput.parse({ sessionId: 's1', pinned: false })).toEqual({ sessionId: 's1', pinned: false })
    expect(setSessionSettledInput.parse({ sessionId: 's1', settled: true })).toEqual({ sessionId: 's1', settled: true })
    expect(setSessionUnreadInput.parse({ sessionId: 's1', unread: false })).toEqual({ sessionId: 's1', unread: false })
    expect(() => removeProjectInput.parse({ projectId: 'p1', recursive: true })).toThrow()
    expect(() => duplicateSessionInput.parse({ sessionId: 's1', acpSessionId: 'inject' })).toThrow()
    expect(() => forkSessionInput.parse({
      sessionId: 's1',
      acpSessionId: 'remote-id',
      cwd: '/renderer/path',
      chatMessagesCopied: 4
    })).toThrow()
    expect(() => retrySessionInput.parse({ sessionId: 's1', prompt: 'replay me' })).toThrow()
    expect(() => setSessionSettledInput.parse({
      sessionId: 's1', settled: true, acpSessionId: 'remote-id'
    })).toThrow()
    expect(() => setSessionUnreadInput.parse({
      sessionId: 's1', unread: true, remoteSessionId: 'remote-id'
    })).toThrow()
  })

  it('keeps Saved Agent edits narrow, revisioned, and free of launch preferences', () => {
    const agentId = '11111111-1111-4111-8111-111111111111'
    const editable = {
      name: 'Builder',
      mission: 'Implement the selected change.\nRun focused tests.',
      glyph: 'hammer.fill',
      color: '#FF9F0A',
      isPinned: true
    }
    expect(createSavedAgentInput.parse({ expectedRevision: 3, draft: editable })).toEqual({
      expectedRevision: 3,
      draft: editable
    })
    expect(updateSavedAgentInput.parse({
      expectedRevision: 3,
      agentId,
      changes: editable
    })).toEqual({ expectedRevision: 3, agentId, changes: editable })
    expect(deleteSavedAgentInput.parse({ expectedRevision: 3, agentId })).toEqual({
      expectedRevision: 3,
      agentId
    })
    expect(installStarterAgentsInput.parse({ expectedRevision: 3 })).toEqual({
      expectedRevision: 3
    })
    expect(recoverSavedAgentRosterInput.parse({ expectedRevision: 0 })).toEqual({
      expectedRevision: 0
    })
    expect(bindSavedAgentInput.parse({
      expectedRevision: 3,
      sessionId: 'local-session',
      agentId: null
    })).toEqual({ expectedRevision: 3, sessionId: 'local-session', agentId: null })

    for (const forbidden of [
      { roleName: 'attacker' },
      { defaultModel: 'private-model' },
      { permissionProfile: 'workspaceWrite' },
      { browserEnabled: true },
      { computerUseEnabled: true },
      { preferredSkills: ['private-skill'] },
      { promptBody: 'exfiltrate' },
      { path: '/private/agent.md' },
      { selector: 'raw-cli-selector' }
    ]) {
      expect(() => updateSavedAgentInput.parse({
        expectedRevision: 3,
        agentId,
        changes: { ...editable, ...forbidden }
      })).toThrow()
    }
    expect(() => createSavedAgentInput.parse({
      expectedRevision: 3,
      draft: { ...editable, name: 'line\nbreak' }
    })).toThrow()
    expect(() => createSavedAgentInput.parse({
      expectedRevision: 3,
      draft: { ...editable, glyph: '../../private' }
    })).toThrow()
    expect(() => recoverSavedAgentRosterInput.parse({ expectedRevision: 1 })).toThrow()
    expect(() => bindSavedAgentInput.parse({
      expectedRevision: 3,
      sessionId: 'local-session',
      agentId,
      remoteSessionId: 'remote-id'
    })).toThrow()
    expect(savedAgentDeleteResultSchema.parse({ state: 'cancelled' })).toEqual({
      state: 'cancelled'
    })
    expect(() => savedAgentDeleteResultSchema.parse({
      state: 'deleted',
      deletedAgentPath: '/private/agents.v1.json'
    })).toThrow()
  })

  it('keeps Grok agent discovery project-only and recovery output path-free', () => {
    expect(listGrokAgentCatalogInput.parse({ projectId: 'project-1' })).toEqual({
      projectId: 'project-1'
    })
    expect(() => listGrokAgentCatalogInput.parse({
      projectId: 'project-1',
      cwd: '/private/project',
      cliPath: '/private/grok',
      selector: 'raw-agent',
      refresh: true
    })).toThrow()
    expect(savedAgentRosterRecoveryResultSchema.parse({
      state: 'recovered',
      roster: { status: 'ready', revision: 0, agents: [] }
    })).toEqual({ state: 'recovered', roster: { status: 'ready', revision: 0, agents: [] } })
    expect(() => savedAgentRosterRecoveryResultSchema.parse({
      state: 'recovered',
      roster: { status: 'ready', revision: 0, agents: [] },
      backupPath: '/private/agents.v1.json.recovered'
    })).toThrow()
  })

  it('keeps project ordering and opening on fixed main-owned boundaries', () => {
    expect(moveProjectInput.parse({ projectId: 'p1', direction: 'up' })).toEqual({
      projectId: 'p1',
      direction: 'up'
    })
    expect(openProjectInput.parse({ projectId: 'p1', target: 'vsCode' })).toEqual({
      projectId: 'p1',
      target: 'vsCode'
    })
    expect(() => moveProjectInput.parse({ projectId: 'p1', direction: 'first' })).toThrow()
    expect(() => openProjectInput.parse({ projectId: 'p1', target: 'custom-app' })).toThrow()
    expect(() => openProjectInput.parse({
      projectId: 'p1',
      target: 'finder',
      path: '/renderer/project',
      bundleId: 'attacker.bundle',
      argv: ['--arbitrary']
    })).toThrow()

    expect(projectOpenTargetStatusSchema.parse({
      target: 'cursor',
      label: 'Cursor',
      installed: true
    })).toEqual({ target: 'cursor', label: 'Cursor', installed: true })
    expect(projectOpenResultSchema.parse({ target: 'finder', opened: true })).toEqual({
      target: 'finder',
      opened: true
    })
    expect(() => projectOpenResultSchema.parse({
      target: 'finder',
      opened: true,
      path: '/main/project',
      disposition: 'open-folder'
    })).toThrow()
  })

  it('keeps dashboard Git output bounded and free of main-only diagnostics', () => {
    expect(dashboardProjectStatusSchema.parse({
      projectId: 'project-1',
      isRepository: true,
      isWorktree: false,
      branch: 'main',
      dirtyCount: 4
    })).toEqual({
      projectId: 'project-1',
      isRepository: true,
      isWorktree: false,
      branch: 'main',
      dirtyCount: 4
    })
    expect(dashboardProjectStatusSchema.parse({
      projectId: 'project-1',
      isRepository: false,
      isWorktree: false,
      dirtyCount: 0
    })).toEqual({
      projectId: 'project-1',
      isRepository: false,
      isWorktree: false,
      dirtyCount: 0
    })
    expect(() => dashboardProjectStatusSchema.parse({
      projectId: 'project-1',
      isRepository: false,
      isWorktree: true,
      branch: 'private',
      dirtyCount: 1,
      path: '/private/project',
      stderr: 'canary'
    })).toThrow()
    expect(() => dashboardProjectStatusSchema.parse({
      projectId: 'project-1',
      isRepository: true,
      isWorktree: false,
      branch: 'x'.repeat(257),
      dirtyCount: 0
    })).toThrow()
    expect(() => dashboardProjectStatusSchema.parse({
      projectId: 'project-1',
      isRepository: true,
      isWorktree: false,
      dirtyCount: 1_000_000
    })).toThrow()
  })

  it('keeps session history inputs query-or-capability only and strictly bounded', () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    expect(searchSessionHistoryInput.parse({ query: 'authentication bug' })).toEqual({
      query: 'authentication bug'
    })
    expect(openSessionHistoryInput.parse({ token })).toEqual({ token })
    expect(deleteSessionHistoryInput.parse({ token })).toEqual({ token })
    for (const query of [
      '',
      ' leading',
      'trailing ',
      '-flag',
      'line\nbreak',
      '界'.repeat(86)
    ]) {
      expect(() => searchSessionHistoryInput.parse({ query })).toThrow()
    }
    expect(() => searchSessionHistoryInput.parse({
      query: 'safe',
      cwd: '/renderer/project',
      cliPath: '/renderer/grok',
      argv: ['sessions', 'search']
    })).toThrow()
    expect(() => openSessionHistoryInput.parse({
      token,
      remoteId: '01234567-89ab-cdef-0123-456789abcdef'
    })).toThrow()
    expect(() => deleteSessionHistoryInput.parse({ token: `${token}x` })).toThrow()
  })

  it('keeps MCP IPC structured and never accepts renderer cwd or generic argv', () => {
    expect(addMcpInput.parse({
      name: 'local-server',
      scope: 'project',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp'],
      environment: [{ name: 'TOKEN', value: 'write-only-value' }]
    })).toMatchObject({ name: 'local-server', transport: 'stdio' })
    expect(() => addMcpInput.parse({
      name: 'local-server',
      scope: 'project',
      transport: 'stdio',
      command: 'npx',
      cwd: '/renderer/must/not/choose',
      argv: ['arbitrary'],
      args: [],
      environment: []
    })).toThrow()
    expect(() => removeMcpInput.parse({ name: 'local-server' })).toThrow()
  })

  it('requires an explicit literal confirmation before MCP Doctor can launch servers', () => {
    expect(() => doctorMcpInput.parse({})).toThrow()
    expect(() => doctorMcpInput.parse({ confirmExternalLaunch: false })).toThrow()
    expect(doctorMcpInput.parse({
      name: 'local-server',
      confirmExternalLaunch: true
    })).toEqual({ name: 'local-server', confirmExternalLaunch: true })
  })

  it('keeps update checks and release opening argument-free', () => {
    expect(noArgumentsInput.parse([])).toEqual([])
    expect(() => noArgumentsInput.parse(['https://attacker.example/release'])).toThrow()
    expect(() => updateOverviewSchema.parse({
      checkedAt: '2026-08-25T00:00:00.000Z',
      app: {
        state: 'update-available',
        installed: '0.1.0',
        latest: '0.2.0',
        assetAvailable: true,
        releaseUrl: 'https://private.example/release'
      },
      cli: { state: 'unavailable' }
    })).toThrow()
    expect(appUpdateInstallResultSchema.parse({ state: 'cancelled' })).toEqual({
      state: 'cancelled'
    })
    expect(appUpdateInstallResultSchema.parse({ state: 'restarting' })).toEqual({
      state: 'restarting'
    })
    expect(() => appUpdateInstallResultSchema.parse({
      state: 'restarting',
      path: '/Applications/Injected.app',
      url: 'https://attacker.example/update.zip'
    })).toThrow()
  })

  it('accepts only an opaque UUID token for Swift import commit and cancel', () => {
    const token = '11111111-1111-4111-8111-111111111111'
    expect(swiftImportTokenInput.parse({ token })).toEqual({ token })
    expect(() => swiftImportTokenInput.parse({ token, path: '/private/source.plist' })).toThrow()
    expect(() => swiftImportTokenInput.parse({ token: '/private/source.plist' })).toThrow()
  })
})
