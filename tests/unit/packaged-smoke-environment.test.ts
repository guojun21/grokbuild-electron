import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createPackagedSmokeEnvironment,
  PACKAGED_SMOKE_ENVIRONMENT_KEYS
} from '../../scripts/qa/lib/packaged-smoke-environment.mjs'

const SECRET_CANARIES = {
  RUNNER_TEMP: '/runner/secret-temp',
  GITHUB_TOKEN: 'github-secret-canary',
  APPLE_ID: 'apple-secret-canary',
  APPLE_APP_SPECIFIC_PASSWORD: 'apple-password-canary',
  CSC_LINK: 'signing-material-canary',
  CSC_KEY_PASSWORD: 'signing-password-canary',
  ARBITRARY_PARENT_SECRET: 'arbitrary-secret-canary',
  NODE_OPTIONS: '--require=/tmp/attacker.cjs',
  ELECTRON_RUN_AS_NODE: 'electron-run-as-node-secret-canary'
} as const

describe('packaged smoke environment', () => {
  it('gives the candidate process only the exact allowlisted environment', async () => {
    const original = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(SECRET_CANARIES)) {
      original.set(key, process.env[key])
      process.env[key] = value
    }

    try {
      const temporaryRoot = resolve('/tmp/grokbuild-packaged-smoke-environment-test')
      const environment = createPackagedSmokeEnvironment({
        temporaryRoot,
        workspacePath: join(temporaryRoot, 'workspace'),
        transcriptPath: join(temporaryRoot, 'rpc.ndjson'),
        cliPath: resolve('qa/mock-grok.mjs'),
        nodeExecutable: process.execPath
      })

      expect(Object.keys(environment)).toEqual(PACKAGED_SMOKE_ENVIRONMENT_KEYS)
      expect(environment).toMatchObject({
        HOME: join(temporaryRoot, 'home'),
        TMPDIR: join(temporaryRoot, 'tmp'),
        GROKBUILD_USER_DATA_DIR: join(temporaryRoot, 'profile'),
        GROKBUILD_E2E_PROJECT_PATH: join(temporaryRoot, 'workspace'),
        GROKBUILD_MOCK_TRANSCRIPT: join(temporaryRoot, 'rpc.ndjson'),
        GROKBUILD_E2E: '1',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        TZ: 'UTC'
      })
      expect(environment.PATH.split(':')).toContain(dirname(process.execPath))

      const observed = await inspectChildEnvironment(environment)
      expect(observed).toMatchObject(environment)
      expect(Object.keys(observed).filter((key) => key !== '__CF_USER_TEXT_ENCODING'))
        .toEqual(PACKAGED_SMOKE_ENVIRONMENT_KEYS)
      expect(Object.keys(observed).filter((key) => /^(APPLE_|CSC_)/.test(key))).toEqual([])
      for (const [key, value] of Object.entries(SECRET_CANARIES)) {
        expect(observed).not.toHaveProperty(key)
        expect(Object.values(observed)).not.toContain(value)
      }
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('wires the strict environment into the packaged candidate spawn', async () => {
    const smokeSource = await readFile(resolve('scripts/qa/smoke-packaged.mjs'), 'utf8')
    expect(smokeSource).toContain('env: createPackagedSmokeEnvironment({')
    expect(smokeSource).not.toMatch(/\.\.\.\s*process\.env/)
  })

  it.each([
    ['temporaryRoot', 'relative'],
    ['workspacePath', 'relative'],
    ['transcriptPath', 'relative'],
    ['cliPath', 'relative'],
    ['nodeExecutable', 'relative']
  ] as const)('rejects a non-absolute %s', (field, value) => {
    const temporaryRoot = resolve('/tmp/grokbuild-packaged-smoke-environment-test')
    expect(() => createPackagedSmokeEnvironment({
      temporaryRoot,
      workspacePath: join(temporaryRoot, 'workspace'),
      transcriptPath: join(temporaryRoot, 'rpc.ndjson'),
      cliPath: resolve('qa/mock-grok.mjs'),
      nodeExecutable: process.execPath,
      [field]: value
    })).toThrow(`${field} must be an absolute path`)
  })
})

async function inspectChildEnvironment(
  environment: Readonly<Record<string, string>>
): Promise<Record<string, string>> {
  return await new Promise((resolveEnvironment, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`environment probe failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`))
        return
      }
      resolveEnvironment(JSON.parse(Buffer.concat(stdout).toString('utf8')) as Record<string, string>)
    })
  })
}
