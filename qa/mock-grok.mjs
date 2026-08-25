#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

/** Smallest valid PNG; the generated-image scenario writes it as a real file on disk. */
const QA_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const args = process.argv.slice(2)
if (args[0] === 'update' && args[1] === '--check' && args.includes('--json')) {
  const cwdLog = process.env.GROKBUILD_MOCK_UPDATE_CWD_LOG
  if (cwdLog) {
    mkdirSync(dirname(cwdLog), { recursive: true })
    appendFileSync(cwdLog, `${JSON.stringify({ cwd: process.cwd(), args })}\n`)
  }
  const currentVersion = mockCurrentVersion()
  const latestVersion = process.env.GROKBUILD_MOCK_UPDATE_LATEST ?? '1.0.6'
  process.stdout.write(`${JSON.stringify({
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion !== currentVersion,
    channel: 'stable',
    installer: 'managed'
  })}\n`)
  process.exit(0)
}

if (args.length === 3 && args[0] === 'update' && args[1] === '--version') {
  const updateStatePath = process.env.GROKBUILD_MOCK_UPDATE_STATE
  if (!updateStatePath) {
    process.stderr.write('qa mock CLI update state is not configured\n')
    process.exit(2)
  }
  const targetVersion = args[2]
  if (!/^\d+(?:\.\d+){2}$/.test(targetVersion)) process.exit(2)
  const startedMarker = process.env.GROKBUILD_MOCK_UPDATE_STARTED_MARKER
  if (startedMarker) {
    mkdirSync(dirname(startedMarker), { recursive: true })
    writeFileSync(startedMarker, 'started\n', { encoding: 'utf8', mode: 0o600 })
  }
  const delayMs = Number(process.env.GROKBUILD_MOCK_UPDATE_DELAY_MS ?? '0')
  if (Number.isSafeInteger(delayMs) && delayMs > 0 && delayMs <= 30_000) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
  }
  mkdirSync(dirname(updateStatePath), { recursive: true })
  writeFileSync(
    updateStatePath,
    `${targetVersion}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )
  const cwdLog = process.env.GROKBUILD_MOCK_UPDATE_CWD_LOG
  if (cwdLog) appendFileSync(cwdLog, `${JSON.stringify({ cwd: process.cwd(), args })}\n`)
  process.stdout.write('Updated Grok CLI\n')
  process.exit(0)
}

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(`grok ${mockCurrentVersion()} (qa-mock)\n`)
  process.exit(0)
}

if (args[0] === 'sessions') {
  handleSessionHistoryCommand(args.slice(1))
}

if (args[0] === 'mcp') {
  handleMcpCommand(args.slice(1))
}

if (args.length === 2 && args[0] === 'inspect' && args[1] === '--json') {
  const sourcePath = process.env.GROKBUILD_MOCK_AGENT_SOURCE_PATH
    ?? realpathSync(process.argv[1])
  const selectorCanary = process.env.GROKBUILD_MOCK_AGENT_SELECTOR_CANARY
  const projectSelector = selectorCanary
    ? `workspace-reviewer /private/${selectorCanary}/agent.md`
    : 'workspace-reviewer'
  process.stdout.write(`${JSON.stringify({
    agents: [
      {
        name: 'general-purpose',
        description: 'General-purpose Grok agent.',
        source: { type: 'builtin' }
      },
      {
        name: projectSelector,
        description: 'Reviews the selected workspace.',
        source: { type: 'project', path: sourcePath }
      },
      {
        name: 'personal-researcher',
        description: 'Produces source-backed research briefs.',
        source: { type: 'user', path: sourcePath }
      },
      {
        name: 'qa-review-tools:operator',
        description: 'Runs bounded review workflows.',
        source: { type: 'plugin', plugin_name: 'QA Review Tools', path: sourcePath }
      }
    ]
  })}\n`)
  process.exit(0)
}

if (!args.includes('agent') || !args.includes('stdio')) {
  process.stderr.write(`qa mock only supports --version, update check, inspect, mcp, and agent stdio; got ${args.join(' ')}\n`)
  process.exit(2)
}

function mockCurrentVersion() {
  const updateStatePath = process.env.GROKBUILD_MOCK_UPDATE_STATE
  if (!updateStatePath || !existsSync(updateStatePath)) return '1.0.5'
  const version = readFileSync(updateStatePath, 'utf8').trim()
  return /^\d+(?:\.\d+){1,3}$/.test(version) ? version : '1.0.5'
}

function handleSessionHistoryCommand(commandArgs) {
  const command = commandArgs[0]
  const logPath = process.env.GROKBUILD_MOCK_SESSION_HISTORY_LOG
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${JSON.stringify({ command, args: commandArgs, cwd: process.cwd() })}\n`)
  }
  const records = readSessionHistoryState()
  if (command === 'list' && optionValue(commandArgs, '--limit') === '50') {
    writeSessionHistoryTable(records)
    process.exit(0)
  }
  if (command === 'search' && optionValue(commandArgs, '--limit') === '50') {
    const query = commandArgs.at(-1)
    if (!query || query.startsWith('-')) process.exit(2)
    const needle = query.toLocaleLowerCase()
    writeSessionHistoryTable(records.filter((record) =>
      record.summary.toLocaleLowerCase().includes(needle)
    ))
    process.exit(0)
  }
  if (command === 'delete' && commandArgs.length === 2) {
    const remoteId = commandArgs[1]
    const next = records.filter((record) => record.remoteId !== remoteId)
    if (next.length === records.length) process.exit(2)
    writeSessionHistoryState(next)
    process.stdout.write('Deleted Grok session\n')
    process.exit(0)
  }
  process.stderr.write('unsupported qa session history command\n')
  process.exit(2)
}

