# GrokBuild Electron migration and parity QA matrix

This document is the executable migration inventory for moving the native
SwiftUI/AppKit GrokBuild Desktop application to Vite, React, TypeScript, and
Electron. It defines what must be preserved, how each behavior is verified,
and which implementation owns each target responsibility.

The reference is pinned in `reference/upstream.json`:

- Repository: `rimusz/grok-build-desktop`
- Release: `v0.3.2`
- Commit: `060de18dc1b9e680cf43781b9cd5ce3b85c0faf8`
- License: Apache-2.0
- Reference CLI while this matrix was authored: `grok 1.0.5
  (5115b46bc909)`

The release and commit pin, not a moving `main` branch, define Swift parity.
Every captured real-CLI fixture must additionally record its own CLI version,
platform, capture date, and sanitization metadata.

## Authority and scope

The detailed conflict rules live in [`qa/contracts/README.md`](../qa/contracts/README.md).
In short:

1. The pinned real grok CLI and its ACP wire behavior are authoritative for
   protocol behavior.
2. The pinned Swift application is authoritative for desktop product behavior,
   persistence semantics, macOS workflow, copy, and visual hierarchy.
3. Sanitized captured events are evidence for the CLI version that produced
   them; they are not a timeless protocol specification.
4. Requirements that do not exist in the Swift application, notably Electron
   isolation and macOS Notification Center delivery, are target contracts and
   are not represented as Swift parity.

The Electron application stays a thin UI shell. The CLI continues to own agent
reasoning, ACP sessions, tools, MCP runtime wiring, skills, hooks, plugins,
subagents, memory, and plan execution. Electron owns the desktop shell,
privileged process boundary, local presentation state, persistence, updates,
and native integration.

## Priority definitions

- **P0** — migration blocker. Required on every relevant pull request and for
  every packaged build. A P0 regression cannot be waived merely to ship.
- **P1** — required before public beta/release and before the migration may be
  declared complete. It may land after the first P0 vertical slice.
- **P2** — later migration wave, but still required before claiming complete
  Swift v0.3.2 feature parity. P2 does not mean out of scope.

## Harness shape

The parity harness should converge on this layout:

```text
qa/
├── contracts/
│   ├── README.md
│   └── known-differences.json
├── scenarios/
│   ├── p0/
│   ├── p1/
│   └── faults/
├── fixtures/
│   ├── acp/
│   ├── cli/
│   ├── persistence/
│   ├── updates/
│   └── workspaces/
├── mock-grok/
├── drivers/
│   ├── swift-driver.ts
│   └── electron-driver.ts
├── canonicalize/
├── baselines/swift/v0.3.2/macos-26/
├── e2e/electron/
├── smoke/real-grok/
└── reports/
```

The fake CLI must be request-driven rather than a timed stdout player. It must
support the one-shot commands used by Settings and updates as well as
`grok agent stdio`. Each scenario declares expected client requests and only
releases the next response/event when its request barrier is satisfied. Any
unexpected method, parameter, order, or duplicate response fails the scenario.

The Swift runner must use an isolated profile and fake CLI, for example:

```bash
CFFIXED_USER_HOME="$QA_PROFILE" \
GROK_CLI_PATH="$QA_FAKE_GROK" \
TZ=UTC LANG=en_US.UTF-8 \
/path/to/GrokBuild.app/Contents/MacOS/GrokBuild
```

Swift black-box evidence consists of outbound RPC captured by the fake CLI,
the Accessibility tree, screenshots, isolated preference/Application Support
files, and child-process lifecycle. Electron additionally exposes a test-only,
serializable state snapshot through the main-process test harness; it must not
expose privileged state to production renderer code.

## Feature matrix

Target paths identify the intended Electron owner. They may be split into
smaller modules, but privileged work must remain in `src/main`, the preload
bridge must remain narrow, and `src/renderer` must stay unprivileged.

