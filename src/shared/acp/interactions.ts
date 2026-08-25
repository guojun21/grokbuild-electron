import { z } from 'zod'

const identifier = z.string().min(1).max(256)
const displayText = z.string().min(1).max(20_000)

export const interactionQuestionOptionSchema = z.object({
  id: identifier,
  label: z.string().min(1).max(2_000),
  description: z.string().max(20_000).optional(),
  preview: z.string().max(256 * 1024).optional()
}).strict()

export const interactionQuestionSchema = z.object({
  id: identifier,
  question: displayText,
  options: z.array(interactionQuestionOptionSchema).max(32),
  multiSelect: z.boolean(),
  otherOptionId: identifier
}).strict()

export const pendingInteractionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plan'),
    interactionId: identifier,
    sessionId: identifier,
    planContent: z.string().max(2 * 1024 * 1024).optional()
  }).strict(),
  z.object({
    kind: z.literal('question'),
    interactionId: identifier,
    sessionId: identifier,
    mode: z.enum(['default', 'plan']),
    questions: z.array(interactionQuestionSchema).min(1).max(32)
  }).strict()
])

export const publicPendingInteractionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plan'),
    interactionId: identifier,
    planContent: z.string().max(2 * 1024 * 1024).optional()
  }).strict(),
  z.object({
    kind: z.literal('question'),
    interactionId: identifier,
    mode: z.enum(['default', 'plan']),
    questions: z.array(interactionQuestionSchema).min(1).max(32)
  }).strict()
])

export const interactionQuestionAnswerSchema = z.object({
  questionId: identifier,
  optionIds: z.array(identifier).max(32),
  otherText: z.string().max(20_000).optional()
}).strict()

export const interactionAnswerSchema = z.union([
  z.object({
    kind: z.literal('plan'),
    decision: z.enum(['approved', 'cancelled', 'abandoned']),
    feedback: z.string().max(64 * 1024).optional()
  }).strict(),
  z.object({
    kind: z.literal('question'),
    action: z.enum(['accepted', 'chat_about_this', 'skip_interview']),
    answers: z.array(interactionQuestionAnswerSchema).max(32)
  }).strict(),
  z.object({
    kind: z.literal('question'),
    action: z.literal('cancelled')
  }).strict()
])

export const interactionResolvedSchema = z.object({
  interactionId: identifier
}).strict()

export type PendingInteraction = z.infer<typeof pendingInteractionSchema>
export type PublicPendingInteraction = z.infer<typeof publicPendingInteractionSchema>
export type InteractionQuestion = z.infer<typeof interactionQuestionSchema>
export type InteractionAnswer = z.infer<typeof interactionAnswerSchema>
export type InteractionResolved = z.infer<typeof interactionResolvedSchema>
