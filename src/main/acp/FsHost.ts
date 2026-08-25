import { randomBytes } from 'node:crypto'
import { constants as fsConstants, realpathSync, statSync, type Stats } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z, type ZodType } from 'zod'

export const FS_MAX_FILE_BYTES = 2 * 1024 * 1024
export const FS_MAX_REQUEST_BYTES = 4 * 1024 * 1024

const MAX_SESSION_ID_BYTES = 256
const MAX_PATH_BYTES = 4_096
const MAX_UINT32 = 4_294_967_295
const NEW_FILE_MODE = 0o600
const NEW_DIRECTORY_MODE = 0o700
const OPEN_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0

const boundedUtf8String = (maximumBytes: number, minimumBytes = 0) => z
  .string()
  .refine((value) => !value.includes('\0'), 'must not contain NUL')
  .refine((value) => Buffer.byteLength(value, 'utf8') >= minimumBytes, `must be at least ${minimumBytes} bytes`)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= maximumBytes, `must not exceed ${maximumBytes} bytes`)

const sessionIdSchema = boundedUtf8String(MAX_SESSION_ID_BYTES, 1)
const absolutePathSchema = boundedUtf8String(MAX_PATH_BYTES, 1)
  .refine(isAbsolute, 'must be an absolute path')
const metaSchema = z.record(z.string(), z.unknown()).nullable().optional()
const uint32Schema = z.number().int().min(0).max(MAX_UINT32).nullable().optional()

const readParamsSchema = z.object({
  sessionId: sessionIdSchema,
  path: absolutePathSchema,
  line: uint32Schema,
  limit: uint32Schema,
  _meta: metaSchema
}).strict()

const writeParamsSchema = z.object({
  sessionId: sessionIdSchema,
  path: absolutePathSchema,
  content: boundedUtf8String(FS_MAX_FILE_BYTES)
    .refine(hasOnlyUnicodeScalars, 'must not contain unpaired UTF-16 surrogates'),
  _meta: metaSchema
}).strict()

export type FsHostMethod = 'fs/read_text_file' | 'fs/write_text_file'

export interface FsReadTextFileResult {
  content: string
}

export type FsWriteTextFileResult = Record<string, never>

export interface FsRpcError {
  code: number
  message: string
}

export interface FsHostOptions {
  sessionId: string
  /**
   * Optional defense-in-depth confinement. Omit this option to preserve ACP's
   * absolute-path semantics, which permit files outside the session cwd.
   * Roots are canonicalized once at construction and must already exist.
   */
  allowedRoots?: readonly string[] | undefined
  /**
   * Exact-file exceptions to `allowedRoots`. This is intended for narrowly
   * scoped files such as the current session's Grok `plan.md`; it does not
   * authorize sibling files or the containing directory. Missing files are
   * supported as long as an ancestor exists when the host is constructed.
   */
  allowedFiles?: readonly string[] | undefined
  /** May lower, but can never raise, the hard 2 MiB file limit. */
  maxFileBytes?: number | undefined
  /** May lower, but can never raise, the hard 4 MiB request limit. */
  maxRequestBytes?: number | undefined
}

export class FsHostError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'FsHostError'
  }

  get rpcError(): FsRpcError {
    return { code: this.rpcCode, message: this.message }
  }

  static invalidParams(message: string): FsHostError {
    return new FsHostError(-32602, message)
  }

  static methodNotFound(method: string): FsHostError {
    return new FsHostError(-32601, `Method not found: ${method.slice(0, 256)}`)
  }

  static operationFailed(message: string, cause?: unknown): FsHostError {
    return new FsHostError(-32603, message, cause === undefined ? undefined : { cause })
  }
}

interface CanonicalDirectory {
  path: string
  stats: Stats
}

/**
 * Bounded ACP reverse filesystem host for a single ACP session.
 *
 * The official v1 wire requires absolute paths. Consequently this class does
 * not silently confine requests to a cwd: callers that need confinement must
 * opt in with `allowedRoots`/`allowedFiles`. Final-component symlinks are always rejected,
 * and opened descriptors are checked against the path snapshot. Node does not
 * expose portable openat/renameat2 primitives, so a hostile process that can
 * replace ancestor directories still leaves a narrow pathname race.
 */
export class FsHost {
  static readonly maxFileBytes = FS_MAX_FILE_BYTES
  static readonly maxRequestBytes = FS_MAX_REQUEST_BYTES

  private readonly sessionId: string
  private readonly allowedRoots: readonly string[] | undefined
  private readonly allowedFiles: readonly string[] | undefined
  private readonly fileByteLimit: number
  private readonly requestByteLimit: number