| ID | Functional domain | Swift authority | Electron target owner | Deterministic fixture | State/behavior assertion | Visual assertion | Real CLI smoke | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PAR-001 | Startup, CLI discovery, authentication, ACP handshake | `GrokBuild/main.swift`; `AppDelegate.swift`; `Services/GrokProcess.swift`; `Services/GrokCLIService.swift`; `Services/DoctorReport.swift`; `Views/DoctorSheet.swift`; `GrokAuthProbeTests.swift` | `src/main/AppController.ts`; `src/main/grok/CliLocator.ts`; `src/main/grok/AcpProcess.ts`; `src/renderer/features/doctor` | `boot-ready`; `missing-cli`; `auth-required-stderr`; `initialize-timeout`; initialize model/mode variants | Exact launch executable, arguments, cwd, environment allowlist, initialize capabilities, and `idle -> starting -> ready/failed` transitions; no renderer access to auth data | No-project state; auth-required banner; missing-CLI and Doctor healthy/warning/error states | `grok --version`; initialize plus `session/new` in a temporary workspace | **P0** |
| PAR-002 | Project/workspace add, remove, select, pin, order, open-in | `Models/Workspace.swift`; `Services/WorkspaceStore.swift`; `Views/WorkspacePicker.swift`; `Views/SidebarView.swift`; `ContentView.swift`; `SessionPersistenceTests.swift` | `src/main/workspaces`; `src/renderer/features/sidebar`; `src/shared/models.ts` | Temporary directories, symlink alias, duplicate resolved path, missing path, pinned/manual order | Resolved-path deduplication; stable IDs; add/remove side effects; selected project; workspace order and settings cleanup | Empty workspace CTA; several projects; selected/pinned rows; path tooltip; open-in menu | Create an ACP session with the selected temporary directory as cwd | **P0** |
| PAR-003 | Session create, resume, fork, close, duplicate, lazy restore, multi-session LRU | `ContentView.swift`; `Services/ChatStore.swift`; `Services/SessionLayoutStore.swift`; `Services/SessionRestorePolicy.swift`; `Services/DashboardGrouping.swift`; `SessionPersistenceTests.swift`; `CompetitiveUXTests.swift` | `src/main/sessions/SessionManager.ts`; `src/renderer/state/sessionStore.ts`; `src/renderer/features/sessions` | Five sessions with selected, busy, scheduled, needs-input, and idle states; successful and stale `session/load`; fork response | Maximum four connected CLI processes; selected/busy/scheduled sessions survive eviction; MRU order; lazy restore; per-workspace selection; close shuts down the correct child only | Sidebar session list and state badges; restored selection; duplicate/fork labels | Open two real sessions; switch away and send another prompt; load a persisted session ID | **P0** |
| PAR-004 | ACP streaming text, thoughts, tool calls, hooks, activity summaries, context and turn usage | `Services/GrokProcess.swift`; `Services/ChatStore.swift`; `Models/Message.swift`; `Services/GrokActivitySummary.swift`; `Services/AssistantTranscriptSanitizer.swift`; `Views/RichMessageView.swift`; `GrokActivitySummaryTests.swift` | `src/main/grok/AcpRouter.ts`; `src/shared/acp-events.ts`; `src/renderer/features/transcript` | Interleaved message/thought chunks; tool call/update; hook executions; context total; prompt usage; xAI notification usage; late chunk; protocol-noise fragments | Exact canonical message-part order; no telemetry JSON in prose; late chunks remain on the completed assistant until the next send starts; usage buckets do not overwrite context total | Streaming assistant; thinking; CLI-style activity line; collapsed/expanded tool cards; context popover | Prompt for a literal response without tools; require at least one message chunk and a successful prompt result | **P0** |
| PAR-005 | ACP reverse terminal and filesystem host | `Services/AcpTerminalHost.swift`; `GrokProcess.handleTerminal`; `GrokProcess.handleFsRead`; `GrokProcess.handleFsWrite`; `AcpTerminalHostTests.swift` | `src/main/grok/TerminalHost.ts`; `src/main/grok/FsHost.ts` | `terminal/create`, `output`, `wait_for_exit`, `kill`, `release`; command arrays; quoted `bash -lc`; UTF-8 truncation; unknown method; plan-file write | JSON-RPC result/error shape and exit status; command splitting; byte cap; resource cleanup; unknown method returns `-32601`; filesystem operations are main-process only | Tool activity and terminal error card; no standalone service UI | Execute `printf` in a temporary workspace through the reverse terminal channel | **P0** |
| PAR-006 | Tool permission requests and Auto accept | `Services/GrokProcess.swift` (`PermissionRequest`, `PermissionAutoApprove`); `Services/ChatStore.swift`; `Views/MessageBubble.swift`; `CompetitiveUXTests.swift` | `src/shared/permission.ts`; `src/main/grok/responses.ts`; `src/renderer/features/permissions` | Integer and string request IDs; allow-always, allow-once, reject; duplicate request; tab switch while pending; switch to yolo mid-turn | Pending queue and selected `optionId`; Auto accept prefers allow-always, then another allow option; already pending cards drain; plan approval is never auto-approved | Waiting, approved, and rejected permission cards; active-tab and background-tab attention state | Optional nightly read-only tool request; model tool choice is not a PR assertion | **P0** |
| PAR-007 | Plan mode, exit-plan request, and ask-user questions | `Models/ComposerModels.swift`; `Services/GrokProcess.swift`; `Services/ChatStore.swift`; `Views/ComposerViews.swift` | `src/shared/interaction-cards.ts`; `src/main/grok/responses.ts`; `src/renderer/features/plan-question` | Plan update plus `fs/write plan.md`; approve/reject/abandon; single and multiple questions; accepted and cancelled answers | Plan text precedence; verdict response shape; answer map and annotations; resolved state; mode remains synchronized | Plan card; question card; resolved, rejected, and cancelled variants | Switch a real session into Plan mode; question generation remains nightly-only | **P0** |
| PAR-008 | Model, mode, session agent/role, and reasoning effort | `Services/GrokProcess.swift` (`AgentMode`, set model/mode); `Services/ChatStore.swift`; `Services/GrokAgentProfiles.swift`; `Services/SessionLayoutStore.swift`; `Views/ChatView.swift`; `AgentsAndCapabilitiesTests.swift`; `CompetitiveUXTests.swift` | `src/main/AppController.ts`; `src/main/acp/AcpClient.ts`; `src/main/acp/AcpWorkerClient.ts`; `src/shared/agents.ts`; `src/shared/models.ts`; `src/renderer/src/components/Composer.tsx` | Model success; 12-second timeout under a fake clock; incompatible-agent error; current-mode update; local Saved Agent bind/new/load/restart/resume; workspace effort | Failed model switch rolls back; `yolo` is displayed only as `Auto accept`; model and local Saved Agent are per tab; inline profile changes restart only affected idle tabs; reasoning effort is per project; linked TOML roles remain a separate transaction | Complete composer control row; pending/error model states; Saved Agent selector/badge; role menu; no user-facing “YOLO” string | Use initialize model state; set the current model; bind a local profile through new/load; switch Agent/Plan where supported | **P0** |
| PAR-009 | Composer text, file chips, image vision blocks, `@` mentions, slash commands, goal, queue, and steer | `Models/ComposerModels.swift`; `Services/FileMention.swift`; `Services/ImageAttachment.swift`; `Services/ChatStore.swift`; `Views/ChatView.swift`; `Views/ComposerViews.swift`; `AttachmentPromptTests.swift`; `PromptQueueTests.swift`; `ComposerWorkflowTests.swift` | `src/renderer/features/composer`; `src/main/files/AttachmentBroker.ts`; `src/shared/composer.ts` | Visible/hidden files; one-pixel PNG; MIME variants; slash catalog; `/goal --budget`; queue delivery failure; explicit/default steer | Normal files become plain-path attachment text; hidden chips are omitted; images become ACP image blocks; failed delivery preserves queue; steer does not cancel the current turn; consumed attachments cannot leak into a later prompt | File/image chips; mention list; slash autocomplete; goal banner; queue badge/menu; steer affordance | Send a one-pixel PNG with a text prompt; require ACP acceptance and turn completion, not exact model prose | **P0** |
| PAR-010 | Transcript persistence, recovery, tail repair, and migration from Swift state | `Services/SessionMessageStore.swift`; `Services/SessionLayoutStore.swift`; `Services/GrokSessionTranscriptImporter.swift`; `Services/SessionTranscriptRecovery.swift`; `Services/SessionRestorePolicy.swift`; `SessionPersistenceTests.swift`; `GrokSessionTranscriptImporterTests.swift` | `src/main/persistence`; `src/main/migration/SwiftV032Importer.ts`; `src/shared/persistence.ts` | Sanitized Swift plist/UserDefaults export; `chat_history.jsonl`; user-only transcript; truncated assistant; stale grok ID; missing legacy fields; malformed state | Replay does not duplicate visible content; selected restored tab has usable content; longer assistant is never replaced by a shorter save; old records decode; import is idempotent and non-destructive | Same selected tab and transcript before/after restart; stale-session fallback note; migration summary/error | Resume a real session after restart; move its session directory and verify preserved local transcript plus fresh fallback | **P0** |
| PAR-011 | Sidebar search, session status, unread, pinned/settled shelves, Dashboard, and History | `Views/SidebarView.swift`; `Services/SessionStatus.swift`; `Services/DashboardGrouping.swift`; `Views/SessionDashboardPanel.swift`; `Views/SessionsBrowserPanel.swift`; `CompetitiveUXTests.swift`; `StatusBarMenuTests.swift` | `src/shared/sessionPresentation.ts`; `src/main/git/DashboardInspector.ts`; `src/main/history/SessionHistoryBroker.ts`; `src/renderer/src/components/Sidebar.tsx`; `src/renderer/src/components/SessionDashboardPanel.tsx`; `src/renderer/src/components/SessionHistoryPanel.tsx` | Working-to-finished; needs input; error; dirty; scheduled; project/title and bound Saved Agent name/mission search terms; pinned and settled sessions | Status priority; unread set once on background completion and cleared on focus; Saved Agent identity participates only when locally bound; Dashboard section order and current-project scope; History and Dashboard remain distinct | All sidebar statuses; Saved Agent badge/search result; Pinned and Settled sections; six Dashboard groups; History screen and toolbar order | Complete one of two real background sessions and verify unread/focus behavior | **P0** |
| PAR-012 | MCP injection and health; Browser and Computer Use enablement | `Services/MCPServerConfig.swift`; `ChatStore.restartProcess`; `Services/AgentBrowserService.swift`; `Services/ComputerUseService.swift`; skill installers; `Views/SettingsView.swift`; browser/computer-use integration tests | `src/main/mcp`; `src/main/browser`; `src/main/computer-use`; matching renderer settings panes | stdio, HTTP, and SSE configs; draft/applied values; enabled/disabled; missing binary; Accessibility denied; skill install | Exact `session/new.mcpServers`; enable toggle applies and restarts immediately; other fields affect sessions only after Apply; disabled integrations inject nothing | Browser/Computer Use panes, runtime health, permission remediation, Apply and Restart state | Inject a deterministic echo MCP and verify `session/new` accepts it; tool invocation is nightly-only | **P0** |
| PAR-013 | Settings navigation, TOML/config editing, custom models/providers, roles, Agents roster, memory, compatibility | `Views/SettingsView.swift`; `Services/CustomModelSettings.swift`; `Services/SpecialistAgentStore.swift`; `Services/CompatConfigStore.swift`; `Services/MemoryStore.swift`; `Services/WorkflowsConfigStore.swift`; Settings/CustomModel/Agents tests | `src/main/agents/AgentRosterStore.ts`; `src/main/agents/GrokAgentCatalogService.ts`; `src/main/memory/MemoryBroker.ts`; `src/main/mcp/McpService.ts`; `src/shared/agents.ts`; `src/shared/memory.ts`; `src/renderer/src/components/SettingsPanel.tsx`; `src/renderer/src/components/AgentsSettings.tsx`; `src/renderer/src/components/MemorySettings.tsx` | Complex TOML with unknown sections/keys; special-character secret; model limit; malformed roster JSON and explicit recovery; starter crew; role prompt files; draft navigation state; strict read-only CLI catalog; Memory normal/private states | Targeted rewrite preserves unknown data; secrets never appear in renderer state/logs; malformed roster is not overwritten; local roster is not conflated with the CLI catalog; visited panes retain state; Memory launch policy persists before safe worker recycle; same-project selection does not dismiss Settings | All settings tabs and wrapping tab bar; model/provider and linked role CRUD; local roster/editor/recovery/catalog; Memory browser/remember/delete/private states; compatibility states; inline errors | Run read-only `grok inspect --json` and the model/skill/MCP inspection commands used by the panes; Memory real-CLI proof uses an isolated profile | **P1** |
| PAR-014 | Scheduled tasks, background commands/monitors/subagents, Rhai workflows, and session goals | `Services/ScheduledTaskStore.swift`; `Services/BackgroundTaskStore.swift`; `Services/WorkflowRunStore.swift`; `Services/SavedWorkflowStore.swift`; `Models/ComposerModels.swift`; task/workflow tests | `src/main/acp/SessionActivityProjection.ts`; `src/shared/acp/sessionActivity.ts`; `src/shared/acp/sessionActivityUpdates.ts`; `src/shared/acp/trustedUpdates.ts`; `src/main/AppController.ts`; `src/main/acp/SessionManager.ts`; `src/renderer/src/components/SessionActivityPanel.tsx`; `src/renderer/src/components/SessionDashboardPanel.tsx` | Typed scheduler/background/workflow/goal notifications; bounded pinned scheduler create/list/delete fallback; generation/revision rollback; replay/failure/offline; malformed and overflowed data; cross-session IDs | Typed scheduler truth overrides legacy fallback; create/delete correlation; workflow/goal tombstones and monotonic terminal state; public view has no raw IDs/payloads and is not persisted; only authoritative live work prevents LRU eviction | Read-only Tasks & Workflows modal with Scheduled/Observed/Workflow/Goal sections and separate budgets; live Scheduled Dashboard group; replaying/live/offline states | Real signed-in scheduler and `/workflow`/goal smoke remains nightly-only; never assert model tool choice, and do not claim continuation after Quit | **P1** |
| PAR-015 | Markdown, tables, code, Mermaid/LaTeX, transcript sanitation, and inline media | `Views/RichMessageView.swift`; `Views/MessageBubble.swift`; `Services/InlineMedia.swift`; `Services/AssistantTranscriptSanitizer.swift`; `MarkdownBlockParserTests.swift` | `src/renderer/features/markdown`; `src/main/media/LocalMediaBroker.ts` | GFM and smashed tables; CRLF fence; `$PATH` versus math; angle-bracket placeholder; Mermaid; local/remote image and video; protocol JSON | Equivalent canonical blocks; HTML disabled/sanitized; no protocol telemetry in prose; local files served through a scoped main-process broker rather than unrestricted file URLs | Component screenshot matrix; long lines wrap without clipping; table/code/media and dark/light states | No real CLI required | **P1** |
| PAR-016 | Git branches, worktrees, dirty state, diff review, commit, and PR action | `Services/GitService.swift`; `Views/GitCheckoutSheet.swift`; `Views/PreviewPane.swift`; `ContentView.swift`; `CompetitiveUXTests.swift` | `src/main/git`; `src/renderer/features/git-review` | Temporary git repository; slash-containing branch; linked worktree; dirty diff; command failure | Current branch; worktree detection; dirty count; Dashboard Needs review; all commands use the selected project cwd; no arbitrary renderer command execution | Branch chip; WT badge; checkout/worktree sheet; Preview, commit, and PR controls | Exercise real git in a temporary repository; independent of grok account | **P1** |
| PAR-017 | App and CLI update discovery, banner, panel, install, and restart | `Services/UpdateChecker.swift`; `Services/UpdateScheduler.swift`; `Services/AppUpdater.swift`; `Services/GrokCLIUpdater.swift`; `UpdatePanel.swift`; `Services/UpdateDebugSimulator.swift`; `ContentView.UpdatesBanner`; updater tests | `src/main/updates`; `src/renderer/features/updates` | Unsigned latest/notarized older; draft; malformed release; missing/exact/fallback asset; CLI update JSON; signature/download failure | Only notarized releases are actionable; exact app zip preferred; mutual busy lock; sessions stop before binary swap; skip/dismiss state; restart routing | v0.3.2-specific: no sidebar version badge; the banner opens Updates except for its dismiss target; dual update panel states | `grok update --check --json`; actual app installation only from a signed staging build | **P0** |
| PAR-018 | macOS main window, app menu, Dock, tray/status item, single instance, close/reopen, finish sound, voice input | `AppDelegate.swift`; `StatusBarController.swift`; `MainWindowLayout.swift`; `Services/TurnCompletionSound.swift`; `Services/VoiceInputService.swift`; icon providers; window/status tests | `src/main/index.ts`; `src/main/AppController.ts`; `src/main/macos/window.ts`; `menu.ts`; `tray.ts`; `singleInstance.ts`; `media.ts` | Ready/busy/error/auth/update menu states; second launch; close/reopen; unfocused completion; microphone denied | Close hides rather than quits; Dock reopen restores; one instance; tray/menu routing; app quit cleans every child; sound only when configured and unfocused | Default 1200x800 and minimum 1100x720; menu/tray states; Dock icon scale; About and Help; voice permission state | Launch the packaged app; second-instance handoff; microphone only on a signed/notarized Mac test host | **P1** |
| PAR-019 | macOS Notification Center | No `UNUserNotificationCenter` implementation exists in Swift v0.3.2; `SessionStatus` and finish sound provide product context only | `src/main/macos/notifications.ts`; narrow preload action callback | Background completed, needs-input, and error events; focused/unfocused; permission denied; notification click | Deduplicate by session/turn; foreground suppression policy; click focuses the correct project/session; denial cannot break session processing; no prompt or secret leakage | System notification pixels are not baselined; assert title/body/action text and click routing through a notification adapter | Packaged-app smoke on a dedicated Mac user profile | **P1**, target-only |
| PAR-020 | Error classification, recovery, retry, stale session fallback, process crash, and corrupt local state | `Services/GrokProcess.swift`; `ChatStore.retryConnection`; transcript reconciliation; `Services/DoctorReport.swift`; recovery tests | `src/main/grok/Supervisor.ts`; `src/main/persistence/recovery.ts`; `src/renderer/features/errors` | Invalid JSON; stderr auth error; process exit mid-turn; request timeout; stale session; corrupt preferences; MCP crash; failed queued delivery | No unresolved RPC promises or orphan child; retry reaches ready; queue and transcript survive; stale session starts fresh with an explanatory note; corrupt state is quarantined, not overwritten silently | Error/auth banners; retry action; stale-session note; Doctor remediation; recovery report | Kill a real stdio child and reconnect; separately test logout/auth-required state | **P0** |
| PAR-021 | Electron renderer isolation, contextBridge allowlist, IPC validation, URL/path policy, secret containment | Target requirement; Swift has no equivalent process-isolation contract | `src/main/ipc.ts`; `src/preload/index.ts`; `src/shared/ipc.ts`; dedicated security tests | Unknown channel; invalid payload; path traversal; malicious URL schemes; oversized input; prototype pollution; untrusted navigation/window open | `nodeIntegration=false`; `contextIsolation=true`; sandbox enabled; exact public bridge keyset; main validates every input; no auth, MCP env/header, hook command, or unrestricted filesystem data crosses to renderer | Playwright confirms `require`, `process`, `fs`, and undeclared bridge methods are absent; navigation blocking has no unexpected UI | Audit the packaged app, Electron fuses, child args, and renderer globals | **P0** |
| PAR-022 | Packaging, entitlements, signing, notarization, DMG, update trust, and installed-app migration | `BUILDING.md`; `scripts/build-macos-app.sh`; `scripts/codesign-app-bundle.sh`; `scripts/notarize.sh`; `scripts/GrokBuild.entitlements`; release workflow; `PackagingEntitlementsTests.swift` | `package.json` builder config; `build/entitlements.mac.plist`; release CI; artifact verifier | Unsigned dev app; Developer ID app; stapled DMG; upgrade from previous Electron version; imported Swift profile; read-only install location | Required resources and helpers packaged; microphone usage/entitlement; hardened runtime; Team ID and update trust; install failure is recoverable; upgrade preserves user data | First launch from mounted DMG and `/Applications`; product name, icon, About version, Gatekeeper behavior | `codesign --verify --deep --strict`; `spctl -a -vv`; `stapler validate`; packaged-app launch and quit cleanup | **P0 release** |
| PAR-023 | Saved Agents identity layer, linked roles, starter crew, binding and deletion semantics | `Services/SpecialistAgentStore.swift`; `Services/SpecialistAgentRoster.swift`; `Views/AgentEditorSheet.swift`; `Views/SidebarView.swift`; `AgentsAndCapabilitiesTests.swift` | `src/main/agents/AgentRosterStore.ts`; `src/main/agents/GrokAgentCatalogService.ts`; `src/main/AppController.ts`; `src/main/acp/AcpClient.ts`; `src/shared/agents.ts`; `src/shared/agentCatalog.ts`; `src/renderer/src/components/AgentsSettings.tsx`; `src/renderer/src/components/Sidebar.tsx`; `src/renderer/src/components/Composer.tsx` | Missing/malformed `agents.v1.json`; exact starter crew; duplicate/reserved name; explicit binding plus duplicate/fork inheritance; inline profile new/load/recycle; linked TOML role and failed role write; stable project-scoped CLI catalog | Malformed file remains untouched until explicit recovery; starter install is idempotent; local roster and CLI catalog remain separate; role-write failure rolls back roster; binding survives restart; deletion clears binding but preserves sessions/transcripts and roles | Agents section active-only/show-all; pinned/idle/working; editor validation/recovery/catalog; bound Agent badge in sidebar/dashboard/composer; dedicated Settings baseline | Use signed-in real `grok inspect --json` for discovered agents and prove a bound inline profile through new/load; roster storage remains local and deterministic | **P2** |
| PAR-024 | Custom model providers and managed Cursor bridge | `Services/CustomModelSettings.swift`; `Services/CursorBridge.swift`; `Services/CursorBridgeRuntime.swift`; `Services/CursorBridgeAPIKey.swift`; `Resources/CursorBridge`; model/Cursor tests | `src/main/models`; `src/main/cursor-bridge`; `src/main/secrets`; `src/renderer/features/settings/models` | OpenAI/Responses/Anthropic backend; env key; local/LAN URL; model catalog shapes; bridge offline/online; Node/TLS CA; invalid key | Targeted TOML round trip; provider resolution; model ordering; Cursor secret file permission and no renderer exposure; managed endpoint loopback-only; child cleanup | Provider/model list, Add Provider, fetch/error states, Cursor/Node Doctor states | Read-only model catalog fetch using a disposable test provider; Cursor smoke only with a dedicated credential | **P2** |
| PAR-025 | Cross-session memory browser and remember notes | `Services/MemoryStore.swift`; `Views/MemoryBrowserPanel.swift`; `ChatStore.remember`; `MemoryStoreTests.swift` | `src/main/memory/MemoryBroker.ts`; `src/main/AppController.ts`; `src/main/acp/AcpClient.ts`; `src/shared/memory.ts`; `src/renderer/src/components/MemorySettings.tsx`; `src/renderer/src/memoryPresentation.ts` | Missing memory tree; global/workspace/session Markdown; append under existing/new heading; delete rules; invalid UTF-8; symlink/hardlink/identity races; persistence/reconnect failure; Privacy Mode | Scope grouping and newest-first order; only session files deletable; empty/oversized notes rejected; launch flag matches durable setting on every worker path; persistence precedes safe recycle; capabilities and paths remain transient | Staged Apply & Restart; grouped browser and bounded Markdown preview; remember; native-confirmed session delete; empty/error/private states; normal/private baselines | Under isolated `HOME`/`GROK_HOME`, start signed-in Grok CLI 1.0.5 sessions with memory disabled and enabled; never inspect private production memory; capture Quit continuation semantics separately | **P2** |
| PAR-026 | Privacy mode, accessibility copy, reduce motion, and sensitive-screen capture behavior | `Services/PrivacyMode.swift`; privacy uses in Sidebar/Chat/History; accessibility labels in status/menu controls; `CompetitiveUXTests.swift` | `src/renderer/features/privacy`; shared redaction helpers; renderer accessibility tests | Named projects/sessions, absolute paths, worktree, custom Agent; privacy on/off | Redaction is display-only; persisted state stays unchanged; every interactive status/control has a stable accessible name; reduce motion disables nonessential transitions | Whole-window privacy screenshot and corresponding normal screenshot; AX tree snapshot; light/dark and reduced-motion variants | No real CLI required | **P1** |

