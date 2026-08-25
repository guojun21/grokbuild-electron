import { useEffect, useRef } from 'react'

export interface LightboxRequest {
  src: string
  name: string
  /** Absolute path of the source file; the caption copies it on click. */
  path?: string | undefined
  /** Where the clicked thumbnail sat, so the zoom can grow out of it. */
  origin: { x: number; y: number; width: number; height: number }
}

/**
 * Full-window image viewer. The image FLIPs from the clicked thumbnail's
 * rectangle to its centered size and reverses on close, so the popup reads as
 * the thumbnail growing rather than a context switch.
 */
export function ImageLightbox({
  request,
  onClose
}: {
  request: LightboxRequest
  onClose: () => void
}): React.JSX.Element {
  const backdrop = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLImageElement>(null)
  const closing = useRef(false)
  const close = (): void => {
    if (closing.current) return
    closing.current = true
    const image = frame.current
    const shade = backdrop.current
    if (!image || !shade) {
      onClose()
      return
    }
    shade.style.opacity = '0'
    applyOriginTransform(image, request.origin)
    image.addEventListener('transitionend', () => onClose(), { once: true })
    window.setTimeout(onClose, 320)
  }

  useEffect(() => {
    const image = frame.current
    if (image) {
      applyOriginTransform(image, request.origin)
      // Two frames so the origin transform paints before transitioning away.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        image.style.transform = 'translate(0, 0) scale(1)'
        image.style.opacity = '1'
      }))
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={backdrop}
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={request.name}
      data-testid="image-lightbox"
      onClick={close}
    >
      <img
        ref={frame}
        className="lightbox-image"
        src={request.src}
        alt={request.name}
        draggable={false}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void window.grokbuild.showImageMenu({
            name: request.name,
            ...(request.path ? { path: request.path } : {}),
            dataUrl: request.src
          })
        }}
      />
    </div>
  )
}

function applyOriginTransform(
  image: HTMLImageElement,
  origin: LightboxRequest['origin']
): void {
  const target = image.getBoundingClientRect()
  if (target.width === 0 || target.height === 0) return
  const scaleX = origin.width / target.width
  const scaleY = origin.height / target.height
  const scale = Math.max(scaleX, scaleY)
  const translateX = origin.x + origin.width / 2 - (target.x + target.width / 2)
  const translateY = origin.y + origin.height / 2 - (target.y + target.height / 2)
  image.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`
  image.style.opacity = '0.6'
}
