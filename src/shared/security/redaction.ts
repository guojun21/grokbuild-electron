export const REDACTED_VALUE = '[REDACTED]'
export const REDACTED_PATH = '[PATH REDACTED]'
export const TRUNCATED_VALUE = '[TRUNCATED]'

export type SanitizedJsonValue =
  | null
  | boolean
  | number
  | string
  | SanitizedJsonValue[]
  | { [key: string]: SanitizedJsonValue }

export interface RedactionLimits {
  maxDepth: number
  maxKeys: number
  maxArrayItems: number
  maxStringChars: number
  maxOutputChars: number
}

const DEFAULT_LIMITS: RedactionLimits = Object.freeze({
  maxDepth: 6,
  maxKeys: 256,
  maxArrayItems: 128,
  maxStringChars: 64 * 1024,
  maxOutputChars: 256 * 1024
})

const SECRET_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'auth',
  'cookie',
  'cookies',
  'cookiejar',
  'setcookie',
  'token',
  'tokens',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'secrettoken',
  'secret',
  'secrets',
  'clientsecret',
  'password',
  'passwords',
  'passwd',
  'apikey',
  'apikeys',
  'xapikey',
  'privatekey',
  'credential',
  'credentials',
  'headers',
  'header',
  'authorizationheader',
  'env',
  'envvars',
  'environment',
  'environmentvariables'
])

const PRIVATE_LOCATION_KEYS = new Set([
  'path',
  'filepath',
  'filename',
  'cwd',
  'workingdirectory',
  'argv',
  'args',
  'arguments',
  'commandline'
])

