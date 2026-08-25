import { spawn, type ChildProcess } from 'node:child_process'
import { stat, realpath } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectSnapshot, SessionSnapshot, TranscriptItem } from '../../shared/models'
import {
  boundedActivityCount,
  parsePersistedActivitySummary
} from '../../shared/acp/activity'

const PLUTIL_PATH = '/usr/bin/plutil'
const PLIST_MAX_BYTES = 64 * 1024 * 1024
const PLUTIL_MAX_OUTPUT_BYTES = 96 * 1024 * 1024
const PLUTIL_LINT_MAX_OUTPUT_BYTES = 64 * 1024
const PLUTIL_TIMEOUT_MS = 10_000
const PLUTIL_TERMINATE_GRACE_MS = 250
const MAX_PROJECTS = 2_000
const MAX_SESSIONS = 10_000
const MAX_TRANSCRIPT_ITEMS = 4_000
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024
const MAX_MESSAGE_TEXT = 2 * 1024 * 1024 + 64
const MAX_NOTICE_TEXT = 64 * 1024
const MAX_IDENTIFIER = 256
const MAX_TITLE = 2_000
const UNKNOWN_CREATED_AT = '1970-01-01T00:00:00.000Z'
const APPLE_REFERENCE_DATE_UNIX_SECONDS = 978_307_200

const PROJECTS_KEY_PATH = 'GrokBuild\\.projects\\.v1'
const SESSION_LAYOUT_KEY_PATH = 'GrokBuild\\.sessionLayout\\.v2'
const SESSION_MESSAGES_KEY_PATH = 'GrokBuild\\.sessionMessages\\.v1'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export type SwiftStateSection = 'projects' | 'session-layout' | 'session-messages'

export interface SwiftStateMigrationData {
  projects: ProjectSnapshot[]
  sessions: SessionSnapshot[]
  selectedSessionIdByProject: Record<string, string>
  selectedProjectId?: string
  selectedSessionId?: string
}

export interface SwiftStateMigrationSummary {
  projectsImported: number
  projectsSkipped: number
  sessionsImported: number
  sessionsSkipped: number
  transcriptItemsImported: number
  transcriptItemsSkipped: number
  unavailableSections: SwiftStateSection[]
}

export type SwiftStateMigrationErrorCode =
  | 'invalid-source'
  | 'source-too-large'
  | 'plutil-unavailable'
  | 'plutil-timeout'
  | 'plutil-output-limit'
  | 'invalid-plist'
  | 'invalid-project-data'
  | 'invalid-session-data'
  | 'invalid-message-data'

export type SwiftStateMigrationResult =
  | {
      ok: true
      data: SwiftStateMigrationData
      summary: SwiftStateMigrationSummary
    }
  | {
      ok: false
      error: { code: SwiftStateMigrationErrorCode; message: string }
      summary: SwiftStateMigrationSummary
    }

export interface PlutilRunRequest {
  args: readonly string[]
  timeoutMs: number
  maxOutputBytes: number
}

export interface PlutilRunResult {
  stdout: string
  exitCode: number | null
}

export interface PlutilRunner {
  run(request: PlutilRunRequest): Promise<PlutilRunResult>
}

type PlutilFailureKind = 'spawn' | 'timeout' | 'output-limit'

export class PlutilProcessError extends Error {
  constructor(readonly kind: PlutilFailureKind) {
    super('The bounded plist reader failed.')
    this.name = 'PlutilProcessError'
  }
}

/** Runs only Apple's fixed plutil binary with argv supplied by this module and no shell. */
class NodePlutilRunner implements PlutilRunner {
  async run(request: PlutilRunRequest): Promise<PlutilRunResult> {
    return await new Promise<PlutilRunResult>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(PLUTIL_PATH, [...request.args], {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch {
        reject(new PlutilProcessError('spawn'))
        return
      }

      const stdout: Buffer[] = []
      let outputBytes = 0
      let settled = false
      let terminationReason: Extract<PlutilFailureKind, 'timeout' | 'output-limit'> | undefined
      let killTimer: NodeJS.Timeout | undefined
      let failSafeTimer: NodeJS.Timeout | undefined
      const timeout = setTimeout(() => beginTermination('timeout'), request.timeoutMs)

      const clearTimers = (): void => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        if (failSafeTimer) clearTimeout(failSafeTimer)
      }

      const settleError = (error: PlutilProcessError): void => {
        if (settled) return
        settled = true
        clearTimers()
        child.stdout?.destroy()
        child.stderr?.destroy()
        reject(error)
      }

      const capture = (destination: Buffer[] | undefined, chunk: unknown): void => {
        if (settled || terminationReason) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        if (outputBytes + bytes.length > request.maxOutputBytes) {
          beginTermination('output-limit')
          return
        }
        outputBytes += bytes.length
        destination?.push(bytes)
      }

      function beginTermination(
        reason: Extract<PlutilFailureKind, 'timeout' | 'output-limit'>
      ): void {
        if (settled || terminationReason) return
        terminationReason = reason
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), PLUTIL_TERMINATE_GRACE_MS)
        failSafeTimer = setTimeout(
          () => settleError(new PlutilProcessError(reason)),
          PLUTIL_TERMINATE_GRACE_MS * 3
        )
      }

