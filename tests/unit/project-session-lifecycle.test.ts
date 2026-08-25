import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AppController,
  MAX_PINNED_PROJECTS,
  MAX_PINNED_SESSIONS
} from '../../src/main/AppController'
import type { AcpStartResult } from '../../src/main/acp/AcpClient'
import type {
  AcpConnection,
  AcpConnectionEvents,
  AcpConnectionOptions
} from '../../src/main/acp/AcpConnection'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class TrackedConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  stopCount = 0

  constructor(
    readonly localSessionId: string,
    private readonly stopGate?: Promise<void>,
    private readonly promptGate?: Promise<void>
  ) {
    super()
  }

  start = async (): Promise<AcpStartResult> => ({
    sessionId: `remote-${this.localSessionId}`,
    resumed: false
  })
  prompt = async (): Promise<void> => { await this.promptGate }
  cancel = (): void => undefined
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (): Promise<void> => undefined
  stop = async (): Promise<void> => {
    this.stopCount += 1
    await this.stopGate
  }
}

class StartGatedConnection extends TrackedConnection {
  constructor(
    localSessionId: string,
    private readonly startGate: Promise<void>,
    private readonly markStart: () => void
  ) {
    super(localSessionId)
  }

  override start = async (): Promise<AcpStartResult> => {
    this.markStart()
    await this.startGate
    return {
      sessionId: `remote-${this.localSessionId}`,
      resumed: true
    }
  }
}

