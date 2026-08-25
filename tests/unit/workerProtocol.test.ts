import { describe, expect, it } from 'vitest'
import {
  ACP_AGENT_PROFILE_LIMITS,
  workerCommandSchema,
  workerResponseSchema,
  workerStartResultSchema
} from '../../src/shared/acp/workerProtocol'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')

describe('ACP utility worker contracts', () => {
  it('accepts the minimum valid command envelope', () => {
    expect(
      workerCommandSchema.parse({ id: 1, type: 'prompt', payload: { text: 'hello' } })
    ).toEqual({ id: 1, type: 'prompt', payload: { text: 'hello' } })
  })

  it('accepts validated content blocks unchanged', () => {
    const command = {
      id: 2,
      type: 'prompt' as const,
      payload: {
        blocks: [
          { type: 'text' as const, text: 'Inspect this image' },
          { type: 'image' as const, data: PNG, mimeType: 'image/png' as const }
        ]
      }
    }
    expect(workerCommandSchema.parse(command)).toEqual(command)
  })

  it('round-trips a strict fork launch and its bounded start result', () => {
    const command = {
      id: 3,
      type: 'start' as const,
      payload: {
        localSessionId: 'local-fork',
        generation: 1,
        cliPath: '/mock/grok',
        cwd: '/workspace',
        model: 'grok-4.6',
        reasoningEffort: 'xhigh',
        memoryEnabled: true,
        forkSession: {
          sourceSessionId: '11111111-1111-4111-8111-111111111111',
          newSessionId: '22222222-2222-4222-8222-222222222222',
          newModelId: 'grok-4.6'
        },
        environment: {}
      }
    }
    expect(workerCommandSchema.parse(command)).toEqual(command)
    expect(workerStartResultSchema.parse({
      sessionId: '22222222-2222-4222-8222-222222222222',
      resumed: false,
      forkedFrom: '11111111-1111-4111-8111-111111111111'
    })).toEqual({
      sessionId: '22222222-2222-4222-8222-222222222222',
      resumed: false,
      forkedFrom: '11111111-1111-4111-8111-111111111111'
    })
    expect(workerStartResultSchema.safeParse({
      sessionId: '22222222-2222-4222-8222-222222222222',
      resumed: false,
      forkedFrom: '11111111-1111-4111-8111-111111111111',
      chatMessagesCopied: 4,
      newCwd: '/must-not-cross-worker-boundary'
    }).success).toBe(false)
  })

  it('round-trips only a strict bounded inline primary-agent profile', () => {
    const profile = {
      name: 'security_reviewer',
      description: 'Reviews trust boundaries.',
      promptBody: 'Inspect the requested boundary and report concrete findings.'
    }
    const command = {
      id: 7,
      type: 'start' as const,
      payload: {
        localSessionId: 'local-profile',
        generation: 2,
        cliPath: '/mock/grok',
        cwd: '/workspace',
        model: 'grok-4.6',
        reasoningEffort: 'xhigh',
        agentProfile: profile,
        environment: {}
      }
    }
    expect(workerCommandSchema.parse(command)).toEqual(command)
  })

  it('rejects malformed, injected, and oversized primary-agent profiles at the worker boundary', () => {
    const envelope = (agentProfile: unknown) => ({
      id: 8,
      type: 'start',
      payload: {
        localSessionId: 'local-profile',
        generation: 2,
        cliPath: '/mock/grok',
        cwd: '/workspace',
        model: 'grok-4.6',
        reasoningEffort: 'xhigh',
        agentProfile,
        environment: {}
      }
    })
    const valid = {
      name: 'safe-agent_1',
      description: 'Safe description',
      promptBody: 'Safe prompt'
    }
    for (const profile of [
      { ...valid, name: '../unsafe' },
      { ...valid, name: 'x'.repeat(ACP_AGENT_PROFILE_LIMITS.nameChars + 1) },
      { ...valid, description: 'x'.repeat(ACP_AGENT_PROFILE_LIMITS.descriptionChars + 1) },
      { ...valid, promptBody: 'x'.repeat(ACP_AGENT_PROFILE_LIMITS.promptBodyChars + 1) },
      { ...valid, sourcePath: '/private/agent.md' },
      { name: valid.name, description: valid.description }
    ]) {
      expect(workerCommandSchema.safeParse(envelope(profile)).success).toBe(false)
    }
  })

  it('rejects fork/load ambiguity, malformed fork ids, and injected fork fields', () => {
    const launch = {
      localSessionId: 'local-fork',
      generation: 1,
      cliPath: '/mock/grok',
      cwd: '/workspace',
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      environment: {}
    }
    const envelope = (payload: Record<string, unknown>) => ({
      id: 4,
      type: 'start',
      payload: { ...launch, ...payload }
    })
    expect(workerCommandSchema.safeParse(envelope({
      resumeSessionId: 'persisted-session',
      forkSession: {
        sourceSessionId: '11111111-1111-4111-8111-111111111111',
        newSessionId: '22222222-2222-4222-8222-222222222222'
      }
    })).success).toBe(false)
    expect(workerCommandSchema.safeParse(envelope({
      forkSession: {
        sourceSessionId: 'not-a-uuid',
        newSessionId: '22222222-2222-4222-8222-222222222222'
      }
    })).success).toBe(false)
    expect(workerCommandSchema.safeParse(envelope({
      forkSession: {
        sourceSessionId: '11111111-1111-4111-8111-111111111111',
        newSessionId: 'not-a-uuid',
        sourceCwd: '/renderer/injected'
      }
    })).success).toBe(false)
    expect(workerCommandSchema.safeParse(envelope({
      forkSession: {
        sourceSessionId: '11111111-1111-4111-8111-111111111111',
        newSessionId: '22222222-2222-4222-8222-222222222222',
        newModelId: 'x'.repeat(129)
      }
    })).success).toBe(false)
  })

  it('rejects unexpected command and payload capabilities', () => {
    expect(() =>
      workerCommandSchema.parse({
        id: 1,
        type: 'prompt',
        payload: { text: 'hello', shell: '/bin/zsh' }
      })
    ).toThrow()
    expect(() =>
      workerCommandSchema.parse({
        id: 1,
        type: 'prompt',
        payload: { text: 'hello', blocks: [{ type: 'text', text: 'shadow' }] }
      })
    ).toThrow()
    expect(() =>
      workerCommandSchema.parse({
        id: 1,
        type: 'prompt',
        payload: { blocks: [{ type: 'image', data: PNG, mimeType: 'image/jpeg' }] }
      })
    ).toThrow()
    expect(() =>
      workerCommandSchema.parse({
        id: 1,
        type: 'cancel',
        payload: {},
        privileged: true
      })
    ).toThrow()
  })

  it('rejects malformed worker responses', () => {
    expect(
      workerResponseSchema.safeParse({ kind: 'response', id: 1, ok: true, extra: true }).success
    ).toBe(false)
    expect(
      workerResponseSchema.safeParse({ kind: 'event', event: 'unknown', payload: null }).success
    ).toBe(false)
  })

  it('allows only bounded semantic metering, mode, hook, and activity data on the trusted worker path', () => {
    const base = {
      kind: 'event' as const,
      event: 'trusted_update' as const,
      localSessionId: 'local-1',
      generation: 1,
      sequence: 1
    }
    expect(workerResponseSchema.parse({
      ...base,
      payload: {
        type: 'turn_usage',
        usage: { inputTokens: 100, outputTokens: 8, cachedReadTokens: 40 }
      }
    })).toMatchObject({ payload: { type: 'turn_usage', usage: { inputTokens: 100 } } })
    expect(workerResponseSchema.parse({
      ...base,
      payload: { type: 'mode_changed', mode: 'plan' }
    })).toMatchObject({ payload: { mode: 'plan' } })
    expect(workerResponseSchema.parse({
      ...base,
      payload: { type: 'hook_execution', hook: 'pre_tool_use', runCount: 2 }
    })).toMatchObject({ payload: { hook: 'pre_tool_use', runCount: 2 } })
    expect(workerResponseSchema.parse({
      ...base,
      payload: {
        type: 'activity_schedule_upsert',
        source: 'typed',
        fired: false,
        generation: '2',
        revision: '5',
        schedule: {
          identity: 'private-main-only-task-id',
          label: 'Review build',
          schedule: 'Every hour'
        }
      }
    })).toMatchObject({
      payload: {
        type: 'activity_schedule_upsert',
        schedule: { label: 'Review build' }
      }
    })
    expect(workerResponseSchema.safeParse({
      ...base,
      payload: {
        type: 'turn_usage',
        usage: { inputTokens: 100, token: 'must-not-cross' }
      }
    }).success).toBe(false)
    expect(workerResponseSchema.safeParse({
      ...base,
      payload: { type: 'context_usage', used: Number.MAX_SAFE_INTEGER }
    }).success).toBe(false)
    expect(workerResponseSchema.safeParse({
      ...base,
      payload: { type: 'mode_changed', mode: 'plan', permissionMode: 'ask' }
    }).success).toBe(false)
    expect(workerResponseSchema.safeParse({
      ...base,
      payload: {
        type: 'hook_execution',
        hook: 'pre_tool_use',
        runCount: 1,
        runs: [{ command: 'must-not-cross', env: { TOKEN: 'must-not-cross' } }]
      }
    }).success).toBe(false)
    expect(workerResponseSchema.safeParse({
      ...base,
      payload: { type: 'hook_execution', hook: 'secret-custom-hook', runCount: 1 }
    }).success).toBe(false)
    expect(workerResponseSchema.safeParse({
      ...base,
      payload: {
        type: 'activity_schedule_upsert',
        source: 'typed',
        fired: false,
        schedule: {
          identity: 'private-main-only-task-id',
          label: 'Review build'
        },
        rawOutput: { path: '/private/must-not-cross', credential: 'must-not-cross' }
      }
    }).success).toBe(false)
  })
})
