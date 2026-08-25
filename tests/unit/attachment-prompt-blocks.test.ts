import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_PROMPT_LIMITS,
  attachmentPromptBlocksSchema,
  type AttachmentImageMimeType
} from '../../src/shared/attachments'

const SIGNATURES: Record<AttachmentImageMimeType, string> = {
  'image/png': Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
  'image/jpeg': Buffer.from('ffd8ff', 'hex').toString('base64'),
  'image/gif': Buffer.from('474946383961', 'hex').toString('base64'),
  'image/webp': Buffer.from('524946460000000057454250', 'hex').toString('base64')
}

describe('attachment prompt block contracts', () => {
  it('accepts exact text and supported image blocks without transforming them', () => {
    const blocks = [
      { type: 'text' as const, text: 'Inspect these images' },
      ...Object.entries(SIGNATURES).map(([mimeType, data]) => ({
        type: 'image' as const,
        data,
        mimeType: mimeType as AttachmentImageMimeType
      }))
    ]

    expect(attachmentPromptBlocksSchema.parse(blocks)).toEqual(blocks)
  })

  it('rejects unknown fields, MIME types, MIME/signature mismatches, and non-canonical base64', () => {
    expect(attachmentPromptBlocksSchema.safeParse([
      { type: 'text', text: 'hello', path: '/private/secret' }
    ]).success).toBe(false)
    expect(attachmentPromptBlocksSchema.safeParse([
      { type: 'image', data: SIGNATURES['image/png'], mimeType: 'image/svg+xml' }
    ]).success).toBe(false)
    expect(attachmentPromptBlocksSchema.safeParse([
      { type: 'image', data: SIGNATURES['image/png'], mimeType: 'image/jpeg' }
    ]).success).toBe(false)
    expect(attachmentPromptBlocksSchema.safeParse([
      { type: 'image', data: `${SIGNATURES['image/png']}\n`, mimeType: 'image/png' }
    ]).success).toBe(false)
    expect(attachmentPromptBlocksSchema.safeParse([
      { type: 'image', data: SIGNATURES['image/png'].replace(/=$/, ''), mimeType: 'image/png' }
    ]).success).toBe(false)
  })

  it('enforces block, image, and aggregate text counts', () => {
    expect(attachmentPromptBlocksSchema.safeParse(
      Array.from({ length: ATTACHMENT_PROMPT_LIMITS.blocks + 1 }, () => ({ type: 'text', text: '' }))
    ).success).toBe(false)
    expect(attachmentPromptBlocksSchema.safeParse(
      Array.from({ length: ATTACHMENT_PROMPT_LIMITS.images + 1 }, () => ({
        type: 'image',
        data: SIGNATURES['image/png'],
        mimeType: 'image/png'
      }))
    ).success).toBe(false)
    expect(attachmentPromptBlocksSchema.safeParse([
      { type: 'text', text: 'a'.repeat(ATTACHMENT_PROMPT_LIMITS.textChars) },
      { type: 'text', text: 'b'.repeat(ATTACHMENT_PROMPT_LIMITS.textChars) },
      { type: 'text', text: 'c' }
    ]).success).toBe(false)
  })

  it('enforces decoded single-image and aggregate image byte limits', () => {
    const maximumImage = pngPayload(ATTACHMENT_PROMPT_LIMITS.imageBytes)
    const oversizedImage = pngPayload(ATTACHMENT_PROMPT_LIMITS.imageBytes + 1)

    expect(attachmentPromptBlocksSchema.safeParse([
      { type: 'image', data: oversizedImage, mimeType: 'image/png' }
    ]).success).toBe(false)
    expect(attachmentPromptBlocksSchema.safeParse([
      { type: 'image', data: maximumImage, mimeType: 'image/png' },
      { type: 'image', data: maximumImage, mimeType: 'image/png' },
      { type: 'image', data: maximumImage, mimeType: 'image/png' },
      { type: 'image', data: SIGNATURES['image/png'], mimeType: 'image/png' }
    ]).success).toBe(false)
  })
})

function pngPayload(bytes: number): string {
  const data = Buffer.alloc(bytes)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(data)
  return data.toString('base64')
}
