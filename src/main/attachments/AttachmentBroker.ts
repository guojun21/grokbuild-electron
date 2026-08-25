import { constants as fsConstants } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, extname, isAbsolute, relative } from 'node:path'
import type {
  AttachmentImageMimeType,
  AttachmentItemSummary,
  AttachmentPromptBlock,
  AttachmentSelectionSummary,
  ConsumedAttachments
} from '../../shared/attachments'

export const ATTACHMENT_HARD_LIMITS = Object.freeze({
  count: 16,
  imageBytes: 8 * 1024 * 1024,
  totalImageBytes: 24 * 1024 * 1024,
  ttlMs: 5 * 60_000
})

const MAX_SESSION_ID_CHARS = 256
const MAX_PATH_CHARS = 4_096
const MAX_SAFE_LABEL_CHARS = 1_024
const MIN_TTL_MS = 10
const MAX_TTL_MS = 30 * 60_000
const READ_CHUNK_BYTES = 64 * 1024

export interface StageAttachmentsInput {
  sessionId: string
  projectRoot: string
  paths: readonly string[]
}

export interface AttachmentBrokerOptions {
  /** Tests may lower limits, but no caller can raise the hard production caps. */
  limits?: {
    count?: number
    imageBytes?: number
    totalImageBytes?: number
  }
  ttlMs?: number
  tokenFactory?: () => string
}

export type AttachmentBrokerErrorCode =
  | 'invalid-request'
  | 'project-unavailable'
  | 'attachment-unavailable'
  | 'too-many-attachments'
  | 'image-too-large'
  | 'total-too-large'
  | 'invalid-image'
  | 'invalid-token'

export class AttachmentBrokerError extends Error {
  constructor(readonly code: AttachmentBrokerErrorCode) {
    super(errorMessage(code))
    this.name = 'AttachmentBrokerError'
  }
}

interface BrokerLimits {
  count: number
  imageBytes: number
  totalImageBytes: number
}

interface FileIdentity {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

interface StagedRegularFile {
  kind: 'file'
  displayName: string
  notePath: string
}

interface StagedImage {
  kind: 'image'
  displayName: string
  mimeType: AttachmentImageMimeType
  handle: FileHandle
  identity: FileIdentity
}

type StagedAttachment = StagedRegularFile | StagedImage

interface StagedLease {
  sessionId: string
  expiresAtMs: number
  attachments: StagedAttachment[]
  timer: NodeJS.Timeout
}

/**
 * Owns selected attachment capabilities in main. Tokens are opaque, session-bound,
 * consume-once leases; renderer-safe summaries never contain absolute paths or bytes.
 */
export class AttachmentBroker {
  private readonly entries = new Map<string, StagedLease>()
  private readonly limits: BrokerLimits
  private readonly ttlMs: number
  private readonly tokenFactory: () => string

  constructor(options: AttachmentBrokerOptions = {}) {
    this.limits = {
      count: lowerBoundedLimit(options.limits?.count, ATTACHMENT_HARD_LIMITS.count),
      imageBytes: lowerBoundedLimit(
        options.limits?.imageBytes,
        ATTACHMENT_HARD_LIMITS.imageBytes
      ),
      totalImageBytes: lowerBoundedLimit(
        options.limits?.totalImageBytes,
        ATTACHMENT_HARD_LIMITS.totalImageBytes
      )
    }
    this.ttlMs = boundedTtl(options.ttlMs)
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'))
  }

