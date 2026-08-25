import { z } from 'zod'
import { interactionAnswerSchema } from './acp/interactions'
import {
  mcpAddRequestSchema,
  mcpDoctorRequestSchema,
  mcpRemoveRequestSchema,
  mcpToggleRequestSchema
} from './mcp'
import {
  sessionHistoryQueryInputSchema,
  sessionHistoryTokenInputSchema
} from './sessionHistory'
import {
  SAVED_AGENT_LIMITS
} from './agents'
import { publicAgentRosterSnapshotSchema } from './schemas'
import { strictUuidSchema } from './identifiers'
import {
  memoryTokenInputSchema,
  rememberMemoryInputSchema
} from './memory'
export { IPC } from './ipcChannels'

const identifier = z.string().min(1).max(256)
const attachmentToken = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/)
const rosterRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

const singleLineAgentText = (maximum: number): z.ZodString => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value))

const agentMission = z.string()
  .min(1)
  .max(SAVED_AGENT_LIMITS.missionCharacters)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value))

/** Renderer-editable Saved Agent fields. Main owns every launch preference and role field. */
export const savedAgentEditorFieldsSchema = z.object({
  name: singleLineAgentText(SAVED_AGENT_LIMITS.nameCharacters),
  mission: agentMission,
  glyph: z.string()
    .min(1)
    .max(SAVED_AGENT_LIMITS.glyphCharacters)
    .regex(/^[A-Za-z0-9._-]+$/u),
  color: z.string().regex(/^#[0-9A-F]{6}$/u),
  isPinned: z.boolean()
}).strict()

export const createSavedAgentInput = z.object({
  expectedRevision: rosterRevision,
  draft: savedAgentEditorFieldsSchema
}).strict()

export const updateSavedAgentInput = z.object({
  expectedRevision: rosterRevision,
  agentId: strictUuidSchema,
  changes: savedAgentEditorFieldsSchema
}).strict()

export const deleteSavedAgentInput = z.object({
  expectedRevision: rosterRevision,
  agentId: strictUuidSchema
}).strict()

export const installStarterAgentsInput = z.object({
  expectedRevision: rosterRevision
}).strict()

export const recoverSavedAgentRosterInput = z.object({
  expectedRevision: z.literal(0)
}).strict()

export const bindSavedAgentInput = z.object({
  expectedRevision: rosterRevision,
  sessionId: identifier,
  agentId: strictUuidSchema.nullable()
}).strict()

export const listGrokAgentCatalogInput = z.object({
  projectId: identifier
}).strict()

export const savedAgentRosterRecoveryResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('cancelled') }).strict(),
  z.object({
    state: z.literal('recovered'),
    roster: publicAgentRosterSnapshotSchema
  }).strict()
])

export const savedAgentDeleteResultSchema = z.object({
  state: z.enum(['cancelled', 'deleted'])
}).strict()

export const noArgumentsInput = z.tuple([])

export const createSessionInput = z.object({
  projectId: identifier
}).strict()

export const selectProjectInput = z.object({
  projectId: identifier
}).strict()

export const selectSessionInput = z.object({
  sessionId: identifier
}).strict()

export const chooseAttachmentsInput = z.object({
  sessionId: identifier
}).strict()

export const copyTextInput = z.object({
  text: z.string().min(1).max(8_192)
}).strict()

export const imageMenuInput = z.object({
  name: z.string().min(1).max(1_024),
  path: z.string().min(1).max(4_096).optional(),
  dataUrl: z.string()
    .max(400_000)
    .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+\/]+={0,2}$/)
    .optional()
}).strict()

export const cancelAttachmentsInput = z.object({
  sessionId: identifier,
  token: attachmentToken
}).strict()

export const removeProjectInput = z.object({
  projectId: identifier
}).strict()

export const moveProjectInput = z.object({
  projectId: identifier,
  direction: z.enum(['up', 'down'])
}).strict()

export const projectOpenTargetSchema = z.enum([
  'finder',
  'cursor',
  'vsCode',
  'terminal',
  'iTerm',
  'zed'
])

export const openProjectInput = z.object({
  projectId: identifier,
  target: projectOpenTargetSchema
}).strict()

export const projectOpenTargetStatusSchema = z.object({
  target: projectOpenTargetSchema,
  label: z.string().min(1).max(64),
  installed: z.boolean()
}).strict()

export const projectOpenResultSchema = z.object({
  target: projectOpenTargetSchema,
  opened: z.literal(true)
}).strict()

export const closeSessionInput = z.object({
  sessionId: identifier
}).strict()

export const duplicateSessionInput = z.object({
  sessionId: identifier
}).strict()

export const forkSessionInput = z.object({
  sessionId: identifier
}).strict()

export const setProjectPinnedInput = z.object({
  projectId: identifier,
  pinned: z.boolean()
}).strict()

export const setSessionPinnedInput = z.object({
  sessionId: identifier,
  pinned: z.boolean()
}).strict()

export const setSessionSettledInput = z.object({
  sessionId: identifier,
  settled: z.boolean()
}).strict()

export const setSessionUnreadInput = z.object({
  sessionId: identifier,
  unread: z.boolean()
}).strict()

export const searchSessionHistoryInput = sessionHistoryQueryInputSchema
export const openSessionHistoryInput = sessionHistoryTokenInputSchema
export const deleteSessionHistoryInput = sessionHistoryTokenInputSchema
export const readMemoryInput = memoryTokenInputSchema
export const deleteMemoryInput = memoryTokenInputSchema
export const rememberMemoryInput = rememberMemoryInputSchema

