import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseGrokCliUpdateCheck } from '../../src/main/updates/UpdateService'

const execFileAsync = promisify(execFile)

describe('qa mock Grok update command', () => {
  it('emits the bounded 1.0.5 update --check --json contract', async () => {
    const result = await execFileAsync(
      resolve('qa/mock-grok.mjs'),
      ['update', '--check', '--json'],
      { cwd: resolve('.'), env: process.env, maxBuffer: 64 * 1024 }
    )
    expect(parseGrokCliUpdateCheck(result.stdout)).toEqual({
      state: 'update-available',
      current: '1.0.5',
      latest: '1.0.6',
      channel: 'stable'
    })
  })

  it('models the fixed install command and a verified post-check without changing the mock executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-mock-update-'))
    const statePath = join(root, 'version.txt')
    const env = { ...process.env, GROKBUILD_MOCK_UPDATE_STATE: statePath }
    try {
      await execFileAsync(resolve('qa/mock-grok.mjs'), ['update', '--version', '1.0.6'], {
        cwd: resolve('.'),
        env,
        maxBuffer: 64 * 1024
      })
      const checked = await execFileAsync(
        resolve('qa/mock-grok.mjs'),
        ['update', '--check', '--json'],
        { cwd: resolve('.'), env, maxBuffer: 64 * 1024 }
      )
      expect(parseGrokCliUpdateCheck(checked.stdout)).toEqual({
        state: 'up-to-date',
        current: '1.0.6',
        latest: '1.0.6',
        channel: 'stable'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
