import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { strictUuidSchema } from '../../shared/identifiers'
import {
  acpAgentProfileSchema,
  type AcpAgentProfile
} from '../../shared/acp/workerProtocol'
import {
  parseJsonRpcLine,
  rpcError,
  rpcNotification,
  rpcRequest,
  rpcResult,
  type JsonRpcId,
  type JsonRpcMessage
} from '../../shared/acp/jsonrpc'
import {
  interactionAnswerSchema,
  pendingInteractionSchema,
  type InteractionAnswer,
  type InteractionResolved,
  type PendingInteraction
} from '../../shared/acp/interactions'
import { sanitizeDisplayText, sanitizeDisplayTitle } from '../../shared/security/redaction'
import {
  attachmentPromptBlocksSchema,
  type AttachmentPrompt,
  type AttachmentPromptBlock
} from '../../shared/attachments'
import { grokMemoryLaunchArgument } from '../../shared/memory'
import {
  isTrustedOnlySessionUpdate,
  trustedUpdatesFromPromptResult,
  trustedUpdatesFromSessionNotification,
  trustedUpdatesFromSessionUpdate,
  type TrustedAcpUpdate
} from '../../shared/acp/trustedUpdates'
import { TerminalHost, TerminalHostError } from './TerminalHost'
import { FsHost, FsHostError } from './FsHost'
import {
  classifyAcpRpcFault,
  PublicAcpError,
  toPublicAcpError,
  type AcpRpcFaultKind
} from './PublicSessionError'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export interface AcpPermissionRequest {
  rpcId: JsonRpcId
  requestId: string
  sessionId: string
  title: string
  description?: string | undefined
  options: Array<{ id: string; label: string; intent?: string | undefined }>
}

export interface AcpCapabilities {
  currentModelId?: string | undefined
  availableModels: Array<{ id: string; name: string; contextLimit?: number | undefined }>
  currentModeId?: 'default' | 'plan' | 'ask' | 'yolo' | undefined
  availableModes: Array<{ id: 'default' | 'plan' | 'ask' | 'yolo'; name: string }>
}

export interface AcpStartResult {
  sessionId: string
  resumed: boolean
  staleFallbackFrom?: string | undefined
  forkedFrom?: string | undefined
}

interface AcpClientBaseOptions {
  cliPath: string
  cwd: string
  model: string
  reasoningEffort: string
  /** Selects the CLI-owned memory subsystem for this worker launch. */
  memoryEnabled?: boolean
  agentProfile?: AcpAgentProfile
  env?: NodeJS.ProcessEnv
  /** History restores must never turn a missing remote session into a new one. */
  allowStaleFallback?: boolean
}

export interface AcpForkSessionOptions {
  sourceSessionId: string
  newSessionId: string
  newModelId?: string | undefined
}

export type AcpClientOptions = AcpClientBaseOptions & (
  | { resumeSessionId?: undefined; forkSession?: undefined }
  | { resumeSessionId: string; forkSession?: never }
  | { resumeSessionId?: never; forkSession: AcpForkSessionOptions }
)

export interface AcpClientEvents {
  update: [params: unknown]
  trustedUpdate: [update: TrustedAcpUpdate]
  capabilities: [capabilities: AcpCapabilities]
  permission: [request: AcpPermissionRequest]
  interaction: [request: PendingInteraction]
  interactionResolved: [resolution: InteractionResolved]
  stderr: [line: string]
  exit: [code: number | null, signal: NodeJS.Signals | null]
}

export class AcpClient extends EventEmitter<AcpClientEvents> {
  private static readonly maxStdoutBufferBytes = 4 * 1024 * 1024
  private process: ChildProcessWithoutNullStreams | undefined
  private stdoutBuffer = ''
  private stdoutDecoder = new TextDecoder()
  private nextRequestId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private readonly permissionRequests = new Map<string, JsonRpcId>()
  private readonly interactionRequests = new Map<string, PendingWireInteraction>()
  private readonly interactionKeys = new Map<string, string>()
  private acpSessionId: string | undefined
  private expectedAcpSessionId: string | undefined
  private lastStartResult: AcpStartResult | undefined
  private startPromise: Promise<AcpStartResult> | undefined
  private stopPromise: Promise<void> | undefined
  private intentionallyStoppingProcess: ChildProcessWithoutNullStreams | undefined
  private terminalHost: TerminalHost | undefined
  private fsHost: FsHost | undefined

  constructor(private readonly options: AcpClientOptions) {
    super()
  }

  start(): Promise<AcpStartResult> {
    if (this.process && this.lastStartResult) return Promise.resolve(this.lastStartResult)
    if (!this.startPromise) {
      const attempt = this.startFresh()
        .catch((error: unknown) => { throw toPublicAcpError(error) })
        .finally(() => {
          if (this.startPromise === attempt) this.startPromise = undefined
        })
      this.startPromise = attempt
    }
    return this.startPromise
  }

