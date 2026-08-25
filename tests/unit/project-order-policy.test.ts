import { describe, expect, it } from 'vitest'
import {
  MAX_PROJECT_ORDER_ENTRIES,
  ProjectOrderPolicy,
  ProjectOrderPolicyError,
  type ProjectOrderRecord
} from '../../src/main/workspaces/ProjectOrderPolicy'

interface Project extends ProjectOrderRecord {
  name: string
}

function projects(...ids: string[]): Project[] {
  return ids.map((id) => ({ id, name: `Project ${id}` }))
}

function ids(values: readonly Project[]): string[] {
  return values.map((value) => value.id)
}

describe('ProjectOrderPolicy', () => {
  it('moves pinned and ordinary projects only inside their original groups', () => {
    const state = {
      projects: projects('u1', 'p1', 'u2', 'p2'),
      pinnedProjectIds: ['p1', 'p2']
    }

    const pinned = ProjectOrderPolicy.move(state, 'p2', 'up')
    expect(pinned.outcome).toBe('moved')
    expect(pinned.pinnedProjectIds).toEqual(['p2', 'p1'])
    expect(ids(pinned.projects)).toEqual(['u1', 'p1', 'u2', 'p2'])
    expect(ids(ProjectOrderPolicy.orderedProjects(pinned))).toEqual(['p2', 'p1', 'u1', 'u2'])

    const ordinary = ProjectOrderPolicy.move(state, 'u2', 'up')
    expect(ordinary.outcome).toBe('moved')
    expect(ordinary.pinnedProjectIds).toEqual(['p1', 'p2'])
    expect(ids(ProjectOrderPolicy.orderedProjects(ordinary))).toEqual(['p1', 'p2', 'u2', 'u1'])
  })

  it('makes group-boundary and unknown moves explicit normalized no-ops', () => {
    const state = {
      projects: projects('p1', 'p2', 'u1', 'u2'),
      pinnedProjectIds: ['p1', 'p2']
    }

    expect(ProjectOrderPolicy.move(state, 'p1', 'up')).toMatchObject({
      outcome: 'at-group-boundary',
      pinnedProjectIds: ['p1', 'p2']
    })
    expect(ProjectOrderPolicy.move(state, 'p2', 'down')).toMatchObject({
      outcome: 'at-group-boundary',
      pinnedProjectIds: ['p1', 'p2']
    })
    expect(ProjectOrderPolicy.move(state, 'u1', 'up').outcome).toBe('at-group-boundary')
    expect(ProjectOrderPolicy.move(state, 'u2', 'down').outcome).toBe('at-group-boundary')
    expect(ProjectOrderPolicy.move(state, 'missing', 'up').outcome).toBe('unknown-project')

    expect(ids(ProjectOrderPolicy.orderedProjects(state))).toEqual(['p1', 'p2', 'u1', 'u2'])
  })

  it('keeps the other group stable when pin membership changes outside the policy', () => {
    const base = projects('a', 'b', 'c', 'd')

    expect(ids(ProjectOrderPolicy.orderedProjects({
      projects: base,
      pinnedProjectIds: ['c', 'b']
    }))).toEqual(['c', 'b', 'a', 'd'])
    expect(ids(ProjectOrderPolicy.orderedProjects({
      projects: base,
      pinnedProjectIds: ['b']
    }))).toEqual(['b', 'a', 'c', 'd'])
    expect(ids(ProjectOrderPolicy.orderedProjects({
      projects: base,
      pinnedProjectIds: []
    }))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('drops dangling pins after removal and deterministically keeps first duplicates', () => {
    const firstA = { id: 'a', name: 'first a' }
    const duplicateA = { id: 'a', name: 'duplicate a' }
    const normalized = ProjectOrderPolicy.normalize({
      projects: [firstA, duplicateA, ...projects('b', 'c')],
      pinnedProjectIds: ['missing', 'b', 'b', 'a']
    })

    expect(normalized.projects).toEqual([firstA, { id: 'b', name: 'Project b' }, { id: 'c', name: 'Project c' }])
    expect(normalized.projects[0]).toBe(firstA)
    expect(normalized.projects).not.toContain(duplicateA)
    expect(normalized.pinnedProjectIds).toEqual(['b', 'a'])

    const afterRemoval = ProjectOrderPolicy.normalize({
      projects: normalized.projects.filter((project) => project.id !== 'b'),
      pinnedProjectIds: normalized.pinnedProjectIds
    })
    expect(ids(afterRemoval.projects)).toEqual(['a', 'c'])
    expect(afterRemoval.pinnedProjectIds).toEqual(['a'])
  })

  it('does not mutate caller arrays or project objects and is deterministic', () => {
    const originalProjects = projects('a', 'p', 'b')
    const originalPins = ['p']
    const beforeProjects = [...originalProjects]
    const beforePins = [...originalPins]

    const first = ProjectOrderPolicy.move({
      projects: originalProjects,
      pinnedProjectIds: originalPins
    }, 'b', 'up')
    const second = ProjectOrderPolicy.move({
      projects: originalProjects,
      pinnedProjectIds: originalPins
    }, 'b', 'up')

    expect(first).toEqual(second)
    expect(first.projects).not.toBe(originalProjects)
    expect(first.pinnedProjectIds).not.toBe(originalPins)
    expect(first.projects[0]).toBe(originalProjects[2])
    expect(originalProjects).toEqual(beforeProjects)
    expect(originalPins).toEqual(beforePins)
  })

  it('handles hostile identifiers without prototype-key behavior or raw error disclosure', () => {
    const hostileIds = ['__proto__', 'constructor', 'toString']
    const state = {
      projects: projects(...hostileIds),
      pinnedProjectIds: ['constructor']
    }
    const result = ProjectOrderPolicy.move(state, 'toString', 'up')

    expect(result.outcome).toBe('moved')
    expect(ids(ProjectOrderPolicy.orderedProjects(result))).toEqual([
      'constructor',
      'toString',
      '__proto__'
    ])

    const canary = `QA_PROJECT_ORDER_SECRET_${'x'.repeat(300)}`
    const invalid = ProjectOrderPolicy.move(state, canary, 'up')
    expect(invalid.outcome).toBe('invalid-project-id')
    expect(JSON.stringify(invalid)).not.toContain(canary)
    expect(() => ProjectOrderPolicy.move(state, 'toString', 'sideways' as 'up')).toThrowError(
      new ProjectOrderPolicyError('invalid-direction')
    )
  })

  it('rejects oversized arrays before iterating them with a fixed error', () => {
    const oversized = new Array<Project>(MAX_PROJECT_ORDER_ENTRIES + 1)
    const canary = 'QA_OVERSIZED_PROJECT_ORDER_SECRET'
    oversized[MAX_PROJECT_ORDER_ENTRIES] = { id: canary, name: canary }

    try {
      ProjectOrderPolicy.normalize({ projects: oversized, pinnedProjectIds: [] })
      throw new Error('Expected an oversized input failure')
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectOrderPolicyError)
      expect(error).toMatchObject({ code: 'input-too-large' })
      expect(String(error)).not.toContain(canary)
    }
  })
})
