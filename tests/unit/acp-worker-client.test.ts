import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const electronHarness = vi.hoisted(() => ({
  fork: vi.fn()
}))

vi.mock('electron', () => ({
  utilityProcess: { fork: electronHarness.fork }
}))

import { AcpWorkerClient } from '../../src/main/acp/AcpWorkerClient'
import { workerCommandSchema } from '../../src/shared/acp/workerProtocol'

describe('AcpWorkerClient launch boundary', () => {
  it('passes the inline primary-agent profile unchanged through the strict worker command', async () => {
    const worker = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stderr: new EventEmitter()
    })
    electronHarness.fork.mockReturnValue(worker)
    const agentProfile = {
      name: 'security_reviewer',
      description: 'Reviews trust boundaries.',
      promptBody: 'Inspect the requested boundary and report concrete findings.'
    }
    const client = new AcpWorkerClient('/app/acp-worker.js', {
      localSessionId: 'local-profile',
      generation: 3,
      cliPath: '/mock/grok',
      cwd: '/workspace',
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      memoryEnabled: true,
      agentProfile
    })

    const starting = client.start()
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    const command = worker.postMessage.mock.calls[0]?.[0]
    expect(workerCommandSchema.parse(command)).toEqual({
      id: 1,
      type: 'start',
      payload: {
        localSessionId: 'local-profile',
        generation: 3,
        cliPath: '/mock/grok',
        cwd: '/workspace',
        model: 'grok-4.6',
        reasoningEffort: 'xhigh',
        memoryEnabled: true,
        agentProfile,
        environment: {}
      }
    })

    worker.emit('message', {
      data: {
        kind: 'response',
        id: 1,
        ok: true,
        result: { sessionId: 'remote-profile', resumed: false }
      }
    })
    await expect(starting).resolves.toEqual({
      sessionId: 'remote-profile',
      resumed: false
    })
  })
})
