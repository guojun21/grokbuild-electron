import { AcpClient } from './AcpClient'
import { classifySessionStderr, publicAcpErrorMessage } from './PublicSessionError'
import { workerCommandSchema, type WorkerResponse } from '../../shared/acp/workerProtocol'

const parentPort = process.parentPort
if (!parentPort) throw new Error('ACP worker was not launched as an Electron utility process')

let client: AcpClient | undefined
let stopping = false
let launchIdentity: { localSessionId: string; generation: number } | undefined
let eventSequence = 0

parentPort.on('message', (event) => {
  const parsed = workerCommandSchema.safeParse(event.data)
  if (!parsed.success) {
    process.stderr.write('Rejected an invalid ACP worker command.\n')
    return
  }
  const command = parsed.data
  void handle(command).then(
    (result) => post({ kind: 'response', id: command.id, ok: true, ...(result !== undefined ? { result } : {}) }),
    (error: unknown) => post({ kind: 'response', id: command.id, ok: false, error: publicAcpErrorMessage(error) })
  )
})

async function handle(command: ReturnType<typeof workerCommandSchema.parse>): Promise<unknown> {
  if (command.type === 'start') {
    if (!launchIdentity) {
      launchIdentity = {
        localSessionId: command.payload.localSessionId,
        generation: command.payload.generation
      }
    } else if (
      launchIdentity.localSessionId !== command.payload.localSessionId ||
      launchIdentity.generation !== command.payload.generation
    ) {
      throw new Error('ACP worker launch identity cannot change')
    }
    if (!client) {
      const sessionOpen = command.payload.forkSession
        ? { forkSession: command.payload.forkSession } as const
        : command.payload.resumeSessionId
          ? {
              resumeSessionId: command.payload.resumeSessionId,
              ...(command.payload.allowStaleFallback !== undefined
                ? { allowStaleFallback: command.payload.allowStaleFallback }
                : {})
            } as const
          : {}
      client = new AcpClient({
        cliPath: command.payload.cliPath,
        cwd: command.payload.cwd,
        model: command.payload.model,
        reasoningEffort: command.payload.reasoningEffort,
        ...(command.payload.memoryEnabled !== undefined
          ? { memoryEnabled: command.payload.memoryEnabled }
          : {}),
        ...(command.payload.agentProfile ? { agentProfile: command.payload.agentProfile } : {}),
        ...sessionOpen,
        env: command.payload.environment
      })
      client.on('update', (params) => postEvent('update', params))
      client.on('trustedUpdate', (update) => postEvent('trusted_update', update))
      client.on('capabilities', (capabilities) => postEvent('capabilities', capabilities))
      client.on('permission', (request) => postEvent('permission', request))
      client.on('interaction', (request) => postEvent('interaction', request))
      client.on('interactionResolved', (resolution) => postEvent('interaction_resolved', resolution))
      client.on('stderr', (line) => {
        const classified = classifySessionStderr(line)
        if (classified) postEvent('stderr', classified.message)
      })
      client.on('exit', (code) => {
        if (stopping) return
        postEvent('exit', { code })
        setTimeout(() => process.exit(code ?? 1), 0)
      })
    }
    return client.start()
  }
  if (!client) throw new Error('ACP worker has not been started')
  switch (command.type) {
    case 'prompt':
      return client.prompt(
        'text' in command.payload ? command.payload.text : command.payload.blocks
      )
    case 'cancel':
      client.cancel()
      return undefined
    case 'set_model':
      return client.setModel(command.payload.model)
    case 'set_mode':
      return client.setMode(command.payload.mode)
    case 'answer_permission':
      return client.answerPermission(command.payload.requestId, command.payload.optionId)
    case 'answer_interaction':
      return client.answerInteraction(command.payload.interactionId, command.payload.answer)
    case 'stop':
      stopping = true
      await client.stop()
      setTimeout(() => process.exit(0), 25).unref()
      return undefined
  }
}

function post(message: WorkerResponse): void {
  parentPort.postMessage(message)
}

function postEvent(
  event: 'update' | 'trusted_update' | 'capabilities' | 'permission' | 'interaction' | 'interaction_resolved' | 'stderr' | 'exit',
  payload: unknown
): void {
  if (!launchIdentity) {
    process.stderr.write(`Dropped ACP worker ${event} event before launch identity was set\n`)
    return
  }
  post({
    kind: 'event',
    event,
    localSessionId: launchIdentity.localSessionId,
    generation: launchIdentity.generation,
    sequence: ++eventSequence,
    payload
  } as WorkerResponse)
}