  private async startFresh(): Promise<AcpStartResult> {
    const agentProfile = parseAgentProfile(this.options.agentProfile)
    if (this.options.resumeSessionId && this.options.forkSession) {
      throw new Error('ACP session load and fork options are mutually exclusive')
    }
    const forkSession = parseForkSessionOptions(this.options.forkSession)
    if (this.stopPromise) await this.stopPromise
    await this.stopTerminalHost()
    this.expectedAcpSessionId = forkSession?.newSessionId ?? this.options.resumeSessionId

    const child = spawn(
      this.options.cliPath,
      [
        grokMemoryLaunchArgument(this.options.memoryEnabled === true),
        'agent',
        '--reasoning-effort',
        this.options.reasoningEffort,
        '--model',
        this.options.model,
        'stdio'
      ],
      {
        cwd: this.options.cwd,
        env: safeCliEnvironment(process.env, this.options.env),
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    this.process = child

    this.stdoutBuffer = ''
    this.stdoutDecoder = new TextDecoder()
    child.stdout.on('data', (chunk: Buffer) => this.handleStdoutChunk(chunk, child))
    child.stdout.on('end', () => {
      const tail = this.stdoutBuffer + this.stdoutDecoder.decode()
      this.stdoutBuffer = ''
      if (tail.trim()) this.handleLine(tail)
    })
    this.attachBoundedStderr(child)
    child.once('error', (error) => this.rejectAll(toPublicAcpError(error)))
    child.once('exit', (code, signal) => {
      this.rejectAll(new PublicAcpError('crash'))
      if (this.intentionallyStoppingProcess !== child) this.emit('exit', code, signal)
      else this.intentionallyStoppingProcess = undefined
      if (this.process === child) {
        this.process = undefined
        this.acpSessionId = undefined
        this.expectedAcpSessionId = undefined
        this.lastStartResult = undefined
        this.fsHost = undefined
        void this.stopTerminalHost().catch(() => {
          this.emit('stderr', 'Failed to stop ACP terminal processes.')
        })
      }
    })

    try {
      const initialization = await this.request(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: { name: 'grokbuild-electron', version: '0.1.0' },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true
          }
        },
        20_000
      )

      let session: unknown
      let sessionId: string
      let resumed = false
      let staleFallbackFrom: string | undefined
      let forkedFrom: string | undefined
      if (forkSession) {
        const forkResult = parseForkSessionResponse(await this.request(
          'x.ai/session/fork',
          {
            sourceSessionId: forkSession.sourceSessionId,
            sourceCwd: this.options.cwd,
            newCwd: this.options.cwd,
            newSessionId: forkSession.newSessionId,
            ...(forkSession.newModelId ? { newModelId: forkSession.newModelId } : {}),
            sessionKind: 'fork'
          },
          30_000
        ))
        if (
          forkResult.newSessionId !== forkSession.newSessionId ||
          forkResult.parentSessionId !== forkSession.sourceSessionId ||
          forkResult.newCwd !== this.options.cwd
        ) {
          throw new Error('Grok CLI returned inconsistent fork metadata')
        }
        sessionId = forkSession.newSessionId
        forkedFrom = forkSession.sourceSessionId
        session = await this.request(
          'session/load',
          {
            sessionId,
            cwd: this.options.cwd,
            mcpServers: [],
            _meta: {
              noReplay: true,
              ...(agentProfile ? { agentProfile } : {})
            }
          },
          30_000
        )
      } else if (this.options.resumeSessionId) {
        try {
          session = await this.request(
            'session/load',
            {
              sessionId: this.options.resumeSessionId,
              cwd: this.options.cwd,
              mcpServers: [],
              ...(agentProfile ? { _meta: { agentProfile } } : {})
            },
            30_000
          )
          sessionId = this.options.resumeSessionId
          resumed = true
        } catch (error) {
          if (!isStaleSessionMissing(error)) throw error
          if (this.options.allowStaleFallback === false) throw error
          staleFallbackFrom = this.options.resumeSessionId
          // The old remote id is no longer authoritative while `session/new`
          // is in flight; late updates for it must fail closed.
          this.expectedAcpSessionId = undefined
          session = await this.request(
            'session/new',
            {
              cwd: this.options.cwd,
              mcpServers: [],
              ...(agentProfile ? { _meta: { agentProfile } } : {})
            },
            30_000
          )
          const sessionRecord = asRecord(session)
          const createdId = firstString(sessionRecord.sessionId, sessionRecord.id)
          if (!createdId) throw new Error('Grok CLI did not return an ACP session id')
          sessionId = createdId
        }
      } else {
        session = await this.request(
          'session/new',
          {
            cwd: this.options.cwd,
            mcpServers: [],
            ...(agentProfile ? { _meta: { agentProfile } } : {})
          },
          30_000
        )
        const sessionRecord = asRecord(session)
        const createdId = firstString(sessionRecord.sessionId, sessionRecord.id)
        if (!createdId) throw new Error('Grok CLI did not return an ACP session id')
        sessionId = createdId
      }
      this.acpSessionId = sessionId
      this.expectedAcpSessionId = sessionId
      this.terminalHost = new TerminalHost({
        sessionId,
        defaultCwd: this.options.cwd,
        environment: safeCliEnvironment(process.env, this.options.env)
      })
      const planPath = grokSessionPlanPath(this.options.cwd, sessionId)
      this.fsHost = new FsHost({
        sessionId,
        allowedRoots: [this.options.cwd],
        ...(planPath ? { allowedFiles: [planPath] } : {})
      })
      // GrokBuild runs one mode by owner decision: the CLI's `yolo`, which
      // auto-approves tool calls. Grok acknowledges the request but sends no
      // current_mode_update for it (unlike `plan`), so the accepted value is
      // carried into the capabilities snapshot rather than awaited as an echo.
      // A rejected request leaves the session reporting Grok's own mode, and
      // an agent-driven switch to `plan` is still tracked as usual.
      const appliedMode = await this.request('session/set_mode', { sessionId, modeId: 'yolo' }, 20_000)
        .then(() => 'yolo' as const)
        .catch(() => undefined)
      this.emit('capabilities', parseCapabilities(initialization, session, appliedMode))
      const result: AcpStartResult = {
        sessionId,
        resumed,
        ...(staleFallbackFrom ? { staleFallbackFrom } : {}),
        ...(forkedFrom ? { forkedFrom } : {})
      }
      this.lastStartResult = result
      return result
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async prompt(prompt: AttachmentPrompt): Promise<void> {
    const blocks = validatedPromptBlocks(prompt)
    const { sessionId } = await this.start()
    const result = await this.request(
      'session/prompt',
      {
        sessionId,
        prompt: blocks
      },
      30 * 60_000
    )
    this.emitTrustedUpdates(trustedUpdatesFromPromptResult(result))
  }

  cancel(): void {
    if (!this.acpSessionId) return
    for (const [requestId, rpcId] of this.permissionRequests) {
      this.write(rpcResult(rpcId, { outcome: { outcome: 'cancelled' } }))
      this.permissionRequests.delete(requestId)
    }
    this.cancelPendingInteractions()
    this.write(rpcNotification('session/cancel', { sessionId: this.acpSessionId }))
  }

  async setModel(model: string): Promise<void> {
    const { sessionId } = await this.start()
    await this.request('session/set_model', { sessionId, modelId: model }, 20_000)
  }

  async setMode(mode: string): Promise<void> {
    const { sessionId } = await this.start()
    await this.request('session/set_mode', { sessionId, modeId: mode }, 20_000)
  }

  async answerPermission(requestId: string, optionId: string): Promise<void> {
    const rpcId = this.permissionRequests.get(requestId)
    if (rpcId === undefined) throw new Error('Permission request is no longer active')
    this.write(rpcResult(rpcId, { outcome: { outcome: 'selected', optionId } }))
    this.permissionRequests.delete(requestId)
  }

  async answerInteraction(interactionId: string, rawAnswer: InteractionAnswer): Promise<void> {
    const answer = interactionAnswerSchema.parse(rawAnswer)
    const pending = this.interactionRequests.get(interactionId)
    if (!pending) throw new Error('Interaction is no longer active')
    if (pending.kind !== answer.kind) throw new Error('Interaction response type does not match')

    const result = pending.kind === 'plan'
      ? planResponse(answer as Extract<InteractionAnswer, { kind: 'plan' }>)
      : questionResponse(
          pending,
          answer as Extract<InteractionAnswer, { kind: 'question' }>
        )
    this.write(rpcResult(pending.rpcId, result))
    this.deleteInteraction(interactionId, pending)
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      const shutdown = this.stopFresh().finally(() => {
        if (this.stopPromise === shutdown) this.stopPromise = undefined
      })
      this.stopPromise = shutdown
    }
    return this.stopPromise
  }

  private async stopFresh(): Promise<void> {
    const child = this.process
    const terminalShutdown = this.stopTerminalHost()
    if (!child) {
      this.acpSessionId = undefined
      this.expectedAcpSessionId = undefined
      this.lastStartResult = undefined
      this.fsHost = undefined
      this.permissionRequests.clear()
      this.interactionRequests.clear()
      this.interactionKeys.clear()
      this.rejectAll(new PublicAcpError('crash'))
      await terminalShutdown
      return
    }
    this.intentionallyStoppingProcess = child
    try {
      child.stdin.end()
    } catch {
      // Continue the bounded process shutdown even if stdin is already unavailable.
    }
    this.permissionRequests.clear()
    this.interactionRequests.clear()
    this.interactionKeys.clear()
    this.rejectAll(new PublicAcpError('crash'))
    if (!(await waitForChildExit(child, 250))) {
      child.kill('SIGTERM')
      if (!(await waitForChildExit(child, 2_000))) {
        child.kill('SIGKILL')
        await waitForChildExit(child, 1_000)
      }
    }
    if (this.process === child) this.process = undefined
    if (this.intentionallyStoppingProcess === child) this.intentionallyStoppingProcess = undefined
    this.acpSessionId = undefined
    this.expectedAcpSessionId = undefined
    this.lastStartResult = undefined
    this.fsHost = undefined
    await terminalShutdown
  }

  private async stopTerminalHost(): Promise<void> {
    const host = this.terminalHost
    if (!host) return
    try {
      await host.stopAll()
    } finally {
      if (this.terminalHost === host) this.terminalHost = undefined
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id))
        reject(new PublicAcpError('network'))
      }, timeoutMs)
      this.pending.set(String(id), { resolve, reject, timeout })
      try {
        this.write(rpcRequest(id, method, params))
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(String(id))
        reject(toPublicAcpError(error))
      }
    })
  }

  private write(payload: string): void {
    if (!this.process?.stdin.writable) throw new PublicAcpError('crash')
    this.process.stdin.write(payload)
  }

  private handleStdoutChunk(chunk: Buffer, child: ChildProcessWithoutNullStreams): void {
    this.stdoutBuffer += this.stdoutDecoder.decode(chunk, { stream: true })
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > AcpClient.maxStdoutBufferBytes) {
      const error = new PublicAcpError('generic')
      this.emit('stderr', error.message)
      this.rejectAll(error)
      child.kill('SIGTERM')
      this.stdoutBuffer = ''
      return
    }
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '')
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      this.handleLine(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private attachBoundedStderr(child: ChildProcessWithoutNullStreams): void {
    const decoder = new TextDecoder()
    let buffer = ''
    const emitLine = (line: string, truncated = false): void => {
      const clean = line.replace(/\r$/, '')
      if (clean) this.emit('stderr', truncated ? `${clean} […truncated]` : clean)
    }
    child.stderr.on('data', (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        emitLine(buffer.slice(0, newline).slice(0, 64 * 1024), newline > 64 * 1024)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      if (buffer.length > 64 * 1024) {
        emitLine(buffer.slice(0, 64 * 1024), true)
        buffer = ''
      }
    })
    child.stderr.on('end', () => {
      const tail = buffer + decoder.decode()
      buffer = ''
      emitLine(tail.slice(0, 64 * 1024), tail.length > 64 * 1024)
    })
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let message: JsonRpcMessage
    try {
      message = parseJsonRpcLine(line)
    } catch {
      this.emit('stderr', 'Ignored malformed ACP stdout.')
      return
    }

    if (message.method) {
      if (message.id !== undefined) {
        this.handleServerRequest(message)
        return
      }
      const ext = normalizeExtRequest(message.method, message.params)
      if (ext.method === 'x.ai/session_notification') {
        if (!this.acceptsSessionEnvelope(ext.params, 'session notification')) return
        const replay = isReplaySessionUpdate(ext.params)
        const trusted = trustedUpdatesFromSessionNotification(ext.params)
        this.emitTrustedUpdates(replay
          ? trusted.filter((event) =>
              event.type !== 'mode_changed' && event.type !== 'hook_execution'
            )
          : trusted)
        if (this.handleSessionNotification(ext.params)) return
      }
      if (
        ext.method === 'session/update' ||
        ext.method === 'x.ai/session/update'
      ) {
        if (!this.acceptsSessionEnvelope(ext.params, 'session update')) return
        const replay = isReplaySessionUpdate(ext.params)
        const trusted = trustedUpdatesFromSessionUpdate(ext.params)
        this.emitTrustedUpdates(replay
          ? trusted.filter((event) =>
              event.type !== 'mode_changed' && event.type !== 'hook_execution'
            )
          : trusted)
        if (
          !isTrustedOnlySessionUpdate(ext.params) &&
          (!replay || isUsageSessionUpdate(ext.params))
        ) {
          this.emit('update', ext.params)
        }
      }
      return
    }

    if (message.id === undefined) return
    const pending = this.pending.get(String(message.id))
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(String(message.id))
    if (message.error) {
      pending.reject(new AcpRpcError(message.error.code, message.error.message, message.error.data))
    }
    else pending.resolve(message.result)
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    if (message.id === undefined || !message.method) return
    const fsMethod = normalizeFsMethod(message.method)
    if (fsMethod) {
      void this.handleFsRequest(message.id, fsMethod, message.params)
      return
    }
    const terminalMethod = normalizeTerminalMethod(message.method)
    if (terminalMethod) {
      void this.handleTerminalRequest(message.id, terminalMethod, message.params)
      return
    }
    if (message.method === 'session/request_permission') {
      if (!this.acceptsSessionEnvelope(message.params, 'permission request')) {
        this.writeReverseResponse(rpcError(
          message.id,
          -32602,
          'Permission request does not match the active ACP session'
        ))
        return
      }
      const params = asRecord(message.params)
      const request = asRecord(params.toolCall ?? params.permission ?? params)
      const rawOptions = Array.isArray(params.options)
        ? params.options
        : Array.isArray(request.options)
          ? request.options
          : []
      const requestId = firstString(params.requestId, request.id, request.toolCallId) ?? String(message.id)
      const description = firstString(request.description, request.detail, params.description)
      const title = sanitizeDisplayTitle(
        firstString(request.title, request.name, params.title) ?? 'Allow this action?',
        2_000
      ) || 'Allow this action?'
      const safeDescription = description
        ? sanitizeDisplayText(description, 20_000).trim()
        : undefined
      const existingRpcId = this.permissionRequests.get(requestId)
      if (existingRpcId !== undefined) {
        if (String(existingRpcId) !== String(message.id)) {
          this.write(rpcResult(message.id, { outcome: { outcome: 'cancelled' } }))
        }
        return
      }
      this.permissionRequests.set(requestId, message.id)
      this.emit('permission', {
        rpcId: message.id,
        requestId,
        sessionId: firstString(params.sessionId, this.acpSessionId) ?? '',
        title,
        ...(safeDescription ? { description: safeDescription } : {}),
        options: rawOptions.map((option, index) => {
          const item = asRecord(option)
          const intent = firstString(item.kind, item.intent)
          return {
            id: firstString(item.optionId, item.id) ?? `option-${index}`,
            label: sanitizeDisplayTitle(
              firstString(item.name, item.label) ?? `Option ${index + 1}`,
              2_000
            ) || `Option ${index + 1}`,
            ...(intent ? { intent } : {})
          }
        })
      })
      return
    }

    const ext = normalizeExtRequest(message.method, message.params)
    if (
      ext.method === 'x.ai/exit_plan_mode' ||
      ext.method === 'session/exit_plan_mode' ||
      ext.method === 'x.ai/ask_user_question'
    ) {
      if (!this.acceptsSessionEnvelope(ext.params, 'interaction request')) {
        this.writeReverseResponse(rpcError(
          message.id,
          -32602,
          'Interaction request does not match the active ACP session'
        ))
        return
      }
      this.handleInteractionRequest(
        message.id,
        ext.method === 'session/exit_plan_mode' ? 'x.ai/exit_plan_mode' : ext.method,
        ext.params
      )
      return
    }

    this.write(rpcError(message.id, -32601, `Client method not available: ${message.method}`))
  }

  private async handleTerminalRequest(
    rpcId: JsonRpcId,
    method: string,
    params: unknown
  ): Promise<void> {
    const host = this.terminalHost
    if (!host) {
      this.writeReverseResponse(
        rpcError(rpcId, -32603, 'ACP terminal host is not available for this session')
      )
      return
    }
    try {
      const result = await host.handle(method, params)
      this.writeReverseResponse(rpcResult(rpcId, result))
    } catch (error) {
      const code = error instanceof TerminalHostError ? error.rpcCode : -32603
      const message = error instanceof TerminalHostError
        ? error.message
        : 'ACP terminal request failed'
      this.writeReverseResponse(rpcError(rpcId, code, message))
      if (!(error instanceof TerminalHostError)) this.emit('stderr', 'ACP terminal host failed.')
    }
  }

  private async handleFsRequest(
    rpcId: JsonRpcId,
    method: string,
    params: unknown
  ): Promise<void> {
    const host = this.fsHost
    if (!host) {
      this.writeReverseResponse(
        rpcError(rpcId, -32603, 'ACP filesystem host is not available for this session')
      )
      return
    }
    try {
      const result = await host.handle(method, params)
      this.writeReverseResponse(rpcResult(rpcId, result))
    } catch (error) {
      const code = error instanceof FsHostError ? error.rpcCode : -32603
      const message = error instanceof FsHostError
        ? error.message
        : 'ACP filesystem request failed'
      this.writeReverseResponse(rpcError(rpcId, code, message))
      if (!(error instanceof FsHostError)) this.emit('stderr', 'ACP filesystem host failed.')
    }
  }

  private writeReverseResponse(payload: string): void {
    try {
      this.write(payload)
    } catch {
      this.emit('stderr', 'Failed to write an ACP reverse response during shutdown.')
    }
  }

  private handleInteractionRequest(
    rpcId: JsonRpcId,
    method: 'x.ai/exit_plan_mode' | 'x.ai/ask_user_question',
    rawParams: unknown
  ): void {
    try {
      if (this.interactionRequests.size >= 64) {
        this.write(rpcResult(rpcId, { outcome: 'cancelled' }))
        this.emit('stderr', 'Rejected ACP interaction because the pending queue reached 64 entries')
        return
      }
      const interactionId = randomUUID()
      const activeSessionId = this.acpSessionId
        ?? this.expectedAcpSessionId
      const pending = method === 'x.ai/exit_plan_mode'
        ? parsePlanInteraction(interactionId, rpcId, rawParams, activeSessionId)
        : parseQuestionInteraction(interactionId, rpcId, rawParams, activeSessionId)
      const existingInteractionId = this.interactionKeys.get(pending.wireKey)
      if (existingInteractionId) {
        const existing = this.interactionRequests.get(existingInteractionId)
        if (!existing || String(existing.rpcId) !== String(rpcId)) {
          this.write(rpcResult(rpcId, { outcome: 'cancelled' }))
        }
        return
      }
      this.interactionRequests.set(interactionId, pending)
      this.interactionKeys.set(pending.wireKey, interactionId)
      this.emit('interaction', pendingInteractionSchema.parse(pending.publicRequest))
    } catch {
      this.write(rpcError(rpcId, -32602, 'Invalid interaction parameters'))
      this.emit('stderr', 'Rejected invalid ACP interaction parameters.')
    }
  }

  private handleSessionNotification(rawParams: unknown): boolean {
    const raw = asRecord(rawParams)
    const update = asRecord(raw.update)
    if (update.sessionUpdate !== 'interaction_resolved') return false
    const parsed = rawInteractionResolvedNotificationSchema.safeParse(rawParams)
    if (!parsed.success) {
      this.emit('stderr', 'Rejected an invalid interaction-resolved notification.')
      return true
    }
    const activeSessionId = this.acpSessionId
      ?? this.expectedAcpSessionId
    if (activeSessionId && parsed.data.sessionId !== activeSessionId) {
      this.emit('stderr', 'Ignored interaction_resolved notification for a different ACP session')
      return true
    }
    const toolCallId = parsed.data.update.tool_call_id ?? parsed.data.update.toolCallId
    if (!toolCallId) {
      this.emit('stderr', 'Rejected interaction_resolved notification without a tool call id')
      return true
    }
    for (const prefix of ['plan:', 'question:'] as const) {
      const wireKey = `${prefix}${toolCallId}`
      const interactionId = this.interactionKeys.get(wireKey)
      if (!interactionId) continue
      const pending = this.interactionRequests.get(interactionId)
      if (!pending) {
        this.interactionKeys.delete(wireKey)
        continue
      }
      this.deleteInteraction(interactionId, pending)
      this.emit('interactionResolved', { interactionId })
    }
    return true
  }

  /**
   * One `grok agent stdio` process is bound to one ACP session. Reject every
   * session-scoped notification before projecting trusted or raw content when
   * the wire session does not match that binding. A brand-new session has no
   * trustworthy id until `session/new` returns, so early updates fail closed.
   */
  private acceptsSessionEnvelope(rawParams: unknown, label: string): boolean {
    const envelope = asRecord(rawParams)
    const wireSessionId = firstString(envelope.sessionId, envelope.session_id)
    const expectedSessionId = this.acpSessionId
      ?? this.expectedAcpSessionId
    if (!wireSessionId || !expectedSessionId || wireSessionId !== expectedSessionId) {
      this.emit('stderr', `Ignored an ACP ${label} for a different or unbound session.`)
      return false
    }
    return true
  }

  private emitTrustedUpdates(updates: readonly TrustedAcpUpdate[]): void {
    for (const update of updates) this.emit('trustedUpdate', update)
  }

  private cancelPendingInteractions(): void {
    for (const [interactionId, pending] of this.interactionRequests) {
      this.write(rpcResult(pending.rpcId, { outcome: 'cancelled' }))
      this.deleteInteraction(interactionId, pending)
    }
  }

  private deleteInteraction(interactionId: string, pending: PendingWireInteraction): void {
    this.interactionRequests.delete(interactionId)
    if (this.interactionKeys.get(pending.wireKey) === interactionId) {
      this.interactionKeys.delete(pending.wireKey)
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function validatedPromptBlocks(prompt: AttachmentPrompt): AttachmentPromptBlock[] {
  const parsed = attachmentPromptBlocksSchema.safeParse(
    typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt
  )
  if (!parsed.success) throw new PublicAcpError('generic')
  return parsed.data
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timeout)
      child.removeListener('close', onExit)
      child.removeListener('error', onExit)
      resolveExit(exited)
    }
    const onExit = (): void => finish(true)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    child.once('close', onExit)
    child.once('error', onExit)
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function normalizeTerminalMethod(method: string): string | undefined {
  if (method === 'terminal/waitForExit') return 'terminal/wait_for_exit'
  if (
    method === 'terminal/create' ||
    method === 'terminal/output' ||
    method === 'terminal/wait_for_exit' ||
    method === 'terminal/kill' ||
    method === 'terminal/release'
  ) {
    return method
  }
  return undefined
}

function normalizeFsMethod(method: string): string | undefined {
  return method === 'fs/read_text_file' || method === 'fs/write_text_file'
    ? method
    : undefined
}

function grokSessionPlanPath(cwd: string, sessionId: string): string | undefined {
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(sessionId)) return undefined
  return join(
    homedir(),
    '.grok',
    'sessions',
    encodeURIComponent(resolve(cwd)),
    sessionId,
    'plan.md'
  )
}

class AcpRpcError extends Error {
  readonly fault: AcpRpcFaultKind

  constructor(
    readonly rpcCode: number,
    rawMessage: unknown,
    rawData: unknown
  ) {
    const classified = classifyAcpRpcFault(rpcCode, rawMessage, rawData)
    super(classified.message)
    this.name = 'AcpRpcError'
    this.fault = classified.kind
  }
}

function isStaleSessionMissing(error: unknown): boolean {
  return error instanceof AcpRpcError && error.fault === 'not-found'
}

function isReplaySessionUpdate(params: unknown): boolean {
  const envelope = asRecord(params)
  const update = asRecord(envelope.update)
  return asRecord(envelope._meta).isReplay === true || asRecord(update._meta).isReplay === true
}

function isUsageSessionUpdate(params: unknown): boolean {
  const envelope = asRecord(params)
  const update = asRecord(envelope.update ?? envelope)
  const kind = firstString(update.sessionUpdate, update.type, update.kind)
  return kind === 'usage_update' || kind === 'usage'
}

function safeCliEnvironment(base: NodeJS.ProcessEnv, additions?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = { ...base, ...additions }
  const allowed = /^(PATH|HOME|USER|LOGNAME|TMPDIR|SHELL|LANG|LC_[A-Z_]+|TZ|TERM|COLORTERM|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|XAI_API_KEY|GROKBUILD_(E2E|MOCK_(TRANSCRIPT|PENDING_STATE|PROFILE|SCENARIO|LOAD_MODE|FAIL_INITIALIZE|RETRY_MARKER|FAILURE_CANARY|MCP_(CANARY|DOCTOR_MARKER|STATE))))$/i
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && allowed.test(key))
  )
}