## Visual comparison policy

SwiftUI/AppKit and Chromium do not rasterize text identically. Cross-implementation
parity therefore uses two layers:

1. Electron screenshots are compared strictly against Electron-owned Playwright
   baselines.
2. Swift-to-Electron comparison uses Accessibility text/order, named layout
   landmarks, component bounds, design-token values, and a perceptual image diff
   with explicitly declared dynamic masks.

Capture conditions are fixed to macOS 26, 1200x800 default window, 2x scale,
`en_US`, UTC, light and dark appearance, and reduced motion. Additional minimum
window captures use 1100x720. UUIDs, request IDs, elapsed timers, timestamps,
token counters from live service calls, cursor blink, scrollbars, and animated
status indicators are masked. Geometry drift over two physical pixels in a
named landmark is a failure unless recorded in `known-differences.json`.

## Real CLI smoke boundary

Mock/replay owns deterministic PR behavior. Real CLI tests validate only stable
integration invariants:

- executable discovery and version parsing;
- initialize and session creation;
- at least one streamed message and completed prompt;
- current model/mode control when advertised;
- session load after application restart;
- accepted deterministic MCP configuration;
- child-process termination and reconnect;
- update check parsing.

They do not assert exact model prose, whether a model chooses a particular tool,
token counts, latency, or third-party service availability. Real account tests
run in nightly/release jobs on a dedicated profile and never update replay
baselines automatically.

## Completion gates

Suggested final command surface:

```bash
npm run reference:verify
npm run qa:fixtures
npm run typecheck
npm run lint
npm run test
npm run qa:parity:p0
npm run test:e2e
npm run test:visual
npm run test:smoke:grok
npm run dist:mac
npm run verify:mac
npm run qa:report
```

Commands not yet present in `package.json` are contractual target commands, not
claims that the current scaffold already implements them.

A migration build is not complete until:

- every P0 and P1 row is implemented and evidenced;
- P2 rows required for complete Swift v0.3.2 parity are also closed;
- every scenario has a source reference and owner;
- no unapproved or expired known difference remains;
- the real CLI smoke suite passes on the pinned supported CLI range;
- a packaged macOS app passes security, signing, Gatekeeper, notarization,
  clean-profile migration, upgrade, and child-process cleanup checks;
- the generated parity report lists no missing required domain.
