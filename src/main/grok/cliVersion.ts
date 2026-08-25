const MAX_VERSION_LINE_LENGTH = 256

/** Parses the fixed Grok version shape while discarding build metadata. */
export function canonicalCliVersion(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine || firstLine.length > MAX_VERSION_LINE_LENGTH) return undefined
  const match = /^(?:grok\s+)?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:\s+\([A-Za-z0-9._-]{1,128}\))?$/i.exec(firstLine)
  if (!match) return undefined
  return match.slice(1, 4).map((part) => String(Number(part))).join('.')
}

export function cliVersionAtLeast(
  version: string | undefined,
  minimum: readonly [number, number, number]
): boolean {
  const canonical = canonicalCliVersion(version)
  if (!canonical) return false
  const actual = canonical.split('.').map(Number)
  for (let index = 0; index < minimum.length; index += 1) {
    const actualPart = actual[index] ?? 0
    const minimumPart = minimum[index] ?? 0
    if (actualPart !== minimumPart) return actualPart > minimumPart
  }
  return true
}
