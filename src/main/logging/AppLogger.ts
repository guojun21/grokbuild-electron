import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeDisplayText } from '../../shared/security/redaction'

const MAX_LOG_BYTES = 10 * 1024 * 1024
const MAX_FIELD_CHARS = 8_192
const MAX_LINE_CHARS = 32 * 1024

export type AppLogLevel = 'info' | 'warn' | 'error'

export interface AppLogger {
  readonly path: string
  log(level: AppLogLevel, event: string, fields?: Record<string, unknown>): void
}

/**
 * Always-on JSONL diagnostics log. Writes are synchronous and line-oriented
 * so entries survive an immediate crash of the process that produced them —
 * the whole point is post-mortem evidence. String fields pass through the
 * shared display redaction and a hard length cap before landing on disk.
 */
export function createAppLogger(directory: string): AppLogger {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'grokbuild.log')
  return {
    path,
    log(level, event, fields) {
      try {
        rotateIfNeeded(path)
        const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, event }
        for (const [key, value] of Object.entries(fields ?? {})) {
          entry[key] = boundedValue(value)
        }
        const line = JSON.stringify(entry)
        appendFileSync(path, `${line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line}\n`)
      } catch {
        // Logging must never take the app down.
      }
    }
  }
}

function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`)
  } catch {
    // Missing file or race — the append below creates it.
  }
}

function boundedValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeDisplayText(value, MAX_FIELD_CHARS)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (value === undefined) return null
  try {
    return sanitizeDisplayText(JSON.stringify(value) ?? 'null', MAX_FIELD_CHARS)
  } catch {
    return '[unserializable]'
  }
}
