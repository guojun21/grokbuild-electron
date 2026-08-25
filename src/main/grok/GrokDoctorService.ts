import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeDisplayText } from '../../shared/security/redaction'
import {
  grokDoctorReportSchema,
  type DoctorCheck,
  type GrokDoctorReport
} from '../../shared/doctor'

const DEFAULT_MAX_AUTH_BYTES = 1024 * 1024

export interface GrokDoctorInput {
  cliAvailable: boolean
  cliVersion?: string
}

export interface GrokDoctorServiceOptions {
  authPath?: string
  configPath?: string
  maximumAuthBytes?: number
}

/**
 * Main-only, read-only launch diagnostics. The public report deliberately
 * contains fixed copy rather than paths, credential values, or parser errors.
 */
export class GrokDoctorService {
  private readonly authPath: string
  private readonly configPath: string
  private readonly maximumAuthBytes: number

  constructor(options: GrokDoctorServiceOptions = {}) {
    this.authPath = options.authPath ?? join(homedir(), '.grok', 'auth.json')
    this.configPath = options.configPath ?? join(homedir(), '.grok', 'config.toml')
    this.maximumAuthBytes = boundedMaximum(options.maximumAuthBytes)
  }

  async inspect(input: GrokDoctorInput): Promise<GrokDoctorReport> {
    const [authenticated, configPresent] = await Promise.all([
      hasCachedCredentials(this.authPath, this.maximumAuthBytes),
      hasRegularFile(this.configPath)
    ])
    const version = safeVersion(input.cliVersion)
    const checks: DoctorCheck[] = [
      {
        key: 'cli',
        title: 'grok CLI',
        detail: input.cliAvailable
          ? 'Found on your system.'
          : 'Not found — choose or install the grok CLI to use GrokBuild.',
        status: input.cliAvailable ? 'ok' : 'failed'
      },
      {
        key: 'version',
        title: 'CLI version',
        detail: version || 'Version unavailable.',
        status: input.cliAvailable ? (version ? 'ok' : 'warning') : 'info'
      },
      {
        key: 'auth',
        title: 'Authentication',
        detail: authenticated
          ? 'Cached sign-in credentials are present.'
          : 'Signed out — run grok login to authenticate.',
        status: authenticated ? 'ok' : (input.cliAvailable ? 'warning' : 'info')
      },
      {
        key: 'config',
        title: 'config.toml',
        detail: configPresent
          ? 'Present in your grok config directory.'
          : 'Not created yet — it appears after first use.',
        status: configPresent ? 'ok' : 'info'
      }
    ]
    const healthy = input.cliAvailable && authenticated
    return grokDoctorReportSchema.parse({
      healthy,
      ...(!input.cliAvailable
        ? { remediation: 'choose-cli' as const }
        : !authenticated
          ? { remediation: 'run-grok-login' as const }
          : {}),
      checks
    })
  }
}

export async function hasCachedCredentials(
  path: string,
  maximumBytes = DEFAULT_MAX_AUTH_BYTES
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > boundedMaximum(maximumBytes)) return false
    const source = await handle.readFile({ encoding: 'utf8' })
    const value: unknown = JSON.parse(source)
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function hasRegularFile(path: string): Promise<boolean> {
  try {
    const canonical = await realpath(path)
    return (await stat(canonical)).isFile()
  } catch {
    return false
  }
}

function safeVersion(value: string | undefined): string {
  if (!value) return ''
  return sanitizeDisplayText(value, 128).trim()
}

function boundedMaximum(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_AUTH_BYTES
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_AUTH_BYTES) {
    return DEFAULT_MAX_AUTH_BYTES
  }
  return value
}
