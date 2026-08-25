import { describe, expect, it } from 'vitest'
import { canonicalCliVersion, cliVersionAtLeast } from '../../src/main/grok/cliVersion'

describe('Grok CLI version projection', () => {
  it('projects only canonical semver and drops bounded build metadata', () => {
    expect(canonicalCliVersion('grok 1.0.5 (5115b46bc909)\n')).toBe('1.0.5')
    expect(canonicalCliVersion(canonicalCliVersion('grok 1.0.5 (5115b46bc909)'))).toBe('1.0.5')
    expect(canonicalCliVersion('grok 001.02.0003 (qa-mock)')).toBe('1.2.3')
    expect(cliVersionAtLeast('1.0.5', [1, 0, 5])).toBe(true)
    expect(cliVersionAtLeast('1.0.4', [1, 0, 5])).toBe(false)
  })

  it('rejects raw suffixes, paths, tokens, malformed output, and oversized first lines', () => {
    const canary = 'QA_CLI_VERSION_SECRET_19A7'
    for (const value of [
      `grok 1.0.5 token=${canary}`,
      `grok 1.0.5 /private/${canary}`,
      `other 1.0.5 ${canary}`,
      `grok 1.0.5 ${'x'.repeat(257)}`
    ]) {
      expect(canonicalCliVersion(value)).toBeUndefined()
    }
  })
})
