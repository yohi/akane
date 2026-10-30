# OpenCode V2 Verification Record

## Target

- OpenCode: `2.1.4`
- `@opencode/plugin`: `2.1.4`
- Bun implementation/test image: `1.4.4`
- Branch: `feat/opencode-v2-migration`
- Sibyl revision: not supplied; consumer integration is `NOT_RUN`.

## Results

- TypeScript: **PASS** — `bun run typecheck` in Bun 1.4.4 image.
- Unit/integration/stress: **PASS** — `bun test`: 300 passed, one gated skip.
- Build: **PASS** — server and both Claude artifacts emitted by `bun run build`.
- Package/root import: **PASS** — dry-run package and built V2 root checked.
- OpenCode version: **PASS** — installed CLI reports `opencode v2.1.4`.
- Server/API: **PASS** — isolated loopback server and client `server.info`.
- Config parsing: **PASS** — isolated config query returned the local entry/options.
- Host plugin activation: **PASS** — isolated V2 config produced shared state.
- Active-model interrupt/recovery: **PASS** — a loopback-only stalled model
  fixture observed prompt admission, accepted interruption, and a second model
  request on the same session.
- Sibyl integration: **NOT_RUN** — consumer package/revision/verifier unavailable.

The host test is gated behind `AKANE_V2_HOST_TEST=1`. It starts the installed
OpenCode CLI with a temporary project configuration/workspace and a loopback-only
stalled model fixture. No repository or user OpenCode configuration is used;
temporary host data is isolated under a temporary directory.

## Interpretation

Unit behavior, package loading, local configuration, and active-model recovery
are verified against OpenCode `2.1.4`. Sibyl consumer integration remains
unverified until a tested package revision and verifier are available.
