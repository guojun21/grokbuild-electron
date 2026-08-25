export const PACKAGED_SMOKE_ENVIRONMENT_KEYS: readonly string[]

export interface PackagedSmokeEnvironmentOptions {
  temporaryRoot: string
  workspacePath: string
  transcriptPath: string
  cliPath: string
  nodeExecutable: string
}

export type PackagedSmokeEnvironment = Readonly<{
  PATH: string
  HOME: string
  TMPDIR: string
  LANG: 'en_US.UTF-8'
  LC_ALL: 'en_US.UTF-8'
  TZ: 'UTC'
  GROK_CLI_PATH: string
  GROKBUILD_USER_DATA_DIR: string
  GROKBUILD_E2E_PROJECT_PATH: string
  GROKBUILD_E2E: '1'
  GROKBUILD_MOCK_TRANSCRIPT: string
}>

export function createPackagedSmokeEnvironment(
  options: PackagedSmokeEnvironmentOptions
): PackagedSmokeEnvironment
