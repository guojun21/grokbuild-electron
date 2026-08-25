# PAR-026 Privacy, Accessibility, and Reduced-Motion Audit

Audit date: 2026-08-25  
Swift reference: `v0.3.2` / `060de18dc1b9e680cf43781b9cd5ce3b85c0faf8`  
Electron scope: baseline audit plus the integrated PAR-026 vertical slice

This document preserves the read-only comparison of the existing Swift and pre-PAR-026 Electron
interfaces, then records the implementation and proof added from that audit. Baseline finding
counts below describe the interface before the vertical slice; unresolved general accessibility
findings remain valid unless explicitly listed as closed.

## Implementation status

The privacy vertical slice is now integrated:

- `privacyMode` is a strict persisted boolean with v1-v4 to v5 migration. Updating it emits a raw
  authoritative snapshot but does not reconnect or restart a worker.
- The shared display-only resolver is applied at final renderer boundaries for project/session
  labels, paths and attachments, worktree/branch metadata, Saved Agent names/missions/catalog,
  Dashboard, History, tooltips, explicit accessible names, and protected input values.
- Saved Agent editing is unavailable while private, local search values are cleared when the mode
  turns on, and the main-owned History deletion dialog derives fixed private copy from the main
  setting. Notifications remain identical and content-free.
- An Electron E2E canary scans serialized DOM, every rendered input value, Chromium's full
  accessibility tree, captured native-dialog options, and the restarted app. It separately proves
  that the bridge snapshot and persisted domain retain their raw values.
- Whole-window 1100×720 light/dark baselines cover the private core. The reduced-motion baseline
  uses the real app preference with screenshot animation suppression disabled and asserts no CSS
  animation name, no transition duration, and zero running document animations.

Privacy Mode remains a metadata screen-sharing aid, not transcript DLP. The menu keyboard model,
transcript live-region scope, and the rest of the baseline accessibility matrix remain follow-up
work rather than claims of this slice.

## Anti-pattern verdict

Pass. The Electron interface reads as a compact macOS developer instrument rather than a generic
AI dashboard. It avoids gradient text, neon-on-dark AI styling, glass stacks, oversized hero
metrics, and decorative motion. The system font is appropriate to the explicit native-macOS design
context. The activity summary and Saved Agent tiles use repeated cards, but they communicate real
operational state rather than ornamental metrics. Preserve this restraint during PAR-026.

## Executive summary

- Findings: **0 critical, 7 high, 7 medium, 1 low**.
- The highest-risk issue is simple: Electron has no privacy preference or final render-boundary
  projection, so project/session/Agent/history metadata remains visible in pixels, tooltips, form
  values, native dialogs, and the accessibility tree.
- Swift establishes the correct display-only rule but is not a complete target: it leaks the final
  path component, Saved Agent identity, Dashboard branch/Agent metadata, a History header path, and
  remote session ids.
- Electron already has strong foundations worth preserving: fixed content-free notifications,
  bounded History/Dashboard DTOs, native modal dialogs, global focus-visible styling, and both OS-
  and app-controlled reduced-motion CSS.
- Privacy Mode is a screenshot/screen-share presentation feature, not a renderer confidentiality or
  content-DLP boundary. The raw snapshot still contains trusted UI data, and transcript content is
  intentionally outside this metadata-only contract.

## Swift v0.3.2 baseline and known holes

| Reference location | Behavior | Audit result |
| --- | --- | --- |
| `GrokBuild/Services/PrivacyMode.swift:3` | Pure display helpers; stored records are untouched | Correct architectural rule |
| `PrivacyMode.swift:9-16` | Path becomes `••••/<lastComponent>` | Insufficient for a named private project because the basename remains visible |
| `PrivacyMode.swift:18-39` | Project/session labels become fixed `Project` / `Session` | Safe but repeated rows become indistinguishable |
| `GrokBuild/Views/SettingsView.swift:5697-5706` | Persisted `Privacy Mode` toggle and accurate “Stored data is unchanged” copy | Target behavior to retain and expand |
| `GrokBuild/Views/SidebarView.swift:731-930` | Masks session/project/path and the sidebar branch caption | Agent/specialist/role names and mission help remain raw |
| `GrokBuild/Views/SessionsBrowserPanel.swift:197-230` | Masks row project/path/title | Top header path at `197-200` and remote session id at `263-269` remain raw |
| `GrokBuild/Views/SessionDashboardPanel.swift:155-201` | Masks header path, project, and session | Specialist name and branch at `226-239` remain raw |
| `GrokBuild/Views/ParallelSessionSheet.swift:316-342` | Masks the project path | Named session/worktree form values remain intentionally editable |
| `GrokBuild/Views/ChatView.swift:60` | Declares the setting | The property is not used by this view; tool/file paths and Agent labels are not covered |
| `Tests/GrokBuildTests/CompetitiveUXTests.swift:869-891` | Tests one path and one label helper | No whole-window, AX-tree, theme, narrow-window, or motion proof |