describe('project and session lifecycle parity', () => {
  it('persists Privacy Mode without reconnecting workers or rewriting domain records', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const session = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(session.id, 'keep the raw domain byte-equal')
    await eventually(() => harness.connections.has(session.id))
    await eventually(() => harness.controller.migrationSnapshot().sessions.find(
      (candidate) => candidate.id === session.id
    )?.status === 'idle')
    const connection = harness.connections.get(session.id)!
    const before = harness.controller.migrationSnapshot()
    const rawDomainBefore = JSON.stringify({
      projects: before.projects,
      sessions: before.sessions
    })
    const createdBefore = harness.createdConnections.length

    await harness.controller.updateSettings({ privacyMode: true })

    const after = harness.controller.migrationSnapshot()
    expect(after.settings.privacyMode).toBe(true)
    expect(JSON.stringify({ projects: after.projects, sessions: after.sessions }))
      .toBe(rawDomainBefore)
    expect(harness.createdConnections).toHaveLength(createdBefore)
    expect(connection.stopCount).toBe(0)

    await eventuallyPersisted(harness.statePath, (state) => state.settings?.privacyMode === true)
    const persisted = JSON.parse(await readFile(harness.statePath, 'utf8')) as {
      settings: { privacyMode: boolean }
      projects: unknown[]
      sessions: unknown[]
    }
    expect(persisted.settings.privacyMode).toBe(true)
    expect(persisted.projects).toEqual(before.projects)
    expect(persisted.sessions).toEqual(before.sessions)

    await harness.controller.stop()
    const restarted = await restartController(harness.statePath)
    expect(restarted.snapshot().settings.privacyMode).toBe(true)
    expect(restarted.migrationSnapshot().projects).toEqual(before.projects)
    await restarted.stop()
  })

  it('blocks reconnects while closing a non-selected session and leaves no dangling selection', async () => {
    const stopGate = deferred<void>()
    const harness = await createHarness(stopGate.promise)
    const project = harness.controller.snapshot().projects[0]!
    const selected = await harness.controller.createSession(project.id)
    const closing = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(selected.id, 'selected')
    await harness.controller.sendPrompt(closing.id, 'closing')
    await eventually(() => harness.connections.size === 2)
    await harness.controller.selectSession(selected.id)

    const close = harness.controller.closeSession(closing.id)
    await eventually(() => harness.connections.get(closing.id)?.stopCount === 1)
    await expect(harness.controller.selectSession(closing.id)).rejects.toThrow(
      'Wait for the current session operation'
    )
    await expect(harness.controller.sendPrompt(closing.id, 'must not reconnect')).rejects.toThrow(
      'Wait for the current session operation'
    )
    expect(() => harness.controller.updateSession({
      sessionId: closing.id, reasoningEffort: 'max'
    })).toThrow('Wait for the current session operation')
    expect(harness.createdConnections).toHaveLength(2)

    stopGate.resolve(undefined)
    await close
    const snapshot = harness.controller.snapshot()
    expect(snapshot.sessions.map((session) => session.id)).toEqual([selected.id])
    expect(snapshot.selectedSessionId).toBe(selected.id)
    expect(harness.createdConnections).toHaveLength(2)
    await harness.controller.stop()
  })

  it('blocks project work while removal waits for workers and leaves no orphan generation', async () => {
    const stopGate = deferred<void>()
    const harness = await createHarness(stopGate.promise)
    const project = harness.controller.snapshot().projects[0]!
    const session = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(session.id, 'remove me')
    await eventually(() => harness.connections.has(session.id))
    await harness.controller.addProject(harness.projectB)

    const removing = harness.controller.removeProject(project.id)
    await eventually(() => harness.connections.get(session.id)?.stopCount === 1)
    await expect(harness.controller.selectProject(project.id)).rejects.toThrow(
      'Wait for the project operation'
    )
    await expect(harness.controller.createSession(project.id)).rejects.toThrow(
      'Wait for the project operation'
    )
    await expect(harness.controller.selectSession(session.id)).rejects.toThrow()
    await expect(harness.controller.sendPrompt(session.id, 'must not reconnect')).rejects.toThrow()
    expect(harness.createdConnections).toHaveLength(1)

    stopGate.resolve(undefined)
    await removing
    const snapshot = harness.controller.snapshot()
    expect(snapshot.projects.map((item) => item.id)).not.toContain(project.id)
    expect(snapshot.sessions.map((item) => item.id)).not.toContain(session.id)
    expect(snapshot.selectedSessionId).toBeUndefined()
    expect(harness.createdConnections).toHaveLength(1)
    await harness.controller.stop()
  })

  it('persists a close before shutdown even while worker cleanup is still pending', async () => {
    const stopGate = deferred<void>()
    const harness = await createHarness(stopGate.promise)
    const project = harness.controller.snapshot().projects[0]!
    const session = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(session.id, 'close before quit')
    await eventually(() => harness.connections.has(session.id))

    const closing = harness.controller.closeSession(session.id)
    await eventually(() => harness.connections.get(session.id)?.stopCount === 1)
    let stopResolved = false
    const stopping = harness.controller.stop().then(() => { stopResolved = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopResolved).toBe(false)
    stopGate.resolve(undefined)
    await stopping
    const persisted = JSON.parse(await readFile(harness.statePath, 'utf8')) as {
      sessions: Array<{ id: string }>
      selectedSessionId?: string
    }
    expect(persisted.sessions.map((item) => item.id)).not.toContain(session.id)
    expect(persisted.selectedSessionId).not.toBe(session.id)

    await closing
    expect(harness.controller.snapshot().sessions).toEqual([])
  })

  it('persists project removal before shutdown while worker cleanup is still pending', async () => {
    const stopGate = deferred<void>()
    const harness = await createHarness(stopGate.promise)
    const project = harness.controller.snapshot().projects[0]!
    const session = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(session.id, 'remove before quit')
    await eventually(() => harness.connections.has(session.id))

    const removing = harness.controller.removeProject(project.id)
    await eventually(() => harness.connections.get(session.id)?.stopCount === 1)
    let stopResolved = false
    const stopping = harness.controller.stop().then(() => { stopResolved = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopResolved).toBe(false)
    stopGate.resolve(undefined)
    await stopping
    const persisted = JSON.parse(await readFile(harness.statePath, 'utf8')) as {
      projects: Array<{ id: string }>
      sessions: Array<{ id: string }>
    }
    expect(persisted.projects.map((item) => item.id)).not.toContain(project.id)
    expect(persisted.sessions.map((item) => item.id)).not.toContain(session.id)

    await removing
    expect(harness.controller.snapshot().projects).toEqual([])
  })

  it('restores a session when close persistence fails and restart matches the visible state', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const session = await harness.controller.createSession(project.id)
    await eventuallyPersisted(harness.statePath, (state) =>
      state.sessions.some((candidate) => candidate.id === session.id)
    )

    const originalSave = harness.store.save.bind(harness.store)
    let failNextSave = true
    harness.store.save = async (state) => {
      if (failNextSave) {
        failNextSave = false
        throw new Error('/private/QA_CLOSE_PERSIST_SECRET')
      }
      await originalSave(state)
    }

    let closeError: unknown
    try {
      await harness.controller.closeSession(session.id)
    } catch (error) {
      closeError = error
    }
    const visibleAfterFailure = harness.controller.migrationSnapshot()
    await harness.controller.stop()
    const persistedAfterStop = JSON.parse(await readFile(harness.statePath, 'utf8')) as unknown
    const restarted = await restartController(harness.statePath)
    const restoredAfterRestart = restarted.migrationSnapshot()
    await restarted.stop()

    expect(closeError).toMatchObject({ message: 'Application state could not be persisted.' })
    expect(visibleAfterFailure.sessions.map((candidate) => candidate.id)).toContain(session.id)
    expect(persistedAfterStop).toEqual(visibleAfterFailure)
    expect(restoredAfterRestart).toEqual(visibleAfterFailure)
  })

  it('restores a project when removal persistence fails and restart matches the visible state', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const session = await harness.controller.createSession(project.id)
    await eventuallyPersisted(harness.statePath, (state) =>
      state.projects.some((candidate) => candidate.id === project.id) &&
      state.sessions.some((candidate) => candidate.id === session.id)
    )

    const originalSave = harness.store.save.bind(harness.store)
    let failNextSave = true
    harness.store.save = async (state) => {
      if (failNextSave) {
        failNextSave = false
        throw new Error('/private/QA_REMOVE_PERSIST_SECRET')
      }
      await originalSave(state)
    }

    let removeError: unknown
    try {
      await harness.controller.removeProject(project.id)
    } catch (error) {
      removeError = error
    }
    const visibleAfterFailure = harness.controller.migrationSnapshot()
    await harness.controller.stop()
    const persistedAfterStop = JSON.parse(await readFile(harness.statePath, 'utf8')) as unknown
    const restarted = await restartController(harness.statePath)
    const restoredAfterRestart = restarted.migrationSnapshot()
    await restarted.stop()

    expect(removeError).toMatchObject({ message: 'Application state could not be persisted.' })
    expect(visibleAfterFailure.projects.map((candidate) => candidate.id)).toContain(project.id)
    expect(visibleAfterFailure.sessions.map((candidate) => candidate.id)).toContain(session.id)
    expect(persistedAfterStop).toEqual(visibleAfterFailure)
    expect(restoredAfterRestart).toEqual(visibleAfterFailure)
  })

  it('restores the selected durable session and per-project mapping when close persistence fails', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const durableA = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(durableA.id, 'durable A')
    const durableB = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(durableB.id, 'durable B')
    await harness.controller.selectSession(durableA.id)
    await eventuallyPersisted(harness.statePath, (state) =>
      state.selectedSessionId === durableA.id &&
      state.selectedSessionIdByProject?.[project.id] === durableA.id
    )

    const originalSave = harness.store.save.bind(harness.store)
    let failNextSave = true
    harness.store.save = async (state) => {
      if (failNextSave) {
        failNextSave = false
        throw new Error('/private/QA_SELECTED_CLOSE_SECRET')
      }
      await originalSave(state)
    }
    let closeError: unknown
    try {
      await harness.controller.closeSession(durableA.id)
    } catch (error) {
      closeError = error
    }
    const visibleAfterFailure = harness.controller.migrationSnapshot()
    await harness.controller.stop()
    const restarted = await restartController(harness.statePath)
    const restoredAfterRestart = restarted.migrationSnapshot()
    await restarted.stop()

    expect(closeError).toMatchObject({ message: 'Application state could not be persisted.' })
    expect(visibleAfterFailure.selectedSessionId).toBe(durableA.id)
    expect(visibleAfterFailure.selectedSessionIdByProject[project.id]).toBe(durableA.id)
    expect(visibleAfterFailure.sessions.map((session) => session.id)).toContain(durableB.id)
    expect(restoredAfterRestart.selectedSessionId).toBe(durableA.id)
    expect(restoredAfterRestart.selectedSessionIdByProject[project.id]).toBe(durableA.id)
  })

  it.each(['close', 'remove'] as const)(
    'preserves another session ACP update when a delayed %s save fails and rolls back',
    async (operationKind) => {
      const harness = await createHarness()
      const targetProject = harness.controller.snapshot().projects[0]!
      const targetSession = await harness.controller.createSession(targetProject.id)
      await harness.controller.sendPrompt(targetSession.id, 'target transcript')
      const otherProject = await harness.controller.addProject(harness.projectB)
      const otherSession = await harness.controller.createSession(otherProject.id)
      await harness.controller.sendPrompt(otherSession.id, 'other transcript')
      await eventuallyPersisted(harness.statePath, (state) =>
        state.sessions.some((session) => session.id === targetSession.id) &&
        state.sessions.some((session) => session.id === otherSession.id)
      )
      await new Promise((resolve) => setTimeout(resolve, 130))

      const originalSave = harness.store.save.bind(harness.store)
      const saveStarted = deferred<void>()
      const releaseSave = deferred<void>()
      let rejectTransactionWrites = true
      let saveCount = 0
      harness.store.save = async (state) => {
        saveCount += 1
        if (rejectTransactionWrites) {
          if (saveCount === 1) {
            saveStarted.resolve(undefined)
            await releaseSave.promise
          }
          throw new Error('/private/QA_DESTRUCTIVE_USAGE_SECRET')
        }
        await originalSave(state)
      }

      const operation = operationKind === 'close'
        ? harness.controller.closeSession(targetSession.id)
        : harness.controller.removeProject(targetProject.id)
      await saveStarted.promise
      harness.connections.get(otherSession.id)!.emit('update', {
        sessionUpdate: 'usage_update',
        usage: { used: 424_242, limit: 500_000 }
      })
      expect(harness.controller.migrationSnapshot().sessions.find(
        (session) => session.id === otherSession.id
      )?.contextUsed).toBe(424_242)
      releaseSave.resolve(undefined)
      let operationError: unknown
      try {
        await operation
      } catch (error) {
        operationError = error
      }
      rejectTransactionWrites = false
      const visibleAfterFailure = harness.controller.migrationSnapshot()
      await harness.controller.stop()
      const restarted = await restartController(harness.statePath)
      const restoredAfterRestart = restarted.migrationSnapshot()
      await restarted.stop()

      expect(operationError).toMatchObject({ message: 'Application state could not be persisted.' })
      expect(visibleAfterFailure.projects.map((project) => project.id)).toContain(targetProject.id)
      expect(visibleAfterFailure.sessions.map((session) => session.id)).toContain(targetSession.id)
      expect(visibleAfterFailure.sessions.find(
        (session) => session.id === otherSession.id
      )?.contextUsed).toBe(424_242)
      expect(restoredAfterRestart.projects.map((project) => project.id)).toContain(targetProject.id)
      expect(restoredAfterRestart.sessions.map((session) => session.id)).toContain(targetSession.id)
      expect(restoredAfterRestart.sessions.find(
        (session) => session.id === otherSession.id
      )?.contextUsed).toBe(424_242)
    }
  )

  it('rejects project and session pin mutations while a destructive save is pending', async () => {
    const harness = await createHarness()
    const targetProject = harness.controller.snapshot().projects[0]!
    const targetSession = await harness.controller.createSession(targetProject.id)
    const otherProject = await harness.controller.addProject(harness.projectB)
    const otherSession = await harness.controller.createSession(otherProject.id)
    await eventuallyPersisted(harness.statePath, (state) =>
      state.sessions.some((session) => session.id === targetSession.id) &&
      state.sessions.some((session) => session.id === otherSession.id)
    )
    await new Promise((resolve) => setTimeout(resolve, 130))

    const originalSave = harness.store.save.bind(harness.store)
    const saveStarted = deferred<void>()
    const releaseSave = deferred<void>()
    let delayNextSave = true
    harness.store.save = async (state) => {
      if (delayNextSave) {
        delayNextSave = false
        saveStarted.resolve(undefined)
        await releaseSave.promise
      }
      await originalSave(state)
    }
    const closing = harness.controller.closeSession(targetSession.id)
    await saveStarted.promise

    expect(() => harness.controller.setProjectPinned(otherProject.id, true)).toThrow(
      'Wait for the current save transaction'
    )
    expect(() => harness.controller.setSessionPinned(otherSession.id, true)).toThrow(
      'Wait for the current save transaction'
    )
    expect(harness.controller.snapshot().pinnedProjectIds).not.toContain(otherProject.id)
    expect(harness.controller.snapshot().pinnedSessionIds).not.toContain(otherSession.id)

    releaseSave.resolve(undefined)
    await closing
    await harness.controller.stop()
  })

  it('rejects migration immediately while an ACP connection start is unresolved', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const session = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(session.id, 'create durable session')
    await eventuallyPersisted(harness.statePath, (state) =>
      state.sessions.some((candidate) => candidate.id === session.id)
    )
    await harness.controller.stop()

    const startGate = deferred<void>()
    const startStarted = deferred<void>()
    const controller = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(harness.statePath, process.execPath),
      acpFactory: (options) => new StartGatedConnection(
        options.localSessionId,
        startGate.promise,
        () => startStarted.resolve(undefined)
      )
    })
    await controller.initialize()
    await controller.selectSession(session.id)
    await startStarted.promise
    const internal = controller as unknown as {
      connectionStarts: Map<string, unknown>
    }
    expect(internal.connectionStarts.size).toBe(1)

    let migrationSettled = false
    let migrationError: unknown
    const applying = controller.applyMigrationState(controller.migrationSnapshot()).then(
      () => { migrationSettled = true },
      (error: unknown) => {
        migrationSettled = true
        migrationError = error
      }
    )
    await Promise.resolve()
    const rejectedWithoutWaitingForStart = migrationSettled
    startGate.resolve(undefined)
    await applying
    await eventually(() => internal.connectionStarts.size === 0)
    await controller.stop()

    expect(rejectedWithoutWaitingForStart).toBe(true)
    expect(migrationError).toMatchObject({
      message: 'Wait for current session and project operations to finish before importing state.'
    })
  })

  it('serializes migration behind an existing save and stop waits for the migration transaction', async () => {
    const harness = await createHarness()
    await eventuallyPersisted(harness.statePath, (state) => state.projects.length === 1)
    const originalSave = harness.store.save.bind(harness.store)
    const firstSaveStarted = deferred<void>()
    const secondSaveStarted = deferred<void>()
    const releaseFirstSave = deferred<void>()
    const releaseSecondSave = deferred<void>()
    let saveCount = 0
    let concurrentSaves = 0
    let maxConcurrentSaves = 0
    harness.store.save = async (state) => {
      saveCount += 1
      const call = saveCount
      concurrentSaves += 1
      maxConcurrentSaves = Math.max(maxConcurrentSaves, concurrentSaves)
      try {
        if (call === 1) {
          firstSaveStarted.resolve(undefined)
          await releaseFirstSave.promise
        } else if (call === 2) {
          secondSaveStarted.resolve(undefined)
          await releaseSecondSave.promise
        }
        await originalSave(state)
      } finally {
        concurrentSaves -= 1
      }
    }

    await harness.controller.updateSettings({ appearance: 'dark' })
    await firstSaveStarted.promise
    const candidate = harness.controller.migrationSnapshot()
    candidate.projects.push({
      id: 'imported-during-quit',
      name: 'Imported during quit',
      path: harness.projectB,
      sessionIds: [],
      createdAt: '2026-08-25T00:00:00.000Z'
    })

    const settlementOrder: string[] = []
    const applying = harness.controller.applyMigrationState(candidate).then(
      () => { settlementOrder.push('migration') },
      () => { settlementOrder.push('migration') }
    )
    const stopping = harness.controller.stop().then(() => { settlementOrder.push('stop') })
    await Promise.resolve()
    expect(settlementOrder).toEqual([])

    releaseFirstSave.resolve(undefined)
    await secondSaveStarted.promise
    await new Promise((resolve) => setTimeout(resolve, 20))
    const stopWaitedForSecondSave = !settlementOrder.includes('stop')
    releaseSecondSave.resolve(undefined)
    await Promise.all([applying, stopping])
    const memoryAfterStop = harness.controller.migrationSnapshot()
    const persistedAfterStop = JSON.parse(await readFile(harness.statePath, 'utf8')) as unknown
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(maxConcurrentSaves).toBe(1)
    expect(stopWaitedForSecondSave).toBe(true)
    expect(settlementOrder).toEqual(['migration', 'stop'])
    expect(persistedAfterStop).toEqual(memoryAfterStop)
    expect(harness.controller.migrationSnapshot()).toEqual(memoryAfterStop)
  })

  it('restores each project durable selection without letting a newer blank tab overwrite it', async () => {
    const harness = await createHarness()
    const projectA = harness.controller.snapshot().projects[0]!
    const durableA = await harness.controller.createSession(projectA.id)
    await harness.controller.sendPrompt(durableA.id, 'durable A')
    await eventually(() => harness.controller.migrationSnapshot().sessions.find(
      (session) => session.id === durableA.id
    )?.status === 'idle')
    const blankA = await harness.controller.createSession(projectA.id)
    expect(harness.controller.migrationSnapshot().selectedSessionIdByProject[projectA.id])
      .toBe(durableA.id)

    const projectB = await harness.controller.addProject(harness.projectB)
    const durableB = await harness.controller.createSession(projectB.id)
    await harness.controller.sendPrompt(durableB.id, 'durable B')
    await eventually(() => harness.controller.migrationSnapshot().sessions.find(
      (session) => session.id === durableB.id
    )?.status === 'idle')

    await harness.controller.selectProject(projectA.id)
    expect(harness.controller.snapshot().selectedSessionId).toBe(durableA.id)
    await harness.controller.selectSession(blankA.id)
    expect(harness.controller.migrationSnapshot().selectedSessionIdByProject[projectA.id])
      .toBe(durableA.id)
    await harness.controller.selectProject(projectB.id)
    await harness.controller.selectProject(projectA.id)
    expect(harness.controller.snapshot().selectedSessionId).toBe(durableA.id)

    await harness.controller.closeSession(durableA.id)
    expect(harness.controller.snapshot().selectedSessionId).toBe(blankA.id)
    expect(harness.controller.migrationSnapshot().selectedSessionIdByProject)
      .not.toHaveProperty(projectA.id)
    await harness.controller.removeProject(projectA.id)
    expect(harness.controller.migrationSnapshot().selectedSessionIdByProject)
      .not.toHaveProperty(projectA.id)
    await harness.controller.stop()
  })

  it('selects projects, closes only one worker, and stops every worker removed with a project', async () => {
    const harness = await createHarness()
    const firstProject = harness.controller.snapshot().projects[0]!
    const secondProject = await harness.controller.addProject(harness.projectB)
    const firstSession = await harness.controller.createSession(firstProject.id)
    const secondSession = await harness.controller.createSession(firstProject.id)
    const otherSession = await harness.controller.createSession(secondProject.id)

    await harness.controller.sendPrompt(firstSession.id, 'first')
    await harness.controller.sendPrompt(secondSession.id, 'second')
    await harness.controller.sendPrompt(otherSession.id, 'other')
    await eventually(() => harness.connections.size === 3)

    await harness.controller.selectProject(firstProject.id)
    expect(harness.controller.snapshot().selectedProjectId).toBe(firstProject.id)
    await harness.controller.closeSession(firstSession.id)
    expect(harness.connections.get(firstSession.id)?.stopCount).toBe(1)
    expect(harness.connections.get(secondSession.id)?.stopCount).toBe(0)
    expect(harness.connections.get(otherSession.id)?.stopCount).toBe(0)

    await harness.controller.removeProject(firstProject.id)
    expect(harness.connections.get(secondSession.id)?.stopCount).toBe(1)
    expect(harness.connections.get(otherSession.id)?.stopCount).toBe(0)
    expect(harness.controller.snapshot()).toMatchObject({
      selectedProjectId: secondProject.id,
      selectedSessionId: otherSession.id
    })
    expect(harness.controller.snapshot().projects.map((project) => project.id)).toEqual([secondProject.id])
    await harness.controller.stop()
  })

  it('duplicates settings into a blank tab without ACP, transcript, or running state', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const source = await harness.controller.createSession(project.id)
    expect(source).not.toHaveProperty('availableModels')
    expect(source).not.toHaveProperty('availableModes')
    harness.controller.updateSession({
      sessionId: source.id,
      model: 'grok-composer-2.5-fast',
      mode: 'plan',
      reasoningEffort: 'max',
      permissionMode: 'auto'
    })
    await harness.controller.sendPrompt(source.id, 'Keep this local transcript')
    await eventually(() => Boolean(
      harness.controller.migrationSnapshot().sessions.find((session) => session.id === source.id)?.acpSessionId
    ))
    harness.connections.get(source.id)!.emit('capabilities', {
      currentModelId: 'grok-composer-2.5-fast',
      availableModels: [{ id: 'grok-composer-2.5-fast', name: 'Connected Composer' }],
      currentModeId: 'plan',
      availableModes: [{ id: 'plan', name: 'Connected Plan' }]
    })
    await eventually(() => Boolean(
      harness.controller.snapshot().sessions.find((session) => session.id === source.id)
        ?.availableModels?.length
    ))

    const duplicate = await harness.controller.duplicateSession(source.id)
    expect(duplicate).toMatchObject({
      title: 'New chat 1 (copy)',
      status: 'idle',
      model: 'grok-composer-2.5-fast',
      mode: 'plan',
      reasoningEffort: 'max',
      permissionMode: 'auto',
      contextUsed: 0
    })
    expect(duplicate).not.toHaveProperty('acpSessionId')
    expect(duplicate).not.toHaveProperty('pendingPermission')
    expect(duplicate).not.toHaveProperty('pendingInteraction')
    expect(duplicate).not.toHaveProperty('availableModels')
    expect(duplicate).not.toHaveProperty('availableModes')
    expect(duplicate.transcript).toEqual([])
    expect(harness.controller.snapshot().projects.find((item) => item.id === project.id)?.sessionIds)
      .toEqual([source.id, duplicate.id])
    expect(harness.controller.snapshot().selectedSessionId).toBe(duplicate.id)
    await harness.controller.stop()
  })

  it('drops persisted capability menus on restart without dropping the offline transcript', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const session = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(session.id, 'Keep this offline transcript')
    await eventually(() => harness.connections.has(session.id))
    harness.connections.get(session.id)!.emit('capabilities', {
      currentModelId: 'real-model',
      availableModels: [{ id: 'real-model', name: 'Real model' }],
      currentModeId: 'ask',
      availableModes: [{ id: 'ask', name: 'Ask only' }]
    })
    await eventually(() => Boolean(
      harness.controller.snapshot().sessions.find((item) => item.id === session.id)
        ?.availableModels?.length
    ))
    await harness.controller.stop()

    const restored = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(harness.statePath, process.execPath)
    })
    const restoredSession = (await restored.initialize()).sessions.find((item) => item.id === session.id)
    expect(restoredSession?.transcript).toContainEqual(expect.objectContaining({
      kind: 'message', role: 'user', text: 'Keep this offline transcript'
    }))
    expect(restoredSession).not.toHaveProperty('availableModels')
    expect(restoredSession).not.toHaveProperty('availableModes')
    await restored.stop()
  })

  it('enforces pin caps and persists deterministic project and global session pin order', async () => {
    const harness = await createHarness()
    const projects = [harness.controller.snapshot().projects[0]!]
    for (let index = 2; index <= MAX_PINNED_PROJECTS + 1; index += 1) {
      const path = join(harness.root, `project-${index}`)
      await mkdir(path)
      projects.push(await harness.controller.addProject(path))
    }
    for (const project of projects.slice(0, MAX_PINNED_PROJECTS)) {
      harness.controller.setProjectPinned(project.id, true)
    }
    expect(() => harness.controller.setProjectPinned(projects[MAX_PINNED_PROJECTS]!.id, true))
      .toThrow(`You can pin up to ${MAX_PINNED_PROJECTS} projects`)

    const sessionProject = projects[0]!
    const sessions = await Promise.all(Array.from({ length: MAX_PINNED_SESSIONS + 1 }, () =>
      harness.controller.createSession(sessionProject.id)
    ))
    for (const session of sessions) harness.controller.setSessionPinned(session.id, true)
    const beforeRestart = harness.controller.snapshot()
    expect(beforeRestart.pinnedSessionIds).toEqual(sessions.slice(1).map((session) => session.id))
    expect(beforeRestart.pinnedProjectIds).toEqual(
      projects.slice(0, MAX_PINNED_PROJECTS).reverse().map((project) => project.id)
    )

    await harness.controller.stop()
    const persisted = JSON.parse(await readFile(harness.statePath, 'utf8')) as Record<string, unknown>
    expect(persisted.version).toBe(5)
    const restored = new AppController({
      appVersion: 'test',
      cliPath: process.execPath,
      store: new AppStateStore(harness.statePath, process.execPath)
    })
    const afterRestart = await restored.initialize()
    expect(afterRestart.pinnedProjectIds).toEqual(beforeRestart.pinnedProjectIds)
    expect(afterRestart.pinnedSessionIds).toEqual(beforeRestart.pinnedSessionIds)
    expect(afterRestart.projects.map((project) => project.id)).toEqual(
      beforeRestart.projects.map((project) => project.id)
    )
    await restored.stop()
  })

  it('atomically applies a non-destructive v2 migration while preserving lifecycle pins', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const existing = await harness.controller.createSession(project.id)
    harness.controller.setProjectPinned(project.id, true)
    harness.controller.setSessionPinned(existing.id, true)
    const candidate = harness.controller.migrationSnapshot()
    const timestamp = '2026-08-25T00:00:00.000Z'
    candidate.projects.push({
      id: 'imported-project',
      name: 'Imported',
      path: harness.projectB,
      sessionIds: ['imported-session'],
      createdAt: timestamp
    })
    candidate.sessions.push({
      ...structuredClone(existing),
      id: 'imported-session',
      projectId: 'imported-project',
      title: 'Imported chat',
      status: 'idle',
      transcript: [],
      createdAt: timestamp,
      updatedAt: timestamp
    })
    candidate.selectedProjectId = 'imported-project'
    candidate.selectedSessionId = 'imported-session'

    await harness.controller.applyMigrationState(candidate)
    const applied = harness.controller.snapshot()
    expect(applied.projects.map((item) => item.id)).toContain('imported-project')
    expect(applied.sessions.map((item) => item.id)).toContain('imported-session')
    expect(applied.pinnedProjectIds).toEqual([project.id])
    expect(applied.pinnedSessionIds).toEqual([existing.id])
    expect(applied).toMatchObject({
      selectedProjectId: 'imported-project',
      selectedSessionId: 'imported-session'
    })
    const persisted = JSON.parse(await readFile(harness.statePath, 'utf8')) as {
      version: number
      sessions: Array<{ id: string }>
    }
    expect(persisted.version).toBe(5)
    expect(persisted.sessions.some((session) => session.id === 'imported-session')).toBe(true)

    const destructive = harness.controller.migrationSnapshot()
    destructive.sessions = destructive.sessions.filter((session) => session.id !== existing.id)
    await expect(harness.controller.applyMigrationState(destructive)).rejects.toThrow(/preserve existing/)
    await harness.controller.stop()
  })

  it('drops stale ACP updates after migration freezes workers and persists the candidate', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const session = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(session.id, 'connect worker')
    await eventually(() => harness.connections.has(session.id))
    await new Promise((resolve) => setTimeout(resolve, 160))

    const originalSave = harness.store.save.bind(harness.store)
    let releaseSave!: () => void
    let markSaveStarted!: () => void
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve })
    const saveReleased = new Promise<void>((resolve) => { releaseSave = resolve })
    let delayNextSave = true
    harness.store.save = async (state) => {
      if (delayNextSave) {
        delayNextSave = false
        markSaveStarted()
        await saveReleased
      }
      await originalSave(state)
    }

    const applying = harness.controller.applyMigrationState(harness.controller.migrationSnapshot())
    await saveStarted
    harness.connections.get(session.id)!.emit('update', {
      sessionUpdate: 'usage_update',
      usage: { used: 123_456, limit: 500_000 }
    })
    releaseSave()
    await applying

    expect(harness.controller.snapshot().sessions.find((item) => item.id === session.id)?.contextUsed)
      .toBe(0)
    const persisted = JSON.parse(await readFile(harness.statePath, 'utf8')) as {
      sessions: Array<{ id: string; contextUsed: number }>
    }
    expect(persisted.sessions.find((item) => item.id === session.id)?.contextUsed).toBe(0)
    await harness.controller.stop()
  })

  it('does not switch memory or report success when migration persistence fails', async () => {
    const harness = await createHarness()
    const before = harness.controller.migrationSnapshot()
    const candidate = structuredClone(before)
    candidate.projects.push({
      id: 'imported-project', name: 'Imported', path: harness.projectB,
      sessionIds: [], createdAt: '2026-08-25T00:00:00.000Z'
    })
    const originalSave = harness.store.save.bind(harness.store)
    harness.store.save = async () => {
      throw new Error('/private/QA_IMPORT_PERSIST_SECRET')
    }
    try {
      await expect(harness.controller.applyMigrationState(candidate)).rejects.toThrow(
        'Application state could not be persisted.'
      )
      expect(harness.controller.migrationSnapshot()).toEqual(before)
      expect(JSON.stringify(harness.controller.snapshot())).not.toContain('QA_IMPORT_PERSIST_SECRET')
    } finally {
      harness.store.save = originalSave
      await harness.controller.stop()
    }
  })

  it('rejects import while a close transaction is cleaning up its worker', async () => {
    const stopGate = deferred<void>()
    const harness = await createHarness(stopGate.promise)
    const project = harness.controller.snapshot().projects[0]!
    const session = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(session.id, 'close before import')
    await eventually(() => harness.connections.has(session.id))
    const closing = harness.controller.closeSession(session.id)
    await eventually(() => harness.connections.get(session.id)?.stopCount === 1)

    await expect(
      harness.controller.applyMigrationState(harness.controller.migrationSnapshot())
    ).rejects.toThrow('Wait for current session and project operations')
    stopGate.resolve(undefined)
    await closing
    await harness.controller.stop()
  })

  it('derives working, needs-input, and transient unread state without persisting unread', async () => {
    const promptGate = deferred<void>()
    const harness = await createHarness(undefined, promptGate.promise)
    const project = harness.controller.snapshot().projects[0]!
    const background = await harness.controller.createSession(project.id)
    const selected = await harness.controller.createSession(project.id)

    await harness.controller.sendPrompt(background.id, 'background work')
    await eventually(() => harness.connections.has(background.id))
    let presented = harness.controller.snapshot().sessions.find((item) => item.id === background.id)!
    expect(presented).toMatchObject({
      activityStatus: 'working',
      hasUnreadCompletion: false,
      pendingUserCount: 0
    })
    expect(presented.workingSince).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    harness.connections.get(background.id)!.emit('interaction', {
      kind: 'plan', interactionId: 'plan-1', sessionId: background.id
    })
    presented = harness.controller.snapshot().sessions.find((item) => item.id === background.id)!
    expect(presented).toMatchObject({ activityStatus: 'needs-input', pendingUserCount: 1 })
    expect(() => harness.controller.setSessionSettled(background.id, true)).toThrow(
      'cannot be settled'
    )

    harness.controller.cancelTurn(background.id)
    promptGate.resolve(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.controller.snapshot().unreadSessionIds).not.toContain(background.id)
    expect(harness.controller.snapshot().sessions.find((item) => item.id === background.id))
      .toMatchObject({ activityStatus: 'idle', hasUnreadCompletion: false })

    await harness.controller.sendPrompt(background.id, 'successful background work')
    await eventually(() => harness.controller.snapshot().unreadSessionIds.includes(background.id))
    expect(harness.controller.snapshot().sessions.find((item) => item.id === background.id))
      .toMatchObject({ activityStatus: 'finished-unread', hasUnreadCompletion: true })

    await harness.controller.sendPrompt(selected.id, 'selected work')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.controller.snapshot().unreadSessionIds).not.toContain(selected.id)

    await harness.controller.selectSession(background.id)
    expect(harness.controller.snapshot().unreadSessionIds).not.toContain(background.id)
    harness.controller.setSessionUnread(background.id, true)
    expect(harness.controller.snapshot().unreadSessionIds).not.toContain(background.id)
    await harness.controller.selectSession(selected.id)
    harness.controller.setSessionUnread(background.id, true)
    expect(harness.controller.snapshot().unreadSessionIds).toEqual([background.id])
    await harness.controller.stop()

    const persisted = JSON.parse(await readFile(harness.statePath, 'utf8')) as Record<string, unknown>
    expect(persisted).not.toHaveProperty('unreadSessionIds')
    const restored = await restartController(harness.statePath)
    expect(restored.snapshot().unreadSessionIds).toEqual([])
    await restored.stop()
  })

  it('marks only background idle assistant transcript growth as unread', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const background = await harness.controller.createSession(project.id)
    await harness.controller.sendPrompt(background.id, 'connect')
    await eventually(() => harness.connections.has(background.id))
    const selected = await harness.controller.createSession(project.id)
    expect(harness.controller.snapshot().selectedSessionId).toBe(selected.id)

    harness.controller.setSessionUnread(background.id, false)
    harness.connections.get(background.id)!.emit('update', {
      sessionUpdate: 'usage_update', usage: { used: 100, limit: 500_000 }
    })
    expect(harness.controller.snapshot().unreadSessionIds).not.toContain(background.id)

    harness.connections.get(background.id)!.emit('update', {
      sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'internal only' }
    })
    expect(harness.controller.snapshot().unreadSessionIds).not.toContain(background.id)
    harness.controller.cancelTurn(background.id)

    harness.connections.get(background.id)!.emit('update', {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late answer' }
    })
    expect(harness.controller.snapshot().unreadSessionIds).toContain(background.id)
    await harness.controller.stop()
  })

  it('keeps pins and settled state mutually exclusive and cleans tracking on close/remove', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const first = await harness.controller.createSession(project.id)
    const second = await harness.controller.createSession(project.id)

    harness.controller.setSessionSettled(first.id, true)
    expect(harness.controller.snapshot().settledSessionIds).toEqual([first.id])
    harness.controller.setSessionPinned(first.id, true)
    expect(harness.controller.snapshot()).toMatchObject({
      pinnedSessionIds: [first.id], settledSessionIds: []
    })
    harness.controller.setSessionSettled(first.id, true)
    expect(harness.controller.snapshot()).toMatchObject({
      pinnedSessionIds: [], settledSessionIds: [first.id]
    })

    harness.controller.setSessionSettled(second.id, true)
    harness.controller.setSessionUnread(second.id, true)
    await harness.controller.closeSession(second.id)
    expect(harness.controller.snapshot().settledSessionIds).not.toContain(second.id)
    expect(harness.controller.snapshot().unreadSessionIds).not.toContain(second.id)

    harness.controller.setSessionUnread(first.id, true)
    await harness.controller.removeProject(project.id)
    expect(harness.controller.snapshot()).toMatchObject({
      sessions: [], settledSessionIds: [], unreadSessionIds: []
    })
    await harness.controller.stop()
  })

  it('restores settled membership if destructive persistence rolls back', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!
    const session = await harness.controller.createSession(project.id)
    harness.controller.setSessionSettled(session.id, true)
    await new Promise((resolve) => setTimeout(resolve, 160))
    const originalSave = harness.store.save.bind(harness.store)
    harness.store.save = async () => { throw new Error('expected save failure') }

    await expect(harness.controller.closeSession(session.id)).rejects.toThrow(
      'Application state could not be persisted.'
    )
    expect(harness.controller.snapshot().settledSessionIds).toEqual([session.id])
    expect(harness.controller.snapshot().pinnedSessionIds).toEqual([])

    harness.store.save = originalSave
    await harness.controller.stop()
  })
})

