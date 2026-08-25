# Swift black-box QA driver

The opt-in Swift driver exercises the pinned GrokBuild `v0.3.2` reference as a
real macOS application. It is a separate evidence tier from source tests and
the Electron Playwright suite; it is intentionally **not** part of `npm run qa`.

## What it runs

The driver verifies commit
`060de18dc1b9e680cf43781b9cd5ce3b85c0faf8`, builds the release Swift binary,
and assembles an ad-hoc-signed QA app with the independent bundle identifier
`com.oasmet.grokbuild.swift-blackbox-qa`. It launches that app with isolated
`HOME` and `CFFIXED_USER_HOME` directories. The request-driven
`qa/mock-grok.mjs` is copied to that profile as `~/.grok/bin/grok`; no installed
Grok CLI, account, or normal GrokBuild preferences are used.

The AX driver waits on observable UI barriers and performs this minimum flow:

1. wait for the boot-ready “Add Project” state;
2. add an isolated fixture project through the native folder picker;
3. create a new session with Command-N;
4. enter and submit the scenario prompt, then wait for both the mock RPC request
   and the deterministic `GROKBUILD_QA_OK` UI result.

The run records raw and canonical AX trees, the complete mock RPC transcript,
the QA preference domain, final window metadata, a window screenshot, and app
stdout/stderr. Generated IDs, timestamps, and isolated roots are normalized in
canonical JSON; event order and product-authored text are preserved.

## Permissions and commands

First fetch and verify the pinned source, then run the permission probe:

```sh
npm run reference:fetch
npm run reference:verify
npm run qa:swift-blackbox:preflight
```

macOS must grant the process hosting the command both Accessibility and Screen
Recording access in System Settings → Privacy & Security. A successful
preflight only writes `status: "preflight-passed"`; it is not scenario evidence.
If either capability is unavailable, the command exits `77`, writes a
`status: "blocked"` manifest with the exact reason and remediation, and never
reports a green run. For example, System Events error `-25211` is classified as
`accessibility-denied`.

Run the black-box scenario after the preflight passes:

```sh
npm run qa:swift-blackbox
```

Optional arguments are forwarded after `--`:

```sh
npm run qa:swift-blackbox -- --output /absolute/empty/output --timeout-seconds 90
npm run qa:swift-blackbox -- --scenario /absolute/path/to/scenario.json
```

The stable QA bundle ID lets macOS associate TCC authorization with this test
app, but the driver re-signs the copied bundle ad hoc. If macOS invalidates a
previous permission after the pinned binary changes, grant it again and rerun
the preflight.

Exit codes are `0` for the requested operation passing, `1` for a driver or
scenario failure, and `77` for a permission/platform block.

## Artifacts

By default each run creates
`test-results/swift-blackbox/<UTC timestamp>/`:

```text
manifest.json                 top-level status; never green when blocked
preflight.json                Accessibility and Screen Recording results
app/                          copied, independently identified Swift QA bundle
profile/home/                 isolated HOME used by the app and fake CLI
workspace/                    isolated project selected through the UI
logs/                         app stdout and stderr
raw/                          AX, NDJSON RPC, plist/JSON prefs, window PNG/data
canonical/                    normalized AX/RPC/prefs/window evidence + manifest
```

Artifact directories must be absent or empty. The driver refuses to overwrite
a non-empty directory.

