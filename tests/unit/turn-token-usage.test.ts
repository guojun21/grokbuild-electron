import { describe, expect, it } from 'vitest'
import {
  MAX_TOKEN_COUNT,
  parseContextUsageFromSessionUpdate,
  parseTurnTokenUsage,
  parseTurnTokenUsageFromSessionUpdate
} from '../../src/shared/acp/usage'

describe('pinned Swift-compatible turn token usage', () => {
  it('parses flat and nested prompt-result metadata with pinned precedence', () => {
    expect(parseTurnTokenUsage({
      stopReason: 'end_turn',
      _meta: {
        sessionId: 'must-not-survive',
        inputTokens: 11_954,
        outputTokens: 36,
        cachedReadTokens: 7_639,
        reasoningTokens: 0,
        totalTokens: 11_990
      }
    })).toEqual({
      inputTokens: 11_954,
      outputTokens: 36,
      cachedReadTokens: 7_639,
      reasoningTokens: 0,
      totalTokens: 11_990
    })

    expect(parseTurnTokenUsage({
      usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 4 },
      _meta: {
        usage: { inputTokens: 500, cachedReadTokens: 200 },
        inputTokens: 999,
        cachedReadTokens: 1
      }
    })).toEqual({ inputTokens: 10, outputTokens: 2, cachedReadTokens: 4 })
  })

  it('ignores a context total without a per-turn breakdown', () => {
    const update = { _meta: { totalTokens: 42_000 } }
    expect(parseTurnTokenUsage(update)).toBeUndefined()
    expect(parseTurnTokenUsageFromSessionUpdate({ update })).toBeUndefined()
    expect(parseContextUsageFromSessionUpdate({ update })).toEqual({ used: 42_000 })
  })

  it('supports xAI snake case, full-input cache semantics, and OpenAI details', () => {
    expect(parseTurnTokenUsage({
      sessionUpdate: 'response_completed',
      usage: {
        input_tokens: 15_163,
        output_tokens: 42,
        cache_read_input_tokens: 2_944,
        reasoning_tokens: 37
      }
    })).toEqual({
      inputTokens: 18_107,
      outputTokens: 42,
      cachedReadTokens: 2_944,
      reasoningTokens: 37
    })

    expect(parseTurnTokenUsage({
      usage: {
        prompt_tokens: 120,
        completion_tokens: 9,
        prompt_tokens_details: { cached_tokens: 40 }
      }
    })).toEqual({ inputTokens: 120, outputTokens: 9, cachedReadTokens: 40 })
  })

  it('accepts the bounded numeric compatibility shapes used by Swift', () => {
    expect(parseTurnTokenUsage({
      result: {
        _meta: {
          usage: {
            inputTokens: '18107',
            outputTokens: 42.9,
            cacheReadInputTokens: '2944',
            thought_tokens: 37
          }
        }
      }
    })).toEqual({
      inputTokens: 18_107,
      outputTokens: 42,
      cachedReadTokens: 2_944,
      reasoningTokens: 37
    })
  })

  it('fails closed on hostile counters and never returns wire siblings', () => {
    const canary = 'usage-secret-canary-73d2'
    const parsed = parseTurnTokenUsage({
      usage: {
        inputTokens: MAX_TOKEN_COUNT + 1,
        outputTokens: 12,
        cachedReadTokens: -1,
        reasoningTokens: Number.POSITIVE_INFINITY,
        totalTokens: `999999999999999999999999${canary}`,
        authorization: `Bearer ${canary}`,
        path: `/private/${canary}`
      },
      token: canary
    })
    expect(parsed).toEqual({ outputTokens: 12 })
    expect(JSON.stringify(parsed)).not.toContain(canary)
    expect(JSON.stringify(parsed)).not.toContain('/private/')
  })

  it('keeps explicit context used/limit separate from turn buckets', () => {
    const update = {
      update: {
        sessionUpdate: 'usage_update',
        usage: { used: 28_000, limit: 500_000 }
      }
    }
    expect(parseContextUsageFromSessionUpdate(update)).toEqual({
      used: 28_000,
      limit: 500_000
    })
    expect(parseTurnTokenUsageFromSessionUpdate(update)).toBeUndefined()
  })
})
