import type { SessionSnapshot, TranscriptItem } from '../models'
import type { NormalizedAcpEvent } from '../acp/events'
import {
  MAX_ACTIVITY_COUNT,
  addActivityKind,
  formatActivityLine,
  type ActivityEntry,
  type ActivityKind
} from '../acp/activity'

const maxStreamingTextChars = 2 * 1024 * 1024
const maxTranscriptItems = 4_000
const maxTranscriptChars = 8 * 1024 * 1024

function now(): string {
  return new Date().toISOString()
}

function appendStreaming(
  transcript: TranscriptItem[],
  kind: 'message' | 'thought',
  text: string,
  mergeIntoCompletedAssistant = false
): TranscriptItem[] {
  const last = transcript.at(-1)
  if (kind === 'message' && last?.kind === 'message' && last.role === 'assistant' && last.streaming) {
    return boundTranscript([
      ...transcript.slice(0, -1),
      { ...last, text: appendBounded(last.text, text) }
    ])
  }
  if (kind === 'message' && mergeIntoCompletedAssistant) {
    const assistantIndex = findLastAssistantSinceUser(transcript)
    if (assistantIndex >= 0) {
      return boundTranscript(transcript.map((item, index) =>
        index === assistantIndex && item.kind === 'message' && item.role === 'assistant'
          ? { ...item, text: appendBounded(item.text, text), streaming: false }
          : item
      ))
    }
  }
  if (kind === 'thought' && last?.kind === 'thought' && last.streaming) {
    return boundTranscript([
      ...transcript.slice(0, -1),
      { ...last, text: appendBounded(last.text, text) }
    ])
  }
  const createdAt = now()
  if (kind === 'message') {
    return boundTranscript([
      ...transcript,
      { id: crypto.randomUUID(), kind, role: 'assistant', text: appendBounded('', text), createdAt, streaming: true }
    ])
  }
  return boundTranscript([
    ...transcript,
    { id: crypto.randomUUID(), kind, text: appendBounded('', text), createdAt, streaming: true }
  ])
}

function closeStreaming(transcript: TranscriptItem[]): TranscriptItem[] {
  return transcript.map((item) =>
    'streaming' in item && item.streaming ? { ...item, streaming: false } : item
  )
}

