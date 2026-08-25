import { constants } from 'node:fs'
import { chmod, mkdtemp, open, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GrokDoctorService,
  hasCachedCredentials
} from '../../src/main/grok/GrokDoctorService'
import { grokDoctorReportSchema } from '../../src/shared/doctor'

const temporaryDirectories: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ))
})

describe('GrokDoctorService', () => {
  it('reports only fixed public status while keeping credential contents private', async () => {
    const root = await temporaryRoot()
    const authPath = join(root, 'auth.json')
    const configPath = join(root, 'config.toml')
    const canary = 'DOCTOR_SECRET_CANARY_41F7'
    await writeFile(authPath, JSON.stringify({ token: canary }), { mode: 0o600 })
    await writeFile(configPath, '[ui]\n', { mode: 0o600 })
    const report = await new GrokDoctorService({ authPath, configPath }).inspect({
      cliAvailable: true,
      cliVersion: 'grok 1.0.5'
    })

    expect(report).toMatchObject({ healthy: true })
    expect(report.checks.map((check) => [check.key, check.status])).toEqual([
      ['cli', 'ok'],
      ['version', 'ok'],
      ['auth', 'ok'],
      ['config', 'ok']
    ])
    expect(JSON.stringify(report)).not.toContain(canary)
    expect(JSON.stringify(report)).not.toContain(root)
    expect(grokDoctorReportSchema.parse(report)).toEqual(report)
  })

  it('treats empty, malformed, oversized, array, and symlinked auth files as signed out', async () => {
    const root = await temporaryRoot()
    const valid = join(root, 'valid.json')
    await writeFile(valid, '{"token":"present"}', { mode: 0o600 })
    const cases: Array<[string, string]> = [
      ['empty.json', '{}'],
      ['malformed.json', '{'],
      ['array.json', '["token"]'],
      ['large.json', '{"token":"0123456789"}']
    ]
    for (const [name, source] of cases) await writeFile(join(root, name), source, { mode: 0o600 })
    await symlink(valid, join(root, 'link.json'))

    expect(await hasCachedCredentials(valid)).toBe(true)
    expect(await hasCachedCredentials(join(root, 'empty.json'))).toBe(false)
    expect(await hasCachedCredentials(join(root, 'malformed.json'))).toBe(false)
    expect(await hasCachedCredentials(join(root, 'array.json'))).toBe(false)
    expect(await hasCachedCredentials(join(root, 'large.json'), 8)).toBe(false)
    expect(await hasCachedCredentials(join(root, 'link.json'))).toBe(false)
    expect(await hasCachedCredentials(join(root, 'missing.json'))).toBe(false)
  })

  it('returns actionable fixed remediation without leaking paths or control characters', async () => {
    const root = await temporaryRoot()
    const service = new GrokDoctorService({
      authPath: join(root, 'missing-auth.json'),
      configPath: join(root, 'missing-config.toml')
    })
    const missingCli = await service.inspect({
      cliAvailable: false,
      cliVersion: `bad\u0000version ${root}`
    })
    expect(missingCli).toMatchObject({ healthy: false, remediation: 'choose-cli' })
    expect(JSON.stringify(missingCli)).not.toContain('\u0000')
    expect(JSON.stringify(missingCli)).not.toContain(root)

    const signedOut = await service.inspect({ cliAvailable: true })
    expect(signedOut).toMatchObject({ healthy: false, remediation: 'run-grok-login' })
  })

  it('does not require credential file write access', async () => {
    const root = await temporaryRoot()
    const authPath = join(root, 'readonly.json')
    await writeFile(authPath, '{"cached":true}', { mode: 0o400 })
    await chmod(authPath, 0o400)
    expect(await hasCachedCredentials(authPath)).toBe(true)

    const handle = await open(authPath, constants.O_RDONLY)
    await handle.close()
  })
})

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'grokbuild-doctor-'))
  temporaryDirectories.push(path)
  return path
}
