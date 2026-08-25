# Migration status

Baseline: Swift GrokBuild `v0.3.2` at
`060de18dc1b9e680cf43781b9cd5ce3b85c0faf8`; pinned Grok CLI contract `1.0.5`.

GrokBuild Electron is an active parity milestone. It is usable for the implemented vertical
slices, but it is not replacement-ready or release-ready. The authoritative status of every
`PAR-xxx` row is `qa/contracts/parity-evidence.json`; the generated human report is
`qa/reports/migration-coverage.md`. This prose intentionally does not invent a second status
counter.

“Implemented core” below means the named path works and is tested, while the wider Swift domain
still has gaps. “Main-only” means a bounded service exists but is not reachable from AppController,
preload, or renderer UI.

## Current coverage

| Domain | Current truth | Remaining parity work |
| --- | --- | --- |
| Electron/Vite/React shell | Implemented core | Release still depends on the machine parity gate and signed-package evidence |
| Renderer/process boundary | Implemented core | Broader runtime secret/protocol canaries remain |
| Startup and ACP handshake | Partial | CLI discovery and ACP startup work; Grok Doctor and explicit Retry are present, but complete live-auth probing, timeout/remediation UX, and crash/fault coverage remain |
| Projects/workspaces | Partial | Add, real-path dedupe, select, remove, pins, pin-group ordering, restart persistence, fixed-target Open in, and missing/changed-path lifecycle protection work; nonstandard app locations are not discovered through LaunchServices, and Swift's disappearance-time Finder fallback remains |
| Local sessions | Partial | Create/select/close/pin, blank duplicate, lazy `session/load`, stale fallback, reconnect, per-project durable selection, user-facing canonical `x.ai/session/fork`, and main-owned live activity protection work; the full five-session mixed-state eviction matrix and real-CLI evidence remain |
| Streaming transcript | Partial | Text, thought, tool, plan, mode, context, turn usage, and bounded hook/activity projections render; richer activity/usage parity, late-chunk ownership matrix, and comprehensive protocol sanitation remain |
| ACP terminal and filesystem | Verified deterministic contract | Bounded worker-owned reverse hosts are implemented; no renderer terminal/fs API |
| Tool permissions | Verified deterministic contract | FIFO, duplicate/late-answer rejection, and Auto accept priority are covered; Plan/questions remain a separate queue |
| Plan and Ask User interactions | Verified deterministic contract | Direct/wrapped aliases, approve/change/abandon, partial answers, Other, multi-select, Plan actions, cancellation, reconnect, remote resolution, and authoritative current-mode synchronization are covered |
| Model/mode/effort | Partial | Capability-driven model/mode and per-session effort work; local Saved Agent binding now supplies a strict inline profile on new/load and reconnects only affected idle chats after profile changes, while project-scoped effort, linked TOML roles, and real-CLI profile evidence remain |
| Composer attachments | Partial | Secure file/image dialog selection, opaque leases, chips, and ordered ACP blocks work end to end; mentions, slash commands, goal creation/control, queue, and steer remain |
| Persistence and recovery | Partial | Strict schema-v5 atomic JSON, v1/v2/v3/v4 migration with Privacy and Memory defaults off, per-project durable-session selection, durable settled membership, corrupt quarantine, lazy load, stale fallback, and explicit Retry exist; unread completion remains transient by design, while no event journal/SQLite, full transcript tail repair, or longer-assistant reconciliation exists |
| Swift state import | Partial | Explicit plist preview with opaque token, confirm/cancel, non-destructive idempotent merge, and immediate save work; no auto discovery, source journal, or `chat_history.jsonl` reconciliation |
| Sidebar, Dashboard, History | Partial | Swift-priority status, transient background unread/focus clearing, local project/title plus bound Saved Agent name/mission search, Agent badges, pinned/settled shelves, the current-project six-group Dashboard with bounded Git status and live scheduled grouping, and distinct opaque-token CLI History list/search/open/native-delete work; a real-user two-session CLI smoke remains |
| MCP | Partial | CLI-owned list/add/remove/enable/disable and explicit Doctor UI work with redacted results; active-session config refresh is not proven, and Browser/Computer Use temporary integrations, skills, permissions, and restart flow remain |
| Settings | Partial | Application, Account (grok.com plan/usage), MCP, Doctor, Swift import, Saved Agents, Privacy, and Memory surfaces exist — the Updates page was removed by owner decision while the install engine remains main-only; Memory covers staged launch policy, browser/preview, remember, native-confirmed session deletion, and private display state, while targeted TOML editing, secret storage, providers/models, linked role CRUD, compatibility, hooks, skills, and plugins remain |
| Tasks/workflows/goals | Partial | A bounded read-only projection consumes CLI-owned typed scheduler/background/workflow/goal updates, uses a pinned legacy scheduler fallback, exposes replaying/live/offline truth without raw IDs or persistence, protects live work from LRU eviction, and has Electron E2E plus a visual baseline; control actions/action capabilities, per-activity Saved Agent assignment, and real-CLI scheduler/workflow/goal smoke remain |
| Rich Markdown/media | Partial | Sanitized GFM/basic code and tables work; smashed-table parity, Mermaid, LaTeX discrimination, broader sanitation, and a scoped inbound local-media broker remain |
| Git | Dashboard projection integrated; broader domain partial | Dashboard reads only the selected project's bounded branch/worktree/dirty projection through zero-argument IPC with selection/path stability checks; diff summary and bounded patches remain main-only, and checkout, worktree creation, commit, review, and PR flows are absent |
| Workspace health | Implemented core | Bounded registered-project health is wired through lifecycle and UI: unsafe work stops, transient capabilities are cleared, saved transcripts stay readable, and recovery can reconnect; signed-package filesystem/TCC variants remain |
| Update discovery | Partial | The engine works but has no Settings entry point since the Updates page was removed by owner decision; app-release and CLI checks plus a cached safe release-page action work over IPC; a main-only one-shot App candidate expires after 15 minutes; local feed config is deliberately null and release CI seals its repository URL into the signed App, but no real published-release capture exists |
| App update install | Integrated deterministic core; release evidence partial | Zero-argument IPC/native confirmation, shared App/CLI lock, current identity and location checks, digest/size staging, ZIP/signature/DR/architecture/Gatekeeper/notarization verification, ACP quiescence/strict save, and Squirrel.Mac restart are wired; no local Developer ID or signed old-to-new installed-App evidence and no post-launch crash rollback |
| CLI update install | Integrated deterministic core | Zero-argument IPC, strict semver/prerelease target confirmation, shared lock/quiescence, dynamic main-only CLI/cwd, fixed target-pinned update command, exact local version authority, best-effort feed refresh, ambiguous-outcome guarded quit, startup/quit barriers, and mock Electron E2E work; no app-owned upstream binary rollback or real managed-CLI upgrade capture |
| macOS shell | Partial | Close-to-hide, Dock/second-instance restore, basic status item, Settings routing, and bounded quit cleanup work; complete menus/status states, finish sound, voice, and microphone flow remain |
| Notifications | Partial | Content-free lifecycle notification routing, foreground suppression, dedupe, click routing, and cancellation guard work; permission-denied UX and signed packaged TCC smoke remain |
| Package hardening | Deterministic/release-workflow core implemented; signed evidence partial | Explicit fuses, ASAR integrity, minimized capabilities, DMG inspection, separate secret-free unsigned smoke with an exact 11-key candidate environment, credential cleanup, and exact-ZIP final verification exist; no signed installed upgrade/recovery evidence |
| Saved Agents | Partial | A main-owned local roster, explicit recovery, exact idempotent starter crew, per-session binding, inline ACP profile/recycle behavior, read-only CLI catalog, Settings/sidebar/composer UI, and deterministic unit/Electron/visual evidence work; linked TOML role transactions, real signed-in Grok smoke, same-UID pathname ABA hardening, and catalog-to-local conversion remain |
| Custom providers | Missing | The PAR-024 custom provider/model and managed Cursor bridge domain still has no authoritative completed vertical slice |
| Memory | Partial | A main-owned capability broker, v5 launch policy, all-worker launch flags, durable recycle transaction, strict IPC, Settings/Privacy UI, Electron E2E, and normal/private visual baselines work; isolated signed-in Grok 1.0.5 proof, a native final-path CAS helper, and post-Quit continuation evidence remain |

