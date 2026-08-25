import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeDisplayText } from '../../shared/security/redaction'
import {
  grokAccountReportSchema,
  type AccountUsageCycle,
  type GrokAccountReport
} from '../../shared/account'

const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
const DEFAULT_MAX_AUTH_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const HISTORY_LIMIT = 12

export interface GrokAccountServiceOptions {
  authPath?: string
  baseUrl?: string
  fetchImpl?: typeof fetch | undefined
}

/**
 * Main-only account status lookup against the same grok.com proxy the CLI
 * itself uses. The bearer credential is read from the CLI's auth store, stays
 * inside this service, and the public report carries display values only.
 */
export class GrokAccountService {
  private readonly authPath: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: GrokAccountServiceOptions = {}) {
    this.authPath = options.authPath ?? join(homedir(), '.grok', 'auth.json')
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async inspect(): Promise<GrokAccountReport> {
    const credential = await readBearerCredential(this.authPath)
    if (!credential) return grokAccountReportSchema.parse({ state: 'signed-out' })
    try {
      const [identity, usage] = await Promise.all([
        this.fetchIdentity(credential),
        this.fetchUsage(credential)
      ])
      if (identity === 'unauthorized') {
        return grokAccountReportSchema.parse({
          state: 'failed',
          message: 'The cached sign-in was not accepted. Send any prompt (or run grok login), then refresh.'
        })
      }
      return grokAccountReportSchema.parse({ state: 'ok', ...identity, usage })
    } catch {
      return grokAccountReportSchema.parse({
        state: 'failed',
        message: 'Could not reach grok.com for account status.'
      })
    }
  }

  private async fetchIdentity(credential: string): Promise<'unauthorized' | {
    email: string
    displayName: string
    tier: string | null
    teamName: string | null
    organizationName: string | null
    hasGrokCodeAccess: boolean
  }> {
    const payload = await this.request(credential, '/user?include=subscription')
    if (payload === 'unauthorized') return 'unauthorized'
    const record = asRecord(payload)
    const email = label(record.email, 256)
    if (!email) throw new Error('account identity unavailable')
    const displayName = [label(record.firstName, 128), label(record.lastName, 128)]
      .filter(Boolean)
      .join(' ')
    return {
      email,
      displayName,
      tier: label(record.subscriptionTier, 128) || null,
      teamName: label(record.teamName, 256) || null,
      organizationName: label(record.organizationName, 256) || null,
      hasGrokCodeAccess: record.hasGrokCodeAccess === true
    }
  }

  private async fetchUsage(credential: string): Promise<ReturnType<typeof parseUsage>> {
    try {
      // format=credits returns the newer credits config: rolling weekly or
      // monthly period plus percent-of-allowance, per the upstream source
      // (xai-grok-shell extensions/billing.rs). Legacy fields still arrive
      // alongside, so older backends keep working through the same parser.
      const payload = await this.request(credential, '/billing?format=credits')
      if (payload === 'unauthorized') return null
      return parseUsage(payload)
    } catch {
      return null
    }
  }

  private async request(credential: string, path: string): Promise<unknown | 'unauthorized'> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}` },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (response.status === 401 || response.status === 403) return 'unauthorized'
    if (!response.ok) throw new Error(`account request failed (${response.status})`)
    return await response.json() as unknown
  }
}

function parseUsage(payload: unknown): {
  used: number
  monthlyLimit: number
  onDemandCap: number
  periodStart: string
  periodEnd: string
  history: AccountUsageCycle[]
  periodType?: 'weekly' | 'monthly' | 'other'
  creditUsagePercent?: number
  prepaidBalance?: number
  onDemandUsed?: number
  productUsage?: Array<{ product: string; usagePercent: number }>
} | null {
  const config = asRecord(asRecord(payload).config)
  const currentPeriod = asRecord(config.currentPeriod)
  const periodStart = isoDate(currentPeriod.start) ?? isoDate(config.billingPeriodStart)
  const periodEnd = isoDate(currentPeriod.end) ?? isoDate(config.billingPeriodEnd)
  if (!periodStart || !periodEnd) return null
  const history: AccountUsageCycle[] = []
  for (const entry of Array.isArray(config.history) ? config.history.slice(0, HISTORY_LIMIT) : []) {
    const record = asRecord(entry)
    const cycle = asRecord(record.billingCycle)
    const year = wholeNumber(cycle.year)
    const month = wholeNumber(cycle.month)
    if (year < 2000 || year > 3000 || month < 1 || month > 12) continue
    history.push({
      year,
      month,
      includedUsed: metric(record.includedUsed),
      onDemandUsed: metric(record.onDemandUsed),
      totalUsed: metric(record.totalUsed)
    })
  }
  const periodType = usagePeriodType(currentPeriod.type)
  const creditUsagePercent = percentValue(config.creditUsagePercent)
  const productUsage: Array<{ product: string; usagePercent: number }> = []
  for (const entry of Array.isArray(config.productUsage) ? config.productUsage.slice(0, 16) : []) {
    const record = asRecord(entry)
    const product = label(record.product, 128)
    const usagePercent = percentValue(record.usagePercent)
    if (product && usagePercent !== undefined) productUsage.push({ product, usagePercent })
  }
  return {
    used: metric(config.used),
    monthlyLimit: metric(config.monthlyLimit),
    onDemandCap: metric(config.onDemandCap),
    periodStart,
    periodEnd,
    history,
    ...(periodType ? { periodType } : {}),
    ...(creditUsagePercent !== undefined ? { creditUsagePercent } : {}),
    ...(asRecord(config.prepaidBalance).val !== undefined ? { prepaidBalance: metric(config.prepaidBalance) } : {}),
    ...(asRecord(config.onDemandUsed).val !== undefined ? { onDemandUsed: metric(config.onDemandUsed) } : {}),
    ...(productUsage.length > 0 ? { productUsage } : {})
  }
}

function usagePeriodType(value: unknown): 'weekly' | 'monthly' | 'other' | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (value === 'USAGE_PERIOD_TYPE_WEEKLY') return 'weekly'
  if (value === 'USAGE_PERIOD_TYPE_MONTHLY') return 'monthly'
  return 'other'
}

function percentValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, 1_000)
    : undefined
}

async function readBearerCredential(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > DEFAULT_MAX_AUTH_BYTES) return null
    const store: unknown = JSON.parse(await handle.readFile({ encoding: 'utf8' }))
    if (store === null || typeof store !== 'object' || Array.isArray(store)) return null
    for (const entry of Object.values(store)) {
      const key = asRecord(entry).key
      if (typeof key === 'string' && key.length > 0 && key.length <= 65_536) return key
    }
    return null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function label(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') return ''
  return sanitizeDisplayText(value, maximumLength).trim()
}

function metric(value: unknown): number {
  const raw = asRecord(value).val
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0
}

function wholeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const time = Date.parse(value)
  if (Number.isNaN(time)) return null
  return new Date(time).toISOString()
}
