# AGENTS.md — Developer & AI Agent Guide for `akane`

`akane` is a lightweight, zero-crash hang detector plugin for OpenCode sessions that monitors agent activity, alerts users via Tmux/OS notifications, and injects recovery pings.

---

## 1. Project Map & Purpose (WHY & WHAT)
- **Goal**: Detect agent silence, color Tmux/OS indicators, and issue a ping prompt to recover.
- **Scope**: Implements a 3-stage state machine (`WATCHING` ➔ `STAGE1_NOTIFIED` ➔ `PINGED` ➔ `SILENCED`).
- **Full Specs**: Refer to the authoritative design specs in [SPEC.md](file:///home/y_ohi/program/private/akane/SPEC.md) and [README.md](file:///home/y_ohi/program/private/akane/README.md).

---

## 2. Tech Stack & Verification (HOW)
This project is built on **Bun 1.3+** and **TypeScript** (strict mode, no `any`). All execution and tests must run inside the devcontainer environment.

- **Build**: `bun run build` (creates `./dist/index.js` using Bun's bundler)
- **Type Check**: `bun run typecheck` (`tsc --noEmit` validation)
- **Test**: `bun test` (runs all unit and stress tests. Expecting **130 tests to pass** under 1500ms)
- **Local Install**: `mkdir -p ~/.config/opencode/plugins/akane && cp -r package.json dist ~/.config/opencode/plugins/akane/`

---

## 3. High-Leverage Rules & Constraints (CRITICAL)

When modifying code, you MUST respect these strict architectural safety guidelines:

### 3.1 Duplication Protection
OpenCode may initialize plugins multiple times. Track active directories using the global `ACTIVE_INSTANCES` (`Set<string>`) at the file level. If already initialized, return a no-op hook `{ event: async () => {}, dispose: async () => {} }` and remove it upon disposal.

### 3.2 Arm Lock & Manual Bypass
After injecting a ping, enforce an arm lock duration (`Math.max(stage2Ms * 2, 30000)`) to ignore late stale assistant events. However, any manual user message (`isUserMessage` or non-empty typing with no agent name) must bypass the lock immediately to trigger recovery and return the session to the `WATCHING` state.

### 3.3 Late Event Tombstoning
To prevent delayed streaming chunks from re-arming stopped sessions (idle/error/deleted), store ended session IDs in a bounded FIFO Set (`stoppedSessions` with a limit of 10,000). Discard any activity matching these tombstones.

### 3.4 Zero-Crash & Secure Logging
- **Containment**: Wrap all external command calls (`Bun.spawn` for tmux/notify-send/osascript) in try/catch to avoid crashing OpenCode.
- **Log Scrubbing**: Never log raw commands or session inputs. If a spawn fails, only log the binary name and exit code to prevent leakage of user data.
- **No Concatenated Scripts**: Always pass arguments as an array (`cmd[]`) to prevent shell injection.

---

## 4. Tip for Claude Code Compatibility
This project supports `CLAUDE.md` via a symbolic link. Ensure `CLAUDE.md` links to `AGENTS.md`:
```bash
ln -sf AGENTS.md CLAUDE.md
```