## Important boundary clarifications

### MCP configuration reaches Grok through the CLI

Electron currently sends an empty client MCP descriptor list during `session/new` and
`session/load`. Grok CLI `1.0.5` resolves and merges its native, project, compatibility, plugin,
and managed configuration itself, so entries written by `grok mcp add` are not excluded from new
sessions. The open gap is proving current-session watcher/restart behavior and implementing
Swift's temporary Browser/Computer Use descriptors—not “MCP never enters ACP.”

### The updater is wired, but deterministic evidence is not release evidence

The App path is now one ordered main-owned transaction: fresh one-shot discovery authority,
current-App identity, private digest/size staging, candidate archive/signing trust, idle-session
quiescence with strict persistence, a second current-App identity check, and a private local feed
handed to Electron's Squirrel.Mac updater. Renderer installation is zero-argument and requires a
native confirmation. Squirrel, not project code, owns App replacement and restores its retained
prior bundle if replacement retries fail. A successful Squirrel preparation releases the source
ZIP before quit. An ambiguous preparation keeps it through exit, and the next launch cleans only
exact-name, canonical, private, same-owner stale directories inside the dedicated update root.

That does not make the row verified. This machine has no Developer ID identity and the repository
does not contain an installed, signed previous-version-to-current update capture. Squirrel's
replacement recovery is not post-launch crash rollback. Electron 43.4.1's Squirrel revision also
does not natively enforce the feed's SHA-256/size fields: main hashes and holds the exact source
inode around handoff, but cannot hash Squirrel's private copy, leaving a very narrow same-UID
path-open race.