function defaultSessionHistory() {
  return [
    {
      remoteId: '11111111-1111-4111-8111-111111111111',
      created: '2026-08-20',
      updated: '2026-08-25',
      status: 'local',
      summary: 'Historical auth repair'
    },
    {
      remoteId: '22222222-2222-4222-8222-222222222222',
      created: '2026-08-19',
      updated: '2026-08-24',
      status: 'remote',
      summary: 'Archived release notes'
    }
  ]
}

function readSessionHistoryState() {
  const path = process.env.GROKBUILD_MOCK_SESSION_HISTORY_STATE
  if (!path || !existsSync(path)) return defaultSessionHistory()
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(value) ? value : defaultSessionHistory()
  } catch {
    return defaultSessionHistory()
  }
}

function writeSessionHistoryState(records) {
  const path = process.env.GROKBUILD_MOCK_SESSION_HISTORY_STATE
  if (!path) process.exit(2)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(records), { encoding: 'utf8', mode: 0o600 })
}

function writeSessionHistoryTable(records) {
  process.stdout.write('\n(no label)\n')
  process.stdout.write('SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY\n')
  for (const record of records) {
    process.stdout.write(
      `${record.remoteId}  ${record.created}  ${record.updated}  ${record.status}  ${record.summary}\n`
    )
  }
}

function handleMcpCommand(commandArgs) {
  const command = commandArgs[0]
  const cwdLog = process.env.GROKBUILD_MOCK_MCP_CWD_LOG
  if (cwdLog) {
    mkdirSync(dirname(cwdLog), { recursive: true })
    appendFileSync(cwdLog, `${JSON.stringify({ command, cwd: process.cwd() })}\n`)
  }
  const state = readMcpState()
  if (command === 'list' && commandArgs.includes('--json')) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    process.exit(0)
  }
  if (command === 'add') {
    const server = parseMcpAdd(commandArgs)
    const next = state.filter((candidate) =>
      candidate.name !== server.name || candidate.scope !== server.scope
    )
    next.push(server)
    writeMcpState(next)
    process.stdout.write(`Added MCP server ${server.name} at ${server.url ?? server.command}\n`)
    process.exit(0)
  }
  if (command === 'remove') {
    const name = commandArgs[1]
    const scope = optionValue(commandArgs, '--scope')
    if (!name || (scope !== 'user' && scope !== 'project')) process.exit(2)
    writeMcpState(state.filter((server) => server.name !== name || server.scope !== scope))
    process.stdout.write(`Removed MCP server ${name}\n`)
    process.exit(0)
  }
  if (command === 'enable' || command === 'disable') {
    const name = commandArgs[1]
    if (!name) process.exit(2)
    writeMcpState(state.map((server) => server.name === name
      ? { ...server, enabled: command === 'enable' }
      : server))
    process.stdout.write(`${command === 'enable' ? 'Enabled' : 'Disabled'} MCP server ${name}\n`)
    process.exit(0)
  }
  if (command === 'doctor' && commandArgs.includes('--json')) {
    const marker = process.env.GROKBUILD_MOCK_MCP_DOCTOR_MARKER
    if (marker) {
      mkdirSync(dirname(marker), { recursive: true })
      writeFileSync(marker, 'doctor launched')
    }
    const name = commandArgs.find((value, index) => index > 0 && value !== '--json')
    const selected = name ? state.filter((server) => server.name === name) : state
    const canary = mcpCanary()
    const servers = selected.map((server) => ({
      name: server.name,
      transport: server.command ? 'stdio' : server.type === 'sse' ? 'sse' : 'http',
      target: server.command
        ? [server.command, ...(server.args ?? [])].join(' ')
        : server.url,
      source: server.scope === 'project'
        ? `/Users/${canary}/workspace/.grok/config.toml`
        : '~/.grok/config.toml',
      checks: [
        { label: 'server started', passed: true, detail: `started with ${canary}` },
        { label: 'handshake OK', passed: true, detail: canary },
        { label: '3 tools discovered', passed: true, detail: canary }
      ],
      healthy: true
    }))
    process.stdout.write(`${JSON.stringify({
      sources: [
        {
          path: `/Users/${canary}/workspace/.grok/config.toml`,
          status: { status: 'found', server_count: selected.length }
        }
      ],
      servers,
      healthy_count: servers.length,
      failing_count: 0
    }, null, 2)}\n`)
    process.exit(0)
  }
  process.stderr.write(`unsupported qa mcp command: ${commandArgs.join(' ')}\n`)
  process.exit(2)
}