function parseCapabilities(
  initialization: unknown,
  session: unknown,
  appliedMode?: 'yolo' | undefined
): AcpCapabilities {
  const initializationRecord = asRecord(initialization)
  const metadata = asRecord(initializationRecord._meta)
  const modelState = asRecord(initializationRecord.modelState ?? metadata.modelState)
  const rawModels = Array.isArray(modelState.availableModels) ? modelState.availableModels : []
  const availableModels = rawModels.slice(0, 64).flatMap((value) => {
    const model = asRecord(value)
    const id = firstString(model.modelId, model.id)
    if (!id) return []
    const modelMetadata = asRecord(model._meta)
    const contextLimit = firstPositiveInteger(
      model.contextLimit,
      model.contextWindow,
      modelMetadata.totalContextTokens,
      modelMetadata.contextLimit,
      modelMetadata.contextWindow
    )
    return [{
      id: id.slice(0, 128),
      name: (firstString(model.name, model.displayName) ?? id).slice(0, 256),
      ...(contextLimit ? { contextLimit } : {})
    }]
  })

  const sessionRecord = asRecord(session)
  const modeState = asRecord(sessionRecord.modeState ?? sessionRecord.modes)
  const rawModes = Array.isArray(sessionRecord.availableModes)
    ? sessionRecord.availableModes
    : Array.isArray(modeState.availableModes)
      ? modeState.availableModes
      : []
  const availableModes = rawModes.slice(0, 8).flatMap((value) => {
    const mode = typeof value === 'string' ? { id: value, name: value } : asRecord(value)
    const id = normalizeModeId(firstString(mode.id, mode.modeId))
    if (!id) return []
    return [{ id, name: (firstString(mode.name, mode.label) ?? modeLabel(id)).slice(0, 128) }]
  })

  const currentModelId = firstString(modelState.currentModelId, initializationRecord.currentModelId)
  const currentModeId = appliedMode ?? normalizeModeId(firstString(
    sessionRecord.currentModeId,
    modeState.currentModeId,
    typeof sessionRecord.mode === 'string' ? sessionRecord.mode : undefined
  ))
  return {
    ...(currentModelId ? { currentModelId: currentModelId.slice(0, 128) } : {}),
    availableModels,
    ...(currentModeId ? { currentModeId } : {}),
    availableModes
  }
}

