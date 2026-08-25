import { z } from 'zod'

export const DASHBOARD_MAX_PROJECT_ID_CHARS = 256
export const DASHBOARD_MAX_BRANCH_CHARS = 256
export const DASHBOARD_MAX_DIRTY_COUNT = 999_999

const dashboardProjectIdSchema = z.string()
  .min(1)
  .max(DASHBOARD_MAX_PROJECT_ID_CHARS)
  .regex(/^[A-Za-z0-9._:-]+$/)

const dashboardBranchSchema = z.string()
  .min(1)
  .max(DASHBOARD_MAX_BRANCH_CHARS)
  .refine((value) => !/[\0\r\n]/.test(value))

/**
 * Renderer-safe, bounded projection of the selected project's Git state.
 * Filesystem identities, revisions, command output, and diff content are not
 * part of this contract.
 */
export const dashboardProjectStatusSchema = z.object({
  projectId: dashboardProjectIdSchema,
  isRepository: z.boolean(),
  isWorktree: z.boolean(),
  branch: dashboardBranchSchema.optional(),
  dirtyCount: z.number().int().min(0).max(DASHBOARD_MAX_DIRTY_COUNT)
}).strict().superRefine((status, context) => {
  if (
    !status.isRepository &&
    (status.isWorktree || status.branch !== undefined || status.dirtyCount !== 0)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'A non-repository must use the neutral dashboard status.'
    })
  }
})

export type DashboardProjectStatus = z.infer<typeof dashboardProjectStatusSchema>