function parseMcpAdd(commandArgs) {
  const transport = optionValue(commandArgs, '--transport') ?? 'stdio'
  const scope = optionValue(commandArgs, '--scope') ?? 'user'
  const environment = {}
  const headers = {}
  const positional = []
  let commandAndArgs
  for (let index = 1; index < commandArgs.length; index += 1) {
    const value = commandArgs[index]
    if (value === '--') {
      commandAndArgs = commandArgs.slice(index + 1)
      break
    }
    if (value === '--transport' || value === '--scope') {
      index += 1
      continue
    }
    if (value === '-e') {
      const entry = commandArgs[++index] ?? ''
      const separator = entry.indexOf('=')
      if (separator > 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1)
      continue
    }
    if (value === '-H') {
      const entry = commandArgs[++index] ?? ''
      const separator = entry.indexOf(':')
      if (separator > 0) headers[entry.slice(0, separator)] = entry.slice(separator + 1).trimStart()
      continue
    }
    positional.push(value)
  }
  const name = positional[0]
  if (!name || (scope !== 'user' && scope !== 'project')) process.exit(2)
  if (transport === 'stdio') {
    const command = commandAndArgs?.[0]
    if (!command) process.exit(2)
    return {
      name,
      scope,
      enabled: true,
      command,
      args: commandAndArgs.slice(1),
      ...(Object.keys(environment).length > 0 ? { env: environment } : {})
    }
  }
  const url = positional[1]
  if (!url || (transport !== 'http' && transport !== 'sse')) process.exit(2)
  return {
    name,
    scope,
    enabled: true,
    url,
    ...(transport === 'sse' ? { type: 'sse' } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {})
  }
}

function optionValue(values, option) {
  const index = values.indexOf(option)
  return index >= 0 ? values[index + 1] : undefined
}

function readMcpState() {
  const path = process.env.GROKBUILD_MOCK_MCP_STATE
  if (path && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  const canary = mcpCanary()
  return [{
    name: 'qa-seeded',
    scope: 'user',
    enabled: true,
    command: `/Users/${canary}/bin/npx`,
    args: ['--token', canary],
    env: { QA_SECRET: canary },
    oauth: { client_secret: canary }
  }]
}

function writeMcpState(state) {
  const path = process.env.GROKBUILD_MOCK_MCP_STATE
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2))
}

function mcpCanary() {
  return process.env.GROKBUILD_MOCK_MCP_CANARY ?? 'QA_MCP_SECRET_CANARY_41F7'
}

const profiles = {
  default: {
    currentModelId: 'grok-4.6',
    availableModels: [
      { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { totalContextTokens: 500_000 } },
      { modelId: 'grok-composer-2.5-fast', name: 'Composer Fast', _meta: { totalContextTokens: 500_000 } }
    ],
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Agent' },
      { id: 'plan', name: 'Plan' },
      { id: 'ask', name: 'Ask' }
    ],
    contextUsed: 28_000,
    contextLimit: 500_000,
    resultText: 'GROKBUILD_QA_OK'
  },
  'capability-truth': {
    currentModelId: 'qa-solo-131k',
    availableModels: [
      { modelId: 'qa-solo-131k', name: 'QA Solo 131K', _meta: { totalContextTokens: 131_072 } }
    ],
    currentModeId: 'ask',
    availableModes: [{ id: 'ask', name: 'Ask only' }],
    contextUsed: 12_345,
    contextLimit: 131_072,
    resultText: 'CAPABILITY_TRUTH_OK'
  }
}
profiles['auth-required-once'] = profiles.default
profiles['initialize-failure'] = profiles.default
profiles['fork-method-not-found'] = profiles.default
profiles['fork-wrong-id'] = profiles.default
profiles['fork-load-failure'] = profiles.default
profiles['fork-nested-response'] = profiles.default

const profileName = process.env.GROKBUILD_MOCK_PROFILE ?? 'default'
const profile = profiles[profileName]
if (!profile) {
  process.stderr.write(`unknown GROKBUILD_MOCK_PROFILE: ${profileName}\n`)
  process.exit(2)
}

const scenario = loadScenario(process.env.GROKBUILD_MOCK_SCENARIO)
const expectedClientFrames = scenario?.steps
  .flatMap((step) => step.expectClient ? [step.expectClient] : []) ?? []
let expectedClientFrameIndex = 0
let sessionCounter = 0
const pendingPermissions = new Map()
const pendingInteractions = new Map()
const pendingTerminalRequests = new Map()
const pendingFsRequests = new Map()
const forkedSessionIds = new Set()

function send(message) {
  record('agent->client', message)
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function record(direction, message) {
  if (!process.env.GROKBUILD_MOCK_TRANSCRIPT) return
  appendFileSync(process.env.GROKBUILD_MOCK_TRANSCRIPT, `${JSON.stringify({ direction, frame: message })}\n`)
}

record('process', { argv: args })

function update(sessionId, value) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } })
}