      child.stdout?.on('data', (chunk: unknown) => capture(stdout, chunk))
      // Stderr is deliberately bounded and discarded so diagnostics can never escape this boundary.
      child.stderr?.on('data', (chunk: unknown) => capture(undefined, chunk))
      child.once('error', () => settleError(new PlutilProcessError('spawn')))
      child.once('close', (exitCode) => {
        if (settled) return
        if (terminationReason) {
          settleError(new PlutilProcessError(terminationReason))
          return
        }
        settled = true
        clearTimers()
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), exitCode })
      })
    })
  }
}

export class SwiftStateMigrationService {
  private readonly runner: PlutilRunner

  constructor(runner: PlutilRunner = new NodePlutilRunner()) {
    this.runner = runner
  }

  /**
   * Reads exactly the plist selected by the caller. It never discovers a default,
   * writes migration state, or changes the Swift application's source plist.
   */
  async importFromPlist(plistPath: string): Promise<SwiftStateMigrationResult> {
    const summary = emptySummary()
    try {
      await validateSource(plistPath)
      const lint = await this.runPlutil(
        ['-lint', '--', plistPath],
        PLUTIL_LINT_MAX_OUTPUT_BYTES
      )
      if (lint.exitCode !== 0) throw new MigrationError('invalid-plist')

      const projectPayload = await this.extractData(
        plistPath,
        PROJECTS_KEY_PATH,
        'projects',
        summary
      )
      const sessionPayload = await this.extractData(
        plistPath,
        SESSION_LAYOUT_KEY_PATH,
        'session-layout',
        summary
      )
      const messageXml = await this.extractMessageDictionary(plistPath, summary)

      const rawProjects = projectPayload === undefined
        ? []
        : parseJsonArray(projectPayload, 'invalid-project-data')
      const rawLayout = sessionPayload === undefined
        ? emptyRawLayout()
        : parseLayout(sessionPayload)
      const messageBlobs = messageXml === undefined
        ? new Map<string, string>()
        : parseMessageDictionaryXml(messageXml)

      const projects = await migrateProjects(rawProjects, summary)
      const sessions = migrateSessions(rawLayout, projects, messageBlobs, summary)
      const sessionById = new Map(sessions.map((session) => [session.id, session]))
      const projectById = new Map(projects.map((project) => [project.id, project]))

      const selectedSession = normalizeUuid(rawLayout.selectedSessionID)
      const selectedProject = normalizeUuid(rawLayout.selectedWorkspaceID)
      const validSelectedSession = selectedSession ? sessionById.get(selectedSession) : undefined
      const validSelectedProject = selectedProject ? projectById.get(selectedProject) : undefined
      const resolvedSelectedProject = validSelectedProject
        ?? (validSelectedSession ? projectById.get(validSelectedSession.projectId) : undefined)
      const resolvedSelectedSession = validSelectedSession?.projectId === resolvedSelectedProject?.id
        ? validSelectedSession
        : undefined
      const selectedSessionIdByProject: Record<string, string> = {}
      for (const [projectId, sessionId] of rawLayout.selectedSessionIDByWorkspace) {
        const session = sessionById.get(sessionId)
        if (
          projectById.has(projectId) &&
          session?.projectId === projectId &&
          (session.acpSessionId || session.transcript.length > 0)
        ) {
          selectedSessionIdByProject[projectId] = sessionId
        }
      }

      return {
        ok: true,
        data: {
          projects,
          sessions,
          selectedSessionIdByProject,
          ...(resolvedSelectedProject ? { selectedProjectId: resolvedSelectedProject.id } : {}),
          ...(resolvedSelectedSession ? { selectedSessionId: resolvedSelectedSession.id } : {})
        },
        summary
      }
    } catch (error) {
      const code = migrationErrorCode(error)
      return { ok: false, error: { code, message: errorMessage(code) }, summary }
    }
  }

