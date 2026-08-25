# GrokBuild Electron architecture

## Scope and source of truth

GrokBuild Electron is a desktop client and local state manager around the official
`grok agent stdio` process. Grok owns model execution, authentication, agent reasoning,
tools, hooks, skills, plugins, and MCP runtime behavior. Electron owns the desktop shell,
the privileged process boundary, local presentation state, persistence, and native macOS
integration.

The behavioral reference is pinned in `reference/upstream.json` to Swift GrokBuild
`v0.3.2` at commit `060de18dc1b9e680cf43781b9cd5ce3b85c0faf8`. The ACP wire reference is the
pinned Grok CLI contract. `docs/PARITY_MATRIX.md` is the human inventory;
`qa/contracts/parity-evidence.json` is the machine-readable implementation/evidence status.

This document describes the repository as it exists now. A service described as
**main-only** has code and unit coverage but is not yet available through AppController,
preload, or renderer UI.

## Runtime topology

```text
Sandboxed React renderer
    |
    | named, typed contextBridge calls and cloned events
    v
Electron main
    |- AppController
    |- AppStateStore -> bounded atomic state.json
    |- AgentRosterStore -> bounded revisioned agents.v1.json
    |- GrokAgentCatalogService -> read-only project-scoped CLI projection
    |- MemoryBroker -> capability-scoped ~/.grok/memory projection
    |- privileged brokers and narrow services
    `- SessionManager
          `- AcpWorkerClient -> one utilityProcess per connected session
                |- AcpClient -> grok agent stdio
                |- bounded ACP terminal host
                `- bounded ACP filesystem host
```

The `utilityProcess` is a process and fault-isolation boundary, not an operating-system
sandbox. Main validates every worker message; the worker validates ACP traffic before
publishing typed events. Raw JSON-RPC is not exposed through the preload bridge.

## Architectural invariants

1. The renderer has no Node.js integration and cannot select IPC channels, executable
   paths, filesystem paths for privileged operations, shell commands, or ACP methods.
2. Main is authoritative for projects, local sessions, persistence, worker ownership,
   external navigation, dialogs, and macOS lifecycle.
3. At most one live worker and one Grok child belong to a connected local session.
4. Worker events carry local session identity, generation, and monotonic sequence so output
   from a replaced worker is rejected.
5. Full state snapshots carry a monotonic revision; older renderer deliveries are ignored.
6. ACP and CLI output is untrusted. Only schema-validated, bounded projections may enter
   application state or renderer-visible errors.
7. Release claims come from the parity evidence manifest and release-readiness gate, not from
   a successful development build or a prose checklist.

## Renderer and preload

The React renderer owns presentation and transient UI state: sidebar selection, transcript
rendering, composer state, interaction cards, settings panels, focus, and scroll position.
It receives a main-owned application snapshot and narrow events.

The preload exposes named capabilities defined in `src/shared/bridge.ts` and validated with
schemas from `src/shared`. It does not expose `ipcRenderer`, Electron event objects, raw
filesystem or terminal access, arbitrary shell execution, or raw ACP JSON-RPC.

The production renderer is loaded from the fixed `grokbuild://app` protocol with context
isolation, renderer sandboxing, navigation and popup denial, and a restrictive Content
Security Policy. Development admits only the configured loopback Vite origin.

## Main controller, state, and sessions

`AppController` is the application orchestrator. It owns project/session mutations,
selection, prompt dispatch, interaction and permission queues, attachment leases, retry,
state reduction, and persistence scheduling. `SessionManager` enforces the live-session
limit and protects sessions that are selected, running a turn, or waiting for input.

Implemented lifecycle behavior includes:

- add, real-path deduplicate, select, remove, pin, and manually order projects within pin groups;
- open a registered project through a fixed Finder/Cursor/VS Code/Terminal/iTerm/Zed allowlist,
  with the main process deriving the canonical path and retaining bundle IDs and argv;
- create, select, close, pin, and blank-duplicate local sessions;
- keep pinned and settled session shelves mutually exclusive, persist settled membership, and keep
  unread completion transient and focus-cleared;
- persist Grok session IDs and lazily reconnect with `session/load`;
- fork a settled session through `x.ai/session/fork`, then persist and resume only the returned child;
- remember the last durable session independently for each project;
- suppress replayed transcript frames while loading;
- fall back from an explicitly stale remote session to `session/new` while preserving the
  visible local transcript and adding a notice;
