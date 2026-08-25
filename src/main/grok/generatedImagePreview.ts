import { nativeImage } from 'electron'

const PREVIEW_HEIGHT = 768
const FALLBACK_PREVIEW_HEIGHT = 512
const MAX_PREVIEW_CHARS = 400_000

/**
 * Bounded display re-encode of a generated image, mirroring the attachment
 * preview pipeline: the renderer gets this downscaled JPEG data URL, never the
 * original bytes. Generated art keeps a taller budget than attachment thumbs
 * because the lightbox shows this same preview.
 */
export function generatedImagePreview(path: string): string | undefined {
  try {
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return undefined
    for (const height of [PREVIEW_HEIGHT, FALLBACK_PREVIEW_HEIGHT]) {
      const size = image.getSize()
      const scaled = size.height > height ? image.resize({ height }) : image
      const preview = `data:image/jpeg;base64,${scaled.toJPEG(80).toString('base64')}`
      if (preview.length <= MAX_PREVIEW_CHARS) return preview
    }
    return undefined
  } catch {
    return undefined
  }
}
