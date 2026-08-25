import { EventEmitter } from 'node:events'
import { AcpClient, type AcpCapabilities, type AcpClientOptions, type AcpPermissionRequest } from './AcpClient'
import type { AcpConnection, AcpConnectionOptions } from './AcpConnection'
import type { InteractionResolved, PendingInteraction } from '../../shared/acp/interactions'
import { classifySessionStderr, type PublicSessionErrorKind } from './PublicSessionError'

const MAX_PUBLIC_STDERR_ERRORS_PER_CLIENT = 5
const MAX_DEFERRED_EVENT_COUNT = 256
const MAX_DEFERRED_EVENT_BYTES = 1024 * 1024

interface DeferredEvents {
  bytes: number
  items: Array<() => void>
}

interface ManagedClient {
  client: AcpConnection
  touchedAt: number
  protectionReasons: Set<SessionProtectionReason>
  deferredEvents?: DeferredEvents
}

export type SessionProtectionReason = 'turn' | 'input' | 'selected' | 'activity'

export interface SessionManagerEvents {
  update: [localSessionId: string, params: unknown]
  capabilities: [localSessionId: string, capabilities: AcpCapabilities]
  permission: [localSessionId: string, request: AcpPermissionRequest]
  interaction: [localSessionId: string, request: PendingInteraction]
  interactionResolved: [localSessionId: string, resolution: InteractionResolved]
  error: [localSessionId: string, error: Error]
  exit: [localSessionId: string]
  evicted: [localSessionId: string]
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly clients = new Map<string, ManagedClient>()
  private readonly generations = new Map<string, number>()
  private readonly stoppingClients = new Set<Promise<void>>()
  private readonly stopByClient = new WeakMap<AcpConnection, Promise<void>>()
  private touchCounter = 0

  constructor(
    private maxLiveSessions = 4,
    private readonly factory: (options: AcpConnectionOptions) => AcpConnection = (options) => new AcpClient(options)
  ) {
    super()
  }

  setLimit(limit: number): void {
    this.maxLiveSessions = limit
    this.evictIfNeeded()
  }

  get(localSessionId: string): AcpConnection | undefined {
    const managed = this.clients.get(localSessionId)
    if (!managed) return undefined
    managed.touchedAt = ++this.touchCounter
    return managed.client
  }

  isCurrent(localSessionId: string, client: AcpConnection): boolean {
    return this.clients.get(localSessionId)?.client === client
  }

  /** Snapshot of main-owned live worker identities without touching LRU order. */
  liveSessionIds(): string[] {
    return [...this.clients.keys()]
  }

  create(localSessionId: string, options: AcpClientOptions): AcpConnection {
    return this.createManaged(localSessionId, options, false)
  }

  createDeferred(localSessionId: string, options: AcpClientOptions): AcpConnection {
    return this.createManaged(localSessionId, options, true)
  }

  activateDeferred(localSessionId: string, client: AcpConnection): void {
    const managed = this.clients.get(localSessionId)
    if (managed?.client !== client || !managed.deferredEvents) {
      throw new Error('Deferred ACP session is no longer current')
    }
    const events = managed.deferredEvents.items
    delete managed.deferredEvents
    for (const forward of events) {
      if (this.clients.get(localSessionId)?.client !== client) break
      forward()
    }
  }

  enforceLimit(exemptId?: string): void {
    this.evictIfNeeded(exemptId)
  }

