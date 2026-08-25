# GrokBuild Electron security model

## Status and threat model

GrokBuild intentionally launches the official Grok CLI and can service agent-requested terminal
and filesystem operations. The objective is therefore not to make a coding agent harmless; it is
to keep authority explicit, bounded, and outside web content, prevent accidental privilege
expansion, contain untrusted protocol data, and avoid leaking credentials or local paths through
renderer state, logs, errors, or update flows.

The repository is an active parity milestone. Its renderer/process/package boundary is hardened,
and terminal/filesystem plus permission contracts have deterministic evidence. The complete P0/P1
parity and release gate is still red. A development build or locally generated DMG must not be
treated as a trusted release.

Security authority is split as follows:

- the renderer presents bounded state and offers named user actions;
- preload exposes a fixed capability bridge;
- Electron main validates IPC, owns dialogs, local state, native lifecycle, and privileged
  brokers;
- one `utilityProcess` per connected session owns ACP parsing and the Grok child;
- Grok owns authentication, model/tool execution, hooks, skills, plugins, and MCP runtime.

Electron `utilityProcess` provides process/fault isolation. It is not an OS sandbox and does not
make the Grok child or agent tools safe by itself.

## Renderer boundary

Production windows use:

- `sandbox: true`;
- `contextIsolation: true`;
- no Node.js integration;
- a fixed preload;
- the custom `grokbuild://app` application origin;
- a restrictive Content Security Policy;
- denied popup creation, unexpected navigation, and renderer permission requests.

The production protocol serves only packaged renderer assets below its fixed root. Development
may admit the configured loopback Vite origin, but production sender/origin checks do not become a
generic localhost allowance.

The preload does not expose `ipcRenderer`, channel names, Electron events, raw ACP, arbitrary
filesystem paths, terminal methods, shell commands, or generic external navigation. Main validates
the sender frame and every input with strict schemas. Results and broadcasts are also constrained
to shared schemas or typed application projections.

Only a cached, validated HTTPS release URL may be opened externally through the current bridge.
Other renderer-selected URLs, `file:` URLs, custom executable URLs, and arbitrary shell-open
requests are not exposed.

## Worker and child-process boundary

Each connected session has one generation-scoped worker. Main sends a validated launch descriptor;
the worker alone owns NDJSON framing, JSON-RPC correlation, the Grok process, reverse hosts, and
pending reverse-RPC continuations.

Child processes use executable-plus-argv APIs with `shell: false` except where an exact ACP
terminal command shape itself intentionally invokes a shell. The Grok process receives a restricted
environment and canonical project `cwd`. Worker input lines, protocol strings, stderr summaries,
and retained terminal output are bounded. Stop uses a finite grace and escalation path.

Every worker event contains local session ID, generation, and sequence. Main rejects events from a
replaced generation and non-monotonic deliveries. This prevents a late process from mutating a new
session instance. Ordinary disconnect is distinct from explicit turn cancellation so a reconnect
does not silently answer or discard an unresolved Plan/question request.

Raw RPC IDs for Plan/question interactions and private `toolCallId` correlation remain inside the
worker. Main and renderer see an opaque random `interactionId`. Remote resolution and local answer
paths enforce first-answer-wins.

## Terminal and filesystem authority

ACP terminal and text-file capabilities are enabled because bounded reverse hosts are implemented.
They are reachable only from the session's Grok process through the worker protocol; the renderer
has no terminal/fs API.

Terminal protections include generation-scoped random IDs, limits on concurrent processes and
retained output, UTF-8-safe truncation, bounded wait/kill/release behavior, and cleanup when the
session ends. There is no arbitrary renderer command endpoint.

Filesystem operations are limited to the canonical project root and the exact plan-file
compatibility path. Reads and writes use byte bounds and symlink-aware containment checks. A
renderer cannot add a root, turn a display path into filesystem authority, or invoke a generic
read/write function.

These controls constrain the client host. They do not remove the inherent local-code-execution
risk of approving agent tools or enabling Auto accept.

## Tool permissions and interactive requests