export function applyAcpEvent(session: SessionSnapshot, event: NormalizedAcpEvent): SessionSnapshot {
  const updatedAt = now()
  switch (event.type) {
    case 'assistant_delta': {
      const arrivedAfterCompletion = session.status === 'idle'
      return {
        ...session,
        status: arrivedAfterCompletion ? 'idle' : 'running',
        transcript: appendStreaming(
          closeOpenActivities(session.transcript),
          'message',
          event.text,
          arrivedAfterCompletion
        ),
        updatedAt
      }
    }
    case 'thought_delta':
      return {
        ...session,
        status: 'running',
        transcript: appendStreaming(session.transcript, 'thought', event.text),
        updatedAt
      }
    case 'tool_start': {
      const withTool: TranscriptItem[] = [
        ...closeStreaming(session.transcript),
        {
          id: event.id,
          kind: 'tool',
          title: event.title,
          status: 'running',
          ...(event.detail ? { detail: event.detail } : {}),
          ...(event.activityKind ? { activityKind: event.activityKind } : {}),
          createdAt: updatedAt
        }
      ]
      const folded = foldNewToolActivity(
        withTool,
        event.activityKind,
        session.pendingHookRuns ?? 0,
        updatedAt
      )
      return withoutPendingHooks({
        ...session,
        status: 'running',
        transcript: boundTranscript(folded.transcript),
        updatedAt
      }, folded.attached ? 0 : session.pendingHookRuns ?? 0)
    }
    case 'tool_update': {
      let previousKind: ActivityKind | undefined
      let targetIndex = -1
      const patched = session.transcript.map((item, index): TranscriptItem => {
        if (item.kind !== 'tool' || item.id !== event.id) return item
        targetIndex = index
        previousKind = item.activityKind
        return {
          ...item,
          status: event.status,
          ...(event.detail ? { detail: event.detail } : {}),
          ...(event.title ? { title: event.title } : {}),
          ...(event.activityKind ? { activityKind: event.activityKind } : {})
        }
      })
      const activityKind = event.activityKind
      const folded = targetIndex >= 0 && activityKind
        ? foldUpdatedToolActivity(
            patched,
            targetIndex,
            previousKind,
            activityKind,
            session.status === 'running',
            session.pendingHookRuns ?? 0,
            updatedAt
          )
        : { transcript: patched, attached: false }
      return withoutPendingHooks({
        ...session,
        transcript: boundTranscript(folded.transcript),
        updatedAt
      }, folded.attached ? 0 : session.pendingHookRuns ?? 0)
    }
    case 'hook_execution':
      return applyHookExecution(session, event.hook, event.runCount, updatedAt)
    case 'plan':
      return {
        ...session,
        transcript: boundTranscript([
          ...closeStreaming(session.transcript),
          { id: crypto.randomUUID(), kind: 'plan', entries: event.entries, createdAt: updatedAt }
        ]),
        updatedAt
      }
    case 'context_usage':
      return {
        ...session,
        contextUsed: event.used,
        ...(event.limit !== undefined ? { contextLimit: event.limit } : {}),
        updatedAt
      }
    case 'turn_usage':
      return { ...session, lastTurnUsage: event.usage, updatedAt }
    case 'mode_changed':
      return {
        ...session,
        mode: event.mode,
        ...(event.permissionMode ? { permissionMode: event.permissionMode } : {}),
        updatedAt
      }
    case 'turn_complete':
      return withoutPendingHooks({
        ...session,
        status: 'idle',
        transcript: closeOpenActivities(closeStreaming(session.transcript)),
        updatedAt
      }, 0)
    case 'unknown':
      return session
  }
}

function findLastAssistantSinceUser(transcript: TranscriptItem[]): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index]
    if (item?.kind === 'message' && item.role === 'user') return -1
    if (item?.kind === 'message' && item.role === 'assistant') return index
  }
  return -1
}

export function appendUserMessage(session: SessionSnapshot, text: string): SessionSnapshot {
  const createdAt = now()
  return withoutPendingHooks({
    ...session,
    status: 'running',
    transcript: boundTranscript([
      ...closeOpenActivities(closeStreaming(session.transcript)),
      { id: crypto.randomUUID(), kind: 'message', role: 'user', text, createdAt }
    ]),
    updatedAt: createdAt
  }, 0)
}

export function appendSessionError(session: SessionSnapshot, error: string): SessionSnapshot {
  const createdAt = now()
  return {
    ...session,
    status: 'failed',
    lastError: error.slice(0, 64 * 1024),
    transcript: boundTranscript([
      ...closeOpenActivities(closeStreaming(session.transcript)),
      { id: crypto.randomUUID(), kind: 'error', text: error.slice(0, 64 * 1024), createdAt }
    ]),
    updatedAt: createdAt
  }
}

export function appendSessionNotice(session: SessionSnapshot, text: string): SessionSnapshot {
  const createdAt = now()
  return {
    ...session,
    transcript: boundTranscript([
      ...closeStreaming(session.transcript),
      { id: crypto.randomUUID(), kind: 'notice', text: text.slice(0, 64 * 1024), createdAt }
    ]),
    updatedAt: createdAt
  }
}

function appendBounded(current: string, addition: string): string {
  const marker = '\n[…stream output truncated…]'
  if (current.endsWith(marker)) return current
  const available = maxStreamingTextChars - current.length
  if (addition.length <= available) return current + addition
  return `${current}${addition.slice(0, Math.max(0, available - marker.length))}${marker}`
}

type ActivityItem = Extract<TranscriptItem, { kind: 'activity' }>

function closeOpenActivities(transcript: TranscriptItem[]): TranscriptItem[] {
  return transcript.map((item) => item.kind === 'activity' && item.open
    ? { ...item, open: false }
    : item)
}