  private createManaged(
    localSessionId: string,
    options: AcpClientOptions,
    deferred: boolean
  ): AcpConnection {
    const existing = this.get(localSessionId)
    if (existing) return existing

    const generation = (this.generations.get(localSessionId) ?? 0) + 1
    this.generations.set(localSessionId, generation)
    const client = this.factory({ ...options, localSessionId, generation })
    const managed: ManagedClient = {
      client,
      touchedAt: ++this.touchCounter,
      protectionReasons: new Set(),
      ...(deferred ? { deferredEvents: { bytes: 0, items: [] } } : {})
    }
    this.clients.set(localSessionId, managed)
    const forwardedErrorKinds = new Set<PublicSessionErrorKind>()
    client.on('update', (params) => {
      this.forwardOrDefer(localSessionId, client, params, () => {
        this.emit('update', localSessionId, params)
      })
    })
    client.on('trustedUpdate', (update) => {
      this.forwardOrDefer(localSessionId, client, update, () => {
        this.emit('update', localSessionId, update)
      })
    })
    client.on('capabilities', (capabilities) => {
      this.forwardOrDefer(localSessionId, client, capabilities, () => {
        this.emit('capabilities', localSessionId, capabilities)
      })
    })
    client.on('permission', (request) => {
      this.forwardOrDefer(localSessionId, client, request, () => {
        this.setProtection(localSessionId, 'input', true)
        this.emit('permission', localSessionId, request)
      })
    })
    client.on('interaction', (request) => {
      this.forwardOrDefer(localSessionId, client, request, () => {
        this.setProtection(localSessionId, 'input', true)
        this.emit('interaction', localSessionId, request)
      })
    })
    client.on('interactionResolved', (resolution) => {
      this.forwardOrDefer(localSessionId, client, resolution, () => {
        this.emit('interactionResolved', localSessionId, resolution)
      })
    })
    client.on('stderr', (line) => {
      if (this.clients.get(localSessionId)?.client !== client) return
      const classified = classifySessionStderr(line)
      if (
        !classified ||
        forwardedErrorKinds.has(classified.kind) ||
        forwardedErrorKinds.size >= MAX_PUBLIC_STDERR_ERRORS_PER_CLIENT
      ) return
      forwardedErrorKinds.add(classified.kind)
      this.forwardOrDefer(localSessionId, client, classified, () => {
        this.emit('error', localSessionId, new Error(classified.message))
      })
    })
    client.on('exit', () => {
      this.forwardOrDefer(localSessionId, client, undefined, () => {
        if (this.clients.get(localSessionId)?.client !== client) return
        this.clients.delete(localSessionId)
        this.emit('exit', localSessionId)
      })
    })
    if (!deferred) this.evictIfNeeded(localSessionId)
    return client
  }

  private forwardOrDefer(
    localSessionId: string,
    client: AcpConnection,
    payload: unknown,
    forward: () => void
  ): void {
    const managed = this.clients.get(localSessionId)
    if (managed?.client !== client) return
    if (!managed.deferredEvents) {
      forward()
      return
    }
    const bytes = boundedSerializedBytes(payload)
    if (
      bytes === undefined ||
      managed.deferredEvents.items.length >= MAX_DEFERRED_EVENT_COUNT ||
      managed.deferredEvents.bytes + bytes > MAX_DEFERRED_EVENT_BYTES
    ) {
      this.clients.delete(localSessionId)
      void this.stopClient(client).catch(() => undefined)
      return
    }
    managed.deferredEvents.bytes += bytes
    managed.deferredEvents.items.push(forward)
  }

  stop(localSessionId: string): Promise<void> {
    const managed = this.clients.get(localSessionId)
    if (!managed) return Promise.resolve()
    this.clients.delete(localSessionId)
    return this.stopClient(managed.client)
  }

  setProtection(
    localSessionId: string,
    reason: SessionProtectionReason,
    enabled: boolean
  ): void {
    const managed = this.clients.get(localSessionId)
    if (!managed) return
    if (enabled) managed.protectionReasons.add(reason)
    else managed.protectionReasons.delete(reason)
    managed.touchedAt = ++this.touchCounter
    if (!enabled) this.evictIfNeeded()
  }

  async stopAll(): Promise<void> {
    const clients = [...this.clients.values()].map((managed) => managed.client)
    this.clients.clear()
    for (const client of clients) {
      void this.stopClient(client).catch(() => undefined)
    }
    while (this.stoppingClients.size > 0) {
      await Promise.allSettled([...this.stoppingClients])
    }
  }

  private evictIfNeeded(exemptId?: string): void {
    while (this.clients.size > this.maxLiveSessions) {
      const candidate = [...this.clients.entries()]
        .filter(([id, managed]) => id !== exemptId && managed.protectionReasons.size === 0)
        .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]
      if (!candidate) return
      const [localSessionId] = candidate
      const stopping = this.stop(localSessionId)
      this.emit('evicted', localSessionId)
      void stopping.catch(() => undefined)
    }
  }

  private stopClient(client: AcpConnection): Promise<void> {
    const existing = this.stopByClient.get(client)
    if (existing) return existing
    let operation: Promise<void>
    try {
      operation = Promise.resolve(client.stop())
    } catch (error) {
      operation = Promise.reject(error)
    }
    this.stopByClient.set(client, operation)
    this.stoppingClients.add(operation)
    void operation.finally(() => {
      this.stoppingClients.delete(operation)
    }).catch(() => undefined)
    return operation
  }
}

function boundedSerializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return 0
    const bytes = Buffer.byteLength(serialized, 'utf8')
    return bytes <= MAX_DEFERRED_EVENT_BYTES ? bytes : undefined
  } catch {
    return undefined
  }
}