Permission cards contain only the offered choices needed for a user decision. Auto accept selects
an offered allow choice according to a fixed priority; it cannot fabricate a choice. Duplicate and
late answers are rejected.

Plan approval and Ask User questions use a separate queue and are never handled by Auto accept.
The answer schema bounds interaction IDs, feedback, question text, choice count, annotations, and
free-form notes. Reconnect and generation rules preserve unresolved interaction safety while
rejecting stale answers.

Auto accept is a high-authority user setting. It does not mean that the renderer, web content, or a
remote MCP server gains a direct command channel; it means Grok-offered tool requests may be
accepted without a per-request click.

## Attachments

File and image attachment authority begins with a native main-process file dialog. Main issues an
opaque, session-bound, expiring, consume-once token. Renderer state contains the display name,
kind, token, and expiry only; it does not contain the source path or image bytes. Attachment leases
are not persisted and are cleared when their session is removed.

When consumed, regular files become bounded text notes with a safe relative name or basename.
Images are opened without following symlinks, identity-checked against the selected file,
size-limited, signature-validated, and then encoded directly into an ACP content block. A token
cannot be replayed for another session or a later prompt.

There is no inbound local-media protocol for assistant-rendered image/video files. Adding one
would require a separate scoped broker; unrestricted `file:` rendering is not acceptable.

## MCP and secret handling

MCP management is delegated to the official CLI through `McpService`. Main fixes the operation and
derives `cwd` from the selected project. List and Doctor results redact command targets, reduce
remote URLs to safe origins, and report environment/header presence as booleans. Raw CLI
stdout/stderr, full remote URLs, environment values, headers, and config paths are not returned in
those result objects.

There is an important current limitation: the MCP add form accepts environment/header values in
renderer memory and sends them through the narrow IPC call to the CLI operation. The application
does not echo or persist those values in app state, but no `safeStorage`/secret-reference broker
exists yet. Consequently the current implementation must not be described as “secrets never enter
the renderer.”

Grok authentication remains CLI-owned. `GrokDoctorService` checks only bounded status signals such
as executable/version, cached sign-in-file presence, and config presence. It does not copy auth
tokens into Electron state or logs and does not automatically launch login.

## State, import, and private data

`AppStateStore` validates a bounded schema-v5 JSON document, migrates compatible v1/v2/v3/v4 state
with `privacyMode` and `memoryEnabled` defaulted off,
quarantines corruption, and writes atomically under restrictive POSIX permissions. Process handles,
raw RPC continuations, attachment bytes/paths, MCP secret values, and Grok credentials are not
serialized. Settled session membership is durable; completion unread state and History capabilities
are transient and are never serialized. CLI-owned Tasks/Workflows/Goals snapshots are also
transient and never enter the state file. Memory contents, source paths, filesystem identities, and
Memory capabilities are not serialized; only the boolean CLI launch policy is durable.

Saved Agent data is not folded into that document. Main derives a separate `agents.v1.json` path
under the Electron user-data directory. Renderer snapshots receive only bounded local roster
summaries and session presentation badges; inline ACP profile bodies, role/model/permission fields,
catalog selectors, source paths, and CLI file identities do not enter `AppSnapshot`.

Swift import is explicit and read-only at the source. Main parses a user-selected plist with fixed
system tooling and strict schemas, returns counts plus an opaque short-lived preview token, and
only mutates Electron state after confirmation. Merge is deterministic and non-destructive;
existing Electron records win and the Swift file is untouched.

The current import does not automatically discover Swift state, maintain a durable source-checksum
journal, or reconcile `chat_history.jsonl`. Those omissions are migration/recovery gaps, not
authorization to scan the user's profile broadly.

## Memory store containment

Production `MemoryBroker` receives `~/.grok/memory` from main; renderer IPC cannot choose a base
path. It recognizes only the global `MEMORY.md`, bounded workspace `MEMORY.md` files, and bounded
session Markdown files. Directory and file traversal is bound to current-UID, non-group/other-
writable, no-symlink identities. Files must be regular, single-link objects. Root, parent, and file
device/inode/owner/mode/time/size identity is rechecked around operations, and scan, preview,
global-file, and note byte limits fail closed. `index.sqlite` and all unrecognized shapes are left
untouched.

