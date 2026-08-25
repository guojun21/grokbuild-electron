import { z } from 'zod'

/**
 * Activity state is deliberately semantic. Tool titles are inspected once to
 * select one of these fixed labels; paths, commands, environment values, and
 * arbitrary hook names never enter the activity transcript item.
 */
export const activityKindSchema = z.enum([
  'read_skill',
  'read_file',
  'listed',
  'edited',
  'searched',
  'fetched',
  'ran',
  'computer_use',
  'subagent',
  'other',
  'stop'
])

export type ActivityKind = z.infer<typeof activityKindSchema>

export const MAX_ACTIVITY_COUNT = 10_000
const MAX_PERSISTED_ACTIVITY_SUMMARY_CHARS = 2_000

export const activityEntrySchema = z.object({
  kind: activityKindSchema,
  count: z.number().int().positive().max(MAX_ACTIVITY_COUNT)
}).strict()

export type ActivityEntry = z.infer<typeof activityEntrySchema>

export const hookKindSchema = z.enum([
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
  'stop',
  'session_start',
  'session_end',
  'other'
])

export type HookKind = z.infer<typeof hookKindSchema>

export const hookExecutionEventSchema = z.object({
  type: z.literal('hook_execution'),
  hook: hookKindSchema,
  runCount: z.number().int().nonnegative().max(MAX_ACTIVITY_COUNT)
}).strict()

export type HookExecutionEvent = z.infer<typeof hookExecutionEventSchema>

/** Port of the pinned Swift GrokActivitySummary classifier, with one hardening. */
export function classifyToolActivity(title: string): ActivityKind | undefined {
  const trimmed = title.trim()
  if (!trimmed || isPlaceholderToolTitle(trimmed)) return undefined
  const lower = trimmed.toLocaleLowerCase('en-US')

  if (startsWithAny(lower, ['read ', 'reading '])) {
    return lower.includes('skill.md') ? 'read_skill' : 'read_file'
  }
  if (startsWithAny(lower, ['list ', 'listed ', 'listing '])) return 'listed'
  if (startsWithAny(lower, ['edit ', 'edited ', 'editing ', 'write ', 'wrote '])) return 'edited'
  if (startsWithAny(lower, ['search ', 'searched ', 'searching ', 'grep ', 'rg '])) return 'searched'
  if (startsWithAny(lower, ['fetch ', 'fetched ', 'fetching ']) || lower.startsWith('fetch')) return 'fetched'
  if (startsWithAny(lower, ['ran ', 'running ', 'execute ', 'exec '])) return 'ran'

  // Regexes and JSON query fragments are always projected to a fixed label.
  if (looksLikeSearchPattern(trimmed)) return 'searched'
  if (
    lower.startsWith('[subagent') || lower.startsWith('subagent:') ||
    lower.startsWith('subagent ') || lower.startsWith('spawn_subagent')
  ) return 'subagent'
  if (lower.startsWith('computer_') || lower.startsWith('computer ') || lower === 'computer') {
    return 'computer_use'
  }

  const slug = (trimmed.split(/\s/u, 1)[0] ?? '').toLocaleLowerCase('en-US')
  if (slug === 'read_file' || slug === 'read') {
    return lower.includes('skill.md') ? 'read_skill' : 'read_file'
  }
  if (slug === 'list_dir' || slug === 'list') return 'listed'
  if (slug === 'write_file' || slug === 'write' || slug === 'edit') return 'edited'
  if (['grep', 'rg', 'glob', 'web_search', 'websearch', 'search', 'searched'].includes(slug)) return 'searched'
  if (slug === 'get' || slug === 'web_fetch' || slug === 'webfetch') return 'fetched'
  if (['bash', 'shell', 'sh', 'zsh', 'spawn', 'run'].includes(slug)) return 'ran'
  if (slug.startsWith('computer')) return 'computer_use'
  if (slug.startsWith('subagent') || slug.startsWith('[subagent')) return 'subagent'

  // Swift preserves a short unknown label. Electron intentionally does not:
  // even a short first word can be a command, path component, or secret name.
  return 'other'
}

