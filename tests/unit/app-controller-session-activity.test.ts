import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AppController,
  MAX_CACHED_SESSION_ACTIVITY_PROJECTIONS
} from '../../src/main/AppController'
import type { AcpStartResult } from '../../src/main/acp/AcpClient'
import type { AcpConnection, AcpConnectionEvents } from '../../src/main/acp/AcpConnection'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'
import type { TrustedAcpUpdate } from '../../src/shared/acp/trustedUpdates'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class ActivityConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  readonly startGate = deferred<AcpStartResult>()
  stopCount = 0

  start = (): Promise<AcpStartResult> => this.startGate.promise
  prompt = async (): Promise<void> => undefined
  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => { this.stopCount += 1 }

  activity(update: TrustedAcpUpdate): void {
    this.emit('trustedUpdate', update)
  }
}

describe('AppController CLI-owned session activity', () => {
  it('isolates replay, publishes a live/offline bounded view, and never persists it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-session-activity-'))
    temporaryRoots.push(root)
    const statePath = join(root, 'state.json')
    const connection = new ActivityConnection()
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(statePath, process.execPath),
      seedProjectPath: process.cwd(),
      acpFactory: () => connection
    })
    await controller.initialize()
    const projectId = controller.snapshot().projects[0]!.id
    const sessionId = (await controller.createSession(projectId)).id

    await controller.sendPrompt(sessionId, 'show activity')
    expect(session(controller, sessionId).activities).toMatchObject({
      syncState: 'replaying',
      schedules: []
    })

    connection.activity({
      type: 'activity_schedule_upsert',
      source: 'typed',
      fired: false,
      generation: '4',
      revision: '1',
      schedule: {
        identity: 'private-remote-task-identity',
        label: 'Run focused checks',
        schedule: 'Every hour'
      }
    })
    const replaying = session(controller, sessionId).activities
    expect(replaying?.syncState).toBe('replaying')
    expect(replaying?.schedules).toEqual([expect.objectContaining({
      label: 'Run focused checks',
      schedule: 'Every hour'
    })])
    expect(JSON.stringify(replaying)).not.toContain('private-remote-task-identity')

    connection.startGate.resolve({ sessionId: 'remote-session', resumed: false })
    await eventually(() => session(controller, sessionId).activities?.syncState === 'live')
    connection.emit('exit', 1, null)
    expect(session(controller, sessionId).activities?.syncState).toBe('offline')
    expect(session(controller, sessionId).activities?.schedules).toHaveLength(1)

    await controller.stop()
    const persisted = await readFile(statePath, 'utf8')
    expect(persisted).not.toContain('activities')
    expect(persisted).not.toContain('private-remote-task-identity')
  })

  it('drops a failed replacement replay and keeps the previous view offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-session-activity-reconnect-'))
    temporaryRoots.push(root)
    const connections: ActivityConnection[] = []
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(join(root, 'state.json'), process.execPath),
      seedProjectPath: process.cwd(),
      acpFactory: () => {
        const connection = new ActivityConnection()
        connections.push(connection)
        return connection
      }
    })
    await controller.initialize()
    const projectId = controller.snapshot().projects[0]!.id
    const sessionId = (await controller.createSession(projectId)).id

    await controller.sendPrompt(sessionId, 'first connection')
    const first = connections[0]!
    first.activity(scheduleUpdate('first-task', 'First schedule'))
    first.startGate.resolve({ sessionId: 'remote-session', resumed: false })
    await eventually(() => session(controller, sessionId).activities?.syncState === 'live')
    first.emit('exit', 1, null)

    await controller.sendPrompt(sessionId, 'replacement connection')
    const replacement = connections[1]!
    replacement.activity(scheduleUpdate('discarded-task', 'Discarded replay'))
    replacement.startGate.reject(new Error('replacement failed'))
    await eventually(() => session(controller, sessionId).status === 'failed')

    const snapshot = session(controller, sessionId).activities
    expect(snapshot?.syncState).toBe('offline')
    expect(snapshot?.schedules.map((entry) => entry.label)).toEqual(['First schedule'])
    expect(JSON.stringify(snapshot)).not.toContain('Discarded replay')
    await controller.stop()
  })

  it('discards the expired session replay when ACP falls back to a fresh remote session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-session-activity-stale-'))
    temporaryRoots.push(root)
    const connection = new ActivityConnection()
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(join(root, 'state.json'), process.execPath),
      seedProjectPath: process.cwd(),
      acpFactory: () => connection
    })
    await controller.initialize()
    const projectId = controller.snapshot().projects[0]!.id
    const sessionId = (await controller.createSession(projectId)).id

    await controller.sendPrompt(sessionId, 'load expired session')
    connection.activity(scheduleUpdate('expired-task', 'Expired replay schedule'))
    expect(session(controller, sessionId).activities?.schedules).toHaveLength(1)
    connection.startGate.resolve({
      sessionId: 'fresh-remote-session',
      resumed: false,
      staleFallbackFrom: 'expired-remote-session'
    })
    await eventually(() => session(controller, sessionId).activities?.syncState === 'live')

    expect(session(controller, sessionId).activities).toMatchObject({
      syncState: 'live',
      schedules: [],
      background: [],
      workflows: [],
      goal: null
    })
    expect(JSON.stringify(controller.snapshot())).not.toContain('Expired replay schedule')
    await controller.stop()
  })

  it('protects authoritative live work from LRU eviction and releases it when deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-session-activity-lru-'))
    temporaryRoots.push(root)
    const connections: ActivityConnection[] = []
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(join(root, 'state.json'), process.execPath),
      seedProjectPath: process.cwd(),
      acpFactory: () => {
        const connection = new ActivityConnection()
        connections.push(connection)
        return connection
      }
    })
    await controller.initialize()
    const projectId = controller.snapshot().projects[0]!.id
    await controller.updateSettings({ maxLiveSessions: 1 })

    const firstSession = (await controller.createSession(projectId)).id
    await controller.sendPrompt(firstSession, 'first')
    const first = connections[0]!
    first.activity(scheduleUpdate('protected-task', 'Keep this worker'))
    first.startGate.resolve({ sessionId: 'remote-first', resumed: false })
    await eventually(() => session(controller, firstSession).activities?.syncState === 'live')

    const secondSession = (await controller.createSession(projectId)).id
    await controller.sendPrompt(secondSession, 'second')
    const second = connections[1]!
    second.startGate.resolve({ sessionId: 'remote-second', resumed: false })
    await eventually(() => session(controller, secondSession).activities?.syncState === 'live')
    expect(first.stopCount).toBe(0)

    first.activity({
      type: 'activity_schedule_delete',
      source: 'typed',
      generation: '1',
      revision: '2',
      identity: 'protected-task'
    })
    await eventually(() => first.stopCount === 1)
    expect(session(controller, firstSession).activities?.syncState).toBe('offline')
    await controller.stop()
  })

  it('bounds offline activity projections without pruning the newest session view', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-session-activity-cache-'))
    temporaryRoots.push(root)
    const connections: ActivityConnection[] = []
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(join(root, 'state.json'), process.execPath),
      seedProjectPath: process.cwd(),
      acpFactory: () => {
        const connection = new ActivityConnection()
        connections.push(connection)
        return connection
      }
    })
    await controller.initialize()
    const projectId = controller.snapshot().projects[0]!.id
    const sessionIds: string[] = []

    for (let index = 0; index <= MAX_CACHED_SESSION_ACTIVITY_PROJECTIONS; index += 1) {
      const sessionId = (await controller.createSession(projectId)).id
      sessionIds.push(sessionId)
      await controller.sendPrompt(sessionId, `cache ${index}`)
      const connection = connections[index]!
      connection.startGate.resolve({ sessionId: `remote-${index}`, resumed: false })
      await eventually(() => session(controller, sessionId).activities?.syncState === 'live')
      connection.emit('exit', 0, null)
      expect(session(controller, sessionId).activities?.syncState).toBe('offline')
    }

    const withActivities = controller.snapshot().sessions.filter((candidate) => candidate.activities)
    expect(withActivities).toHaveLength(MAX_CACHED_SESSION_ACTIVITY_PROJECTIONS)
    expect(session(controller, sessionIds[0]!).activities).toBeUndefined()
    expect(session(controller, sessionIds.at(-1)!).activities?.syncState).toBe('offline')
    await controller.stop()
  })
})

function scheduleUpdate(identity: string, label: string): TrustedAcpUpdate {
  return {
    type: 'activity_schedule_upsert',
    source: 'typed',
    fired: false,
    generation: '1',
    revision: '1',
    schedule: { identity, label }
  }
}

function session(controller: AppController, sessionId: string) {
  return controller.snapshot().sessions.find((candidate) => candidate.id === sessionId)!
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condition did not become true')
}
