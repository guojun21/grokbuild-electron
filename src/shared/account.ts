import { z } from 'zod'

const boundedLabel = z.string().min(1).max(256)

export const accountUsageCycleSchema = z.object({
  year: z.number().int().min(2000).max(3000),
  month: z.number().int().min(1).max(12),
  includedUsed: z.number().finite().min(0),
  onDemandUsed: z.number().finite().min(0),
  totalUsed: z.number().finite().min(0)
}).strict()

const accountUsageSchema = z.object({
  used: z.number().finite().min(0),
  monthlyLimit: z.number().finite().min(0),
  onDemandCap: z.number().finite().min(0),
  periodStart: z.string().datetime({ offset: true }),
  periodEnd: z.string().datetime({ offset: true }),
  history: z.array(accountUsageCycleSchema).max(24),
  /** Rolling window kind from the credits config (USAGE_PERIOD_TYPE_*). */
  periodType: z.enum(['weekly', 'monthly', 'other']).optional(),
  /** Included-allowance usage for the current period, 0–100 (may exceed on overage). */
  creditUsagePercent: z.number().finite().min(0).max(1_000).optional(),
  prepaidBalance: z.number().finite().min(0).optional(),
  onDemandUsed: z.number().finite().min(0).optional(),
  productUsage: z.array(z.object({
    product: z.string().min(1).max(128),
    usagePercent: z.number().finite().min(0).max(1_000)
  }).strict()).max(16).optional()
}).strict()

/**
 * Main-owned account status projection. The bearer credential that produced it
 * never appears here; the renderer receives display strings and numbers only.
 */
export const grokAccountReportSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('signed-out') }).strict(),
  z.object({
    state: z.literal('failed'),
    message: z.string().min(1).max(2_000)
  }).strict(),
  z.object({
    state: z.literal('ok'),
    email: boundedLabel,
    displayName: z.string().max(256),
    tier: z.string().min(1).max(128).nullable(),
    teamName: z.string().min(1).max(256).nullable(),
    organizationName: z.string().min(1).max(256).nullable(),
    hasGrokCodeAccess: z.boolean(),
    usage: accountUsageSchema.nullable()
  }).strict()
])

export type AccountUsageCycle = z.infer<typeof accountUsageCycleSchema>
export type AccountUsage = z.infer<typeof accountUsageSchema>
export type GrokAccountReport = z.infer<typeof grokAccountReportSchema>
