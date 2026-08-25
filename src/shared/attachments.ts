import { z } from 'zod'

export type AttachmentKind = 'file' | 'image'

export const ATTACHMENT_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
] as const

export type AttachmentImageMimeType = typeof ATTACHMENT_IMAGE_MIME_TYPES[number]

/** Hard wire limits shared by direct ACP and utility-process ACP transports. */
export const ATTACHMENT_PROMPT_LIMITS = Object.freeze({
  blocks: 19,
  images: 16,
  textChars: 200_000,
  totalTextChars: 400_000,
  imageBytes: 8 * 1024 * 1024,
  totalImageBytes: 24 * 1024 * 1024
})

const MAX_ENCODED_IMAGE_CHARS = Math.ceil(ATTACHMENT_PROMPT_LIMITS.imageBytes / 3) * 4
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/

/** Renderer-safe metadata. It intentionally contains neither paths nor image bytes. */
export interface AttachmentItemSummary {
  kind: AttachmentKind
  displayName: string
}

/** An opaque, session-scoped lease for a staged attachment selection. */
export interface AttachmentSelectionSummary {
  token: string
  expiresAt: string
  attachments: AttachmentItemSummary[]
}

export const attachmentItemSummarySchema = z.object({
  kind: z.enum(['file', 'image']),
  displayName: z.string().min(1).max(1_024).regex(/^[^\u0000-\u001f\u007f]+$/)
}).strict()

/** Output guard for the only attachment shape permitted to cross into renderer. */
export const attachmentSelectionSummarySchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),
  expiresAt: z.string().datetime(),
  attachments: z.array(attachmentItemSummarySchema).min(1).max(16)
}).strict()

/**
 * ACP-compatible content blocks produced only when main consumes a lease.
 * Image blocks are not renderer-safe and must stay on the main-to-ACP path.
 */
const attachmentTextPromptBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string().max(ATTACHMENT_PROMPT_LIMITS.textChars)
}).strict()

const attachmentImagePromptBlockSchema = z.object({
  type: z.literal('image'),
  data: z.string().min(4).max(MAX_ENCODED_IMAGE_CHARS),
  mimeType: z.enum(ATTACHMENT_IMAGE_MIME_TYPES)
}).strict().superRefine((block, context) => {
  if (!isCanonicalBase64(block.data)) {
    context.addIssue({ code: 'custom', path: ['data'], message: 'Invalid image encoding' })
    return
  }
  if (decodedBase64Bytes(block.data) > ATTACHMENT_PROMPT_LIMITS.imageBytes) {
    context.addIssue({ code: 'custom', path: ['data'], message: 'Image payload is too large' })
    return
  }
  if (!hasImageSignature(block.data, block.mimeType)) {
    context.addIssue({ code: 'custom', path: ['data'], message: 'Invalid image signature' })
  }
})

export const attachmentPromptBlockSchema = z.discriminatedUnion('type', [
  attachmentTextPromptBlockSchema,
  attachmentImagePromptBlockSchema
])

export const attachmentPromptBlocksSchema = z.array(attachmentPromptBlockSchema)
  .min(1)
  .max(ATTACHMENT_PROMPT_LIMITS.blocks)
  .superRefine((blocks, context) => {
    let imageCount = 0
    let totalImageBytes = 0
    let totalTextChars = 0
    for (const block of blocks) {
      if (block.type === 'text') {
        totalTextChars += block.text.length
        continue
      }
      imageCount += 1
      if (isCanonicalBase64(block.data)) totalImageBytes += decodedBase64Bytes(block.data)
    }
    if (imageCount > ATTACHMENT_PROMPT_LIMITS.images) {
      context.addIssue({ code: 'custom', message: 'Too many image blocks' })
    }
    if (totalImageBytes > ATTACHMENT_PROMPT_LIMITS.totalImageBytes) {
      context.addIssue({ code: 'custom', message: 'Image payload is too large' })
    }
    if (totalTextChars > ATTACHMENT_PROMPT_LIMITS.totalTextChars) {
      context.addIssue({ code: 'custom', message: 'Text payload is too large' })
    }
  })

export type AttachmentPromptBlock = z.infer<typeof attachmentPromptBlockSchema>
export type AttachmentPrompt = string | readonly AttachmentPromptBlock[]

export function parseAttachmentPromptBlocks(value: unknown): AttachmentPromptBlock[] {
  return attachmentPromptBlocksSchema.parse(value)
}

export interface ConsumedAttachments {
  blocks: AttachmentPromptBlock[]
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_BODY.test(value)) return false
  const firstPadding = value.indexOf('=')
  if (firstPadding >= 0 && firstPadding < value.length - 2) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  if (padding === 2) {
    const sextet = BASE64_ALPHABET.indexOf(value[value.length - 3] ?? '')
    return sextet >= 0 && (sextet & 0x0f) === 0
  }
  if (padding === 1) {
    const sextet = BASE64_ALPHABET.indexOf(value[value.length - 2] ?? '')
    return sextet >= 0 && (sextet & 0x03) === 0
  }
  return true
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function hasImageSignature(data: string, mimeType: AttachmentImageMimeType): boolean {
  const prefix = decodeBase64Prefix(data, 12)
  switch (mimeType) {
    case 'image/png':
      return matches(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/jpeg':
      return matches(prefix, [0xff, 0xd8, 0xff])
    case 'image/gif':
      return matches(prefix, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        matches(prefix, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    case 'image/webp':
      return matches(prefix, [0x52, 0x49, 0x46, 0x46]) &&
        matches(prefix.slice(8), [0x57, 0x45, 0x42, 0x50])
  }
}

function decodeBase64Prefix(value: string, maximumBytes: number): number[] {
  const result: number[] = []
  let bits = 0
  let bitCount = 0
  for (const character of value) {
    if (character === '=' || result.length >= maximumBytes) break
    const sextet = BASE64_ALPHABET.indexOf(character)
    if (sextet < 0) return []
    bits = (bits << 6) | sextet
    bitCount += 6
    if (bitCount < 8) continue
    bitCount -= 8
    result.push((bits >> bitCount) & 0xff)
    bits &= (1 << bitCount) - 1
  }
  return result
}

function matches(actual: readonly number[], expected: readonly number[]): boolean {
  return expected.every((value, index) => actual[index] === value)
}
