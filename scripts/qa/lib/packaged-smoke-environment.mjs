import { dirname, isAbsolute, join } from 'node:path'

export const PACKAGED_SMOKE_ENVIRONMENT_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'GROK_CLI_PATH',
  'GROKBUILD_USER_DATA_DIR',
  'GROKBUILD_E2E_PROJECT_PATH',
  'GROKBUILD_E2E',
  'GROKBUILD_MOCK_TRANSCRIPT'
])

/**
 * Constructs the complete environment for the packaged smoke candidate.
 *
 * This intentionally has no parent-environment input: adding a variable to the
 * workflow or the developer's shell must not make it visible to the app under
 * test. HOME and TMPDIR are also isolated so the smoke run cannot accidentally
 * consume user state while exercising the packaged binary.
 */
export function createPackagedSmokeEnvironment({
  temporaryRoot,
  workspacePath,
  transcriptPath,
  cliPath,
  nodeExecutable
}) {
  const safeTemporaryRoot = requireAbsolutePath('temporaryRoot', temporaryRoot)
  const safeWorkspacePath = requireAbsolutePath('workspacePath', workspacePath)
  const safeTranscriptPath = requireAbsolutePath('transcriptPath', transcriptPath)
  const safeCliPath = requireAbsolutePath('cliPath', cliPath)
  const safeNodeExecutable = requireAbsolutePath('nodeExecutable', nodeExecutable)
  const path = [...new Set([
    dirname(safeNodeExecutable),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ])].join(':')

  return Object.freeze({
    PATH: path,
    HOME: join(safeTemporaryRoot, 'home'),
    TMPDIR: join(safeTemporaryRoot, 'tmp'),
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'UTC',
    GROK_CLI_PATH: safeCliPath,
    GROKBUILD_USER_DATA_DIR: join(safeTemporaryRoot, 'profile'),
    GROKBUILD_E2E_PROJECT_PATH: safeWorkspacePath,
    GROKBUILD_E2E: '1',
    GROKBUILD_MOCK_TRANSCRIPT: safeTranscriptPath
  })
}

function requireAbsolutePath(label, value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`)
  }
  return value
}