  constructor(options: FsHostOptions) {
    const parsedSessionId = sessionIdSchema.safeParse(options.sessionId)
    if (!parsedSessionId.success) {
      throw FsHostError.invalidParams('FsHost requires a valid sessionId')
    }
    this.sessionId = parsedSessionId.data
    this.fileByteLimit = boundedIntegerOption(
      options.maxFileBytes,
      FS_MAX_FILE_BYTES,
      0,
      FS_MAX_FILE_BYTES,
      'maxFileBytes'
    )
    this.requestByteLimit = boundedIntegerOption(
      options.maxRequestBytes,
      FS_MAX_REQUEST_BYTES,
      1,
      FS_MAX_REQUEST_BYTES,
      'maxRequestBytes'
    )
    this.allowedRoots = canonicalizeAllowedRoots(options.allowedRoots)
    this.allowedFiles = canonicalizeAllowedFiles(options.allowedFiles)
  }

  get pathPolicy(): 'absolute-paths' | 'allowlist' {
    return this.allowedRoots || this.allowedFiles ? 'allowlist' : 'absolute-paths'
  }

  async handle(
    method: string,
    params: unknown
  ): Promise<FsReadTextFileResult | FsWriteTextFileResult> {
    switch (method) {
      case 'fs/read_text_file':
        return await this.readTextFile(params)
      case 'fs/write_text_file':
        return await this.writeTextFile(params)
      default:
        throw FsHostError.methodNotFound(method)
    }
  }

  async readTextFile(params: unknown): Promise<FsReadTextFileResult> {
    const parsed = this.parseParams('fs/read_text_file', params, readParamsSchema)
    this.assertSessionId(parsed.sessionId)
    const requestedPath = normalizeFilePath(parsed.path)

    try {
      const { canonicalPath, snapshot } = await this.resolveExistingRegularFile(requestedPath)
      const handle = await open(canonicalPath, fsConstants.O_RDONLY | OPEN_NOFOLLOW)
      try {
        const opened = await handle.stat()
        assertRegularFile(opened)
        if (!sameFile(snapshot, opened)) {
          throw FsHostError.operationFailed('Filesystem path changed while it was being opened')
        }
        if (opened.size > this.fileByteLimit) {
          throw FsHostError.invalidParams(`File exceeds the ${this.fileByteLimit}-byte read limit`)
        }

        const bytes = await readBounded(handle, this.fileByteLimit)
        const content = decodeUtf8Strict(bytes)
        return { content: sliceTextByLines(content, parsed.line, parsed.limit) }
      } finally {
        await handle.close()
      }
    } catch (error) {
      rethrowOperationError('Filesystem read failed', error)
    }
  }

  async writeTextFile(params: unknown): Promise<FsWriteTextFileResult> {
    const parsed = this.parseParams('fs/write_text_file', params, writeParamsSchema)
    this.assertSessionId(parsed.sessionId)
    const content = Buffer.from(parsed.content, 'utf8')
    if (content.byteLength > this.fileByteLimit) {
      throw FsHostError.invalidParams(`Content exceeds the ${this.fileByteLimit}-byte write limit`)
    }
    const requestedPath = normalizeFilePath(parsed.path)

    try {
      const parent = await this.prepareWriteDirectory(dirname(requestedPath), requestedPath)
      const canonicalPath = join(parent.path, basename(requestedPath))
      this.assertCanonicalTargetAllowed(canonicalPath)
      const existing = await lstatIfPresent(canonicalPath)
      if (existing) assertRegularFile(existing)

      await this.atomicWrite(canonicalPath, parent, existing, content)
      return {}
    } catch (error) {
      rethrowOperationError('Filesystem write failed', error)
    }
  }

  private parseParams<T>(method: FsHostMethod, params: unknown, schema: ZodType<T>): T {
    assertRequestByteLimit(method, params, this.requestByteLimit)
    const parsed = schema.safeParse(params)
    if (!parsed.success) {
      throw FsHostError.invalidParams(`${method} invalid params: ${summarizeZodIssues(parsed.error)}`)
    }
    return parsed.data
  }

  private assertSessionId(sessionId: string): void {
    if (sessionId !== this.sessionId) {
      throw FsHostError.invalidParams('Filesystem request sessionId does not match this ACP session')
    }
  }

