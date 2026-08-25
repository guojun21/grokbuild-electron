import { EventEmitter } from 'node:events'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { AcpConnectionEvents, AcpConnectionOptions } from './AcpConnection'
import type { AcpStartResult } from './AcpClient'
import type { InteractionAnswer } from '../../shared/acp/interactions'
import {
  attachmentPromptBlocksSchema,
  type AttachmentPrompt,
  type AttachmentPromptBlock
} from '../../shared/attachments'
import {
  classifySessionStderr,
  PublicAcpError,
  publicAcpErrorMessage,
  toPublicAcpError
} from './PublicSessionError'
import {
  workerResponseSchema,
  workerStartResultSchema,
  type WorkerCommand,
  type WorkerLaunch,
  type WorkerResponse
} from '../../shared/acp/workerProtocol'

interface PendingWorkerRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export class AcpWorkerClient extends EventEmitter<AcpConnectionEvents> {
  private worker: UtilityProcess | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingWorkerRequest>()
  private startPromise: Promise<AcpStartResult> | undefined
  private stopPromise: Promise<void> | undefined
  private stopping = false
  private exitEmitted = false
  private lastEventSequence = 0

  constructor(
    private readonly workerModulePath: string,
    private readonly options: AcpConnectionOptions
  ) {
    super()
  }

  start(): Promise<AcpStartResult> {
    if (!this.startPromise) {
      this.startPromise = this.request(
        'start',
        toWorkerLaunch(this.options),
        60_000
      ).then((result) => {
        const parsed = workerStartResultSchema.safeParse(result)
        if (!parsed.success) throw new Error('ACP worker returned an invalid start result')
        return parsed.data
      }).catch((error: unknown) => {
        this.startPromise = undefined
        throw error
      })
    }
    return this.startPromise
  }

  async prompt(prompt: AttachmentPrompt): Promise<void> {
    const blocks = validatedPromptBlocks(prompt)
    await this.start()
    await this.request(
      'prompt',
      typeof prompt === 'string' ? { text: prompt } : { blocks },
      30 * 60_000
    )
  }

  cancel(): void {
    void this.request('cancel', {}, 10_000).catch((error: unknown) => {
      if (!this.stopping) this.emit('stderr', publicAcpErrorMessage(error))
    })
  }

  async setModel(model: string): Promise<void> {
    await this.start()
    await this.request('set_model', { model }, 20_000)
  }

  async setMode(mode: string): Promise<void> {
    await this.start()
    await this.request('set_mode', { mode }, 20_000)
  }

  async answerPermission(requestId: string, optionId: string): Promise<void> {
    await this.request('answer_permission', { requestId, optionId }, 10_000)
  }

  async answerInteraction(interactionId: string, answer: InteractionAnswer): Promise<void> {
    await this.request('answer_interaction', { interactionId, answer }, 10_000)
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const worker = this.worker
    if (!worker) return Promise.resolve()
    this.stopping = true
    const shutdown = this.request('stop', {}, 6_000)
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        worker.kill()
        if (this.stopPromise === shutdown) this.stopPromise = undefined
      })
    this.stopPromise = shutdown
    return shutdown
  }

  private request(
    type: WorkerCommand['type'],
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new PublicAcpError('network'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      worker.postMessage({ id, type, payload })
    })
  }

  private ensureWorker(): UtilityProcess {
    if (this.worker) return this.worker
    const worker = utilityProcess.fork(this.workerModulePath, [], {
      cwd: this.options.cwd,
      env: safeWorkerEnvironment(process.env),
      stdio: ['ignore', 'ignore', 'pipe'],
      serviceName: 'GrokBuild ACP Session',
      allowLoadingUnsignedLibraries: false,
      disclaim: false
    })
    this.worker = worker
    worker.on('error', () => {
      const error = new PublicAcpError('crash')
      this.rejectAll(error)
      if (!this.stopping) this.emit('stderr', error.message)
    })
    worker.on('message', (message) => this.handleMessage(extractMessageData(message)))
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = undefined
      this.rejectAll(new PublicAcpError('crash'))
      if (!this.stopping && !this.exitEmitted) {
        this.exitEmitted = true
        this.emit('exit', code, null)
      }
    })
    worker.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim()
      const classified = classifySessionStderr(line)
      if (classified) this.emit('stderr', classified.message)
    })
    return worker
  }

  private handleMessage(raw: unknown): void {
    const parsed = workerResponseSchema.safeParse(raw)
    if (!parsed.success) {
      this.emit('stderr', 'Rejected an invalid ACP worker message.')
      return
    }
    const message: WorkerResponse = parsed.data
    if (message.kind === 'response') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(toPublicAcpError(message.error))
      return
    }
    if (
      message.localSessionId !== this.options.localSessionId ||
      message.generation !== this.options.generation ||
      message.sequence !== this.lastEventSequence + 1
    ) {
      this.protocolFault()
      return
    }
    this.lastEventSequence = message.sequence
    switch (message.event) {
      case 'update':
        this.emit('update', message.payload)
        break
      case 'trusted_update':
        this.emit('trustedUpdate', message.payload)
        break
      case 'capabilities':
        this.emit('capabilities', message.payload)
        break
      case 'permission':
        this.emit('permission', message.payload)
        break
      case 'interaction':
        this.emit('interaction', message.payload)
        break
      case 'interaction_resolved':
        this.emit('interactionResolved', message.payload)
        break
      case 'stderr':
        {
          const classified = classifySessionStderr(message.payload)
          if (classified) this.emit('stderr', classified.message)
        }
        break
      case 'exit': {
        if (!this.exitEmitted) {
          this.exitEmitted = true
          const payload = asRecord(message.payload)
          this.emit('exit', typeof payload.code === 'number' ? payload.code : null, null)
        }
        this.worker?.kill()
        break
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private protocolFault(): void {
    const error = new PublicAcpError('generic')
    this.emit('stderr', error.message)
    this.rejectAll(error)
    this.worker?.kill()
  }
}

function validatedPromptBlocks(prompt: AttachmentPrompt): AttachmentPromptBlock[] {
  const parsed = attachmentPromptBlocksSchema.safeParse(
    typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt
  )
  if (!parsed.success) throw new PublicAcpError('generic')
  return parsed.data
}

function toWorkerLaunch(options: AcpConnectionOptions): WorkerLaunch {
  return {
    localSessionId: options.localSessionId,
    generation: options.generation,
    cliPath: options.cliPath,
    cwd: options.cwd,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    ...(options.memoryEnabled !== undefined ? { memoryEnabled: options.memoryEnabled } : {}),
    ...(options.agentProfile ? { agentProfile: options.agentProfile } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    ...(options.resumeSessionId && options.allowStaleFallback !== undefined
      ? { allowStaleFallback: options.allowStaleFallback }
      : {}),
    ...(options.forkSession ? { forkSession: options.forkSession } : {}),
    environment: Object.fromEntries(
      Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
  }
}

function safeWorkerEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = /^(PATH|HOME|USER|LOGNAME|TMPDIR|SHELL|LANG|LC_[A-Z_]+|TZ|TERM|COLORTERM|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|XAI_API_KEY|GROKBUILD_(E2E|MOCK_(TRANSCRIPT|PENDING_STATE|PROFILE|SCENARIO|LOAD_MODE|FAIL_INITIALIZE|RETRY_MARKER|FAILURE_CANARY|MCP_(CANARY|DOCTOR_MARKER|STATE))))$/i
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined && allowed.test(entry[0]))
  )
}

function extractMessageData(message: unknown): unknown {
  const object = asRecord(message)
  return 'data' in object ? object.data : message
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
