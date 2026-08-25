import { describe, expect, it, vi } from 'vitest'
import { revealWindowTarget } from '../../src/main/shell/revealWindowTarget'

describe('notification and shell window targeting', () => {
  it('selects the target session, restores, shows, and focuses in order', () => {
    const calls: string[] = []
    const revealed = revealWindowTarget(
      {
        window: {
          isDestroyed: () => false,
          isMinimized: () => true,
          restore: () => calls.push('restore'),
          show: () => calls.push('show'),
          focus: () => calls.push('window-focus')
        },
        selectSession: (sessionId) => calls.push(`select:${sessionId}`),
        focusApplication: () => calls.push('app-focus')
      },
      'session-2'
    )

    expect(revealed).toBe(true)
    expect(calls).toEqual([
      'select:session-2',
      'restore',
      'show',
      'app-focus',
      'window-focus'
    ])
  })

  it('still reveals for a stale target and ignores a destroyed window', () => {
    const show = vi.fn()
    expect(revealWindowTarget({
      window: {
        isDestroyed: () => false,
        isMinimized: () => false,
        restore: vi.fn(),
        show,
        focus: vi.fn()
      },
      selectSession: () => { throw new Error('stale session') },
      focusApplication: vi.fn()
    }, 'stale')).toBe(true)
    expect(show).toHaveBeenCalledOnce()

    expect(revealWindowTarget({
      window: {
        isDestroyed: () => true,
        isMinimized: vi.fn(),
        restore: vi.fn(),
        show,
        focus: vi.fn()
      },
      selectSession: vi.fn(),
      focusApplication: vi.fn()
    }, 'session')).toBe(false)
    expect(show).toHaveBeenCalledOnce()
  })
})