Electron should port the display-only invariant, not the Swift leaks. The strict target uses fully
input-independent placeholders and optional one-based ordinals (`Project 1`, `Session 2`) so no
private basename is retained while rows remain operable.

## Public surface inventory

The “privacy target” column applies to visible text, `title`, `aria-*`, form values exposed to the
accessibility tree, status/toast copy, and native dialog copy. Masking only text nodes is not enough.

| Domain | Current Electron surfaces | Current exposure | Privacy target |
| --- | --- | --- | --- |
| Project | Sidebar row and search; project tooltip; project/action menu AX names; remove confirmation; topbar title and Open-in menu AX name; Dashboard/History headers; Tasks/Agents/MCP settings context | Raw name everywhere; absolute path in sidebar `title`; raw name in confirmations and AX | `Project n`; path `••••`; raw id remains routing-only |
| Session | Sidebar active/pinned/settled text, tooltip, action/menu AX names; topbar subtitle; Dashboard cards; Tasks & Workflows header | Raw title in pixels, title attributes, and computed button names; working duration changes the computed name each second | `Session n`; explicit stable `Open Session n` / `Actions for Session n` names; status described separately |
| Path | Sidebar project tooltip; missing-CLI banner; Settings CLI-path input; attachment filename chips; project-scoped native open panels; future worktree paths | Absolute project/CLI paths and filename components can be captured; native pickers are outside renderer control | In-app path value `••••`; attachment `Attachment n`; native picker limitation documented |
| Worktree/Git | Dashboard `Worktree` chip and raw branch; a linked-worktree project path can also leak through the sidebar tooltip | Boolean worktree label is safe; branch and path are not | Keep generic `Worktree`; branch `Branch`; any worktree name/path uses fixed placeholder |
| Saved Agent | Sidebar Agent roster; bound session tooltip/avatar AX; Composer select/badge; Settings roster name/mission/toasts/actions/editor title and input values | Name and mission appear visually and in AX; avatar labels duplicate visible names | `Saved Agent n`; mission `Instructions hidden`; neutral decorative avatar while private; editing unavailable while private |
| CLI Agent catalog | Settings loading context, Agent/plugin names and descriptions | Project/custom/plugin configuration may be private even though it is not the local roster | Mask project/user/plugin entries or the whole catalog body while private; built-ins may remain only if provenance is authoritative |
| History | Header project; visible search query; summary rows; delete-button AX name; native delete confirmation `detail` | Summary/first prompt and query are visible; native dialog repeats the summary | `Saved session n`; protected/masked query field; native confirmation uses fixed generic detail |
| Dashboard | Header project; session title; model/mode; pending/dirty counts; worktree flag; raw branch | Project/session/branch are sensitive; model and aggregate counts are safe | Apply the same resolver to pixels and explicit card AX names; preserve safe state/count metadata |
| Notifications | Fixed completed/needs-input/error copy; opaque main-owned click target | No prompt, title, Agent, project, path, model, or error detail is emitted | Keep identical in normal/privacy modes; privacy must never weaken or personalize this boundary |
| Transcript/tool activity | User/assistant prose, tool titles/details, activity labels | Can contain arbitrary user content or paths | Explicitly out of PAR-026 metadata redaction scope; do not market Privacy Mode as DLP |

Relevant Electron locations include `src/renderer/src/App.tsx:343-469`,
`src/renderer/src/components/Sidebar.tsx:168-221,310-482`,
`SessionDashboardPanel.tsx:82-147`, `SessionHistoryPanel.tsx:45-135`,
`SessionActivityPanel.tsx:60-83`, `Composer.tsx:176-240`, `AgentsSettings.tsx:249-424`,
`SettingsPanel.tsx:72-125`, and `src/main/ipc.ts:448-463`.