List returns random generation/TTL-scoped capabilities plus sanitized public summaries; absolute
paths, real workspace slugs, and filesystem identities remain in main. Read opens no-follow and
returns at most a strict UTF-8 bounded Markdown preview. Remember is allowed only while the durable
launch policy is enabled, appends beneath a complete global `## Notes` heading, and uses an
exclusive cooperating-writer lock, no-follow same-directory temporary file, fsync, expected-target
identity check, rename, reopen verification, and directory fsync. Delete resolves only a session
capability, moves the exact target into a private quarantine, verifies what moved, unlinks it, and
syncs the sessions directory. Global and workspace memory are never deletable through this API.

Preload exposes four named methods with exact argument schemas. Main owns the cancel-default native
delete confirmation and maps all Memory failures to one fixed public message. Capabilities are
invalidated on list refresh, expiry, relevant application-context change, setting transaction, and
shutdown. They do not enter DOM attributes, accessible names, or persisted state. An explicitly
opened preview necessarily sends its bounded Markdown contents to the renderer; this is a browser
feature, not a claim that memory contents never cross the renderer boundary.

Privacy Mode is display-only, not a filesystem access-control or DLP boundary. The shipped UI stops
listing/reading and removes browser content, note drafts, and memory-file mutations from the DOM and full AX
tree while private, but does not change the underlying CLI store. The deterministic E2E uses only an
isolated synthetic memory root and asserts that its path, workspace slug, contents, drafts, and
tokens do not enter persisted app state.

The launch policy is also main-owned. Schema v5 requires `memoryEnabled`; all ACP connection paths
receive exactly one of `--experimental-memory` and `--no-memory`. AppController admits a change only
when sessions and authoritative live protection work are settled, captures the affected workers,
persists the policy, then stops every captured worker even if new CLI activity appeared during the
save. Offline/replaying cached activity does not falsely block the transaction. A stop/reconnect
failure clears capabilities and leaves the affected worker offline under the durable desired
policy. Memory operations/settings transactions participate in the controller stop barrier.

One filesystem limit remains: Node does not expose the native directory-FD `openat` and
rename-swap/no-replace CAS primitives needed to make the final pathname boundary atomic against a
malicious non-cooperating process running as the same UID. PAR-025 also lacks a signed-in Grok CLI
1.0.5 smoke under isolated `HOME`/`GROK_HOME` and device evidence for CLI-owned continuation after
Electron quits. Three P2 limitations are also explicit: clearing the broker cannot linearly revoke
a read/delete that already completed token resolution; a well-shaped stale or foreign delete token
opens native confirmation before capability revalidation, although the later mutation fails; and
worker stop resolves after bounded utility termination without waiting for utility exit or proving
process-group/PID cleanup of the internal ACP child in the timeout case. The domain therefore
remains partial.

## Saved Agent roster and catalog containment

Saved Agent renderer mutations are narrow and revisioned: name, mission, glyph, color, and pin
state only. Main merges those fields into the private full record, requires stable idle sessions
before changing a binding or runtime profile, and recycles only affected workers. Native
confirmation is required for deletion and explicit recovery. Deletion removes bindings while
preserving chats/transcripts; recovery moves the invalid original aside instead of following or
silently overwriting it.

`AgentRosterStore` rejects symlinks, non-regular files, oversized or malformed JSON, invalid
invariants, stale revisions, and parent-directory identity changes. It uses private modes, file and
directory sync, identity checks, a same-directory exclusive lock for cooperating store instances,
and an expected-revision/CAS write contract. Node does not provide a portable directory-FD-bound,
no-replace final rename for this design. A malicious or simply non-cooperating process running as
the same user can therefore still race the final pathname replacement/ABA boundary. Recovery
preserves every owner's bytes rather than overwriting a pathname that another writer claimed, but
this residual same-UID race keeps the persistence claim partial.

