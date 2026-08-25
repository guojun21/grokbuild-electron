import { describe, expect, it } from 'vitest'
import { parseJsonRpcLine, rpcRequest, rpcResult } from '../../src/shared/acp/jsonrpc'

describe('JSON-RPC NDJSON contract', () => {
  it('accepts ACP notifications and string request ids', () => {
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","method":"session/update","params":{}}')).toMatchObject({
      method: 'session/update'
    })
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","id":"permission-1","result":{}}').id).toBe('permission-1')
  })

  it('writes exactly one line per request and response', () => {
    expect(rpcRequest(7, 'initialize', {})).toBe('{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}\n')
    expect(rpcResult('p-1', { outcome: 'cancelled' })).toBe('{"jsonrpc":"2.0","id":"p-1","result":{"outcome":"cancelled"}}\n')
  })

  it('rejects unrelated JSON', () => {
    expect(() => parseJsonRpcLine('{"hello":"world"}')).toThrow()
  })
})