## Detailed findings

### High severity

| ID | Category and location | Impact / standard | Required correction |
| --- | --- | --- | --- |
| H1 | Privacy — `models.ts:153-160`, `SettingsPanel.tsx:72-108`, `App.tsx`, `Sidebar.tsx` | No preference or projection exists; every scoped identity is capturable | Add a strict boolean setting and use the shared resolver only at final presentation boundaries |
| H2 | Privacy — `Sidebar.tsx:195-221,408-482`, `App.tsx:439,468`, `SettingsPanel.tsx:91-95`, `ipc.ts:453-457` | A visible-text-only fix would still leak through `title`, `aria-label`, input value, and a native History confirmation | Maintain a surface checklist; assert canaries are absent from DOM attributes, input accessibility values, full AX tree, and native-dialog options |
| H3 | Privacy/forms — Sidebar and History queries; `AgentsSettings.tsx:313-424,493-590` | Search terms, Agent editor values, missions, catalog text, and mutation toasts can reveal hidden data after the toggle | Keep raw query only as local behavior state but protect its rendered value; block opening Agent editors while private; project all notices and catalog copy |
| H4 | Accessibility — `Sidebar.tsx:189-221,327-341` | Buttons derive names from nested visible text, labeled avatars, pins, project copy, and a per-second status. Names are duplicated and unstable. WCAG 4.1.2, 2.4.6 | Give each control one explicit action-oriented name; make decorative nested icons/avatars hidden; describe status separately without elapsed-time churn |
| H5 | Keyboard/focus — `Sidebar.tsx:211-270,427-498` | `role="menu"` popovers lack menu focus/arrow/Escape behavior, and the inline project `alertdialog` is not a modal/focus-managed confirmation. WCAG 2.1.1, 2.4.3 | Implement a real roving-focus menu or use ordinary popover semantics; move destructive confirmation to the native modal surface and restore trigger focus |
| H6 | Live regions — `Transcript.tsx:34` plus nested status/alert rows | `aria-live="polite"` on the entire streaming transcript can repeatedly announce large partial responses and nested tool states. WCAG 4.1.3 | Use a bounded dedicated atomic live status; keep the readable transcript/log navigable without announcing every stream chunk |
| H7 | Contrast — `styles.css:11-13,101,121,352,397,427,432,490,573` | `#9299a6` on white is ~2.87:1; dark faint text is ~4.04:1; several amber/green small labels are below 4.5:1. Much of this text is 8.5-10px. WCAG 1.4.3 | Raise faint/semantic token contrast in both themes and validate actual composited backgrounds; do not use tiny size to compensate for weak contrast |

### Medium severity

| ID | Category and location | Impact / standard | Required correction |
| --- | --- | --- | --- |
| M1 | Accessibility — `SessionDashboardPanel.tsx:128-146`, `SessionHistoryPanel.tsx:112-135` | Open-row controls rely on long computed subtree names and do not lead with the action; Dashboard details can overwhelm the primary name | Use exact `Open Session n` / `Open Saved session n`; connect secondary metadata with `aria-describedby` |
| M2 | Target size — `styles.css:87,413,576` | 20-23px clear/Agent action controls fall below WCAG 2.2 AA 2.5.8's 24×24 CSS-pixel minimum | Expand hit boxes to at least 24×24 without reducing the compact visual glyph |
| M3 | Responsive — `styles.css:180-194,740-742` | At 1100×720 a long, non-shrinking project `<strong>` competes with five fixed toolbar actions; only sidebar width changes | Give title parts shrink/ellipsis rules and add a deterministic 1100×720 long-canary baseline |
| M4 | Theming — semantic hard-coded colors throughout `styles.css` | Health/attention/history/activity colors do not all adapt for dark backgrounds and some fail contrast only in one theme | Promote semantic tones to light/dark tokens and test both forced themes, not only system mode |
| M5 | Reduced motion QA — `styles.css:729-738`, `App.tsx:80-85` | The implementation is promising but Playwright screenshots currently force animations off, which can hide a broken preference | Test the OS media query and app setting independently; assert no nonessential running animations before capture |
| M6 | AX regression coverage — `tests/e2e/visual.spec.ts` | There is no normalized whole-window accessibility-tree baseline or sensitive-canary scan | Capture the Chromium full AX tree, strip volatile node ids, snapshot semantic fields, and reject every private canary |
| M7 | Visual privacy coverage — `tests/e2e/visual.spec.ts` | Existing 1200×800 light screenshots do not cover privacy, dark, minimum window, or real reduced-motion state | Add the orthogonal full-window matrix below and keep screenshot animation disabling out of the reduced-motion proof |