The local roster and the Grok CLI catalog are intentionally separate authorities. Catalog listing
uses the selected canonical workspace and configured executable, strict bounded JSON, repeated
stable inspection, file-source identity checks, generation/TTL invalidation, and random view
tokens. Renderer-visible catalog entries omit raw selectors and paths; the current read-only UI
discards the tokens and cannot resolve, launch, edit, or install a catalog entry. No catalog entry
implicitly becomes a local Saved Agent.

When a local Agent is bound, main derives the strict ACP profile and passes it through the validated
worker launch descriptor only to `session/new`/`session/load`. It is never accepted from renderer
content. Linked TOML role/prompt-file staging and rollback are not implemented, and no signed-in
real Grok CLI catalog/profile smoke is committed; those remain required security and parity
evidence.

## Protocol content, Markdown, and errors

ACP and CLI payloads are untrusted even when produced by the official executable. Known xAI
notifications for mode, usage, context, hooks, and activity are projected into strict bounded event
types. Transcript Markdown renders through a sanitizer with raw HTML disabled and controlled
links. Tool and interaction UI consume normalized models rather than raw JSON-RPC.

Public errors use stable messages/codes. Services that invoke Git, Grok, update, archive, signing,
or plist tools keep command output and internal paths out of public errors. Main-process logs and
QA captures still require redaction because local diagnostics can carry sensitive context.

The remaining security work includes a comprehensive runtime canary across malformed stdout,
stderr, RPC error data, transcript content, state, notifications, and logs, plus broader assistant
protocol-noise sanitation. Passing one boundary test is not evidence that every future ACP update
shape is safe.

## CLI-owned activity containment

Tasks, background observations, workflow runs, and goals remain owned by the session's Grok CLI
process. Electron does not create an independent timer, cron service, workflow runner, or durable
activity database. The utility worker accepts only session-bound direct/wrapped notifications and
projects them through a strict trusted-event union. Typed scheduler updates are primary; the pinned
Swift `scheduler_create/list/delete` tool shapes are parsed only as a bounded compatibility
fallback, and typed authority prevents later legacy mutation.

Private CLI session/task/tool-call/run/goal identities exist only inside the worker/main projection
needed for correlation, revision checks, and tombstones. The public schema replaces them with
generated view keys and permits only bounded labels, timestamps, statuses, counters, and separate
workflow-agent versus goal-token budgets. Commands, raw tool input/output, paths, environment
values, arbitrary payload keys, and remote IDs are excluded. Malformed or oversized activity is
reduced to bounded unknown/overflow state rather than forwarded.

Replay is staged separately from live state; failed replacement replay is discarded and disconnect
preserves only an offline display cache. App state persistence never receives the projection. LRU
protection is decided in main from the internal bounded state and fail-closed overflow sentinels,
and is enabled only for a live projection. Renderer array counts are display data, not authority to
keep a process alive.

The current surface is read-only, so there is no renderer-to-main task mutation API and no
short-lived action-token capability to audit yet. Scheduled work depends on the owning Grok process;
Quit stops it and does not promise continued execution. Real signed-in CLI scheduler/workflow/goal
smoke and future control-action capability tests remain required before PAR-014 can be verified.

## Git and workspace inspection

`GitService` is read-only. It uses a fixed or explicitly safe executable, `shell: false`, a
realpath-validated project `cwd`, time/output limits, and fixed public errors. Its broader surface is
limited to branch, worktree identity, dirty status/counts, summary, and bounded diff; there is no
arbitrary command entry point.

Only a smaller `DashboardInspector` projection is connected to the renderer. The bridge call is
zero-argument, so renderer content cannot supply a project ID, path, Git argv, executable, or
revision. AppController selects the current registered project in main, acquires its integration
lease, checks the workspace identity and current selection around the asynchronous inspection, and
strictly validates the result. The renderer receives only `{ projectId, isRepository, isWorktree,
branch?, dirtyCount }`; paths, diff content, repository identities, and command output stay in main.
The rest of `GitService`, including summary and patch reads, remains main-only.

