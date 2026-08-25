import { describe, expect, it } from 'vitest'
import {
  GrokCliService,
  type GrokCliProcessRunner,
  type GrokCliRunRequest,
  type GrokCliRunResult
} from '../../src/main/grok/GrokCliService'
import { McpService } from '../../src/main/mcp/McpService'

const CANARY = 'mcp-service-secret-canary-8e5294'

class FakeRunner implements GrokCliProcessRunner {
  readonly requests: GrokCliRunRequest[] = []
  listJson = '[]'
  doctorJson = JSON.stringify({ sources: [], servers: [], healthy_count: 0, failing_count: 0 })
  doctorExitCode = 0
  failure: GrokCliRunResult | undefined
  thrown: unknown

  async run(request: GrokCliRunRequest): Promise<GrokCliRunResult> {
    this.requests.push(request)
    if (this.thrown !== undefined) throw this.thrown
    if (this.failure) return this.failure
    return {
      stdout: request.args[1] === 'list' ? this.listJson :
        request.args[1] === 'doctor' ? this.doctorJson : '',
      stderr: '',
      exitCode: request.args[1] === 'doctor' ? this.doctorExitCode : 0,
      signal: null
    }
  }
}

describe('McpService input and argv contracts', () => {
  it('strictly validates requests and requires explicit doctor launch confirmation', async () => {
    const { service, runner } = harness()

    await expect(service.list({ cwd: process.cwd(), unexpected: true }))
      .rejects.toMatchObject({ code: 'invalid-input', operation: 'list' })
    await expect(service.add({
      cwd: process.cwd(),
      scope: 'user',
      transport: 'http',
      name: 'remote',
      url: `https://user:${CANARY}@example.test/mcp`,
      headers: []
    })).rejects.toMatchObject({ code: 'invalid-input', operation: 'add' })
    await expect(service.doctor({ cwd: process.cwd(), confirmExternalLaunch: false }))
      .rejects.toMatchObject({ code: 'invalid-input', operation: 'doctor' })
    await expect(service.doctor({ cwd: process.cwd() }))
      .rejects.toMatchObject({ code: 'invalid-input', operation: 'doctor' })

    expect(runner.requests).toEqual([])
  })

  it('exposes list/add/remove/enable/disable/doctor without a generic command surface', async () => {
    const { service, runner } = harness()
    await expect(service.list({ cwd: process.cwd() })).resolves.toEqual({ servers: [] })
    await expect(service.add({
      cwd: process.cwd(),
      scope: 'project',
      transport: 'stdio',
      name: 'local',
      command: 'npx',
      args: ['-y', '@example/mcp'],
      environment: []
    })).resolves.toEqual({ ok: true })
    await expect(service.remove({ cwd: process.cwd(), scope: 'project', name: 'local' }))
      .resolves.toEqual({ ok: true })
    await expect(service.enable({ cwd: process.cwd(), name: 'local' })).resolves.toEqual({ ok: true })
    await expect(service.disable({ cwd: process.cwd(), name: 'local' })).resolves.toEqual({ ok: true })
    await expect(service.doctor({
      cwd: process.cwd(),
      name: 'local',
      confirmExternalLaunch: true
    })).resolves.toMatchObject({ servers: [], healthyCount: 0, failingCount: 0 })

    expect(runner.requests.map((request) => request.args)).toEqual([
      ['mcp', 'list', '--json'],
      [
        'mcp', 'add', '--transport', 'stdio', '--scope', 'project',
        'local', '--', 'npx', '-y', '@example/mcp'
      ],
      ['mcp', 'remove', 'local', '--scope', 'project'],
      ['mcp', 'enable', 'local'],
      ['mcp', 'disable', 'local'],
      ['mcp', 'doctor', '--json', 'local']
    ])
  })
})