  private async resolveExistingRegularFile(
    requestedPath: string
  ): Promise<{ canonicalPath: string; snapshot: Stats }> {
    if (this.hasPathAllowlist()) {
      await this.assertNearestExistingAncestorAllowsTarget(dirname(requestedPath), requestedPath)
    }
    const canonicalParent = await realpath(dirname(requestedPath))
    const canonicalPath = join(canonicalParent, basename(requestedPath))
    this.assertCanonicalTargetAllowed(canonicalPath)
    const original = await lstat(requestedPath)
    assertRegularFile(original)
    const snapshot = await lstat(canonicalPath)
    assertRegularFile(snapshot)
    if (!sameFile(original, snapshot)) {
      throw FsHostError.operationFailed('Filesystem path changed during validation')
    }
    return { canonicalPath, snapshot }
  }

  private async prepareWriteDirectory(
    requestedParent: string,
    requestedTarget: string
  ): Promise<CanonicalDirectory> {
    if (this.hasPathAllowlist()) {
      await this.assertNearestExistingAncestorAllowsTarget(requestedParent, requestedTarget)
    }
    await mkdir(requestedParent, { recursive: true, mode: NEW_DIRECTORY_MODE })
    const canonicalParent = await realpath(requestedParent)
    this.assertCanonicalTargetAllowed(join(canonicalParent, basename(requestedTarget)))
    const parentStats = await stat(canonicalParent)
    if (!parentStats.isDirectory()) {
      throw FsHostError.invalidParams('Filesystem target parent is not a directory')
    }
    return { path: canonicalParent, stats: parentStats }
  }

  private async assertNearestExistingAncestorAllowsTarget(
    requestedParent: string,
    requestedTarget: string
  ): Promise<void> {
    let candidate = requestedParent
    for (;;) {
      try {
        const canonical = await realpath(candidate)
        const projectedParent = resolve(canonical, relative(candidate, requestedParent))
        this.assertCanonicalTargetAllowed(join(projectedParent, basename(requestedTarget)))
        return
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
      const parent = dirname(candidate)
      if (parent === candidate) {
        throw FsHostError.invalidParams('Filesystem path is outside the filesystem allowlist')
      }
      candidate = parent
    }
  }

  private hasPathAllowlist(): boolean {
    return this.allowedRoots !== undefined || this.allowedFiles !== undefined
  }

  private assertCanonicalTargetAllowed(canonicalPath: string): void {
    if (!this.hasPathAllowlist()) return
    if (this.allowedRoots?.some((root) => isWithin(root, canonicalPath))) return
    if (this.allowedFiles?.includes(canonicalPath)) return
    throw FsHostError.invalidParams('Filesystem path is outside the filesystem allowlist')
  }

  private async atomicWrite(
    targetPath: string,
    parent: CanonicalDirectory,
    existing: Stats | undefined,
    content: Buffer
  ): Promise<void> {
    const temporaryPath = join(
      parent.path,
      `.grokbuild-${process.pid}-${randomBytes(12).toString('hex')}.tmp`
    )
    let failure: unknown

    try {
      const handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | OPEN_NOFOLLOW,
        NEW_FILE_MODE
      )
      try {
        await handle.writeFile(content)
        await handle.chmod(existing ? existing.mode & 0o777 : NEW_FILE_MODE)
        await handle.sync()
      } finally {
        await handle.close()
      }

      const currentParent = await stat(parent.path)
      if (!currentParent.isDirectory() || !sameFile(parent.stats, currentParent)) {
        throw FsHostError.operationFailed('Filesystem target directory changed during write')
      }
      await assertTargetUnchanged(targetPath, existing)

      if (existing) {
        await rename(temporaryPath, targetPath)
      } else {
        // link(2) gives new-file creation no-clobber semantics; the temporary
        // name is removed below after the link becomes visible atomically.
        await link(temporaryPath, targetPath)
      }
    } catch (error) {
      failure = error
    }

    try {
      await unlink(temporaryPath)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT') && failure === undefined) failure = error
    }

    if (failure !== undefined) throw failure
  }
}

async function readBounded(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1)
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset > maximumBytes) {
    throw FsHostError.invalidParams(`File exceeds the ${maximumBytes}-byte read limit`)
  }
  return buffer.subarray(0, offset)
}

function decodeUtf8Strict(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw FsHostError.operationFailed('Filesystem text file is not valid UTF-8', error)
  }
}

export function sliceTextByLines(
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined
): string {
  if (line == null && limit == null) return content
  if (limit === 0) return ''

  const startLine = Math.max(1, line ?? 1)
  let start = 0
  for (let currentLine = 1; currentLine < startLine; currentLine += 1) {
    const newline = content.indexOf('\n', start)
    if (newline < 0) return ''
    start = newline + 1
  }
  if (limit == null) return content.slice(start)

  let cursor = start
  for (let count = 0; count < limit; count += 1) {
    const newline = content.indexOf('\n', cursor)
    if (newline < 0) return content.slice(start)
    if (count === limit - 1) return content.slice(start, newline)
    cursor = newline + 1
  }
  return ''
}