`WorkspaceHealthService` is main-only and maps a registered project to a bounded opaque health
result rather than exposing a generic path probe. AppController projects only `{ projectId, state }`
into the renderer snapshot; filesystem errors stay in main, and health is never persisted. Lifecycle
actions probe the registered path before spawning work, stop and quiesce project workers on an
unavailable result, and preserve saved transcripts for inspection or removal. `GitService` remains
bounded and read-only; the Dashboard projection above does not expose its broader authority.

Project Open in is a separate fixed-target boundary. Renderer IPC accepts only a registered
project ID and one of Finder, Cursor, VS Code, Terminal, iTerm, or Zed. Main resolves the stored
canonical path; application bundle IDs, `/usr/bin/open`, argv, probe paths, and timeout policy never
cross the bridge. The current availability probe intentionally checks fixed application locations
instead of exposing a generic LaunchServices or executable lookup surface.

## CLI session-history capabilities

History uses the fixed Grok CLI command families `sessions list --limit 50`, `sessions search
--limit 50 <query>`, and `sessions delete <remote-id>` with `shell: false`, a main-owned CLI path,
and the selected project's canonical working directory. Strict parsing bounds the table to 50
records and converts command failures, output limits, and timeouts to content-free public errors.
The renderer cannot pass a working directory, CLI path, remote session ID, or arbitrary argv.

`SessionHistoryBroker` binds each remote session ID to a random 32-byte base64url capability in a
main-only cache. Capabilities expire, are invalidated on every refresh or project/CLI/workspace
context change, and are rechecked against canonical path identity before use. Renderer records
contain only the opaque token, project ID, bounded summary/status, and calendar dates. Opening a
token resumes through ACP with stale fallback disabled and commits one local tab only after the
remote ID is revalidated. An existing matching local tab is selected rather than duplicated.

Deletion is a serialized main-owned mutation. It rejects a remote session already represented by a
live or selected local tab, shows a native confirmation containing only the bounded summary, then
revalidates context, capability, and protection immediately before the one-shot CLI delete. Tokens,
remote IDs, paths, and CLI output are absent from persisted state and renderer-visible errors.
History mutation also acts as a main-state write barrier; delete reads protection again after the
broker's asynchronous identity check and before consuming the token, then rechecks context after
the CLI operation. Already-started list/search/delete work is tracked by the controller's stop
barrier, so shutdown cannot silently abandon a destructive History child process.

## Update trust chain

Update installation has no generic renderer-to-filesystem or renderer-to-network authority. A
check places the exact URL, digest, size, installed/latest versions, and release metadata in a
main-only one-shot cache. The public projection contains only statuses and versions. An install
IPC call accepts zero arguments and passes a native confirmation dialog; a renderer-supplied URL,
path, digest, Team ID, or version is rejected before confirmation. The candidate expires after 15
minutes and is consumed by the first install attempt.

The reversible portion of the main transaction enforces all of the following:

- one App/CLI operation lease, with no re-entry or deduplication;
- a packaged current executable at exactly `/Applications/GrokBuild Electron.app` or the current
  user's `Applications` equivalent, with a canonical non-symlink bundle/executable path;
- a valid Developer ID Application signature, hardened runtime, secure timestamp, unique Team and
  bundle identity, current designated requirement, plist identity/version/executable, and exact
  `arm64`/`x86_64` architecture set;
- bounded HTTPS redirect/download, expected byte size, SHA-256, and private same-owner staging;
- bounded ZIP entries, uncompressed bytes, normalized/collision-free names, traversal and symlink
  containment, and one exact top-level App;
- candidate Developer ID/runtime/timestamp/Team/bundle identity, the current App's designated
  requirement through `codesign -R`, exact versions/executable/architectures, Gatekeeper
  assessment, and stapled notarization-ticket validation;
- refusal while sessions, permissions, interactions, state migration, lifecycle changes, health
  checks, or other integration work are unsettled; ACP shutdown and a strict persistence flush;
- a second inspection of the current App identity at the last reversible boundary; and
- fixed public failures that omit tool output, URLs, paths, identities, and private diagnostics.