function completePrompt(id, sessionId) {
  update(sessionId, {
    sessionUpdate: 'usage_update',
    usage: { used: profile.contextUsed, limit: profile.contextLimit }
  })
  send({
    jsonrpc: '2.0',
    id,
    result: {
      stopReason: 'end_turn',
      _meta: {
        totalTokens: profile.contextUsed,
        usage: {
          inputTokens: 11_954,
          outputTokens: 36,
          cachedReadTokens: 7_639,
          reasoningTokens: 0,
          totalTokens: 11_990
        },
        token: 'QA_USAGE_SECRET_CANARY_73D2',
        path: '/private/QA_USAGE_SECRET_CANARY_73D2'
      }
    }
  })
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  record('client->agent', message)

  if (message.method && !assertExpectedClientFrame(message)) return

  const pendingPermission = !message.method
    ? pendingPermissions.get(String(message.id))
    : undefined
  if (pendingPermission) {
    const selected = message.result?.outcome?.optionId ?? 'unknown'
    update(pendingPermission.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: `Permission ${pendingPermission.requestId} resolved with ${selected}.`
      }
    })
    pendingPermissions.delete(pendingPermission.requestId)
    if (pendingPermissions.size === 0) {
      completePrompt(pendingPermission.promptId, pendingPermission.sessionId)
    }
    return
  }

  const pendingInteraction = !message.method
    ? pendingInteractions.get(String(message.id))
    : undefined
  if (pendingInteraction) {
    const result = message.result ?? {}
    const summary = pendingInteraction.kind === 'plan'
      ? `Plan resolved: ${result.outcome}${result.feedback ? ` (${result.feedback})` : ''}.`
      : `Question resolved: ${JSON.stringify(result)}.`
    update(pendingInteraction.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: summary }
    })
    pendingInteractions.delete(String(message.id))
    clearPersistedInteraction(String(message.id))
    if (pendingInteraction.promptId !== undefined) {
      completePrompt(pendingInteraction.promptId, pendingInteraction.sessionId)
    } else {
      update(pendingInteraction.sessionId, { sessionUpdate: 'turn_complete' })
    }
    return
  }

  const pendingTerminal = !message.method
    ? pendingTerminalRequests.get(String(message.id))
    : undefined
  if (pendingTerminal) {
    pendingTerminalRequests.delete(String(message.id))
    continueTerminalRoundTrip(pendingTerminal, message)
    return
  }

  const pendingFs = !message.method
    ? pendingFsRequests.get(String(message.id))
    : undefined
  if (pendingFs) {
    pendingFsRequests.delete(String(message.id))
    continueFsRoundTrip(pendingFs, message)
    return
  }

  switch (message.method) {
    case 'initialize':
      if (profileName === 'auth-required-once' && consumeFirstFailureMarker()) {
        const canary = process.env.GROKBUILD_MOCK_FAILURE_CANARY ?? 'QA_RETRY_SECRET_CANARY_8A31'
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: 401,
            message: `Authentication required ${canary} at /private/${canary}/auth.json`,
            data: { authorization: `Bearer ${canary}`, path: `/private/${canary}` }
          }
        })
        break
      }
      if (profileName === 'initialize-failure') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'Deterministic initialize failure' }
        })
        break
      }
      if (process.env.GROKBUILD_MOCK_FAIL_INITIALIZE === '1') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'Deterministic initialize failure' }
        })
        break
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          modelState: {
            currentModelId: profile.currentModelId,
            availableModels: profile.availableModels
          }
        }
      })
      break
    case 'session/new': {
      const sessionId = `00000000-0000-4000-8000-${String(++sessionCounter).padStart(12, '0')}`
      if (process.env.GROKBUILD_MOCK_LOAD_MODE === 'stale-race') {
        update('stale-session', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'STALE_SESSION_RACE_CANARY' }
        })
        send({
          jsonrpc: '2.0',
          method: '_x.ai/session_notification',
          params: {
            method: 'x.ai/session_notification',
            params: {
              sessionId: 'stale-session',
              update: { sessionUpdate: 'current_mode_update', currentModeId: 'yolo' }
            }
          }
        })
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          sessionId,
          currentModeId: profile.currentModeId,
          availableModes: profile.availableModes
        }
      })
      break
    }
    case 'x.ai/session/fork': {
      if (profileName === 'fork-method-not-found') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: 'Unsupported fork QA_FORK_SECRET_CANARY_61C4',
            data: { path: '/private/QA_FORK_SECRET_CANARY_61C4' }
          }
        })
        break
      }
      const requestedSessionId = message.params?.newSessionId
      const sourceSessionId = message.params?.sourceSessionId
      const newSessionId = profileName === 'fork-wrong-id'
        ? '00000000-0000-4000-8000-000000000099'
        : requestedSessionId
      forkedSessionIds.add(newSessionId)
      const result = {
        newSessionId,
        chatMessagesCopied: 4,
        updatesCopied: 8,
        planStateCopied: true,
        newCwd: message.params?.newCwd,
        parentSessionId: sourceSessionId,
        ...(message.params?.newModelId ? { newModelId: message.params.newModelId } : {})
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: profileName === 'fork-nested-response' ? { result } : result
      })
      break
    }
    case 'session/load': {
      const sessionId = message.params?.sessionId
      const loadMode = process.env.GROKBUILD_MOCK_LOAD_MODE ?? 'ok'
      if (profileName === 'fork-load-failure' && forkedSessionIds.has(sessionId)) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32000,
            message: 'Fork child load failed QA_FORK_SECRET_CANARY_61C4',
            data: { path: '/private/QA_FORK_SECRET_CANARY_61C4' }
          }
        })
        break
      }
      if (loadMode === 'stale' || loadMode === 'stale-race') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32000,
            message: 'Path not found.',
            data: { code: 'FS_NOT_FOUND' }
          }
        })
        break
      }
      if (loadMode === 'fatal') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'Authentication expired.' }
        })
        break
      }
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'REPLAY_MUST_NOT_RENDER' },
        _meta: { isReplay: true }
      })
      update(sessionId, {
        sessionUpdate: 'usage_update',
        usage: { used: profile.contextUsed, limit: profile.contextLimit },
        _meta: { isReplay: true }
      })
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          currentModeId: profile.currentModeId,
          availableModes: profile.availableModes
        }
      })
      replayPersistedInteraction(sessionId)
      break
    }
    case 'session/set_model':
    case 'session/set_mode':
      send({ jsonrpc: '2.0', id: message.id, result: {} })
      break
    case 'session/prompt': {
      const text = message.params?.prompt?.map((part) => part.text ?? '').join('') ?? ''
      const sessionId = message.params?.sessionId
      if (profileName === 'capability-truth') {
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: profile.resultText }
        })
        completePrompt(message.id, sessionId)
        break
      }
      // Turn-integrity scenarios run before the shared thought chunk so the
      // narration cases produce exactly the transcript shape under test.
      if (/narrate with tools/i.test(text)) {
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'qa-narrate-tool',
          title: 'list_dir',
          rawInput: '{"path":"."}'
        })
        update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'qa-narrate-tool',
          status: 'completed',
          rawOutput: { summary: 'Listed the workspace.' }
        })
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Scanning the assets folder... one moment. Done: nothing matched.' }
        })
        completePrompt(message.id, sessionId)
        break
      }
      if (/narrate without tools/i.test(text)) {
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Sure — scanning the assets folder... one moment.\n\nDone: nothing matched.' }
        })
        completePrompt(message.id, sessionId)
        break
      }
      if (/answer without narration/i.test(text)) {
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'A tuple is an ordered, fixed-length sequence.' }
        })
        completePrompt(message.id, sessionId)
        break
      }
      if (/generate an escaped image/i.test(text)) {
        // A real image file that sits OUTSIDE the trusted generated-image
        // root: the boundary must reject it even though the bytes exist.
        const escapedPath = join(process.cwd(), 'qa-escaped.png')
        writeFileSync(escapedPath, Buffer.from(QA_PNG_BASE64, 'base64'))
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'qa-escaped-image-tool',
          title: 'image_gen',
          rawInput: { prompt: 'an out-of-root swatch', aspect_ratio: '1:1' }
        })
        update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'qa-escaped-image-tool',
          status: 'completed',
          rawOutput: {
            type: 'ImageGen',
            path: escapedPath,
            filename: 'qa-escaped.png',
            session_folder: 'images'
          }
        })
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Reported an out-of-root image.' }
        })
        completePrompt(message.id, sessionId)
        break
      }
      if (/generate an image/i.test(text)) {
        const imageDirectory = join(process.cwd(), '.grok-generated')
        mkdirSync(imageDirectory, { recursive: true })
        const imagePath = join(imageDirectory, 'qa-generated.png')
        writeFileSync(imagePath, Buffer.from(QA_PNG_BASE64, 'base64'))
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'qa-image-tool',
          title: 'image_gen',
          rawInput: { prompt: 'a quality assurance swatch', aspect_ratio: '1:1' }
        })
        update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'qa-image-tool',
          title: 'imagine: a quality assurance swatch',
          status: 'completed',
          rawOutput: {
            type: 'ImageGen',
            path: imagePath,
            filename: 'qa-generated.png',
            session_folder: 'images'
          }
        })
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Generated one image.' }
        })
        completePrompt(message.id, sessionId)
        break
      }
      update(sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Checking the workspace contract.' }
      })
      if (/permission/i.test(text)) {
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'qa-write-tool',
          title: 'Write qa-result.txt',
          rawInput: '{"path":"qa-result.txt"}'
        })
        emitPermission('qa-permission-1', 'Allow writing qa-result.txt?', message.id, sessionId)
        if (/queue/i.test(text)) {
          emitPermission('qa-permission-2', 'Allow running the QA check?', message.id, sessionId)
          // An exact duplicate frame must not overwrite or duplicate the queued request.
          emitPermission('qa-permission-2', 'Allow running the QA check?', message.id, sessionId, true)
        }
        break
      }
      if (/plan approve/i.test(text)) {
        emitPlanInteraction('qa-plan-1', message.id, sessionId, false)
        break
      }
      if (/plan changes/i.test(text)) {
        emitPlanInteraction('qa-plan-2', message.id, sessionId, true)
        break
      }
      if (/plan abandon/i.test(text)) {
        emitPlanInteraction('qa-plan-3', message.id, sessionId, false)
        break
      }
      if (/question plan/i.test(text)) {
        emitQuestionInteraction('qa-question-plan', message.id, sessionId, true, true, {
          mode: 'plan',
          includeSecondQuestion: true
        })
        break
      }
      if (/question reconnect/i.test(text)) {
        emitQuestionInteraction('qa-question-reconnect', message.id, sessionId, false, true, {
          mode: 'plan',
          includeSecondQuestion: true,
          persist: true
        })
        break
      }
      if (/question remote (direct|underscored|wrapped)/i.test(text)) {
        const style = /wrapped/i.test(text)
          ? 'wrapped'
          : /underscored/i.test(text)
            ? 'underscored'
            : 'direct'
        const requestId = `qa-question-remote-${style}`
        emitQuestionInteraction(requestId, message.id, sessionId, false)
        emitInteractionResolved(requestId, sessionId, style)
        pendingInteractions.delete(requestId)
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Question ${style} was resolved remotely.` }
        })
        completePrompt(message.id, sessionId)
        break
      }
      if (/question (choice|other|cancel|default)/i.test(text)) {
        emitQuestionInteraction(
          'qa-question-1',
          message.id,
          sessionId,
          /other/i.test(text),
          !/default/i.test(text)
        )
        break
      }
      if (/terminal host/i.test(text)) {
        emitTerminalCreate(message.id, sessionId)
        break
      }
      if (/filesystem host/i.test(text)) {
        emitFsWrite(message.id, sessionId)
        break
      }
      if (/usage sources/i.test(text)) {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            _meta: { totalTokens: 32_100 },
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Metering sources received.' },
              _meta: {
                usage: {
                  inputTokens: 1_500,
                  outputTokens: 200,
                  cachedReadTokens: 1_000,
                  reasoningTokens: 75
                },
                token: 'QA_USAGE_SECRET_CANARY_73D2'
              }
            }
          }
        })
        send({
          jsonrpc: '2.0',
          method: 'x.ai/session_notification',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'turn_completed',
              usage: {
                prompt_tokens: 120,
                completion_tokens: 9,
                prompt_tokens_details: { cached_tokens: 40 }
              }
            }
          }
        })
        send({
          jsonrpc: '2.0',
          method: '_x.ai/session_notification',
          params: {
            method: 'x.ai/session_notification',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'response_completed',
                usage: {
                  input_tokens: 150,
                  output_tokens: 7,
                  cache_read_input_tokens: 50,
                  reasoning_tokens: 3
                }
              }
            }
          }
        })
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { stopReason: 'end_turn' }
        })
        break
      }
      if (/mode update/i.test(text)) {
        send({
          jsonrpc: '2.0',
          method: '_x.ai/session_notification',
          params: {
            method: 'x.ai/session_notification',
            params: {
              sessionId,
              update: { sessionUpdate: 'current_mode_update', currentModeId: 'yolo' }
            }
          }
        })
        update(sessionId, {
          sessionUpdate: 'current_mode_update',
          currentModeId: 'plan'
        })
        completePrompt(message.id, sessionId)
        break
      }
      if (/activity projection/i.test(text)) {
        emitActivityProjection(message.id, sessionId)
        break
      }
      update(sessionId, {
        sessionUpdate: 'hook_execution',
        event_name: 'user_prompt_submit',
        runs: [{
          command: 'QA_HOOK_SECRET_CANARY_2E77',
          env: { XAI_API_KEY: `xai-${'QA_HOOK_SECRET_CANARY_2E77'}` },
          path: '/private/QA_HOOK_SECRET_CANARY_2E77',
          token: 'QA_HOOK_SECRET_CANARY_2E77'
        }]
      })
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I inspected the project. ' }
      })
      update(sessionId, {
        sessionUpdate: 'hook_execution',
        eventName: 'pre_tool_use',
        runs: [{
          command: 'cat /private/QA_HOOK_SECRET_CANARY_2E77',
          output: 'QA_HOOK_SECRET_CANARY_2E77'
        }]
      })
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'qa-read-tool',
        title: 'Read package.json',
        rawInput: '{"path":"package.json"}'
      })
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'qa-read-tool',
        status: 'completed',
        rawOutput: 'package.json inspected'
      })
      update(sessionId, {
        sessionUpdate: 'hook_execution',
        event_name: 'post_tool_use',
        runs: [{ output: 'QA_HOOK_SECRET_CANARY_2E77' }]
      })
      update(sessionId, {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect the project', status: 'completed' },
          { content: 'Report a deterministic result', status: 'in_progress' }
        ]
      })
      update(sessionId, {
        sessionUpdate: 'hook_execution',
        event_name: 'stop',
        runs: [
          { env: { TOKEN: 'QA_HOOK_SECRET_CANARY_2E77' } },
          { path: '/private/QA_HOOK_SECRET_CANARY_2E77' },
          { command: 'QA_HOOK_SECRET_CANARY_2E77' }
        ]
      })
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: profile.resultText }
      })
      completePrompt(message.id, sessionId)
      break
    }
    case 'session/cancel':
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} })
      break
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown QA method ${message.method}` } })
      }
  }
})