export function normalizeHookKind(value: unknown): HookKind {
  if (typeof value !== 'string') return 'other'
  switch (value.trim().toLocaleLowerCase('en-US')) {
    case 'user_prompt_submit':
    case 'pre_tool_use':
    case 'post_tool_use':
    case 'stop':
    case 'session_start':
    case 'session_end':
      return value.trim().toLocaleLowerCase('en-US') as HookKind
    default:
      return 'other'
  }
}

export function boundedActivityCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_ACTIVITY_COUNT, Math.trunc(value))
}

export function addActivityKind(
  entries: readonly ActivityEntry[],
  kind: ActivityKind,
  count = 1
): ActivityEntry[] {
  const increment = boundedActivityCount(count)
  if (increment === 0) return [...entries]
  const index = entries.findIndex((entry) => entry.kind === kind)
  if (index < 0) return [...entries, { kind, count: increment }]
  return entries.map((entry, entryIndex) => entryIndex === index
    ? { ...entry, count: Math.min(MAX_ACTIVITY_COUNT, entry.count + increment) }
    : entry)
}

/**
 * Rehydrates a persisted Swift activity summary without retaining any source
 * text. Canonical CLI clauses keep their counts; older raw tool titles are
 * classified through the same fixed semantic projection used for live tools.
 */
export function parsePersistedActivitySummary(summary: string): ActivityEntry[] {
  if (!/\S/u.test(summary)) return []
  const trimmed = summary.slice(0, MAX_PERSISTED_ACTIVITY_SUMMARY_CHARS).trim()
  if (!trimmed) return [{ kind: 'other', count: 1 }]
  let entries: ActivityEntry[] = []
  for (const rawClause of trimmed.split(',').slice(0, 256)) {
    const clause = rawClause.trim()
    if (!clause) continue
    const canonical = parseCanonicalActivityClause(clause)
    if (canonical) {
      entries = addActivityKind(entries, canonical.kind, canonical.count)
      continue
    }
    const legacy = splitLegacyCountSuffix(clause)
    entries = addActivityKind(
      entries,
      classifyToolActivity(legacy.title) ?? 'other',
      legacy.count
    )
  }
  // A non-empty but unparseable historical label is represented by one fixed
  // generic bucket. The raw label must never be persisted or rendered.
  return entries.length > 0 ? entries : [{ kind: 'other', count: 1 }]
}

/** Formats only fixed semantic labels while preserving Swift's first-verb order. */
export function formatActivitySummary(entries: readonly ActivityEntry[]): string {
  const counts = new Map<ActivityKind, number>()
  const verbOrder: string[] = []
  for (const entry of entries) {
    const count = boundedActivityCount(entry.count)
    if (count === 0) continue
    counts.set(entry.kind, Math.min(MAX_ACTIVITY_COUNT, (counts.get(entry.kind) ?? 0) + count))
    const verb = entry.kind === 'read_skill' || entry.kind === 'read_file' ? 'read' : entry.kind
    if (!verbOrder.includes(verb)) verbOrder.push(verb)
  }

  const clauses: string[] = []
  for (const verb of verbOrder) {
    switch (verb) {
      case 'read': {
        const skills = counts.get('read_skill') ?? 0
        const files = counts.get('read_file') ?? 0
        if (skills > 0) clauses.push(`Read ${skills} ${skills === 1 ? 'skill' : 'skills'}`)
        if (files > 0) clauses.push(`Read ${files} ${files === 1 ? 'file' : 'files'}`)
        break
      }
      case 'listed':
        clauses.push(countClause(counts, 'listed', 'Listed', 'dir', 'dirs'))
        break
      case 'edited':
        clauses.push(countClause(counts, 'edited', 'Edited', 'file', 'files'))
        break
      case 'searched':
        clauses.push(`Searched ${counts.get('searched') ?? 0}`)
        break
      case 'fetched':
        clauses.push(`Fetched ${counts.get('fetched') ?? 0}`)
        break
      case 'ran':
        clauses.push(countClause(counts, 'ran', 'Ran', 'command', 'commands'))
        break
      case 'computer_use': {
        const count = counts.get('computer_use') ?? 0
        clauses.push(count === 1 ? 'Computer Use' : `Computer Use ×${count}`)
        break
      }
      case 'subagent': {
        const count = counts.get('subagent') ?? 0
        clauses.push(count === 1 ? 'subagent' : `subagent ×${count}`)
        break
      }
      case 'other': {
        const count = counts.get('other') ?? 0
        clauses.push(`Used ${count} ${count === 1 ? 'tool' : 'tools'}`)
        break
      }
      case 'stop':
        clauses.push('stop')
        break
    }
  }
  return clauses.filter(Boolean).join(', ')
}

