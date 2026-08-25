import { createServer, type Server } from 'node:net'
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { BrowserWindow } from 'electron'
import type { AppLogger } from '../logging/AppLogger'

/**
 * Local control plane for driving and inspecting the running app from a
 * terminal (`gbctl`). Listens on a unix domain socket inside userData with
 * mode 0600 — filesystem permissions are the authentication boundary; there
 * is no TCP listener and nothing reachable off-machine.
 *
 * Input injection deliberately uses the internal CDP debugger
 * (Input.dispatchMouseEvent / dispatchKeyEvent / insertText): unlike
 * webContents.sendInputEvent it does not require the window to hold OS
 * focus, so a terminal session can click and type while the user keeps
 * working elsewhere. Reads (tree/state/screenshot) never need focus either.
 */
export interface ControlServerOptions {
  socketPath: string
  screenshotDirectory: string
  appVersion: string
  window: BrowserWindow
  getState: () => unknown
  logger: AppLogger
}

type ControlRequest = { id?: number; cmd?: string; [key: string]: unknown }

const MAX_REQUEST_CHARS = 64 * 1024
const LOG_TAIL_DEFAULT = 100
const LOG_TAIL_MAX = 2_000
const LOG_TAIL_WINDOW_BYTES = 512 * 1024

const KEY_CODES: Record<string, { keyCode: number; text?: string }> = {
  Enter: { keyCode: 13, text: '\r' },
  Escape: { keyCode: 27 },
  Tab: { keyCode: 9, text: '\t' },
  Backspace: { keyCode: 8 },
  Delete: { keyCode: 46 },
  Space: { keyCode: 32, text: ' ' },
  ArrowUp: { keyCode: 38 },
  ArrowDown: { keyCode: 40 },
  ArrowLeft: { keyCode: 37 },
  ArrowRight: { keyCode: 39 },
  Home: { keyCode: 36 },
  End: { keyCode: 35 },
  PageUp: { keyCode: 33 },
  PageDown: { keyCode: 34 }
}

const MODIFIER_BITS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 }

export function startControlServer(options: ControlServerOptions): Server {
  try {
    unlinkSync(options.socketPath)
  } catch {
    // No stale socket to remove.
  }
  const server = createServer((connection) => {
    const lines = createInterface({ input: connection })
    lines.on('line', (line) => {
      void (async () => {
        if (line.length > MAX_REQUEST_CHARS) {
          connection.write(`${JSON.stringify({ ok: false, error: 'Request too large.' })}\n`)
          return
        }
        let request: ControlRequest
        try {
          request = JSON.parse(line) as ControlRequest
        } catch {
          connection.write(`${JSON.stringify({ ok: false, error: 'Invalid JSON request.' })}\n`)
          return
        }
        const response = await execute(options, request)
        connection.write(`${JSON.stringify({ id: request.id, ...response })}\n`)
      })().catch(() => connection.destroy())
    })
    connection.on('error', () => undefined)
  })
  server.on('error', (error) => {
    options.logger.log('error', 'control_server_error', { message: error.message })
  })
  server.listen(options.socketPath, () => {
    try {
      chmodSync(options.socketPath, 0o600)
    } catch {
      // Best effort; the userData directory is already user-only.
    }
    options.logger.log('info', 'control_server_listening', { socketPath: options.socketPath })
  })
  return server
}

