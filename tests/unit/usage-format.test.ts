import { describe, expect, it } from 'vitest'
import {
  cachedPercent,
  formatCachedLine,
  formatContextSummary,
  formatDecimalTokens,
  usagePercent
} from '../../src/shared/acp/usageFormat'

describe('context and last-turn usage formatting', () => {
  it('formats pinned decimal and whole-percent context values', () => {
    expect(formatDecimalTokens(11_954)).toBe('11,954')
    expect(formatContextSummary(28_000, 500_000)).toBe('28,000 / 500,000 tokens')
    expect(usagePercent(28_000, 500_000)).toBe(6)
    expect(usagePercent(600_000, 500_000)).toBe(100)
  })

  it('omits unsafe percentages and clamps the cached share', () => {
    expect(cachedPercent(7_639, 11_954)).toBe(64)
    expect(formatCachedLine(7_639, 11_954)).toBe('7,639 cached (64%)')
    expect(formatCachedLine(10, 0)).toBe('10 cached')
    expect(formatCachedLine(0, undefined)).toBe('0 cached')
    expect(formatCachedLine(undefined, 100)).toBeUndefined()
    expect(cachedPercent(200, 100)).toBe(100)
    expect(usagePercent(10, 0)).toBeUndefined()
    expect(usagePercent(Number.POSITIVE_INFINITY, 100)).toBeUndefined()
  })
})
