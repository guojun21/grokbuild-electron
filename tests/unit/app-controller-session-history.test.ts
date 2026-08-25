import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AppController,
  SessionHistoryUnavailableError,
  UpdateQuiescenceUnavailableError
} from '../../src/main/AppController'
import type { AcpConnection, AcpConnectionOptions } from '../../src/main/acp/AcpConnection'
import type { AcpStartResult } from '../../src/main/acp/AcpClient'
import { SessionHistoryBroker } from '../../src/main/history/SessionHistoryBroker'
import type { GrokCliSessionHistoryRecord } from '../../src/main/grok/GrokCliService'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'
import type { AttachmentPrompt } from '../../src/shared/attachments'
import type { InteractionAnswer } from '../../src/shared/acp/interactions'

const REMOTE_ID = '01234567-89ab-cdef-0123-456789abcdef'
const CANARY = 'history-controller-private-canary-9d6311'
const temporaryRoots: string[] = []

class HistoryCliService {
  records: GrokCliSessionHistoryRecord[] = [{
    remoteId: REMOTE_ID,
    summary: 'Restore the auth flow',
    status: 'local',
    created: '2026-08-20',
    updated: '2026-08-25'
  }]
  listImpl: (() => Promise<GrokCliSessionHistoryRecord[]>) | undefined
  deleteImpl: (() => Promise<void>) | undefined
  readonly listCalls: string[] = []
  readonly searchCalls: Array<{ cwd: string; query: string }> = []
  readonly deleteCalls: Array<{ cwd: string; remoteId: string }> = []

  async listSessions(cwd: string): Promise<GrokCliSessionHistoryRecord[]> {
    this.listCalls.push(cwd)
    return this.listImpl ? await this.listImpl() : this.records
  }

  async searchSessions(cwd: string, query: string): Promise<GrokCliSessionHistoryRecord[]> {
    this.searchCalls.push({ cwd, query })
    return this.records
  }

  async deleteSession(cwd: string, remoteId: string): Promise<void> {
    this.deleteCalls.push({ cwd, remoteId })
    if (this.deleteImpl) await this.deleteImpl()
  }
}

class HistoryConnection extends EventEmitter implements AcpConnection {
  constructor(
    readonly options: AcpConnectionOptions,
    private readonly startImpl: (options: AcpConnectionOptions) => Promise<AcpStartResult>
  ) {
    super()
  }

  start(): Promise<AcpStartResult> { return this.startImpl(this.options) }
  async prompt(_prompt: AttachmentPrompt): Promise<void> {}
  cancel(): void {}
  async setModel(_model: string): Promise<void> {}
  async setMode(_mode: string): Promise<void> {}
  async answerPermission(_requestId: string, _optionId: string): Promise<void> {}
  async answerInteraction(_interactionId: string, _answer: InteractionAnswer): Promise<void> {}
  async stop(): Promise<void> {}
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
})

