# vendor/

## grok-build (not committed)

`vendor/grok-build/` holds a checkout of xAI's official open-source agent,
used to build the ACP backend from source so the app no longer depends on
the distributed `grok` binary. It is gitignored to keep this repository
small; recreate it with:

```
git clone https://github.com/xai-org/grok-build.git vendor/grok-build
```

- Upstream: https://github.com/xai-org/grok-build (Apache-2.0)
- Pinned source rev: see `vendor/grok-build/SOURCE_REV` (2026-08-25 checkout: 437c7c928f3fcd13e9d37a51d887f41d7f84185d)
- Build: `PATH="$PWD/bin:$PATH" cargo build -p xai-grok-pager-bin --release`
  (needs rustup with the toolchain pinned in `rust-toolchain.toml`, plus
  `dotslash` for the vendored `bin/protoc`)
- Artifact: `target/release/xai-grok-pager` — a full Grok Build binary
  including the `agent stdio` ACP mode this app drives. Point the app's
  Grok CLI path at it; the only runtime credential it needs is
  `~/.grok/auth.json`.

### Local patches (`patches/`)

Applied on top of the pinned rev before building; re-apply after a fresh
clone with `git -C vendor/grok-build apply ../patches/*.patch`.

- `0001-tool-discipline-prompt.patch` — adds a hard anti-fake-narration
  rule to the system prompt's `<tool_calling>` section (a text-only turn
  must never claim or role-play tool work). Templates are XOR-obfuscated
  into `prompt_encrypted.rs`; after editing `templates/prompt.md`, rerun
  `python3 scripts/encrypt_templates.py` from
  `crates/codegen/xai-grok-agent/` — the patch includes the regenerated
  bytes, so applying it needs no extra step.
