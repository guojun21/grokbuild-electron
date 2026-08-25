import { describe, expect, it, vi } from 'vitest'
import { createTrayMenuTemplate } from '../../src/main/shell/trayMenu'

describe('macOS status item menu', () => {
  it('switches Show/Hide and enables New Chat only for a selected project', () => {
    const toggleWindow = vi.fn()
    const createSession = vi.fn()
    const quit = vi.fn()
    const actions = { toggleWindow, createSession, quit }

    const hidden = createTrayMenuTemplate(
      { windowVisible: false, canCreateSession: false },
      actions
    )
    expect(hidden.map((item) => item.label ?? item.type)).toEqual([
      'Show',
      'New Chat',
      'separator',
      'Quit'
    ])
    expect(hidden[1]?.enabled).toBe(false)

    const visible = createTrayMenuTemplate(
      { windowVisible: true, canCreateSession: true },
      actions
    )
    expect(visible[0]?.label).toBe('Hide')
    expect(visible[1]?.enabled).toBe(true)

    visible[0]?.click?.({} as never, {} as never, {} as never)
    visible[1]?.click?.({} as never, {} as never, {} as never)
    visible[3]?.click?.({} as never, {} as never, {} as never)
    expect(toggleWindow).toHaveBeenCalledOnce()
    expect(createSession).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })
})