- explicit retry after a startup/session failure without replaying the previous prompt;
- reject stale worker generations and out-of-order sequence deliveries;
- stage CLI-owned activity during replay, expose live/offline truth without persisting it, and
  protect authoritative live schedule/background/workflow/goal work from LRU eviction;
- load a separate local Saved Agent roster, bind a Saved Agent to an idle chat, inherit that
  binding across duplicate/fork transactions, and recycle only affected workers when the inline
  ACP profile changes;
- persist a strict app-wide Memory launch policy before recycling safe workers, pass that policy
  through every new/load/retry/fork/History-resume connection path, and keep failed reconnects
  offline rather than continuing under the prior policy;
- shut down workers with bounded escalation on application quit.

Tasks/workflows/goals are currently read-only; control capabilities and real-CLI smoke remain.
Quitting stops the owning Grok process and does not promise scheduled work continues. Fork uses
pre/post workspace identity checks and atomic local rollback, but
the current ACP contract has no compensating delete for a remote child if the app crashes after
the server accepts the fork and before the local commit completes.

## Persistence

`AppStateStore` validates schema version 5, migrates version 1, version 2, version 3, version 4, or
unversioned compatible records to version 5, quarantines malformed state, and writes a bounded
atomic JSON file. The v5 settings add required `privacyMode` and `memoryEnabled` booleans; every
older version migrates both to `false`.
The state directory and temporary file use restrictive POSIX permissions. Streaming saves
are coalesced so only the latest dirty state is persisted rather than queueing every chunk.

Durable state contains projects, local sessions, pinned and settled membership, sanitized
transcript projections, and application settings, including the Memory launch policy. Unread
completion is intentionally transient.
State does not serialize process handles, RPC continuations, attachment bytes, attachment source
paths, MCP secret values, Grok authentication material, Memory file contents/capability tokens, or
the Tasks/Workflows activity projection.

Saved Agents use a separate main-owned `agents.v1.json` rather than being embedded in `state.json`.
The roster has its own revision/CAS contract, bounded agent and binding collections, restrictive
permissions, same-directory serialization, explicit invalid-file recovery, and session-binding
cleanup. Public snapshots contain only the editor/presentation summary; role/model/permission and
other launch preferences remain main-private. A same-UID non-cooperating filesystem writer can
still race the last pathname replacement/ABA boundary, so this is not claimed as a fully hostile
same-user database transaction.

There is no SQLite repository, append-only ACP event journal, or full transcript tail-repair
system yet.

## Sidebar, Dashboard, and CLI History

`sessionPresentation.ts` is the pure presentation contract ported from the pinned Swift reference.
It resolves sidebar priority as needs-input, error, working, finished-unread, then idle; bounds
case-insensitive filtering; prevents settling active/waiting sessions; formats working duration;
and maps Dashboard sessions into the fixed Needs you, Failed, Working, Needs review, Scheduled,
Idle order. AppController derives unread only from background completion/idle assistant growth and
clears it on selection or explicit read, while schema v5 stores settled membership.
Bound Saved Agent name and mission participate in bounded sidebar filtering, and bound chats carry
only the Agent name/glyph/color presentation summary.

The Sessions Dashboard consumes only the current AppSnapshot project and a separate
`DashboardProjectStatus`. Its bridge call accepts no arguments. Main derives the selected project
and registered path, validates workspace identity and selection before and after the asynchronous
read, and returns only project ID, repository/worktree booleans, an optional bounded branch, and a
dirty count. Scheduled grouping consumes only a `live` PAR-014 activity projection; replaying and
offline cached activity does not claim a live scheduled count.

Sessions History is not the Dashboard and does not read Electron's local session list. Main invokes
the fixed Grok CLI list/search/delete commands for the selected project. `SessionHistoryBroker`
keeps the CLI path, canonical working directory, workspace identity, and remote session IDs in a
generation-scoped, expiring cache; the renderer receives a bounded public record plus a random
opaque token. Open either selects an already bound local tab or performs a deferred ACP resume and
transactional schema-v5 insertion. Delete revalidates context and live-tab protection immediately
before the CLI mutation and requires a main-owned native confirmation. History mutation is a
main-state write barrier; protection is read again after asynchronous broker identity validation
and before token consumption, CLI completion is rechecked, and already-started list/search/delete
operations participate in the controller's stop barrier.

