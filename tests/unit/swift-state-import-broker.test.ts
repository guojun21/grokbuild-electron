import { describe, expect, it, vi } from 'vitest'
import { SwiftStateImportBroker } from '../../src/main/migration/SwiftStateImportBroker'
import { defaultState } from '../../src/main/persistence/AppStateStore'
import type { SwiftStateMigrationResult } from '../../src/main/migration/SwiftStateMigrationService'

const token = '11111111-1111-4111-8111-111111111111'
const sourceSummary = {
  projectsImported: 1,
  projectsSkipped: 0,
  sessionsImported: 0,
  sessionsSkipped: 0,
  transcriptItemsImported: 0,
  transcriptItemsSkipped: 0,
  unavailableSections: [] as const
}
const publicSourceSummary = {
  projectsImported: 1,
  projectsSkipped: 0,
  sessionsImported: 0,
  sessionsSkipped: 0,
  transcriptItemsImported: 0,
  transcriptItemsSkipped: 0,
  unavailableSections: 0
}

describe('SwiftStateImportBroker', () => {
  it('returns only counts and an opaque token, then consumes the plan once', async () => {
    const importFromPlist = vi.fn(async (): Promise<SwiftStateMigrationResult> => ({
      ok: true,
      data: {
        projects: [{
          id: 'swift-project',
          name: 'Private project name',
          path: '/private/project/path',
          sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z'
        }],
        sessions: [],
        selectedSessionIdByProject: {}
      },
      summary: { ...sourceSummary, unavailableSections: [] }
    }))
    const broker = new SwiftStateImportBroker(
      { importFromPlist } as never,
      () => 1_000,
      () => token
    )
    const preview = await broker.preview('/private/source.plist', defaultState('/mock/grok'))

    expect(preview).toEqual({
      ok: true,
      token,
      source: publicSourceSummary,
      merge: expect.objectContaining({ projectsAdded: 1 })
    })
    expect(JSON.stringify(preview)).not.toContain('/private')
    const consumed = broker.consume(token, defaultState('/mock/grok'))
    expect(consumed.state.projects[0]?.name).toBe('Private project name')
    expect(() => broker.consume(token, consumed.state)).toThrow(/expired/i)
  })

  it('expires previews and never exposes failed source details', async () => {
    let now = 0
    const broker = new SwiftStateImportBroker(
      {
        importFromPlist: vi.fn(async (): Promise<SwiftStateMigrationResult> => ({
          ok: true,
          data: { projects: [], sessions: [], selectedSessionIdByProject: {} },
          summary: { ...sourceSummary, projectsImported: 0, unavailableSections: [] }
        }))
      } as never,
      () => now,
      () => token,
      10
    )
    await broker.preview('/private/source.plist', defaultState('/mock/grok'))
    now = 10
    expect(() => broker.consume(token, defaultState('/mock/grok'))).toThrow(/expired/i)
  })

  it('passes through only the migration service public error envelope', async () => {
    const broker = new SwiftStateImportBroker({
      importFromPlist: vi.fn(async (): Promise<SwiftStateMigrationResult> => ({
        ok: false,
        error: { code: 'invalid-source', message: 'The selected file cannot be imported.' },
        summary: {
          projectsImported: 0,
          projectsSkipped: 0,
          sessionsImported: 0,
          sessionsSkipped: 0,
          transcriptItemsImported: 0,
          transcriptItemsSkipped: 0,
          unavailableSections: []
        }
      }))
    } as never)
    const preview = await broker.preview('/secret/canary.plist', defaultState('/mock/grok'))
    expect(preview).toMatchObject({
      ok: false,
      error: { code: 'invalid-source', message: 'The selected file cannot be imported.' }
    })
    expect(JSON.stringify(preview)).not.toContain('/secret')
  })
})
