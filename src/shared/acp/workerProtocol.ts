import { z } from 'zod'
import {
  interactionAnswerSchema,
  interactionResolvedSchema,
  pendingInteractionSchema
} from './interactions'
import {
  ATTACHMENT_PROMPT_LIMITS,
  attachmentPromptBlocksSchema
} from '../attachments'
import { trustedAcpUpdateSchema } from './trustedUpdates'
import { strictUuidSchema } from '../identifiers'

export const ACP_AGENT_PROFILE_LIMITS = {
  nameChars: 64,
  descriptionChars: 2_048,
  promptBodyChars: 64 * 1_024
} as const

/** Main/utility-process-only inline agent definition. */
export const acpAgentProfileSchema = z.object({
  name: z.string()
    .min(1)
    .max(ACP_AGENT_PROFILE_LIMITS.nameChars)
    .regex(/^[A-Za-z0-9_-]+$/),
  description: z.string().max(ACP_AGENT_PROFILE_LIMITS.descriptionChars),
  promptBody: z.string().min(1).max(ACP_AGENT_PROFILE_LIMITS.promptBodyChars)
}).strict()

export type AcpAgentProfile = z.infer<typeof acpAgentProfileSchema>

export const workerLaunchSchema = z.object({
  localSessionId: z.string().min(1).max(256),
  generation: z.number().int().positive(),
  cliPath: z.string().min(1).max(4096),
  cwd: z.string().min(1).max(4096),
  model: z.string().min(1).max(128),
  reasoningEffort: z.string().min(1).max(32),
  memoryEnabled: z.boolean().optional(),
  agentProfile: acpAgentProfileSchema.optional(),
  resumeSessionId: z.string().min(1).max(256).optional(),
  allowStaleFallback: z.boolean().optional(),
  forkSession: z.object({
    sourceSessionId: strictUuidSchema,
    newSessionId: strictUuidSchema,
    newModelId: z.string().min(1).max(128).optional()
  }).strict().optional(),
  environment: z.record(z.string(), z.string()).default({})
}).strict().superRefine((launch, context) => {
  if (launch.resumeSessionId && launch.forkSession) {
    context.addIssue({
      code: 'custom',
      path: ['forkSession'],
      message: 'resumeSessionId and forkSession are mutually exclusive'
    })
  }
  if (launch.allowStaleFallback !== undefined && !launch.resumeSessionId) {
    context.addIssue({
      code: 'custom',
      path: ['allowStaleFallback'],
      message: 'allowStaleFallback requires resumeSessionId'
    })
  }
})

export const workerStartResultSchema = z.object({
  sessionId: z.string().min(1).max(256),
  resumed: z.boolean(),
  staleFallbackFrom: z.string().min(1).max(256).optional(),
  forkedFrom: z.string().uuid().optional()
}).strict()

const emptyPayloadSchema = z.object({}).strict()
const promptPayloadSchema = z.union([
  z.object({ text: z.string().max(ATTACHMENT_PROMPT_LIMITS.textChars) }).strict(),
  z.object({ blocks: attachmentPromptBlocksSchema }).strict()
])
const modelPayloadSchema = z.object({ model: z.string().min(1).max(128) }).strict()
const modePayloadSchema = z.object({ mode: z.string().min(1).max(32) }).strict()
const permissionPayloadSchema = z.object({
  requestId: z.string().min(1).max(256),
  optionId: z.string().min(1).max(256)
}).strict()
const interactionPayloadSchema = z.object({
  interactionId: z.string().min(1).max(256),
  answer: interactionAnswerSchema
}).strict()

export const workerPermissionEventSchema = z.object({
  rpcId: z.union([z.string(), z.number()]),
  requestId: z.string().min(1).max(256),
  sessionId: z.string().max(256),
  title: z.string().min(1).max(2_000),
  description: z.string().max(20_000).optional(),
  options: z.array(z.object({
    id: z.string().min(1).max(256),
    label: z.string().min(1).max(2_000),
    intent: z.string().max(64).optional()
  }).strict()).max(32)
}).strict()