  private async extractData(
    plistPath: string,
    keyPath: string,
    section: SwiftStateSection,
    summary: SwiftStateMigrationSummary
  ): Promise<string | undefined> {
    const result = await this.runPlutil(
      ['-extract', keyPath, 'raw', '-expect', 'data', '-o', '-', '--', plistPath],
      PLUTIL_MAX_OUTPUT_BYTES
    )
    if (result.exitCode !== 0) {
      summary.unavailableSections.push(section)
      return undefined
    }
    return decodeBase64(result.stdout, section === 'projects'
      ? 'invalid-project-data'
      : 'invalid-session-data')
  }

  private async extractMessageDictionary(
    plistPath: string,
    summary: SwiftStateMigrationSummary
  ): Promise<string | undefined> {
    const result = await this.runPlutil(
      [
        '-extract', SESSION_MESSAGES_KEY_PATH, 'xml1', '-expect', 'dictionary',
        '-o', '-', '--', plistPath
      ],
      PLUTIL_MAX_OUTPUT_BYTES
    )
    if (result.exitCode !== 0) {
      summary.unavailableSections.push('session-messages')
      return undefined
    }
    return result.stdout
  }

  private async runPlutil(
    args: readonly string[],
    maxOutputBytes: number
  ): Promise<PlutilRunResult> {
    try {
      return await this.runner.run({ args, timeoutMs: PLUTIL_TIMEOUT_MS, maxOutputBytes })
    } catch (error) {
      if (error instanceof PlutilProcessError) {
        if (error.kind === 'timeout') throw new MigrationError('plutil-timeout')
        if (error.kind === 'output-limit') throw new MigrationError('plutil-output-limit')
      }
      throw new MigrationError('plutil-unavailable')
    }
  }
}

class MigrationError extends Error {
  constructor(readonly code: SwiftStateMigrationErrorCode) {
    super('Swift state migration failed safely.')
    this.name = 'MigrationError'
  }
}

interface RawLayout {
  records: unknown[]
  sessionOrderByWorkspace: Map<string, string[]>
  selectedSessionIDByWorkspace: Map<string, string>
  selectedSessionID?: unknown
  selectedWorkspaceID?: unknown
}

async function validateSource(plistPath: string): Promise<void> {
  if (!plistPath || plistPath.length > 4_096 || !isAbsolute(plistPath)) {
    throw new MigrationError('invalid-source')
  }
  try {
    const source = await stat(plistPath)
    if (!source.isFile()) throw new MigrationError('invalid-source')
    if (source.size > PLIST_MAX_BYTES) throw new MigrationError('source-too-large')
  } catch (error) {
    if (error instanceof MigrationError) throw error
    throw new MigrationError('invalid-source')
  }
}

async function migrateProjects(
  records: unknown[],
  summary: SwiftStateMigrationSummary
): Promise<ProjectSnapshot[]> {
  const projects: ProjectSnapshot[] = []
  const projectIds = new Set<string>()
  const projectPaths = new Set<string>()
  const boundedRecords = records.slice(0, MAX_PROJECTS)
  summary.projectsSkipped += Math.max(0, records.length - boundedRecords.length)

  for (const raw of boundedRecords) {
    const record = asRecord(raw)
    const id = normalizeUuid(record?.id)
    const url = typeof record?.path === 'string' && record.path.length <= 8_192
      ? parseLocalFileUrl(record.path)
      : undefined
    if (!id || !url || projectIds.has(id)) {
      summary.projectsSkipped += 1
      continue
    }
    try {
      const path = await realpath(url)
      const info = await stat(path)
      if (!info.isDirectory() || path.length > 4_096 || projectPaths.has(path)) {
        summary.projectsSkipped += 1
        continue
      }
      const rawName = typeof record?.name === 'string' ? record.name.trim() : ''
      const name = boundedText(rawName || basename(path) || 'Imported project', MAX_TITLE)
      projects.push({ id, name, path, sessionIds: [], createdAt: UNKNOWN_CREATED_AT })
      projectIds.add(id)
      projectPaths.add(path)
      summary.projectsImported += 1
    } catch {
      summary.projectsSkipped += 1
    }
  }
  return projects
}