Feed configuration itself is deterministic: the checkout keeps `build/update-feed.json` null,
while release CI derives the GitHub releases URL from `GITHUB_REPOSITORY` before QA/packaging and
embeds it into the signed App. Packaged runtime reads that resource only; the environment override
is limited to development/E2E. The missing evidence is a real published, signed update—not a
missing release-workflow configuration step.

CLI installation is now connected through a separate zero-argument IPC and Settings action. The
shared App/CLI lock and AppController quiescence gate are acquired before main resolves the current
configured CLI path and selected-project working directory (falling back to home). A fresh
`grok update --check --json` is accepted only when strict canonical semantic versions, including
prereleases, identify a newer target. Native confirmation binds that exact target, and only
`grok update --version <target>` may run. Local `grok --version` must then equal the target exactly;
that readback—not a feed postcheck—is authoritative for releasing quiescence and reconnecting ACP.
The later feed check is best-effort display data and can surface an even newer version.

If execution may have mutated disk and fails, or local readback is missing/mismatched, the state is
ambiguous: both leases remain held, retry and reconnect stay blocked, and main requests a guarded
ordinary quit. `before-quit` waits the active CLI-update barrier, and startup awaits its initial
version probe before registering IPC, closing both child-orphan and stale-cache races. After exact
success, main refreshes only the cache for the path used; renderer state contains only cancellation
or bounded installed/current-feed information. Unit tests, the ordinary App E2E, and the dedicated
real-Electron CLI lifecycle E2E cover this state machine. There is still no committed real managed-
CLI upgrade or application-owned rollback evidence.

### Release workflow separates executable smoke from signing authority

The packaged mock-ACP smoke runs in its own unsigned macOS job with no release secrets. The child
receives exactly 11 constructed keys, including isolated HOME/TMPDIR and QA-only paths, rather than
the runner environment. The signing job depends on that result and never launches its candidate.
Both checkouts disable persisted credentials; repository write credentials are provided explicitly
only to the final publish command.

The P8 key is protected by an EXIT trap, electron-builder keychains are confined under a dedicated
`APP_BUILDER_TMP_DIR`, and unconditional cleanup deletes the key, keychains, and directory and
asserts their absence before ZIP creation. CI then verifies the exact ZIP bytes and reconstructed
App. That verifier is the last repository-produced executable boundary: only checksum validation
and upload of the unchanged ZIP/DMG/manifest follow. These controls harden the workflow, but they do
not create the missing Developer ID, installed old-to-new, Gatekeeper, or recovery artifacts.

### Swift import is manual and intentionally narrow

The Settings import flow handles a file the user explicitly selected. It does not scan the user's
profile or silently mutate the Swift source. That implemented safety boundary does not satisfy
automatic migration or transcript recovery parity.

### Sidebar, Dashboard, and History keep separate authorities

Sidebar activity follows the pinned Swift priority: needs input, error, working, finished unread,
then idle. A background streaming completion or idle assistant-message growth marks a tab unread;
selecting/focusing it clears that transient flag, which is intentionally absent from persisted
state. Pinned and settled membership are mutually exclusive. Settled membership is durable in
schema v5, defaults collapsed in the sidebar, and cannot be applied while a session is working or
waiting for user input. Case-insensitive local filtering covers project/session titles plus the
name and mission of a bound local Saved Agent. The roster summary also drives Agent badges and the
sidebar Agents section without exposing the private inline ACP profile.

The Dashboard is a native top-layer modal over only the selected project's live/restored local
tabs. It resolves the six ordered Swift groups—Needs you, Failed, Working, Needs review,
Scheduled, Idle—and receives a zero-argument, main-derived Git projection. AppController verifies
the registered workspace identity and selected project around the asynchronous inspection; the
renderer receives only bounded repository/worktree/branch/dirty fields. The Scheduled group now
uses the selected session's live CLI-owned PAR-014 projection; replaying and offline cached views do
not claim live scheduled state.

