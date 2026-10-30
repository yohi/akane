# AGENTS.md — Developer & AI Agent Guide for `akane`

`akane` on this migration branch is an OpenCode **2.1.4 V2-only** watchdog plugin. The `master` branch remains the V1 implementation. This branch exports `Plugin.define({ id, setup })`; it has no V1 server-hook or configuration compatibility layer.

---

## 1. Project Map & Purpose (WHY, WHAT, & WHERE)
- **Goal**: Minimize false recovery pings during user-waiting states (`PAUSED`) and active tool executions, steer recovery pings via interrupts, and prevent disk bloat by summarizing high-frequency stream events. The TUI is maintained in `yohi/sibyl` and reads the versioned state file.
- **Architecture**: A typed V2 adapter maps V2 event discriminants and session ownership into the host-independent state machine (`WATCHING` ➔ `STAGE1_NOTIFIED` ➔ `PINGED` ➔ `SILENCED`, plus `PAUSED` for input requests).
- **Authoritative Docs**: For detailed state transitions, edge cases, invariants, and SDK signatures, refer to [SPEC.md](SPEC.md) and [README.md](README.md) via progressive disclosure.

---

## 2. Tech Stack & Verification (HOW)
Built on **Bun 1.4.4** and **TypeScript 6** (strict mode). All executions and tests must run inside the devcontainer environment.

- **Build**: `bun run build` (bundles TypeScript source into `./dist/index.js` using Bun's bundler)
- **Type Check**: `bun run typecheck` (`tsc --noEmit` validation)
- **Test**: `bun test` (runs unit, integration-gated, and stress tests; use actual output for test counts)
- **Local Install**: `mkdir -p ~/.config/opencode/plugins/akane && cp -r package.json dist ~/.config/opencode/plugins/akane/`

---

## 3. High-Leverage Constraints & Safety Rules (CRITICAL)

When modifying code, you MUST respect these strict architectural safety guidelines:

### 3.1 Duplication Protection
OpenCode may initialize plugins multiple times. Track active project directories with the module-level `ACTIVE_INSTANCES` set. A duplicate setup owns no resources and returns a no-op cleanup. Remove the directory guard only after the owning runtime has stopped and released its resources.

### 3.2 Arm Lock & Manual Bypass
After injecting a ping, enforce an arm lock duration (`Math.max(stage2Ms * 2, 30000)`) to ignore late stale assistant events. Manual user input is recognized from V2 `session.inbox.enqueued` user items and bypasses the lock. Exclude self-injected input by its registered inbox/message ID, never by matching prompt text.

### 3.3 Late Event Tombstoning
To prevent delayed streaming chunks from re-arming stopped sessions (execution completion/interruption, errors, deletion, or move), store ended session IDs in the bounded FIFO Set (`stoppedSessions`, limit 10,000). Discard activity matching these tombstones until genuine user input starts a new execution.

### 3.4 Zero-Crash & Secure Logging
- **Containment**: Wrap all external command calls (`Bun.spawn` for tmux/notify-send/osascript) in try/catch to avoid crashing OpenCode.
- **Log Scrubbing**: Never log raw commands, user inputs, or notification messages. If a spawn fails, only log the binary name and exit code to prevent leakage of user data.
- **No Concatenated Scripts**: Always pass arguments as an array (`cmd[]`) to prevent shell injection.

### 3.5 Atomic State Persistence
All shared state file writes must be written first to a temporary file (`.tmp` extension) in the same directory, then replaced via `fs.renameSync` to prevent corrupted states or partial reads during process crashes.

### 3.6 Strict Color Validation
Hex color code validation for agent status must follow a strict CSS-compliant regular expression: `/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/`. Any other color codes or invalid strings must be rejected to prevent injection vulnerabilities.

### 3.7 Pinger Masking & Debug Controls
- **Pinger Masking**: In all injection logs and warnings, `sessionId` must be redacted/masked (leaving only the first 4 characters). Errors must be truncated to 30 characters to protect user data and secrets.
- **Debug Logs**: Heavy log writing (such as `watchdog-debug.log`) must only be active if the environment variable `AKANE_DEBUG` is set to `"true"`, preventing storage exhaustion under high-frequency stream events.

---

## 4. Tip for Claude Code Compatibility
This project supports `CLAUDE.md` via a symbolic link. Ensure `CLAUDE.md` links to `AGENTS.md`:
```bash
ln -sf AGENTS.md CLAUDE.md
```

## 5. OpenCode V2 Alpha Status and TODO

This branch has released `@yohi/akane@3.0.0-alpha.1` for OpenCode `2.1.4`:
[GitHub prerelease](https://github.com/yohi/akane/releases/tag/v3.0.0-alpha.1).
It is an experimental V2-only prerelease; do not describe it as stable or as
fully sibyl-compatible. The V1 implementation remains on `master`.

Outstanding release gates:

- [ ] Verify the consumer in `yohi/sibyl` against the V1 shared-state schema,
  including all states, counters, heartbeat, and shutdown behavior. Record the
  exact consumer package/revision and verifier result.

The current evidence and gate classifications are maintained in
[`docs/opencode-v2-verification.md`](docs/opencode-v2-verification.md). Unit
tests do not close the sibyl consumer gate.
Prerelease publication must use the `alpha` package dist-tag and must not move
`latest`.
