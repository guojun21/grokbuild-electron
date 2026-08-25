# Parity QA contracts

This directory defines how the pinned Swift application, pinned Grok CLI contract, and Electron
implementation are compared. A passing Electron test is regression evidence; it is not, by itself,
proof of Swift parity or release readiness.

## Immutable references and authority

`reference/upstream.json` pins the Swift behavior/visual reference:

- repository: `rimusz/grok-build-desktop`;
- tag: `v0.3.2`;
- commit: `060de18dc1b9e680cf43781b9cd5ce3b85c0faf8`;
- license: Apache-2.0.

Reference verification fails if the tag resolves to a different commit, the license differs, or
the fetched checkout is dirty. A moving upstream branch never redefines parity.

Authority is surface-specific:

1. The pinned real Grok CLI/ACP behavior is authoritative for JSON-RPC methods, wire shapes,
   arguments, terminal/fs callbacks, session lifecycle, model/mode capability truth, and MCP
   acceptance.
2. Swift v0.3.2 source and native black-box behavior are authoritative for existing desktop
   workflow, persistence semantics, macOS shell behavior, copy, accessibility hierarchy, and visual
   reference.
3. Sanitized captures are evidence only for the CLI version and platform recorded with them.
4. Explicit target contracts govern Electron-specific security isolation, content-free system
   notifications, migration import, and other behavior absent from Swift.
5. The Electron implementation never authorizes its own expected result merely by existing.

Protocol conflicts resolve to the pinned CLI. Existing desktop-product conflicts resolve to the
pinned Swift reference. Security conflicts resolve to the stricter explicit target contract and
must be recorded if that creates a product difference.

## The three truth files

### Human inventory: `docs/PARITY_MATRIX.md`

Every required capability has a stable `PAR-xxx` ID and priority. P0 is a migration blocker, P1 is
required before public release, and P2 remains required before claiming complete parity.

The matrix describes scope and expected evidence. It is not used as a prose status checklist.

### Machine status: `parity-evidence.json`

The evidence manifest is the status source of truth. It covers every matrix ID exactly once with:

- the same priority as the matrix;
- one of `verified`, `partial`, `missing`, `external-blocked`, or
  `intentional-difference`;
- repository-relative implementation, test, and artifact paths;
- a concise current gap.

`npm run qa:contracts` checks that the matrix and manifest have no missing or extra IDs, priorities
match, keys/statuses are valid, every evidence path is a real repository file, and every
`verified` entry names at least one test or artifact. Documentation prose cannot make an entry
green.

### Scoped differences: `known-differences.json`

This registry contains concrete differences, including current pending migration gaps. Each record
is tied to a matrix scenario, priority, surface, non-wildcard selector, expected/actual behavior,
reason, owner, issue, introduction date, expiry, and `approvalStatus`.

- `pending` documents a difference and must not contain `approvedBy`;
- `approved` requires `approvedBy` and may be used only while unexpired;
- expiry or malformed scope fails contract validation;
- a manifest `intentional-difference` must have a related registry record;
- a pending record is never a waiver and blocks P0/P1 release readiness.

Broad selectors, wildcard masks, and removing a failing assertion are not valid resolutions.
Secret exposure, signature/identity failure, traversal, data loss, and child-process cleanup failures
are not made acceptable by a difference record.

## Evidence layers

The harness deliberately keeps these layers distinct:

1. `qa:swift-reference` builds/tests the pinned source checkout. This proves the reference is
   healthy on the host; it does not exercise the Electron app.
2. Request-driven fake-Grok scenarios, unit tests, Electron E2E/visual tests, and packaged smoke
   exercise the Electron implementation deterministically.
3. `qa:swift-blackbox` drives the native pinned app with an isolated profile and the request-driven
   fake CLI, producing evidence from the other implementation.
4. Canonical comparison evaluates normalized artifacts from the two implementations.
5. The evidence manifest records whether each parity domain has enough implementation and
   test/artifact evidence.

Do not collapse these into a single claim such as “the Swift tests passed, therefore Electron has
parity.”

For PAR-011, unit and Electron evidence covers the Swift status priority, transient unread/focus
rules, schema-v5 settled/pinned invariants, bounded local project/title and bound Saved Agent
name/mission search, six-group current-project Dashboard, selected-project Git isolation, and the
distinct opaque-token CLI History list/search/ACP-open/native-delete path. The macOS visual lane
holds separate Dashboard and History baselines in addition to conversation and context usage.
PAR-014 supplies the live read-only Scheduled source and PAR-023 supplies local Saved Agent search
identity; PAR-011 remains partial because no signed-in real Grok CLI run proves the two-session
background-completion/focus/open behavior.

