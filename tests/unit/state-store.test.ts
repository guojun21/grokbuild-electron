import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppStateStore, defaultState } from '../../src/main/persistence/AppStateStore'
import { AppController } from '../../src/main/AppController'
import { parsePersistedState } from '../../src/shared/schemas'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('bounded persisted state', () => {
  it('round-trips a validated versioned state with restrictive file mode', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'state.json')
    const store = new AppStateStore(path, '/tmp/grok')
    const state = defaultState('/tmp/grok')
    state.settings.appearance = 'dark'

    await store.save(state)

    await expect(store.load()).resolves.toEqual(state)
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(5)
  })

  it('migrates v1 state without quarantining it as corrupt', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'state.json')
    const current = defaultState('/tmp/grok')
    const legacy = {
      version: 1,
      projects: current.projects,
      sessions: current.sessions,
      settings: legacySettings('/tmp/grok')
    }
    await writeFile(path, JSON.stringify(legacy))
    const store = new AppStateStore(path, '/tmp/grok')

    await expect(store.load()).resolves.toEqual({
      ...legacy,
      version: 5,
      pinnedProjectIds: [],
      pinnedSessionIds: [],
      settledSessionIds: [],
      selectedSessionIdByProject: {},
      settings: current.settings
    })
    expect((await readdir(directory)).some((name) => name.startsWith('state.json.corrupt-'))).toBe(false)
  })

  it('migrates v2 selections deterministically without guessing per-project history', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'state.json')
    const current = defaultState('/tmp/grok')
    const legacy = {
      version: 2,
      projects: current.projects,
      sessions: current.sessions,
      pinnedProjectIds: current.pinnedProjectIds,
      pinnedSessionIds: current.pinnedSessionIds,
      settings: legacySettings('/tmp/grok')
    }
    await writeFile(path, JSON.stringify(legacy))

    await expect(new AppStateStore(path, '/tmp/grok').load()).resolves.toEqual({
      ...current,
      selectedSessionIdByProject: {}
    })
  })

  it('migrates v3 to v5 with an empty settled list and new settings disabled', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'state.json')
    const current = defaultState('/tmp/grok')
    const legacy = {
      version: 3,
      projects: current.projects,
      sessions: current.sessions,
      pinnedProjectIds: current.pinnedProjectIds,
      pinnedSessionIds: current.pinnedSessionIds,
      selectedSessionIdByProject: current.selectedSessionIdByProject,
      settings: legacySettings('/tmp/grok')
    }
    await writeFile(path, JSON.stringify(legacy))

    await expect(new AppStateStore(path, '/tmp/grok').load()).resolves.toEqual(current)
    expect((await readdir(directory)).some((name) => name.startsWith('state.json.corrupt-'))).toBe(false)
  })

  it('migrates v4 once, serializes v5, and restarts without quarantine', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'state.json')
    const current = defaultState('/tmp/grok')
    const legacy = {
      version: 4,
      projects: current.projects,
      sessions: current.sessions,
      pinnedProjectIds: current.pinnedProjectIds,
      pinnedSessionIds: current.pinnedSessionIds,
      settledSessionIds: current.settledSessionIds,
      selectedSessionIdByProject: current.selectedSessionIdByProject,
      settings: legacySettings('/tmp/grok')
    }
    await writeFile(path, JSON.stringify(legacy))
    const store = new AppStateStore(path, '/tmp/grok')

    const migrated = await store.load()
    expect(migrated).toEqual(current)
    expect((await readdir(directory)).some((name) => name.startsWith('state.json.corrupt-'))).toBe(false)

    await store.save(migrated)
    const serialized = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(serialized).toMatchObject({
      version: 5,
      settings: {
        privacyMode: false,
        memoryEnabled: false
      }
    })
    await expect(new AppStateStore(path, '/tmp/grok').load()).resolves.toEqual(current)
  })

  it('keeps v1-v4 and v5 settings strict for missing and extra keys', () => {
    const current = defaultState('/tmp/grok')
    const legacyV4 = {
      ...current,
      version: 4,
      settings: legacySettings('/tmp/grok')
    }
    const missingLegacy = {
      ...legacyV4,
      settings: {
        appearance: 'system',
        reduceMotion: false,
        grokCliPath: '/tmp/grok'
      }
    }
    const extraLegacy = {
      ...legacyV4,
      settings: { ...legacyV4.settings, privacyMode: false }
    }
    const missingCurrent = {
      ...current,
      settings: legacySettings('/tmp/grok')
    }
    const extraCurrent = {
      ...current,
      settings: { ...current.settings, telemetryEnabled: false }
    }

    expect(() => parsePersistedState(missingLegacy)).toThrow()
    expect(() => parsePersistedState(extraLegacy)).toThrow()
    expect(() => parsePersistedState(missingCurrent)).toThrow()
    expect(() => parsePersistedState(extraCurrent)).toThrow()
  })

  it('normalizes v5 settled ids to valid unique unpinned local sessions', async () => {
    const directory = await temporaryDirectory()
    const projectPath = join(directory, 'project')
    const path = join(directory, 'state.json')
    await mkdir(projectPath)
    const timestamp = '2026-08-25T00:00:00.000Z'
    const state = defaultState('/tmp/grok')
    state.projects = [{
      id: 'project-1', name: 'Project', path: projectPath,
      sessionIds: ['pinned', 'settled'], createdAt: timestamp
    }]
    state.sessions = ['pinned', 'settled'].map((id) => ({
      id, projectId: 'project-1', title: id, status: 'idle' as const,
      model: 'grok-4.6', mode: 'default' as const, reasoningEffort: 'xhigh' as const,
      permissionMode: 'ask' as const, contextUsed: 0, contextLimit: 500_000,
      transcript: [], createdAt: timestamp, updatedAt: timestamp
    }))
    state.pinnedSessionIds = ['pinned']
    state.settledSessionIds = ['missing', 'pinned', 'settled', 'settled']
    await writeFile(path, JSON.stringify(state))

    const loaded = await new AppStateStore(path, '/tmp/grok').load()
    expect(loaded.settledSessionIds).toEqual(['settled'])
    expect(loaded.pinnedSessionIds).toEqual(['pinned'])
  })

  it('seeds a verified durable legacy selection but never seeds a blank tab', async () => {
    const directory = await temporaryDirectory()
    const timestamp = '2026-08-25T00:00:00.000Z'
    const legacyBase = {
      version: 2 as const,
      projects: [{
        id: 'project-1', name: 'Project', path: '/tmp', sessionIds: ['session-1'], createdAt: timestamp
      }],
      sessions: [{
        id: 'session-1', projectId: 'project-1', title: 'Chat', status: 'idle' as const,
        model: 'grok-4.6', mode: 'default' as const, reasoningEffort: 'xhigh' as const,
        permissionMode: 'ask' as const, contextUsed: 0, contextLimit: 500_000,
        transcript: [], createdAt: timestamp, updatedAt: timestamp
      }],
      pinnedProjectIds: [],
      pinnedSessionIds: [],
      selectedProjectId: 'project-1',
      selectedSessionId: 'session-1',
      settings: legacySettings('/tmp/grok')
    }
    const blankPath = join(directory, 'blank.json')
    await writeFile(blankPath, JSON.stringify(legacyBase))
    expect((await new AppStateStore(blankPath, '/tmp/grok').load()).selectedSessionIdByProject)
      .toEqual({})

    const durablePath = join(directory, 'durable.json')
    const durable = {
      ...legacyBase,
      sessions: [{
        ...legacyBase.sessions[0]!,
        transcript: [{
          id: 'message-1', kind: 'message', role: 'user', text: 'durable', createdAt: timestamp
        }]
      }]
    }
    await writeFile(durablePath, JSON.stringify(durable))
    expect((await new AppStateStore(durablePath, '/tmp/grok').load()).selectedSessionIdByProject)
      .toEqual({ 'project-1': 'session-1' })
  })

  it('self-heals a v3 blank workspace mapping and prefers its durable sibling', async () => {
    const directory = await temporaryDirectory()
    const firstProjectPath = join(directory, 'first')
    const secondProjectPath = join(directory, 'second')
    await mkdir(firstProjectPath)
    await mkdir(secondProjectPath)
    const timestamp = '2026-08-25T00:00:00.000Z'
    const later = '2026-08-25T01:00:00.000Z'
    const state = defaultState(process.execPath)
    state.projects = [
      {
        id: 'project-1', name: 'First', path: firstProjectPath,
        sessionIds: ['durable', 'blank'], createdAt: timestamp
      },
      {
        id: 'project-2', name: 'Second', path: secondProjectPath,
        sessionIds: [], createdAt: timestamp
      }
    ]
    state.sessions = [
      {
        id: 'durable', acpSessionId: 'remote-session', projectId: 'project-1', title: 'Durable',
        status: 'idle', model: 'grok-4.6', mode: 'default', reasoningEffort: 'xhigh',
        permissionMode: 'ask', contextUsed: 0, contextLimit: 500_000, transcript: [],
        createdAt: timestamp, updatedAt: timestamp
      },
      {
        id: 'blank', projectId: 'project-1', title: 'Blank', status: 'idle', model: 'grok-4.6',
        mode: 'default', reasoningEffort: 'xhigh', permissionMode: 'ask', contextUsed: 0,
        contextLimit: 500_000, transcript: [], createdAt: later, updatedAt: later
      }
    ]
    state.selectedProjectId = 'project-1'
    state.selectedSessionId = 'blank'
    state.selectedSessionIdByProject = { 'project-1': 'blank' }
    const store = new AppStateStore(join(directory, 'state.json'), process.execPath)
    await store.save(state)
    const controller = new AppController({
      appVersion: 'test', cliPath: process.execPath, store
    })

    await controller.initialize()
    expect(controller.migrationSnapshot().selectedSessionIdByProject).toEqual({})
    await controller.selectProject('project-2')
    await controller.selectProject('project-1')
    expect(controller.snapshot().selectedSessionId).toBe('durable')
    expect(controller.migrationSnapshot().selectedSessionIdByProject).toEqual({
      'project-1': 'durable'
    })
    await controller.stop()
  })

  it('quarantines malformed or capability-injected state', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'state.json')
    const state = { ...defaultState('/tmp/grok'), rendererCanRunShell: true }
    await writeFile(path, JSON.stringify(state))
    const store = new AppStateStore(path, '/tmp/grok')

    await expect(store.load()).resolves.toEqual(defaultState('/tmp/grok'))
    expect((await readdir(directory)).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true)
  })

  it('quarantines legacy duplicate session ids instead of routing one id across workspaces', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'state.json')
    const timestamp = '2026-08-25T00:00:00.000Z'
    const baseSession = {
      id: 'duplicate-session', title: 'Duplicate', status: 'idle' as const,
      model: 'grok-4.6', mode: 'default' as const, reasoningEffort: 'xhigh' as const,
      permissionMode: 'ask' as const, contextUsed: 0, contextLimit: 500_000,
      transcript: [], createdAt: timestamp, updatedAt: timestamp
    }
    const legacy = {
      version: 2,
      projects: [
        { id: 'project-a', name: 'A', path: '/tmp/a', sessionIds: ['duplicate-session'], createdAt: timestamp },
        { id: 'project-b', name: 'B', path: '/tmp/b', sessionIds: ['duplicate-session'], createdAt: timestamp }
      ],
      sessions: [
        { ...baseSession, projectId: 'project-a' },
        { ...baseSession, projectId: 'project-b' }
      ],
      pinnedProjectIds: [],
      pinnedSessionIds: [],
      settings: legacySettings('/tmp/grok')
    }
    await writeFile(path, JSON.stringify(legacy))
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(new AppStateStore(path, '/tmp/grok').load())
        .resolves.toEqual(defaultState('/tmp/grok'))
      expect((await readdir(directory)).some((name) => name.startsWith('state.json.corrupt-')))
        .toBe(true)
    } finally {
      logger.mockRestore()
    }
  })

  it('does not log malformed state contents, paths, or parser diagnostics', async () => {
    const canary = 'state-log-canary-4f17'
    const directory = await mkdtemp(join(tmpdir(), `grokbuild-${canary}-`))
    temporaryDirectories.push(directory)
    const path = join(directory, `${canary}.json`)
    await writeFile(path, `{ "token": "${canary}"`)
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(new AppStateStore(path, '/tmp/grok').load()).resolves.toEqual(defaultState('/tmp/grok'))
      const serializedCalls = JSON.stringify(logger.mock.calls)
      expect(serializedCalls).toContain('using safe defaults')
      expect(serializedCalls).not.toContain(canary)
      expect(serializedCalls).not.toContain(path)
      expect(serializedCalls).not.toContain('SyntaxError')
    } finally {
      logger.mockRestore()
    }
  })

  it('does not attach persistence errors or paths to main-process logs', async () => {
    const canary = 'persist-log-canary-9d31'
    const directory = await mkdtemp(join(tmpdir(), `grokbuild-${canary}-`))
    temporaryDirectories.push(directory)
    const path = join(directory, `${canary}.json`)
    const store = new AppStateStore(path, process.execPath)
    store.save = async () => {
      throw new Error(`/private/${canary} token=${canary}`)
    }
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const controller = new AppController({
        appVersion: 'test', cliPath: process.execPath, store
      })
      await controller.initialize()
      await controller.stop()
      const serializedCalls = JSON.stringify(logger.mock.calls)
      expect(serializedCalls).toContain('Failed to persist application state.')
      expect(serializedCalls).not.toContain(canary)
      expect(serializedCalls).not.toContain(path)
      expect(serializedCalls).not.toContain('Error')
    } finally {
      logger.mockRestore()
    }
  })
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'grokbuild-state-test-'))
  temporaryDirectories.push(path)
  return path
}

function legacySettings(cliPath: string): {
  appearance: 'system' | 'light' | 'dark'
  reduceMotion: boolean
  grokCliPath: string
  maxLiveSessions: number
} {
  const settings = defaultState(cliPath).settings
  return {
    appearance: settings.appearance,
    reduceMotion: settings.reduceMotion,
    grokCliPath: settings.grokCliPath,
    maxLiveSessions: settings.maxLiveSessions
  }
}
