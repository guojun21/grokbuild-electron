import { realpath } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  GROK_CLI_SESSION_HISTORY_LIMIT,
  GrokCliRunError,
  GrokCliService,
  canonicalGrokCliSessionQuery,
  isCanonicalGrokCliSessionId,
  parseGrokCliSessionHistory,
  type GrokCliProcessRunner,
  type GrokCliRunRequest,
  type GrokCliRunResult
} from '../../src/main/grok/GrokCliService'

const FIRST_ID = '01234567-89ab-cdef-0123-456789abcdef'
const SECOND_ID = 'fedcba98-7654-3210-fedc-ba9876543210'
const CANARY = 'history-private-canary-4c913e'

class RecordingRunner implements GrokCliProcessRunner {
  readonly requests: GrokCliRunRequest[] = []
  readonly results: GrokCliRunResult[] = []
  thrown: unknown

  async run(request: GrokCliRunRequest): Promise<GrokCliRunResult> {
    this.requests.push(request)
    if (this.thrown !== undefined) throw this.thrown
    return this.results.shift() ?? {
      stdout: '',
      stderr: '',
      exitCode: 0,
      signal: null
    }
  }
}

describe('GrokCliService session history', () => {
  it('uses only the verified Grok 1.0.5 argv, exact caller cwd, and bounded table projection', async () => {
    const runner = new RecordingRunner()
    runner.results.push(
      successful(table([
        row(FIRST_ID, '2026-08-20', '2026-08-25', 'local', 'Fix auth refresh'),
        row(SECOND_ID, '2026-08-21', '2026-08-24', 'remote', '梳理发布流程')
      ])),
      successful(table([
        row(SECOND_ID, '2026-08-21', '2026-08-24', 'remote', '梳理发布流程')
      ])),
      successful('')
    )
    const cli = makeCli(runner)
    const cwd = await realpath(process.cwd())

    await expect(cli.listSessions(cwd)).resolves.toEqual([
      {
        remoteId: FIRST_ID,
        summary: 'Fix auth refresh',
        status: 'local',
        created: '2026-08-20',
        updated: '2026-08-25'
      },
      {
        remoteId: SECOND_ID,
        summary: '梳理发布流程',
        status: 'remote',
        created: '2026-08-21',
        updated: '2026-08-24'
      }
    ])
    await expect(cli.searchSessions(cwd, 'auth bug')).resolves.toEqual([{
      remoteId: SECOND_ID,
      summary: '梳理发布流程',
      status: 'remote',
      created: '2026-08-21',
      updated: '2026-08-24'
    }])
    await expect(cli.deleteSession(cwd, FIRST_ID)).resolves.toBeUndefined()

    expect(runner.requests.map((request) => request.args)).toEqual([
      ['sessions', 'list', '--limit', '50'],
      ['sessions', 'search', '--limit', '50', 'auth bug'],
      ['sessions', 'delete', FIRST_ID]
    ])
    expect(runner.requests).toHaveLength(3)
    expect(runner.requests.every((request) => request.executable === process.execPath)).toBe(true)
    expect(runner.requests.every((request) => request.cwd === cwd)).toBe(true)
    expect(runner.requests.every((request) => request.timeoutMs === 1_000)).toBe(true)
    expect(runner.requests.every((request) => request.maxOutputBytes === 64 * 1_024)).toBe(true)
    expect(GROK_CLI_SESSION_HISTORY_LIMIT).toBe(50)
  })

  it.each([
    '',
    ' ',
    ' leading',
    'trailing ',
    '--debug',
    '-n',
    'line\nbreak',
    'a'.repeat(257),
    '测'.repeat(86)
  ])('rejects an invalid or ambiguous query before spawning: %j', async (query) => {
    const runner = new RecordingRunner()
    const error = await rejection(makeCli(runner).searchSessions(process.cwd(), query))

    expect(error).toMatchObject({ code: 'invalid-query', operation: 'sessions-search' })
    expect(String(error)).toBe('GrokCliServiceError: The Grok session search query is invalid')
    expect(runner.requests).toEqual([])
  })

  it.each([
    FIRST_ID.toUpperCase(),
    'not-a-session',
    `${FIRST_ID}\n--debug`,
    `${FIRST_ID} --debug`,
    '01234567-89ab-cdef-0123-456789abcde'
  ])('rejects a non-canonical session id before spawning: %j', async (remoteId) => {
    const runner = new RecordingRunner()
    const error = await rejection(makeCli(runner).deleteSession(process.cwd(), remoteId))

    expect(error).toMatchObject({ code: 'invalid-session-id', operation: 'sessions-delete' })
    expect(String(error)).toBe('GrokCliServiceError: The Grok session id is invalid')
    expect(runner.requests).toEqual([])
  })

  it('rejects malformed or oversized table data without exposing raw diagnostics', async () => {
    const runner = new RecordingRunner()
    runner.results.push(successful(`diagnostic ${CANARY} /private/path --token\n`))
    const cli = makeCli(runner)

    const diagnosticError = await rejection(cli.listSessions(process.cwd()))
    expect(diagnosticError).toMatchObject({ code: 'invalid-output', operation: 'sessions-list' })
    expect(String(diagnosticError)).toBe(
      'GrokCliServiceError: Grok CLI sessions-list returned an invalid response'
    )
    expect(serializeError(diagnosticError)).not.toContain(CANARY)
    expect(serializeError(diagnosticError)).not.toContain('/private/path')
    expect(serializeError(diagnosticError)).not.toContain('--token')

    runner.results.push(successful('x'.repeat(256 * 1_024 + 1)))
    const sizeError = await rejection(cli.searchSessions(process.cwd(), 'bounded'))
    expect(sizeError).toMatchObject({ code: 'invalid-output', operation: 'sessions-search' })
    expect(serializeError(sizeError)).not.toContain('xxxxx')
  })

  it.each([
    table([row(FIRST_ID, '2026-02-30', '2026-08-25', 'local', CANARY)]),
    table([row(FIRST_ID, '2026-08-20', '2026-08-25', 'local!', CANARY)]),
    table([row(FIRST_ID, '2026-08-20', '2026-08-25', 'local', `safe\u001b${CANARY}`)]),
    table([
      row(FIRST_ID, '2026-08-20', '2026-08-25', 'local', 'one'),
      row(FIRST_ID, '2026-08-20', '2026-08-25', 'local', CANARY)
    ]),
    table([row(FIRST_ID, '2026-08-20', '2026-08-25', 'local', `${CANARY}${'x'.repeat(1_024)}`)])
  ])('fails closed on unsafe row fields and never includes them in errors', async (output) => {
    const error = await rejection(Promise.resolve().then(() => parseGrokCliSessionHistory(output)))

    expect(error).toMatchObject({ code: 'invalid-output', operation: 'sessions-list' })
    expect(serializeError(error)).not.toContain(CANARY)
  })

  it('maps history runner output limits, timeouts, and command output to fixed errors', async () => {
    const runner = new RecordingRunner()
    const cli = makeCli(runner)

    runner.thrown = new GrokCliRunError('output-limit')
    const outputError = await rejection(cli.listSessions(process.cwd()))
    expect(outputError).toMatchObject({ code: 'output-limit', operation: 'sessions-list' })
    expect(String(outputError)).toBe(
      'GrokCliServiceError: Grok CLI sessions-list exceeded its output limit'
    )

    runner.thrown = new GrokCliRunError('timeout')
    const timeoutError = await rejection(cli.searchSessions(process.cwd(), 'safe query'))
    expect(timeoutError).toMatchObject({ code: 'timeout', operation: 'sessions-search' })

    runner.thrown = undefined
    runner.results.push({
      stdout: `stdout ${CANARY}`,
      stderr: `stderr ${CANARY} /private/path --debug-file`,
      exitCode: 7,
      signal: null
    })
    const commandError = await rejection(cli.deleteSession(process.cwd(), FIRST_ID))
    expect(commandError).toMatchObject({
      code: 'command-failed',
      operation: 'sessions-delete',
      exitCode: 7
    })
    expect(serializeError(commandError)).not.toContain(CANARY)
    expect(serializeError(commandError)).not.toContain('/private/path')
    expect(serializeError(commandError)).not.toContain('--debug-file')
  })

  it('accepts empty search output and the captured 1.0.5 group/header/table form only', () => {
    expect(parseGrokCliSessionHistory('')).toEqual([])
    expect(parseGrokCliSessionHistory(
      `\r\n(no label)\r\n${header()}\r\n${row(
        FIRST_ID,
        '2026-08-20',
        '2026-08-25',
        'local',
        '(no summary)'
      )}\r\n`
    )).toEqual([{
      remoteId: FIRST_ID,
      summary: '(no summary)',
      status: 'local',
      created: '2026-08-20',
      updated: '2026-08-25'
    }])

    expect(canonicalGrokCliSessionQuery('安全 query')).toBe('安全 query')
    expect(isCanonicalGrokCliSessionId(FIRST_ID)).toBe(true)
    expect(isCanonicalGrokCliSessionId(FIRST_ID.toUpperCase())).toBe(false)
  })
})

function makeCli(runner: GrokCliProcessRunner): GrokCliService {
  return new GrokCliService({
    cliPath: process.execPath,
    runner,
    timeoutMs: 1_000,
    doctorTimeoutMs: 2_000,
    updateInstallTimeoutMs: 3_000,
    maxOutputBytes: 64 * 1_024,
    terminateGraceMs: 20
  })
}

function successful(stdout: string): GrokCliRunResult {
  return { stdout, stderr: '', exitCode: 0, signal: null }
}

function header(): string {
  return 'SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY'
}

function row(
  remoteId: string,
  created: string,
  updated: string,
  status: string,
  summary: string
): string {
  return `${remoteId}  ${created}  ${updated}  ${status}  ${summary}`
}

function table(rows: string[]): string {
  return `\n(no label)\n${header()}\n${rows.join('\n')}\n`
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