function foldNewToolActivity(
  transcript: TranscriptItem[],
  kind: ActivityKind | undefined,
  pendingHookRuns: number,
  createdAt: string
): { transcript: TranscriptItem[]; attached: boolean } {
  if (!kind) return { transcript, attached: false }
  const openIndex = findLastOpenActivity(transcript)
  if (openIndex >= 0) {
    return {
      transcript: transcript.map((item, index) => index === openIndex && item.kind === 'activity'
        ? {
            ...item,
            entries: addActivityKind(item.entries, kind),
            hookCount: addBoundedCount(item.hookCount, pendingHookRuns)
          }
        : item),
      attached: true
    }
  }

  const toolIndex = transcript.length - 1
  const activity: ActivityItem = {
    id: crypto.randomUUID(),
    kind: 'activity',
    entries: [{ kind, count: 1 }],
    hookCount: boundedCount(pendingHookRuns),
    isLead: isLeadActivity(transcript, toolIndex),
    open: true,
    createdAt
  }
  return {
    transcript: [
      ...transcript.slice(0, toolIndex),
      activity,
      ...transcript.slice(toolIndex)
    ],
    attached: true
  }
}

function foldUpdatedToolActivity(
  transcript: TranscriptItem[],
  targetIndex: number,
  previousKind: ActivityKind | undefined,
  nextKind: ActivityKind,
  allowCreate: boolean,
  pendingHookRuns: number,
  createdAt: string
): { transcript: TranscriptItem[]; attached: boolean } {
  const openIndex = findLastOpenActivity(transcript)
  if (openIndex >= 0 && targetIndex > openIndex) {
    return {
      transcript: transcript.map((item, index) => {
        if (index !== openIndex || item.kind !== 'activity') return item
        const entries = previousKind && previousKind !== nextKind
          ? replaceActivityKind(item.entries, previousKind, nextKind)
          : previousKind
            ? item.entries
            : addActivityKind(item.entries, nextKind)
        return {
          ...item,
          entries,
          hookCount: addBoundedCount(item.hookCount, pendingHookRuns)
        }
      }),
      attached: true
    }
  }
  if (!allowCreate) return { transcript, attached: false }

  const boundary = findActivityBoundaryBefore(transcript, targetIndex)
  if (targetIndex <= boundary) return { transcript, attached: false }
  let insertionIndex = targetIndex
  for (let index = boundary + 1; index <= targetIndex; index += 1) {
    if (transcript[index]?.kind === 'tool') {
      insertionIndex = index
      break
    }
  }
  const activity: ActivityItem = {
    id: crypto.randomUUID(),
    kind: 'activity',
    entries: [{ kind: nextKind, count: 1 }],
    hookCount: boundedCount(pendingHookRuns),
    isLead: isLeadActivity(transcript, insertionIndex),
    open: true,
    createdAt
  }
  return {
    transcript: [
      ...transcript.slice(0, insertionIndex),
      activity,
      ...transcript.slice(insertionIndex)
    ],
    attached: true
  }
}

function applyHookExecution(
  session: SessionSnapshot,
  hook: 'user_prompt_submit' | 'pre_tool_use' | 'post_tool_use' | 'stop' | 'session_start' | 'session_end' | 'other',
  runCount: number,
  updatedAt: string
): SessionSnapshot {
  const count = boundedCount(runCount)
  if (hook === 'session_start' || hook === 'session_end' || hook === 'post_tool_use') {
    return session
  }
  if (hook === 'user_prompt_submit') {
    return withoutPendingHooks(
      { ...session, updatedAt },
      addBoundedCount(session.pendingHookRuns ?? 0, count)
    )
  }
  if (hook === 'stop') {
    const closed = closeOpenActivities(session.transcript)
    const stop: ActivityItem = {
      id: crypto.randomUUID(),
      kind: 'activity',
      entries: [{ kind: 'stop', count: 1 }],
      hookCount: count,
      isLead: isLeadActivity(closed, closed.length),
      open: false,
      createdAt: updatedAt
    }
    return withoutPendingHooks({
      ...session,
      transcript: boundTranscript([...closed, stop]),
      updatedAt
    }, 0)
  }

  const openIndex = findLastOpenActivity(session.transcript)
  if (openIndex < 0) {
    return withoutPendingHooks(
      { ...session, updatedAt },
      addBoundedCount(session.pendingHookRuns ?? 0, count)
    )
  }
  return {
    ...session,
    transcript: session.transcript.map((item, index) =>
      index === openIndex && item.kind === 'activity'
        ? { ...item, hookCount: addBoundedCount(item.hookCount, count) }
        : item
    ),
    updatedAt
  }
}

