import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  countParityStatuses,
  evaluateReleaseReadiness,
  parseParityMatrix,
  validateEvidenceManifest,
  validateIntentionalDifferenceLinks,
  validateKnownDifferences
} from '../../scripts/qa/lib/parity-contracts.mjs'
import type {
  KnownDifference,
  ParityEvidenceManifest,
  ParityMatrixEntry
} from '../../scripts/qa/lib/parity-contracts.mjs'

const fixtureRoot = fileURLToPath(new URL('../fixtures/qa-contracts/', import.meta.url))

describe('machine-readable parity contracts', () => {
  it('parses matrix priority decorations and validates a complete evidence fixture', async () => {
    const fixture = await loadFixture()

    expect(fixture.matrixEntries).toEqual([
      { id: 'PAR-001', priority: 'P0' },
      { id: 'PAR-013', priority: 'P1' },
      { id: 'PAR-023', priority: 'P2' }
    ])
    await expect(validateEvidenceManifest({
      matrixEntries: fixture.matrixEntries,
      manifest: fixture.manifest,
      root: fixtureRoot,
      expectedMatrixPath: 'matrix.md'
    })).resolves.toEqual([])
    expect(validateKnownDifferences(
      fixture.knownDifferences,
      fixture.matrixEntries,
      new Date('2026-08-25T12:00:00Z')
    )).toEqual([])
    expect(validateIntentionalDifferenceLinks(
      fixture.manifest,
      fixture.knownDifferences
    )).toEqual([])
  })

  it('rejects missing, extra, priority-mismatched, unevidenced, and nonexistent evidence', async () => {
    const fixture = await loadFixture()
    const missing = structuredClone(fixture.manifest)
    missing.entries = missing.entries.filter((entry) => entry.id !== 'PAR-013')
    expect(await validate(missing, fixture.matrixEntries)).toContain(
      'parity-evidence.json is missing PAR-013'
    )

    const extra = structuredClone(fixture.manifest)
    extra.entries.push({ ...structuredClone(extra.entries[0]!), id: 'PAR-999' })
    expect(await validate(extra, fixture.matrixEntries)).toContain(
      'parity-evidence.json has extra entry PAR-999'
    )

    const mismatched = structuredClone(fixture.manifest)
    mismatched.entries[1]!.priority = 'P0'
    expect(await validate(mismatched, fixture.matrixEntries)).toContain(
      'parity-evidence.json PAR-013 priority P0 does not match matrix P1'
    )

    const unevidenced = structuredClone(fixture.manifest)
    unevidenced.entries[0]!.testPaths = []
    expect(await validate(unevidenced, fixture.matrixEntries)).toContain(
      'parity-evidence.json entries[0] is verified but has no test or artifact evidence'
    )

    const nonexistent = structuredClone(fixture.manifest)
    nonexistent.entries[0]!.testPaths = ['evidence/not-present.test.ts']
    expect(await validate(nonexistent, fixture.matrixEntries)).toContain(
      'parity-evidence.json entries[0].testPaths[0] does not exist: evidence/not-present.test.ts'
    )
  })

  it('requires explicit approval metadata and fails expired records deterministically', async () => {
    const fixture = await loadFixture()
    const pendingWithApprover = structuredClone(fixture.knownDifferences)
    pendingWithApprover[0]!.approvedBy = 'not-an-approval'
    expect(validateKnownDifferences(
      pendingWithApprover,
      fixture.matrixEntries,
      new Date('2026-08-25T12:00:00Z')
    )).toContain('known-differences.json[0] is pending and must not set approvedBy')

    const expired = structuredClone(fixture.knownDifferences)
    expired[0]!.expiresOn = '2026-08-24'
    expect(validateKnownDifferences(
      expired,
      fixture.matrixEntries,
      new Date('2026-08-25T12:00:00Z')
    )).toContain('known-differences.json[0] expired on 2026-08-24')
  })

  it('returns stable release blockers for incomplete rows and pending differences', async () => {
    const fixture = await loadFixture()
    expect(evaluateReleaseReadiness(
      fixture.matrixEntries,
      fixture.manifest,
      fixture.knownDifferences
    )).toEqual({
      releaseReady: false,
      blockers: [
        { id: 'KD-9001', status: 'pending' },
        { id: 'PAR-013', status: 'partial' }
      ]
    })

    const unapprovedIntentional = structuredClone(fixture.manifest)
    unapprovedIntentional.entries[1]!.status = 'intentional-difference'
    expect(evaluateReleaseReadiness(
      fixture.matrixEntries,
      unapprovedIntentional,
      fixture.knownDifferences
    ).blockers).toEqual([
      { id: 'KD-9001', status: 'pending' },
      { id: 'PAR-013', status: 'intentional-difference-unapproved' }
    ])

    const approved = structuredClone(fixture.knownDifferences)
    approved[0]!.approvalStatus = 'approved'
    approved[0]!.approvedBy = 'fixture-reviewer'
    expect(evaluateReleaseReadiness(
      fixture.matrixEntries,
      unapprovedIntentional,
      approved
    )).toEqual({ releaseReady: true, blockers: [] })
  })

  it('counts every allowed status including zero-count states', async () => {
    const fixture = await loadFixture()
    expect(countParityStatuses(fixture.manifest.entries)).toEqual({
      verified: 1,
      partial: 1,
      missing: 0,
      'external-blocked': 0,
      'intentional-difference': 1
    })
  })
})

async function validate(
  manifest: unknown,
  matrixEntries: ParityMatrixEntry[]
): Promise<string[]> {
  return validateEvidenceManifest({
    matrixEntries,
    manifest,
    root: fixtureRoot,
    expectedMatrixPath: 'matrix.md'
  })
}

async function loadFixture(): Promise<{
  matrixEntries: ParityMatrixEntry[]
  manifest: ParityEvidenceManifest
  knownDifferences: KnownDifference[]
}> {
  const [matrix, manifest, knownDifferences] = await Promise.all([
    readFile(new URL('../fixtures/qa-contracts/matrix.md', import.meta.url), 'utf8'),
    readFile(new URL('../fixtures/qa-contracts/parity-evidence.valid.json', import.meta.url), 'utf8'),
    readFile(new URL('../fixtures/qa-contracts/known-differences.valid.json', import.meta.url), 'utf8')
  ])
  return {
    matrixEntries: parseParityMatrix(matrix),
    manifest: JSON.parse(manifest) as ParityEvidenceManifest,
    knownDifferences: JSON.parse(knownDifferences) as KnownDifference[]
  }
}