  async stage(input: StageAttachmentsInput): Promise<AttachmentSelectionSummary> {
    if (!input || typeof input !== 'object') throw new AttachmentBrokerError('invalid-request')
    validateSessionId(input.sessionId)
    validateSelection(input.paths, this.limits.count)
    const projectRoot = await canonicalProjectRoot(input.projectRoot)
    const staged: StagedAttachment[] = []
    const canonicalPaths = new Set<string>()
    const identities = new Set<string>()
    let totalImageBytes = 0

    try {
      for (const selectedPath of input.paths) {
        validateSelectedPath(selectedPath)
        let canonicalPath: string
        try {
          canonicalPath = await realpath(selectedPath)
        } catch {
          throw new AttachmentBrokerError('attachment-unavailable')
        }
        if (canonicalPath.length > MAX_PATH_CHARS) {
          throw new AttachmentBrokerError('attachment-unavailable')
        }
        if (canonicalPaths.has(canonicalPath)) continue
        canonicalPaths.add(canonicalPath)

        const mimeType = imageMimeType(selectedPath)
        if (!mimeType) {
          await assertRegularFile(canonicalPath)
          const notePath = safeNotePath(projectRoot, canonicalPath)
          staged.push({
            kind: 'file',
            displayName: safeLabel(basename(selectedPath)),
            notePath
          })
          continue
        }

        const image = await stageImage(canonicalPath, selectedPath, mimeType)
        const identityKey = `${image.identity.dev}:${image.identity.ino}`
        if (identities.has(identityKey)) {
          await closeQuietly(image.handle)
          continue
        }
        identities.add(identityKey)
        const byteLength = Number(image.identity.size)
        if (byteLength > this.limits.imageBytes) {
          await closeQuietly(image.handle)
          throw new AttachmentBrokerError('image-too-large')
        }
        if (totalImageBytes + byteLength > this.limits.totalImageBytes) {
          await closeQuietly(image.handle)
          throw new AttachmentBrokerError('total-too-large')
        }
        totalImageBytes += byteLength
        staged.push(image)
      }

      if (staged.length === 0) throw new AttachmentBrokerError('invalid-request')
      const token = this.issueToken()
      const expiresAtMs = Date.now() + this.ttlMs
      const timer = setTimeout(() => {
        const entry = this.entries.get(token)
        if (!entry) return
        this.entries.delete(token)
        void closeAttachments(entry.attachments)
      }, this.ttlMs)
      timer.unref()
      this.entries.set(token, { sessionId: input.sessionId, expiresAtMs, attachments: staged, timer })
      return {
        token,
        expiresAt: new Date(expiresAtMs).toISOString(),
        attachments: staged.map(rendererSafeSummary)
      }
    } catch (error) {
      await closeAttachments(staged)
      if (error instanceof AttachmentBrokerError) throw error
      throw new AttachmentBrokerError('attachment-unavailable')
    }
  }

  async consume(sessionId: string, token: string): Promise<ConsumedAttachments> {
    validateSessionId(sessionId)
    validateToken(token)
    const entry = this.entries.get(token)
    if (!entry || entry.sessionId !== sessionId) throw new AttachmentBrokerError('invalid-token')
    this.entries.delete(token)
    clearTimeout(entry.timer)

    if (Date.now() >= entry.expiresAtMs) {
      await closeAttachments(entry.attachments)
      throw new AttachmentBrokerError('invalid-token')
    }

    try {
      const blocks: AttachmentPromptBlock[] = []
      const files = entry.attachments.filter(
        (attachment): attachment is StagedRegularFile => attachment.kind === 'file'
      )
      const images = entry.attachments.filter(
        (attachment): attachment is StagedImage => attachment.kind === 'image'
      )
      const fileNote = buildFileNote(files)
      if (fileNote) blocks.push({ type: 'text', text: fileNote })
      const imageNote = buildImageNote(images)
      if (imageNote) blocks.push({ type: 'text', text: imageNote })

      let consumedImageBytes = 0
      for (const image of images) {
        const data = await readStableImage(image, this.limits.imageBytes)
        consumedImageBytes += data.byteLength
        if (consumedImageBytes > this.limits.totalImageBytes) {
          throw new AttachmentBrokerError('total-too-large')
        }
        if (!hasExpectedImageSignature(data, image.mimeType)) {
          throw new AttachmentBrokerError('invalid-image')
        }
        blocks.push({ type: 'image', data: data.toString('base64'), mimeType: image.mimeType })
      }
      return { blocks }
    } catch (error) {
      if (error instanceof AttachmentBrokerError) throw error
      throw new AttachmentBrokerError('attachment-unavailable')
    } finally {
      await closeAttachments(entry.attachments)
    }
  }

  async cancel(sessionId: string, token: string): Promise<boolean> {
    if (!isValidSessionId(sessionId) || !isValidToken(token)) return false
    const entry = this.entries.get(token)
    if (!entry || entry.sessionId !== sessionId) return false
    this.entries.delete(token)
    clearTimeout(entry.timer)
    await closeAttachments(entry.attachments)
    return true
  }

