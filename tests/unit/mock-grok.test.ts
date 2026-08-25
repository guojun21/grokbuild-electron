import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

describe('strict Grok QA scenarios', () => {
  it('rejects both out-of-order requests and mismatched parameters', async () => {
    const wrongOrder = await rejectedFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: process.cwd(), mcpServers: [] }
    })
    expect(wrongOrder).toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining('expected initialize, received session/new')
      }
    })

    const wrongProtocol = await rejectedFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 999,
        clientInfo: { name: 'grokbuild-electron', version: '0.1.0' },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true
        }
      }
    })
    expect(wrongProtocol).toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining('params.protocolVersion expected 1, received 999')
      }
    })

    const wrongCapabilities = await rejectedFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientInfo: { name: 'grokbuild-electron', version: '0.1.0' },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        }
      }
    })
    expect(wrongCapabilities).toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining('params.clientCapabilities.fs.readTextFile expected true')
      }
    })
  })

  it('provides deterministic auth-required-once and initialize-failure profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-mock-retry-'))
    const marker = join(root, 'retry.marker')
    try {
      const first = await initializeProfile({
        GROKBUILD_MOCK_PROFILE: 'auth-required-once',
        GROKBUILD_MOCK_RETRY_MARKER: marker,
        GROKBUILD_MOCK_FAILURE_CANARY: 'QA_MOCK_AUTH_CANARY'
      })
      expect(first).toMatchObject({ error: { code: 401 } })
      expect(JSON.stringify(first)).toContain('QA_MOCK_AUTH_CANARY')

      const recovered = await initializeProfile({
        GROKBUILD_MOCK_PROFILE: 'auth-required-once',
        GROKBUILD_MOCK_RETRY_MARKER: marker
      })
      expect(recovered).toMatchObject({ result: { protocolVersion: 1 } })

      const failed = await initializeProfile({ GROKBUILD_MOCK_PROFILE: 'initialize-failure' })
      expect(failed).toMatchObject({
        error: { code: -32000, message: 'Deterministic initialize failure' }
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function initializeProfile(environment: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const child = spawn(resolve('qa/mock-grok.mjs'), ['agent', 'stdio'], {
    cwd: resolve('.'),
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const output = createInterface({ input: child.stdout })
  const responseLine = once(output, 'line')
  const closed = once(child, 'close')
  child.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'grokbuild-electron', version: '0.1.0' },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true
      }
    }
  })}\n`)
  const [line] = await responseLine as [string]
  await closed
  output.close()
  return JSON.parse(line) as Record<string, unknown>
}

async function rejectedFrame(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  const child = spawn(resolve('qa/mock-grok.mjs'), ['agent', 'stdio'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROKBUILD_MOCK_PROFILE: 'capability-truth',
      GROKBUILD_MOCK_SCENARIO: resolve('qa/scenarios/p0/capability-truth.json')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const output = createInterface({ input: child.stdout })
  const responseLine = once(output, 'line')
  const closed = once(child, 'close')
  child.stdin.end(`${JSON.stringify(frame)}\n`)
  const [line] = await responseLine as [string]
  const [exitCode] = await closed as [number | null]
  output.close()
  expect(exitCode).toBe(2)
  return JSON.parse(line) as Record<string, unknown>
}
