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
