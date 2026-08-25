import { z } from 'zod'

const jsonRpcIdSchema = z.union([z.string(), z.number()])

export const jsonRpcMessageSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: jsonRpcIdSchema.optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional()
      })
      .optional()
  })
  .refine((message) => Boolean(message.method || message.result !== undefined || message.error), {
    message: 'Not a JSON-RPC request, notification, or response'
  })

export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>
export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>

export function parseJsonRpcLine(line: string): JsonRpcMessage {
  const parsed: unknown = JSON.parse(line)
  return jsonRpcMessageSchema.parse(parsed)
}

export function rpcRequest(id: JsonRpcId, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
}

export function rpcNotification(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`
}

export function rpcResult(id: JsonRpcId, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`
}

export function rpcError(id: JsonRpcId, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`
}