export const sendPromptInput = z.object({
  sessionId: identifier,
  text: z.string().trim().max(200_000),
  attachmentToken: attachmentToken.optional()
}).strict().refine(
  (input) => input.text.length > 0 || input.attachmentToken !== undefined,
  { message: 'A prompt requires text or attachments' }
)

export const cancelTurnInput = z.object({
  sessionId: identifier
}).strict()

export const retrySessionInput = z.object({
  sessionId: identifier
}).strict()

export const answerPermissionInput = z.object({
  sessionId: identifier,
  requestId: identifier,
  optionId: identifier
}).strict()

export const answerInteractionInput = z.object({
  sessionId: identifier,
  interactionId: identifier,
  answer: interactionAnswerSchema
}).strict()

export const updateSessionInput = z
  .object({
    sessionId: identifier,
    title: z.string().trim().min(1).max(2_000).optional(),
    model: z.string().min(1).max(128).optional(),
    mode: z.enum(['default', 'plan', 'ask', 'yolo']).optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    permissionMode: z.enum(['ask', 'auto']).optional()
  })
  .strict()
  .refine((input) => input.title || input.model || input.mode || input.reasoningEffort || input.permissionMode, {
    message: 'At least one session setting is required'
  })

export const updateSettingsInput = z.object({
  appearance: z.enum(['system', 'light', 'dark']).optional(),
  reduceMotion: z.boolean().optional(),
  maxLiveSessions: z.number().int().min(1).max(8).optional(),
  privacyMode: z.boolean().optional(),
  memoryEnabled: z.boolean().optional()
}).strict().refine(
  (input) => Object.values(input).some((value) => value !== undefined),
  { message: 'At least one application setting is required' }
)

export const addMcpInput = mcpAddRequestSchema
export const removeMcpInput = mcpRemoveRequestSchema
export const enableMcpInput = mcpToggleRequestSchema
export const disableMcpInput = mcpToggleRequestSchema
export const doctorMcpInput = mcpDoctorRequestSchema

export const swiftImportTokenInput = z.object({
  token: z.string().uuid()
}).strict()

export type CreateSessionInput = z.infer<typeof createSessionInput>
export type SavedAgentEditorFields = z.infer<typeof savedAgentEditorFieldsSchema>
export type CreateSavedAgentInput = z.infer<typeof createSavedAgentInput>
export type UpdateSavedAgentInput = z.infer<typeof updateSavedAgentInput>
export type DeleteSavedAgentInput = z.infer<typeof deleteSavedAgentInput>
export type InstallStarterAgentsInput = z.infer<typeof installStarterAgentsInput>
export type RecoverSavedAgentRosterInput = z.infer<typeof recoverSavedAgentRosterInput>
export type BindSavedAgentInput = z.infer<typeof bindSavedAgentInput>
export type ListGrokAgentCatalogInput = z.infer<typeof listGrokAgentCatalogInput>
export type SavedAgentRosterRecoveryResult = z.infer<typeof savedAgentRosterRecoveryResultSchema>
export type SavedAgentDeleteResult = z.infer<typeof savedAgentDeleteResultSchema>
export type SelectProjectInput = z.infer<typeof selectProjectInput>
export type SelectSessionInput = z.infer<typeof selectSessionInput>
export type ChooseAttachmentsInput = z.infer<typeof chooseAttachmentsInput>
export type CancelAttachmentsInput = z.infer<typeof cancelAttachmentsInput>
export type RemoveProjectInput = z.infer<typeof removeProjectInput>
export type MoveProjectInput = z.infer<typeof moveProjectInput>
export type ProjectOpenTarget = z.infer<typeof projectOpenTargetSchema>
export type OpenProjectInput = z.infer<typeof openProjectInput>
export type ProjectOpenTargetStatus = z.infer<typeof projectOpenTargetStatusSchema>
export type ProjectOpenResult = z.infer<typeof projectOpenResultSchema>
export type CloseSessionInput = z.infer<typeof closeSessionInput>
export type DuplicateSessionInput = z.infer<typeof duplicateSessionInput>
export type ForkSessionInput = z.infer<typeof forkSessionInput>
export type SetProjectPinnedInput = z.infer<typeof setProjectPinnedInput>
export type SetSessionPinnedInput = z.infer<typeof setSessionPinnedInput>
export type SetSessionSettledInput = z.infer<typeof setSessionSettledInput>
export type SetSessionUnreadInput = z.infer<typeof setSessionUnreadInput>
export type SearchSessionHistoryInput = z.infer<typeof searchSessionHistoryInput>
export type OpenSessionHistoryInput = z.infer<typeof openSessionHistoryInput>
export type DeleteSessionHistoryInput = z.infer<typeof deleteSessionHistoryInput>
export type ReadMemoryInput = z.infer<typeof readMemoryInput>
export type DeleteMemoryInput = z.infer<typeof deleteMemoryInput>
export type RememberMemoryInput = z.infer<typeof rememberMemoryInput>
export type SendPromptInput = z.infer<typeof sendPromptInput>
export type CancelTurnInput = z.infer<typeof cancelTurnInput>
export type RetrySessionInput = z.infer<typeof retrySessionInput>
export type AnswerPermissionInput = z.infer<typeof answerPermissionInput>
export type AnswerInteractionInput = z.infer<typeof answerInteractionInput>
export type UpdateSessionInput = z.infer<typeof updateSessionInput>
export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>
export type AddMcpInput = z.infer<typeof addMcpInput>
export type RemoveMcpInput = z.infer<typeof removeMcpInput>
export type EnableMcpInput = z.infer<typeof enableMcpInput>
export type DisableMcpInput = z.infer<typeof disableMcpInput>
export type DoctorMcpInput = z.infer<typeof doctorMcpInput>
export type SwiftImportTokenInput = z.infer<typeof swiftImportTokenInput>
