import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const CONFIG_NAME = 'update-feed.json'
const MAX_CONFIG_BYTES = 4 * 1024
const OWNER_PATTERN = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?'
const REPOSITORY_PATTERN = '[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?'
const RELEASES_URL = new RegExp(
  `^https://api\\.github\\.com/repos/(${OWNER_PATTERN})/(${REPOSITORY_PATTERN})/releases$`
)

export interface ReleaseFeedConfigOptions {
  isPackaged: boolean
  isE2E: boolean
  resourcesPath: string
  environmentUrl?: string | undefined
}

/**
 * Resolves the discovery-only GitHub releases API endpoint. Packaged builds do
 * not trust their launch environment: outside E2E, only the code-signed bundle
 * resource is considered.
 */
export async function resolveReleaseFeedUrl(
  options: ReleaseFeedConfigOptions
): Promise<string | undefined> {
  if (!options.isPackaged || options.isE2E) {
    return validatedReleaseFeedUrl(options.environmentUrl)
  }

  const resourcesPath = validatedAbsolutePath(options.resourcesPath)
  if (!resourcesPath) return undefined
  const configPath = join(resourcesPath, CONFIG_NAME)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_CONFIG_BYTES) {
      return undefined
    }
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0)
    if (bytesRead !== metadata.size || bytesRead > MAX_CONFIG_BYTES) return undefined
    const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    if (!isStrictFeedConfig(parsed)) return undefined
    return parsed.releasesUrl === null
      ? undefined
      : validatedReleaseFeedUrl(parsed.releasesUrl)
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function validatedReleaseFeedUrl(value: string | undefined): string | undefined {
  if (!value?.trim() || value.length > 1_024 || value !== value.trim()) return undefined
  return RELEASES_URL.test(value) ? value : undefined
}

function isStrictFeedConfig(value: unknown): value is { releasesUrl: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 &&
    Object.hasOwn(record, 'releasesUrl') &&
    (record.releasesUrl === null || typeof record.releasesUrl === 'string')
}

function validatedAbsolutePath(value: string): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 &&
    !value.includes('\0') && isAbsolute(value) && resolve(value) === value
    ? value
    : undefined
}