describe('McpService redaction', () => {
  it('whitelists list output and drops env, headers, args, OAuth, paths, query, and fragment', async () => {
    const { service, runner } = harness()
    runner.listJson = JSON.stringify([
      {
        name: 'local',
        scope: 'user',
        enabled: true,
        command: `/Users/${CANARY}/bin/npx`,
        args: ['--token', CANARY],
        env: { SECRET_TOKEN: CANARY },
        cwd: `/Users/${CANARY}/project`,
        oauth: { client_secret: CANARY },
        setup: { token: CANARY },
        unknown_secret: CANARY
      },
      {
        name: 'remote',
        scope: 'project',
        enabled: false,
        url: `https://example.test/private/${CANARY}?token=${CANARY}#${CANARY}`,
        type: 'sse',
        headers: { Authorization: `Bearer ${CANARY}` },
        bearer_token_env_var: `TOKEN_${CANARY}`,
        oauth_client_secret_env_var: `SECRET_${CANARY}`
      }
    ])

    const result = await service.list({ cwd: process.cwd() })
    expect(result).toEqual({
      servers: [
        {
          name: 'local',
          scope: 'user',
          enabled: true,
          transport: 'stdio',
          targetRedacted: '[stdio command]',
          hasEnvironment: true,
          hasHeaders: false
        },
        {
          name: 'remote',
          scope: 'project',
          enabled: false,
          transport: 'sse',
          targetRedacted: 'https://example.test',
          hasEnvironment: false,
          hasHeaders: true
        }
      ]
    })
    expect(JSON.stringify(result)).not.toContain(CANARY)
    expect(JSON.stringify(result)).not.toMatch(/"(?:env|headers|args|oauth|setup|cwd)":/i)
  })

  it('returns a fixed doctor projection without paths, target details, hints, or raw labels', async () => {
    const { service, runner } = harness()
    // Grok 1.0.5 deliberately exits 1 when the JSON report has failures.
    runner.doctorExitCode = 1
    runner.doctorJson = JSON.stringify({
      sources: [
        {
          path: `/Users/${CANARY}/project/.grok/config.toml`,
          status: { status: 'found', server_count: 1, reason: CANARY }
        },
        {
          path: `plugin: ${CANARY}`,
          status: { status: 'skipped', reason: CANARY }
        }
      ],
      servers: [
        {
          name: 'local',
          transport: 'stdio',
          target: `npx --token ${CANARY}`,
          source: `/Users/${CANARY}/project/.grok/config.toml`,
          checks: [
            { label: 'server started', passed: true, detail: CANARY },
            { label: `unknown ${CANARY}`, passed: false, hint: CANARY }
          ],
          healthy: false
        },
        {
          name: 'remote',
          transport: 'http',
          target: `https://example.test/private/${CANARY}?token=${CANARY}#${CANARY}`,
          source: 'claude.json',
          checks: [{ label: 'handshake OK', passed: true, detail: CANARY }],
          healthy: true
        }
      ],
      healthy_count: 999,
      failing_count: 999
    })

    const result = await service.doctor({ cwd: process.cwd(), confirmExternalLaunch: true })
    expect(result).toEqual({
      sources: [
        { source: 'grok-project', status: 'found', serverCount: 1 },
        { source: 'plugin', status: 'skipped' }
      ],
      servers: [
        {
          name: 'local',
          transport: 'stdio',
          targetRedacted: '[stdio command]',
          source: 'grok-project',
          checks: [
            { kind: 'start', passed: true },
            { kind: 'other', passed: false }
          ],
          healthy: false
        },
        {
          name: 'remote',
          transport: 'http',
          targetRedacted: 'https://example.test',
          source: 'claude',
          checks: [{ kind: 'handshake', passed: true }],
          healthy: true
        }
      ],
      healthyCount: 1,
      failingCount: 1
    })
    expect(JSON.stringify(result)).not.toContain(CANARY)
  })

  it('does not leak CLI output, injected runner errors, or malformed JSON in service errors', async () => {
    const first = harness()
    first.runner.failure = {
      stdout: `stdout ${CANARY}`,
      stderr: `stderr ${CANARY}`,
      exitCode: 2,
      signal: null
    }
    const commandError = await rejection(first.service.list({ cwd: process.cwd() }))
    expect(serializeError(commandError)).not.toContain(CANARY)
    expect(commandError).toMatchObject({ code: 'cli-failed', operation: 'list' })

    const second = harness()
    second.runner.thrown = new Error(`runner ${CANARY}`)
    const runnerError = await rejection(second.service.enable({ cwd: process.cwd(), name: 'local' }))
    expect(serializeError(runnerError)).not.toContain(CANARY)

    const third = harness()
    third.runner.listJson = `{"secret":"${CANARY}"`
    const parseError = await rejection(third.service.list({ cwd: process.cwd() }))
    expect(serializeError(parseError)).not.toContain(CANARY)
    expect(parseError).toMatchObject({ code: 'invalid-cli-output' })
  })
})

function harness(): { service: McpService; runner: FakeRunner } {
  const runner = new FakeRunner()
  const cli = new GrokCliService({
    cliPath: process.execPath,
    runner,
    timeoutMs: 1_000,
    doctorTimeoutMs: 2_000,
    maxOutputBytes: 128 * 1_024,
    terminateGraceMs: 20
  })
  return { service: new McpService(cli), runner }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

function serializeError(error: unknown): string {
  return `${String(error)} ${JSON.stringify(error)}`
}
