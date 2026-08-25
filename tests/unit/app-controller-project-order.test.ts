import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppController } from '../../src/main/AppController'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'

const controllers: AppController[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.allSettled(controllers.splice(0).map((controller) => controller.stop()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AppController project ordering', () => {
  it('moves within pinned and ordinary groups and publishes only real moves', async () => {
    const harness = await createHarness()
    const first = harness.controller.snapshot().projects[0]!
    const second = await harness.addProject('second')
    const third = await harness.addProject('third')

    expect(projectIds(harness.controller)).toEqual([third.id, second.id, first.id])
    const beforeMove = harness.controller.snapshot().revision
    harness.controller.moveProject(second.id, 'up')
    expect(projectIds(harness.controller)).toEqual([second.id, third.id, first.id])
    expect(harness.controller.snapshot().revision).toBe(beforeMove + 1)

    const atBoundary = harness.controller.snapshot().revision
    harness.controller.moveProject(second.id, 'up')
    expect(projectIds(harness.controller)).toEqual([second.id, third.id, first.id])
    expect(harness.controller.snapshot().revision).toBe(atBoundary)

    harness.controller.setProjectPinned(first.id, true)
    harness.controller.setProjectPinned(second.id, true)
    expect(projectIds(harness.controller)).toEqual([second.id, first.id, third.id])
    harness.controller.moveProject(first.id, 'up')
    expect(projectIds(harness.controller)).toEqual([first.id, second.id, third.id])

    const pinnedBoundary = harness.controller.snapshot().revision
    harness.controller.moveProject(first.id, 'up')
    expect(harness.controller.snapshot().revision).toBe(pinnedBoundary)
  })

  it('selects an existing canonical path without silently reordering it', async () => {
    const harness = await createHarness()
    const first = harness.controller.snapshot().projects[0]!
    const second = await harness.addProject('second')
    const third = await harness.addProject('third')
    const before = projectIds(harness.controller)

    const selected = await harness.controller.addProject(harness.projectPaths.second!)

    expect(selected.id).toBe(second.id)
    expect(projectIds(harness.controller)).toEqual(before)
    expect(harness.controller.snapshot()).toMatchObject({ selectedProjectId: second.id })
    expect(projectIds(harness.controller)).toEqual([third.id, second.id, first.id])
  })

  it('rejects moves while an import or project-removal transaction owns state', async () => {
    const harness = await createHarness()
    const first = harness.controller.snapshot().projects[0]!
    const second = await harness.addProject('second')

    const importing = harness.controller.applyMigrationState(
      harness.controller.migrationSnapshot()
    )
    expect(() => harness.controller.moveProject(first.id, 'down')).toThrow(
      'Wait for state import to finish'
    )
    await importing

    const removing = harness.controller.removeProject(first.id)
    expect(() => harness.controller.moveProject(first.id, 'down')).toThrow(
      'Wait for the project operation to finish'
    )
    await removing
    expect(projectIds(harness.controller)).toEqual([second.id])
  })
})

async function createHarness(): Promise<{
  controller: AppController
  addProject: (name: string) => ReturnType<AppController['addProject']>
  projectPaths: Record<string, string>
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-project-order-'))
  roots.push(root)
  const projectPaths: Record<string, string> = {}
  const firstPath = join(root, 'first')
  await mkdir(firstPath)
  projectPaths.first = firstPath
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store: new AppStateStore(join(root, 'state.json'), process.execPath),
    seedProjectPath: firstPath
  })
  controllers.push(controller)
  await controller.initialize()
  return {
    controller,
    projectPaths,
    addProject: async (name: string) => {
      const path = join(root, name)
      await mkdir(path)
      projectPaths[name] = path
      return controller.addProject(path)
    }
  }
}

function projectIds(controller: AppController): string[] {
  return controller.snapshot().projects.map((project) => project.id)
}