const SECRET_QUERY_KEYS = /(?:^|[_-])(?:authorization|auth|cookie|token|secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)$/i
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi
const COMMON_TOKEN_PATTERNS = [
  /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/gi,
  /\bgh[pousr]_[A-Za-z0-9]{8,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi,
  /\bAKIA[A-Z0-9]{12,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
] as const
const SECRET_ASSIGNMENT_PATTERN = /(["']?\b(?:authorization|auth|cookie|token|secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi
const SECRET_FLAG_PATTERN = /(--(?:authorization|auth|cookie|token|secret|password|api[-_]?key|access[-_]?token|client[-_]?secret))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi
// Quoted paths can legitimately contain spaces. Redact them before the
// unquoted heuristics below, otherwise only the prefix before the first space
// would be removed and the basename could still cross a public boundary.
const PRIVATE_QUOTED_PATH_PATTERN = /(["'`])(?:\/(?!\/)|~\/|[A-Za-z]:\\)[^"'`\r\n<>]*\1/gm
// A path often follows diagnostic punctuation (`path:/Users/...`, `cwd=C:\\...`).
// Excluding alphanumerics and path separators from the boundary avoids treating
// ordinary fractions or the second slash in an HTTPS URL as local authority.
const PRIVATE_POSIX_PATH_PATTERN = /(^|[^A-Za-z0-9/])\/(?!\/)[^\s"'`<>)]*/gm
const PRIVATE_HOME_PATH_PATTERN = /(^|[^A-Za-z0-9/])~\/[^\s"'`<>)]*/gm
const PRIVATE_WINDOWS_PATH_PATTERN = /(^|[^A-Za-z0-9\\/])[A-Za-z]:\\[^\s"'`<>)]*/gm
const DETAIL_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
const TITLE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g

interface SanitizeState {
  limits: RedactionLimits
  keyCount: number
  remainingStringChars: number
  seen: WeakSet<object>
}

export function sanitizeDisplayText(value: string, maxChars = DEFAULT_LIMITS.maxStringChars): string {
  const bounded = boundRawString(value, Math.max(1, maxChars * 2))
  let sanitized = bounded.replace(URL_PATTERN, redactUrl)
  sanitized = sanitized.replace(BEARER_PATTERN, 'Bearer [REDACTED]')
  for (const pattern of COMMON_TOKEN_PATTERNS) sanitized = sanitized.replace(pattern, REDACTED_VALUE)
  sanitized = sanitized
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1[REDACTED]')
    .replace(SECRET_FLAG_PATTERN, '$1 [REDACTED]')
    .replace(PRIVATE_QUOTED_PATH_PATTERN, (_match, quote: string) =>
      `${quote}${REDACTED_PATH}${quote}`)
    .replace(PRIVATE_POSIX_PATH_PATTERN, `$1${REDACTED_PATH}`)
    .replace(PRIVATE_HOME_PATH_PATTERN, `$1${REDACTED_PATH}`)
    .replace(PRIVATE_WINDOWS_PATH_PATTERN, `$1${REDACTED_PATH}`)
    .replace(DETAIL_CONTROL_PATTERN, ' ')
  return truncateSanitized(sanitized, maxChars)
}

export function sanitizeDisplayTitle(value: string, maxChars = 2_000): string {
  return sanitizeDisplayText(value, maxChars)
    .replace(TITLE_CONTROL_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

export function sanitizeJsonValue(
  value: unknown,
  overrides: Partial<RedactionLimits> = {}
): SanitizedJsonValue {
  const limits = resolveLimits(overrides)
  const state: SanitizeState = {
    limits,
    keyCount: 0,
    remainingStringChars: limits.maxOutputChars,
    seen: new WeakSet()
  }
  return sanitizeUnknown(value, state, 0)
}

export function stringifySanitizedJson(
  value: unknown,
  overrides: Partial<RedactionLimits> = {}
): string {
  const limits = resolveLimits(overrides)
  const serialized = JSON.stringify(sanitizeJsonValue(value, limits))
  return truncateSanitized(serialized, limits.maxOutputChars)
}

export function isSensitiveDisplayKey(key: string): boolean {
  const normalized = normalizeKey(key)
  return SECRET_KEYS.has(normalized) || PRIVATE_LOCATION_KEYS.has(normalized) ||
    /(?:authorization|cookie|token|secret|password|passwd|apikey|privatekey|credential)$/.test(normalized)
}

function sanitizeUnknown(value: unknown, state: SanitizeState, depth: number): SanitizedJsonValue {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return sanitizeBudgetedString(value, state)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return '[UNAVAILABLE]'
  if (typeof value === 'function' || typeof value === 'symbol') return '[UNSUPPORTED]'
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return '[BINARY REDACTED]'
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[INVALID DATE]' : value.toISOString()
  if (value instanceof Error) return sanitizeBudgetedString(value.message, state)
  if (depth >= state.limits.maxDepth) return '[DEPTH LIMIT]'
  if (typeof value !== 'object') return '[UNSUPPORTED]'
  if (state.seen.has(value)) return '[CIRCULAR]'
  state.seen.add(value)

  if (Array.isArray(value)) {
    const bounded = value.slice(0, state.limits.maxArrayItems)
    const sanitized = bounded.map((item) => sanitizeUnknown(item, state, depth + 1))
    if (value.length > bounded.length) sanitized.push(TRUNCATED_VALUE)
    return sanitized
  }

  const output = Object.create(null) as Record<string, SanitizedJsonValue>
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return '[UNAVAILABLE]'
  }
  for (const rawKey of keys) {
    if (state.keyCount >= state.limits.maxKeys) {
      output._truncated = '[KEY LIMIT]'
      break
    }
    state.keyCount += 1
    const key = sanitizeDisplayTitle(rawKey, 256) || 'field'
    if (isSensitiveDisplayKey(rawKey)) {
      output[key] = REDACTED_VALUE
      continue
    }
    try {
      output[key] = sanitizeUnknown((value as Record<string, unknown>)[rawKey], state, depth + 1)
    } catch {
      output[key] = '[UNAVAILABLE]'
    }
  }
  return output
}

function sanitizeBudgetedString(value: string, state: SanitizeState): string {
  if (state.remainingStringChars <= 0) return TRUNCATED_VALUE
  const allowance = Math.min(state.limits.maxStringChars, state.remainingStringChars)
  const sanitized = sanitizeDisplayText(value, allowance)
  state.remainingStringChars = Math.max(0, state.remainingStringChars - sanitized.length)
  return sanitized
}

function redactUrl(candidate: string): string {
  try {
    const url = new URL(candidate)
    if (url.protocol === 'file:') return REDACTED_PATH
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.test(key) || isSensitiveDisplayKey(key)) {
        url.searchParams.set(key, REDACTED_VALUE)
      }
    }
    if (url.hash) {
      url.hash = url.hash.replace(SECRET_ASSIGNMENT_PATTERN, '$1[REDACTED]')
    }
    return url.toString()
  } catch {
    return '[URL REDACTED]'
  }
}

function boundRawString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const prefix = value.slice(0, maxChars)
  const lastBoundary = Math.max(
    prefix.lastIndexOf(' '),
    prefix.lastIndexOf('\n'),
    prefix.lastIndexOf('\t'),
    prefix.lastIndexOf(','),
    prefix.lastIndexOf(';')
  )
  return `${lastBoundary >= 0 ? prefix.slice(0, lastBoundary + 1) : ''}${TRUNCATED_VALUE}`
}

function truncateSanitized(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = `…${TRUNCATED_VALUE}`
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function resolveLimits(overrides: Partial<RedactionLimits>): RedactionLimits {
  return {
    maxDepth: boundedInteger(overrides.maxDepth, DEFAULT_LIMITS.maxDepth, 1, 20),
    maxKeys: boundedInteger(overrides.maxKeys, DEFAULT_LIMITS.maxKeys, 1, 4_096),
    maxArrayItems: boundedInteger(overrides.maxArrayItems, DEFAULT_LIMITS.maxArrayItems, 1, 4_096),
    maxStringChars: boundedInteger(
      overrides.maxStringChars,
      DEFAULT_LIMITS.maxStringChars,
      1,
      512 * 1024
    ),
    maxOutputChars: boundedInteger(
      overrides.maxOutputChars,
      DEFAULT_LIMITS.maxOutputChars,
      1,
      1024 * 1024
    )
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return Number.isSafeInteger(value) && value !== undefined
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback
}
