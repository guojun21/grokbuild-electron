import { resolve } from 'node:path'
import { join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { AcpClient } from '../../src/main/acp/AcpClient'
import type { PendingInteraction } from '../../src/shared/acp/interactions'

const FORK_SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const FORK_CHILD_ID = '22222222-2222-4222-8222-222222222222'

describe('AcpClient with the deterministic Grok double', () => {
  it('handshakes and streams a full turn', async () => {
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh'
    })
    const updates: unknown[] = []
    const trustedUpdates: unknown[] = []
    const capabilities: unknown[] = []
    client.on('update', (update) => updates.push(update))
    client.on('trustedUpdate', (update) => trustedUpdates.push(update))
    client.on('capabilities', (value) => capabilities.push(value))
    await expect(client.start()).resolves.toEqual({
      sessionId: '00000000-0000-4000-8000-000000000001',
      resumed: false
    })
    expect(capabilities).toEqual([{
      currentModelId: 'grok-4.6',
      availableModels: [
        { id: 'grok-4.6', name: 'Grok 4.6', contextLimit: 500_000 },
        { id: 'grok-composer-2.5-fast', name: 'Composer Fast', contextLimit: 500_000 }
      ],
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Agent' },
        { id: 'plan', name: 'Plan' },
        { id: 'ask', name: 'Ask' }
      ]
    }])
    await expect(client.prompt('Run the QA contract')).resolves.toBeUndefined()
    expect(updates).toHaveLength(6)
    expect(JSON.stringify(updates)).toContain('GROKBUILD_QA_OK')
    expect(trustedUpdates).toEqual([
      { type: 'hook_execution', hook: 'user_prompt_submit', runCount: 1 },
      { type: 'hook_execution', hook: 'pre_tool_use', runCount: 1 },
      { type: 'hook_execution', hook: 'post_tool_use', runCount: 1 },
      { type: 'hook_execution', hook: 'stop', runCount: 3 },
      { type: 'context_usage', used: 28_000, limit: 500_000 },
      {
        type: 'turn_usage',
        usage: {
          inputTokens: 11_954,
          outputTokens: 36,
          cachedReadTokens: 7_639,
          reasoningTokens: 0,
          totalTokens: 11_990
        }
      }
    ])
    expect(JSON.stringify(trustedUpdates)).not.toContain('QA_USAGE_SECRET_CANARY_73D2')
    expect(JSON.stringify(trustedUpdates)).not.toContain('QA_HOOK_SECRET_CANARY_2E77')
    expect(JSON.stringify(trustedUpdates)).not.toContain('/private/')
    await client.stop()
  })

  it('projects prompt results, session metadata, and both xAI notification dialects', async () => {
    const client = createClient()
    const trustedUpdates: unknown[] = []
    client.on('trustedUpdate', (update) => trustedUpdates.push(update))
    await client.start()
    await expect(client.prompt('exercise usage sources please')).resolves.toBeUndefined()

    expect(trustedUpdates).toEqual([
      { type: 'context_usage', used: 32_100 },
      {
        type: 'turn_usage',
        usage: {
          inputTokens: 1_500,
          outputTokens: 200,
          cachedReadTokens: 1_000,
          reasoningTokens: 75
        }
      },
      {
        type: 'turn_usage',
        usage: { inputTokens: 120, outputTokens: 9, cachedReadTokens: 40 }
      },
      {
        type: 'turn_usage',
        usage: {
          inputTokens: 200,
          outputTokens: 7,
          cachedReadTokens: 50,
          reasoningTokens: 3
        }
      }
    ])
    const serialized = JSON.stringify(trustedUpdates)
    expect(serialized).not.toContain('QA_USAGE_SECRET_CANARY_73D2')
    expect(serialized).not.toContain('/private/')
    await client.stop()
  })

  it('projects authoritative current_mode_update across wrapped and direct protocols', async () => {
    const client = createClient()
    const updates: unknown[] = []
    const trustedUpdates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    client.on('trustedUpdate', (update) => trustedUpdates.push(update))
    await client.start()
    await expect(client.prompt('exercise mode update please')).resolves.toBeUndefined()

    expect(trustedUpdates.slice(0, 2)).toEqual([
      { type: 'mode_changed', mode: 'default', permissionMode: 'auto' },
      { type: 'mode_changed', mode: 'plan' }
    ])
    expect(JSON.stringify(updates)).not.toContain('current_mode_update')
    await client.stop()
  })

  it('filters replayed mode and hook notifications while retaining typed activity replay', async () => {
    const client = createClient()
    const trustedUpdates: unknown[] = []
    client.on('trustedUpdate', (update) => trustedUpdates.push(update))
    await client.start()

    const inject = (frame: unknown): void => {
      (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify(frame))
    }
    const activeSessionId = '00000000-0000-4000-8000-000000000001'
    inject({
      jsonrpc: '2.0',
      method: 'x.ai/session_notification',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: 'plan',
          _meta: { isReplay: true }
        }
      }
    })
    inject({
      jsonrpc: '2.0',
      method: '_x.ai/session_notification',
      params: {
        method: 'x.ai/session_notification',
        params: {
          sessionId: activeSessionId,
          _meta: { isReplay: true },
          update: {
            sessionUpdate: 'hook_execution',
            event_name: 'UserPromptSubmit',
            runs: [{}]
          }
        }
      }
    })
    inject({
      jsonrpc: '2.0',
      method: 'x.ai/session_notification',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'scheduled_task_created',
          task_id: 'replayed-current-task',
          prompt: 'Restored task',
          _meta: {
            isReplay: true,
            'x.ai/schedulerGeneration': 1,
            'x.ai/schedulerRevision': 1
          }
        }
      }
    })

    expect(trustedUpdates).toEqual([{
      type: 'activity_schedule_upsert',
      source: 'typed',
      fired: false,
      generation: '1',
      revision: '1',
      schedule: { identity: 'replayed-current-task', label: 'Restored task' }
    }])
    await client.stop()
  })

  it('drops raw, trusted, and wrapped updates for a different ACP session', async () => {
    const client = createClient()
    const updates: unknown[] = []
    const trustedUpdates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    client.on('trustedUpdate', (update) => trustedUpdates.push(update))
    await client.start()

    const inject = (frame: unknown): void => {
      (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify(frame))
    }
    const wrongSessionId = '99999999-9999-4999-8999-999999999999'
    inject({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: wrongSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'WRONG_SESSION_RAW_CANARY' }
        }
      }
    })
    inject({
      jsonrpc: '2.0',
      method: '_x.ai/session/update',
      params: {
        method: 'x.ai/session/update',
        params: {
          sessionId: wrongSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'WRONG_WRAPPED_SESSION_CANARY' }
          }
        }
      }
    })
    inject({
      jsonrpc: '2.0',
      method: 'x.ai/session_notification',
      params: {
        sessionId: wrongSessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'yolo' }
      }
    })
    inject({
      jsonrpc: '2.0',
      method: '_x.ai/session_notification',
      params: {
        method: 'x.ai/session_notification',
        params: {
          sessionId: wrongSessionId,
          update: {
            sessionUpdate: 'turn_completed',
            usage: { prompt_tokens: 999, completion_tokens: 999 }
          }
        }
      }
    })
    expect(updates).toEqual([])
    expect(trustedUpdates).toEqual([])

    const activeSessionId = '00000000-0000-4000-8000-000000000001'
    inject({
      jsonrpc: '2.0',
      method: 'x.ai/session_notification',
      params: {
        sessionId: activeSessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }
      }
    })
    inject({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Accepted current-session update.' }
        }
      }
    })
    inject({
      jsonrpc: '2.0',
      method: '_x.ai/session/update',
      params: {
        method: 'x.ai/session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Accepted wrapped current-session update.' }
          }
        }
      }
    })
    expect(trustedUpdates).toEqual([{ type: 'mode_changed', mode: 'plan' }])
    expect(JSON.stringify(updates)).toContain('Accepted current-session update.')
    expect(JSON.stringify(updates)).toContain('Accepted wrapped current-session update.')
    expect(JSON.stringify(updates)).not.toContain('WRONG_SESSION_RAW_CANARY')
    expect(JSON.stringify(updates)).not.toContain('WRONG_WRAPPED_SESSION_CANARY')
    await client.stop()
  })

  it('routes only current-session activity through the strict trusted path', async () => {
    const client = createClient()
    const updates: unknown[] = []
    const trustedUpdates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    client.on('trustedUpdate', (update) => trustedUpdates.push(update))
    await client.start()

    const inject = (frame: unknown): void => {
      (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify(frame))
    }
    const activeSessionId = '00000000-0000-4000-8000-000000000001'
    const wrongSessionId = '99999999-9999-4999-8999-999999999999'
    inject({
      jsonrpc: '2.0',
      method: 'x.ai/session_notification',
      params: {
        sessionId: wrongSessionId,
        update: {
          sessionUpdate: 'scheduled_task_created',
          task_id: 'wrong-session-task',
          prompt: 'WRONG_SESSION_ACTIVITY_CANARY'
        }
      }
    })
    inject({
      jsonrpc: '2.0',
      method: '_x.ai/session/update',
      params: {
        method: '_x.ai/session_notification',
        params: {
          sessionId: wrongSessionId,
          update: {
            sessionUpdate: 'workflow_updated',
            run_id: 'wrong-session-workflow',
            revision: 1,
            name: 'WRONG_WRAPPED_ACTIVITY_CANARY',
            status: 'active'
          }
        }
      }
    })
    expect(updates).toEqual([])
    expect(trustedUpdates).toEqual([])

    inject({
      jsonrpc: '2.0',
      method: 'x.ai/session_notification',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'scheduled_task_created',
          task_id: 'current-task',
          prompt: 'Review build',
          _meta: {
            'x.ai/schedulerGeneration': 1,
            'x.ai/schedulerRevision': 1
          }
        }
      }
    })
    inject({
      jsonrpc: '2.0',
      method: '_x.ai/session/update',
      params: {
        method: '_x.ai/session_notification',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'goal_updated',
            goal_id: 'current-goal',
            objective: 'Ship build',
            status: 'active',
            token_budget: 1_000
          }
        }
      }
    })
    inject({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'current-call',
          title: 'Create scheduled task',
          rawInput: { prompt: 'Daily review', interval: '1d' },
          _meta: { 'x.ai/tool': { name: 'scheduler_create' } }
        }
      }
    })

    expect(trustedUpdates).toEqual([
      {
        type: 'activity_schedule_upsert',
        source: 'typed',
        fired: false,
        generation: '1',
        revision: '1',
        schedule: { identity: 'current-task', label: 'Review build' }
      },
      {
        type: 'activity_goal_update',
        goal: {
          identity: 'current-goal',
          objective: 'Ship build',
          status: 'active',
          tokenBudget: 1_000
        }
      },
      {
        type: 'activity_legacy_scheduler_input',
        callIdentity: 'current-call',
        operation: 'create',
        label: 'Daily review',
        schedule: '1d'
      }
    ])
    expect(updates).toHaveLength(1)
    expect(JSON.stringify(updates)).toContain('Create scheduled task')
    expect(JSON.stringify(trustedUpdates)).not.toContain('WRONG_SESSION_ACTIVITY_CANARY')
    expect(JSON.stringify(trustedUpdates)).not.toContain('WRONG_WRAPPED_ACTIVITY_CANARY')
    await client.stop()
  })

  it('sends validated multimodal content blocks to session/prompt unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-multimodal-integration-'))
    const transcript = join(root, 'transcript.ndjson')
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: root,
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      env: { GROKBUILD_MOCK_TRANSCRIPT: transcript }
    })
    const blocks = [
      { type: 'text' as const, text: 'Run the multimodal contract' },
      {
        type: 'image' as const,
        data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
        mimeType: 'image/png' as const
      }
    ]
    try {
      await expect(client.prompt(blocks)).resolves.toBeUndefined()
      const frames = (await readFile(transcript, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as {
          direction: string
          frame: { method?: string; params?: { prompt?: unknown } }
        })
      const prompt = frames.find(({ direction, frame }) =>
        direction === 'client->agent' && frame.method === 'session/prompt'
      )
      expect(prompt?.frame.params?.prompt).toEqual(blocks)
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('round-trips a permission choice without exposing raw JSON-RPC to the UI layer', async () => {
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh'
    })
    const permission = new Promise<string>((resolvePermission) => {
      client.once('permission', (request) => {
        resolvePermission(request.title)
        void client.answerPermission(request.requestId, 'allow_once')
      })
    })
    await client.start()
    const prompt = client.prompt('permission please')
    await expect(permission).resolves.toBe('Allow writing qa-result.txt?')
    await expect(prompt).resolves.toBeUndefined()
    await client.stop()
  })

  it('serves the complete reverse terminal lifecycle inside the ACP worker boundary', async () => {
    const client = createClient()
    const updates: unknown[] = []
    client.on('update', (update) => updates.push(update))

    await client.start()
    await expect(client.prompt('Run the terminal host QA contract')).resolves.toBeUndefined()
    expect(JSON.stringify(updates)).toContain('Terminal host returned TERMINAL_HOST_QA_OK.')
    await client.stop()
  })

  it('confines and serves reverse filesystem reads and writes for the active workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-fs-integration-'))
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: root,
      model: 'grok-4.6',
      reasoningEffort: 'xhigh'
    })
    const updates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    try {
      await client.start()
      await expect(client.prompt('Run the filesystem host QA contract')).resolves.toBeUndefined()
      expect(JSON.stringify(updates)).toContain('Filesystem host returned FILESYSTEM_HOST_QA_OK.')
      await expect(readFile(join(root, 'grokbuild-fs-host-qa.txt'), 'utf8'))
        .resolves.toBe('FILESYSTEM_HOST_QA_OK')
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes a direct underscored plan request and returns the official approved outcome', async () => {
    const client = createClient()
    const updates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    const interaction = nextInteraction(client)
    await client.start()
    const prompt = client.prompt('plan approve please')
    const request = await interaction
    expect(request).toMatchObject({ kind: 'plan', planContent: expect.stringContaining('# QA plan') })
    expect(request.interactionId).not.toBe('qa-plan-1')
    expect(request).not.toHaveProperty('rpcId')
    await client.answerInteraction(request.interactionId, { kind: 'plan', decision: 'approved' })
    await expect(client.answerInteraction(request.interactionId, { kind: 'plan', decision: 'approved' }))
      .rejects.toThrow('no longer active')
    await expect(prompt).resolves.toBeUndefined()
    expect(JSON.stringify(updates)).toContain('Plan resolved: approved.')
    await client.stop()
  })

  it('unwraps a leader-routed plan request and returns cancelled feedback as a result', async () => {
    const client = createClient()
    const updates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    const interaction = nextInteraction(client)
    await client.start()
    const prompt = client.prompt('plan changes please')
    const request = await interaction
    await client.answerInteraction(request.interactionId, {
      kind: 'plan',
      decision: 'cancelled',
      feedback: 'Add rollback coverage'
    })
    await expect(prompt).resolves.toBeUndefined()
    expect(JSON.stringify(updates)).toContain('Plan resolved: cancelled (Add rollback coverage).')
    await client.stop()
  })

  it('returns the official abandoned plan outcome', async () => {
    const client = createClient()
    const updates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    const interaction = nextInteraction(client)
    await client.start()
    const prompt = client.prompt('plan abandon please')
    const request = await interaction
    await client.answerInteraction(request.interactionId, {
      kind: 'plan',
      decision: 'abandoned'
    })
    await expect(prompt).resolves.toBeUndefined()
    expect(JSON.stringify(updates)).toContain('Plan resolved: abandoned.')
    await client.stop()
  })

  it('maps fixed and Other question answers to string arrays and annotations', async () => {
    const fixed = createClient()
    const fixedUpdates: unknown[] = []
    fixed.on('update', (update) => fixedUpdates.push(update))
    const fixedInteraction = nextInteraction(fixed)
    await fixed.start()
    const fixedPrompt = fixed.prompt('question choice please')
    const fixedRequest = await fixedInteraction
    if (fixedRequest.kind !== 'question') throw new Error('Expected a question')
    const question = fixedRequest.questions[0]
    const option = question?.options[0]
    if (!question || !option) throw new Error('Expected a question option')
    await fixed.answerInteraction(fixedRequest.interactionId, {
      kind: 'question',
      action: 'accepted',
      answers: [{ questionId: question.id, optionIds: [option.id] }]
    })
    await expect(fixedPrompt).resolves.toBeUndefined()
    expect(JSON.stringify(fixedUpdates)).toContain('\\"answers\\":{\\"Which implementation should Grok use?\\":[\\"React\\"]}')
    expect(JSON.stringify(fixedUpdates)).toContain('\\"preview\\":\\"<ReactPreview />\\"')
    await fixed.stop()

    const other = createClient()
    const otherUpdates: unknown[] = []
    other.on('update', (update) => otherUpdates.push(update))
    const otherInteraction = nextInteraction(other)
    await other.start()
    const otherPrompt = other.prompt('question other please')
    const otherRequest = await otherInteraction
    if (otherRequest.kind !== 'question') throw new Error('Expected a question')
    const otherQuestion = otherRequest.questions[0]
    if (!otherQuestion) throw new Error('Expected a question')
    await other.answerInteraction(otherRequest.interactionId, {
      kind: 'question',
      action: 'accepted',
      answers: [{
        questionId: otherQuestion.id,
        optionIds: [otherQuestion.otherOptionId],
        otherText: 'Use SolidJS'
      }]
    })
    await expect(otherPrompt).resolves.toBeUndefined()
    expect(JSON.stringify(otherUpdates)).toContain('\\"answers\\":{\\"Which implementation should Grok use?\\":[\\"Other\\"]}')
    expect(JSON.stringify(otherUpdates)).toContain('\\"notes\\":\\"Use SolidJS\\"')
    await other.stop()
  })

  it('keeps fixed labels and freeform notes when multi-select includes Other', async () => {
    const client = createClient()
    const updates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    const interaction = nextInteraction(client)
    await client.start()
    const prompt = client.prompt('question plan please')
    const request = await interaction
    if (request.kind !== 'question') throw new Error('Expected a question')
    const checks = request.questions[1]
    if (!checks || !checks.multiSelect) throw new Error('Expected a multi-select question')

    await client.answerInteraction(request.interactionId, {
      kind: 'question',
      action: 'accepted',
      answers: [{
        questionId: checks.id,
        optionIds: [...checks.options.map((option) => option.id), checks.otherOptionId],
        otherText: 'Also run the smoke suite'
      }]
    })
    await expect(prompt).resolves.toBeUndefined()
    expect(JSON.stringify(updates)).toContain(
      '\\"answers\\":{\\"Which checks should Grok run?\\":[\\"Tests\\",\\"Lint\\"]},\\"annotations\\":{\\"Which checks should Grok run?\\":{\\"notes\\":\\"Also run the smoke suite\\"}}'
    )
    await client.stop()
  })

  it('still rejects mixing a fixed option with Other for single-select questions', async () => {
    const client = createClient()
    const interaction = nextInteraction(client)
    await client.start()
    const prompt = client.prompt('question choice please')
    const request = await interaction
    if (request.kind !== 'question') throw new Error('Expected a question')
    const question = request.questions[0]
    const option = question?.options[0]
    if (!question || !option) throw new Error('Expected a single-select question')

    await expect(client.answerInteraction(request.interactionId, {
      kind: 'question',
      action: 'accepted',
      answers: [{
        questionId: question.id,
        optionIds: [option.id, question.otherOptionId],
        otherText: 'And a custom choice'
      }]
    })).rejects.toThrow('Other cannot be combined with a fixed option')
    client.cancel()
    await expect(prompt).resolves.toBeUndefined()
    await client.stop()
  })

  it('keeps plan partial answers label-only when multi-select also includes Other', async () => {
    const client = createClient()
    const updates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    const interaction = nextInteraction(client)
    await client.start()
    const prompt = client.prompt('question plan please')
    const request = await interaction
    if (request.kind !== 'question') throw new Error('Expected a question')
    const checks = request.questions[1]
    if (!checks || !checks.multiSelect) throw new Error('Expected a multi-select question')

    await client.answerInteraction(request.interactionId, {
      kind: 'question',
      action: 'chat_about_this',
      answers: [{
        questionId: checks.id,
        optionIds: [...checks.options.map((option) => option.id), checks.otherOptionId],
        otherText: 'Also run the smoke suite'
      }]
    })
    await expect(prompt).resolves.toBeUndefined()
    const serialized = JSON.stringify(updates)
    expect(serialized).toContain(
      '\\"outcome\\":\\"chat_about_this\\",\\"partial_answers\\":{\\"Which checks should Grok run?\\":\\"Tests, Lint\\"}'
    )
    expect(serialized).not.toContain('Also run the smoke suite')
    await client.stop()
  })

  it('defaults a missing question mode to default for compatibility', async () => {
    const client = createClient()
    const interaction = nextInteraction(client)
    await client.start()
    const prompt = client.prompt('question default please')
    const request = await interaction
    expect(request).toMatchObject({ kind: 'question', mode: 'default' })
    client.cancel()
    await expect(prompt).resolves.toBeUndefined()
    await client.stop()
  })

  it('accepts a partial interview and omits unanswered questions from the wire result', async () => {
    const client = createClient()
    const updates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    const interaction = nextInteraction(client)
    await client.start()
    const prompt = client.prompt('question plan please')
    const request = await interaction
    if (request.kind !== 'question') throw new Error('Expected a question')
    const first = request.questions[0]
    const react = first?.options[0]
    if (!first || !react) throw new Error('Expected the first question')

    await client.answerInteraction(request.interactionId, {
      kind: 'question',
      action: 'accepted',
      answers: [{ questionId: first.id, optionIds: [react.id] }]
    })
    await expect(prompt).resolves.toBeUndefined()
    const serialized = JSON.stringify(updates)
    expect(serialized).toContain('\\"Which implementation should Grok use?\\":[\\"React\\"]')
    expect(serialized).not.toContain('\\"Which checks should Grok run?\\":')
    await client.stop()
  })

  it('serializes plan interview actions with pager-compatible partial answer strings', async () => {
    const chat = createClient()
    const chatUpdates: unknown[] = []
    chat.on('update', (update) => chatUpdates.push(update))
    const chatInteraction = nextInteraction(chat)
    await chat.start()
    const chatPrompt = chat.prompt('question plan please')
    const chatRequest = await chatInteraction
    if (chatRequest.kind !== 'question') throw new Error('Expected a question')
    const implementation = chatRequest.questions[0]
    const checks = chatRequest.questions[1]
    if (!implementation || !checks) throw new Error('Expected two questions')
    await chat.answerInteraction(chatRequest.interactionId, {
      kind: 'question',
      action: 'chat_about_this',
      answers: [
        { questionId: implementation.id, optionIds: [implementation.options[0]!.id] },
        { questionId: checks.id, optionIds: checks.options.map((option) => option.id) }
      ]
    })
    await expect(chatPrompt).resolves.toBeUndefined()
    expect(JSON.stringify(chatUpdates)).toContain(
      '\\"outcome\\":\\"chat_about_this\\",\\"partial_answers\\":{\\"Which implementation should Grok use?\\":\\"React\\",\\"Which checks should Grok run?\\":\\"Tests, Lint\\"}'
    )
    await chat.stop()

    const skip = createClient()
    const skipUpdates: unknown[] = []
    skip.on('update', (update) => skipUpdates.push(update))
    const skipInteraction = nextInteraction(skip)
    await skip.start()
    const skipPrompt = skip.prompt('question plan please')
    const skipRequest = await skipInteraction
    if (skipRequest.kind !== 'question') throw new Error('Expected a question')
    const first = skipRequest.questions[0]
    if (!first) throw new Error('Expected a question')
    await skip.answerInteraction(skipRequest.interactionId, {
      kind: 'question',
      action: 'skip_interview',
      answers: [{
        questionId: first.id,
        optionIds: [first.otherOptionId],
        otherText: 'Discuss a custom framework'
      }]
    })
    await expect(skipPrompt).resolves.toBeUndefined()
    expect(JSON.stringify(skipUpdates)).toContain(
      '\\"outcome\\":\\"skip_interview\\",\\"partial_answers\\":{\\"Which implementation should Grok use?\\":\\"Other\\"}'
    )
    expect(JSON.stringify(skipUpdates)).not.toContain('Discuss a custom framework')
    await skip.stop()
  })

  it.each(['direct', 'underscored', 'wrapped'] as const)(
    'normalizes %s interaction_resolved and makes the remote answer win exactly once',
    async (style) => {
      const client = createClient()
      const interaction = nextInteraction(client)
      const resolution = new Promise<{ interactionId: string }>((resolveResolution) => {
        client.once('interactionResolved', resolveResolution)
      })
      await client.start()
      const prompt = client.prompt('question remote ' + style + ' please')
      const request = await interaction
      const resolved = await resolution
      expect(resolved).toEqual({ interactionId: request.interactionId })
      expect(resolved).not.toHaveProperty('toolCallId')
      await expect(client.answerInteraction(request.interactionId, {
        kind: 'question',
        action: 'cancelled'
      })).rejects.toThrow('no longer active')
      await expect(prompt).resolves.toBeUndefined()
      await client.stop()
    }
  )

  it('resolves every pending interaction as cancelled before cancelling the turn', async () => {
    const client = createClient()
    const updates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    const interaction = nextInteraction(client)
    await client.start()
    const prompt = client.prompt('question cancel please')
    await interaction
    client.cancel()
    await expect(prompt).resolves.toBeUndefined()
    expect(JSON.stringify(updates)).toContain('Question resolved: {\\"outcome\\":\\"cancelled\\"}.')
    await client.stop()
  })

  it('disconnects without resolving a pending interaction or cancelling the remote turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-stop-contract-'))
    const transcriptPath = join(root, 'rpc.ndjson')
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      env: { GROKBUILD_MOCK_TRANSCRIPT: transcriptPath }
    })
    try {
      const interaction = nextInteraction(client)
      await client.start()
      const promptResult = client.prompt('question choice please').catch((error: unknown) => error)
      await interaction
      await client.stop()
      expect(await promptResult).toBeInstanceOf(Error)

      const entries = (await readFile(transcriptPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { direction: string; frame: { id?: string; method?: string; result?: unknown } })
        .filter((entry) => entry.direction === 'client->agent')
      expect(entries.some((entry) => entry.frame.id === 'qa-question-1' && entry.frame.result)).toBe(false)
      expect(entries.some((entry) => entry.frame.method === 'session/cancel')).toBe(false)
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forks through the canonical extension, then loads only the requested child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-fork-contract-'))
    const transcriptPath = join(root, 'rpc.ndjson')
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: root,
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      forkSession: {
        sourceSessionId: FORK_SOURCE_ID,
        newSessionId: FORK_CHILD_ID,
        newModelId: 'grok-4.6'
      },
      env: { GROKBUILD_MOCK_TRANSCRIPT: transcriptPath }
    })
    try {
      await expect(client.start()).resolves.toEqual({
        sessionId: FORK_CHILD_ID,
        resumed: false,
        forkedFrom: FORK_SOURCE_ID
      })
      const entries = await readRpcTranscript(transcriptPath)
      const processEntry = entries.find((entry) => entry.direction === 'process')
      expect(processEntry?.frame.argv).toEqual([
        '--no-memory',
        'agent',
        '--reasoning-effort',
        'xhigh',
        '--model',
        'grok-4.6',
        'stdio'
      ])
      const requests = entries.filter((entry) => entry.direction === 'client->agent' && entry.frame.method)
      expect(requests.map((entry) => entry.frame.method)).toEqual([
        'initialize',
        'x.ai/session/fork',
        'session/load'
      ])
      expect(requests[1]?.frame.params).toEqual({
        sourceSessionId: FORK_SOURCE_ID,
        sourceCwd: root,
        newCwd: root,
        newSessionId: FORK_CHILD_ID,
        newModelId: 'grok-4.6',
        sessionKind: 'fork'
      })
      expect(requests[2]?.frame.params).toEqual({
        sessionId: FORK_CHILD_ID,
        cwd: root,
        mcpServers: [],
        _meta: { noReplay: true }
      })
      expect(JSON.stringify(entries)).not.toContain('--fork-session')
      expect(JSON.stringify(entries)).not.toContain('--session-id')
      expect(requests.some((entry) => entry.frame.method === 'session/new')).toBe(false)
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('selects exactly one CLI memory compatibility flag per worker launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-memory-launch-'))
    const transcriptPath = join(root, 'rpc.ndjson')
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: root,
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      memoryEnabled: true,
      env: { GROKBUILD_MOCK_TRANSCRIPT: transcriptPath }
    })
    try {
      await client.start()
      const entries = await readRpcTranscript(transcriptPath)
      const processEntry = entries.find((entry) => entry.direction === 'process')
      expect(processEntry?.frame.argv).toEqual([
        '--experimental-memory',
        'agent',
        '--reasoning-effort',
        'xhigh',
        '--model',
        'grok-4.6',
        'stdio'
      ])
      expect(processEntry?.frame.argv).not.toContain('--no-memory')
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts the single nested result wrapper used by compatible fork transports', async () => {
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      forkSession: {
        sourceSessionId: FORK_SOURCE_ID,
        newSessionId: FORK_CHILD_ID
      },
      env: { GROKBUILD_MOCK_PROFILE: 'fork-nested-response' }
    })
    await expect(client.start()).resolves.toEqual({
      sessionId: FORK_CHILD_ID,
      resumed: false,
      forkedFrom: FORK_SOURCE_ID
    })
    await client.stop()
  })

  it.each([
    ['fork-method-not-found', ['initialize', 'x.ai/session/fork']],
    ['fork-wrong-id', ['initialize', 'x.ai/session/fork']],
    ['fork-load-failure', ['initialize', 'x.ai/session/fork', 'session/load']]
  ] as const)('fails closed for %s without creating a fallback session', async (profile, expectedMethods) => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-fork-failure-'))
    const transcriptPath = join(root, 'rpc.ndjson')
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: root,
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      forkSession: {
        sourceSessionId: FORK_SOURCE_ID,
        newSessionId: FORK_CHILD_ID
      },
      env: {
        GROKBUILD_MOCK_PROFILE: profile,
        GROKBUILD_MOCK_TRANSCRIPT: transcriptPath
      }
    })
    try {
      let failure: unknown
      try {
        await client.start()
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe('Grok reported an unexpected error. Retry the request.')
      expect((failure as Error).message).not.toContain('QA_FORK_SECRET_CANARY_61C4')
      expect((failure as Error).message).not.toContain('/private/')
      const requests = (await readRpcTranscript(transcriptPath))
        .filter((entry) => entry.direction === 'client->agent' && entry.frame.method)
      expect(requests.map((entry) => entry.frame.method)).toEqual(expectedMethods)
      expect(requests.some((entry) => entry.frame.method === 'session/new')).toBe(false)
      expect((client as unknown as { process?: unknown }).process).toBeUndefined()
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads a persisted ACP session and suppresses replayed transcript events', async () => {
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      resumeSessionId: 'persisted-session',
      env: { GROKBUILD_MOCK_LOAD_MODE: 'ok' }
    })
    const updates: unknown[] = []
    const trustedUpdates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    client.on('trustedUpdate', (update) => trustedUpdates.push(update))

    await expect(client.start()).resolves.toEqual({
      sessionId: 'persisted-session',
      resumed: true
    })
    expect(JSON.stringify(updates)).not.toContain('REPLAY_MUST_NOT_RENDER')
    expect(trustedUpdates).toContainEqual({
      type: 'context_usage', used: 28_000, limit: 500_000
    })
    await client.stop()
  })

  it('falls back to a fresh session only for an explicitly stale persisted session', async () => {
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      resumeSessionId: 'stale-session',
      env: { GROKBUILD_MOCK_LOAD_MODE: 'stale' }
    })

    await expect(client.start()).resolves.toEqual({
      sessionId: '00000000-0000-4000-8000-000000000001',
      resumed: false,
      staleFallbackFrom: 'stale-session'
    })
    await client.stop()
  })

  it('drops late updates from a stale session while creating its replacement', async () => {
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      resumeSessionId: 'stale-session',
      env: { GROKBUILD_MOCK_LOAD_MODE: 'stale-race' }
    })
    const updates: unknown[] = []
    const trustedUpdates: unknown[] = []
    client.on('update', (update) => updates.push(update))
    client.on('trustedUpdate', (update) => trustedUpdates.push(update))

    await expect(client.start()).resolves.toEqual({
      sessionId: '00000000-0000-4000-8000-000000000001',
      resumed: false,
      staleFallbackFrom: 'stale-session'
    })
    expect(JSON.stringify(updates)).not.toContain('STALE_SESSION_RACE_CANARY')
    expect(trustedUpdates).toEqual([])
    expect((client as unknown as { expectedAcpSessionId?: string }).expectedAcpSessionId)
      .toBe('00000000-0000-4000-8000-000000000001')
    await client.stop()
  })

  it('rejects stale permission and interaction requests until the replacement session is bound', () => {
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      resumeSessionId: 'stale-session'
    })
    const permissions: unknown[] = []
    const interactions: PendingInteraction[] = []
    const writes: Array<Record<string, unknown>> = []
    client.on('permission', (request) => permissions.push(request))
    client.on('interaction', (request) => interactions.push(request))

    const internals = client as unknown as {
      acpSessionId: string | undefined
      expectedAcpSessionId: string | undefined
      handleLine(line: string): void
      write(payload: string): void
    }
    internals.write = (payload) => {
      writes.push(JSON.parse(payload) as Record<string, unknown>)
    }
    // This is the stale load -> session/new gap: the old expectation has been
    // explicitly cleared and must never be recovered from constructor options.
    internals.acpSessionId = undefined
    internals.expectedAcpSessionId = undefined

    const inject = (frame: unknown): void => internals.handleLine(JSON.stringify(frame))
    inject(permissionRequest('stale-permission', 'stale-session', 'STALE_PERMISSION_CANARY'))
    inject(questionRequest('stale-question', 'stale-session', true, 'STALE_QUESTION_CANARY'))
    inject({
      jsonrpc: '2.0',
      id: 'stale-plan',
      method: '_x.ai/exit_plan_mode',
      params: {
        sessionId: 'stale-session',
        toolCallId: 'stale-plan',
        planContent: 'STALE_PLAN_CANARY'
      }
    })

    expect(permissions).toEqual([])
    expect(interactions).toEqual([])
    expect(writes).toHaveLength(3)
    expect(writes.every((response) =>
      (response.error as { code?: number } | undefined)?.code === -32602
    )).toBe(true)
    expect(JSON.stringify(writes)).not.toContain('STALE_PERMISSION_CANARY')
    expect(JSON.stringify(writes)).not.toContain('STALE_QUESTION_CANARY')
    expect(JSON.stringify(writes)).not.toContain('STALE_PLAN_CANARY')

    internals.expectedAcpSessionId = 'replacement-session'
    inject(permissionRequest('replacement-permission', 'replacement-session', 'Allow replacement?'))
    inject(questionRequest('replacement-question', 'replacement-session', true, 'Replacement question?'))
    expect(permissions).toHaveLength(1)
    expect(interactions).toHaveLength(1)
    expect(interactions[0]).toMatchObject({
      kind: 'question',
      sessionId: 'replacement-session'
    })

    internals.acpSessionId = 'replacement-session'
    internals.expectedAcpSessionId = 'replacement-session'
    inject({
      jsonrpc: '2.0',
      id: 'replacement-plan',
      method: '_x.ai/exit_plan_mode',
      params: {
        method: 'x.ai/exit_plan_mode',
        params: {
          sessionId: 'replacement-session',
          toolCallId: 'replacement-plan',
          planContent: '# Replacement plan'
        }
      }
    })
    expect(interactions).toHaveLength(2)
    expect(interactions[1]).toMatchObject({
      kind: 'plan',
      sessionId: 'replacement-session',
      planContent: '# Replacement plan'
    })
    expect(writes).toHaveLength(3)
  })

  it('never creates a replacement session when strict history restore is stale', async () => {
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      resumeSessionId: 'stale-history-session',
      allowStaleFallback: false,
      env: { GROKBUILD_MOCK_LOAD_MODE: 'stale' }
    })

    await expect(client.start()).rejects.toThrow()
    await client.stop()
  })

  it('does not silently create a new session after a non-stale load failure', async () => {
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      resumeSessionId: 'protected-session',
      env: { GROKBUILD_MOCK_LOAD_MODE: 'fatal' }
    })

    await expect(client.start()).rejects.toThrow('Grok authentication failed. Sign in again and retry.')
    await client.stop()
  })

  it('reaps the child without reporting intentional initialization cleanup as a crash', async () => {
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      env: { GROKBUILD_MOCK_FAIL_INITIALIZE: '1' }
    })
    let exitEvents = 0
    client.on('exit', () => { exitEvents += 1 })

    await expect(client.start()).rejects.toThrow('Grok reported an unexpected error. Retry the request.')
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    expect(exitEvents).toBe(0)
    expect((client as unknown as { process?: unknown }).process).toBeUndefined()
    await client.stop()
  })

  it('writes the exact inline primary-agent profile on new, resume, stale fallback, and fork load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grokbuild-agent-profile-wire-'))
    const profile = {
      name: 'security_reviewer',
      description: 'Reviews trust boundaries.',
      promptBody: 'Inspect the requested boundary and report concrete findings.'
    }
    const base = {
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: root,
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      agentProfile: profile
    } as const
    const clients: AcpClient[] = []
    try {
      const newTranscript = join(root, 'new.ndjson')
      const newClient = new AcpClient({
        ...base,
        env: { GROKBUILD_MOCK_TRANSCRIPT: newTranscript }
      })
      clients.push(newClient)
      await newClient.start()
      expect((await readRpcTranscript(newTranscript)).find((entry) =>
        entry.frame.method === 'session/new'
      )?.frame.params).toEqual({
        cwd: root,
        mcpServers: [],
        _meta: { agentProfile: profile }
      })

      const resumeTranscript = join(root, 'resume.ndjson')
      const resumeClient = new AcpClient({
        ...base,
        resumeSessionId: 'persisted-session',
        env: {
          GROKBUILD_MOCK_TRANSCRIPT: resumeTranscript,
          GROKBUILD_MOCK_LOAD_MODE: 'ok'
        }
      })
      clients.push(resumeClient)
      await resumeClient.start()
      expect((await readRpcTranscript(resumeTranscript)).find((entry) =>
        entry.frame.method === 'session/load'
      )?.frame.params).toEqual({
        sessionId: 'persisted-session',
        cwd: root,
        mcpServers: [],
        _meta: { agentProfile: profile }
      })

      const staleTranscript = join(root, 'stale.ndjson')
      const staleClient = new AcpClient({
        ...base,
        resumeSessionId: 'stale-session',
        env: {
          GROKBUILD_MOCK_TRANSCRIPT: staleTranscript,
          GROKBUILD_MOCK_LOAD_MODE: 'stale'
        }
      })
      clients.push(staleClient)
      await staleClient.start()
      const staleRequests = (await readRpcTranscript(staleTranscript)).filter((entry) =>
        entry.frame.method === 'session/load' || entry.frame.method === 'session/new'
      )
      expect(staleRequests.map((entry) => entry.frame.params)).toEqual([
        {
          sessionId: 'stale-session',
          cwd: root,
          mcpServers: [],
          _meta: { agentProfile: profile }
        },
        {
          cwd: root,
          mcpServers: [],
          _meta: { agentProfile: profile }
        }
      ])

      const forkTranscript = join(root, 'fork.ndjson')
      const forkClient = new AcpClient({
        ...base,
        forkSession: {
          sourceSessionId: FORK_SOURCE_ID,
          newSessionId: FORK_CHILD_ID
        },
        env: { GROKBUILD_MOCK_TRANSCRIPT: forkTranscript }
      })
      clients.push(forkClient)
      await forkClient.start()
      expect((await readRpcTranscript(forkTranscript)).find((entry) =>
        entry.frame.method === 'session/load'
      )?.frame.params).toEqual({
        sessionId: FORK_CHILD_ID,
        cwd: root,
        mcpServers: [],
        _meta: { noReplay: true, agentProfile: profile }
      })
    } finally {
      await Promise.all(clients.map((client) => client.stop()))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a malformed primary-agent profile without reflecting private profile data', async () => {
    const canary = 'QA_AGENT_PROFILE_SECRET_CANARY_9B4D'
    const client = new AcpClient({
      cliPath: resolve('qa/mock-grok.mjs'),
      cwd: process.cwd(),
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      agentProfile: {
        name: `unsafe name ${canary}`,
        description: 'must remain private',
        promptBody: `private instructions ${canary}`
      }
    })

    let failure: unknown
    try {
      await client.start()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('Grok reported an unexpected error. Retry the request.')
    expect((failure as Error).message).not.toContain(canary)
    expect((client as unknown as { process?: unknown }).process).toBeUndefined()
    await client.stop()
  })
})

