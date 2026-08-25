import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AppController,
  DashboardInspectionUnavailableError,
  UpdateQuiescenceUnavailableError
} from '../../src/main/AppController'
import type {
  DashboardInspectionInput,
  DashboardInspector
} from '../../src/main/git/DashboardInspector'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'
import { WorkspaceUnavailableError } from '../../src/main/workspaces/WorkspaceHealthService'
import type { DashboardProjectStatus } from '../../src/shared/dashboard'

const temporaryRoots: string[] = []
const PRIVATE_CANARY = 'dashboard-controller-private-canary-7fd30d'

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ))
})

describe('AppController selected dashboard inspection', () => {
  it('chooses the selected main-owned project and returns only its bounded projection', async () => {
    const inspected: DashboardInspectionInput[] = []
    const inspector = inspectorFrom(async (input) => {
      inspected.push(input)
      return repositoryStatus(input.projectId)
    })
    const harness = await createHarness(inspector)
    const project = harness.controller.snapshot().projects[0]!

    await expect(harness.controller.inspectDashboardGit()).resolves.toEqual({
      projectId: project.id,
      isRepository: true,
      isWorktree: false,
      branch: 'main',
      dirtyCount: 2
    })
    expect(inspected).toEqual([{
      projectId: project.id,
      canonicalProjectPath: project.path
    }])
    await harness.controller.stop()
  })

  it('rejects a stale completion after the selected project changes', async () => {
    const gate = deferred<DashboardProjectStatus>()
    const started = deferred<void>()
    const inspector = inspectorFrom(async () => {
      started.resolve()
      return await gate.promise
    })
    const harness = await createHarness(inspector)
    const firstProject = harness.controller.snapshot().projects[0]!
    const otherPath = join(harness.root, 'other-project')
    await mkdir(otherPath)
    const otherProject = await harness.controller.addProject(otherPath)
    await harness.controller.selectProject(firstProject.id)

    const pending = harness.controller.inspectDashboardGit()
    await started.promise
    await harness.controller.selectProject(otherProject.id)
    gate.resolve(repositoryStatus(firstProject.id))

    const error = await rejection(pending)
    expect(error).toBeInstanceOf(DashboardInspectionUnavailableError)
    expect(error.message).toBe(
      'The selected project changed or became unavailable. Try the dashboard inspection again.'
    )
    expect(String(error)).not.toContain(harness.projectPath)
    expect(harness.controller.snapshot().selectedProjectId).toBe(otherProject.id)
    await harness.controller.stop()
  })

  it('blocks an unhealthy workspace before Git and detects an identity swap while Git is running', async () => {
    const inspect = vi.fn(async (input: DashboardInspectionInput) => repositoryStatus(input.projectId))
    const missingHarness = await createHarness(inspectorFrom(inspect))
    await rm(missingHarness.projectPath, { recursive: true })

    const missingError = await rejection(missingHarness.controller.inspectDashboardGit())
    expect(missingError).toBeInstanceOf(WorkspaceUnavailableError)
    expect(missingError.message).toBe(
      'The workspace folder is missing. Restore it, then check again.'
    )
    expect(String(missingError)).not.toContain(missingHarness.projectPath)
    expect(inspect).not.toHaveBeenCalled()
    await missingHarness.controller.stop()

    const gate = deferred<DashboardProjectStatus>()
    const started = deferred<void>()
    const swapHarness = await createHarness(inspectorFrom(async () => {
      started.resolve()
      return await gate.promise
    }))
    const projectId = swapHarness.controller.snapshot().selectedProjectId!
    const pending = swapHarness.controller.inspectDashboardGit()
    await started.promise
    await rm(swapHarness.projectPath, { recursive: true })
    await mkdir(swapHarness.projectPath)
    gate.resolve(repositoryStatus(projectId))

    const changedError = await rejection(pending)
    expect(changedError).toBeInstanceOf(WorkspaceUnavailableError)
    expect(changedError.message).toBe(
      'The workspace location changed. Restore the original folder without an alias, then check again.'
    )
    expect(String(changedError)).not.toContain(swapHarness.projectPath)
    await swapHarness.controller.stop()
  })

  it('conflicts with update quiescence and holds the integration gate while pending', async () => {
    const called = vi.fn()
    const blockedHarness = await createHarness(inspectorFrom(async (input) => {
      called()
      return repositoryStatus(input.projectId)
    }))
    const updateLease = await blockedHarness.controller.acquireUpdateQuiescence()
    await expect(blockedHarness.controller.inspectDashboardGit())
      .rejects.toBeInstanceOf(UpdateQuiescenceUnavailableError)
    expect(called).not.toHaveBeenCalled()
    updateLease.release()
    await blockedHarness.controller.stop()

    const gate = deferred<DashboardProjectStatus>()
    const started = deferred<void>()
    const pendingHarness = await createHarness(inspectorFrom(async () => {
      started.resolve()
      return await gate.promise
    }))
    const projectId = pendingHarness.controller.snapshot().selectedProjectId!
    const inspection = pendingHarness.controller.inspectDashboardGit()
    await started.promise
    await expect(pendingHarness.controller.acquireUpdateQuiescence())
      .rejects.toBeInstanceOf(UpdateQuiescenceUnavailableError)
    gate.resolve(repositoryStatus(projectId))
    await expect(inspection).resolves.toMatchObject({ projectId })
    const after = await pendingHarness.controller.acquireUpdateQuiescence()
    after.release()
    await pendingHarness.controller.stop()
  })

  it('maps injected diagnostics and invalid result fields to one canary-free failure', async () => {
    for (const inspector of [
      inspectorFrom(async () => {
        throw new Error(`/private/${PRIVATE_CANARY} stderr diff --secret`)
      }),
      inspectorFrom(async (input) => ({
        ...repositoryStatus(input.projectId),
        privatePath: `/private/${PRIVATE_CANARY}`
      }) as DashboardProjectStatus)
    ]) {
      const harness = await createHarness(inspector)
      const error = await rejection(harness.controller.inspectDashboardGit())
      expect(error).toBeInstanceOf(DashboardInspectionUnavailableError)
      expect(JSON.stringify({ name: error.name, message: error.message }))
        .not.toContain(PRIVATE_CANARY)
      expect(String(error)).not.toContain('/private/')
      await harness.controller.stop()
    }
  })
})

function inspectorFrom(
  inspect: (input: DashboardInspectionInput) => Promise<DashboardProjectStatus>
): Pick<DashboardInspector, 'inspect'> {
  return { inspect }
}

function repositoryStatus(projectId: string): DashboardProjectStatus {
  return {
    projectId,
    isRepository: true,
    isWorktree: false,
    branch: 'main',
    dirtyCount: 2
  }
}

async function createHarness(
  dashboardInspector: Pick<DashboardInspector, 'inspect'>
): Promise<{
  root: string
  projectPath: string
  controller: AppController
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-dashboard-controller-'))
  temporaryRoots.push(root)
  const projectPath = join(root, 'project')
  await mkdir(projectPath)
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store: new AppStateStore(join(root, 'state.json'), process.execPath),
    seedProjectPath: projectPath,
    dashboardInspector
  })
  await controller.initialize()
  return { root, projectPath, controller }
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
