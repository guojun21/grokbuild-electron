import type { SessionNotificationTarget } from './SessionNotificationCoordinator'

export interface SafeNotificationOptions {
  title: string
  body: string
  silent: boolean
}

export interface SafeNotificationPresenter {
  isSupported: () => boolean
  show: (options: SafeNotificationOptions, onClick: () => void) => void
}

const notificationCopy: Record<SessionNotificationTarget['status'], SafeNotificationOptions> = {
  completed: {
    title: 'GrokBuild',
    body: 'A turn finished.',
    silent: false
  },
  'needs-input': {
    title: 'GrokBuild needs your input',
    body: 'Open GrokBuild to respond.',
    silent: false
  },
  error: {
    title: 'GrokBuild hit an error',
    body: 'Open GrokBuild for details.',
    silent: false
  }
}

/**
 * The only accepted payload is an opaque target. Notification copy is fixed here so user
 * prompts, paths, tool output, error details, and secrets cannot reach macOS notifications.
 */
export class TargetOnlyNotificationAdapter {
  constructor(
    private readonly presenter: SafeNotificationPresenter,
    private readonly activateTarget: (sessionId: string) => void
  ) {}

  publish(target: SessionNotificationTarget): void {
    try {
      if (!this.presenter.isSupported()) return
      const copy = notificationCopy[target.status]
      this.presenter.show({ ...copy }, () => this.activateTarget(target.sessionId))
    } catch {
      // Native notification availability and user policy must never affect session processing.
    }
  }
}
