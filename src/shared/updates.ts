import { z } from 'zod'

const boundedVersion = z.string().min(1).max(128)
export const appUpdateStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unconfigured') }).strict(),
  z.object({
    state: z.literal('up-to-date'),
    installed: boundedVersion,
    latest: boundedVersion
  }).strict(),
  z.object({
    state: z.literal('update-available'),
    installed: boundedVersion,
    latest: boundedVersion,
    assetAvailable: z.boolean()
  }).strict(),
  z.object({
    state: z.literal('failed'),
    message: z.string().min(1).max(2_000)
  }).strict()
])

export const cliUpdateStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unavailable') }).strict(),
  z.object({
    state: z.literal('up-to-date'),
    current: boundedVersion,
    latest: boundedVersion,
    channel: z.string().max(128).optional()
  }).strict(),
  z.object({
    state: z.literal('update-available'),
    current: boundedVersion,
    latest: boundedVersion,
    channel: z.string().max(128).optional()
  }).strict(),
  z.object({
    state: z.literal('failed'),
    message: z.string().min(1).max(2_000)
  }).strict()
])

export const updateOverviewSchema = z.object({
  checkedAt: z.string().datetime({ offset: true }),
  app: appUpdateStatusSchema,
  cli: cliUpdateStatusSchema
}).strict()

export const appUpdateInstallResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('cancelled') }).strict(),
  z.object({ state: z.literal('restarting') }).strict()
])

export const cliUpdateInstallResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('cancelled') }).strict(),
  z.object({
    state: z.literal('installed'),
    current: boundedVersion,
    latest: boundedVersion,
    updateAvailable: z.boolean(),
    channel: z.string().max(128).optional()
  }).strict()
])

export type AppUpdateStatus = z.infer<typeof appUpdateStatusSchema>
export type CliUpdateStatus = z.infer<typeof cliUpdateStatusSchema>
export type UpdateOverview = z.infer<typeof updateOverviewSchema>
export type AppUpdateInstallResult = z.infer<typeof appUpdateInstallResultSchema>
export type CliUpdateInstallResult = z.infer<typeof cliUpdateInstallResultSchema>
