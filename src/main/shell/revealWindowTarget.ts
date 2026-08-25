export interface RevealableWindow {
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  focus: () => void
}

export interface RevealWindowTargetOptions {
  window: RevealableWindow | undefined
  selectSession: (sessionId: string) => void
  focusApplication: () => void
}

export function revealWindowTarget(
  options: RevealWindowTargetOptions,
  sessionId?: string
): boolean {
  const window = options.window
  if (!window || window.isDestroyed()) return false
  if (sessionId) {
    try {
      options.selectSession(sessionId)
    } catch {
      // A native notification may outlive a removed session. The app should still be revealed.
    }
  }
  if (window.isMinimized()) window.restore()
  window.show()
  options.focusApplication()
  window.focus()
  return true
}