function consumeFirstFailureMarker() {
  const marker = process.env.GROKBUILD_MOCK_RETRY_MARKER
  if (!marker) return true
  if (existsSync(marker)) return false
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, 'failed once')
  return true
}

function emitPermission(requestId, title, promptId, sessionId, duplicate = false) {
  send({
    jsonrpc: '2.0',
    id: requestId,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: {
        toolCallId: requestId,
        title,
        description: 'The deterministic QA agent requests one local action.'
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
      ]
    }
  })
  if (!duplicate) pendingPermissions.set(requestId, { requestId, promptId, sessionId })
}

function emitPlanInteraction(requestId, promptId, sessionId, wrapped) {
  const params = {
    sessionId,
    toolCallId: requestId,
    planContent: '# QA plan\n\n1. Inspect the project\n2. Apply the requested change'
  }
  send(wrapped
    ? {
        jsonrpc: '2.0',
        id: requestId,
        method: '_x.ai/exit_plan_mode',
        params: { method: 'x.ai/exit_plan_mode', params }
      }
    : { jsonrpc: '2.0', id: requestId, method: '_x.ai/exit_plan_mode', params })
  pendingInteractions.set(requestId, { kind: 'plan', promptId, sessionId })
}

function emitQuestionInteraction(requestId, promptId, sessionId, wrapped, includeMode = true, options = {}) {
  const params = {
    sessionId,
    toolCallId: requestId,
    questions: [
      {
        question: 'Which implementation should Grok use?',
        options: [
          { label: 'React', description: 'Use React components.', preview: '<ReactPreview />' },
          { label: 'Vue', description: 'Use Vue components.' }
        ],
        multiSelect: false
      },
      ...(options.includeSecondQuestion
        ? [{
            question: 'Which checks should Grok run?',
            options: [
              { label: 'Tests', description: 'Run the test suite.' },
              { label: 'Lint', description: 'Run static checks.' }
            ],
            multiSelect: true
          }]
        : [])
    ]
  }
  if (includeMode) params.mode = options.mode ?? 'default'
  send(wrapped
    ? {
        jsonrpc: '2.0',
        id: requestId,
        method: '_x.ai/ask_user_question',
        params: { method: 'x.ai/ask_user_question', params }
      }
    : { jsonrpc: '2.0', id: requestId, method: 'x.ai/ask_user_question', params })
  pendingInteractions.set(requestId, { kind: 'question', promptId, sessionId })
  if (options.persist) persistInteraction({ kind: 'question', requestId, sessionId, options })
}