For PAR-023, deterministic evidence must keep two authorities separate. The local versioned roster
owns Saved Agent identity, starter templates, bindings, and main-derived inline ACP profiles. The
project-scoped `grok inspect --json` result is a read-only CLI catalog whose selectors and paths stay
in main; displaying it does not prove local identity linkage. Unit and Electron evidence covers
CAS/recovery/starter/binding/profile-recycle/deletion behavior and the Saved Agents UI, including
restart/resume and a visual baseline. The row remains partial until linked TOML role/prompt-file
mutation has an atomic rollback contract, signed-in real-CLI catalog/profile smoke is committed,
and the documented same-UID pathname ABA residual is either hardened or explicitly retained as a
known platform limit.

For PAR-025, deterministic evidence covers the main-owned Memory capability broker, bounded
global/workspace/session projection, global remember and session-only native-confirmed deletion,
v1-v4-to-v5 `memoryEnabled` persistence, durable-before-recycle AppController transaction, strict
IPC/preload boundary, exactly one memory flag on every ACP worker launch, Settings behavior,
Privacy Mode DOM/full-AX canaries, restart/process-argv E2E, and normal/private visual baselines.
Those tests use an isolated synthetic memory root. They do not prove signed-in Grok CLI 1.0.5
behavior, eliminate the documented same-UID final-path race without a native directory-FD helper,
or prove CLI-owned continuation after Quit. The row must remain partial until those three evidence
boundaries are resolved. P2 audit residuals are also not hidden: worker stop lacks utility-exit/
process-group proof in its timeout case, broker clear cannot revoke an already-resolved read/delete
linearly, and a well-shaped stale/foreign delete token is confirmed before capability revalidation
even though the later mutation fails safely.

For PAR-017/PAR-022, unit and Electron E2E tests may prove candidate containment, transaction
order, signature-policy invocation, quiescence, hostile-IPC rejection, and Squirrel handoff state.
They do not prove a release update. Moving either row to `verified` also requires artifacts from a
Developer ID-signed/notarized previous-version-to-current installation on macOS, including
installed identity/Gatekeeper checks and replacement-failure recovery. Squirrel's implementation
backup is not an artifact, and successful launch has no automatic crash rollback today.

The connected CLI install lane has a separate evidence boundary. Unit and real-Electron tests with
the request-driven mock may prove zero-argument IPC, main-owned path/cwd selection, the shared
quiescence lock, strict semver/prerelease target confirmation, fixed
`grok update --version <target>`, exact local `grok --version` verification, display-only feed
refresh, terminal ambiguous-failure handling, and startup/quit barriers. The dedicated lifecycle
E2E must prove that ordinary quit waits for an in-flight updater and that ACP never reconnects
through an unverified executable. These tests do not prove a real managed CLI self-update or
application-owned rollback of an upstream partial install, and they do not replace the signed App
artifacts required above.

PAR-022 workflow evidence also distinguishes structural containment from positive signing proof.
Tests may prove separate unsigned/signing jobs, an exact 11-key child environment, disabled checkout
credential persistence, dedicated signing-temp/keychain cleanup, absence of candidate execution on
the signing runner, and exact-ZIP verification as the last repository-produced executable boundary.
After that boundary the workflow may only checksum and upload unchanged artifacts. These assertions
do not provide a Developer ID identity, notarization result, installed-App launch, or upgrade capture;
the row must remain partial until those external artifacts exist.

## Deterministic scenarios and fake Grok

Scenarios under `qa/scenarios` pin the Swift commit and Grok version, declare request barriers, and
name state/RPC/filesystem/accessibility/visual assertions. `qa:contracts` validates their IDs,
priorities, reference pin, nonempty steps/assertions, and referenced artifacts.

`qa/mock-grok.mjs` is request-driven. When a scenario is active, it waits for and validates the
expected command or ACP request before releasing the next result/update. Recursive object subsets
may be matched where declared; arrays remain exact and ordered. An unexpected method, parameter,
order, duplicate request, command, or extra output fails instead of being hidden by a sleep.

The fake covers the ACP lifecycle and one-shot CLI surfaces used by the application, including MCP
and update inspection. Fault profiles may emit deterministic malformed output, stderr, timeout,
or process exit. Arbitrary wall-clock sleeps are not synchronization; only an outer deadlock
watchdog may rely on real time.