Both panels use `ModalSurface`, which calls native `HTMLDialogElement.showModal()` for top-layer
inertness/focus containment, chooses an explicit initial focus target, closes on Escape or backdrop,
and returns focus to the invoking toolbar control. The visual lane maintains ten macOS baselines:
conversation, context usage, Dashboard, History, Tasks & Workflows, Saved Agents settings,
light/dark Privacy Mode, and normal/private Memory settings.

## Saved Agents and the Grok CLI catalog

`AgentRosterStore` is the local identity authority. It parses the versioned Electron format and the
pinned Swift legacy array, rejects malformed/symlink/non-regular/oversized input without silently
overwriting it, performs expected-revision mutations, installs the exact missing starter templates
idempotently, and moves an invalid entry aside only through explicit recovery. `AppController`
serializes roster mutations with session/project lifecycle work and compensates binding changes
when duplicate, fork, close, or project removal fails.

A bound local Agent becomes a strict inline `agentProfile` containing the derived role name,
mission description, and prompt body. The worker supplies it only in ACP `session/new` and
`session/load`; it is absent from renderer snapshots and persisted chat state. Binding, deletion,
or a name/mission/role change stops and reconnects only the stably idle affected chats. Glyph,
color, and pin changes are presentation-only. Deleting an Agent clears its bindings while leaving
the local sessions and transcripts intact.

`GrokAgentCatalogService` is a different, read-only authority over project-scoped
`grok inspect --json`. It identity-binds the selected workspace, CLI executable, and file-backed
agent sources, requires stable repeated inspection before caching, and exposes only bounded display
text, source class, optional plug-in display name, and random expiring tokens—never selectors or
source paths. The current renderer immediately discards those tokens because there is no catalog
mutation or selection action. Catalog entries are not local Saved Agents, and there is currently no
conversion/link transaction between them.

The missing Swift slice is the atomic linked TOML role/prompt-file transaction and its rollback.
The roster intentionally does not write those files itself. A signed-in real Grok CLI inspect plus
profile launch/resume smoke is also still required before PAR-023 can move beyond partial.

## Grok CLI memory boundary

`MemoryBroker` is main-owned and receives a fixed production root of `~/.grok/memory`; the E2E lane
substitutes an isolated user-data root. It discovers only the global `MEMORY.md`, bounded workspace
`MEMORY.md` files, and bounded per-session Markdown files. A list rotates generation-scoped,
five-minute random capabilities. The renderer receives a sanitized title, synthetic workspace
label, scope, date, size, deletion flag, and token—not the base path, workspace slug, filesystem
identity, or other CLI-owned files such as `index.sqlite`.

Every read and mutation rebinds the root, parent directories, and target by owner, mode, device,
inode, timestamps, size, and link count. Symlinks, hard links, non-regular files, group/other
writable objects, oversized scans/content, and invalid UTF-8 fail closed. Remember appends a bounded
note beneath a complete `## Notes` section in global memory using a cooperating-writer lock,
exclusive no-follow temporary file, fsync, expected-identity check, rename, reopen verification,
and directory fsync. Delete accepts only a capability minted for session memory, moves that file to
a private quarantine, verifies the moved identity, unlinks it, and syncs the sessions directory.

The preload exposes four fixed calls: zero-argument list, token-only read, bounded note-only
remember, and token-only delete. Main validates exact positional arity and output schemas, returns
one fixed public failure, and owns a cancel-default native confirmation for deletion. The Settings
page groups global/workspace/session summaries, renders bounded sanitized Markdown previews,
stages the launch-policy switch until `Apply & Restart Sessions`, and exposes explicit
loading/empty/error states. Privacy Mode removes the browser, preview, note draft, and delete
controls from the rendered and accessibility trees without changing stored files.

`memoryEnabled` is a durable v5 application setting. A change is admitted only while sessions and
authoritative live lifecycle/integration work are settled—offline/replaying cached activity does
not block it—captures the affected workers, persists
before public state changes, then unconditionally stops those captured workers—even if new CLI
activity appears during the durable save window—before reconnecting under the new flag. A
persistence failure leaves the old policy and workers intact; a stop/reconnect failure leaves the
durable requested policy authoritative, takes the affected worker offline, and clears cached
capabilities. In-flight Memory operations and the setting transaction participate in the
controller stop barrier. Project/selection/CLI/settings changes invalidate future capability
resolutions; an operation that already completed token resolution may still finish.

