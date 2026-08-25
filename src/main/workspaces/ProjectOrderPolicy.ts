export const MAX_PROJECT_ORDER_ENTRIES = 2_000
export const MAX_PROJECT_ORDER_PINS = 5
export const MAX_PROJECT_ORDER_ID_LENGTH = 256

export interface ProjectOrderRecord {
  readonly id: string
}

export interface ProjectOrderState<T extends ProjectOrderRecord> {
  readonly projects: readonly T[]
  readonly pinnedProjectIds: readonly string[]
}

export interface NormalizedProjectOrder<T extends ProjectOrderRecord> {
  projects: T[]
  pinnedProjectIds: string[]
}

export type ProjectMoveDirection = 'up' | 'down'

export type ProjectMoveOutcome =
  | 'moved'
  | 'at-group-boundary'
  | 'unknown-project'
  | 'invalid-project-id'

export interface ProjectMoveResult<T extends ProjectOrderRecord>
  extends NormalizedProjectOrder<T> {
  outcome: ProjectMoveOutcome
}

export type ProjectOrderPolicyErrorCode =
  | 'invalid-input'
  | 'input-too-large'
  | 'invalid-direction'

/** A fixed, content-free failure safe to surface at the main-process boundary. */
export class ProjectOrderPolicyError extends Error {
  constructor(readonly code: ProjectOrderPolicyErrorCode) {
    super(policyErrorMessage(code))
    this.name = 'ProjectOrderPolicyError'
  }
}

/**
 * Pure ordering policy matching the pinned GrokBuild v0.3.2 WorkspaceStore:
 * pinned projects form one ordered group above the ordinary project order.
 * Reordering never changes pin membership or crosses the group boundary.
 */
export class ProjectOrderPolicy {
  /**
   * Returns fresh arrays, keeping the first valid project occurrence and the
   * first valid pin occurrence. Dangling pins and excess persisted pins are
   * discarded, matching the application's bounded persisted-state contract.
   */
  static normalize<T extends ProjectOrderRecord>(
    state: ProjectOrderState<T>
  ): NormalizedProjectOrder<T> {
    const { projects: rawProjects, pinnedProjectIds: rawPinnedProjectIds } = validatedArrays(state)
    const projects: T[] = []
    const projectIds = new Set<string>()

    for (const candidate of rawProjects) {
      const id = validProjectId(candidate)
      if (id === undefined || projectIds.has(id)) continue
      projectIds.add(id)
      projects.push(candidate)
    }

    const pinnedProjectIds: string[] = []
    const pinned = new Set<string>()
    for (const candidate of rawPinnedProjectIds) {
      if (
        pinnedProjectIds.length >= MAX_PROJECT_ORDER_PINS ||
        !isValidProjectId(candidate) ||
        !projectIds.has(candidate) ||
        pinned.has(candidate)
      ) continue
      pinned.add(candidate)
      pinnedProjectIds.push(candidate)
    }

    return { projects, pinnedProjectIds }
  }

  /** Derives the sidebar order without modifying either persisted input array. */
  static orderedProjects<T extends ProjectOrderRecord>(
    state: ProjectOrderState<T>
  ): T[] {
    const normalized = ProjectOrderPolicy.normalize(state)
    const projectsById = new Map(normalized.projects.map((project) => [project.id, project]))
    const pinned = new Set(normalized.pinnedProjectIds)
    return [
      ...normalized.pinnedProjectIds.map((id) => projectsById.get(id) as T),
      ...normalized.projects.filter((project) => !pinned.has(project.id))
    ]
  }

  /**
   * Moves a project by one position within its current group. The result is
   * always normalized and uses fresh arrays, including for explicit no-ops.
   */
  static move<T extends ProjectOrderRecord>(
    state: ProjectOrderState<T>,
    projectId: string,
    direction: ProjectMoveDirection
  ): ProjectMoveResult<T> {
    if (direction !== 'up' && direction !== 'down') {
      throw new ProjectOrderPolicyError('invalid-direction')
    }
    const normalized = ProjectOrderPolicy.normalize(state)
    if (!isValidProjectId(projectId)) {
      return { ...normalized, outcome: 'invalid-project-id' }
    }
    if (!normalized.projects.some((project) => project.id === projectId)) {
      return { ...normalized, outcome: 'unknown-project' }
    }

    const pinnedIndex = normalized.pinnedProjectIds.indexOf(projectId)
    if (pinnedIndex >= 0) {
      const destination = adjacentIndex(
        pinnedIndex,
        normalized.pinnedProjectIds.length,
        direction
      )
      if (destination === undefined) {
        return { ...normalized, outcome: 'at-group-boundary' }
      }
      swap(normalized.pinnedProjectIds, pinnedIndex, destination)
      return { ...normalized, outcome: 'moved' }
    }

    const pinned = new Set(normalized.pinnedProjectIds)
    const ordinaryProjectIds = normalized.projects
      .filter((project) => !pinned.has(project.id))
      .map((project) => project.id)
    const ordinaryIndex = ordinaryProjectIds.indexOf(projectId)
    const destination = adjacentIndex(ordinaryIndex, ordinaryProjectIds.length, direction)
    if (destination === undefined) {
      return { ...normalized, outcome: 'at-group-boundary' }
    }

    const neighbourId = ordinaryProjectIds[destination]
    const sourceIndex = normalized.projects.findIndex((project) => project.id === projectId)
    const destinationIndex = normalized.projects.findIndex((project) => project.id === neighbourId)
    swap(normalized.projects, sourceIndex, destinationIndex)
    return { ...normalized, outcome: 'moved' }
  }
}

function validatedArrays<T extends ProjectOrderRecord>(
  state: ProjectOrderState<T>
): { projects: readonly T[]; pinnedProjectIds: readonly string[] } {
  if (
    !state ||
    !Array.isArray(state.projects) ||
    !Array.isArray(state.pinnedProjectIds)
  ) throw new ProjectOrderPolicyError('invalid-input')
  if (
    state.projects.length > MAX_PROJECT_ORDER_ENTRIES ||
    state.pinnedProjectIds.length > MAX_PROJECT_ORDER_ENTRIES
  ) throw new ProjectOrderPolicyError('input-too-large')
  return { projects: state.projects, pinnedProjectIds: state.pinnedProjectIds }
}

function validProjectId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const id = (value as { id?: unknown }).id
  return isValidProjectId(id) ? id : undefined
}

function isValidProjectId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PROJECT_ORDER_ID_LENGTH
}

function adjacentIndex(
  index: number,
  length: number,
  direction: ProjectMoveDirection
): number | undefined {
  const candidate = direction === 'up' ? index - 1 : index + 1
  return index < 0 || candidate < 0 || candidate >= length ? undefined : candidate
}

function swap<T>(values: T[], left: number, right: number): void {
  const value = values[left]
  values[left] = values[right] as T
  values[right] = value as T
}

function policyErrorMessage(code: ProjectOrderPolicyErrorCode): string {
  switch (code) {
    case 'invalid-input': return 'The project order input is invalid.'
    case 'input-too-large': return 'The project order input exceeds the safety limit.'
    case 'invalid-direction': return 'The project move direction is invalid.'
  }
}