function normalizeModeId(value: string | undefined): 'default' | 'plan' | 'ask' | 'yolo' | undefined {
  if (value === 'default' || value === 'agent') return 'default'
  if (value === 'plan') return 'plan'
  if (value === 'ask') return 'ask'
  if (value === 'yolo') return 'yolo'
  return undefined
}

function modeLabel(mode: 'default' | 'plan' | 'ask' | 'yolo'): string {
  if (mode === 'default') return 'Agent'
  if (mode === 'yolo') return 'Auto accept'
  return mode === 'plan' ? 'Plan' : 'Ask'
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  const value = values.find((candidate): candidate is number =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
  )
  return value === undefined ? undefined : Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

const rawPlanInteractionSchema = z.object({
  sessionId: z.string().min(1).max(256),
  toolCallId: z.string().min(1).max(256),
  planContent: z.string().max(2 * 1024 * 1024).nullable().optional()
}).strict()

const forkSessionOptionsSchema = z.object({
  sourceSessionId: strictUuidSchema,
  newSessionId: strictUuidSchema,
  newModelId: z.string().min(1).max(128).optional()
}).strict()

const forkSessionResponsePayloadSchema = z.object({
  newSessionId: strictUuidSchema,
  chatMessagesCopied: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatesCopied: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  planStateCopied: z.boolean(),
  newCwd: z.string().min(1).max(4_096),
  parentSessionId: strictUuidSchema,
  newModelId: z.string().min(1).max(128).optional()
}).strict()

const forkSessionResponseSchema = z.union([
  forkSessionResponsePayloadSchema,
  z.object({ result: forkSessionResponsePayloadSchema }).strict()
])

const rawQuestionInteractionSchema = z.object({
  sessionId: z.string().min(1).max(256),
  toolCallId: z.string().min(1).max(256),
  questions: z.array(z.object({
    question: z.string().min(1).max(20_000),
    options: z.array(z.object({
      label: z.string().min(1).max(2_000),
      description: z.string().max(20_000),
      preview: z.string().max(256 * 1024).nullable().optional(),
      id: z.string().min(1).max(256).nullable().optional()
    }).strict()).max(32),
    multiSelect: z.boolean().nullable().optional(),
    id: z.string().min(1).max(256).nullable().optional()
  }).strict()).min(1).max(32),
  mode: z.enum(['default', 'plan']).default('default')
}).strict()

const rawInteractionResolvedNotificationSchema = z.object({
  sessionId: z.string().min(1).max(256),
  update: z.object({
    sessionUpdate: z.literal('interaction_resolved'),
    tool_call_id: z.string().min(1).max(256).optional(),
    toolCallId: z.string().min(1).max(256).optional(),
    _meta: z.unknown().optional()
  }).strict(),
  _meta: z.unknown().optional()
}).strict()

interface PendingWireQuestion {
  id: string
  answerKey: string
  multiSelect: boolean
  otherOptionId: string
  options: Array<{ id: string; label: string; preview?: string | undefined }>
}

type PendingWireInteraction =
  | {
      kind: 'plan'
      rpcId: JsonRpcId
      wireKey: string
      publicRequest: Extract<PendingInteraction, { kind: 'plan' }>
    }
  | {
      kind: 'question'
      rpcId: JsonRpcId
      wireKey: string
      publicRequest: Extract<PendingInteraction, { kind: 'question' }>
      questions: PendingWireQuestion[]
    }

function normalizeExtRequest(
  method: string,
  rawParams: unknown
): { method: string; params: unknown } {
  const params = asRecord(rawParams)
  const nestedMethod = firstString(params.method)
  const normalizedMethod = (nestedMethod ?? method).replace(/^_/, '')
  return {
    method: normalizedMethod,
    params: nestedMethod && 'params' in params ? params.params : rawParams
  }
}

function parseForkSessionOptions(
  value: AcpForkSessionOptions | undefined
): AcpForkSessionOptions | undefined {
  if (value === undefined) return undefined
  return forkSessionOptionsSchema.parse(value)
}

function parseAgentProfile(value: unknown): AcpAgentProfile | undefined {
  if (value === undefined) return undefined
  const parsed = acpAgentProfileSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid ACP agent profile')
  return parsed.data
}

function parseForkSessionResponse(value: unknown): z.infer<typeof forkSessionResponsePayloadSchema> {
  const parsed = forkSessionResponseSchema.parse(value)
  return 'result' in parsed ? parsed.result : parsed
}

function parsePlanInteraction(
  interactionId: string,
  rpcId: JsonRpcId,
  rawParams: unknown,
  activeSessionId: string | undefined
): Extract<PendingWireInteraction, { kind: 'plan' }> {
  const params = rawPlanInteractionSchema.parse(rawParams)
  if (activeSessionId && params.sessionId !== activeSessionId) {
    throw new Error('Plan interaction session does not match the active ACP session')
  }
  return {
    kind: 'plan',
    rpcId,
    wireKey: `plan:${params.toolCallId}`,
    publicRequest: {
      kind: 'plan',
      interactionId,
      sessionId: params.sessionId,
      ...(params.planContent ? { planContent: params.planContent } : {})
    }
  }
}

function parseQuestionInteraction(
  interactionId: string,
  rpcId: JsonRpcId,
  rawParams: unknown,
  activeSessionId: string | undefined
): Extract<PendingWireInteraction, { kind: 'question' }> {
  const params = rawQuestionInteractionSchema.parse(rawParams)
  if (activeSessionId && params.sessionId !== activeSessionId) {
    throw new Error('Question interaction session does not match the active ACP session')
  }
  const questions = params.questions.map((question, questionIndex) => {
    const questionId = `question-${questionIndex + 1}`
    const options = question.options.map((option, optionIndex) => ({
      id: `option-${questionIndex + 1}-${optionIndex + 1}`,
      label: option.label,
      ...(option.preview ? { preview: option.preview } : {})
    }))
    return {
      id: questionId,
      answerKey: question.question,
      multiSelect: question.multiSelect === true,
      otherOptionId: `other-${questionIndex + 1}`,
      options
    }
  })
  return {
    kind: 'question',
    rpcId,
    wireKey: `question:${params.toolCallId}`,
    questions,
    publicRequest: {
      kind: 'question',
      interactionId,
      sessionId: params.sessionId,
      mode: params.mode,
      questions: params.questions.map((question, questionIndex) => {
        const wire = questions[questionIndex]
        if (!wire) throw new Error('Question normalization failed')
        return {
          id: wire.id,
          question: question.question,
          multiSelect: wire.multiSelect,
          otherOptionId: wire.otherOptionId,
          options: question.options.map((option, optionIndex) => {
            const normalized = wire.options[optionIndex]
            if (!normalized) throw new Error('Question option normalization failed')
            return {
              id: normalized.id,
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
              ...(option.preview ? { preview: option.preview } : {})
            }
          })
        }
      })
    }
  }
}

function planResponse(answer: Extract<InteractionAnswer, { kind: 'plan' }>): Record<string, string> {
  const feedback = answer.feedback?.trim()
  return {
    outcome: answer.decision,
    ...(answer.decision === 'cancelled' && feedback ? { feedback } : {})
  }
}

function questionResponse(
  pending: Extract<PendingWireInteraction, { kind: 'question' }>,
  answer: Extract<InteractionAnswer, { kind: 'question' }>
): Record<string, unknown> {
  if (answer.action === 'cancelled') return { outcome: 'cancelled' }
  if (answer.action !== 'accepted' && pending.publicRequest.mode !== 'plan') {
    throw new Error('Plan interview actions require plan mode')
  }
  const answers: Record<string, string[]> = {}
  const partialAnswers: Record<string, string> = {}
  const annotations: Record<string, { preview?: string; notes?: string }> = {}
  const seen = new Set<string>()
  for (const response of answer.answers) {
    if (seen.has(response.questionId)) throw new Error('Question was answered more than once')
    seen.add(response.questionId)
    const question = pending.questions.find((item) => item.id === response.questionId)
    if (!question) throw new Error('Question is no longer active')
    const uniqueOptionIds = [...new Set(response.optionIds)]
    if (uniqueOptionIds.length === 0) {
      if (response.otherText?.trim()) throw new Error('Unexpected freeform answer')
      continue
    }
    const selectedOther = uniqueOptionIds.includes(question.otherOptionId)
    const fixedOptionIds = uniqueOptionIds.filter((id) => id !== question.otherOptionId)
    if (selectedOther && fixedOptionIds.length > 0 && !question.multiSelect) {
      throw new Error('Other cannot be combined with a fixed option')
    }
    if (!question.multiSelect && uniqueOptionIds.length > 1) {
      throw new Error('Single-select question received multiple answers')
    }
    const otherText = response.otherText?.trim()
    if (selectedOther) {
      if (!otherText) throw new Error('Other requires an answer')
      if (fixedOptionIds.length === 0 && answer.action === 'accepted') {
        answers[question.answerKey] = ['Other']
        annotations[question.answerKey] = { notes: otherText }
        continue
      }
      if (fixedOptionIds.length === 0) {
        partialAnswers[question.answerKey] = 'Other'
        continue
      }
    }
    if (otherText && !selectedOther) throw new Error('Unexpected freeform answer')
    const selected = fixedOptionIds.map((optionId) => {
      const option = question.options.find((item) => item.id === optionId)
      if (!option) throw new Error('Question option is no longer active')
      return option
    })
    if (selected.length === 0) continue
    const labels = selected.map((option) => option.label)
    if (answer.action === 'accepted') {
      answers[question.answerKey] = labels
      if (selectedOther && otherText) {
        annotations[question.answerKey] = { notes: otherText }
      } else if (!question.multiSelect && selected[0]?.preview) {
        annotations[question.answerKey] = { preview: selected[0].preview }
      }
    } else {
      partialAnswers[question.answerKey] = labels.join(', ')
    }
  }
  if (answer.action !== 'accepted') {
    return {
      outcome: answer.action,
      ...(Object.keys(partialAnswers).length > 0 ? { partial_answers: partialAnswers } : {})
    }
  }
  return {
    outcome: 'accepted',
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {})
  }
}