Only then does main create a private, atomically written local Squirrel.Mac JSON feed and call
Electron `autoUpdater`. The staged file is reopened with `O_NOFOLLOW`, hashed through the open
descriptor, and bound by device/inode/size/mtime/ctime checks before and after Squirrel reports
`update-downloaded`. Returned version, release date, archive URL, and active feed URL must match.
The renderer cannot select or modify this feed.

Crossing `checkForUpdates()` is treated as irreversible because Squirrel may retain an update for
the next launch. Any ambiguous failure after that point permanently fails the coordinator closed,
retains the update and leases, and starts a controlled ordinary quit; it never retries a second
candidate. A classified success first deletes the source stage that Squirrel has already copied
and prepared, then retains quiescence and enters the controlled `quitAndInstall()` route. If that
deletion fails, installation remains non-retryable and the next production launch performs a
bounded stale-stage sweep. That sweep accepts only an exact `grokbuild-update-<6 alnum>` direct
child of the canonical dedicated root with same-UID ownership, private mode, same-device identity,
and no symlink, while excluding every stage owned by the live process. The project contains no
custom App-bundle swap helper. Squirrel.Mac owns
process waiting, replacement retries, prior-bundle backup, and restoration if replacement cannot
complete.

The Grok CLI installer is a separate narrow boundary, not a generic process runner exposed to the
renderer. Its IPC accepts no arguments. Main acquires the shared CLI/App operation lock, drains ACP
workers through the strict persistence quiescence gate, and only then snapshots the configured CLI
path plus selected-project `cwd` (or the home-directory fallback). It performs a fresh update
check, accepts only strict canonical semantic versions (including prereleases), rejects downgrade
or injected version text, and presents a native dialog containing only the exact current/target
versions. Confirmation invokes the fixed `grok update --version <target>` argv with `shell: false`
and bounded time/output.

The security authority after execution is the installed executable, not the release feed: main
runs local `grok --version`, strictly parses its first line, and requires exact equality with the
confirmed target before releasing quiescence or reconnecting ACP. A later feed check is best-effort
display refresh; it may report a newer release, but it cannot make a locally verified target fail.
Main updates only the version cache for the exact path used. Renderer output is limited to
`cancelled` or `installed` with bounded current/latest/update-available/channel fields. Command
output, paths, argv, and diagnostics remain main-only, and fixed public errors cover every failure.

Once command execution may have touched disk, a command failure or non-exact/unreadable local
version is classified as ambiguous. The coordinator permanently retains the quiescence and shared
operation leases, blocks retry/reconnect, and requests an ordinary guarded quit. `before-quit`
waits the tracked `activeCliUpdateBarrier` together with controller cleanup, so Electron cannot
orphan the updater child while it is still resolving. Only failures proven to occur before command
execution release the gates normally. Startup likewise awaits the initial CLI version probe before
registering IPC, preventing a stale probe from racing an update and overwriting verified state.

Residual limits are explicit:

- Electron 43.4.1's bundled Squirrel.Mac does not itself validate the extra feed SHA-256/size
  fields. JavaScript validates and holds the source archive but cannot read back Squirrel's private
  copy, leaving a very narrow same-UID race at Squirrel's path-open boundary.
- Squirrel restoration covers replacement failure. There is no health-check rollback when a newly
  installed App later launches and crashes.
- The checkout's `build/update-feed.json` is deliberately null. Release CI derives a repository-
  specific GitHub API URL from `GITHUB_REPOSITORY`, embeds it as an extra resource, and signs it
  with the App. Packaged runtime accepts only the strict, credential-free
  `https://api.github.com/repos/<owner>/<repository>/releases` shape and does not accept the
  development/E2E environment override. There is still no real published-release capture, local
  Developer ID identity, or signed previous-version-to-current install/recovery run.
- CLI installation is wired and deterministically covered with the request-driven mock CLI,
  including target pinning, prereleases, exact local verification, ambiguous failure, and
  quit-barrier behavior. The application still does not own a binary backup/rollback mechanism
  for a partially successful upstream update, and no real managed-CLI upgrade capture is committed.