function emitInteractionResolved(requestId, sessionId, style) {
  const params = {
    sessionId,
    update: { sessionUpdate: 'interaction_resolved', tool_call_id: requestId }
  }
  send(style === 'wrapped'
    ? {
        jsonrpc: '2.0',
        method: '_x.ai/session_notification',
        params: { method: 'x.ai/session_notification', params }
      }
    : {
        jsonrpc: '2.0',
        method: style === 'underscored' ? '_x.ai/session_notification' : 'x.ai/session_notification',
        params
      })
}

function emitActivityProjection(promptId, sessionId) {
  const privateCanary = 'QA_ACTIVITY_PRIVATE_CANARY_4E19'
  send({
    jsonrpc: '2.0',
    method: 'x.ai/session_notification',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'scheduled_task_created',
        task_id: `scheduled-${privateCanary}`,
        task_snapshot: {
          prompt: 'Run focused checks',
          human_schedule: 'Every hour',
          next_fire_at: '2026-08-25T09:00:00.000Z'
        },
        _meta: {
          'x.ai/schedulerGeneration': '9',
          'x.ai/schedulerRevision': '2'
        }
      }
    }
  })
  send({
    jsonrpc: '2.0',
    method: '_x.ai/session_notification',
    params: {
      method: 'x.ai/session_notification',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'subagent_spawned',
          subagent_id: `subagent-${privateCanary}`,
          name: 'QA reviewer'
        }
      }
    }
  })
  send({
    jsonrpc: '2.0',
    method: 'x.ai/session_notification',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'workflow_updated',
        run_id: `workflow-${privateCanary}`,
        revision: '2',
        name: 'Release confidence',
        objective: 'Verify the desktop build',
        status: 'active',
        current_phase: 'Contract checks',
        agent_budget: 8,
        agents_used: 3,
        active_agents: ['reviewer']
      }
    }
  })
  send({
    jsonrpc: '2.0',
    method: 'x.ai/session_notification',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'goal_updated',
        goal_id: `goal-${privateCanary}`,
        objective: 'Ship the verified desktop app',
        status: 'active',
        phase: 'Verification',
        token_budget: 120000,
        tokens_used: 42000,
        active_agents: ['reviewer']
      }
    }
  })
  // Malformed activity is counted but none of its raw fields may cross the
  // semantic projection boundary.
  send({
    jsonrpc: '2.0',
    method: 'x.ai/session_notification',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'scheduled_task_created',
        path: `/private/${privateCanary}`,
        token: privateCanary,
        command: `cat /private/${privateCanary}`
      }
    }
  })
  // Lower scheduler/workflow revisions must not regress the live view.
  send({
    jsonrpc: '2.0',
    method: 'x.ai/session_notification',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'scheduled_task_created',
        task_id: `scheduled-${privateCanary}`,
        task_snapshot: { prompt: 'STALE ACTIVITY LABEL' },
        _meta: {
          'x.ai/schedulerGeneration': '9',
          'x.ai/schedulerRevision': '1'
        }
      }
    }
  })
  send({
    jsonrpc: '2.0',
    method: 'x.ai/session_notification',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'workflow_updated',
        run_id: `workflow-${privateCanary}`,
        revision: '1',
        name: 'STALE WORKFLOW LABEL',
        status: 'failed'
      }
    }
  })
  send({
    jsonrpc: '2.0',
    method: '_x.ai/session_notification',
    params: {
      method: 'x.ai/session_notification',
      params: {
        sessionId: '00000000-0000-4000-8000-999999999999',
        update: {
          sessionUpdate: 'goal_updated',
          goal_id: 'wrong-session-goal',
          objective: `WRONG SESSION ${privateCanary}`,
          status: 'active'
        }
      }
    }
  })
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Session activity projection received.' }
  })
  completePrompt(promptId, sessionId)
}

