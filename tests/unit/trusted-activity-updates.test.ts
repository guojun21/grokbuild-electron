import { describe, expect, it } from 'vitest'
import {
  isTrustedOnlySessionUpdate,
  trustedAcpUpdateSchema,
  trustedUpdatesFromSessionNotification,
  trustedUpdatesFromSessionUpdate
} from '../../src/shared/acp/trustedUpdates'

describe('trusted ACP session activity updates', () => {
  it('projects direct and wrapped typed notifications onto the strict trusted path', () => {
    const direct = trustedUpdatesFromSessionNotification({
      sessionId: 'remote-session',
      update: {
        sessionUpdate: 'scheduled_task_created',
        task_id: 'private-task-1',
        prompt: 'Inspect /private/project/secrets.txt',
        human_schedule: 'Every hour',
        _meta: {
          'x.ai/schedulerGeneration': 2,
          'x.ai/schedulerRevision': 3
        }
      }
    })
    expect(direct).toEqual([{
      type: 'activity_schedule_upsert',
      source: 'typed',
      fired: false,
      generation: '2',
      revision: '3',
      schedule: {
        identity: 'private-task-1',
        label: 'Inspect [PATH REDACTED]',
        schedule: 'Every hour'
      }
    }])

    const wrapped = trustedUpdatesFromSessionNotification({
      method: '_x.ai/session/update',
      params: {
        method: '_x.ai/session_notification',
        params: {
          sessionId: 'remote-session',
          update: {
            sessionUpdate: 'workflow_updated',
            run_id: 'private-workflow-1',
            revision: 7,
            name: 'Release',
            status: 'active'
          }
        }
      }
    })
    expect(wrapped).toEqual([{
      type: 'activity_workflow_update',
      source: 'typed',
      workflow: {
        identity: 'private-workflow-1',
        revision: '7',
        name: 'Release',
        status: 'active'
      }
    }])
    expect(direct.every((update) => trustedAcpUpdateSchema.safeParse(update).success)).toBe(true)
    expect(wrapped.every((update) => trustedAcpUpdateSchema.safeParse(update).success)).toBe(true)
  })

  it('keeps live legacy scheduler updates semantic without swallowing their transcript', () => {
    const start = {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'private-call-1',
        rawInput: { prompt: 'Daily review', interval: '1h' },
        _meta: { 'x.ai/tool': { name: 'scheduler_create' } }
      }
    }
    expect(trustedUpdatesFromSessionUpdate(start)).toEqual([{
      type: 'activity_legacy_scheduler_input',
      callIdentity: 'private-call-1',
      operation: 'create',
      label: 'Daily review',
      schedule: '1h'
    }])
    expect(isTrustedOnlySessionUpdate(start)).toBe(false)

    const completed = {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'private-call-1',
        rawOutput: {
          type: 'SchedulerCreate',
          id: 'private-task-1',
          humanSchedule: 'Every hour'
        }
      }
    }
    expect(trustedUpdatesFromSessionUpdate(completed)).toEqual([{
      type: 'activity_schedule_upsert',
      source: 'legacy',
      fired: false,
      callIdentity: 'private-call-1',
      schedule: {
        identity: 'private-task-1',
        label: 'Scheduled task',
        schedule: 'Every hour'
      }
    }])
    expect(isTrustedOnlySessionUpdate(completed)).toBe(false)
  })

  it('suppresses replayed legacy scheduler fallback but retains typed authoritative replay', () => {
    const legacyReplay = {
      _meta: { isReplay: true },
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'private-call-replay',
        rawOutput: {
          type: 'SchedulerList',
          tasks: [{ id: 'private-task-replay', prompt: 'Old replayed task' }]
        }
      }
    }
    expect(trustedUpdatesFromSessionUpdate(legacyReplay)).toEqual([])
    expect(isTrustedOnlySessionUpdate(legacyReplay)).toBe(false)

    const typedReplay = {
      update: {
        sessionUpdate: 'scheduled_task_created',
        task_id: 'private-authoritative-task',
        prompt: 'Restored task',
        _meta: {
          isReplay: true,
          'x.ai/schedulerGeneration': 4,
          'x.ai/schedulerRevision': 1
        }
      }
    }
    expect(trustedUpdatesFromSessionUpdate(typedReplay)).toEqual([{
      type: 'activity_schedule_upsert',
      source: 'typed',
      fired: false,
      generation: '4',
      revision: '1',
      schedule: { identity: 'private-authoritative-task', label: 'Restored task' }
    }])
    expect(isTrustedOnlySessionUpdate(typedReplay)).toBe(true)
  })

  it('counts malformed activity notifications without retaining their payload', () => {
    const canary = 'ACTIVITY_WIRE_CANARY_8F21'
    const events = trustedUpdatesFromSessionNotification({
      sessionId: 'remote-session',
      update: {
        sessionUpdate: 'workflow_future_variant',
        path: `/private/${canary}`,
        credential: canary
      }
    })
    expect(events).toEqual([{ type: 'activity_unknown' }])
    expect(JSON.stringify(events)).not.toContain(canary)
    expect(JSON.stringify(events)).not.toContain('/private/')
  })
})