function assertRequestByteLimit(method: string, params: unknown, maximumBytes: number): void {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(params)
  } catch {
    throw FsHostError.invalidParams(`${method} params are not valid JSON`)
  }
  if (serialized === undefined) {
    throw FsHostError.invalidParams(`${method} requires params`)
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw FsHostError.invalidParams(`${method} request exceeds the ${maximumBytes}-byte limit`)
  }
}

function normalizeFilePath(filePath: string): string {
  const normalized = resolve(filePath)
  if (!basename(normalized)) {
    throw FsHostError.invalidParams('Filesystem path must identify a file')
  }
  return normalized
}

function canonicalizeAllowedRoots(roots: readonly string[] | undefined): readonly string[] | undefined {
  if (roots === undefined) return undefined
  if (roots.length === 0) {
    throw FsHostError.invalidParams('allowedRoots must contain at least one directory')
  }
  const canonical = roots.map((root) => {
    if (typeof root !== 'string' || !isAbsolute(root) || Buffer.byteLength(root, 'utf8') > MAX_PATH_BYTES) {
      throw FsHostError.invalidParams('allowedRoots entries must be bounded absolute paths')
    }
    try {
      const path = realpathSync(resolve(root))
      if (!statSync(path).isDirectory()) {
        throw FsHostError.invalidParams('allowedRoots entries must be directories')
      }
      return path
    } catch (error) {
      if (error instanceof FsHostError) throw error
      throw FsHostError.invalidParams('allowedRoots entries must be existing readable directories')
    }
  })
  return [...new Set(canonical)]
}

function canonicalizeAllowedFiles(files: readonly string[] | undefined): readonly string[] | undefined {
  if (files === undefined) return undefined
  if (files.length === 0) {
    throw FsHostError.invalidParams('allowedFiles must contain at least one file path')
  }
  const canonical = files.map((filePath) => {
    if (
      typeof filePath !== 'string' ||
      !isAbsolute(filePath) ||
      Buffer.byteLength(filePath, 'utf8') > MAX_PATH_BYTES
    ) {
      throw FsHostError.invalidParams('allowedFiles entries must be bounded absolute paths')
    }
    const normalized = normalizeFilePath(filePath)
    let candidate = dirname(normalized)
    const missingComponents: string[] = []

    for (;;) {
      try {
        const canonicalAncestor = realpathSync(candidate)
        if (!statSync(canonicalAncestor).isDirectory()) {
          throw FsHostError.invalidParams('allowedFiles ancestors must be directories')
        }
        return join(canonicalAncestor, ...missingComponents, basename(normalized))
      } catch (error) {
        if (error instanceof FsHostError) throw error
        if (!isNodeError(error, 'ENOENT')) {
          throw FsHostError.invalidParams('allowedFiles entries must have a readable ancestor')
        }
      }
      const parent = dirname(candidate)
      if (parent === candidate) {
        throw FsHostError.invalidParams('allowedFiles entries must have an existing ancestor')
      }
      missingComponents.unshift(basename(candidate))
      candidate = parent
    }
  })
  return [...new Set(canonical)]
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return pathFromRoot === '' || (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  )
}

function assertRegularFile(stats: Stats): void {
  if (stats.isSymbolicLink()) {
    throw FsHostError.invalidParams('Filesystem target must not be a symbolic link')
  }
  if (!stats.isFile()) {
    throw FsHostError.invalidParams('Filesystem target must be a regular file')
  }
}

async function lstatIfPresent(filePath: string): Promise<Stats | undefined> {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
}

async function assertTargetUnchanged(targetPath: string, expected: Stats | undefined): Promise<void> {
  const current = await lstatIfPresent(targetPath)
  if (!expected) {
    if (current) {
      throw FsHostError.invalidParams('Filesystem target was created concurrently')
    }
    return
  }
  if (!current || !current.isFile() || current.isSymbolicLink() || !sameFile(expected, current)) {
    throw FsHostError.operationFailed('Filesystem target changed during write')
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

function summarizeZodIssues(error: z.ZodError): string {
  return error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'params'
    return `${path}: ${issue.message}`
  }).join('; ')
}

function boundedIntegerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw FsHostError.invalidParams(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return resolved
}

function rethrowOperationError(message: string, error: unknown): never {
  if (error instanceof FsHostError) throw error
  throw FsHostError.operationFailed(message, error)
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