Every new CLI-derived fixture must record its own CLI version, platform, capture time,
sanitization status, and source. Captures are not timeless protocol specifications.

## Native Swift black-box driver

The opt-in driver lives under `qa/drivers/swift-blackbox` and is invoked with:

```bash
npm run qa:swift-blackbox:preflight
npm run qa:swift-blackbox
```

It builds/copies the pinned Swift v0.3.2 application under an independent QA bundle identity,
creates an isolated HOME, installs the request-driven fake as that profile's Grok executable, and
uses macOS Accessibility automation for boot-ready, add-project, create-session, and send-prompt
behavior. Canonical artifacts include the AX tree, fake-CLI RPC log, isolated preferences, window
screenshot, and a run manifest.

Accessibility and Screen Recording authorization are host-specific. Missing authorization emits a
clear blocked manifest and exit code `77`; the lane cannot pretend to pass. For that reason the
driver is opt-in and not part of the default PR gate.

## Canonical state and normalization

Canonical artifacts contain observable product behavior, not React component state, Swift object
identity, process handles, private caches, raw credentials, or unredacted environment values.

Allowed normalization removes nondeterminism while preserving semantics:

- map generated IDs by first semantic appearance and reuse the same token everywhere;
- map isolated roots to named tokens while preserving relative path, kind, mode, size, and digest;
- normalize absolute time against a declared virtual origin while preserving order and duration;
- normalize transport line endings, not product-authored whitespace or Markdown structure;
- preserve transcript, RPC, project, session, menu, Dashboard, and user-visible list order;
- sort only a collection whose contract explicitly defines it as a set;
- redact secrets during capture, before an artifact is written.

Normalization must not sort events to hide ordering bugs, deduplicate product state, replace exact
fixture usage counts, trim copy, or mask an entire component.

## Canonical comparison

Run a bounded comparison with:

```bash
npm run qa:compare -- \
  --expected path/to/expected.json \
  --actual path/to/actual.json \
  --output path/to/diff.json
```

The comparator bounds input size, depth, visited nodes, and reported differences. Arrays are exact
and ordered; object keys are traversed deterministically. A difference report does not echo the
differing values. It records kind, path, length/key metadata where applicable, and SHA-256 summaries
so CI logs and artifacts do not become a data-exfiltration surface.

An ignored JSON subtree requires both the difference ID and exact JSON pointer:

```bash
npm run qa:compare -- \
  --expected expected.json \
  --actual actual.json \
  --waive KD-0001:/exact/json/pointer
```

The referenced registry record must be approved, unexpired, and pointer-scoped. Pending records
cannot waive output. A nonmatching pointer does nothing.

## Generated report

`npm run qa:report` validates the contracts, then generates:

- `qa/reports/migration-coverage.json` for tools;
- `qa/reports/migration-coverage.md` for review.

The report derives status counts, release readiness, blocker IDs, and domain rows from
`parity-evidence.json`. It inventories deterministic scenarios, NDJSON fixtures, unit/E2E files,
and known-difference approvals from the repository at generation time. Migration prose may add
context but cannot override this result.

## Development, black-box, and release gates

### Development

```bash
npm run qa
```

This runs the repository's pinned-reference, contracts, security, unit, Electron, and reporting
lane. It is intended to stay useful while migration is in progress. It deliberately does not call
`qa:release-readiness`.

### Native comparison

Run `qa:swift-blackbox` only on a macOS host with the required TCC permissions. Preserve its
blocked state when the host is not authorized, and never substitute a stale artifact without
recording provenance.

### Release readiness

```bash
npm run qa:release-readiness
```

This command first requires valid parity contracts. It then prints stable
`RELEASE_BLOCKER <ID> <status>` lines and exits nonzero for:

- any P0/P1 entry with status `partial`, `missing`, or `external-blocked`;
- an `intentional-difference` without complete approved registry coverage;
- every pending P0/P1 known difference.

The GitHub release workflow runs this command before packaging. The current repository is expected
to fail release readiness until its incomplete rows and pending differences are resolved; this is
the intended truthful result, not a development-test failure.

## Review checklist

When changing a parity domain:

1. update implementation and deterministic evidence together;
2. update the matching manifest row without changing its matrix priority;
3. keep evidence paths real, narrow, and repository-relative;
4. register an observed difference as pending unless an authorized reviewer explicitly approves
   it;
5. regenerate the report;
6. inspect the exact release blocker IDs rather than relying on prose or test totals;
7. keep secrets, private prompts, repository content, auth material, MCP values, and absolute user
   paths out of committed fixtures and diff output.