function findLastOpenActivity(transcript: readonly TranscriptItem[]): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index]
    if (item?.kind === 'activity' && item.open) return index
  }
  return -1
}

function findActivityBoundaryBefore(transcript: readonly TranscriptItem[], beforeIndex: number): number {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const item = transcript[index]
    if (item?.kind === 'message' || item?.kind === 'activity') return index
  }
  return -1
}

function isLeadActivity(transcript: readonly TranscriptItem[], beforeIndex: number): boolean {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const item = transcript[index]
    if (item?.kind === 'message' && item.role === 'user') return true
    if (item?.kind === 'activity') return false
  }
  return true
}

function replaceActivityKind(
  entries: readonly ActivityEntry[],
  previousKind: ActivityKind,
  nextKind: ActivityKind
): ActivityEntry[] {
  if (previousKind === nextKind) return [...entries]
  const previousIndex = entries.findIndex((entry) => entry.kind === previousKind)
  if (previousIndex < 0) return addActivityKind(entries, nextKind)
  const previous = entries[previousIndex]
  if (!previous) return addActivityKind(entries, nextKind)
  let remaining = previous.count > 1
    ? entries.map((entry, index) => index === previousIndex ? { ...entry, count: entry.count - 1 } : entry)
    : entries.filter((_entry, index) => index !== previousIndex)
  const existingNext = remaining.findIndex((entry) => entry.kind === nextKind)
  if (existingNext >= 0) return addActivityKind(remaining, nextKind)
  remaining = [...remaining]
  remaining.splice(Math.min(previousIndex, remaining.length), 0, { kind: nextKind, count: 1 })
  return remaining
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_ACTIVITY_COUNT, Math.trunc(value))
}

function addBoundedCount(left: number, right: number): number {
  return Math.min(MAX_ACTIVITY_COUNT, boundedCount(left) + boundedCount(right))
}

function withoutPendingHooks(session: SessionSnapshot, count: number): SessionSnapshot {
  const { pendingHookRuns: _pendingHookRuns, ...rest } = session
  const bounded = boundedCount(count)
  return bounded > 0 ? { ...rest, pendingHookRuns: bounded } : rest
}

function boundTranscript(transcript: TranscriptItem[]): TranscriptItem[] {
  let remainingChars = maxTranscriptChars
  let start = transcript.length
  const minimumIndex = Math.max(0, transcript.length - maxTranscriptItems)
  while (start > minimumIndex) {
    const item = transcript[start - 1]
    if (!item) break
    const size = transcriptItemChars(item)
    if (size > remainingChars && start < transcript.length) break
    remainingChars -= Math.min(size, remainingChars)
    start -= 1
    if (remainingChars <= 0) break
  }
  return start === 0 ? transcript : transcript.slice(start)
}

function transcriptItemChars(item: TranscriptItem): number {
  switch (item.kind) {
    case 'message':
    case 'thought':
    case 'error':
    case 'notice':
      return item.text.length
    case 'tool':
      return item.title.length + (item.detail?.length ?? 0)
    case 'activity':
      return formatActivityLine(item.entries, item.hookCount).length
    case 'plan':
      return item.entries.reduce((total, entry) => total + entry.text.length, 0)
  }
}
