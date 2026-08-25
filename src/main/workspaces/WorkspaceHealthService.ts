import { access, lstat, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import type {
  WorkspaceHealthResult,
  WorkspaceHealthState
} from '../../shared/workspaceHealth'

export type { WorkspaceHealthResult, WorkspaceHealthState } from '../../shared/workspaceHealth'

export interface WorkspaceHealthInput {
  projectId: string
  path: string
}

export interface WorkspaceIdentity {
  device: bigint
  inode: bigint
}

const PUBLIC_WORKSPACE_MESSAGES: Record<Exclude<WorkspaceHealthState, 'ready'>, string> = {
  missing: 'The workspace folder is missing. Restore it, then check again.',
  'not-directory': 'The workspace location is no longer a folder. Restore the original folder, then check again.',
  changed: 'The workspace location changed. Restore the original folder without an alias, then check again.',
  unreadable: 'The workspace folder is not readable. Restore access, then check again.'
}

export class WorkspaceUnavailableError extends Error {
  constructor(readonly state: Exclude<WorkspaceHealthState, 'ready'>) {
    super(PUBLIC_WORKSPACE_MESSAGES[state])
    this.name = 'WorkspaceUnavailableError'
  }
}

/**
 * Main-only, read-only workspace liveness probe. Results contain the opaque
 * project id and a fixed state only; filesystem paths and errors stay private.
 */
export class WorkspaceHealthService {
  async inspect(projects: readonly WorkspaceHealthInput[]): Promise<WorkspaceHealthResult[]> {
    return await Promise.all(projects.map(async (project) => ({
      projectId: boundedProjectId(project.projectId),
      state: await inspectPath(project.path)
    })))
  }

  /** Main-only identity checkpoint for operations that span an external RPC. */
  async identity(path: string): Promise<WorkspaceIdentity | undefined> {
    if (!isCanonicalAbsolutePath(path)) return undefined
    try {
      const linkInfo = await lstat(path, { bigint: true })
      if (linkInfo.isSymbolicLink() || !linkInfo.isDirectory()) return undefined
      if (await realpath(path) !== path) return undefined
      return { device: linkInfo.dev, inode: linkInfo.ino }
    } catch {
      return undefined
    }
  }
}

async function inspectPath(path: string): Promise<WorkspaceHealthState> {
  if (!isCanonicalAbsolutePath(path)) {
    return 'changed'
  }
  try {
    const linkInfo = await lstat(path)
    if (linkInfo.isSymbolicLink()) return 'changed'
    if (!linkInfo.isDirectory()) return 'not-directory'
    const canonical = await realpath(path)
    if (canonical !== path) return 'changed'
    if (!(await stat(canonical)).isDirectory()) return 'not-directory'
    try {
      await access(canonical, constants.R_OK | constants.X_OK)
    } catch {
      return 'unreadable'
    }
    return 'ready'
  } catch (error) {
    return isMissingError(error) ? 'missing' : 'unreadable'
  }
}

function isCanonicalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && path.length > 0 && path.length <= 4_096 && normalize(path) === path
}

function boundedProjectId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) return 'invalid-project'
  return value
}

function isMissingError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' || (error as { code?: unknown }).code === 'ENOTDIR')
  )
}
