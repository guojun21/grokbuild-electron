import { describe, expect, it } from 'vitest'
import {
  REDACTED_PATH,
  REDACTED_VALUE,
  sanitizeDisplayText,
  sanitizeDisplayTitle,
  sanitizeJsonValue,
  stringifySanitizedJson
} from '../../src/shared/security/redaction'
import {
  classifyAcpRpcFault,
  classifySessionStderr,
  publicAcpErrorMessage
} from '../../src/main/acp/PublicSessionError'

const CANARY = 'redaction-canary-c711a9'

describe('bounded display redaction', () => {
  it('recursively replaces secret, header, environment, argv, and path fields', () => {
    const value = {
      normal: 'Readable result',
      nested: {
        authorization: `Bearer ${CANARY}`,
        cookie: `session=${CANARY}`,
        token: CANARY,
        client_secret: CANARY,
        password: CANARY,
        api_key: CANARY,
        headers: { safe: CANARY },
        env: { XAI_API_KEY: CANARY },
        path: `/private/${CANARY}`,
        argv: ['--token', CANARY],
        count: 2
      }
    }

    const sanitized = sanitizeJsonValue(value)
    expect(sanitized).toMatchObject({
      normal: 'Readable result',
      nested: {
        authorization: REDACTED_VALUE,
        cookie: REDACTED_VALUE,
        token: REDACTED_VALUE,
        client_secret: REDACTED_VALUE,
        password: REDACTED_VALUE,
        api_key: REDACTED_VALUE,
        headers: REDACTED_VALUE,
        env: REDACTED_VALUE,
        path: REDACTED_VALUE,
        argv: REDACTED_VALUE,
        count: 2
      }
    })
    expect(JSON.stringify(sanitized)).not.toContain(CANARY)
  })

  it('redacts common tokens, URL credentials/query secrets, flags, and absolute paths', () => {
    const raw = [
      `Bearer ${CANARY}`,
      `sk-${CANARY}`,
      `xai-${CANARY}`,
      `ghp_${CANARY.replaceAll('-', '')}`,
      `token=${CANARY}`,
      `--api-key ${CANARY}`,
      `https://user:${CANARY}@example.test/api?token=${CANARY}&safe=visible`,
      `/Users/private/${CANARY}`,
      `source:/Users/private/${CANARY}`,
      `source:C:\\Users\\private\\${CANARY}`,
      `source:"/Users/private/My Secret/${CANARY}/agent.md"`,
      "source:'C:\\Users\\private\\My Secret\\" + CANARY + "\\agent.md'",
      'ordinary diagnostic remains readable'
    ].join('\n')

    const sanitized = sanitizeDisplayText(raw)
    expect(sanitized).not.toContain(CANARY)
    expect(sanitized).not.toContain('user:')
    expect(sanitized).not.toContain('/Users/private')
    expect(sanitized).toContain('safe=visible')
    expect(sanitized).toContain('https://example.test/api')
    expect(sanitized).toContain(REDACTED_PATH)
    expect(sanitized).toContain('ordinary diagnostic remains readable')
    expect(sanitizeDisplayTitle(`Read\u0000\nBearer ${CANARY}`)).toBe('Read Bearer [REDACTED]')
  })

  it('bounds depth, key count, arrays, cycles, binary values, and serialized length', () => {
    const cyclic: Record<string, unknown> = { safe: 'readable' }
    cyclic.self = cyclic
    cyclic.deep = { one: { two: { three: CANARY } } }
    cyclic.list = [1, 2, 3, 4]
    cyclic.binary = new Uint8Array([1, 2, 3])
    cyclic.extraA = 'a'.repeat(200)
    cyclic.extraB = 'b'.repeat(200)

    const sanitized = sanitizeJsonValue(cyclic, {
      maxDepth: 2,
      maxKeys: 6,
      maxArrayItems: 2,
      maxStringChars: 32,
      maxOutputChars: 120
    })
    const serialized = stringifySanitizedJson(cyclic, {
      maxDepth: 2,
      maxKeys: 6,
      maxArrayItems: 2,
      maxStringChars: 32,
      maxOutputChars: 120
    })

    expect(JSON.stringify(sanitized)).toContain('[CIRCULAR]')
    expect(JSON.stringify(sanitized)).toContain('[DEPTH LIMIT]')
    expect(serialized.length).toBeLessThanOrEqual(120)
    expect(serialized).not.toContain(CANARY)
  })
})

describe('fixed ACP public fault classification', () => {
  it('classifies raw diagnostics without returning their contents', () => {
    const diagnostics = [
      classifySessionStderr(`401 unauthorized Bearer ${CANARY}`),
      classifySessionStderr(`429 rate limit token=${CANARY}`),
      classifySessionStderr(`ECONNRESET /private/${CANARY}`),
      classifySessionStderr(`fatal panic env=${CANARY}`),
      classifySessionStderr(`unexpected error argv=${CANARY}`)
    ]
    expect(diagnostics.map((item) => item?.kind)).toEqual([
      'authentication', 'rate-limit', 'network', 'crash', 'generic'
    ])
    expect(JSON.stringify(diagnostics)).not.toContain(CANARY)
    expect(classifySessionStderr('ordinary debug output')).toBeUndefined()
  })

  it('discards RPC error messages/data after fixed classification', () => {
    const auth = classifyAcpRpcFault(401, `expired xai-${CANARY}`, {
      token: CANARY,
      path: `/private/${CANARY}`
    })
    const missing = classifyAcpRpcFault(-32000, CANARY, {
      code: 'FS_NOT_FOUND',
      path: `/private/${CANARY}`
    })
    const publicMessage = publicAcpErrorMessage(new Error(`spawn /private/${CANARY} env TOKEN=${CANARY}`))

    expect(auth).toEqual({
      kind: 'authentication',
      message: 'Grok authentication failed. Sign in again and retry.'
    })
    expect(missing).toEqual({
      kind: 'not-found',
      message: 'The previous Grok session is no longer available.'
    })
    expect(publicMessage).toBe('Grok reported an unexpected error. Retry the request.')
    expect(JSON.stringify([auth, missing, publicMessage])).not.toContain(CANARY)
  })
})