This remains a partial parity boundary. There is no signed-in Grok CLI 1.0.5 memory smoke under an
isolated `HOME`/`GROK_HOME`, no native directory-FD `openat`/rename-swap CAS helper to eliminate the
last same-UID non-cooperating pathname race, and no device evidence for CLI-owned continuation
semantics after Electron quits. Additional P2 lifecycle/UX residuals remain: worker stop resolves
without waiting for utility-process exit or proving process-group/PID cleanup after a timeout, and
a syntactically valid stale or foreign delete token reaches native confirmation before broker
capability revalidation (the later mutation still fails safely).

## ACP worker and lifecycle

`AcpWorkerClient` spawns an Electron `utilityProcess` with a validated launch descriptor.
The worker owns `AcpClient`, NDJSON framing, JSON-RPC correlation, the Grok child process,
reverse hosts, and pending reverse-RPC continuations. The worker protocol is a strict Zod
union with bounded strings and payloads.

A normal connection:

1. resolves a configured or safely located Grok executable;
2. spawns with an argv array, `shell: false`, a restricted environment, the canonical project
   directory as `cwd`, and exactly one app-owned memory argument: `--experimental-memory` when the
   persisted policy is enabled or `--no-memory` otherwise;
3. sends `initialize` and advertises only implemented client capabilities;
4. uses `session/load` for a persisted remote ID or `session/new` otherwise, attaching the
   main-derived inline Saved Agent profile when that local chat is bound;
5. sends prompts as ACP content blocks and reduces validated session updates;
6. uses `session/cancel` only for an explicit turn cancellation, not ordinary disconnect;
7. cleans up the child, terminals, and pending calls when the worker is finally stopped.

The client supports capability-driven model and mode selection, reasoning effort,
current-mode notifications, context-window usage, last-turn usage, and bounded hook/activity
projections. Text, thought, tool, plan, usage, mode, and activity events are reduced into the
local transcript/state model. Advanced rich-content and full protocol-noise sanitation remain
parity work.

## CLI-owned Tasks, Workflows, and Goals

Electron does not run a parallel scheduler or workflow engine. `AcpClient` accepts session-bound
typed notifications for scheduled tasks, background commands/monitors/subagents, workflow runs,
and goals, then emits only strict semantic events across the existing trusted worker channel. The
pinned Swift scheduler tool-call shapes are a bounded fallback for compatible older CLI output;
typed scheduler generation/revision truth takes authority when present. Ordinary legacy tool
updates still follow the transcript path, while replayed legacy scheduler mutations cannot create
live activity.

`SessionActivityProjection` is main-only. It correlates private task/call/run/goal identities,
enforces scheduler and workflow high-water marks and tombstones, preserves terminal-state
monotonicity, caps public collections/text/counters, and records fail-closed overflow sentinels for
process-liveness decisions. Its renderer-safe snapshot contains generated view keys and bounded
labels/status/budgets only. Raw identities, commands, paths, environment values, tool input/output,
and arbitrary payload fields never enter `AppSnapshot`.

AppController creates a staging projection in `replaying`, atomically promotes it to `live` after a
successful connection, preserves the last known view as `offline` on disconnect, discards failed
replacement replay, and resets the view on stale-session fallback. Activity changes use transient
snapshot publication rather than the persistence write path. `SessionManager` protects a worker
from LRU eviction only when main reports live scheduled work, a nonterminal background/workflow, an
active or paused goal, or a fail-closed overflow condition. Offline/replaying views never own that
protection.

The renderer exposes one native-modal Tasks & Workflows view and a live Scheduled Dashboard count.
It is deliberately read-only: there are no control mutations or short-lived action tokens yet.
The owner is still the Grok CLI process, so quitting GrokBuild stops that process and provides no
continuation guarantee.

## Reverse terminal and filesystem hosts

The initialized client advertises terminal and text-file support because both reverse hosts
are implemented.

`TerminalHost` owns terminal IDs per worker, uses fixed process APIs rather than a
renderer-selected command channel, bounds live processes and retained output, preserves UTF-8
boundaries when truncating, implements wait/kill/release, and releases children when the
session ends.

`FsHost` supports ACP text reads and writes inside the canonical project root plus the exact
plan-file compatibility path. It applies symlink-aware containment checks and byte bounds.
The renderer cannot add an approved root or call the host directly.

