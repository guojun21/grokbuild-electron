export type SessionLifecycleStatus = 'started' | 'completed' | 'needs-input' | 'error'

export interface SessionLifecycleEvent {
  sessionId: string
  status: SessionLifecycleStatus
}

export interface SessionNotificationTarget {
  sessionId: string
  turn: number
  status: Exclude<SessionLifecycleStatus, 'started'>
}

export interface SessionNotificationCoordinatorOptions {
  isForeground: () => boolean
  publish: (target: SessionNotificationTarget) => void
  maxRememberedTargets?: number
}

/**
 * Converts content-free session lifecycle events into deduplicated notification targets.
 * The coordinator deliberately has no access to transcripts, project paths, or error text.
 */
export class SessionNotificationCoordinator {
  private readonly turns = new Map<string, number>()
  private readonly rememberedTargets = new Set<string>()
  private readonly rememberedTargetOrder: string[] = []
  private readonly maxRememberedTargets: number

  constructor(private readonly options: SessionNotificationCoordinatorOptions) {
    this.maxRememberedTargets = Math.max(1, options.maxRememberedTargets ?? 4_096)
  }

  handle(event: SessionLifecycleEvent): void {
    if (event.status === 'started') {
      this.turns.set(event.sessionId, (this.turns.get(event.sessionId) ?? 0) + 1)
      return
    }

    const target: SessionNotificationTarget = {
      sessionId: event.sessionId,
      turn: this.turns.get(event.sessionId) ?? 0,
      status: event.status
    }
    const key = JSON.stringify([target.sessionId, target.turn, target.status])
    if (this.rememberedTargets.has(key)) return
    this.remember(key)

    // Foreground events are intentionally consumed, not deferred until the window is hidden.
    if (!this.options.isForeground()) this.options.publish(target)
  }

  private remember(key: string): void {
    this.rememberedTargets.add(key)
    this.rememberedTargetOrder.push(key)
    while (this.rememberedTargetOrder.length > this.maxRememberedTargets) {
      const oldest = this.rememberedTargetOrder.shift()
      if (oldest) this.rememberedTargets.delete(oldest)
    }
  }
}
