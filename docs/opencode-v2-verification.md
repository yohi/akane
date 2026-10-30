# OpenCode V2 Verification Record

## Target

- OpenCode: `2.1.4`
- `@opencode/plugin`: `2.1.4`
- Package: `@yohi/akane@3.0.0-alpha.2`
- GitHub Release:
  [v3.0.0-alpha.2](https://github.com/yohi/akane/releases/tag/v3.0.0-alpha.2)
- Source commit: release tag `v3.0.0-alpha.2`
- GitHub asset SHA-256: `3ced661908d1e8bfe0aa8684d69169aac6d312fd67195ed5500a30b74e678ec4`
- npm integrity: `sha512-MTeGXBBlZHx9ljo09Q+61qlvXmuVi03o88gyRXwdbgnEpRLAeB9YBVMdp8qVlzC60Cw52lBAhhciu2YqaYu/4Q==`
- GPR dist-tags: `alpha=3.0.0-alpha.2`, `latest=2.0.0`
- Bun implementation/test image: `1.4.4`
- Branch: `feat/opencode-v2-migration`
- Sibyl package: `@yohi/sibyl@3.0.0-alpha.1`
- Sibyl source revision: `2c81d141e9fed59e54ce950ea26fb53190cb9308`

## Results

- TypeScript: **PASS** — `bun run typecheck` in Bun 1.4.4 image.
- Unit/integration/stress: **PASS** — `bun test`: 301 passed, two gated skips.
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
- Combined host UI/runtime: **PASS** — an isolated OpenCode `2.1.4` host loaded
  published `@yohi/akane@3.0.0-alpha.1` and `@yohi/sibyl@3.0.0-alpha.1`.
  Both selected parent sessions showed Akane `WATCHING` and one `BUSY` direct
  child; the displayed child category changed from `visual` to `review` when
  switching parents. The session picker showed both parent titles and a selected
  row. Three real xterm.js screenshots were 960x800 RGB PNGs; their matching
  terminal captures were 42x120 and each passed `tui-check` with no overflow,
  border misalignment, or wide-character column drift. Two independent visual
  QA reviews returned **PASS** with high confidence.
- Alpha.2 package: **REPACKAGED** — the package version and release metadata are
  updated; server/TUI runtime code is unchanged from alpha.1. The combined-host
  acceptance above was performed against the alpha.1 artifacts.
- Runtime evidence: both parents had their own direct child, the child records
  were distinct, and their categories were `visual` and `review`. The retained
  runtime assertion does not include literal child session IDs, so this gate
  records the ownership/distinctness assertions rather than an ID-string audit.

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

Unit behavior, package loading, local configuration, active-model recovery, and
the documented combined-host visual/runtime scenarios are verified against
OpenCode `2.1.4` and the Sibyl revision above. The combined-host gate confirms
only the tested scenarios; it does not establish general or complete Sibyl
compatibility for this experimental prerelease. Visual evidence was captured in
the isolated QA workspace and was not committed to the repository.