function persistInteraction(value) {
  if (!process.env.GROKBUILD_MOCK_PENDING_STATE) return
  writeFileSync(process.env.GROKBUILD_MOCK_PENDING_STATE, JSON.stringify(value))
}

function clearPersistedInteraction(requestId) {
  const path = process.env.GROKBUILD_MOCK_PENDING_STATE
  if (!path || !existsSync(path)) return
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value.requestId === requestId) unlinkSync(path)
  } catch {
    unlinkSync(path)
  }
}

function replayPersistedInteraction(sessionId) {
  const path = process.env.GROKBUILD_MOCK_PENDING_STATE
  if (!path || !existsSync(path)) return
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value.kind !== 'question') return
  emitQuestionInteraction(value.requestId, undefined, sessionId, false, true, {
    ...value.options,
    persist: false
  })
}

function emitTerminalCreate(promptId, sessionId) {
  const id = 'qa-terminal-create'
  send({
    jsonrpc: '2.0',
    id,
    method: 'terminal/create',
    params: {
      sessionId,
      command: "/bin/bash -lc 'printf TERMINAL_HOST_QA_OK'",
      outputByteLimit: 100
    }
  })
  pendingTerminalRequests.set(id, { stage: 'create', promptId, sessionId })
}

function continueTerminalRoundTrip(pending, message) {
  if (message.error) {
    update(pending.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Terminal host error: ${message.error.code}.` }
    })
    completePrompt(pending.promptId, pending.sessionId)
    return
  }
  if (pending.stage === 'create') {
    const terminalId = message.result?.terminalId
    const id = 'qa-terminal-wait'
    send({
      jsonrpc: '2.0',
      id,
      method: 'terminal/wait_for_exit',
      params: { sessionId: pending.sessionId, terminalId }
    })
    pendingTerminalRequests.set(id, { ...pending, stage: 'wait', terminalId })
    return
  }
  if (pending.stage === 'wait') {
    const id = 'qa-terminal-output'
    send({
      jsonrpc: '2.0',
      id,
      method: 'terminal/output',
      params: { sessionId: pending.sessionId, terminalId: pending.terminalId }
    })
    pendingTerminalRequests.set(id, { ...pending, stage: 'output' })
    return
  }
  if (pending.stage === 'output') {
    const id = 'qa-terminal-release'
    send({
      jsonrpc: '2.0',
      id,
      method: 'terminal/release',
      params: { sessionId: pending.sessionId, terminalId: pending.terminalId }
    })
    pendingTerminalRequests.set(id, {
      ...pending,
      stage: 'release',
      output: message.result?.output ?? ''
    })
    return
  }
  update(pending.sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `Terminal host returned ${pending.output}.` }
  })
  completePrompt(pending.promptId, pending.sessionId)
}

function emitFsWrite(promptId, sessionId) {
  const id = 'qa-fs-write'
  const path = resolve(process.cwd(), 'grokbuild-fs-host-qa.txt')
  send({
    jsonrpc: '2.0',
    id,
    method: 'fs/write_text_file',
    params: { sessionId, path, content: 'FILESYSTEM_HOST_QA_OK' }
  })
  pendingFsRequests.set(id, { stage: 'write', promptId, sessionId, path })
}

function continueFsRoundTrip(pending, message) {
  if (message.error) {
    update(pending.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Filesystem host error: ${message.error.code}.` }
    })
    completePrompt(pending.promptId, pending.sessionId)
    return
  }
  if (pending.stage === 'write') {
    const id = 'qa-fs-read'
    send({
      jsonrpc: '2.0',
      id,
      method: 'fs/read_text_file',
      params: { sessionId: pending.sessionId, path: pending.path }
    })
    pendingFsRequests.set(id, { ...pending, stage: 'read' })
    return
  }
  update(pending.sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `Filesystem host returned ${message.result?.content ?? ''}.` }
  })
  completePrompt(pending.promptId, pending.sessionId)
}