export function formatActivityLine(entries: readonly ActivityEntry[], hookCount: number): string {
  const summary = formatActivitySummary(entries) || 'Working'
  const hooks = boundedActivityCount(hookCount)
  return hooks > 0 ? `${summary}  [hooks: ${hooks}]` : summary
}

export function isPlaceholderToolTitle(title: string): boolean {
  const normalized = title.trim().toLocaleLowerCase('en-US')
  return !normalized || normalized === 'unknown' || normalized === 'tool call'
}

function countClause(
  counts: ReadonlyMap<ActivityKind, number>,
  kind: ActivityKind,
  verb: string,
  singular: string,
  plural: string
): string {
  const count = counts.get(kind) ?? 0
  return `${verb} ${count} ${count === 1 ? singular : plural}`
}

function startsWithAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.startsWith(candidate))
}

function looksLikeSearchPattern(title: string): boolean {
  const trimmed = title.trim()
  return title.includes('.*') || title.includes('\\') || title.includes('|') ||
    title.includes('"name":') || title.includes('":["') || title.includes('":[{') ||
    title.includes('":"') || trimmed.startsWith('"') ||
    (title.includes('*') && title.includes('.'))
}

function parseCanonicalActivityClause(
  clause: string
): { kind: ActivityKind; count: number } | undefined {
  let match = /^read\s+(\d+)\s+(skill|skills|file|files)$/iu.exec(clause)
  if (match) {
    return {
      kind: match[2]?.toLocaleLowerCase('en-US').startsWith('skill')
        ? 'read_skill'
        : 'read_file',
      count: parsedPersistedCount(match[1])
    }
  }
  match = /^listed\s+(\d+)\s+(dir|dirs)$/iu.exec(clause)
  if (match) return { kind: 'listed', count: parsedPersistedCount(match[1]) }
  match = /^edited\s+(\d+)\s+(file|files)$/iu.exec(clause)
  if (match) return { kind: 'edited', count: parsedPersistedCount(match[1]) }
  match = /^(searched|fetched)\s+(\d+)$/iu.exec(clause)
  if (match) {
    return {
      kind: match[1]?.toLocaleLowerCase('en-US') === 'searched' ? 'searched' : 'fetched',
      count: parsedPersistedCount(match[2])
    }
  }
  match = /^ran\s+(\d+)\s+(command|commands)$/iu.exec(clause)
  if (match) return { kind: 'ran', count: parsedPersistedCount(match[1]) }
  match = /^computer\s+use(?:\s*[×x]\s*(\d+))?$/iu.exec(clause)
  if (match) return { kind: 'computer_use', count: parsedPersistedCount(match[1]) }
  match = /^subagent(?:\s*[×x]\s*(\d+))?$/iu.exec(clause)
  if (match) return { kind: 'subagent', count: parsedPersistedCount(match[1]) }
  if (/^stop$/iu.test(clause)) return { kind: 'stop', count: 1 }
  return undefined
}

function splitLegacyCountSuffix(clause: string): { title: string; count: number } {
  const match = /\s*[×x]\s*(\d+)\s*$/iu.exec(clause)
  if (!match || match.index <= 0) return { title: clause, count: 1 }
  return {
    title: clause.slice(0, match.index).trim(),
    count: parsedPersistedCount(match[1])
  }
}

function parsedPersistedCount(value: string | undefined): number {
  if (value === undefined) return 1
  const significant = value.replace(/^0+/u, '')
  if (!significant) return 1
  const ceiling = String(MAX_ACTIVITY_COUNT)
  if (significant.length > ceiling.length) return MAX_ACTIVITY_COUNT
  return boundedActivityCount(Number(significant))
}
