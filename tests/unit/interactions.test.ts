import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppController } from '../../src/main/AppController'
import type { AcpStartResult } from '../../src/main/acp/AcpClient'
import type { AcpConnection, AcpConnectionEvents } from '../../src/main/acp/AcpConnection'
import { AppStateStore } from '../../src/main/persistence/AppStateStore'
import type { InteractionAnswer, PendingInteraction } from '../../src/shared/acp/interactions'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class FakeInteractionConnection extends EventEmitter<AcpConnectionEvents> implements AcpConnection {
  readonly answers: Array<{ interactionId: string; answer: InteractionAnswer }> = []
  cancelCount = 0
  start = async (): Promise<AcpStartResult> => ({ sessionId: 'remote-session', resumed: false })
  prompt = async (): Promise<void> => undefined
  cancel = (): void => { this.cancelCount += 1 }
  setModel = async (): Promise<void> => undefined
  setMode = async (): Promise<void> => undefined
  answerPermission = async (): Promise<void> => undefined
  answerInteraction = async (interactionId: string, answer: InteractionAnswer): Promise<void> => {
    this.answers.push({ interactionId, answer })
  }
  stop = async (): Promise<void> => undefined
}

describe('plan and question interaction queue', () => {
  it('shows only the FIFO head and rejects out-of-order or late answers', async () => {
    const { controller, connection, sessionId } = await harness()
    connection.emit('interaction', plan('plan-1'))
    connection.emit('interaction', question('question-2'))
    connection.emit('interaction', plan('plan-3'))

    expect(controller.snapshot().sessions[0]?.pendingInteraction?.interactionId).toBe('plan-1')
    expect(controller.snapshot().sessions[0]?.pendingInteraction).not.toHaveProperty('sessionId')
    expect(JSON.stringify(controller.snapshot())).not.toContain('remote-session')
    await expect(controller.answerInteraction(sessionId, 'plan-3', {
      kind: 'plan',
      decision: 'approved'
    })).rejects.toThrow('no longer active')

    await controller.answerInteraction(sessionId, 'plan-1', { kind: 'plan', decision: 'approved' })
    expect(controller.snapshot().sessions[0]?.pendingInteraction?.interactionId).toBe('question-2')
    await expect(controller.answerInteraction(sessionId, 'plan-1', {
      kind: 'plan',
      decision: 'approved'
    })).rejects.toThrow('no longer active')
    expect(connection.answers).toEqual([{
      interactionId: 'plan-1',
      answer: { kind: 'plan', decision: 'approved' }
    }])
    await controller.stop()
  })

  it('never applies permission auto-accept to plan or question interactions', async () => {
    const { controller, connection, sessionId } = await harness()
    controller.updateSession({ sessionId, permissionMode: 'auto' })
    connection.emit('interaction', plan('plan-1'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(controller.snapshot().sessions[0]?.pendingInteraction?.interactionId).toBe('plan-1')
    expect(connection.answers).toEqual([])
    await controller.answerInteraction(sessionId, 'plan-1', { kind: 'plan', decision: 'abandoned' })
    expect(connection.answers).toHaveLength(1)
    await controller.stop()
  })

  it('clears the visible FIFO when the turn is cancelled', async () => {
    const { controller, connection, sessionId } = await harness()
    connection.emit('interaction', question('question-1'))
    connection.emit('interaction', plan('plan-2'))
    controller.cancelTurn(sessionId)

    expect(connection.cancelCount).toBe(1)
    expect(controller.snapshot().sessions[0]?.pendingInteraction).toBeUndefined()
    await controller.stop()
  })

  it('removes a remotely resolved opaque interaction from any FIFO position', async () => {
    const { controller, connection, sessionId } = await harness()
    connection.emit('interaction', plan('plan-1'))
    connection.emit('interaction', question('question-2'))
    connection.emit('interaction', plan('plan-3'))

    connection.emit('interactionResolved', { interactionId: 'question-2' })
    expect(controller.snapshot().sessions[0]?.pendingInteraction?.interactionId).toBe('plan-1')
    await controller.answerInteraction(sessionId, 'plan-1', {
      kind: 'plan',
      decision: 'approved'
    })
    expect(controller.snapshot().sessions[0]?.pendingInteraction?.interactionId).toBe('plan-3')

    connection.emit('interactionResolved', { interactionId: 'plan-3' })
    expect(controller.snapshot().sessions[0]?.pendingInteraction).toBeUndefined()
    await expect(controller.answerInteraction(sessionId, 'plan-3', {
      kind: 'plan',
      decision: 'approved'
    })).rejects.toThrow('no longer active')
    expect(connection.answers).toHaveLength(1)
    await controller.stop()
  })

  it('keeps the next FIFO item when a late remote resolution follows the local winning answer', async () => {
    const { controller, connection, sessionId } = await harness()
    connection.emit('interaction', plan('plan-1'))
    connection.emit('interaction', question('question-2'))
    await controller.answerInteraction(sessionId, 'plan-1', {
      kind: 'plan',
      decision: 'approved'
    })
    connection.emit('interactionResolved', { interactionId: 'plan-1' })

    expect(controller.snapshot().sessions[0]?.pendingInteraction?.interactionId).toBe('question-2')
    expect(connection.answers).toEqual([{
      interactionId: 'plan-1',
      answer: { kind: 'plan', decision: 'approved' }
    }])
    await controller.stop()
  })
})

async function harness(): Promise<{
  controller: AppController
  connection: FakeInteractionConnection
  sessionId: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-interactions-'))
  temporaryRoots.push(root)
  let connection: FakeInteractionConnection | undefined
  const controller = new AppController({
    appVersion: 'test',
    cliPath: process.execPath,
    store: new AppStateStore(join(root, 'state.json'), process.execPath),
    seedProjectPath: process.cwd(),
    acpFactory: () => {
      connection = new FakeInteractionConnection()
      return connection
    }
  })
  await controller.initialize()
  const projectId = controller.snapshot().projects[0]!.id
  const sessionId = (await controller.createSession(projectId)).id
  controller.sendPrompt(sessionId, 'start')
  await eventually(() => Boolean(connection))
  return { controller, connection: connection!, sessionId }
}

function plan(interactionId: string): PendingInteraction {
  return {
    kind: 'plan',
    interactionId,
    sessionId: 'remote-session',
    planContent: '# Plan'
  }
}

function question(interactionId: string): PendingInteraction {
  return {
    kind: 'question',
    interactionId,
    sessionId: 'remote-session',
    mode: 'default',
    questions: [{
      id: 'question-1',
      question: 'Pick one?',
      options: [{ id: 'option-1', label: 'A' }],
      multiSelect: false,
      otherOptionId: 'other-1'
    }]
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condition did not become true')
}
