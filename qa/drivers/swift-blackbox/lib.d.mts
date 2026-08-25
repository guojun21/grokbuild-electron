export interface CommandProbe {
  status: number | null
  stdout?: string
  stderr?: string
}

export interface ProbeResult {
  granted: boolean
  code?: string
  reason?: string
  remediation?: string
}

export const SWIFT_QA_BUNDLE_ID: string
export const PERMISSION_BLOCKED_EXIT: number
export function classifyAccessibilityProbe(probe: CommandProbe): ProbeResult
export function classifyScreenRecordingProbe(probe: CommandProbe): ProbeResult
export function blockedManifest(input: {
  reasons: ProbeResult[]
  reference: Record<string, unknown>
  outputDirectory: string
}): Record<string, unknown>
export function canonicalizeRpcTranscript(text: string, roots?: Record<string, string>): unknown[]
export function canonicalizePreferences(value: unknown, roots?: Record<string, string>): unknown
export function canonicalizeAxTree(value: unknown, roots?: Record<string, string>): unknown
export function canonicalWindowMetadata(windows: Array<Record<string, any>>): unknown[]
export function sha256(data: string | Buffer): string