async function createHarness(stopGate?: Promise<void>, promptGate?: Promise<void>): Promise<{
  root: string
  projectA: string
  projectB: string
  statePath: string
  controller: AppController
  store: AppStateStore
  connections: Map<string, TrackedConnection>
  createdConnections: TrackedConnection[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-project-lifecycle-'))
  temporaryRoots.push(root)
  const projectA = join(root, 'project-a')
  const projectB = join(root, 'project-b')
  const statePath = join(root, 'state.json')
  await mkdir(projectA)
  await mkdir(projectB)
  const connections = new Map<string, TrackedConnection>()
  const createdConnections: TrackedConnection[] = []
  const factory = (options: AcpConnectionOptions): TrackedConnection => {
    const connection = new TrackedConnection(options.localSessionId, stopGate, promptGate)
    connections.set(options.localSessionId, connection)
    createdConnections.push(connection)
    return connection
  }
  const store = new AppStateStore(statePath, process.execPath)
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store,
    seedProjectPath: projectA,
    acpFactory: factory
  })
  await controller.initialize()
  return { root, projectA, projectB, statePath, controller, store, connections, createdConnections }
}

async function restartController(statePath: string): Promise<AppController> {
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store: new AppStateStore(statePath, process.execPath),
    acpFactory: (options) => new TrackedConnection(options.localSessionId)
  })
  await controller.initialize()
  return controller
}

async function eventuallyPersisted(
  statePath: string,
  predicate: (state: {
    projects: Array<{ id: string }>
    sessions: Array<{ id: string }>
    selectedSessionId?: string
    selectedSessionIdByProject?: Record<string, string>
    settings?: { privacyMode?: boolean }
  }) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        projects: Array<{ id: string }>
        sessions: Array<{ id: string }>
        selectedSessionId?: string
        selectedSessionIdByProject?: Record<string, string>
        settings?: { privacyMode?: boolean }
      }
      if (predicate(state)) return
    } catch {
      // Persistence is debounced, so the file may not exist during early attempts.
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Persisted state condition did not become true')
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condition did not become true')
}
