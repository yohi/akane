# AGENTS.md — Developer & AI Agent Guide for `akane`

`akane` is a lightweight, zero-crash watchdog plugin for OpenCode sessions that monitors agent activity, colors Tmux/OS indicators, and injects recovery pings via interrupts.

---

## 1. Project Map & Purpose (WHY, WHAT, & WHERE)
- **Goal**: Minimize false recovery pings during user-waiting states (`PAUSED`) and active tool executions, steer recovery pings via interrupts, and prevent disk bloat by summarizing high-frequency stream events.
- **Architecture**: Implements a 5-state state machine (`WATCHING` ➔ `STAGE1_NOTIFIED` ➔ `PINGED` ➔ `SILENCED`, plus `PAUSED` for input requests).
- **Authoritative Docs**: For detailed state transitions, edge cases, invariants, and SDK signatures, refer to [SPEC.md](SPEC.md) and [README.md](README.md) via progressive disclosure.

---

## 2. Tech Stack & Verification (HOW)
Built on **Bun 1.3+** and **TypeScript** (strict mode). All executions and tests must run inside the devcontainer environment.

- **Build**: `bun run build` (bundles TypeScript source into `./dist/index.js` using Bun's bundler)
- **Type Check**: `bun run typecheck` (`tsc --noEmit` validation)
- **Test**: `bun test` (runs all unit, integration, and stress tests. Expecting **188 tests to pass** under 1500ms)
- **Local Install**: `mkdir -p ~/.config/opencode/plugins/akane && cp -r package.json dist ~/.config/opencode/plugins/akane/`

---

## 3. High-Leverage Constraints & Safety Rules (CRITICAL)

When modifying code, you MUST respect these strict architectural safety guidelines:

### 3.1 Duplication Protection
OpenCode may initialize plugins multiple times. Track active directories using the global `ACTIVE_INSTANCES` (`Set<string>`) at the file level. If already initialized, return a no-op hook `{ event: async () => {}, dispose: async () => {} }` and remove it upon disposal.

### 3.2 Arm Lock & Manual Bypass
After injecting a ping, enforce an arm lock duration (`Math.max(stage2Ms * 2, 30000)`) to ignore late stale assistant events. However, any manual user message (`isUserMessage` or non-empty typing with no agent name) must bypass the lock immediately to trigger recovery and return the session to the `WATCHING` state.

### 3.3 Late Event Tombstoning
To prevent delayed streaming chunks from re-arming stopped sessions (idle/error/deleted), store ended session IDs in a bounded FIFO Set (`stoppedSessions` with a limit of 10,000). Discard any activity matching these tombstones.

### 3.4 Zero-Crash & Secure Logging
- **Containment**: Wrap all external command calls (`Bun.spawn` for tmux/notify-send/osascript) in try/catch to avoid crashing OpenCode.
- **Log Scrubbing**: Never log raw commands, user inputs, or notification messages. If a spawn fails, only log the binary name and exit code to prevent leakage of user data.
- **No Concatenated Scripts**: Always pass arguments as an array (`cmd[]`) to prevent shell injection.

---

## 4. Tip for Claude Code Compatibility
This project supports `CLAUDE.md` via a symbolic link. Ensure `CLAUDE.md` links to `AGENTS.md`:
```bash
ln -sf AGENTS.md CLAUDE.md
```
