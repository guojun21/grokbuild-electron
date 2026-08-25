import { describe, expect, it } from 'vitest'
import { mergeSwiftState } from '../../src/main/migration/mergeSwiftState'
import { defaultState } from '../../src/main/persistence/AppStateStore'
import type { ProjectSnapshot, SessionSnapshot } from '../../src/shared/models'

const project = (id: string, path: string, sessionIds: string[] = []): ProjectSnapshot => ({
  id,
  name: id,
  path,
  sessionIds,
  createdAt: '2026-01-01T00:00:00.000Z'
})

const session = (id: string, projectId: string, acpSessionId?: string): SessionSnapshot => ({
  id,
  ...(acpSessionId ? { acpSessionId } : {}),
  projectId,
  title: id,
  status: 'idle',
  model: 'grok-4.6',
  mode: 'default',
  reasoningEffort: 'xhigh',
  permissionMode: 'ask',
  contextUsed: 0,
  contextLimit: 500_000,
  transcript: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

describe('mergeSwiftState', () => {
  it('matches projects by canonical path, preserves Electron data, and appends Swift sessions', () => {
    const current = defaultState('/mock/grok')
    current.projects = [project('electron-project', '/workspace', ['electron-session'])]
    current.sessions = [session('electron-session', 'electron-project', 'electron-remote')]
    current.selectedProjectId = 'electron-project'
    current.selectedSessionId = 'electron-session'

    const result = mergeSwiftState(current, {
      projects: [project('swift-project', '/workspace', ['swift-session'])],
      sessions: [session('swift-session', 'swift-project', 'remote-session')],
      selectedSessionIdByProject: {
        'swift-project': 'swift-session'
      },
      selectedProjectId: 'swift-project',
      selectedSessionId: 'swift-session'
    })

    expect(result.summary).toMatchObject({ projectsMatchedByPath: 1, sessionsAdded: 1 })
    expect(result.state.projects).toEqual([
      expect.objectContaining({
        id: 'electron-project',
        name: 'electron-project',
        sessionIds: ['electron-session', 'swift-session']
      })
    ])
    expect(result.state.sessions.at(-1)).toMatchObject({
      id: 'swift-session',
      projectId: 'electron-project',
      acpSessionId: 'remote-session'
    })
    expect(result.state.selectedSessionId).toBe('electron-session')
    expect(result.state.selectedSessionIdByProject).toEqual({
      'electron-project': 'electron-session'
    })
  })

  it('is idempotent and never overwrites an existing session', () => {
    const initial = defaultState('/mock/grok')
    const imported = {
      projects: [project('swift-project', '/workspace', ['swift-session'])],
      sessions: [session('swift-session', 'swift-project', 'remote-session')],
      selectedSessionIdByProject: {}
    }
    const first = mergeSwiftState(initial, imported)
    first.state.sessions[0]!.title = 'Electron-owned title'
    const second = mergeSwiftState(first.state, imported)

    expect(second.summary).toMatchObject({
      projectsAdded: 0,
      projectsMatchedByPath: 1,
      sessionsAdded: 0,
      sessionsAlreadyPresent: 1
    })
    expect(second.state.projects).toHaveLength(1)
    expect(second.state.sessions).toHaveLength(1)
    expect(second.state.sessions[0]?.title).toBe('Electron-owned title')
  })

  it('skips conflicting IDs and duplicate remote session ownership', () => {
    const current = defaultState('/mock/grok')
    current.projects = [project('collision', '/electron'), project('other', '/other', ['remote-owner'])]
    current.sessions = [session('remote-owner', 'other', 'same-remote')]
    const result = mergeSwiftState(current, {
      projects: [
        project('collision', '/swift', ['unreachable']),
        project('new-project', '/new', ['remote-duplicate'])
      ],
      sessions: [
        session('unreachable', 'collision'),
        session('remote-duplicate', 'new-project', 'same-remote')
      ],
      selectedSessionIdByProject: {}
    })

    expect(result.summary).toMatchObject({
      projectsAdded: 1,
      projectsSkippedForConflict: 1,
      sessionsAdded: 0,
      sessionsSkippedForConflict: 2
    })
    expect(result.state.sessions).toHaveLength(1)
  })

  it('adopts a valid imported selection only when the current selection is missing', () => {
    const current = defaultState('/mock/grok')
    current.selectedProjectId = 'missing'
    current.selectedSessionId = 'missing'
    const result = mergeSwiftState(current, {
      projects: [project('swift-project', '/workspace', ['swift-session'])],
      sessions: [session('swift-session', 'swift-project')],
      selectedSessionIdByProject: {},
      selectedProjectId: 'swift-project',
      selectedSessionId: 'swift-session'
    })

    expect(result.state.selectedProjectId).toBe('swift-project')
    expect(result.state.selectedSessionId).toBe('swift-session')
  })

  it('imports a durable per-workspace selection but never persists an imported blank tab', () => {
    const imported = {
      projects: [project('swift-project', '/workspace', ['durable', 'blank'])],
      sessions: [
        session('durable', 'swift-project', 'remote-session'),
        session('blank', 'swift-project')
      ],
      selectedSessionIdByProject: { 'swift-project': 'blank' }
    }
    const blankSelected = mergeSwiftState(defaultState('/mock/grok'), imported)
    expect(blankSelected.state.selectedSessionIdByProject).toEqual({})

    const durableSelected = mergeSwiftState(defaultState('/mock/grok'), {
      ...imported,
      selectedSessionIdByProject: { 'swift-project': 'durable' }
    })
    expect(durableSelected.state.selectedSessionIdByProject).toEqual({
      'swift-project': 'durable'
    })
  })
})
