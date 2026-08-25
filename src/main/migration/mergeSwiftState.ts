import type { ProjectSnapshot, SessionSnapshot } from '../../shared/models'
import type { PersistedState } from '../persistence/AppStateStore'
import type { SwiftStateMigrationData } from './SwiftStateMigrationService'

export interface SwiftStateMergeSummary {
  projectsAdded: number
  projectsMatchedByPath: number
  projectsSkippedForConflict: number
  sessionsAdded: number
  sessionsAlreadyPresent: number
  sessionsSkippedForConflict: number
}

export interface SwiftStateMergeResult {
  state: PersistedState
  summary: SwiftStateMergeSummary
}

/**
 * Produces a non-destructive, deterministic merge plan. Existing Electron
 * records always win; imported records only fill missing projects/sessions.
 * Reapplying the same Swift data therefore cannot duplicate or overwrite data.
 */
export function mergeSwiftState(
  current: PersistedState,
  imported: SwiftStateMigrationData
): SwiftStateMergeResult {
  const state = structuredClone(current)
  const summary: SwiftStateMergeSummary = {
    projectsAdded: 0,
    projectsMatchedByPath: 0,
    projectsSkippedForConflict: 0,
    sessionsAdded: 0,
    sessionsAlreadyPresent: 0,
    sessionsSkippedForConflict: 0
  }

  const projectIdMap = new Map<string, string>()
  const projectsById = new Map(state.projects.map((project) => [project.id, project]))
  const projectsByPath = new Map(state.projects.map((project) => [project.path, project]))

  for (const project of imported.projects) {
    const pathMatch = projectsByPath.get(project.path)
    if (pathMatch) {
      projectIdMap.set(project.id, pathMatch.id)
      summary.projectsMatchedByPath += 1
      continue
    }
    if (projectsById.has(project.id)) {
      summary.projectsSkippedForConflict += 1
      continue
    }
    const added: ProjectSnapshot = { ...structuredClone(project), sessionIds: [] }
    state.projects.push(added)
    projectsById.set(added.id, added)
    projectsByPath.set(added.path, added)
    projectIdMap.set(project.id, added.id)
    summary.projectsAdded += 1
  }

  const sessionsById = new Map(state.sessions.map((session) => [session.id, session]))
  const sessionsByAcpId = new Map(
    state.sessions.flatMap((session) => session.acpSessionId
      ? [[session.acpSessionId, session] as const]
      : [])
  )
  const importedSessionsById = new Map(imported.sessions.map((session) => [session.id, session]))
  const orderedImportedSessions = imported.projects.flatMap((project) =>
    project.sessionIds.flatMap((sessionId) => {
      const session = importedSessionsById.get(sessionId)
      return session ? [session] : []
    })
  )
  const orderedIds = new Set(orderedImportedSessions.map((session) => session.id))
  orderedImportedSessions.push(...imported.sessions.filter((session) => !orderedIds.has(session.id)))

  const importedSessionIdMap = new Map<string, string>()
  for (const session of orderedImportedSessions) {
    const targetProjectId = projectIdMap.get(session.projectId)
    if (!targetProjectId) {
      summary.sessionsSkippedForConflict += 1
      continue
    }
    const existingById = sessionsById.get(session.id)
    if (existingById) {
      if (existingById.projectId === targetProjectId) {
        importedSessionIdMap.set(session.id, existingById.id)
        summary.sessionsAlreadyPresent += 1
      } else {
        summary.sessionsSkippedForConflict += 1
      }
      continue
    }
    const existingByAcpId = session.acpSessionId
      ? sessionsByAcpId.get(session.acpSessionId)
      : undefined
    if (existingByAcpId) {
      if (existingByAcpId.projectId === targetProjectId) {
        importedSessionIdMap.set(session.id, existingByAcpId.id)
        summary.sessionsAlreadyPresent += 1
      } else {
        summary.sessionsSkippedForConflict += 1
      }
      continue
    }

    const added: SessionSnapshot = {
      ...structuredClone(session),
      projectId: targetProjectId,
      status: 'idle'
    }
    state.sessions.push(added)
    sessionsById.set(added.id, added)
    if (added.acpSessionId) sessionsByAcpId.set(added.acpSessionId, added)
    const project = projectsById.get(targetProjectId)
    if (project && !project.sessionIds.includes(added.id)) project.sessionIds.push(added.id)
    importedSessionIdMap.set(session.id, added.id)
    summary.sessionsAdded += 1
  }

  const currentSelectedSession = state.sessions.find(
    (session) => session.id === state.selectedSessionId
  )
  if (
    currentSelectedSession &&
    !state.selectedSessionIdByProject[currentSelectedSession.projectId] &&
    (currentSelectedSession.acpSessionId || currentSelectedSession.transcript.length > 0)
  ) {
    state.selectedSessionIdByProject[currentSelectedSession.projectId] = currentSelectedSession.id
  }

  for (const [importedProjectId, importedSessionId] of Object.entries(
    imported.selectedSessionIdByProject
  )) {
    const projectId = projectIdMap.get(importedProjectId)
    const sessionId = importedSessionIdMap.get(importedSessionId)
    const session = sessionId ? sessionsById.get(sessionId) : undefined
    if (
      projectId &&
      session?.projectId === projectId &&
      isDurableSession(session) &&
      !state.selectedSessionIdByProject[projectId]
    ) {
      state.selectedSessionIdByProject[projectId] = session.id
    }
  }

  const currentProjectIsValid = state.projects.some((project) => project.id === state.selectedProjectId)
  if (!currentProjectIsValid) {
    const selectedProjectId = imported.selectedProjectId
      ? projectIdMap.get(imported.selectedProjectId)
      : undefined
    if (selectedProjectId) state.selectedProjectId = selectedProjectId
    else delete state.selectedProjectId
  }

  const currentSessionIsValid = state.sessions.some((session) => session.id === state.selectedSessionId)
  if (!currentSessionIsValid) {
    const selectedSessionId = imported.selectedSessionId
      ? importedSessionIdMap.get(imported.selectedSessionId)
      : undefined
    if (selectedSessionId) {
      const selectedSession = sessionsById.get(selectedSessionId)
      if (selectedSession) {
        state.selectedSessionId = selectedSession.id
        state.selectedProjectId = selectedSession.projectId
      }
    } else {
      delete state.selectedSessionId
    }
  }

  return { state, summary }
}

function isDurableSession(session: SessionSnapshot): boolean {
  return Boolean(session.acpSessionId || session.transcript.length > 0)
}
