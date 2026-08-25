import { describe, expect, it, vi } from 'vitest'
import {
  SessionNotificationCoordinator,
  type SessionNotificationTarget
} from '../../src/main/notifications/SessionNotificationCoordinator'
import {
  TargetOnlyNotificationAdapter,
  type SafeNotificationOptions
} from '../../src/main/notifications/TargetOnlyNotificationAdapter'

describe('SessionNotificationCoordinator', () => {
  it('deduplicates by session, turn, and status while allowing the next turn', () => {
    const published: SessionNotificationTarget[] = []
    const coordinator = new SessionNotificationCoordinator({
      isForeground: () => false,
      publish: (target) => published.push(target)
    })

    coordinator.handle({ sessionId: 'session-a', status: 'started' })
    coordinator.handle({ sessionId: 'session-a', status: 'needs-input' })
    coordinator.handle({ sessionId: 'session-a', status: 'needs-input' })
    coordinator.handle({ sessionId: 'session-a', status: 'completed' })
    coordinator.handle({ sessionId: 'session-a', status: 'completed' })
    coordinator.handle({ sessionId: 'session-b', status: 'error' })
    coordinator.handle({ sessionId: 'session-a', status: 'started' })
    coordinator.handle({ sessionId: 'session-a', status: 'completed' })

    expect(published).toEqual([
      { sessionId: 'session-a', turn: 1, status: 'needs-input' },
      { sessionId: 'session-a', turn: 1, status: 'completed' },
      { sessionId: 'session-b', turn: 0, status: 'error' },
      { sessionId: 'session-a', turn: 2, status: 'completed' }
    ])
  })

  it('consumes foreground events instead of replaying them after the app is hidden', () => {
    let foreground = true
    const publish = vi.fn()
    const coordinator = new SessionNotificationCoordinator({
      isForeground: () => foreground,
      publish
    })

    coordinator.handle({ sessionId: 'session-a', status: 'started' })
    coordinator.handle({ sessionId: 'session-a', status: 'completed' })
    foreground = false
    coordinator.handle({ sessionId: 'session-a', status: 'completed' })

    expect(publish).not.toHaveBeenCalled()
  })
})

describe('TargetOnlyNotificationAdapter', () => {
  it('uses fixed safe copy and returns only the opaque session target on click', () => {
    const shown: Array<{ options: SafeNotificationOptions; onClick: () => void }> = []
    const activateTarget = vi.fn()
    const adapter = new TargetOnlyNotificationAdapter(
      {
        isSupported: () => true,
        show: (options, onClick) => shown.push({ options, onClick })
      },
      activateTarget
    )
    const sensitiveTarget = '/Users/alice/secret-project prompt=do-not-leak token=abc'

    adapter.publish({ sessionId: sensitiveTarget, turn: 7, status: 'error' })

    expect(shown).toHaveLength(1)
    expect(shown[0]?.options).toEqual({
      title: 'GrokBuild hit an error',
      body: 'Open GrokBuild for details.',
      silent: false
    })
    expect(JSON.stringify(shown[0]?.options)).not.toContain('secret-project')
    shown[0]?.onClick()
    expect(activateTarget).toHaveBeenCalledWith(sensitiveTarget)
  })

  it('does nothing when native notifications are unavailable', () => {
    const show = vi.fn()
    const adapter = new TargetOnlyNotificationAdapter(
      { isSupported: () => false, show },
      vi.fn()
    )

    adapter.publish({ sessionId: 'session-a', turn: 1, status: 'completed' })

    expect(show).not.toHaveBeenCalled()
  })

  it('contains native notification failures', () => {
    const adapter = new TargetOnlyNotificationAdapter(
      {
        isSupported: () => true,
        show: () => {
          throw new Error('Notification Center denied the request')
        }
      },
      vi.fn()
    )

    expect(() => adapter.publish({ sessionId: 'session-a', turn: 1, status: 'error' }))
      .not.toThrow()
  })
})
