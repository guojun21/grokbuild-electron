import { describe, expect, it } from 'vitest'
import {
  PERMISSION_BLOCKED_EXIT,
  blockedManifest,
  canonicalizeAxTree,
  canonicalizeRpcTranscript,
  classifyAccessibilityProbe,
  classifyScreenRecordingProbe
} from '../../qa/drivers/swift-blackbox/lib.mjs'

describe('Swift black-box QA evidence contracts', () => {
  it('classifies System Events -25211 as an explicit Accessibility block', () => {
    expect(classifyAccessibilityProbe({
      status: 1,
      stderr: 'execution error: osascript is not allowed assistive access. (-25211)'
    })).toEqual({
      granted: false,
      code: 'accessibility-denied',
      reason: 'Accessibility automation is not authorized: execution error: osascript is not allowed assistive access. (-25211)',
      remediation: 'Enable the terminal or automation host running this command in System Settings → Privacy & Security → Accessibility.'
    })
  })

  it('classifies a negative CoreGraphics preflight as a Screen Recording block', () => {
    expect(classifyScreenRecordingProbe({ status: 0, stdout: '{"screenRecording":false}\n' }))
      .toMatchObject({ granted: false, code: 'screen-recording-denied' })
  })

  it('writes a blocked manifest with exit 77 and no passing stages', () => {
    const reason = classifyAccessibilityProbe({ status: 1, stderr: 'not allowed (-25211)' })
    expect(blockedManifest({
      reasons: [reason],
      reference: { commit: 'pinned' },
      outputDirectory: '/tmp/qa-evidence'
    })).toEqual({
      schemaVersion: 1,
      driver: 'swift-blackbox-ax',
      status: 'blocked',
      exitCode: PERMISSION_BLOCKED_EXIT,
      reference: { commit: 'pinned' },
      outputDirectory: '/tmp/qa-evidence',
      stages: [],
      reasons: [{
        code: 'accessibility-denied',
        reason: 'Accessibility automation is not authorized: not allowed (-25211)',
        remediation: 'Enable the terminal or automation host running this command in System Settings → Privacy & Security → Accessibility.'
      }]
    })
  })

  it('canonicalizes RPC correlation in first-seen order without sorting the stream', () => {
    const transcript = [
      {
        direction: 'client->agent',
        frame: {
          jsonrpc: '2.0',
          id: 41,
          method: 'session/prompt',
          params: {
            sessionId: 'session-real',
            cwd: '/private/qa/workspace',
            toolCallId: 'tool-real'
          }
        }
      },
      {
        direction: 'agent->client',
        frame: {
          jsonrpc: '2.0',
          id: 41,
          result: { sessionId: 'session-real', requestId: 'tool-real' }
        }
      }
    ].map((entry) => JSON.stringify(entry)).join('\n')

    expect(canonicalizeRpcTranscript(transcript, { '$WORKSPACE': '/private/qa/workspace' }))
      .toEqual([
        {
          direction: 'client->agent',
          frame: {
            jsonrpc: '2.0',
            id: '$RPC_1',
            method: 'session/prompt',
            params: {
              cwd: '$WORKSPACE',
              sessionId: '$ACP_SESSION_1',
              toolCallId: '$REQUEST_1'
            }
          }
        },
        {
          direction: 'agent->client',
          frame: {
            jsonrpc: '2.0',
            id: '$RPC_1',
            result: {
              requestId: '$REQUEST_1',
              sessionId: '$ACP_SESSION_1'
            }
          }
        }
      ])
  })

  it('removes volatile AX positions while preserving semantic order and size', () => {
    expect(canonicalizeAxTree({
      role: 'AXApplication',
      title: 'GrokBuild',
      position: [127, 80],
      size: [1200.4, 799.6],
      children: [
        { role: 'AXButton', title: 'Add Project', position: [400, 300], enabled: true },
        { role: 'AXStaticText', value: '/private/qa/workspace' }
      ]
    }, { '$WORKSPACE': '/private/qa/workspace' })).toEqual({
      role: 'AXApplication',
      title: 'GrokBuild',
      size: [1200, 800],
      children: [
        { role: 'AXButton', title: 'Add Project', enabled: true },
        { role: 'AXStaticText', value: '$WORKSPACE' }
      ]
    })
  })
})
