export type PublicSessionErrorKind =
  | 'authentication'
  | 'rate-limit'
  | 'network'
  | 'crash'
  | 'generic'

export type AcpRpcFaultKind = PublicSessionErrorKind | 'not-found'

export interface PublicSessionError {
  kind: PublicSessionErrorKind
  message: string
}

export interface ClassifiedAcpRpcFault {
  kind: AcpRpcFaultKind
  message: string
}

const PUBLIC_MESSAGES: Record<PublicSessionErrorKind, string> = {
  authentication: 'Grok authentication failed. Sign in again and retry.',
  'rate-limit': 'Grok is temporarily rate limited. Wait and retry.',
  network: 'Grok could not reach the service. Check the connection and retry.',
  crash: 'The Grok process stopped unexpectedly. Start a new prompt to reconnect.',
  generic: 'Grok reported an unexpected error. Retry the request.'
}

const NOT_FOUND_MESSAGE = 'The previous Grok session is no longer available.'
const MAX_CLASSIFICATION_CHARS = 64 * 1024

export class PublicAcpError extends Error {
  constructor(readonly kind: PublicSessionErrorKind) {
    super(PUBLIC_MESSAGES[kind])
    this.name = 'PublicAcpError'
  }
}

/** Inspects raw diagnostics but returns only a fixed public taxonomy and copy. */
export function classifySessionStderr(raw: unknown): PublicSessionError | undefined {
  const text = diagnosticText(raw)
  if (!text) return undefined
  const kind = classifyText(text, false)
  return kind ? { kind, message: PUBLIC_MESSAGES[kind] } : undefined
}

/** RPC data is inspected for classification only and is never retained on the returned value. */
export function classifyAcpRpcFault(
  rpcCode: number,
  rawMessage: unknown,
  rawData: unknown
): ClassifiedAcpRpcFault {
  const dataCode = recordString(rawData, 'code')
  const text = diagnosticText(rawMessage)
  if (
    rpcCode === 404 || dataCode === 'FS_NOT_FOUND' || dataCode === 'NOT_FOUND' ||
    /(?:path|session)\s+not\s+found|no\s+such\s+(?:file|session)/i.test(text)
  ) {
    return { kind: 'not-found', message: NOT_FOUND_MESSAGE }
  }
  const kind = classifyText(`${rpcCode} ${text}`, true) ?? 'generic'
  return { kind, message: PUBLIC_MESSAGES[kind] }
}

export function toPublicAcpError(error: unknown): PublicAcpError {
  if (error instanceof PublicAcpError) return error
  const kind = classifyText(diagnosticText(error), true) ?? 'generic'
  return new PublicAcpError(kind)
}

export function publicAcpErrorMessage(error: unknown): string {
  return toPublicAcpError(error).message
}

function classifyText(text: string, allowGeneric: boolean): PublicSessionErrorKind | undefined {
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|forbidden|auth(?:entication)?\s+(?:error|failed|required|expired)|invalid\s+(?:api\s*)?key|login\s+required|credential/i.test(text)
  ) return 'authentication'
  if (/\b429\b|rate[\s_-]*limit|too\s+many\s+requests|quota\s+(?:exceeded|exhausted)/i.test(text)) {
    return 'rate-limit'
  }
  if (
    /\b(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ETIMEDOUT)\b|network|offline|dns|socket|tls|certificate|could\s+not\s+reach|connection\s+(?:refused|reset|failed)|timed?\s*out|timeout/i.test(text)
  ) return 'network'
  if (/panic|fatal|segmentation|uncaught|abort|crash|killed|out\s+of\s+memory|heap\s+limit|process\s+(?:exited|stopped)/i.test(text)) {
    return 'crash'
  }
  if (allowGeneric || /error|failed|failure|exception/i.test(text)) return 'generic'
  return undefined
}

function diagnosticText(raw: unknown): string {
  try {
    if (raw instanceof Error) return raw.message.slice(0, MAX_CLASSIFICATION_CHARS)
    return typeof raw === 'string' ? raw.slice(0, MAX_CLASSIFICATION_CHARS) : ''
  } catch {
    return ''
  }
}

function recordString(value: unknown, key: string): string | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const candidate = (value as Record<string, unknown>)[key]
    return typeof candidate === 'string' ? candidate.slice(0, 128) : undefined
  } catch {
    return undefined
  }
}
