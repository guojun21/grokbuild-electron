import { z } from 'zod'

const boundedCount = z.number().int().nonnegative().max(100_000)

export const swiftImportSourceCountsSchema = z.object({
  projectsImported: boundedCount,
  projectsSkipped: boundedCount,
  sessionsImported: boundedCount,
  sessionsSkipped: boundedCount,
  transcriptItemsImported: boundedCount,
  transcriptItemsSkipped: boundedCount,
  unavailableSections: z.number().int().nonnegative().max(3)
}).strict()

export const swiftImportMergeSummarySchema = z.object({
  projectsAdded: boundedCount,
  projectsMatchedByPath: boundedCount,
  projectsSkippedForConflict: boundedCount,
  sessionsAdded: boundedCount,
  sessionsAlreadyPresent: boundedCount,
  sessionsSkippedForConflict: boundedCount
}).strict()

export const swiftImportErrorSchema = z.object({
  code: z.enum([
    'invalid-source',
    'source-too-large',
    'plutil-unavailable',
    'plutil-timeout',
    'plutil-output-limit',
    'invalid-plist',
    'invalid-project-data',
    'invalid-session-data',
    'invalid-message-data'
  ]),
  message: z.string().min(1).max(256)
}).strict()

export const swiftImportPreviewSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    token: z.string().uuid(),
    source: swiftImportSourceCountsSchema,
    merge: swiftImportMergeSummarySchema
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: swiftImportErrorSchema,
    source: swiftImportSourceCountsSchema
  }).strict()
])

export const swiftImportCommitResultSchema = z.object({
  merge: swiftImportMergeSummarySchema
}).strict()

export type SwiftImportSourceCounts = z.infer<typeof swiftImportSourceCountsSchema>
export type SwiftImportMergeSummary = z.infer<typeof swiftImportMergeSummarySchema>
export type SwiftImportPreview = z.infer<typeof swiftImportPreviewSchema>
export type SwiftImportCommitResult = z.infer<typeof swiftImportCommitResultSchema>
