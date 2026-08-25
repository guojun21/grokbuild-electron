#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const cliPath = process.env.GROK_CLI_PATH ?? join(homedir(), '.grok/bin/grok')
await access(cliPath)
const workspace = await mkdtemp(join(tmpdir(), 'grokbuild-real-cli-smoke-'))
const child = spawn(
  cliPath,
  ['--no-memory', 'agent', '--reasoning-effort', 'low', '--model', 'grok-4.6', 'stdio'],
  {
    cwd: workspace,
    env: safeEnvironment(process.env),
    stdio: ['pipe', 'pipe', 'pipe']
  }
)

let nextId = 1
let stderr = ''
const pending = new Map()
const observedMethods = []
const lines = createInterface({ input: child.stdout })
child.once('error', (error) => {
  stderr = `${stderr}\n${error.message}`.slice(-64 * 1024)
  for (const item of pending.values()) {
    clearTimeout(item.timeout)
    item.reject(error)
  }
  pending.clear()
})
lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (typeof message.method === 'string') {
    observedMethods.push(message.method)
    if (message.id !== undefined) {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Smoke client does not implement ${message.method}` }
      })}\n`)
    }
    return
  }
  const request = pending.get(String(message.id))
  if (!request) return
  clearTimeout(request.timeout)
  pending.delete(String(message.id))
  if (message.error) request.reject(new Error(`${message.error.code}: ${message.error.message}`))
  else request.resolve(message.result)
})
child.stderr.on('data', (chunk) => {
  stderr = `${stderr}${chunk.toString('utf8')}`.slice(-64 * 1024)
})

try {
  const initialization = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'grokbuild-electron-real-smoke', version: '0.1.0' },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true
    }
  }, 20_000)
  if (!initialization || typeof initialization !== 'object') {
    throw new Error('initialize returned no capability object')
  }

  const session = await request('session/new', { cwd: workspace, mcpServers: [] }, 30_000)
  const sessionId = session?.sessionId ?? session?.id
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('session/new returned no session id')
  }

  let turnCompleted = false
  if (process.env.GROKBUILD_REAL_TURN === '1') {
    await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply briefly that the ACP smoke connection works. Do not use tools.' }]
    }, 5 * 60_000)
    turnCompleted = true
  }

  notify('session/cancel', { sessionId })
  const version = execFileSync(cliPath, ['--version'], { encoding: 'utf8' }).trim().slice(0, 256)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    version,
    initialized: true,
    sessionCreated: true,
    turnCompleted,
    observedNotificationMethods: [...new Set(observedMethods)].sort()
  }, null, 2)}\n`)
} catch (error) {
  const detail = stderr.trim()
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\nCLI stderr:\n${detail}` : ''}`)
} finally {
  for (const item of pending.values()) {
    clearTimeout(item.timeout)
    item.reject(new Error('Real CLI smoke stopped'))
  }
  pending.clear()
  child.stdin.end()
  if (!(await waitForExit(500))) child.kill('SIGTERM')
  if (!(await waitForExit(2_000))) child.kill('SIGKILL')
  await waitForExit(1_000)
  await rm(workspace, { recursive: true, force: true })
}

function request(method, params, timeoutMs) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(String(id))
      reject(new Error(`${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(String(id), { resolve, reject, timeout })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

function waitForExit(timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timeout)
      child.removeListener('close', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    child.once('close', onExit)
  })
}

function safeEnvironment(source) {
  const allowed = /^(PATH|HOME|USER|LOGNAME|TMPDIR|SHELL|LANG|LC_[A-Z_]+|TZ|TERM|COLORTERM|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|XAI_API_KEY)$/i
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && allowed.test(key))
  )
}