  async clearSession(sessionId: string): Promise<number> {
    if (!isValidSessionId(sessionId)) return 0
    const removed: StagedLease[] = []
    for (const [token, entry] of this.entries) {
      if (entry.sessionId !== sessionId) continue
      this.entries.delete(token)
      clearTimeout(entry.timer)
      removed.push(entry)
    }
    await Promise.all(removed.map((entry) => closeAttachments(entry.attachments)))
    return removed.length
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) clearTimeout(entry.timer)
    await Promise.all(entries.map((entry) => closeAttachments(entry.attachments)))
  }

  private issueToken(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = this.tokenFactory()
      if (isValidToken(token) && !this.entries.has(token)) return token
    }
    throw new AttachmentBrokerError('attachment-unavailable')
  }
}

async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  if (!projectRoot || projectRoot.length > MAX_PATH_CHARS || !isAbsolute(projectRoot)) {
    throw new AttachmentBrokerError('project-unavailable')
  }
  try {
    const canonical = await realpath(projectRoot)
    if (canonical.length > MAX_PATH_CHARS) throw new AttachmentBrokerError('project-unavailable')
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new AttachmentBrokerError('project-unavailable')
    return canonical
  } catch (error) {
    if (error instanceof AttachmentBrokerError) throw error
    throw new AttachmentBrokerError('project-unavailable')
  }
}

async function assertRegularFile(path: string): Promise<void> {
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new AttachmentBrokerError('attachment-unavailable')
  } catch (error) {
    if (error instanceof AttachmentBrokerError) throw error
    throw new AttachmentBrokerError('attachment-unavailable')
  }
}

async function stageImage(
  canonicalPath: string,
  selectedPath: string,
  mimeType: AttachmentImageMimeType
): Promise<StagedImage> {
  let handle: FileHandle | undefined
  try {
    const beforeOpen = await stat(canonicalPath, { bigint: true })
    if (!beforeOpen.isFile()) throw new AttachmentBrokerError('attachment-unavailable')
    handle = await open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const afterOpen = await handle.stat({ bigint: true })
    if (!afterOpen.isFile() || !sameFile(beforeOpen, afterOpen)) {
      throw new AttachmentBrokerError('attachment-unavailable')
    }
    if (afterOpen.size <= 0n) throw new AttachmentBrokerError('invalid-image')
    return {
      kind: 'image',
      displayName: safeLabel(basename(selectedPath)),
      mimeType,
      handle,
      identity: fileIdentity(afterOpen)
    }
  } catch (error) {
    if (handle) await closeQuietly(handle)
    if (error instanceof AttachmentBrokerError) throw error
    throw new AttachmentBrokerError('attachment-unavailable')
  }
}

async function readStableImage(image: StagedImage, maxBytes: number): Promise<Buffer> {
  const before = await image.handle.stat({ bigint: true })
  const beforeIdentity = fileIdentity(before)
  if (!before.isFile() || !sameIdentity(beforeIdentity, image.identity)) {
    throw new AttachmentBrokerError('attachment-unavailable')
  }
  if (before.size <= 0n) throw new AttachmentBrokerError('invalid-image')
  if (before.size > BigInt(maxBytes)) throw new AttachmentBrokerError('image-too-large')

  const expectedBytes = Number(before.size)
  const data = Buffer.allocUnsafe(expectedBytes)
  let offset = 0
  while (offset < expectedBytes) {
    const length = Math.min(READ_CHUNK_BYTES, expectedBytes - offset)
    const result = await image.handle.read(data, offset, length, offset)
    if (result.bytesRead === 0) throw new AttachmentBrokerError('attachment-unavailable')
    offset += result.bytesRead
  }
  const extra = Buffer.allocUnsafe(1)
  const extraRead = await image.handle.read(extra, 0, 1, expectedBytes)
  const after = await image.handle.stat({ bigint: true })
  if (extraRead.bytesRead !== 0 || !sameIdentity(fileIdentity(after), beforeIdentity)) {
    throw new AttachmentBrokerError('attachment-unavailable')
  }
  return data
}

