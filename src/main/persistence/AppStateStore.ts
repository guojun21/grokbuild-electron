import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings, ProjectSnapshot, SessionSnapshot } from '../../shared/models'
import { parsePersistedState, persistedStateSchema } from '../../shared/schemas'

export interface PersistedState {
  version: 5
  projects: ProjectSnapshot[]
  sessions: SessionSnapshot[]
  pinnedProjectIds: string[]
  pinnedSessionIds: string[]
  settledSessionIds: string[]
  selectedSessionIdByProject: Record<string, string>
  selectedProjectId?: string
  selectedSessionId?: string
  settings: AppSettings
}

export const MAX_PERSISTED_STATE_BYTES = 64 * 1024 * 1024

export function defaultState(cliPath: string): PersistedState {
  return {
    version: 5,
    projects: [],
    sessions: [],
    pinnedProjectIds: [],
    pinnedSessionIds: [],
    settledSessionIds: [],
    selectedSessionIdByProject: {},
    settings: {
      appearance: 'system',
      reduceMotion: false,
      grokCliPath: cliPath,
      maxLiveSessions: 4,
      privacyMode: false,
      memoryEnabled: false
    }
  }
}

export class AppStateStore {
  constructor(
    private readonly path: string,
    private readonly cliPath: string
  ) {}

  async load(): Promise<PersistedState> {
    try {
      const info = await stat(this.path)
      if (!info.isFile() || info.size > MAX_PERSISTED_STATE_BYTES) {
        throw new Error('Application state is not a bounded regular file')
      }
      return parsePersistedState(JSON.parse(await readFile(this.path, 'utf8'))) as PersistedState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read application state; using safe defaults.')
        await this.quarantineInvalidState()
      }
      return defaultState(this.cliPath)
    }
  }

  async save(state: PersistedState): Promise<void> {
    const serialized = serializePersistedState(state)
    const parent = dirname(this.path)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    await chmod(parent, 0o700)
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, serialized, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.path)
  }

  private async quarantineInvalidState(): Promise<void> {
    try {
      await rename(this.path, `${this.path}.corrupt-${Date.now()}`)
    } catch {
      // A missing, unreadable, or concurrently replaced file cannot be quarantined here.
    }
  }
}

export function serializePersistedState(state: PersistedState): string {
  const validated = persistedStateSchema.parse(state)
  const serialized = `${JSON.stringify(validated, null, 2)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PERSISTED_STATE_BYTES) {
    throw new Error('Application state exceeds the 64 MiB persistence limit')
  }
  return serialized
}
