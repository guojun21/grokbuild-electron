import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

const MAX_SOURCE_BYTES = 30 * 1024 * 1024
const IMAGE_EXTENSION = /\.(jpe?g|png|webp)$/i

/** Where the grok CLI's image_gen tool writes; the only trusted display root. */
export function defaultGeneratedImageRoot(): string {
  return join(homedir(), '.grok', 'sessions')
}

/**
 * The path in an ImageGen rawOutput is an agent claim, not a fact. Display is
 * allowed only for a real, regular image file that resolves inside the CLI's
 * own generated-image root. That boundary keeps a fabricated or hostile path
 * from turning into a preview of an arbitrary file on disk.
 */
export function resolveGeneratedImagePath(
  claimedPath: string,
  rootPath: string
): string | undefined {
  try {
    const root = realpathSync(rootPath)
    const resolved = realpathSync(claimedPath)
    if (!resolved.startsWith(root + sep)) return undefined
    if (!IMAGE_EXTENSION.test(resolved)) return undefined
    const stats = statSync(resolved)
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_SOURCE_BYTES) return undefined
    return resolved
  } catch {
    return undefined
  }
}
