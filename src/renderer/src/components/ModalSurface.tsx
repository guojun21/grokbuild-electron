import { useEffect, useRef, type ReactNode } from 'react'

interface ModalSurfaceProps {
  labelledBy: string
  className?: string
  children: ReactNode
  onClose: () => void
  onRequestClose?: () => boolean
}

interface InitialFocusState {
  hadUserInteraction: boolean
  hasDialogFocus: boolean
  focusChangedSinceOpen: boolean
}

/**
 * `showModal()` applies its own synchronous focus step. We may replace that
 * browser-selected target on the next frame, but only while nothing else has
 * deliberately established focus inside the dialog in the meantime.
 */
export function shouldApplyModalInitialFocus({
  hadUserInteraction,
  hasDialogFocus,
  focusChangedSinceOpen
}: InitialFocusState): boolean {
  return !hadUserInteraction && (!hasDialogFocus || !focusChangedSinceOpen)
}

/**
 * Native top-layer modal wrapper. `showModal()` makes the application behind
 * the dialog inert, supplies a browser-managed focus loop, and keeps sidebar
 * popovers from escaping above the surface by z-index alone.
 */
export function ModalSurface({
  labelledBy,
  className,
  children,
  onClose,
  onRequestClose
}: ModalSurfaceProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  const onRequestCloseRef = useRef(onRequestClose)

  useEffect(() => {
    onCloseRef.current = onClose
    onRequestCloseRef.current = onRequestClose
  }, [onClose, onRequestClose])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    const focusAfterOpen = document.activeElement
    let hadUserInteraction = false
    const recordUserInteraction = (): void => {
      hadUserInteraction = true
    }
    dialog.addEventListener('pointerdown', recordUserInteraction, true)
    dialog.addEventListener('keydown', recordUserInteraction, true)
    const frame = window.requestAnimationFrame(() => {
      dialog.removeEventListener('pointerdown', recordUserInteraction, true)
      dialog.removeEventListener('keydown', recordUserInteraction, true)
      const activeElement = document.activeElement
      const hasDialogFocus = dialog.contains(activeElement)
      if (shouldApplyModalInitialFocus({
        hadUserInteraction,
        hasDialogFocus,
        focusChangedSinceOpen: hasDialogFocus && activeElement !== focusAfterOpen
      })) {
        dialog.querySelector<HTMLElement>('[data-modal-initial-focus]')?.focus()
      }
    })
    return () => {
      window.cancelAnimationFrame(frame)
      dialog.removeEventListener('pointerdown', recordUserInteraction, true)
      dialog.removeEventListener('keydown', recordUserInteraction, true)
      if (dialog.open) dialog.close()
    }
  }, [])

  function close(): void {
    if (onRequestCloseRef.current?.() === false) return
    const dialog = dialogRef.current
    if (dialog?.open) dialog.close()
    onCloseRef.current()
  }

  return (
    <dialog
      ref={dialogRef}
      className={`app-modal${className ? ` ${className}` : ''}`}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault()
        // React events from a portal still bubble through the component tree.
        // Keep Escape scoped to the top-most modal instead of also closing its
        // logical parent surface.
        event.stopPropagation()
        close()
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      {children}
    </dialog>
  )
}
