import { describe, expect, it } from 'vitest'
import { appendUserMessage, applyAcpEvent } from '../../src/shared/chat/reducer'
import type { SessionSnapshot } from '../../src/shared/models'

function session(): SessionSnapshot {
  const time = '2026-08-25T00:00:00.000Z'
  return {
    id: 'local-1', projectId: 'project-1', title: 'New chat', status: 'running', model: 'grok-4.6', mode: 'default', reasoningEffort: 'xhigh', permissionMode: 'ask', contextUsed: 0, contextLimit: 500_000, transcript: [], createdAt: time, updatedAt: time
  }
}

describe('canonical transcript reducer', () => {
  it('coalesces adjacent assistant chunks and closes them before a tool', () => {
    let state = applyAcpEvent(session(), { type: 'assistant_delta', text: 'Hello ' })
    state = applyAcpEvent(state, { type: 'assistant_delta', text: 'world' })
    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]).toMatchObject({ kind: 'message', text: 'Hello world', streaming: true })
    state = applyAcpEvent(state, { type: 'tool_start', id: 't1', title: 'Read file', activityKind: 'read_file' })
    expect(state.transcript[0]).toMatchObject({ streaming: false })
    expect(state.transcript[1]).toMatchObject({
      kind: 'activity',
      entries: [{ kind: 'read_file', count: 1 }],
      isLead: true,
      open: true
    })
    expect(state.transcript[2]).toMatchObject({ kind: 'tool', id: 't1', status: 'running' })
  })

  it('patches tool state and keeps context and turn usage separate', () => {
    let state = applyAcpEvent(session(), { type: 'tool_start', id: 't1', title: 'Read file', activityKind: 'read_file' })
    state = applyAcpEvent(state, { type: 'tool_update', id: 't1', status: 'completed', detail: 'done' })
    state = applyAcpEvent(state, { type: 'context_usage', used: 28_000, limit: 500_000 })
    state = applyAcpEvent(state, {
      type: 'turn_usage',
      usage: {
        inputTokens: 11_954,
        outputTokens: 36,
        cachedReadTokens: 7_639,
        reasoningTokens: 0,
        totalTokens: 11_990
      }
    })
    expect(state.transcript.find((item) => item.kind === 'tool')).toMatchObject({ status: 'completed', detail: 'done' })
    expect(state.contextUsed).toBe(28_000)
    expect(state.contextLimit).toBe(500_000)
    expect(state.lastTurnUsage).toEqual({
      inputTokens: 11_954,
      outputTokens: 36,
      cachedReadTokens: 7_639,
      reasoningTokens: 0,
      totalTokens: 11_990
    })
  })

  it('accepts authoritative mode changes from ACP', () => {
    let state: SessionSnapshot = { ...session(), permissionMode: 'auto' }
    state = applyAcpEvent(state, { type: 'mode_changed', mode: 'plan' })
    expect(state).toMatchObject({ mode: 'plan', permissionMode: 'auto' })
    state = applyAcpEvent(state, { type: 'mode_changed', mode: 'default', permissionMode: 'auto' })
    expect(state).toMatchObject({ mode: 'default', permissionMode: 'auto' })
  })

  it('merges a late assistant chunk into the completed turn until the next user send', () => {
    let state = applyAcpEvent(session(), { type: 'assistant_delta', text: 'First' })
    state = applyAcpEvent(state, { type: 'tool_start', id: 't1', title: 'Read file', activityKind: 'read_file' })
    state = applyAcpEvent(state, { type: 'turn_complete' })

    state = applyAcpEvent(state, { type: 'assistant_delta', text: ' + late' })

    expect(state.status).toBe('idle')
    expect(state.transcript).toHaveLength(3)
    expect(state.transcript[0]).toMatchObject({
      kind: 'message',
      role: 'assistant',
      text: 'First + late',
      streaming: false
    })

    state = appendUserMessage(state, 'Next turn')
    state = applyAcpEvent(state, { type: 'tool_start', id: 't2', title: 'Inspect next turn', activityKind: 'other' })
    state = applyAcpEvent(state, { type: 'assistant_delta', text: 'Second' })
    expect(state.transcript).toHaveLength(7)
    expect(state.transcript[6]).toMatchObject({
      kind: 'message',
      role: 'assistant',
      text: 'Second',
      streaming: true
    })
  })

  it('folds tool and hook activity in pinned order without retaining hook payloads', () => {
    let state = applyAcpEvent(session(), { type: 'assistant_delta', text: "I'll start." })
    state = applyAcpEvent(state, { type: 'hook_execution', hook: 'user_prompt_submit', runCount: 1 })
    state = applyAcpEvent(state, { type: 'hook_execution', hook: 'pre_tool_use', runCount: 1 })
    state = applyAcpEvent(state, { type: 'tool_start', id: '1', title: 'redacted', activityKind: 'read_skill' })
    state = applyAcpEvent(state, { type: 'hook_execution', hook: 'pre_tool_use', runCount: 1 })
    state = applyAcpEvent(state, { type: 'tool_start', id: '2', title: 'redacted', activityKind: 'listed' })
    state = applyAcpEvent(state, { type: 'hook_execution', hook: 'pre_tool_use', runCount: 1 })
    state = applyAcpEvent(state, { type: 'tool_start', id: '3', title: 'redacted', activityKind: 'read_file' })
    state = applyAcpEvent(state, { type: 'hook_execution', hook: 'pre_tool_use', runCount: 1 })
    state = applyAcpEvent(state, { type: 'tool_start', id: '4', title: 'redacted', activityKind: 'read_file' })
    state = applyAcpEvent(state, { type: 'hook_execution', hook: 'post_tool_use', runCount: 99 })
    state = applyAcpEvent(state, { type: 'hook_execution', hook: 'stop', runCount: 3 })
    state = applyAcpEvent(state, { type: 'assistant_delta', text: 'Done.' })

    const activities = state.transcript.filter((item) => item.kind === 'activity')
    expect(activities).toEqual([
      expect.objectContaining({
        kind: 'activity',
        entries: [
          { kind: 'read_skill', count: 1 },
          { kind: 'listed', count: 1 },
          { kind: 'read_file', count: 2 }
        ],
        hookCount: 5,
        isLead: true,
        open: false
      }),
      expect.objectContaining({
        kind: 'activity',
        entries: [{ kind: 'stop', count: 1 }],
        hookCount: 3,
        isLead: false,
        open: false
      })
    ])
    expect(state.pendingHookRuns).toBeUndefined()
    expect(state.transcript.map((item) => item.kind)).toEqual([
      'message', 'activity', 'tool', 'tool', 'tool', 'tool', 'activity', 'message'
    ])
  })

  it('lets a semantic tool-update title establish activity for a placeholder call', () => {
    let state = applyAcpEvent(session(), {
      type: 'tool_start',
      id: 'late-title',
      title: 'Tool call'
    })
    state = applyAcpEvent(state, { type: 'hook_execution', hook: 'pre_tool_use', runCount: 2 })
    state = applyAcpEvent(state, {
      type: 'tool_update',
      id: 'late-title',
      status: 'running',
      title: 'Read file',
      activityKind: 'read_file'
    })

    expect(state.transcript.map((item) => item.kind)).toEqual(['activity', 'tool'])
    expect(state.transcript[0]).toMatchObject({
      kind: 'activity',
      entries: [{ kind: 'read_file', count: 1 }],
      hookCount: 2,
      open: true
    })
    expect(state.transcript[1]).toMatchObject({
      kind: 'tool',
      id: 'late-title',
      title: 'Read file',
      activityKind: 'read_file'
    })
  })
})