The deterministic parity manifest currently marks the terminal/filesystem contract verified.

## Permissions, Plan approval, and Ask User questions

Tool permissions are a FIFO main-owned queue. A user can answer an offered choice; Auto accept
selects only an offered allow option according to the implemented priority. Duplicate and late
answers are rejected.

Plan approval and Ask User questions use a separate interaction queue. Auto accept never answers
them. The worker retains the real RPC ID and `toolCallId`; main/renderer use a random opaque
`interactionId`. Supported compatibility forms include direct and leader-wrapped
`_x.ai/...` and `x.ai/...` requests, plus the captured legacy Plan alias.

Plan results support:

- `approved`;
- `cancelled` with optional feedback, meaning request changes and remain in Plan;
- `abandoned`, meaning leave Plan without implementation.

Question results support optional/partial answers, single- and multi-select fixed choices,
Other/free-form notes, cancellation, and Plan-mode actions `chat_about_this` and
`skip_interview`. Remote `interaction_resolved` notifications remove the matching opaque card
from any queue position. Generation checks and first-answer-wins handling reject late local or
remote responses. A normal disconnect preserves unresolved cards for load/reconnect.

## Attachments

`AttachmentBroker` is a main-process capability broker. A dialog-selected file becomes an
opaque, session-bound, expiring, consume-once lease. The renderer receives only a display name,
kind, token, and expiry; source paths and file bytes do not enter renderer snapshots or persisted
state.

At prompt time, main consumes the lease. Regular files become bounded attachment notes using a
safe relative name or basename. Images are opened without following symlinks, identity-checked,
size- and signature-validated, then encoded into ACP image blocks. Content blocks preserve the
Swift attachment ordering expected by the prompt contract.

`@` mentions, slash commands, goal creation/control, prompt queueing, and steer are not implemented.
Read-only goal state, when reported by the CLI, is covered by the activity projection above.

## MCP and Grok Doctor

`McpService` is connected to Settings through narrow IPC. It delegates list/add/remove and
enable/disable operations to the official Grok CLI. Doctor is explicit and requires a confirmed
external launch. Main derives the project `cwd`; the renderer cannot override it. Results expose
safe summaries: command targets and URLs are reduced, and environment/header values are not
echoed back.

The current add form does accept environment/header values from the renderer for the one CLI
operation. There is no `safeStorage` or secret-reference broker yet, so this is not complete
secret-containment parity.

New and loaded ACP sessions pass an empty client descriptor list. Grok CLI 1.0.5 merges its own
native, project, compatibility, plugin, and managed MCP configuration, so CLI-managed entries are
still resolved by Grok. Live-session config-watcher/restart behavior has not been proven.
Swift's temporary Browser and Computer Use descriptors, permissions, health flow, and skill
installation are not implemented.

`GrokDoctorService` performs bounded, read-only checks for the CLI, version, cached sign-in-file
presence, and config presence. It returns fixed statuses and remediation choices; it neither
reads tokens into app state nor runs `grok login`. Together with explicit Retry this covers a
useful recovery path, but not a complete live-auth probe or automatic remediation system.

## Swift state import

Swift import is an explicit, non-destructive workflow. The user selects a plist; main parses it
through fixed system tooling and strict schemas, then returns counts plus an opaque, short-lived
preview token. Confirming the token performs a deterministic merge into fresh Electron schema v5
state, where existing Electron records win, and persists immediately. Cancel discards the preview.
Repeated import is idempotent and the Swift source is not modified.

Automatic source discovery, a durable source checksum/import journal, and reconciliation with
Swift `chat_history.jsonl` are not implemented.

## Updates and package boundary

The App update path is a main-owned transaction. The renderer can request a check or a
zero-argument install, but it never receives or supplies a download URL, digest, size, Team ID,
designated requirement, filesystem path, or target version. Settings displays the bounded
discovery projection, and main uses a native confirmation dialog before installation.

The transaction is ordered as follows:

1. `UpdateCoordinator` discovers App and CLI versions. An exact App asset becomes a main-only,
   one-shot candidate with a bounded 15-minute lifetime; starting an install consumes it.
2. `UpdateOperationLock` excludes a simultaneous App or CLI update. `MacAppIdentityService`
   accepts only the packaged product in the exact system or user Applications location and reads
   its signed bundle identity, Team ID, designated requirement, version, and architectures.
