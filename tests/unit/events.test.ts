import { describe, expect, it } from 'vitest'
import { normalizeSessionUpdate } from '../../src/shared/acp/events'

describe('ACP event normalization', () => {
  it('normalizes the rich Swift-compatible stream shapes', () => {
    expect(normalizeSessionUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } } })).toEqual({ type: 'assistant_delta', text: 'Hi' })
    expect(normalizeSessionUpdate({ update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', rawInput: '{}' } })).toEqual({ type: 'tool_start', id: 't1', title: 'Read file', detail: 'Tool input received (0 fields).', activityKind: 'read_file' })
    expect(normalizeSessionUpdate({ update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'done' } })).toEqual({ type: 'tool_update', id: 't1', status: 'completed', detail: 'done' })
    expect(normalizeSessionUpdate({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't2',
        status: 'running',
        title: 'List `/tmp/project`'
      }
    })).toEqual({
      type: 'tool_update',
      id: 't2',
      status: 'running',
      title: 'List `[PATH REDACTED]`',
      activityKind: 'listed'
    })
  })

  it('semantically projects tool payloads and redacts titles, strings, and unknown events', () => {
    const canary = 'tool-secret-canary-8a3f9d'
    const token = `xai-${canary}`
    const started = normalizeSessionUpdate({
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: `Read\u0000 Bearer ${canary}`,
        rawInput: {
          summary: 'Read 2 records',
          count: 2,
          token,
          authorization: `Bearer ${canary}`,
          headers: { cookie: canary },
          env: { XAI_API_KEY: token },
          path: `/private/${canary}`
        }
      }
    })
    expect(started).toMatchObject({
      type: 'tool_start',
      title: 'Read Bearer [REDACTED]',
      detail: '{"summary":"Read 2 records","count":2}',
      activityKind: 'read_file'
    })

    const completed = normalizeSessionUpdate({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: {
          stdout: canary,
          headers: { authorization: token },
          env: { TOKEN: canary },
          path: `/tmp/${canary}`
        }
      }
    })
    expect(completed).toMatchObject({
      type: 'tool_update',
      detail: 'Tool output received (4 fields).'
    })

    const unknown = normalizeSessionUpdate({
      update: {
        sessionUpdate: 'future_event',
        token,
        headers: { authorization: `Bearer ${canary}` },
        message: `See https://user:${canary}@example.test/?api_key=${canary}`
      }
    })
    const serialized = JSON.stringify([started, completed, unknown])
    expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain('/private/')
    expect(serialized).not.toContain('/tmp/')
    expect(serialized).not.toMatch(/[\u0000-\u001f\u007f]/)
  })

  it('normalizes plan and usage updates without leaking wire fields', () => {
    expect(normalizeSessionUpdate({ update: { sessionUpdate: 'plan', entries: [{ content: 'Build', status: 'in_progress' }] } })).toEqual({ type: 'plan', entries: [{ text: 'Build', status: 'in_progress' }] })
    expect(normalizeSessionUpdate({ update: { sessionUpdate: 'usage_update', usage: { used: 12, limit: 500_000 } } })).toEqual({ type: 'context_usage', used: 12, limit: 500_000 })
    expect(normalizeSessionUpdate({
      type: 'turn_usage',
      usage: { inputTokens: 100, outputTokens: 8, cachedReadTokens: 40 }
    })).toEqual({
      type: 'turn_usage',
      usage: { inputTokens: 100, outputTokens: 8, cachedReadTokens: 40 }
    })
    expect(normalizeSessionUpdate({
      update: {
        sessionUpdate: 'usage_update',
        usage: { used: Number.POSITIVE_INFINITY, limit: -1, token: 'must-not-survive' }
      }
    })).toEqual({ type: 'unknown', name: 'usage_update', payload: {} })
  })

  it('normalizes authoritative current mode updates without exposing yolo copy', () => {
    expect(normalizeSessionUpdate({
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }
    })).toEqual({ type: 'mode_changed', mode: 'plan' })
    expect(normalizeSessionUpdate({
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'yolo' }
    })).toEqual({ type: 'mode_changed', mode: 'default', permissionMode: 'auto' })
  })

  it('projects hook runs to a bounded kind and count without retaining payloads', () => {
    const canary = 'QA_HOOK_SECRET_CANARY_2E77'
    const event = normalizeSessionUpdate({
      update: {
        sessionUpdate: 'hook_execution',
        event_name: 'pre_tool_use',
        runs: [{
          command: `rm /private/${canary}`,
          env: { XAI_API_KEY: `xai-${canary}` },
          token: canary,
          output: canary
        }]
      }
    })
    expect(event).toEqual({ type: 'hook_execution', hook: 'pre_tool_use', runCount: 1 })
    expect(JSON.stringify(event)).not.toContain(canary)
    expect(JSON.stringify(event)).not.toContain('/private/')

    expect(normalizeSessionUpdate({
      update: { sessionUpdate: 'hook_execution', eventName: canary, runs: [{}, {}] }
    })).toEqual({ type: 'hook_execution', hook: 'other', runCount: 2 })
  })
})
