import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  approvedIgnorePointers,
  compareCanonicalJson
} from '../../scripts/qa/lib/canonical-diff.mjs'

describe('canonical parity diff', () => {
  it('compares objects by key and arrays by order with precise JSON pointers', () => {
    const report = compareCanonicalJson(
      { object: { same: true, changed: 1 }, order: ['a', 'b'], removed: 'x' },
      { object: { changed: 2, same: true }, order: ['b', 'a'], added: 'y' }
    )
    expect(report.equal).toBe(false)
    expect(report.differences.map((difference) => [difference.pointer, difference.kind])).toEqual([
      ['/added', 'added'],
      ['/object/changed', 'value'],
      ['/order/0', 'value'],
      ['/order/1', 'value'],
      ['/removed', 'removed']
    ])
  })

  it('never copies differing string values into the report', () => {
    const canary = 'CANONICAL_DIFF_SECRET_73B4'
    const report = compareCanonicalJson({ value: canary }, { value: `other-${canary}` })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(canary)
    expect(report.differences[0]?.expected).toMatchObject({ kind: 'string', length: canary.length })
  })

  it('requires an approved, unexpired registry entry for every ignored subtree', () => {
    const known = [{
      id: 'KD-0099',
      approvalStatus: 'approved',
      expiresOn: '2026-09-30'
    }]
    expect(approvedIgnorePointers([
      { differenceId: 'KD-0099', pointer: '/window/frame' }
    ], known, new Date('2026-08-25T00:00:00Z'))).toEqual(['/window/frame'])
    expect(compareCanonicalJson(
      { window: { frame: [1, 2], title: 'Grok' } },
      { window: { frame: [3, 4], title: 'Grok' } },
      { ignoredPointers: ['/window/frame'] }
    ).equal).toBe(true)
    expect(() => approvedIgnorePointers([
      { differenceId: 'KD-0099', pointer: '/window/frame' }
    ], [{ ...known[0], approvalStatus: 'pending' }], new Date('2026-08-25T00:00:00Z')))
      .toThrow('not approved')
    expect(() => approvedIgnorePointers([
      { differenceId: 'KD-0099', pointer: '/window/frame' }
    ], known, new Date('2026-10-01T00:00:00Z'))).toThrow('expired')
  })

  it('enforces node, depth, difference, and pointer budgets', () => {
    expect(() => compareCanonicalJson({ a: { b: 1 } }, { a: { b: 2 } }, { maximumDepth: 1 }))
      .toThrow('depth budget')
    expect(() => compareCanonicalJson({ a: 1, b: 2 }, { a: 2, b: 3 }, { maximumNodes: 1 }))
      .toThrow('node budget')
    const limited = compareCanonicalJson([1, 2, 3], [4, 5, 6], { maximumDifferences: 1 })
    expect(limited).toMatchObject({ equal: false, truncated: true })
    expect(() => compareCanonicalJson({}, {}, { ignoredPointers: ['not-a-pointer'] }))
      .toThrow('Invalid JSON pointer')
  })

  it('provides a reproducible CLI report without paths or differing values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-canonical-diff-'))
    try {
      const expected = join(root, 'swift.json')
      const actual = join(root, 'electron.json')
      const registry = join(root, 'known.json')
      const output = join(root, 'report.json')
      const canary = 'CLI_CANONICAL_SECRET_8D31'
      await Promise.all([
        writeFile(expected, JSON.stringify({ value: canary })),
        writeFile(actual, JSON.stringify({ value: `different-${canary}` })),
        writeFile(registry, '[]')
      ])
      const result = spawnSync(process.execPath, [
        resolve('scripts/qa/compare-canonical.mjs'),
        '--expected', expected,
        '--actual', actual,
        '--known-differences', registry,
        '--output', output
      ], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('Canonical parity differs (1 difference(s)).')
      const report = await readFile(output, 'utf8')
      expect(report).not.toContain(canary)
      expect(report).not.toContain(root)
      expect(JSON.parse(report)).toMatchObject({
        schemaVersion: 1,
        expected: 'swift.json',
        actual: 'electron.json',
        equal: false
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