export const workerCapabilitiesEventSchema = z.object({
  currentModelId: z.string().min(1).max(128).optional(),
  availableModels: z.array(z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    contextLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  }).strict()).max(64),
  currentModeId: z.enum(['default', 'plan', 'ask', 'yolo']).optional(),
  availableModes: z.array(z.object({
    id: z.enum(['default', 'plan', 'ask', 'yolo']),
    name: z.string().min(1).max(128)
  }).strict()).max(8)
}).strict()

export const workerCommandSchema = z.discriminatedUnion('type', [
  z.object({ id: z.number().int().positive(), type: z.literal('start'), payload: workerLaunchSchema }).strict(),
  z.object({ id: z.number().int().positive(), type: z.literal('prompt'), payload: promptPayloadSchema }).strict(),
  z.object({ id: z.number().int().positive(), type: z.literal('cancel'), payload: emptyPayloadSchema }).strict(),
  z.object({ id: z.number().int().positive(), type: z.literal('set_model'), payload: modelPayloadSchema }).strict(),
  z.object({ id: z.number().int().positive(), type: z.literal('set_mode'), payload: modePayloadSchema }).strict(),
  z.object({ id: z.number().int().positive(), type: z.literal('answer_permission'), payload: permissionPayloadSchema }).strict(),
  z.object({ id: z.number().int().positive(), type: z.literal('answer_interaction'), payload: interactionPayloadSchema }).strict(),
  z.object({ id: z.number().int().positive(), type: z.literal('stop'), payload: emptyPayloadSchema }).strict()
])

export const workerResponseSchema = z.union([
  z.object({ kind: z.literal('response'), id: z.number().int().positive(), ok: z.literal(true), result: z.unknown().optional() }).strict(),
  z.object({ kind: z.literal('response'), id: z.number().int().positive(), ok: z.literal(false), error: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('event'), event: z.literal('update'), localSessionId: z.string().min(1).max(256), generation: z.number().int().positive(), sequence: z.number().int().positive(), payload: z.unknown() }).strict(),
  z.object({ kind: z.literal('event'), event: z.literal('trusted_update'), localSessionId: z.string().min(1).max(256), generation: z.number().int().positive(), sequence: z.number().int().positive(), payload: trustedAcpUpdateSchema }).strict(),
  z.object({ kind: z.literal('event'), event: z.literal('capabilities'), localSessionId: z.string().min(1).max(256), generation: z.number().int().positive(), sequence: z.number().int().positive(), payload: workerCapabilitiesEventSchema }).strict(),
  z.object({ kind: z.literal('event'), event: z.literal('permission'), localSessionId: z.string().min(1).max(256), generation: z.number().int().positive(), sequence: z.number().int().positive(), payload: workerPermissionEventSchema }).strict(),
  z.object({ kind: z.literal('event'), event: z.literal('interaction'), localSessionId: z.string().min(1).max(256), generation: z.number().int().positive(), sequence: z.number().int().positive(), payload: pendingInteractionSchema }).strict(),
  z.object({ kind: z.literal('event'), event: z.literal('interaction_resolved'), localSessionId: z.string().min(1).max(256), generation: z.number().int().positive(), sequence: z.number().int().positive(), payload: interactionResolvedSchema }).strict(),
  z.object({ kind: z.literal('event'), event: z.literal('stderr'), localSessionId: z.string().min(1).max(256), generation: z.number().int().positive(), sequence: z.number().int().positive(), payload: z.string().max(64 * 1024) }).strict(),
  z.object({
    kind: z.literal('event'),
    event: z.literal('exit'),
    localSessionId: z.string().min(1).max(256),
    generation: z.number().int().positive(),
    sequence: z.number().int().positive(),
    payload: z.object({ code: z.number().int().nullable() }).strict()
  }).strict()
])

export type WorkerLaunch = z.infer<typeof workerLaunchSchema>
export type WorkerCommand = z.infer<typeof workerCommandSchema>
export type WorkerResponse = z.infer<typeof workerResponseSchema>
