import {
  GitService,
  GitServiceError,
  type GitProjectSnapshot
} from './GitService'
import {
  DASHBOARD_MAX_BRANCH_CHARS,
  DASHBOARD_MAX_DIRTY_COUNT,
  DASHBOARD_MAX_PROJECT_ID_CHARS,
  type DashboardProjectStatus
} from '../../shared/dashboard'

export {
  DASHBOARD_MAX_BRANCH_CHARS,
  DASHBOARD_MAX_DIRTY_COUNT,
  DASHBOARD_MAX_PROJECT_ID_CHARS
} from '../../shared/dashboard'
export type { DashboardProjectStatus } from '../../shared/dashboard'

export interface DashboardInspectionInput {
  /** Opaque identity resolved from the main-owned application snapshot. */
  projectId: string
  /** Already-canonical registered project path, resolved by a trusted main caller. */
  canonicalProjectPath: string
}

export type DashboardInspectorErrorCode =
  | 'invalid-project-id'
  | 'git-unavailable'
  | 'timeout'
  | 'output-limit'
  | 'inspection-failed'

export class DashboardInspectorError extends Error {
  constructor(readonly code: DashboardInspectorErrorCode) {
    super(publicErrorMessage(code))
    this.name = 'DashboardInspectorError'
  }
}

interface GitSnapshotReader {
  inspect(projectDirectory: string): Promise<GitProjectSnapshot>
}

export interface DashboardInspectorOptions {
  /** Main-only deterministic test seam. It cannot accept an argv or diff scope. */
  gitService?: GitSnapshotReader | undefined
}

/**
 * Main-process-only dashboard projection over GitService.
 *
 * The registered project path is used only inside the privileged Git boundary.
 * Results contain no filesystem paths, Git directories, revisions, argv,
 * stderr, stdout, or diff text.
 */
export class DashboardInspector {
  private readonly gitService: GitSnapshotReader

  constructor(options: DashboardInspectorOptions = {}) {
    this.gitService = options.gitService ?? new GitService()
  }

  async inspect(input: DashboardInspectionInput): Promise<DashboardProjectStatus> {
    const projectId = requireProjectId(input.projectId)
    try {
      const snapshot = await this.gitService.inspect(input.canonicalProjectPath)
      return projectStatus(projectId, snapshot)
    } catch (error) {
      if (error instanceof GitServiceError) {
        if (error.code === 'not-repository' || error.code === 'invalid-project') {
          return neutralStatus(projectId)
        }
        throw new DashboardInspectorError(mapGitError(error.code))
      }
      // An injected runner or future Git implementation may throw diagnostics
      // containing paths, argv, stderr, or repository content. Never forward it.
      throw new DashboardInspectorError('inspection-failed')
    }
  }
}

function projectStatus(
  projectId: string,
  snapshot: GitProjectSnapshot
): DashboardProjectStatus {
  const dirtyCount = boundedDirtyCount(snapshot.status.total)
  const branch = boundedBranch(snapshot.branch.name)
  return {
    projectId,
    isRepository: true,
    isWorktree: snapshot.worktree.isLinkedWorktree === true,
    ...(branch === undefined ? {} : { branch }),
    dirtyCount
  }
}

function neutralStatus(projectId: string): DashboardProjectStatus {
  return {
    projectId,
    isRepository: false,
    isWorktree: false,
    dirtyCount: 0
  }
}

function requireProjectId(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > DASHBOARD_MAX_PROJECT_ID_CHARS ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new DashboardInspectorError('invalid-project-id')
  }
  return value
}

function boundedBranch(value: string | null): string | undefined {
  if (value === null) return undefined
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new DashboardInspectorError('inspection-failed')
  }
  return value.slice(0, DASHBOARD_MAX_BRANCH_CHARS)
}

function boundedDirtyCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DashboardInspectorError('inspection-failed')
  }
  return Math.min(value, DASHBOARD_MAX_DIRTY_COUNT)
}

function mapGitError(code: GitServiceError['code']): DashboardInspectorErrorCode {
  switch (code) {
    case 'invalid-git':
    case 'spawn-failed':
      return 'git-unavailable'
    case 'timeout':
      return 'timeout'
    case 'output-limit':
      return 'output-limit'
    case 'invalid-project':
    case 'not-repository':
    case 'invalid-request':
    case 'command-failed':
    case 'invalid-output':
      return 'inspection-failed'
  }
}

function publicErrorMessage(code: DashboardInspectorErrorCode): string {
  switch (code) {
    case 'invalid-project-id':
      return 'The dashboard project identity is invalid.'
    case 'git-unavailable':
      return 'Git is unavailable for dashboard inspection.'
    case 'timeout':
      return 'Dashboard repository inspection timed out.'
    case 'output-limit':
      return 'Dashboard repository status exceeded the safety limit.'
    case 'inspection-failed':
      return 'The dashboard could not inspect the repository state.'
  }
}