These limits keep PAR-017 and PAR-022 partial; deterministic unit/E2E evidence is not a substitute
for signed installed-App release evidence.

## Packaging and macOS capabilities

The packaged application uses ASAR, hardened-runtime configuration, ASAR integrity validation,
and explicit Electron fuse settings verified from the built executable. In particular, run-as-Node,
Node options, CLI inspect arguments, and extra file-protocol privilege are disabled; cookie
encryption, embedded ASAR integrity, only-load-from-ASAR, and WebAssembly trap handlers are enabled.
The browser-process-specific V8 snapshot fuse remains disabled because the stock Electron package
does not include that snapshot; it is a performance option, not a privilege boundary.

Current entitlements and Info.plist omit microphone capability because voice input is not
implemented. Do not predeclare that permission before an implemented, tested feature requires it.

The release workflow has signing, notarization, stapling, package verification, and a separate
unsigned packaged-smoke job, but release readiness runs before signed packaging and currently fails
on incomplete parity and pending known differences. This host has no valid Developer ID identity.
Signed-package Notification/TCC behavior, mounted-DMG first launch, previous-version upgrade,
Squirrel replacement-failure restoration, and launch-health behavior still need dedicated evidence.

Unsigned execution and signing authority never share a runner. The smoke job receives no release
secrets and starts the candidate with a newly constructed, exact 11-key environment instead of
spreading `process.env`; its HOME, TMPDIR, user data, workspace, fake CLI, and transcript are all
isolated. The signing job depends on that smoke result but never launches the candidate. Both
checkout actions disable credential persistence. Although the signing job has repository write
permission, checkout retains no credential and `GH_TOKEN` is injected only for final publication.

Signing credentials are also time- and path-bounded. The P8 file is written with private umask and
covered by an EXIT trap. Electron-builder temporary keychains are confined to the dedicated
private `APP_BUILDER_TMP_DIR`. An `if: always()` cleanup step deletes every keychain below that
validated directory, removes the directory and P8, and asserts that neither remains before the App
ZIP is created. No candidate binary is executed while signing secrets are present.

Release verification is bound to the final upload bytes rather than only the source App. After
creating `GrokBuild-Electron-v<version>.app.zip`, CI writes its exact filename and digest to
`SHA256SUMS`, then passes the source App, DMG, ZIP, and checksum file explicitly to the verifier.
The verifier recomputes that ZIP digest, requires one normalized top-level App shape, extracts into
a temporary directory, confines symlinks, and repeats Developer ID/runtime/timestamp, current
designated requirement, Team/bundle identity, version/build/executable, architecture, Gatekeeper,
and stapled-ticket checks on the extracted App. Only that same path is subsequently uploaded.
This exact ZIP check is the last repository-produced executable trust boundary: afterward the
workflow only rechecks the generated checksum manifest and calls `gh release create` with the
unchanged ZIP, DMG, and checksum file. It runs no repository script or candidate executable and
performs no rebuild, signing, or archive transformation after trust verification. Unsigned local
package QA does not enter this signed-only branch and therefore cannot be mistaken for positive
Developer ID or notarization evidence.

## Notifications and privacy

Lifecycle notifications contain no prompt, response, tool output, path, model name, or other
session content. They carry only a state category needed for routing, suppress foreground noise,
deduplicate transitions, and ignore late turn completion after cancellation. Clicking routes to
the relevant session through main-owned identifiers.

Notification permission denial and signed packaged TCC behavior remain unverified. Privacy mode,
complete accessibility naming, and light/dark/minimum-size visual matrices are also incomplete.

## QA evidence and non-waivable failures

Fixtures and captures must be bounded and sanitized before commit. The canonical diff reports
structural differences and digests rather than differing values. A subtree can be waived only by
an approved, unexpired, pointer-scoped known-difference entry; pending entries are not waivers.

P0 secret exposure, signature/identity failure, traversal, data loss, or child-process cleanup
failure cannot be made green by deleting an assertion or adding a broad visual mask. The
release-readiness command fails on incomplete P0/P1 evidence and pending relevant differences, and
the release workflow invokes it before packaging.