function migrateSessions(
  layout: RawLayout,
  projects: ProjectSnapshot[],
  messageBlobs: Map<string, string>,
  summary: SwiftStateMigrationSummary
): SessionSnapshot[] {
  const projectById = new Map(projects.map((project) => [project.id, project]))
  const sessionById = new Map<string, SessionSnapshot>()
  const recordOrder: string[] = []
  const projectOrdinal = new Map<string, number>()
  const boundedRecords = layout.records.slice(0, MAX_SESSIONS)
  summary.sessionsSkipped += Math.max(0, layout.records.length - boundedRecords.length)

  for (const raw of boundedRecords) {
    const record = asRecord(raw)
    const id = normalizeUuid(record?.id)
    const projectId = normalizeUuid(record?.workspaceID)
    const project = projectId ? projectById.get(projectId) : undefined
    const timestamp = parseSwiftDate(record?.lastAccessed)
    if (!id || !project || !timestamp || sessionById.has(id)) {
      summary.sessionsSkipped += 1
      continue
    }

    const ordinal = (projectOrdinal.get(project.id) ?? 0) + 1
    projectOrdinal.set(project.id, ordinal)
    const rawTitle = typeof record?.title === 'string' ? record.title.trim() : ''
    const rawModel = typeof record?.model === 'string' ? record.model.trim() : ''
    const rawAcpSessionId = typeof record?.grokSessionID === 'string'
      ? record.grokSessionID.trim()
      : ''
    const transcript = migrateTranscript(id, messageBlobs.get(id), summary)
    const session: SessionSnapshot = {
      id,
      ...(rawAcpSessionId && rawAcpSessionId.length <= MAX_IDENTIFIER
        ? { acpSessionId: rawAcpSessionId }
        : {}),
      projectId: project.id,
      title: boundedText(rawTitle || `New chat ${ordinal}`, MAX_TITLE),
      status: 'idle',
      model: boundedText(rawModel || 'grok-4.6', 128),
      mode: 'default',
      reasoningEffort: 'xhigh',
      permissionMode: 'ask',
      contextUsed: 0,
      contextLimit: 500_000,
      transcript,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    sessionById.set(id, session)
    recordOrder.push(id)
    summary.sessionsImported += 1
  }

  const orderedIds = new Set<string>()
  for (const project of projects) {
    const requestedOrder = layout.sessionOrderByWorkspace.get(project.id) ?? []
    for (const sessionId of [...requestedOrder, ...recordOrder]) {
      const session = sessionById.get(sessionId)
      if (session?.projectId === project.id && !orderedIds.has(sessionId)) {
        project.sessionIds.push(sessionId)
        orderedIds.add(sessionId)
      }
    }
  }
  return [...orderedIds].map((id) => sessionById.get(id) as SessionSnapshot)
}

function migrateTranscript(
  sessionId: string,
  encoded: string | undefined,
  summary: SwiftStateMigrationSummary
): TranscriptItem[] {
  if (encoded === undefined) return []
  let rawMessages: unknown[]
  try {
    rawMessages = parseJsonArray(decodeBase64(encoded, 'invalid-message-data'), 'invalid-message-data')
  } catch {
    // One malformed transcript must not prevent otherwise valid projects and sessions importing.
    summary.transcriptItemsSkipped += 1
    return []
  }

  const transcript: TranscriptItem[] = []
  const itemIds = new Set<string>()
  const boundedMessages = rawMessages.slice(0, MAX_TRANSCRIPT_ITEMS)
  summary.transcriptItemsSkipped += Math.max(0, rawMessages.length - boundedMessages.length)
  for (const raw of boundedMessages) {
    if (transcript.length >= MAX_TRANSCRIPT_ITEMS) {
      summary.transcriptItemsSkipped += 1
      continue
    }
    const record = asRecord(raw)
    const id = normalizeUuid(record?.id)
    const role = record?.role
    const timestamp = parseSwiftDate(record?.timestamp)
    if (
      !id || itemIds.has(id) || !timestamp || typeof record?.content !== 'string' ||
      Buffer.byteLength(record.content, 'utf8') > MAX_MESSAGE_BYTES ||
      (role !== 'user' && role !== 'assistant' && role !== 'system')
    ) {
      summary.transcriptItemsSkipped += 1
      continue
    }

    const text = boundedText(
      record.content,
      role === 'system' ? MAX_NOTICE_TEXT : MAX_MESSAGE_TEXT
    )
    transcript.push(role === 'system'
      ? { id, kind: 'notice', text, createdAt: timestamp }
      : { id, kind: 'message', role, text, createdAt: timestamp })
    itemIds.add(id)
    summary.transcriptItemsImported += 1

    if (role !== 'assistant' || !Array.isArray(record.parts)) continue
    const boundedParts = record.parts.slice(0, MAX_TRANSCRIPT_ITEMS)
    summary.transcriptItemsSkipped += Math.max(0, record.parts.length - boundedParts.length)
    for (const [index, part] of boundedParts.entries()) {
      if (transcript.length >= MAX_TRANSCRIPT_ITEMS) {
        summary.transcriptItemsSkipped += 1
        break
      }
      const activity = asRecord(part)
      if (activity?.type !== 'activity' || typeof activity.summary !== 'string') continue
      const entries = parsePersistedActivitySummary(activity.summary)
      if (entries.length === 0) {
        summary.transcriptItemsSkipped += 1
        continue
      }
      const activityId = `${sessionId}:${id}:activity:${index}`
      transcript.push({
        id: boundedText(activityId, MAX_IDENTIFIER),
        kind: 'activity',
        entries,
        hookCount: typeof activity.hookCount === 'number'
          ? boundedActivityCount(activity.hookCount)
          : 0,
        isLead: activity.isLead === true,
        createdAt: timestamp
      })
      summary.transcriptItemsImported += 1
    }
  }
  return transcript
}

function parseLayout(json: string): RawLayout {
  try {
    const raw = asRecord(JSON.parse(json))
    if (!raw || !Array.isArray(raw.records)) throw new Error('invalid')
    return {
      records: raw.records,
      sessionOrderByWorkspace: parseUuidArrayDictionary(raw.sessionOrderByWorkspace),
      selectedSessionIDByWorkspace: parseUuidDictionary(raw.selectedSessionIDByWorkspace),
      ...(raw.selectedSessionID !== undefined ? { selectedSessionID: raw.selectedSessionID } : {}),
      ...(raw.selectedWorkspaceID !== undefined ? { selectedWorkspaceID: raw.selectedWorkspaceID } : {})
    }
  } catch {
    throw new MigrationError('invalid-session-data')
  }
}

function parseUuidDictionary(value: unknown): Map<string, string> {
  const result = new Map<string, string>()
  if (Array.isArray(value)) {
    if (value.length % 2 !== 0 || value.length > MAX_PROJECTS * 2) return result
    for (let index = 0; index < value.length; index += 2) {
      addUuidDictionaryEntry(result, value[index], value[index + 1])
    }
    return result
  }
  const record = asRecord(value)
  if (!record) return result
  for (const [key, rawValue] of Object.entries(record).slice(0, MAX_PROJECTS)) {
    addUuidDictionaryEntry(result, key, rawValue)
  }
  return result
}

function addUuidDictionaryEntry(
  result: Map<string, string>,
  rawKey: unknown,
  rawValue: unknown
): void {
  const key = normalizeUuid(rawKey)
  const value = normalizeUuid(rawValue)
  if (key && value && !result.has(key)) result.set(key, value)
}

function parseUuidArrayDictionary(value: unknown): Map<string, string[]> {
  const result = new Map<string, string[]>()
  if (Array.isArray(value)) {
    if (value.length % 2 !== 0 || value.length > MAX_PROJECTS * 2) return result
    for (let index = 0; index < value.length; index += 2) {
      addUuidArrayDictionaryEntry(result, value[index], value[index + 1])
    }
    return result
  }
  const record = asRecord(value)
  if (!record) return result
  for (const [key, ids] of Object.entries(record).slice(0, MAX_PROJECTS)) {
    addUuidArrayDictionaryEntry(result, key, ids)
  }
  return result
}

function addUuidArrayDictionaryEntry(
  result: Map<string, string[]>,
  rawKey: unknown,
  rawIds: unknown
): void {
  const key = normalizeUuid(rawKey)
  if (!key || !Array.isArray(rawIds)) return
  const ids: string[] = []
  const seen = new Set<string>()
  for (const rawId of rawIds.slice(0, MAX_SESSIONS)) {
    const id = normalizeUuid(rawId)
    if (id && !seen.has(id)) {
      ids.push(id)
      seen.add(id)
    }
  }
  result.set(key, ids)
}

function parseMessageDictionaryXml(xml: string): Map<string, string> {
  const outer = /<plist\s+version="1\.0">\s*<dict>([\s\S]*?)<\/dict>\s*<\/plist>\s*$/.exec(xml)
  if (!outer || outer[1] === undefined) throw new MigrationError('invalid-message-data')
  const body = outer[1]
  const pair = /\s*<key>([0-9A-Fa-f-]+)<\/key>\s*<data>\s*([A-Za-z0-9+/=\s]*)<\/data>/gy
  const result = new Map<string, string>()
  let cursor = 0
  while (cursor < body.length) {
    pair.lastIndex = cursor
    const match = pair.exec(body)
    if (!match || match.index !== cursor) {
      if (body.slice(cursor).trim() === '') break
      throw new MigrationError('invalid-message-data')
    }
    const key = normalizeUuid(match[1])
    if (!key || result.has(key) || result.size >= MAX_SESSIONS) {
      throw new MigrationError('invalid-message-data')
    }
    const encoded = normalizeBase64(match[2] ?? '', 'invalid-message-data')
    result.set(key, encoded)
    cursor = pair.lastIndex
  }
  return result
}

function parseJsonArray(json: string, code: SwiftStateMigrationErrorCode): unknown[] {
  try {
    const value: unknown = JSON.parse(json)
    if (!Array.isArray(value)) throw new Error('invalid')
    return value
  } catch {
    throw new MigrationError(code)
  }
}

function decodeBase64(encoded: string, code: SwiftStateMigrationErrorCode): string {
  const normalized = normalizeBase64(encoded, code)
  const decoded = Buffer.from(normalized, 'base64')
  if (decoded.byteLength > PLIST_MAX_BYTES) throw new MigrationError(code)
  return decoded.toString('utf8')
}

function normalizeBase64(encoded: string, code: SwiftStateMigrationErrorCode): string {
  const normalized = encoded.replace(/\s/g, '')
  if (!normalized || normalized.length > PLUTIL_MAX_OUTPUT_BYTES || !BASE64_PATTERN.test(normalized)) {
    throw new MigrationError(code)
  }
  return normalized
}

function parseLocalFileUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:' || url.username || url.password || (url.hostname && url.hostname !== 'localhost')) {
      return undefined
    }
    const path = fileURLToPath(url)
    return isAbsolute(path) ? path : undefined
  } catch {
    return undefined
  }
}

