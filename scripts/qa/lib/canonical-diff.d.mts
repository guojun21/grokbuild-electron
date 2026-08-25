export interface CanonicalDifferenceSummary {
  kind: string
  length?: number
  keys?: number
  sha256: string
}

export interface CanonicalDifference {
  pointer: string
  kind: 'type' | 'array-length' | 'added' | 'removed' | 'value'
  expected: CanonicalDifferenceSummary
  actual: CanonicalDifferenceSummary
}

export function compareCanonicalJson(
  expected: unknown,
  actual: unknown,
  options?: {
    ignoredPointers?: string[]
    maximumDifferences?: number
    maximumNodes?: number
    maximumDepth?: number
  }
): {
  equal: boolean
  differences: CanonicalDifference[]
  ignoredPointers: string[]
  visitedNodes: number
  truncated: boolean
}

export function approvedIgnorePointers(
  waivers: Array<{ differenceId: string; pointer: string }>,
  knownDifferences: Array<Record<string, unknown>>,
  today?: Date
): string[]
