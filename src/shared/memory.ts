import { z } from 'zod'

export const MEMORY_SCOPES = ['global', 'workspace', 'session'] as const

export const MEMORY_PUBLIC_LIMITS = Object.freeze({
  files: 2_000,
  previewBytes: 512 * 1_024,
  noteBytes: 8 * 1_024
})

export const memoryTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)

export const publicMemoryFileSummarySchema = z.object({
  token: memoryTokenSchema,
  scope: z.enum(MEMORY_SCOPES),
  title: z.string().min(1).max(128),
  workspaceLabel: z.string().min(1).max(128).optional(),
  modifiedAt: z.string().datetime({ offset: true }).optional(),
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  canDelete: z.boolean()
}).strict()

export const publicMemoryFileSummariesSchema = z.array(publicMemoryFileSummarySchema)
  .max(MEMORY_PUBLIC_LIMITS.files)

export const memoryTokenInputSchema = z.object({
  token: memoryTokenSchema
}).strict()

export const rememberMemoryInputSchema = z.object({
  note: z.string().min(1).max(MEMORY_PUBLIC_LIMITS.noteBytes)
}).strict()

export const publicMemoryFileContentsSchema = z.object({
  token: memoryTokenSchema,
  scope: z.enum(MEMORY_SCOPES),
  title: z.string().min(1).max(128),
  workspaceLabel: z.string().min(1).max(128).optional(),
  modifiedAt: z.string().datetime({ offset: true }).optional(),
  byteLength: z.number().int().nonnegative().max(MEMORY_PUBLIC_LIMITS.previewBytes),
  canDelete: z.boolean(),
  contents: z.string().max(MEMORY_PUBLIC_LIMITS.previewBytes)
}).strict()

export const memoryDeleteResultSchema = z.object({
  state: z.enum(['cancelled', 'deleted'])
}).strict()

export type MemoryScope = typeof MEMORY_SCOPES[number]
export type PublicMemoryFileSummary = z.infer<typeof publicMemoryFileSummarySchema>
export type PublicMemoryFileContents = z.infer<typeof publicMemoryFileContentsSchema>
export type MemoryTokenInput = z.infer<typeof memoryTokenInputSchema>
export type RememberMemoryInput = z.infer<typeof rememberMemoryInputSchema>
export type MemoryDeleteResult = z.infer<typeof memoryDeleteResultSchema>

/** App-scoped compatibility flag for new/restarted Grok 1.0.5 sessions. */
export function grokMemoryLaunchArgument(enabled: boolean): '--experimental-memory' | '--no-memory' {
  return enabled ? '--experimental-memory' : '--no-memory'
}