History is a separate native modal and data source backed by fixed `grok sessions list/search/delete`
CLI operations. A generation-, context-, and TTL-bound main-process broker replaces remote session
IDs and paths with opaque capabilities. Opening selects an existing matching local tab or resumes a
single transactionally persisted tab through ACP; deletion is one-shot, refuses a protected live
tab, and requires a native confirmation. The shared modal surface uses the browser's native
`<dialog>` top layer, explicit initial focus, Escape/backdrop close, and focus return to the toolbar
trigger. Deterministic mock-CLI and Electron tests cover this path; a real signed-in user's two-live-
session unread/open smoke is still missing.

Ten macOS visual baselines now cover conversation, context usage, Dashboard, History,
Tasks & Workflows, Saved Agents settings, 1100x720 light/dark Privacy Mode, and normal/private
Memory settings. They prevent accidental collapse of these surfaces but do not replace
Swift black-box or real-CLI evidence.

### Tasks, workflows, and goals are a CLI-owned read-only projection

The utility-process trusted channel projects typed scheduled-task, background command/monitor/
subagent, workflow, and goal notifications into strict semantic events. Scheduler generation and
revision clocks, workflow revisions/tombstones, goal ownership, terminal-state monotonicity, and
hard item/text/counter bounds are reduced in main. Typed scheduler truth takes authority over the
pinned Swift `scheduler_create/list/delete` tool fallback; legacy replay cannot manufacture live
work.

AppController stages replay into a replacement projection, publishes explicit `replaying`, `live`,
and `offline` states, discards failed or stale-session replacement replay, and never serializes the
projection. The renderer receives generated `viewKey` values and bounded display fields only—not
CLI session/task/run/goal IDs, commands, raw tool input/output, paths, environment values, or
arbitrary payload keys. Main alone decides LRU protection from bounded internal truth plus
fail-closed overflow sentinels, and only while the projection is live. The Tasks & Workflows modal distinguishes authoritative schedules
from background observations and keeps workflow agent-call budgets separate from goal token
budgets and chat context usage.

PAR-014 remains partial. There are no create/delete/pause/resume/stop controls, no short-lived
action-token broker, no per-activity Saved Agent assignment, and no deterministic real Grok CLI
scheduler/workflow/goal smoke. Scheduled work is supported only while the app and owning Grok
process remain active; Quit does not promise continued execution.

### Saved Agents are local identity, not the CLI catalog

The Saved Agents slice is wired end to end but remains partial. `AgentRosterStore` owns a separate
bounded `agents.v1.json`, accepts the pinned Swift legacy array, uses revisioned/CAS mutations and
same-directory serialization, installs only the missing members of the exact five-agent starter
crew, and leaves invalid input untouched until explicit native-confirmed recovery moves it aside.
Bindings survive restart, are inherited transactionally by duplicate/fork, are removed on
close/project removal, and are cleared on Agent deletion without deleting chats or transcripts.

Main converts a bound local Agent into a strict inline ACP profile for `session/new` and
`session/load`. Name/mission/role changes recycle only stably idle bound workers; glyph/color/pin
changes stay local. Settings provides the bounded editor/recovery/starter flow, sidebar search and
badges use the public name/mission presentation, and the composer changes bindings through a
revisioned main-owned operation. Deterministic unit tests, a restart/resume/deletion Electron E2E,
and a Saved Agents visual baseline cover this vertical slice.

The lower Settings section is a separate, read-only projection of project-scoped
`grok inspect --json`. Raw selectors, source paths, and file identities stay in main; public catalog
records are bounded and the renderer discards their random view tokens. A CLI catalog entry is not
a local Saved Agent, and no conversion/link action exists.

Remaining PAR-023 gaps are material: no atomic linked TOML role/prompt-file transaction or rollback,
no signed-in real Grok CLI inspect plus profile launch/resume capture, and a residual same-UID
non-cooperating pathname replacement/ABA race at the local roster's final rename boundary. These
gaps are why the evidence status is `partial`, not `verified`.

### Memory is wired, but deterministic storage evidence is not a real CLI smoke

PAR-025 now has a complete deterministic vertical slice. `MemoryBroker` is main-owned, fixes the
production root to `~/.grok/memory`, scans only bounded global/workspace/session Markdown shapes,
and replaces paths and filesystem identities with rotating opaque capabilities. It rejects
symlinks, hard links, changed identities, wrong owners, group/other-writable objects, oversized
trees/files/notes, and invalid UTF-8. Read is bounded, remember appends only to global memory under
a cooperating-writer lock and durable same-directory write, and delete is limited to session
capabilities and requires a cancel-default native confirmation.