### Low severity

| ID | Category and location | Impact | Required correction |
| --- | --- | --- | --- |
| L1 | Performance — `Sidebar.tsx:85-151` | A working session updates `nowMs` every second and rebuilds all project/session/Agent maps and rows | Isolate elapsed-time rendering or memoize bounded presentation maps after correctness and AX names are fixed |

## Display-only projection contract

`createPrivacyDisplayResolver(enabled)` is intentionally presentation-only:

| Kind | Normal | Privacy |
| --- | --- | --- |
| Project | exact stored name | `Project n` |
| Session | exact stored title | `Session n` |
| Filesystem / CLI path | exact path | `••••` |
| Worktree name | exact name | `Worktree n` |
| Git branch | exact branch | `Branch` |
| Saved Agent name | exact name | `Saved Agent n` |
| Saved Agent mission | exact mission | `Instructions hidden` |
| History summary | exact summary | `Saved session n` |

Rules:

1. Normal mode returns the source string byte-for-byte; it does not trim or normalize.
2. Privacy output is independent of the source. In particular, it does not preserve the path
   basename as Swift does.
3. Optional ordinals are derived from the already-authoritative visible ordering, never an id or
   secret. Invalid/unbounded ordinals are omitted.
4. Search, selection, sorting, routing, and IPC always use authoritative records and opaque ids.
5. Apply the resolver separately to visible copy and accessible copy. Never derive an accessible
   name from a raw hidden value.
6. Do not construct a redacted `AppSnapshot` and feed it back into mutations: placeholders must be
   impossible to persist as project/session/Agent data.

## Strict toggle and IPC boundary design

1. Add `privacyMode: boolean` to `AppSettings`; bump persisted state to v5 and migrate v1-v4 with
   `false`. The preference may persist, but project/session/Agent/history data must not change.
2. Extend the existing strict `updateSettingsInput` with optional `privacyMode: z.boolean()` and
   require at least one known field. Reject `"true"`, `1`, `null`, unknown keys, empty objects, and
   renderer-supplied names/paths.
3. The Settings switch sends only `{ privacyMode: checked }`. No `redact(text)` IPC and no generic
   renderer-controlled privacy payload should exist.
4. Main stores the boolean, emits a new snapshot revision, and performs no session reconnect,
   worker restart, CLI call, catalog refresh, or transcript/state rewrite.
5. Renderer creates one resolver from the trusted snapshot setting and uses raw values for matching
   and ids, then projects at each text/title/ARIA/value boundary. A small `PrivacyContext` is safer
   than copying a transformed domain snapshot.
6. Main-native surfaces cannot trust renderer projection. At dialog presentation time, main reads
   its own current setting. History deletion uses fixed generic detail in privacy mode; Saved Agent
   deletion is already generic. Native notifications remain fixed and content-free in all modes.
7. When private, prevent opening a Saved Agent editor and use a stable explanation. A search query
   can remain in local state for filtering but its rendered/accessibility value must be protected.
8. Set `data-privacy="true|false"` on `<html>` only as a styling/test hook; CSS must never be the
   only redaction mechanism because hidden/raw DOM and AX values are still capturable.

## Visual and accessibility QA design

### Deterministic canary fixture

Use distinct canaries in every domain: project basename/display name, two session titles, linked
worktree path and branch, Saved Agent name and mission, CLI-history summary/query, CLI path, and an
attachment filename. Keep transcript prose non-sensitive because transcript redaction is explicitly
out of scope. Create enough repeated rows to prove ordinals are deterministic.

### Full-window visual matrix

All captures are `page.toHaveScreenshot`, so overlays remain whole-window screenshots rather than
component crops.