input.on('close', () => {
  if (scenario && expectedClientFrameIndex < expectedClientFrames.length) {
    const expected = expectedClientFrames[expectedClientFrameIndex]
    process.stderr.write(
      `QA scenario ${scenario.id} ended before client request ${expectedClientFrameIndex + 1}: ${expected.method}\n`
    )
    process.exitCode = 2
  }
})

function loadScenario(path) {
  if (!path) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || !Array.isArray(value.steps) || typeof value.id !== 'string') {
      throw new Error('scenario must contain an id and steps array')
    }
    return value
  } catch (error) {
    process.stderr.write(
      `failed to load GROKBUILD_MOCK_SCENARIO ${path}: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(2)
  }
}

function assertExpectedClientFrame(message) {
  if (!scenario) return true
  const expected = expectedClientFrames[expectedClientFrameIndex]
  if (!expected) {
    // A graceful app shutdown always sends this ACP notification after the scenario is complete.
    if (message.method === 'session/cancel') return true
    return failScenario(message, `unexpected extra client method ${message.method}`)
  }
  if (message.jsonrpc !== '2.0') {
    return failScenario(message, `request ${expectedClientFrameIndex + 1} omitted jsonrpc 2.0`)
  }
  if (message.method !== expected.method) {
    return failScenario(
      message,
      `request ${expectedClientFrameIndex + 1} expected ${expected.method}, received ${message.method}`
    )
  }
  const { method: _method, params: nestedParams, ...shorthandParams } = expected
  const expectedParams = { ...shorthandParams, ...(nestedParams ?? {}) }
  const mismatch = findSubsetMismatch(expectedParams, message.params, 'params')
  if (mismatch) return failScenario(message, mismatch)
  expectedClientFrameIndex += 1
  return true
}

function failScenario(message, detail) {
  const text = `QA scenario ${scenario.id} failed: ${detail}`
  process.stderr.write(`${text}\n`)
  process.exitCode = 2
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: text } })
  }
  return false
}

function findSubsetMismatch(expected, actual, path) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path} expected an array`
    if (actual.length !== expected.length) {
      return `${path} expected ${expected.length} item(s), received ${actual.length}`
    }
    for (let index = 0; index < expected.length; index += 1) {
      const mismatch = findSubsetMismatch(expected[index], actual[index], `${path}[${index}]`)
      if (mismatch) return mismatch
    }
    return undefined
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return `${path} expected an object`
    }
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in actual)) return `${path}.${key} is missing`
      const mismatch = findSubsetMismatch(value, actual[key], `${path}.${key}`)
      if (mismatch) return mismatch
    }
    return undefined
  }
  return Object.is(expected, actual)
    ? undefined
    : `${path} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
}