3. `TrustedUpdateStager` downloads the exact HTTPS asset into a private owned directory while
   enforcing redirect, byte-size, and SHA-256 policies.
4. `TrustedAppArchiveVerifier` bounds ZIP shape and extraction, then checks the candidate's
   Developer ID signature, hardened runtime/timestamp, current designated requirement, Team and
   bundle identity, exact architectures, versions/executable metadata, Gatekeeper assessment,
   and stapled notarization ticket.
5. `AppController.acquireUpdateQuiescence()` refuses unsettled or conflicting work, stops ACP
   workers, clears transient capabilities, and requires a successful state flush. The current App
   identity is then inspected again at the last reversible boundary.
6. `TrustedSquirrelUpdater` atomically writes a private local `file://` JSON feed bound to the
   verified staged archive and asks Electron `autoUpdater` to prepare it. A successful handoff
   reclaims the now-unneeded source archive, retains the operation/quiescence leases, and restarts
   through Squirrel.Mac. If the handoff may already have crossed into Squirrel but its result
   cannot be classified, the updater fails closed, disables retry, retains the source through
   process exit, and performs a controlled ordinary quit. The next production launch removes only
   canonical, private, same-UID, exact-name stale directories directly below the dedicated update
   root; symlinks, broad permissions, foreign entries, nested paths, and live-process stages are
   never cleanup targets.

There is no project-owned swap helper or Node process that replaces the App bundle. Squirrel.Mac
waits for target processes to exit, keeps the prior bundle as a backup during replacement, and
restores it when its installation retries fail. That recovery covers replacement failure, not a
new version that installs successfully and then crashes on launch.

CLI installation is a separate main-owned transaction sharing the same `UpdateOperationLock`:

1. `installCliUpdate` is zero-argument. Main acquires the CLI operation lease and
   `AppController.acquireUpdateQuiescence()` before resolving any runtime input, so active ACP
   workers stop and state must persist successfully first.
2. A provider reads the latest main snapshot after those gates are held. It selects the configured
   CLI path dynamically and derives `cwd` from the selected project, falling back to the user's
   home directory. Neither value enters the renderer or install result.
3. `CliUpdateInstallCoordinator` runs a fresh `grok update --check --json`, asks through a native
   dialog only after both versions pass strict semantic-version canonicalization (including
   prerelease identity) and the target compares newer than the current version. Declining never
   invokes the updater.
4. On confirmation, `GrokCliService.installUpdate()` invokes only
   `grok update --version <canonical-target>` under its bounded process policy. Renderer, feed,
   and dialog text cannot append argv or choose another target.
5. The installed executable is then queried locally with `grok --version`. Exact equality with the
   confirmed canonical target is the authoritative condition for releasing quiescence and allowing
   ACP to reconnect. A subsequent feed check is best-effort presentation data only: it may surface
   a still-newer release, but failure, stale data, or a non-`up-to-date` response cannot invalidate
   an exact local verification.
6. If the updater may have changed disk and then fails, or local version readback does not exactly
   match the target, the outcome is ambiguous. The coordinator becomes terminal, retains both the
   quiescence and shared-operation leases, and requests an ordinary guarded quit; it never reconnects
   ACP through an unverified executable or retries in-process. Only definitely pre-execution input,
   path, or spawn failures release the gates normally.
7. After exact verification, main refreshes only the cache associated with the CLI path used. The
   renderer receives `cancelled` or an `installed` projection containing bounded current/latest,
   update-available, and optional channel fields—never paths, argv, output, or diagnostics.

Main wraps the CLI transaction in `activeCliUpdateBarrier`. `before-quit` waits for that barrier as
well as controller cleanup, preventing an in-flight updater child from being orphaned. At startup,
the initial CLI version probe is awaited before IPC registration, so an older `--version` result
cannot race a self-update and overwrite the verified cache.

`build/update-feed.json` is intentionally null in the checkout. The release workflow derives the
GitHub releases API URL from `GITHUB_REPOSITORY` before QA and packaging, embeds that file as an
App resource, and signs it with the bundle. Packaged runtime reads only that resource;
`GROKBUILD_UPDATE_FEED_URL` is a development/E2E override, not a production authority.

