import type {
  AcpCapabilities,
  AcpClientOptions,
  AcpPermissionRequest,
  AcpStartResult
} from './AcpClient'
import type {
  InteractionAnswer,
  InteractionResolved,
  PendingInteraction
} from '../../shared/acp/interactions'
import type { AttachmentPrompt } from '../../shared/attachments'
import type { TrustedAcpUpdate } from '../../shared/acp/trustedUpdates'

export type AcpConnectionOptions = AcpClientOptions & {
  localSessionId: string
  generation: number
}

export interface AcpConnectionEvents {
  update: [params: unknown]
  trustedUpdate: [update: TrustedAcpUpdate]
  capabilities: [capabilities: AcpCapabilities]
  permission: [request: AcpPermissionRequest]
  interaction: [request: PendingInteraction]
  interactionResolved: [resolution: InteractionResolved]
  stderr: [line: string]
  exit: [code: number | null, signal: NodeJS.Signals | null]
}

export interface AcpConnection {
  on(event: 'update', listener: (params: unknown) => void): this
  on(event: 'trustedUpdate', listener: (update: TrustedAcpUpdate) => void): this
  on(event: 'capabilities', listener: (capabilities: AcpCapabilities) => void): this
  on(event: 'permission', listener: (request: AcpPermissionRequest) => void): this
  on(event: 'interaction', listener: (request: PendingInteraction) => void): this
  on(event: 'interactionResolved', listener: (resolution: InteractionResolved) => void): this
  on(event: 'stderr', listener: (line: string) => void): this
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  start(): Promise<AcpStartResult>
  prompt(prompt: AttachmentPrompt): Promise<void>
  cancel(): void
  setModel(model: string): Promise<void>
  setMode(mode: string): Promise<void>
  answerPermission(requestId: string, optionId: string): Promise<void>
  answerInteraction(interactionId: string, answer: InteractionAnswer): Promise<void>
  stop(): Promise<void>
}
