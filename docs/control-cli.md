# gbctl — UI control CLI & diagnostics logging

Research notes and design for driving the running GrokBuild app from a
terminal **without stealing OS focus**, plus the always-on diagnostics log.

## Research: how to inject input without focusing the window

| Approach | Focus needed? | Verdict |
| --- | --- | --- |
| `webContents.sendInputEvent` | **Yes** — docs: "The BrowserWindow containing the contents needs to be focused for sendInputEvent() to work." | Rejected. |
| macOS `CGEvent` / AppleScript clicks | Yes (posts to the frontmost app, needs Accessibility) | Rejected. |
| External `--remote-debugging-port` + Playwright attach | No, but ships an open CDP port in a fuse-hardened production app | Rejected (security). |
| **Internal CDP via `webContents.debugger`** (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`) | **No** — events enter the renderer input pipeline directly; this is the same mechanism Playwright/Puppeteer use to drive background pages | **Chosen.** |

Supporting facts (Electron docs, checked 2026-08-25):

- `capturePage` works while unfocused, occluded, or hidden ("considered
  visible when its browser window is hidden and the capturer count is
  non-zero") — screenshots never need focus.
- `executeJavaScript` runs in the page's main world (the React app world)
  and resolves with the serialized result — used for reading the UI tree
  and element geometry; never for injecting behaviour.
- `webContents.paste()` executes the paste editing command against the
  page-focused element; combined with `focus` + clipboard it reproduces a
  real composer paste. In-page element focus does not require OS focus.
- CDP input coordinates are CSS/viewport pixels, matching
  `getBoundingClientRect` — no `deviceScaleFactor` math.

Known limitation: only one debugger can attach; while DevTools is open the
`click/type/key/scroll` commands report an attach error (read-only commands
still work).

## Transport

A JSON-lines protocol over a **unix domain socket** at
`<userData>/control.sock` (mode 0600). Filesystem permissions are the
authentication boundary: same local user only, no TCP, nothing remote. The
server lives in the main process and starts with the app. Every command is
written to the diagnostics log.

Request: `{"id":1,"cmd":"click","query":"testid:tool-card"}`
Response: `{"id":1,"ok":true,"result":{...}}`

## Commands

| Command | Args | Effect |
| --- | --- | --- |
| `ping` | — | version, pid, uptime |
| `state` | — | full AppController snapshot (sessions, statuses, errors) |
| `tree` | `all?` | interactive elements: testid, role, label, text, rect, disabled |
| `click` | `query`, `double?` | CDP mouse press/release at element centre |
| `type` | `text` | CDP `Input.insertText` into the page-focused element |
| `key` | `key` (Enter/Escape/Tab/…), `modifiers?` | CDP raw key down/up |
| `focus` | `query` | in-page `element.focus()` |
| `paste` | — | `webContents.paste()` (clipboard → focused element) |
| `scroll` | `query?`, `deltaY` | CDP mouse wheel at element (or viewport) centre |
| `screenshot` | `path?` | `capturePage` PNG, focus-free |
| `logs` | `lines?` | tail of the diagnostics log |

Element query grammar: `testid:x`, `text:y` (aria-label or innerText
contains), `css:selector`, or a bare string (testid, then text).

## Diagnostics log

`<userData>/logs/grokbuild.log`, JSON lines, 10 MB rotation (one `.1`
archive). Wired sources:

- app lifecycle (start/quit, versions)
- **every grok CLI stderr line** and worker exit, per session — previously
  raw stderr was dropped after classification, which is exactly what made
  the 2026-08-25 mid-turn CLI death undiagnosable
- session errors surfaced to the UI
- renderer console warnings/errors
- main-process uncaught exceptions / unhandled rejections
- every control command

`gbctl logs -n 200` is the first stop for any incident.