async function execute(
  options: ControlServerOptions,
  request: ControlRequest
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const cmd = typeof request.cmd === 'string' ? request.cmd : ''
  options.logger.log('info', 'control_command', { cmd, query: typeof request.query === 'string' ? request.query : undefined })
  try {
    const result = await runCommand(options, cmd, request)
    return { ok: true, result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.logger.log('warn', 'control_command_failed', { cmd, message })
    return { ok: false, error: message }
  }
}

async function runCommand(
  options: ControlServerOptions,
  cmd: string,
  request: ControlRequest
): Promise<unknown> {
  const { window } = options
  switch (cmd) {
    case 'ping':
      return { version: options.appVersion, pid: process.pid, uptimeSeconds: Math.round(process.uptime()) }
    case 'state':
      return options.getState()
    case 'tree':
      return await window.webContents.executeJavaScript(treeScript(request.all === true), true)
    case 'click':
    case 'hover': {
      const target = await locate(window, stringArg(request, 'query'))
      const modifiers = modifierMask(request.modifiers)
      await cdp(window, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: target.x, y: target.y, button: 'none', modifiers
      })
      if (cmd === 'click') {
        const clickCount = request.double === true ? 2 : 1
        for (let press = 0; press < clickCount; press += 1) {
          await cdp(window, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: press + 1, modifiers
          })
          await cdp(window, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: press + 1, modifiers
          })
        }
      }
      return target
    }
    case 'type': {
      const text = stringArg(request, 'text')
      await cdp(window, 'Input.insertText', { text })
      return { inserted: text.length }
    }
    case 'key': {
      const key = stringArg(request, 'key')
      const spec = KEY_CODES[key]
      if (!spec) throw new Error(`Unsupported key "${key}". Supported: ${Object.keys(KEY_CODES).join(', ')}`)
      const modifiers = modifierMask(request.modifiers)
      await cdp(window, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers
      })
      if (spec.text && modifiers === 0) {
        await cdp(window, 'Input.dispatchKeyEvent', { type: 'char', text: spec.text, key, modifiers })
      }
      await cdp(window, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key, code: key, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers
      })
      return { key, modifiers }
    }
    case 'focus': {
      const query = stringArg(request, 'query')
      return await window.webContents.executeJavaScript(focusScript(query), true)
    }
    case 'paste':
      window.webContents.paste()
      return { pasted: true }
    case 'scroll': {
      const deltaY = typeof request.deltaY === 'number' ? request.deltaY : 400
      const query = typeof request.query === 'string' && request.query ? request.query : undefined
      const at = query
        ? await locate(window, query)
        : { x: Math.round(window.getContentBounds().width / 2), y: Math.round(window.getContentBounds().height / 2) }
      await cdp(window, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY, modifiers: 0
      })
      return { x: at.x, y: at.y, deltaY }
    }
    case 'screenshot': {
      const image = await window.webContents.capturePage()
      mkdirSync(options.screenshotDirectory, { recursive: true })
      const path = typeof request.path === 'string' && request.path
        ? request.path
        : join(options.screenshotDirectory, `shot-${Date.now()}.png`)
      writeFileSync(path, image.toPNG())
      const size = image.getSize()
      return { path, width: size.width, height: size.height }
    }
    case 'logs': {
      const requested = typeof request.lines === 'number' ? Math.trunc(request.lines) : LOG_TAIL_DEFAULT
      const lines = Math.min(Math.max(requested, 1), LOG_TAIL_MAX)
      return { path: options.logger.path, lines: tailLines(options.logger.path, lines) }
    }
    default:
      throw new Error(`Unknown command "${cmd}".`)
  }
}

async function cdp(window: BrowserWindow, method: string, params: Record<string, unknown>): Promise<unknown> {
  const dbg = window.webContents.debugger
  if (!dbg.isAttached()) dbg.attach('1.3')
  return await dbg.sendCommand(method, params)
}

async function locate(
  window: BrowserWindow,
  query: string
): Promise<{ x: number; y: number; matchedCount: number; label: string }> {
  const result = (await window.webContents.executeJavaScript(locateScript(query), true)) as
    | { found: false }
    | { found: true; x: number; y: number; matchedCount: number; label: string }
  if (!result.found) throw new Error(`No element matches "${query}". Use the tree command to list targets.`)
  return result
}