Electron 43.4.1's bundled Squirrel.Mac does not natively enforce the extra SHA-256/size fields in
this local feed. Main reopens and hashes the exact staged inode, keeps that descriptor open through
`update-downloaded`, rechecks the path/inode/metadata around handoff, and validates the returned
version, date, URL, and feed. JavaScript cannot hash Squirrel's private copied archive, leaving a
very narrow same-UID path-open race between those checks and Squirrel opening the path. Candidate
code signing and the current designated requirement remain the final executable trust boundary.

The release workflow can build, sign, notarize, staple, and verify a package, but it invokes the
machine release-readiness gate before packaging. This host has no usable Developer ID identity and
there is no real published release or captured signed old-to-new installed-App run, so PAR-017 and
PAR-022 remain partial even though the deterministic transaction is wired.

The release artifact verifier closes the build-to-upload loop. CI first creates the exact
versioned `.app.zip` and `SHA256SUMS`, then supplies both paths explicitly to `verify:package`.
That verifier checks the checksum entry and extracted archive shape and re-runs the App trust
checks—signature, source designated requirement, Team and bundle identity, version/build,
architecture, Gatekeeper, and stapler—against the App reconstructed from the ZIP. The verified ZIP
path is the path passed to `gh release create`; checking the pre-ZIP source App alone is not treated
as upload verification.

Release execution is split across two fresh macOS jobs. `unsigned-package-smoke` builds and launches
only an unsigned package without release secrets. Its candidate receives a constructed environment
with exactly 11 keys (`PATH`, isolated `HOME`/`TMPDIR`, locale/timezone, and fixed QA paths/flags),
never the parent runner environment. The signing job depends on that result but does not launch its
candidate. Both checkout actions set `persist-credentials: false`; write authority appears only as
the explicit `GH_TOKEN` on the final publish command.

Signing material is bounded to one step: the App Store Connect P8 file has an EXIT trap, builder
keychains live under a dedicated private `APP_BUILDER_TMP_DIR`, and an unconditional following step
deletes discovered keychains, removes both the P8 and builder directory, and asserts their absence
before ZIP creation. Exact ZIP verification is then the last repository-produced executable trust
boundary. The remaining publish step only rechecks `SHA256SUMS` and uploads the unchanged ZIP, DMG,
and checksum file; no candidate launch, repository script, rebuild, resign, or archive rewrite can
occur after verification.

## Repository and workspace services

`GitService` is a bounded read-only service. It runs a fixed or explicitly safe Git executable
with `shell: false` in a realpath-validated project directory and can produce branch,
linked-worktree identity, dirty counts/status, a bounded diff summary, and bounded read-only
patches. Only `DashboardInspector` is wired through AppController/IPC/preload/renderer, and that
projection is limited to current-project branch/worktree/dirty metadata. Diff/patch operations
remain main-only. Checkout, worktree creation, commit, and PR actions are absent.

`WorkspaceHealthService` is main-only. It resolves a registered project to an opaque health state
such as ready, missing, changed, or unreadable without exposing a generic filesystem API.
AppController keeps that projection transient, rechecks lifecycle entry points, and stops project
workers before publishing an unavailable state. The renderer receives only project IDs and fixed
states, keeps offline transcripts readable, disables new-work controls, and offers a bounded
"Check again" recovery action.

## macOS shell

The app implements a single main window, minimum size, close-to-hide, Dock activation and
second-instance restore, a basic status item with Show/Hide/New Chat/Quit, Settings routing,
bounded asynchronous quit cleanup, and content-free lifecycle notifications. Notifications cover
started/completed/needs-input/error routing, suppress foreground noise, and guard against a late
completion after user cancellation.

Complete menu/status state parity, finish sounds, voice input, microphone permission flow, and a
signed packaged Notification Center/TCC smoke remain open.

## QA and release truth

The QA system has separate evidence layers:

- pinned Swift source verification and tests;
- request-driven fake-Grok scenarios and Electron unit/E2E/package checks;
- an opt-in native Swift Accessibility black-box driver with isolated HOME and bundle identity;
- a bounded canonical JSON diff that emits structural and digest summaries, not differing values;
- a one-to-one parity evidence manifest and known-difference registry;
- a release-readiness gate that fails on incomplete P0/P1 rows or unapproved differences.

Missing Accessibility or Screen Recording authorization makes the Swift black-box lane exit as
blocked; it cannot report green. Ordinary `npm run qa` remains suitable for development and does
not include the release-readiness gate. The release workflow does.