function parseSwiftDate(value: unknown): string | undefined {
  let date: Date
  if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date((value + APPLE_REFERENCE_DATE_UNIX_SECONDS) * 1_000)
  } else if (typeof value === 'string' && value.length <= 64) {
    date = new Date(value)
  } else {
    return undefined
  }
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function normalizeUuid(value: unknown): string | undefined {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return undefined
  return value.toLowerCase()
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function emptyRawLayout(): RawLayout {
  return {
    records: [],
    sessionOrderByWorkspace: new Map(),
    selectedSessionIDByWorkspace: new Map()
  }
}

function emptySummary(): SwiftStateMigrationSummary {
  return {
    projectsImported: 0,
    projectsSkipped: 0,
    sessionsImported: 0,
    sessionsSkipped: 0,
    transcriptItemsImported: 0,
    transcriptItemsSkipped: 0,
    unavailableSections: []
  }
}

function migrationErrorCode(error: unknown): SwiftStateMigrationErrorCode {
  return error instanceof MigrationError ? error.code : 'invalid-plist'
}

function errorMessage(code: SwiftStateMigrationErrorCode): string {
  switch (code) {
    case 'invalid-source': return 'The selected Swift state file is unavailable.'
    case 'source-too-large': return 'The selected Swift state file exceeds the migration limit.'
    case 'plutil-unavailable': return 'The macOS property-list reader is unavailable.'
    case 'plutil-timeout': return 'Reading the Swift state timed out.'
    case 'plutil-output-limit': return 'The Swift state exceeds the extraction limit.'
    case 'invalid-project-data': return 'The Swift project data is not valid.'
    case 'invalid-session-data': return 'The Swift session data is not valid.'
    case 'invalid-message-data': return 'The Swift transcript data is not valid.'
    case 'invalid-plist': return 'The selected Swift state is not a valid property list.'
  }
}
