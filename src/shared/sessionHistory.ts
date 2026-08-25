import { z } from 'zod'

export const SESSION_HISTORY_QUERY_MAX_BYTES = 256
export const SESSION_HISTORY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

const historyTokenSchema = z.string().regex(SESSION_HISTORY_TOKEN_PATTERN)

export const sessionHistoryQueryInputSchema = z.object({
  query: z.string()
    .min(1)
    .max(256)
    .refine((value) => value === value.trim())
    .refine((value) => !value.startsWith('-'))
    .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value))
    .refine((value) => new TextEncoder().encode(value).byteLength <= SESSION_HISTORY_QUERY_MAX_BYTES)
}).strict()

export const sessionHistoryTokenInputSchema = z.object({
  token: historyTokenSchema
}).strict()

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** Renderer-safe history projection. Remote ACP ids and paths never enter it. */
export const publicSessionHistoryRecordSchema = z.object({
  token: historyTokenSchema,
  projectId: z.string().min(1).max(256),
  summary: z.string().max(1_024)
    .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value)),
  status: z.string().min(1).max(32).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  created: calendarDateSchema,
  updated: calendarDateSchema
}).strict()

export const publicSessionHistoryRecordsSchema = z.array(
  publicSessionHistoryRecordSchema
).max(50)

export const sessionHistoryDeleteResultSchema = z.object({
  state: z.enum(['cancelled', 'deleted'])
}).strict()

export type SessionHistoryQueryInput = z.infer<typeof sessionHistoryQueryInputSchema>
export type SessionHistoryTokenInput = z.infer<typeof sessionHistoryTokenInputSchema>
export type PublicSessionHistoryRecord = z.infer<typeof publicSessionHistoryRecordSchema>
export type SessionHistoryDeleteResult = z.infer<typeof sessionHistoryDeleteResultSchema>
