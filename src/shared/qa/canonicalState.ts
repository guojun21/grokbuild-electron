import type { AppSnapshot, TranscriptItem } from '../models'

export interface CanonicalArtifact {
  path: string
  mode: string
}

export function canonicalizeSnapshot(
  snapshot: AppSnapshot,
  workspacePath: string,
  rpcTranscript: Array<{ entry: string }>,
  persistedArtifacts: CanonicalArtifact[]
): Record<string, unknown> {
  const projectIds = new Map(snapshot.projects.map((project, index) => [project.id, `$PROJECT_${index + 1}`]))
  const sessionIds = new Map(snapshot.sessions.map((session, index) => [session.id, `$TAB_${index + 1}`]))
  return {
    schemaVersion: 1,
    cli: {
      state: snapshot.cli.available ? 'ready' : 'failed',
      ...(snapshot.cli.version ? { version: snapshot.cli.version } : {})
    },
    projects: snapshot.projects.map((project) => ({
      key: projectIds.get(project.id),
      name: project.name,
      path: project.path === workspacePath ? '$WORKSPACE' : '$EXTERNAL_PATH',
      sessions: project.sessionIds.map((id) => sessionIds.get(id))
    })),
    workspaceHealth: snapshot.workspaceHealth.map((health) => ({
      project: projectIds.get(health.projectId),
      state: health.state
    })),
    sessions: snapshot.sessions.map((session) => ({
      key: sessionIds.get(session.id),
      project: projectIds.get(session.projectId),
      title: session.title,
      status: session.status,
      model: session.model,
      mode: session.mode,
      reasoningEffort: session.reasoningEffort,
      permissionMode: session.permissionMode,
      context: { used: session.contextUsed, limit: session.contextLimit },
      ...(session.lastTurnUsage ? { lastTurnUsage: session.lastTurnUsage } : {}),
      transcript: session.transcript.map(canonicalTranscriptItem),
      ...(session.pendingPermission
        ? {
            pendingPermission: {
              title: session.pendingPermission.title,
              options: session.pendingPermission.options.map((option) => ({
                label: option.label,
                ...(option.intent ? { intent: option.intent } : {})
              }))
            }
          }
        : {})
    })),
    ...(snapshot.selectedProjectId ? { selectedProject: projectIds.get(snapshot.selectedProjectId) } : {}),
    ...(snapshot.selectedSessionId ? { selectedSession: sessionIds.get(snapshot.selectedSessionId) } : {}),
    settings: {
      appearance: snapshot.settings.appearance,
      reduceMotion: snapshot.settings.reduceMotion,
      maxLiveSessions: snapshot.settings.maxLiveSessions
    },
    rpcTranscript,
    persistedArtifacts,
    menuState: {}
  }
}

export function canonicalizeRpcSequence(ndjson: string): Array<{ entry: string }> {
  const records = ndjson.split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
    direction: 'client->agent' | 'agent->client'
    frame: Record<string, unknown>
  })
  const requests = new Map<string, string>()
  const result: Array<{ entry: string }> = []
  for (const { direction, frame } of records) {
    const method = typeof frame.method === 'string' ? frame.method : undefined
    const id = typeof frame.id === 'string' || typeof frame.id === 'number' ? String(frame.id) : undefined
    if (method && id) requests.set(id, method)
    if (method) {
      const params = asRecord(frame.params)
      const update = asRecord(params.update)
      const suffix = method.endsWith('session/update') && typeof update.sessionUpdate === 'string'
        ? `:${update.sessionUpdate}`
        : ''
      result.push({ entry: `${direction} ${method}${suffix}` })
    } else if (id) {
      result.push({ entry: `${direction} response:${requests.get(id) ?? 'unknown'}` })
    }
  }
  return result
}

function canonicalTranscriptItem(item: TranscriptItem): Record<string, unknown> {
  switch (item.kind) {
    case 'message':
      return { kind: item.kind, role: item.role, text: item.text }
    case 'thought':
      return { kind: item.kind, text: item.text }
    case 'tool':
      return {
        kind: item.kind,
        title: item.title,
        status: item.status,
        ...(item.detail ? { detail: item.detail } : {})
      }
    case 'activity':
      return {
        kind: item.kind,
        entries: item.entries,
        hookCount: item.hookCount,
        isLead: item.isLead
      }
    case 'plan':
      return { kind: item.kind, entries: item.entries }
    case 'error':
    case 'notice':
      return { kind: item.kind, text: item.text }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
