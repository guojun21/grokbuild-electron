import { open } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { UpdateCheckResult } from './UpdateCoordinator'

const MARKER_CONTENT = 'trusted-app-update-install-requested\n'

export interface E2EAppUpdateCoordinatorOptions {
  enabled: boolean
  markerPath?: string | undefined
  userDataPath: string
  installedVersion: string
  confirmInstall: (latestVersion: string) => Promise<boolean>
}

export interface E2EAppUpdateCoordinator {
  check(cwd?: string): Promise<UpdateCheckResult>
  installApp(): Promise<'cancelled' | 'restarting'>
}

/**
 * Creates the inert end-to-end update boundary. It is unavailable unless the
 * process is explicitly in E2E mode and its fixed marker stays below the
 * isolated user-data directory. It never downloads, verifies, invokes
 * autoUpdater, or exits the application.
 */
export function createE2EAppUpdateCoordinator(
  options: E2EAppUpdateCoordinatorOptions
): E2EAppUpdateCoordinator | undefined {
  if (!options.enabled || !options.markerPath?.trim()) return undefined

  const userDataPath = canonicalInputPath(options.userDataPath)
  const markerPath = canonicalInputPath(options.markerPath.trim())
  const markerRelativePath = relative(userDataPath, markerPath)
  if (
    markerRelativePath.length === 0 ||
    markerRelativePath === '..' ||
    markerRelativePath.startsWith('../') ||
    isAbsolute(markerRelativePath)
  ) {
    throw new Error('The E2E app update marker is invalid.')
  }

  let installed = false
  let candidateAvailable = false
  const coordinator: E2EAppUpdateCoordinator = {
    check: async (): Promise<UpdateCheckResult> => {
      candidateAvailable = true
      return {
        overview: {
          checkedAt: new Date().toISOString(),
          app: {
            state: 'update-available',
            installed: safeVersion(options.installedVersion),
            latest: '999.0.0',
            assetAvailable: true
          },
          cli: { state: 'unavailable' }
        }
      }
    },
    installApp: async () => {
      if (installed) throw new Error('The E2E app update was already requested.')
      if (!candidateAvailable) throw new Error('A fresh E2E app update check is required.')
      candidateAvailable = false
      if (!await options.confirmInstall('999.0.0')) return 'cancelled'
      installed = true
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(markerPath, 'wx', 0o600)
        await handle.writeFile(MARKER_CONTENT, 'utf8')
        await handle.sync()
      } catch {
        throw new Error('The E2E app update marker could not be written.')
      } finally {
        await handle?.close().catch(() => undefined)
      }
      return 'restarting'
    }
  }
  return Object.freeze(coordinator)
}

function canonicalInputPath(value: string): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 4_096 ||
    value.includes('\0') || !isAbsolute(value) || resolve(value) !== value
  ) throw new Error('The E2E app update marker is invalid.')
  return value
}

function safeVersion(value: string): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value
    : '0.0.0'
}