describe('AppController session history runtime', () => {
  it('derives list/search context in main and returns opaque records only', async () => {
    const harness = await createHarness()
    const project = harness.controller.snapshot().projects[0]!

    const listed = await harness.controller.listSessionHistory()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      projectId: project.id,
      summary: 'Restore the auth flow',
      status: 'local'
    })
    expect(listed[0]!.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(harness.service.listCalls).toEqual([project.path])

    const searched = await harness.controller.searchSessionHistory('auth flow')
    expect(searched).toHaveLength(1)
    expect(harness.service.searchCalls).toEqual([{ cwd: project.path, query: 'auth flow' }])
    const wire = JSON.stringify({ listed, searched })
    expect(wire).not.toContain(REMOTE_ID)
    expect(wire).not.toContain(project.path)
    expect(wire).not.toContain(process.execPath)
    await harness.controller.stop()
  })

  it('loads one strict restored tab, then selects it instead of duplicating the remote session', async () => {
    const harness = await createHarness()
    await harness.controller.updateSettings({ memoryEnabled: true })
    const [history] = await harness.controller.listSessionHistory()
    const opened = await harness.controller.openSessionHistory(history!.token)

    expect(opened.title).toBe('Restore the auth flow')
    expect(opened).not.toHaveProperty('acpSessionId')
    expect(harness.connections).toHaveLength(1)
    expect(harness.connections[0]!.options).toMatchObject({
      cliPath: process.execPath,
      cwd: harness.projectPath,
      memoryEnabled: true,
      resumeSessionId: REMOTE_ID,
      allowStaleFallback: false
    })

    const other = await harness.controller.createSession(opened.projectId)
    expect(harness.controller.snapshot().selectedSessionId).toBe(other.id)
    const reopened = await harness.controller.openSessionHistory(history!.token)
    expect(reopened.id).toBe(opened.id)
    expect(harness.controller.snapshot().selectedSessionId).toBe(opened.id)
    expect(harness.connections).toHaveLength(1)
    expect(harness.controller.snapshot().sessions.filter((session) => session.title === opened.title))
      .toHaveLength(1)
    await harness.controller.stop()
  })

  it('reconnects an evicted local history tab only after releasing the history write barrier', async () => {
    const harness = await createHarness()
    const [history] = await harness.controller.listSessionHistory()
    const opened = await harness.controller.openSessionHistory(history!.token)
    await harness.controller.updateSettings({ maxLiveSessions: 1 })
    const other = await harness.controller.createSession(opened.projectId)
    await harness.controller.sendPrompt(other.id, 'evict the restored worker')
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.connections).toHaveLength(2)

    const reopened = await harness.controller.openSessionHistory(history!.token)
    expect(reopened.id).toBe(opened.id)
    expect(harness.connections).toHaveLength(3)
    expect(harness.connections[2]!.options).toMatchObject({
      resumeSessionId: REMOTE_ID,
      cwd: harness.projectPath
    })
    expect(harness.controller.snapshot().sessions.filter((session) => session.id === opened.id))
      .toHaveLength(1)
    await harness.controller.stop()
  })

  it('rolls back when strict ACP load cannot resume and never accepts a stale fallback', async () => {
    const harness = await createHarness(async (options) => ({
      sessionId: 'fedcba98-7654-3210-fedc-ba9876543210',
      resumed: false,
      staleFallbackFrom: options.resumeSessionId
    }))
    const before = harness.controller.snapshot()
    const [history] = await harness.controller.listSessionHistory()

    await expect(harness.controller.openSessionHistory(history!.token))
      .rejects.toBeInstanceOf(SessionHistoryUnavailableError)
    const after = harness.controller.snapshot()
    expect(after.sessions.map(({ id }) => id)).toEqual(before.sessions.map(({ id }) => id))
    expect(after.selectedSessionId).toBe(before.selectedSessionId)
    expect(harness.connections[0]!.options.allowStaleFallback).toBe(false)
    await harness.controller.stop()
  })

  it('native-confirmation flow cancels without consuming and deletes once after revalidation', async () => {
    const harness = await createHarness()
    const [history] = await harness.controller.listSessionHistory()
    const confirmations: string[] = []

    await expect(harness.controller.deleteSessionHistory(history!.token, async (summary) => {
      confirmations.push(summary)
      return false
    })).resolves.toEqual({ state: 'cancelled' })
    expect(harness.service.deleteCalls).toEqual([])

    await expect(harness.controller.deleteSessionHistory(history!.token, async (summary) => {
      confirmations.push(summary)
      return true
    })).resolves.toEqual({ state: 'deleted' })
    expect(confirmations).toEqual(['Restore the auth flow', 'Restore the auth flow'])
    expect(harness.service.deleteCalls).toEqual([{ cwd: harness.projectPath, remoteId: REMOTE_ID }])
    await expect(harness.controller.deleteSessionHistory(history!.token, async () => true))
      .rejects.toMatchObject({ code: 'invalid-token' })
    await harness.controller.stop()
  })

  it('refuses deletion whenever a local tab is bound to the remote session', async () => {
    const harness = await createHarness()
    const [history] = await harness.controller.listSessionHistory()
    await harness.controller.openSessionHistory(history!.token)
    const [fresh] = await harness.controller.listSessionHistory()
    const confirm = vi.fn(async () => true)

    await expect(harness.controller.deleteSessionHistory(fresh!.token, confirm))
      .rejects.toMatchObject({ code: 'delete-protected' })
    expect(confirm).not.toHaveBeenCalled()
    expect(harness.service.deleteCalls).toEqual([])
    await harness.controller.stop()
  })

  it('fails closed on stale list context and blocks state mutation throughout confirmation', async () => {
    const listGate = deferred<GrokCliSessionHistoryRecord[]>()
    const listStarted = deferred<void>()
    const harness = await createHarness()
    harness.service.listImpl = async () => {
      listStarted.resolve()
      return await listGate.promise
    }
    const pendingList = harness.controller.listSessionHistory()
    await listStarted.promise
    await harness.controller.createSession(harness.controller.snapshot().selectedProjectId!)
    listGate.resolve(harness.service.records)
    await expect(pendingList).rejects.toBeInstanceOf(SessionHistoryUnavailableError)

    harness.service.listImpl = undefined
    const [history] = await harness.controller.listSessionHistory()
    const confirmStarted = deferred<void>()
    const confirmGate = deferred<boolean>()
    const deletion = harness.controller.deleteSessionHistory(history!.token, async () => {
      confirmStarted.resolve()
      return await confirmGate.promise
    })
    await confirmStarted.promise
    await expect(harness.controller.createSession(
      harness.controller.snapshot().selectedProjectId!
    )).rejects.toBeInstanceOf(SessionHistoryUnavailableError)
    await expect(harness.controller.selectProject(
      harness.controller.snapshot().selectedProjectId!
    )).rejects.toBeInstanceOf(SessionHistoryUnavailableError)
    await expect(harness.controller.setGrokCliPath(process.execPath))
      .rejects.toBeInstanceOf(SessionHistoryUnavailableError)
    await expect(harness.controller.applyMigrationState(harness.controller.migrationSnapshot()))
      .rejects.toBeInstanceOf(SessionHistoryUnavailableError)
    confirmGate.resolve(true)
    await expect(deletion).resolves.toEqual({ state: 'deleted' })
    expect(harness.service.deleteCalls).toEqual([{ cwd: harness.projectPath, remoteId: REMOTE_ID }])

    const updateLease = await harness.controller.acquireUpdateQuiescence()
    await expect(harness.controller.listSessionHistory())
      .rejects.toBeInstanceOf(UpdateQuiescenceUnavailableError)
    updateLease.release()
    await harness.controller.stop()
  })

  it('keeps stop pending until an already-started destructive History CLI operation settles', async () => {
    const harness = await createHarness()
    const [history] = await harness.controller.listSessionHistory()
    const deleteStarted = deferred<void>()
    const deleteGate = deferred<void>()
    harness.service.deleteImpl = async () => {
      deleteStarted.resolve()
      await deleteGate.promise
    }

    const deletion = harness.controller.deleteSessionHistory(history!.token, async () => true)
    const deletionResult = deletion.then(
      () => ({ error: undefined as unknown }),
      (error: unknown) => ({ error })
    )
    await deleteStarted.promise
    let stopped = false
    const stopping = harness.controller.stop().then(() => { stopped = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)

    deleteGate.resolve()
    await stopping
    expect((await deletionResult).error).toBeInstanceOf(SessionHistoryUnavailableError)
    expect(stopped).toBe(true)
    expect(harness.service.deleteCalls).toEqual([{ cwd: harness.projectPath, remoteId: REMOTE_ID }])
  })

  it('invalidates tokens on project and CLI changes and redacts injected diagnostics', async () => {
    const harness = await createHarness()
    const [projectToken] = await harness.controller.listSessionHistory()
    const otherPath = join(harness.root, 'other-project')
    await mkdir(otherPath)
    await harness.controller.addProject(otherPath)
    await expect(harness.controller.openSessionHistory(projectToken!.token))
      .rejects.toMatchObject({ code: 'invalid-token' })

    await harness.controller.selectProject(harness.controller.snapshot().projects
      .find((project) => project.path === harness.projectPath)!.id)
    const [cliToken] = await harness.controller.listSessionHistory()
    const otherCli = join(harness.root, 'other-grok')
    await writeFile(otherCli, '#!/bin/sh\nexit 0\n')
    await chmod(otherCli, 0o700)
    await harness.controller.setGrokCliPath(otherCli)
    await expect(harness.controller.openSessionHistory(cliToken!.token))
      .rejects.toMatchObject({ code: 'invalid-token' })

    harness.service.listImpl = async () => {
      throw new Error(`${CANARY} ${harness.projectPath} ${REMOTE_ID} --secret`)
    }
    const error = await rejection(harness.controller.listSessionHistory())
    expect(String(error)).not.toContain(CANARY)
    expect(String(error)).not.toContain(harness.projectPath)
    expect(String(error)).not.toContain(REMOTE_ID)
    await harness.controller.stop()
  })
})

async function createHarness(
  startImpl: (options: AcpConnectionOptions) => Promise<AcpStartResult> = async (options) => ({
    sessionId: options.resumeSessionId!,
    resumed: true
  })
): Promise<{
  root: string
  projectPath: string
  controller: AppController
  service: HistoryCliService
  connections: HistoryConnection[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-history-runtime-'))
  temporaryRoots.push(root)
  const projectPathInput = join(root, 'project')
  await mkdir(projectPathInput)
  const projectPath = await realpath(projectPathInput)
  const service = new HistoryCliService()
  const connections: HistoryConnection[] = []
  let tokenIndex = 0
  const broker = new SessionHistoryBroker({
    serviceProvider: () => service,
    tokenFactory: () => Buffer.alloc(32, (tokenIndex += 1) % 256).toString('base64url')
  })
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store: new AppStateStore(join(root, 'state.json'), process.execPath),
    seedProjectPath: projectPath,
    sessionHistoryBroker: broker,
    acpFactory: (options) => {
      const connection = new HistoryConnection(options, startImpl)
      connections.push(connection)
      return connection
    }
  })
  await controller.initialize()
  return { root, projectPath, controller, service, connections }
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