function createClient(): AcpClient {
  return new AcpClient({
    cliPath: resolve('qa/mock-grok.mjs'),
    cwd: process.cwd(),
    model: 'grok-4.6',
    reasoningEffort: 'xhigh'
  })
}

function nextInteraction(client: AcpClient): Promise<PendingInteraction> {
  return new Promise((resolveInteraction) => client.once('interaction', resolveInteraction))
}

function permissionRequest(id: string, sessionId: string, title: string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId: id, title },
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }]
    }
  }
}

function questionRequest(
  id: string,
  sessionId: string,
  wrapped: boolean,
  question: string
): unknown {
  const params = {
    sessionId,
    toolCallId: id,
    questions: [{
      question,
      options: [{ label: 'Continue', description: 'Continue with the request.' }],
      multiSelect: false
    }],
    mode: 'default'
  }
  return wrapped
    ? {
        jsonrpc: '2.0',
        id,
        method: '_x.ai/ask_user_question',
        params: { method: 'x.ai/ask_user_question', params }
      }
    : { jsonrpc: '2.0', id, method: 'x.ai/ask_user_question', params }
}

async function readRpcTranscript(path: string): Promise<Array<{
  direction: string
  frame: { method?: string; params?: unknown; argv?: string[] }
}>> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      direction: string
      frame: { method?: string; params?: unknown; argv?: string[] }
    })
}
