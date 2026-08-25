import { z } from 'zod'

export const workspaceHealthStateSchema = z.enum([
  'ready',
  'missing',
  'not-directory',
  'changed',
  'unreadable'
])

export const workspaceHealthResultSchema = z.object({
  projectId: z.string().min(1).max(256),
  state: workspaceHealthStateSchema
}).strict()

export type WorkspaceHealthState = z.infer<typeof workspaceHealthStateSchema>
export type WorkspaceHealthResult = z.infer<typeof workspaceHealthResultSchema>
