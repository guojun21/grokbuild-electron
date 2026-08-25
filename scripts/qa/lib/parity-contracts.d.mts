export type ParityPriority = 'P0' | 'P1' | 'P2'
export type ParityStatus =
  | 'verified'
  | 'partial'
  | 'missing'
  | 'external-blocked'
  | 'intentional-difference'

export interface ParityMatrixEntry {
  id: string
  priority: ParityPriority
}

export interface ParityEvidenceEntry {
  id: string
  priority: ParityPriority
  status: ParityStatus
  implementationPaths: string[]
  testPaths: string[]
  artifactPaths: string[]
  gap: string
}

export interface ParityEvidenceManifest {
  schemaVersion: number
  matrix: string
  entries: ParityEvidenceEntry[]
}

export interface KnownDifference {
  id: string
  scenario: string
  surface: string
  selector: string
  priority: ParityPriority
  expectedSwift: string
  actualElectron: string
  reason: string
  owner: string
  issue: string
  introducedAt: string
  expiresOn: string
  approvalStatus: 'pending' | 'approved'
  approvedBy?: string
}

export interface ReleaseBlocker {
  id: string
  status: string
}

export const PARITY_STATUSES: readonly ParityStatus[]
export const PARITY_PRIORITIES: readonly ParityPriority[]
export const KNOWN_DIFFERENCE_APPROVALS: readonly ['pending', 'approved']

export function parseParityMatrix(markdown: string): ParityMatrixEntry[]
export function validateEvidenceManifest(options: {
  matrixEntries: ParityMatrixEntry[]
  manifest: unknown
  root: string
  expectedMatrixPath?: string
}): Promise<string[]>
export function validateKnownDifferences(
  value: unknown,
  matrixEntries: ParityMatrixEntry[],
  now?: Date
): string[]
export function validateIntentionalDifferenceLinks(
  manifest: unknown,
  knownDifferences: unknown
): string[]
export function evaluateReleaseReadiness(
  matrixEntries: ParityMatrixEntry[],
  manifest: ParityEvidenceManifest,
  knownDifferences: KnownDifference[]
): { releaseReady: boolean; blockers: ReleaseBlocker[] }
export function countParityStatuses(
  entries: ParityEvidenceEntry[]
): Record<ParityStatus, number>
