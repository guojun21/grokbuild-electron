import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceHealthService } from '../../src/main/workspaces/WorkspaceHealthService'
import { defaultState } from '../../src/main/persistence/AppStateStore'
import { appSnapshotSchema } from '../../src/shared/schemas'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('WorkspaceHealthService', () => {
  it('reports ready, missing, file, and replaced-symlink states without returning paths', async () => {
    const root = await temporaryRoot()
    const ready = join(root, 'ready')
    const file = join(root, 'file')
    const alias = join(root, 'alias')
    await mkdir(ready)
    await writeFile(file, 'not a directory')
    await symlink(ready, alias)
    const results = await new WorkspaceHealthService().inspect([
      { projectId: 'ready-project', path: ready },
      { projectId: 'missing-project', path: join(root, 'missing') },
      { projectId: 'file-project', path: file },
      { projectId: 'alias-project', path: alias }
    ])

    expect(results).toEqual([
      { projectId: 'ready-project', state: 'ready' },
      { projectId: 'missing-project', state: 'missing' },
      { projectId: 'file-project', state: 'not-directory' },
      { projectId: 'alias-project', state: 'changed' }
    ])
    expect(JSON.stringify(results)).not.toContain(root)
  })

  it('fails closed for non-canonical input and bounds invalid project ids', async () => {
    const root = await temporaryRoot()
    const results = await new WorkspaceHealthService().inspect([
      { projectId: '../unsafe', path: `${root}/../${root.split('/').at(-1)}` },
      { projectId: 'relative', path: 'relative/path' }
    ])
    expect(results).toEqual([
      { projectId: 'invalid-project', state: 'changed' },
      { projectId: 'relative', state: 'changed' }
    ])
  })

  it('requires exactly one strict renderer-safe health result per snapshot project', () => {
    const project = {
      id: 'project-1',
      name: 'Workspace',
      path: '/registered/workspace',
      sessionIds: [],
      createdAt: '2026-08-25T00:00:00.000Z'
    }
    const snapshot = {
      revision: 1,
      projects: [project],
      sessions: [],
      pinnedProjectIds: [],
      pinnedSessionIds: [],
      settledSessionIds: [],
      unreadSessionIds: [],
      selectedProjectId: project.id,
      settings: defaultState('/usr/bin/true').settings,
      workspaceHealth: [{ projectId: project.id, state: 'ready' }],
      agentRoster: { status: 'ready', revision: 0, agents: [] },
      cli: { available: true, path: '/usr/bin/true' },
      appVersion: 'test'
    }

    expect(appSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(appSnapshotSchema.safeParse({ ...snapshot, workspaceHealth: [] }).success).toBe(false)
    expect(appSnapshotSchema.safeParse({
      ...snapshot,
      workspaceHealth: [...snapshot.workspaceHealth, ...snapshot.workspaceHealth]
    }).success).toBe(false)
    expect(appSnapshotSchema.safeParse({
      ...snapshot,
      workspaceHealth: [{ projectId: project.id, state: 'ready', path: project.path }]
    }).success).toBe(false)
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grokbuild-workspace-health-')))
  roots.push(root)
  return root
}
