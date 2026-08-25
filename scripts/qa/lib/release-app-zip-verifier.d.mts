export interface ReleaseAppZipVerifierOptions {
  archivePath: string
  archiveName: string
  checksumsPath: string
  sourceAppPath: string
  appName: string
  bundleId: string
  version: string
  bundleVersion: string
  teamId: string
  architectures: readonly ('arm64' | 'x86_64')[]
}

export interface ReleaseAppZipToolResult {
  stdout?: string | Buffer
  stderr?: string | Buffer
}

export interface ReleaseAppZipVerifierDependencies {
  runTool?: (
    executable: string,
    args: readonly string[],
    options: {
      cwd: string
      timeout: number
      maxBuffer: number
      windowsHide: boolean
    }
  ) => Promise<ReleaseAppZipToolResult>
}

export interface VerifiedReleaseAppZip {
  archivePath: string
  archiveName: string
  sha256: string
  bundleId: string
  version: string
  teamId: string
  architectures: readonly ('arm64' | 'x86_64')[]
}

export class ReleaseAppZipVerificationError extends Error {
  readonly code: string
}

export function verifyReleaseAppZip(
  options: ReleaseAppZipVerifierOptions,
  dependencies?: ReleaseAppZipVerifierDependencies
): Promise<VerifiedReleaseAppZip>
