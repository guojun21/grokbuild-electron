import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PlutilProcessError,
  SwiftStateMigrationService,
  type PlutilRunner,
  type PlutilRunRequest,
  type PlutilRunResult
} from '../../src/main/migration/SwiftStateMigrationService'

const fixturePath = fileURLToPath(new URL('../fixtures/swift-state/sanitized.plist', import.meta.url))
const CANARY = 'private-path-and-message-canary-9a26c5'
const ACTIVITY_CANARY = 'QA_SWIFT_ACTIVITY_SECRET_5F29'

class RecordingRunner implements PlutilRunner {
  readonly requests: PlutilRunRequest[] = []
  readonly results: Array<PlutilRunResult | Error> = []

  async run(request: PlutilRunRequest): Promise<PlutilRunResult> {
    this.requests.push(request)
    const result = this.results.shift()
    if (result instanceof Error) throw result
    return result ?? { stdout: '', exitCode: 1 }
  }
}

describe('SwiftStateMigrationService', () => {
  it('read-only imports the sanitized Swift v0.3.2 fixture deterministically', async () => {
    const before = await readFile(fixturePath)
    const service = new SwiftStateMigrationService()

    const first = await service.importFromPlist(fixturePath)
    const second = await service.importFromPlist(fixturePath)

    expect(first).toEqual(second)
    expect(createHash('sha256').update(await readFile(fixturePath)).digest('hex')).toBe(
      createHash('sha256').update(before).digest('hex')
    )
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('Expected sanitized migration to succeed')

    const canonicalTmp = await realpath('/tmp')
    expect(first.data).toMatchObject({
      selectedSessionIdByProject: {
        '11111111-1111-4111-8111-111111111111': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      },
      selectedProjectId: '11111111-1111-4111-8111-111111111111',
      selectedSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projects: [{
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Sanitized Fixture',
        path: canonicalTmp,
        sessionIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        createdAt: '1970-01-01T00:00:00.000Z'
      }],
      sessions: [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        acpSessionId: '019eef73-aadb-7b92-90a2-eff8825b3a0b',
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'Sanitized imported chat',
        model: 'grok-4.6',
        status: 'idle',
        createdAt: '2026-05-09T06:13:20.000Z',
        updatedAt: '2026-05-09T06:13:20.000Z'
      }]
    })
    expect(first.data.sessions[0]?.transcript).toEqual([
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        kind: 'message',
        role: 'user',
        text: 'Sanitized fixture prompt.',
        createdAt: '2026-05-09T06:13:21.000Z'
      },
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        kind: 'message',
        role: 'assistant',
        text: 'Sanitized fixture response.',
        createdAt: '2026-05-09T06:13:22.000Z'
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:dddddddd-dddd-4ddd-8ddd-dddddddddddd:activity:1',
        kind: 'activity',
        entries: [
          { kind: 'read_skill', count: 1 },
          { kind: 'read_file', count: 2 },
          { kind: 'listed', count: 1 }
        ],
        hookCount: 2,
        isLead: true,
        createdAt: '2026-05-09T06:13:22.000Z'
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:dddddddd-dddd-4ddd-8ddd-dddddddddddd:activity:2',
        kind: 'activity',
        entries: [{ kind: 'ran', count: 1 }],
        hookCount: 10_000,
        isLead: false,
        createdAt: '2026-05-09T06:13:22.000Z'
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:dddddddd-dddd-4ddd-8ddd-dddddddddddd:activity:3',
        kind: 'activity',
        entries: [{ kind: 'other', count: 1 }],
        hookCount: 0,
        isLead: false,
        createdAt: '2026-05-09T06:13:22.000Z'
      },
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        kind: 'notice',
        text: 'Sanitized system note.',
        createdAt: '2026-05-09T06:13:23.000Z'
      }
    ])
    expect(first.summary).toEqual({
      projectsImported: 1,
      projectsSkipped: 1,
      sessionsImported: 1,
      sessionsSkipped: 1,
      transcriptItemsImported: 6,
      transcriptItemsSkipped: 1,
      unavailableSections: []
    })
    const serialized = JSON.stringify(first)
    expect(serialized).not.toContain(ACTIVITY_CANARY)
    expect(serialized).not.toContain(`/private/${ACTIVITY_CANARY}`)
    expect(serialized).not.toContain(`xai-${ACTIVITY_CANARY}`)
    expect(serialized).not.toContain(`bash /private/${ACTIVITY_CANARY}`)
  })

  it('uses only fixed escaped plutil extraction argv with bounded time and output', async () => {
    const runner = new RecordingRunner()
    runner.results.push(
      { stdout: 'OK', exitCode: 0 },
      { stdout: '', exitCode: 1 },
      { stdout: '', exitCode: 1 },
      { stdout: '', exitCode: 1 }
    )
    const result = await new SwiftStateMigrationService(runner).importFromPlist(fixturePath)

    expect(result).toEqual({
      ok: true,
      data: { projects: [], sessions: [], selectedSessionIdByProject: {} },
      summary: {
        projectsImported: 0,
        projectsSkipped: 0,
        sessionsImported: 0,
        sessionsSkipped: 0,
        transcriptItemsImported: 0,
        transcriptItemsSkipped: 0,
        unavailableSections: ['projects', 'session-layout', 'session-messages']
      }
    })
    expect(runner.requests.map((request) => request.args)).toEqual([
      ['-lint', '--', fixturePath],
      [
        '-extract', 'GrokBuild\\.projects\\.v1', 'raw', '-expect', 'data',
        '-o', '-', '--', fixturePath
      ],
      [
        '-extract', 'GrokBuild\\.sessionLayout\\.v2', 'raw', '-expect', 'data',
        '-o', '-', '--', fixturePath
      ],
      [
        '-extract', 'GrokBuild\\.sessionMessages\\.v1', 'xml1', '-expect', 'dictionary',
        '-o', '-', '--', fixturePath
      ]
    ])
    expect(runner.requests.every((request) =>
      request.timeoutMs === 10_000 &&
      request.maxOutputBytes > 0 &&
      request.args.at(-2) === '--' &&
      request.args.at(-1) === fixturePath
    )).toBe(true)
  })

  it('does not discover a default plist when the caller supplies no valid absolute path', async () => {
    const runner = new RecordingRunner()
    const result = await new SwiftStateMigrationService(runner).importFromPlist('')

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-source', message: 'The selected Swift state file is unavailable.' }
    })
    expect(runner.requests).toEqual([])
  })

  it('accepts Swift stores whose three supported sections are present but empty', async () => {
    const runner = new RecordingRunner()
    runner.results.push(
      { stdout: 'OK', exitCode: 0 },
      { stdout: Buffer.from('[]').toString('base64'), exitCode: 0 },
      {
        stdout: Buffer.from(JSON.stringify({ records: [], sessionOrderByWorkspace: [] })).toString('base64'),
        exitCode: 0
      },
      {
        stdout: '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>',
        exitCode: 0
      }
    )

    await expect(new SwiftStateMigrationService(runner).importFromPlist(fixturePath)).resolves.toEqual({
      ok: true,
      data: { projects: [], sessions: [], selectedSessionIdByProject: {} },
      summary: {
        projectsImported: 0,
        projectsSkipped: 0,
        sessionsImported: 0,
        sessionsSkipped: 0,
        transcriptItemsImported: 0,
        transcriptItemsSkipped: 0,
        unavailableSections: []
      }
    })
  })

  it('returns fixed safe errors without runner, path, or transcript diagnostics', async () => {
    const runner = new RecordingRunner()
    runner.results.push(new Error(`runner ${CANARY} ${fixturePath}`))
    const result = await new SwiftStateMigrationService(runner).importFromPlist(fixturePath)
    const serialized = JSON.stringify(result)

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'plutil-unavailable',
        message: 'The macOS property-list reader is unavailable.'
      }
    })
    expect(serialized).not.toContain(CANARY)
    expect(serialized).not.toContain(fixturePath)

    const timedOut = new RecordingRunner()
    timedOut.results.push(new PlutilProcessError('timeout'))
    await expect(new SwiftStateMigrationService(timedOut).importFromPlist(fixturePath)).resolves.toMatchObject({
      ok: false,
      error: { code: 'plutil-timeout', message: 'Reading the Swift state timed out.' }
    })
  })

  it('does not leak malformed decoded project content in its error summary', async () => {
    const runner = new RecordingRunner()
    runner.results.push(
      { stdout: 'OK', exitCode: 0 },
      { stdout: Buffer.from(`not json ${CANARY}`).toString('base64'), exitCode: 0 },
      { stdout: Buffer.from(JSON.stringify({ records: [], sessionOrderByWorkspace: [] })).toString('base64'), exitCode: 0 },
      { stdout: '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>', exitCode: 0 }
    )

    const result = await new SwiftStateMigrationService(runner).importFromPlist(fixturePath)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-project-data', message: 'The Swift project data is not valid.' }
    })
    expect(JSON.stringify(result)).not.toContain(CANARY)
  })
})
