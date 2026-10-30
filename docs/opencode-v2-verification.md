# OpenCode V2 Verification Record

## Target

- OpenCode: `2.1.4`
- `@opencode/plugin`: `2.1.4`
- Package: `@yohi/akane@3.0.0-alpha.1`
- GitHub Release:
  [v3.0.0-alpha.1](https://github.com/yohi/akane/releases/tag/v3.0.0-alpha.1)
- Source commit: `449ae7b42cf060b33bd19a1b746aa4d677c7eb81`
- GitHub asset SHA-256: `b66d56e340dd84cb1cdf555e73980e2efaeed916b445247cef36013f2d48e46d`
- npm integrity: `sha512-F74VYM33/D/ZCgggwwJcCYlKXVma3uH/W7Do1ydzwUN/d4JBDFDhuiYmvqkNFQJczJPm9QkpErq9etCtk4x/uQ==`
- GPR dist-tags: `alpha=3.0.0-alpha.1`, `latest=2.0.0`
- Bun implementation/test image: `1.4.4`
- Branch: `feat/opencode-v2-migration`
- Sibyl package: `@yohi/sibyl@3.0.0-alpha.1`
- Sibyl source revision: `2c81d141e9fed59e54ce950ea26fb53190cb9308`

## Results

- TypeScript: **PASS** — `bun run typecheck` in Bun 1.4.4 image.
- Unit/integration/stress: **PASS** — `bun test`: 300 passed, two gated skips.
- Build: **PASS** — server and both Claude artifacts emitted by `bun run build`.
- Package/root import: **PASS** — dry-run package and built V2 root checked.
- OpenCode version: **PASS** — installed CLI reports `opencode v2.1.4`.
- Server/API: **PASS** — isolated loopback server and client `server.info`.
- Config parsing: **PASS** — isolated config query returned the local entry/options.
- Host plugin activation: **PASS** — isolated V2 config produced shared state.
- Active-model interrupt/recovery: **PASS** — a loopback-only stalled model
  fixture observed prompt admission, accepted interruption, and a second model
  request on the same session.
- Sibyl state contract: **PASS** — tagged consumer parser accepts Akane's real
  writer output for all six states, four counters, heartbeat freshness,
  disabled shutdown, and restart-to-`IDLE`; verifier 1/1 with 12 assertions.
- Sibyl's own `tests/akane-state.test.ts`: **PASS** — 5 tests, 14 assertions.
- Combined host UI/runtime: **NOT_RUN** — the published Sibyl TUI has not yet
  been run alongside the published Akane alpha in one real host.

The host test is gated behind `AKANE_V2_HOST_TEST=1`. It starts the installed
OpenCode CLI with a temporary project configuration/workspace and a loopback-only
stalled model fixture. No repository or user OpenCode configuration is used;
temporary host data is isolated under a temporary directory.

Run the consumer contract check with the Sibyl tag checkout and exact revision:

```sh
AKANE_SIBYL_ROOT=/path/to/sibyl-v3.0.0-alpha.1 \
AKANE_SIBYL_REVISION=2c81d141e9fed59e54ce950ea26fb53190cb9308 \
bun test tests/integration/opencode-v2-sibyl.test.ts
```

## Interpretation

Unit behavior, package loading, local configuration, and active-model recovery
are verified against OpenCode `2.1.4`. The Sibyl parser contract is verified at
the revision above; combined-host visual/runtime acceptance remains outstanding.