State schema v5 persists `memoryEnabled` as a required boolean and migrates v1-v4 with it disabled.
Every ACP worker launch receives exactly one policy argument: `--experimental-memory` or
`--no-memory`. AppController refuses an unsafe policy transition, persists before changing public
state, and then unconditionally stops the captured workers so CLI activity appearing during the
save window cannot retain an old flag. Offline/replaying cached activity does not falsely block a
change. Stop/reconnect failure clears capabilities, leaves the desired durable policy authoritative,
and keeps the affected worker offline. App shutdown waits for Memory operations/settings
transactions. IPC has exact arity and bounded schemas; public failures do not expose paths or
broker details.

Settings provides the staged Apply & Restart flow, grouped browser and sanitized Markdown preview,
global remember action, session-only deletion, empty/loading/error states, and a Privacy Mode state
that removes file details, preview content, note draft, and mutations from DOM and accessibility
output without modifying storage. Unit tests, a restart/process-argv/native-confirmation/privacy
Electron E2E, and normal/private visual baselines prove that deterministic contract against an
isolated fake CLI profile.

That is why PAR-025 is `partial`, not `verified`: there is no signed-in Grok CLI 1.0.5 memory smoke
under isolated `HOME` and `GROK_HOME`; Node alone does not provide the directory-FD
`openat`/rename-swap CAS primitive needed to close the last same-UID non-cooperating pathname race;
and no device capture proves the expected CLI-owned continuation behavior after Electron Quit.
The audited P2 list also retains three narrower gaps: worker stop does not wait for utility exit or
prove process-group/PID cleanup after a timeout; broker clear cannot linearly revoke a read/delete
whose token resolution already completed; and a well-shaped stale/foreign delete token reaches the
native confirmation before capability revalidation, although no deletion follows.

### Bounded services require explicit lifecycle wiring

`WorkspaceHealthService` is now connected through AppController as a transient, strict health
projection. The sidebar and conversation pane block new work when a registered folder is missing,
changed, not a directory, or unreadable while preserving saved transcripts and removal controls.
The Dashboard-specific `DashboardInspector` is connected through a reviewed zero-argument
contract; the broader `GitService` diff/patch surface remains main-only and does not expand renderer
authority. The update services remain main-only trust boundaries internally, but the App
transaction exposes only bounded check and zero-argument install operations through reviewed IPC.

## QA and release state

Development QA uses the pinned reference, request-driven fake Grok, unit/Electron/package checks,
and generated evidence report:

```bash
npm run qa
```

The native Swift black-box driver is opt-in because macOS Accessibility and Screen Recording
authorization is host-specific:

```bash
npm run qa:swift-blackbox:preflight
npm run qa:swift-blackbox
```

It builds/copies the pinned Swift app under an independent bundle identity, uses an isolated HOME
and fake CLI, drives boot/project/session/prompt behavior, and emits AX, RPC, preferences, and
screenshot artifacts. Missing authorization is an explicit blocked exit, never a green result.

The canonical comparison command performs a bounded, value-redacting structural diff:

```bash
npm run qa:compare -- --expected expected.json --actual actual.json --output diff.json
```

Only an approved, unexpired, JSON-pointer-scoped entry in
`qa/contracts/known-differences.json` may waive a difference. A pending record is documentation,
not approval.

Release readiness is deliberately separate:

```bash
npm run qa:release-readiness
```

It exits nonzero while any P0/P1 parity row is `partial`, `missing`, or `external-blocked`, or a
relevant intentional difference is unapproved/pending. The GitHub release workflow invokes this
gate before packaging. Its current failure is expected and is the truthful release result, not a
broken development QA command.

For update/package rows specifically, unit and Electron tests prove App and CLI transaction order,
content-free failures, hostile-argument rejection, CLI target pinning/local verification/ambiguous
quit lifecycle, and controlled Squirrel handoff behavior. They cannot prove Developer ID,
Gatekeeper/notarization behavior on an installed App release, an old-to-new signed replacement, or
replacement recovery. Those positive release artifacts are absent on this host and
PAR-017/PAR-022 must stay `partial`.

The migration can be declared complete only after the manifest has evidence for every required
row, pending differences are resolved or explicitly approved within policy, native/reference and
Electron canonical evidence converge, and the signed/notarized application passes first-install,
upgrade, TCC, and rollback-relevant release checks.