function sameFile(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function fileIdentity(info: {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}): FileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function imageMimeType(path: string): AttachmentImageMimeType | undefined {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    default: return undefined
  }
}

function hasExpectedImageSignature(data: Buffer, mimeType: AttachmentImageMimeType): boolean {
  switch (mimeType) {
    case 'image/png':
      return data.length >= 8 && data.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    case 'image/jpeg':
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    case 'image/gif':
      return data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' ||
        data.subarray(0, 6).toString('ascii') === 'GIF89a')
    case 'image/webp':
      return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' &&
        data.subarray(8, 12).toString('ascii') === 'WEBP'
  }
}

function safeNotePath(projectRoot: string, filePath: string): string {
  const candidate = relative(projectRoot, filePath)
  const insideProject = candidate !== '' && candidate !== '..' && !candidate.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(candidate)
  return safeLabel(insideProject ? candidate : basename(filePath))
}

function safeLabel(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return (sanitized || 'attachment').slice(0, MAX_SAFE_LABEL_CHARS)
}

function buildFileNote(files: StagedRegularFile[]): string | undefined {
  const paths = files.map((file) => file.notePath)
  if (paths.length === 0) return undefined
  if (paths.length === 1) return `Attached file: ${paths[0]}`
  return `Attached files:\n${paths.map((path) => `- ${path}`).join('\n')}`
}

function buildImageNote(images: StagedImage[]): string | undefined {
  const names = images.map((image) => image.displayName)
  if (names.length === 0) return undefined
  if (names.length === 1) return `Attached image: ${names[0]}`
  return `Attached images: ${names.join(', ')}`
}

function rendererSafeSummary(attachment: StagedAttachment): AttachmentItemSummary {
  return { kind: attachment.kind, displayName: attachment.displayName }
}

async function closeAttachments(attachments: StagedAttachment[]): Promise<void> {
  await Promise.all(attachments.map((attachment) =>
    attachment.kind === 'image' ? closeQuietly(attachment.handle) : Promise.resolve()
  ))
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // Cleanup is best effort; no file or path diagnostic crosses the broker boundary.
  }
}

function validateSessionId(sessionId: string): void {
  if (!isValidSessionId(sessionId)) throw new AttachmentBrokerError('invalid-request')
}

function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && sessionId.length > 0 &&
    sessionId.length <= MAX_SESSION_ID_CHARS && sessionId.trim() === sessionId
}

function validateSelection(paths: readonly string[], maxCount: number): void {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new AttachmentBrokerError('invalid-request')
  }
  if (paths.length > maxCount) throw new AttachmentBrokerError('too-many-attachments')
}

function validateSelectedPath(path: string): void {
  if (typeof path !== 'string' || !path || path.length > MAX_PATH_CHARS || !isAbsolute(path)) {
    throw new AttachmentBrokerError('invalid-request')
  }
}

function validateToken(token: string): void {
  if (!isValidToken(token)) throw new AttachmentBrokerError('invalid-token')
}

function isValidToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(token)
}

function lowerBoundedLimit(value: number | undefined, hardLimit: number): number {
  if (value === undefined) return hardLimit
  if (!Number.isSafeInteger(value) || value < 1) throw new AttachmentBrokerError('invalid-request')
  return Math.min(value, hardLimit)
}

function boundedTtl(value: number | undefined): number {
  if (value === undefined) return ATTACHMENT_HARD_LIMITS.ttlMs
  if (!Number.isSafeInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) {
    throw new AttachmentBrokerError('invalid-request')
  }
  return value
}

function errorMessage(code: AttachmentBrokerErrorCode): string {
  switch (code) {
    case 'invalid-request': return 'The attachment request is not valid.'
    case 'project-unavailable': return 'The selected project is unavailable.'
    case 'attachment-unavailable': return 'A selected attachment is unavailable.'
    case 'too-many-attachments': return 'Too many attachments were selected.'
    case 'image-too-large': return 'A selected image exceeds the attachment limit.'
    case 'total-too-large': return 'The selected images exceed the total attachment limit.'
    case 'invalid-image': return 'A selected image is not a supported image file.'
    case 'invalid-token': return 'The attachment selection is no longer available.'
  }
}
