import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppController } from '../../src/main/AppController'
import type { AcpStartResult } from '../../src/main/acp/AcpClient'
import type { AcpConnection, AcpConnectionEvents } from '../../src/main/acp/AcpConnection'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'
import {
  WorkspaceHealthService,
  type WorkspaceHealthInput,
  type WorkspaceHealthResult
} from '../../src/main/workspaces/WorkspaceHealthService'
import type { AttachmentPrompt } from '../../src/shared/attachments'
import type { SessionLifecycleEvent } from '../../src/main/notifications/SessionNotificationCoordinator'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ))
})

class HealthConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  readonly prompts: AttachmentPrompt[] = []
  startCount = 0
  stopCount = 0

  constructor(private readonly promptGate?: Promise<void>) {
    super()
  }

  start = async (): Promise<AcpStartResult> => {
    this.startCount += 1
    return { sessionId: `remote-${this.startCount}`, resumed: false }
  }

  prompt = async (prompt: AttachmentPrompt): Promise<void> => {
    this.prompts.push(structuredClone(prompt))
    await this.promptGate
  }

  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => { this.stopCount += 1 }
}

describe('AppController workspace health lifecycle', () => {
  it('quiesces an active workspace, blocks new work, detects a symlink swap, and recovers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-workspace-health-'))
    temporaryRoots.push(root)
    const projectPath = join(root, 'QA_WORKSPACE_PATH_CANARY')
    const symlinkTarget = join(root, 'replacement-target')
    const statePath = join(root, 'state.json')
    await mkdir(projectPath)
    const firstPrompt = deferred<void>()
    const connections: HealthConnection[] = []
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(statePath, process.execPath),
      seedProjectPath: projectPath,
      acpFactory: () => {
        const connection = new HealthConnection(connections.length === 0 ? firstPrompt.promise : undefined)
        connections.push(connection)
        return connection
      }
    })

    const initialized = await controller.initialize()
    const projectId = initialized.projects[0]!.id
    expect(initialized.workspaceHealth).toEqual([{ projectId, state: 'ready' }])
    const session = await controller.createSession(projectId)
    const lifecycle: SessionLifecycleEvent[] = []
    controller.on('sessionLifecycle', (event) => lifecycle.push(event))
    await controller.sendPrompt(session.id, 'Keep this saved transcript')
    await eventually(() => connections[0]?.prompts.length === 1)
    connections[0]!.emit('capabilities', {
      currentModelId: 'reported-model',
      availableModels: [{ id: 'reported-model', name: 'Reported model' }],
      currentModeId: 'default',
      availableModes: [{ id: 'default', name: 'Default' }]
    })
    connections[0]!.emit('permission', {
      rpcId: 'permission-1',
      requestId: 'permission-1',
      sessionId: 'remote-1',
      title: 'Approve?',
      options: [{ id: 'allow_once', label: 'Allow once', intent: 'allow_once' }]
    })
    connections[0]!.emit('update', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'unfinished response' }
    })
    await eventually(() => controller.snapshot().sessions[0]?.pendingPermission !== undefined)

    await rm(projectPath, { recursive: true })
    await controller.selectProject(projectId)
    const missing = controller.snapshot()
    expect(missing.workspaceHealth).toEqual([{ projectId, state: 'missing' }])
    expect(missing.sessions[0]).toMatchObject({ status: 'idle' })
    expect(missing.sessions[0]?.pendingPermission).toBeUndefined()
    expect(missing.sessions[0]).not.toHaveProperty('availableModels')
    expect(missing.sessions[0]?.transcript).toContainEqual(expect.objectContaining({
      kind: 'message', role: 'user', text: 'Keep this saved transcript'
    }))
    expect(missing.sessions[0]?.transcript.some((item) =>
      'streaming' in item && item.streaming === true
    )).toBe(false)
    expect(connections[0]?.stopCount).toBe(1)
    expect(lifecycle.some((event) => event.status === 'error')).toBe(false)

    const blocked = await rejection(controller.sendPrompt(session.id, 'must not spawn'))
    expect(blocked.message).toBe('The workspace folder is missing. Restore it, then check again.')
    expect(blocked.message).not.toContain(projectPath)
    await expect(controller.createSession(projectId)).rejects.toThrow('The workspace folder is missing.')
    await expect(controller.duplicateSession(session.id)).rejects.toThrow('The workspace folder is missing.')
    await expect(controller.prepareAttachments(session.id)).rejects.toThrow('The workspace folder is missing.')
    expect(connections).toHaveLength(1)

    await mkdir(symlinkTarget)
    await symlink(symlinkTarget, projectPath)
    await controller.selectProject(projectId)
    expect(controller.snapshot().workspaceHealth).toEqual([{ projectId, state: 'changed' }])
    expect(JSON.stringify(controller.snapshot().workspaceHealth)).not.toContain(projectPath)
    expect(connections).toHaveLength(1)

    await rm(projectPath)
    await mkdir(projectPath)
    await controller.selectProject(projectId)
    expect(controller.snapshot().workspaceHealth).toEqual([{ projectId, state: 'ready' }])
    firstPrompt.resolve()
    await controller.sendPrompt(session.id, 'Workspace restored')
    await eventually(() => connections.length === 2 && connections[1]!.prompts.length === 1)
    expect(connections[1]!.prompts).toEqual(['Workspace restored'])

    await controller.stop()
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    expect(persisted).not.toHaveProperty('workspaceHealth')
  })

  it('does not create an orphan session when its project is removed during a health check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-workspace-race-'))
    temporaryRoots.push(root)
    const projectPath = join(root, 'project')
    await mkdir(projectPath)
    const health = new DeferredWorkspaceHealthService()
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(join(root, 'state.json'), process.execPath),
      seedProjectPath: projectPath,
      workspaceHealthService: health
    })
    const snapshot = await controller.initialize()
    const projectId = snapshot.projects[0]!.id

    const check = health.deferNext()
    const creating = controller.createSession(projectId)
    await check.started
    await controller.removeProject(projectId)
    check.resolve([{ projectId, state: 'ready' }])

    await expect(creating).rejects.toThrow('Project not found')
    expect(controller.snapshot().projects).toEqual([])
    expect(controller.snapshot().sessions).toEqual([])
    expect(controller.snapshot().workspaceHealth).toEqual([])
    await controller.stop()
  })

  it('bounds quit while retry initialization is stuck and rejects a late worker result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-workspace-stop-'))
    temporaryRoots.push(root)
    const projectPath = join(root, 'project')
    await mkdir(projectPath)
    const start = deferred<AcpStartResult>()
    const connection = new DeferredStartConnection(start.promise)
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(join(root, 'state.json'), process.execPath),
      seedProjectPath: projectPath,
      acpFactory: () => connection
    })
    const initialized = await controller.initialize()
    const session = await controller.createSession(initialized.projects[0]!.id)
    const retry = controller.retrySession(session.id)
    void retry.catch(() => undefined)
    await eventually(() => connection.startCount === 1)

    const startedAt = Date.now()
    await controller.stop()
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(connection.stopCount).toBeGreaterThanOrEqual(1)

    start.resolve({ sessionId: 'late-remote-session', resumed: false })
    await expect(retry).rejects.toThrow()
    expect(controller.migrationSnapshot().sessions[0]?.acpSessionId).toBeUndefined()
    expect(connection.stopCount).toBeGreaterThanOrEqual(2)
  })
})

class DeferredWorkspaceHealthService extends WorkspaceHealthService {
  private next: ReturnType<typeof deferred<WorkspaceHealthResult[]>> | undefined
  private markStarted: (() => void) | undefined

  deferNext(): {
    started: Promise<void>
    resolve: (value: WorkspaceHealthResult[]) => void
  } {
    const next = deferred<WorkspaceHealthResult[]>()
    const started = deferred<void>()
    this.next = next
    this.markStarted = () => started.resolve()
    return { started: started.promise, resolve: next.resolve }
  }

  override async inspect(projects: readonly WorkspaceHealthInput[]): Promise<WorkspaceHealthResult[]> {
    const next = this.next
    if (!next) return projects.map((project) => ({ projectId: project.projectId, state: 'ready' }))
    this.next = undefined
    this.markStarted?.()
    this.markStarted = undefined
    return next.promise
  }
}

class DeferredStartConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  startCount = 0
  stopCount = 0

  constructor(private readonly result: Promise<AcpStartResult>) {
    super()
  }

  start = (): Promise<AcpStartResult> => {
    this.startCount += 1
    return this.result
  }
  prompt = async (): Promise<void> => undefined
  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => { this.stopCount += 1 }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('Expected promise to reject')
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condition did not become true')
}
