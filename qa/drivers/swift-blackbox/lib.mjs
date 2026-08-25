import { createHash } from 'node:crypto'

export const SWIFT_QA_BUNDLE_ID = 'com.oasmet.grokbuild.swift-blackbox-qa'
export const PERMISSION_BLOCKED_EXIT = 77

const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const isoTimestampPattern = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g

export function classifyAccessibilityProbe(probe) {
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim()
  if (probe.status !== 0) {
    const denied = /-25211|assistive access|accessibility|not authorized|not allowed/i.test(output)
    return {
      granted: false,
      code: denied ? 'accessibility-denied' : 'accessibility-probe-failed',
      reason: denied
        ? `Accessibility automation is not authorized${output ? `: ${singleLine(output)}` : '.'}`
        : `Accessibility preflight failed${output ? `: ${singleLine(output)}` : '.'}`,
      remediation: 'Enable the terminal or automation host running this command in System Settings → Privacy & Security → Accessibility.'
    }
  }
  try {
    const value = JSON.parse(String(probe.stdout).trim())
    if (value.uiElementsEnabled === true) return { granted: true }
    return {
      granted: false,
      code: 'accessibility-denied',
      reason: 'System Events reports that accessibility UI scripting is disabled.',
      remediation: 'Enable the terminal or automation host running this command in System Settings → Privacy & Security → Accessibility.'
    }
  } catch {
    return {
      granted: false,
      code: 'accessibility-probe-invalid',
      reason: `Accessibility preflight returned an unrecognized response${output ? `: ${singleLine(output)}` : '.'}`,
      remediation: 'Re-run the preflight from a macOS terminal with Automation and Accessibility access.'
    }
  }
}

export function classifyScreenRecordingProbe(probe) {
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim()
  if (probe.status !== 0) {
    return {
      granted: false,
      code: 'screen-recording-probe-failed',
      reason: `Screen Recording preflight failed${output ? `: ${singleLine(output)}` : '.'}`,
      remediation: 'Enable the terminal or automation host running this command in System Settings → Privacy & Security → Screen & System Audio Recording.'
    }
  }
  try {
    const value = JSON.parse(String(probe.stdout).trim())
    if (value.screenRecording === true) return { granted: true }
    return {
      granted: false,
      code: 'screen-recording-denied',
      reason: 'CoreGraphics reports that Screen Recording access is not granted.',
      remediation: 'Enable the terminal or automation host running this command in System Settings → Privacy & Security → Screen & System Audio Recording.'
    }
  } catch {
    return {
      granted: false,
      code: 'screen-recording-probe-invalid',
      reason: `Screen Recording preflight returned an unrecognized response${output ? `: ${singleLine(output)}` : '.'}`,
      remediation: 'Re-run the preflight from a macOS terminal with Screen Recording access.'
    }
  }
}

export function blockedManifest({ reasons, reference, outputDirectory }) {
  return {
    schemaVersion: 1,
    driver: 'swift-blackbox-ax',
    status: 'blocked',
    exitCode: PERMISSION_BLOCKED_EXIT,
    reference,
    outputDirectory,
    stages: [],
    reasons: reasons.map(({ granted: _granted, ...reason }) => reason)
  }
}

export function canonicalizeRpcTranscript(text, roots = {}) {
  const entries = String(text)
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`Invalid RPC transcript line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  const state = createCanonicalState(roots)
  return entries.map((entry) => ({
    direction: entry.direction,
    frame: canonicalizeRpcFrame(entry.frame, state)
  }))
}

export function canonicalizePreferences(value, roots = {}) {
  return canonicalizeValue(value, createCanonicalState(roots))
}

export function canonicalizeAxTree(value, roots = {}) {
  const state = createCanonicalState(roots)
  const visit = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
    const result = {}
    for (const key of ['role', 'subrole', 'title', 'description', 'value']) {
      if (node[key] !== undefined && node[key] !== '') result[key] = canonicalizeValue(node[key], state)
    }
    for (const key of ['enabled', 'focused']) {
      if (typeof node[key] === 'boolean') result[key] = node[key]
    }
    if (Array.isArray(node.size) && node.size.length === 2) {
      result.size = node.size.map((part) => Number.isFinite(part) ? Math.round(part) : part)
    }
    const children = Array.isArray(node.children)
      ? node.children.map(visit).filter(Boolean)
      : []
    if (children.length > 0) result.children = children
    return result
  }
  return visit(value)
}

export function canonicalWindowMetadata(windows) {
  return windows
    .filter((window) => window.layer === 0 && window.bounds)
    .map((window) => ({
      name: window.name || '',
      width: Math.round(window.bounds.width ?? 0),
      height: Math.round(window.bounds.height ?? 0),
      onScreen: window.onScreen === true
    }))
    .sort((left, right) => (right.width * right.height) - (left.width * left.height))
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function canonicalizeRpcFrame(frame, state) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return frame
  const result = {}
  for (const [key, value] of Object.entries(frame)) {
    if (key === 'id') {
      result.id = tokenFor(state.rpcIds, String(value), '$RPC')
    } else {
      result[key] = canonicalizeValue(value, state, key)
    }
  }
  return result
}

function canonicalizeValue(value, state, key = '') {
  if (typeof value === 'string') {
    if (/sessionId$/i.test(key) && value) return tokenFor(state.sessionIds, value, '$ACP_SESSION')
    if (/(?:toolCallId|requestId)$/i.test(key) && value) return tokenFor(state.requestIds, value, '$REQUEST')
    return canonicalizeString(value, state)
  }
  if (Array.isArray(value)) return value.map((item) => canonicalizeValue(item, state))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map((childKey) => [
      childKey,
      canonicalizeValue(value[childKey], state, childKey)
    ])
  )
}

function canonicalizeString(input, state) {
  let value = input.replace(/\r\n?/g, '\n')
  for (const [path, token] of state.roots) {
    value = value.split(path).join(token)
  }
  value = value.replace(uuidPattern, (match) => tokenFor(state.uuids, match.toLowerCase(), '$UUID'))
  value = value.replace(isoTimestampPattern, (match) => tokenFor(state.timestamps, match, '$TIME'))
  return value
}

function createCanonicalState(roots) {
  const normalizedRoots = Object.entries(roots)
    .filter((entry) => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([token, path]) => [path, token])
    .sort((left, right) => right[0].length - left[0].length)
  return {
    roots: normalizedRoots,
    rpcIds: new Map(),
    sessionIds: new Map(),
    requestIds: new Map(),
    uuids: new Map(),
    timestamps: new Map()
  }
}

function tokenFor(map, value, prefix) {
  if (!map.has(value)) map.set(value, `${prefix}_${map.size + 1}`)
  return map.get(value)
}

function singleLine(value) {
  return value.replace(/\s+/g, ' ').slice(0, 1_000)
}