function stringArg(request: ControlRequest, name: string): string {
  const value = request[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing "${name}" argument.`)
  return value
}

function modifierMask(value: unknown): number {
  if (!Array.isArray(value)) return 0
  return value.reduce<number>(
    (mask, name) => mask | (MODIFIER_BITS[String(name).toLowerCase()] ?? 0),
    0
  )
}

function tailLines(path: string, count: number): string[] {
  try {
    const content = readFileSync(path, 'utf8')
    const window = content.length > LOG_TAIL_WINDOW_BYTES ? content.slice(-LOG_TAIL_WINDOW_BYTES) : content
    return window.split('\n').filter(Boolean).slice(-count)
  } catch {
    return []
  }
}

/**
 * Renderer-side scripts. They run in the page's main world, only read the
 * DOM (plus scrollIntoView/focus for targeting), and return plain JSON.
 * The query grammar is shared with gbctl: `testid:x`, `css:selector`,
 * `text:y`, or a bare string (testid first, then label/text contains).
 */
function collectorSnippet(): string {
  return `
    const describe = (element) => {
      const rect = element.getBoundingClientRect()
      const text = (element.innerText || element.value || '').trim().replace(/\\s+/g, ' ').slice(0, 80)
      return {
        testid: element.getAttribute('data-testid') || undefined,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || undefined,
        label: element.getAttribute('aria-label') || undefined,
        text: text || undefined,
        disabled: element.disabled === true || undefined,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
      }
    }
    const interactive = () => Array.from(document.querySelectorAll(
      'button, a[href], input, textarea, select, [role="button"], [role="menuitem"], [data-testid]'
    ))
    const visible = (element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const matchesQuery = (element, query) => {
      const info = describe(element)
      const needle = query.toLowerCase()
      return (info.label || '').toLowerCase().includes(needle) ||
        (info.text || '').toLowerCase().includes(needle)
    }
    const CLICKABLE = new Set(['button', 'a', 'input', 'textarea', 'select'])
    const rankTextMatches = (candidates) => candidates
      .map((element) => ({
        element,
        clickable: CLICKABLE.has(element.tagName.toLowerCase()) || element.getAttribute('role') === 'button' ? 0 : 1,
        textLength: ((element.getAttribute('aria-label') || element.innerText || '')).length
      }))
      .sort((a, b) => a.clickable - b.clickable || a.textLength - b.textLength)
      .map((entry) => entry.element)
    const resolve = (query) => {
      if (query.startsWith('testid:')) {
        return [document.querySelector('[data-testid="' + query.slice(7).replace(/"/g, '\\\\"') + '"]')].filter(Boolean)
      }
      if (query.startsWith('css:')) {
        return Array.from(document.querySelectorAll(query.slice(4)))
      }
      const text = query.startsWith('text:') ? query.slice(5) : null
      if (text !== null) return rankTextMatches(interactive().filter((el) => visible(el) && matchesQuery(el, text)))
      const byTestid = document.querySelector('[data-testid="' + query.replace(/"/g, '\\\\"') + '"]')
      if (byTestid) return [byTestid]
      return rankTextMatches(interactive().filter((el) => visible(el) && matchesQuery(el, query)))
    }
  `
}

function treeScript(all: boolean): string {
  return `(() => {
    ${collectorSnippet()}
    const elements = ${all ? 'Array.from(document.querySelectorAll("*"))' : 'interactive()'}
      .filter(visible)
      .slice(0, 500)
      .map(describe)
    return { url: location.hash || '/', count: elements.length, elements }
  })()`
}

function locateScript(query: string): string {
  return `(() => {
    ${collectorSnippet()}
    const matches = resolve(${JSON.stringify(query)})
    const target = matches[0]
    if (!target) return { found: false }
    target.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = target.getBoundingClientRect()
    const info = describe(target)
    return {
      found: true,
      matchedCount: matches.length,
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      label: info.testid || info.label || info.text || info.tag
    }
  })()`
}

function focusScript(query: string): string {
  return `(() => {
    ${collectorSnippet()}
    const target = resolve(${JSON.stringify(query)})[0]
    if (!target) return { found: false }
    target.focus()
    return { found: true, focused: document.activeElement === target }
  })()`
}
