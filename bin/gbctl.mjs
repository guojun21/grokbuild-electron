#!/usr/bin/env node
// gbctl — drive and inspect the running GrokBuild app without focusing it.
// Talks JSON lines to the app's control socket (<userData>/control.sock).
// See docs/control-cli.md for the command reference.
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Electron derives userData from the package name, not the product name.
const CANDIDATE_SOCKETS = [
  join(homedir(), 'Library/Application Support/grokbuild-electron/control.sock'),
  join(homedir(), 'Library/Application Support/GrokBuild/control.sock')
]
const socketPath = process.env.GBCTL_SOCKET
  ?? CANDIDATE_SOCKETS.find((candidate) => existsSync(candidate))
  ?? CANDIDATE_SOCKETS[0]

const USAGE = `gbctl <command> [args]

  ping                         app version / pid / uptime
  state                        full app state snapshot (JSON)
  sessions                     compact session list from the snapshot
  tree [--all]                 visible interactive elements
  click <query> [--double]     click element (testid:x | text:y | css:sel | bare)
  hover <query>                move pointer onto element (reveals hover UI)
  type <text>                  insert text into the page-focused element
  key <Key> [mod,...]          press key (Enter, Escape, Tab, ArrowDown, ...)
  focus <query>                focus element inside the page
  paste                        paste clipboard into the focused element
  scroll [query] <deltaY>      wheel-scroll at element (or viewport centre)
  screenshot [path]            capture the window to PNG (no focus needed)
  logs [-n N]                  tail the diagnostics log

  Env: GBCTL_SOCKET overrides the control socket path.`

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function request(payload) {
  return new Promise((resolvePromise, reject) => {
    const connection = createConnection(socketPath)
    let buffered = ''
    const timer = setTimeout(() => {
      connection.destroy()
      reject(new Error('Timed out waiting for the app (is GrokBuild running?).'))
    }, 15_000)
    connection.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`Cannot reach GrokBuild control socket at ${socketPath}: ${error.message}`))
    })
    connection.on('data', (chunk) => {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      connection.end()
      try {
        resolvePromise(JSON.parse(buffered.slice(0, newline)))
      } catch {
        reject(new Error('Malformed response from the app.'))
      }
    })
    connection.on('connect', () => {
      connection.write(`${JSON.stringify(payload)}\n`)
    })
  })
}

const [command, ...rest] = process.argv.slice(2)
if (!command || command === 'help' || command === '--help') {
  console.log(USAGE)
  process.exit(0)
}

const payload = { cmd: command }
switch (command) {
  case 'ping':
  case 'state':
  case 'paste':
    break
  case 'sessions':
    payload.cmd = 'state'
    break
  case 'tree':
    if (rest.includes('--all')) payload.all = true
    break
  case 'click':
  case 'hover':
  case 'focus': {
    const query = rest.filter((arg) => !arg.startsWith('--'))[0]
    if (!query) fail(`Usage: gbctl ${command} <query>`)
    payload.query = query
    if (rest.includes('--double')) payload.double = true
    break
  }
  case 'type': {
    const text = rest.join(' ')
    if (!text) fail('Usage: gbctl type <text>')
    payload.text = text
    break
  }
  case 'key': {
    const [key, modifiers] = rest
    if (!key) fail('Usage: gbctl key <Key> [meta,shift,...]')
    payload.key = key
    if (modifiers) payload.modifiers = modifiers.split(',')
    break
  }
  case 'scroll': {
    const numeric = rest.findIndex((arg) => /^-?\d+$/.test(arg))
    payload.deltaY = numeric >= 0 ? Number(rest[numeric]) : 400
    const query = rest.filter((_, index) => index !== numeric)[0]
    if (query) payload.query = query
    break
  }
  case 'screenshot':
    if (rest[0]) payload.path = rest[0]
    break
  case 'logs': {
    const flag = rest.indexOf('-n')
    if (flag >= 0 && rest[flag + 1]) payload.lines = Number(rest[flag + 1])
    break
  }
  default:
    fail(`Unknown command "${command}".\n\n${USAGE}`)
}

try {
  const response = await request(payload)
  if (!response.ok) fail(`Error: ${response.error}`)
  let result = response.result
  if (command === 'sessions' && result && typeof result === 'object') {
    const sessions = Array.isArray(result.sessions) ? result.sessions : []
    result = sessions.map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status,
      model: session.model,
      lastError: session.lastError
    }))
  }
  if (command === 'logs' && result && Array.isArray(result.lines)) {
    for (const line of result.lines) console.log(line)
    process.exit(0)
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