| ID | Size | Appearance | Privacy | Motion | Surface |
| --- | --- | --- | --- | --- | --- |
| VIS-026-01 | 1200×800 | light | off | normal | conversation shell |
| VIS-026-02 | 1200×800 | light | on | normal | same shell, direct privacy pair |
| VIS-026-03 | 1200×800 | dark | off | normal | conversation shell |
| VIS-026-04 | 1200×800 | dark | on | normal | same shell, direct privacy pair |
| VIS-026-05 | 1100×720 | light | off | normal | long-name shell and complete toolbar |
| VIS-026-06 | 1100×720 | light | on | normal | same minimum-size shell |
| VIS-026-07a-c | 1100×720 | dark | on | normal | Dashboard, History, Saved Agents overlays |
| VIS-026-08 | 1200×800 | light | on | reduced | working/refresh state with no nonessential motion |

Do not use only `animations: 'disabled'` for VIS-026-08; that Playwright option can make a broken
preference look correct. First assert the actual app state and running-animation set, then capture.

### Privacy/persistence assertions

- In normal mode, DOM text/attributes and normalized AX tree contain the canaries expected on each
  surface.
- In privacy mode, scan `innerText`, every `title`, `aria-label`, `aria-description`, input value
  exposed to AX, the normalized full AX tree, and captured native-dialog options; none may contain
  any canary or a private path basename.
- The bridge snapshot remains authoritative and still contains raw values in privacy mode. This
  proves presentation, not domain data, was projected.
- Hash projects, sessions, Agent roster, selection/order/pins, and transcript before/after toggling;
  they must be byte-equivalent. Only the privacy preference and ordinary snapshot revision may
  differ. Restart must preserve the preference and raw domain values.
- Notification presenter options are identical in normal/privacy modes and contain no canary.

### AX-tree and keyboard assertions

Use a CDP session with `Accessibility.getFullAXTree`. Normalize each non-ignored node to stable
semantic fields (`role`, `name`, protected `value`, `checked`, `expanded`, `disabled`, `focusable`),
drop backend/node ids, then snapshot:

- conversation shell, privacy off and on;
- Dashboard, History, and Saved Agents in privacy mode;
- light versus dark semantic equality;
- 1200×800 versus 1100×720 preservation of every action;
- normal versus reduced-motion semantic equality.

Also assert exact accessible names, not substring matches: `Open Session 1`, `Actions for Session 1`,
`Open Saved session 1`, `Delete Saved session 1`, `Privacy Mode` with the correct checked state, and
generic Saved Agent actions. Run keyboard-only Tab/Shift-Tab, menu arrow/Escape, modal focus trap,
and focus-return flows. A working-session name must remain stable across at least two timer ticks.

### Reduced-motion assertions

- App preference: `data-reduce-motion="true"`, computed animation/transition duration is zero, and
  `document.getAnimations()` has no running nonessential animations after opening working,
  refreshing, and loading states.
- OS preference: emulate `prefers-reduced-motion: reduce` while the app preference is false and
  repeat the assertion.
- Essential state remains perceivable without spinning: loading/working copy and `role="status"`
  text must still identify the state.

## Positive findings to preserve

- `ModalSurface` uses native `<dialog>.showModal()`, inert background content, scoped Escape, and a
  deliberate initial-focus policy.
- Global `:focus-visible` styling is present.
- CSS already honors both `prefers-reduced-motion` and the app setting.
- History remote ids and Dashboard filesystem identities do not enter renderer DTOs.
- Native notification copy is fixed, content-free, and click routing uses an opaque target.
- Saved Agent delete confirmation is already generic and does not need the Agent name.

## Original recommended sequence

1. Add the v5 setting migration and strict boolean IPC contract; prove no domain mutation.
2. Wire the shared resolver through a renderer privacy context and cover every inventory row,
   including tooltip/ARIA/form/native-dialog surfaces.
3. Fix explicit stable AX names, keyboard menu/confirmation behavior, and transcript live-region
   scope before accepting AX snapshots.
4. Raise semantic token contrast in both themes and fix the sub-24px targets.
5. Add canary, visual, AX-tree, keyboard, 1100×720, theme, and real reduced-motion gates.
6. Only then update PAR-026 from missing to partial/verified; do not claim transcript DLP or native
   picker redaction.
