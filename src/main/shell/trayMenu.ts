import type { MenuItemConstructorOptions } from 'electron'

export interface TrayMenuState {
  windowVisible: boolean
  canCreateSession: boolean
}

export interface TrayMenuActions {
  toggleWindow: () => void
  createSession: () => void
  quit: () => void
}

export function createTrayMenuTemplate(
  state: TrayMenuState,
  actions: TrayMenuActions
): MenuItemConstructorOptions[] {
  return [
    {
      label: state.windowVisible ? 'Hide' : 'Show',
      click: actions.toggleWindow
    },
    {
      label: 'New Chat',
      enabled: state.canCreateSession,
      click: actions.createSession
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: actions.quit
    }
  ]
}
