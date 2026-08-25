import { describe, expect, it } from 'vitest'
import {
  createSessionActivityProjectionState,
  reduceSessionActivityProjection,
  SessionActivityProjection,
  sessionActivitySnapshotFromState
} from '../../src/main/acp/SessionActivityProjection'
import {
  parseSessionActivityUpdate,
  sessionActivityUpdateSchema
} from '../../src/shared/acp/sessionActivityUpdates'
import {
  MAX_SESSION_ACTIVITY_ITEMS,
  sessionActivitySnapshotSchema
} from '../../src/shared/acp/sessionActivity'

describe('SessionActivityProjection', () => {
  it('parses direct and wrapped typed scheduler notifications with a bounded clock', () => {
    const direct = parseSessionActivityUpdate({
      method: 'x.ai/session_notification',
      params: {
        sessionId: 'remote-session-must-not-survive',
        update: {
          sessionUpdate: 'scheduled_task_created',
          task_snapshot: {
            task_id: 'raw-task-1',
            prompt: 'Review remote-session-must-not-survive raw-task-1 /private/project/secrets.txt',
            human_schedule: 'Every hour',
            next_fire_at: '2026-08-25T12:00:00Z'
          },
          _meta: {
            'x.ai/schedulerGeneration': 7,
            'x.ai/schedulerRevision': '11'
          }
        }
      }
    })
    expect(direct).toEqual({
      type: 'activity_schedule_upsert',
      source: 'typed',
      fired: false,
      generation: '7',
      revision: '11',
      schedule: {
        identity: 'raw-task-1',
        label: 'Review [ID REDACTED] [ID REDACTED] [PATH REDACTED]',
        schedule: 'Every hour',
        nextFireAt: '2026-08-25T12:00:00.000Z'
      }
    })

    expect(parseSessionActivityUpdate({
      method: '_x.ai/session/update',
      params: {
        method: '_x.ai/session_notification',
        params: {
          update: {
            sessionUpdate: 'scheduled_task_fired',
            taskId: 'raw-task-1',
            humanSchedule: 'Every hour'
          }
        }
      }
    })).toMatchObject({
      type: 'activity_schedule_upsert',
      fired: true,
      schedule: { identity: 'raw-task-1', schedule: 'Every hour' }
    })
  })

  it('ignores ordinary notifications and counts only malformed activity updates as unknown', () => {
    for (const sessionUpdate of [
      'turn_completed',
      'response_completed',
      'current_mode_update',
      'interaction_resolved',
      'usage_update'
    ]) {
      expect(parseSessionActivityUpdate({
        method: 'x.ai/session_notification',
        params: { update: { sessionUpdate } }
      })).toBeUndefined()
    }
    expect(parseSessionActivityUpdate({
      method: 'x.ai/session_notification',
      params: { update: { sessionUpdate: 'workflow_updated', revision: 3 } }
    })).toEqual({ type: 'activity_unknown' })
    expect(parseSessionActivityUpdate({
      method: 'x.ai/session_notification',
      params: { update: { sessionUpdate: 'workflow_future_variant' } }
    })).toEqual({ type: 'activity_unknown' })
  })

  it('keeps scheduler identities private and rejects stale generation/revision updates', () => {
    const projection = new SessionActivityProjection()
    projection.setSyncState('replaying')
    expect(projection.ingest(notification({
      sessionUpdate: 'scheduled_task_created',
      task_id: 'scheduler-secret-id',
      prompt: 'Inspect /Users/alice/private.txt',
      human_schedule: 'Every 5 minutes',
      _meta: { 'x.ai/schedulerGeneration': 4, 'x.ai/schedulerRevision': 8 }
    }))).toBe(true)
    projection.setSyncState('live')

    projection.ingest(notification({
      sessionUpdate: 'scheduled_task_deleted',
      task_id: 'scheduler-secret-id',
      _meta: { 'x.ai/schedulerGeneration': 4, 'x.ai/schedulerRevision': 7 }
    }))
    const retained = projection.getSnapshot()
    expect(retained.syncState).toBe('live')
    expect(retained.schedules).toHaveLength(1)
    expect(retained.schedules[0]).toMatchObject({
      viewKey: 'schedule-1',
      label: 'Inspect [PATH REDACTED]',
      schedule: 'Every 5 minutes'
    })
    expect(JSON.stringify(retained)).not.toContain('scheduler-secret-id')
    expect(JSON.stringify(retained)).not.toContain('/Users/alice')

    projection.ingest(notification({
      sessionUpdate: 'scheduled_task_deleted',
      task_id: 'scheduler-secret-id',
      _meta: { 'x.ai/schedulerGeneration': 4, 'x.ai/schedulerRevision': 9 }
    }))
    expect(projection.getSnapshot().schedules).toEqual([])
  })

  it('treats a newer scheduler generation as a fresh authoritative epoch', () => {
    const projection = new SessionActivityProjection()
    projection.ingest(notification({
      sessionUpdate: 'scheduled_task_created',
      task_id: 'old-epoch-task',
      prompt: 'Old task',
      _meta: { 'x.ai/schedulerGeneration': 3, 'x.ai/schedulerRevision': 1 }
    }))
    projection.ingest(notification({
      sessionUpdate: 'scheduled_task_created',
      task_id: 'also-old-epoch-task',
      prompt: 'Also old',
      _meta: { 'x.ai/schedulerGeneration': 3, 'x.ai/schedulerRevision': 2 }
    }))
    expect(projection.getSnapshot().schedules).toHaveLength(2)

    projection.ingest(notification({
      sessionUpdate: 'scheduled_task_created',
      task_id: 'restored-task',
      prompt: 'Restored',
      _meta: { 'x.ai/schedulerGeneration': 4, 'x.ai/schedulerRevision': 1 }
    }))
    expect(projection.getSnapshot().schedules).toEqual([{
      viewKey: 'schedule-3',
      label: 'Restored',
      status: 'scheduled',
      fireCount: 0
    }])

    projection.ingest(notification({
      sessionUpdate: 'scheduled_task_created',
      task_id: 'late-old-epoch-task',
      prompt: 'Must be ignored',
      _meta: { 'x.ai/schedulerGeneration': 3, 'x.ai/schedulerRevision': 99 }
    }))
    expect(projection.getSnapshot().schedules).toHaveLength(1)
  })

  it('keeps typed scheduler state authoritative over late legacy and unclocked updates', () => {
    const projection = new SessionActivityProjection()
    projection.ingest({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'legacy-create',
        rawOutput: { type: 'SchedulerCreate', id: 'shared-task', prompt: 'Legacy task' }
      }
    })
    projection.ingest(notification({
      sessionUpdate: 'scheduled_task_created',
      task_id: 'shared-task',
      prompt: 'Typed task',
      _meta: { 'x.ai/schedulerGeneration': 2, 'x.ai/schedulerRevision': 1 }
    }))

    projection.ingest({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'late-list',
        rawOutput: { type: 'SchedulerList', tasks: [] }
      }
    })
    projection.ingest(notification({
      sessionUpdate: 'scheduled_task_deleted',
      task_id: 'shared-task'
    }))
    expect(projection.getSnapshot().schedules[0]?.label).toBe('Typed task')

    projection.ingest(notification({
      sessionUpdate: 'scheduled_task_deleted',
      task_id: 'shared-task',
      _meta: { 'x.ai/schedulerGeneration': 2, 'x.ai/schedulerRevision': 2 }
    }))
    projection.ingest({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'late-create',
        rawOutput: { type: 'SchedulerCreate', id: 'shared-task', prompt: 'Must not resurrect' }
      }
    })
    expect(projection.getSnapshot().schedules).toEqual([])
    expect(projection.hasLiveProtectionWork()).toBe(false)
  })

  it('retains an internal protection truth when the public schedule cap overflows', () => {
    const projection = new SessionActivityProjection()
    const tasks = Array.from({ length: MAX_SESSION_ACTIVITY_ITEMS + 1 }, (_, index) => ({
      id: `overflow-task-${index}`,
      prompt: `Task ${index}`
    }))
    projection.ingest({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'overflow-list',
        rawOutput: { type: 'SchedulerList', tasks }
      }
    })
    expect(projection.getSnapshot().schedules).toHaveLength(MAX_SESSION_ACTIVITY_ITEMS)
    expect(projection.hasLiveProtectionWork()).toBe(true)

    for (let index = 0; index < MAX_SESSION_ACTIVITY_ITEMS; index += 1) {
      projection.apply({
        type: 'activity_schedule_delete',
        source: 'legacy',
        identity: `overflow-task-${index}`
      })
    }
    expect(projection.getSnapshot().schedules).toEqual([])
    expect(projection.hasLiveProtectionWork()).toBe(true)

    projection.ingest({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'authoritative-empty-list',
        rawOutput: { type: 'SchedulerList', tasks: [] }
      }
    })
    expect(projection.hasLiveProtectionWork()).toBe(false)

    const malformed = new SessionActivityProjection()
    malformed.ingest({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'malformed-list',
        rawOutput: { type: 'SchedulerList', tasks: [{}] }
      }
    })
    expect(malformed.getSnapshot().schedules).toEqual([])
    expect(malformed.hasLiveProtectionWork()).toBe(true)
  })

  it('applies workflow revision high-water and permanently tombstones cleared runs', () => {
    const projection = new SessionActivityProjection()
    projection.ingest(notification({
      sessionUpdate: 'workflow_updated',
      run_id: 'private-workflow-id',
      revision: 10,
      name: 'Research',
      objective: 'Review /private/source.md',
      status: 'active',
      agent_budget: 128,
      agents_used: 3
    }))
    projection.ingest(notification({
      sessionUpdate: 'workflow_updated',
      run_id: 'private-workflow-id',
      revision: 9,
      name: 'Regressed',
      status: 'failed'
    }))
    expect(projection.getSnapshot().workflows[0]).toMatchObject({
      name: 'Research',
      objective: 'Review [PATH REDACTED]',
      status: 'active',
      agentBudget: 128,
      agentsUsed: 3
    })

    projection.ingest(notification({
      sessionUpdate: 'workflow_updated',
      run_id: 'private-workflow-id',
      revision: 11,
      name: 'Research',
      status: 'cleared'
    }))
    projection.ingest(notification({
      sessionUpdate: 'workflow_updated',
      run_id: 'private-workflow-id',
      revision: 99,
      name: 'Must not resurrect',
      status: 'active'
    }))
    const snapshot = projection.getSnapshot()
    expect(snapshot.workflows).toEqual([])
    expect(JSON.stringify(snapshot)).not.toContain('private-workflow-id')
  })

  it('still applies a newer workflow clear after the tombstone cache saturates', () => {
    const projection = new SessionActivityProjection()
    projection.apply({
      type: 'activity_workflow_update',
      source: 'typed',
      workflow: {
        identity: 'active-workflow',
        revision: '1',
        name: 'Active workflow',
        status: 'active'
      }
    })
    for (let index = 0; index < 257; index += 1) {
      projection.apply({
        type: 'activity_workflow_update',
        source: 'typed',
        workflow: {
          identity: `cleared-workflow-${index}`,
          revision: '1',
          name: 'Cleared workflow',
          status: 'cleared'
        }
      })
    }
    expect(projection.hasLiveProtectionWork()).toBe(true)
    projection.apply({
      type: 'activity_workflow_update',
      source: 'typed',
      workflow: {
        identity: 'active-workflow',
        revision: '2',
        name: 'Active workflow',
        status: 'cleared'
      }
    })
    expect(projection.getSnapshot().workflows).toEqual([])
    expect(projection.hasLiveProtectionWork()).toBe(false)

    projection.apply({
      type: 'activity_workflow_update',
      source: 'typed',
      workflow: {
        identity: 'new-workflow-after-saturation',
        revision: '1',
        name: 'New active workflow',
        status: 'active'
      }
    })
    expect(projection.getSnapshot().workflows).toEqual([])
    expect(projection.hasLiveProtectionWork()).toBe(true)
  })

  it('retains goal protection truth after the goal tombstone cache saturates', () => {
    const projection = new SessionActivityProjection()
    for (let index = 0; index < 257; index += 1) {
      projection.apply({
        type: 'activity_goal_update',
        goal: {
          identity: `cleared-goal-${index}`,
          objective: 'Cleared goal',
          status: 'cleared'
        }
      })
    }
    expect(projection.hasLiveProtectionWork()).toBe(false)

    projection.apply({
      type: 'activity_goal_update',
      goal: {
        identity: 'new-goal-after-saturation',
        objective: 'New active goal',
        status: 'active'
      }
    })
    expect(projection.getSnapshot().goal).toBeNull()
    expect(projection.hasLiveProtectionWork()).toBe(true)
  })

  it('uses goal ids only for main-side tombstones and keeps elapsed time monotonic per goal', () => {
    const projection = new SessionActivityProjection()
    projection.ingest(notification({
      sessionUpdate: 'goal_updated',
      goal_id: 'private-goal-1',
      objective: 'Ship the app',
      status: 'active',
      token_budget: 50_000,
      tokens_used: 1_000,
      elapsed_ms: 500
    }))
    projection.ingest(notification({
      sessionUpdate: 'goal_updated',
      goal_id: 'private-goal-1',
      objective: 'Ship the app',
      status: 'paused',
      elapsed_ms: 400
    }))
    expect(projection.getSnapshot().goal).toMatchObject({
      objective: 'Ship the app',
      status: 'paused',
      elapsedMs: 500
    })

    projection.ingest(notification({
      sessionUpdate: 'goal_updated',
      goal_id: '',
      objective: '',
      status: 'cleared'
    }))
    projection.ingest(notification({
      sessionUpdate: 'goal_updated',
      goal_id: 'private-goal-1',
      objective: 'Late old goal',
      status: 'active'
    }))
    expect(projection.getSnapshot().goal).toBeNull()

    projection.ingest(notification({
      sessionUpdate: 'goal_updated',
      goal_id: 'private-goal-2',
      objective: 'New goal',
      status: 'active',
      elapsed_ms: 2
    }))
    projection.ingest(notification({
      sessionUpdate: 'goal_updated',
      goal_id: 'private-goal-1',
      objective: '',
      status: 'cleared'
    }))
    const snapshot = projection.getSnapshot()
    expect(snapshot.goal).toMatchObject({ objective: 'New goal', elapsedMs: 2 })
    expect(JSON.stringify(snapshot)).not.toContain('private-goal')
  })

  it('tombstones a replaced goal even when the CLI omits an explicit clear', () => {
    const projection = new SessionActivityProjection()
    projection.ingest(notification({
      sessionUpdate: 'goal_updated',
      goal_id: 'replaced-goal',
      objective: 'Old goal',
      status: 'active'
    }))
    projection.ingest(notification({
      sessionUpdate: 'goal_updated',
      goal_id: 'current-goal',
      objective: 'Current goal',
      status: 'active'
    }))
    projection.ingest(notification({
      sessionUpdate: 'goal_updated',
      goal_id: 'replaced-goal',
      objective: 'Late old update',
      status: 'active'
    }))
    expect(projection.getSnapshot().goal?.objective).toBe('Current goal')
  })

  it('projects typed background activity without commands, output, paths, or remote ids', () => {
    const projection = new SessionActivityProjection()
    projection.ingest(notification({
      sessionUpdate: 'task_backgrounded',
      task_id: 'private-command-id',
      command: 'cat /private/passwords.txt',
      output: 'secret output'
    }))
    projection.ingest(notification({
      sessionUpdate: 'monitor_event',
      monitor_id: 'private-monitor-id',
      monitor_description: 'Watch /private/build.log',
      event_text: 'secret event body'
    }))
    projection.ingest(notification({
      sessionUpdate: 'subagent_spawned',
      subagent_id: 'private-subagent-id',
      role: 'Verifier'
    }))
    projection.ingest(notification({
      sessionUpdate: 'task_completed',
      task_id: 'private-command-id',
      status: 'completed',
      output: 'another secret output'
    }))
    // A late start cannot regress a terminal activity.
    projection.ingest(notification({
      sessionUpdate: 'task_backgrounded',
      task_id: 'private-command-id'
    }))

    const snapshot = projection.getSnapshot()
    expect(snapshot.background).toEqual([
      {
        viewKey: 'background-1',
        kind: 'command',
        label: 'Background command',
        status: 'completed',
        updateCount: 2
      },
      {
        viewKey: 'background-2',
        kind: 'monitor',
        label: 'Watch [PATH REDACTED]',
        status: 'running',
        updateCount: 1
      },
      {
        viewKey: 'background-3',
        kind: 'subagent',
        label: 'Verifier',
        status: 'running',
        updateCount: 1
      }
    ])
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('private-command-id')
    expect(serialized).not.toContain('passwords.txt')
    expect(serialized).not.toContain('secret output')
    expect(serialized).not.toContain('event body')
  })

  it('supports the pinned Swift scheduler tool fallback and authoritative list replacement', () => {
    const projection = new SessionActivityProjection()
    projection.ingest({
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'private-call-create',
        rawInput: {
          id: 'private-target-task',
          prompt: 'Daily private-call-create private-target-task review',
          interval: '1h'
        },
        _meta: { 'x.ai/tool': { name: 'scheduler_create' } }
      }
    })
    projection.ingest({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'private-call-create',
        rawOutput: { type: 'SchedulerCreate', id: 'private-created-task', humanSchedule: 'Every hour' }
      }
    })
    expect(projection.getSnapshot().schedules[0]).toMatchObject({
      label: 'Daily [ID REDACTED] [ID REDACTED] review',
      schedule: 'Every hour'
    })

    projection.ingest({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'private-call-list',
        rawOutput: {
          type: 'SchedulerList',
          tasks: [{ id: 'private-listed-task', prompt: 'Listed task', intervalHuman: 'Every day' }]
        }
      }
    })
    const snapshot = projection.getSnapshot()
    expect(snapshot.schedules).toEqual([{
      viewKey: 'schedule-2',
      label: 'Listed task',
      status: 'scheduled',
      schedule: 'Every day',
      fireCount: 0
    }])
    expect(JSON.stringify(snapshot)).not.toContain('private-')
  })

  it('redacts envelope and event identities from every renderer-eligible label', () => {
    const projection = new SessionActivityProjection()
    projection.ingest({
      method: 'x.ai/session_notification',
      params: {
        sessionId: 'private-session-id',
        update: {
          sessionUpdate: 'workflow_updated',
          run_id: 'private-run-id',
          revision: 1,
          name: 'Run private-session-id private-run-id',
          objective: 'Inspect /private/source',
          status: 'active'
        }
      }
    })
    projection.ingest({
      method: 'x.ai/session_notification',
      params: {
        sessionId: 'private-session-id',
        update: {
          sessionUpdate: 'subagent_spawned',
          subagent_id: 'private-subagent-id',
          role: 'Verify private-session-id private-subagent-id'
        }
      }
    })
    const serialized = JSON.stringify(projection.getSnapshot())
    expect(serialized).not.toContain('private-session-id')
    expect(serialized).not.toContain('private-run-id')
    expect(serialized).not.toContain('private-subagent-id')
    expect(serialized).not.toContain('/private/source')
  })

  it('protects only non-terminal background, workflow, and goal work', () => {
    const projection = new SessionActivityProjection()
    projection.ingest(notification({
      sessionUpdate: 'task_backgrounded',
      task_id: 'background-remote-id'
    }))
    expect(projection.hasLiveProtectionWork()).toBe(true)
    projection.ingest(notification({
      sessionUpdate: 'task_completed',
      task_id: 'background-remote-id',
      status: 'completed'
    }))
    expect(projection.hasLiveProtectionWork()).toBe(false)

    projection.ingest(notification({
      sessionUpdate: 'goal_updated',
      goal_id: 'goal-remote-id',
      objective: 'Goal',
      status: 'paused'
    }))
    expect(projection.hasLiveProtectionWork()).toBe(true)
    projection.ingest(notification({
      sessionUpdate: 'goal_updated',
      goal_id: 'goal-remote-id',
      objective: 'Goal',
      status: 'completed'
    }))
    expect(projection.hasLiveProtectionWork()).toBe(false)
  })

  it('does not lose worker protection when active background or workflow maps reach their cap', () => {
    const background = new SessionActivityProjection()
    for (let index = 0; index <= MAX_SESSION_ACTIVITY_ITEMS; index += 1) {
      background.apply({
        type: 'activity_background_update',
        identity: `background-overflow-${index}`,
        kind: 'command',
        label: 'Background work',
        status: 'running'
      })
    }
    for (let index = 0; index < MAX_SESSION_ACTIVITY_ITEMS; index += 1) {
      background.apply({
        type: 'activity_background_update',
        identity: `background-overflow-${index}`,
        kind: 'command',
        label: 'Background work',
        status: 'completed'
      })
    }
    expect(background.getSnapshot().background).toHaveLength(MAX_SESSION_ACTIVITY_ITEMS)
    expect(background.hasLiveProtectionWork()).toBe(true)

    const workflows = new SessionActivityProjection()
    for (let index = 0; index <= MAX_SESSION_ACTIVITY_ITEMS; index += 1) {
      workflows.apply({
        type: 'activity_workflow_update',
        source: 'typed',
        workflow: {
          identity: `workflow-overflow-${index}`,
          revision: '1',
          name: 'Workflow',
          status: 'active'
        }
      })
    }
    for (let index = 0; index < MAX_SESSION_ACTIVITY_ITEMS; index += 1) {
      workflows.apply({
        type: 'activity_workflow_update',
        source: 'typed',
        workflow: {
          identity: `workflow-overflow-${index}`,
          revision: '2',
          name: 'Workflow',
          status: 'cleared'
        }
      })
    }
    expect(workflows.getSnapshot().workflows).toEqual([])
    expect(workflows.hasLiveProtectionWork()).toBe(true)
  })

  it('is immutable, bounded, strict, and keeps sync transitions explicit', () => {
    const original = createSessionActivityProjectionState()
    const next = reduceSessionActivityProjection(original, { type: 'activity_unknown' })
    expect(original.unknownEventCount).toBe(0)
    expect(next.unknownEventCount).toBe(1)

    let bounded = next
    for (let index = 0; index < 10_100; index += 1) {
      bounded = reduceSessionActivityProjection(bounded, { type: 'activity_unknown' })
    }
    expect(bounded.unknownEventCount).toBe(10_000)
    expect(sessionActivitySnapshotSchema.safeParse(sessionActivitySnapshotFromState(bounded)).success).toBe(true)

    const projection = new SessionActivityProjection()
    expect(projection.getSnapshot().syncState).toBe('unseen')
    projection.ingest(notification({
      sessionUpdate: 'scheduled_task_created',
      task_id: 'does-not-promote-live'
    }))
    expect(projection.getSnapshot().syncState).toBe('unseen')
    projection.setSyncState('offline')
    expect(projection.getSnapshot().syncState).toBe('offline')

    expect(sessionActivityUpdateSchema.safeParse({
      type: 'activity_schedule_delete',
      source: 'typed',
      identity: 'ok',
      rawOutput: { path: '/private/must-not-cross' }
    }).success).toBe(false)
  })
})

function notification(update: Record<string, unknown>): unknown {
  return { method: 'x.ai/session_notification', params: { update } }
}
