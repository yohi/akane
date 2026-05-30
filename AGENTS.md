# AGENTS.md — Agent Developer Guide for `akane`

Welcome, AI Engineer. This document serves as your guide to understanding the project context, build commands, test instructions, design constraints, and known gotchas of `akane`.

---

## 1. Project Overview

`akane` is a hang detector plugin for [OpenCode](https://github.com/anomalyco/opencode) sessions. It implements a 3-stage escalation pipeline using the `@opencode-ai/plugin` API:
1. **Stage 1 (warn)**: Notifies Tmux with a yellow highlight when the agent response stream halts.
2. **Stage 2 (critical)**: Automatically injects a ping message to attempt self-recovery and highlights Tmux in red.
3. **Stage 3 (silenced)**: Halts automatic pinging when `maxPings` threshold is hit, requiring manual human intervention (red highlight remains).

---

## 2. Tech Stack & Environment

- **Runtime**: Bun 1.3+
- **Language**: TypeScript (strict mode)
- **Framework**: `@opencode-ai/plugin` SDK
- **Testing**: `bun test` (native runner)
- **Devcontainer**: Debian 12 + tmux (for integration tests and command verification)

---

## 3. Core Development Commands

Always run build, check, and test commands **inside the devcontainer** for environment consistency. Git operations should be performed on the host.

### Build the project
```bash
bun run build
```
*Compiles `./src/index.ts` to `./dist/index.js` using Bun's bundler.*

### Run type check
```bash
bun run typecheck
```
*Runs `tsc --noEmit` to verify type integrity.*

### Run all tests
```bash
bun test
```
*Runs all units and stress tests. Expecting ~79 tests to pass under 600ms.*

### Local plugin deployment (manual check)
```bash
mkdir -p ~/.config/opencode/plugins/opencode-watchdog
cp -r package.json dist ~/.config/opencode/plugins/opencode-watchdog/
```

---

## 4. Codebase Structure

- [src/index.ts](file:///home/y_ohi/program/akane/src/index.ts): Plugin entry point. Dispatches incoming events to `Watchdog` and handles duplicate loading protection.
- [src/watchdog.ts](file:///home/y_ohi/program/akane/src/watchdog.ts): Core Watchdog engine. Manages state machine (`WATCHING` ➔ `STAGE1_NOTIFIED` ➔ `PINGED` ➔ `SILENCED`) and session timers.
- [src/notifier.ts](file:///home/y_ohi/program/akane/src/notifier.ts): Handles Tmux status line colorization (`bg=yellow`, `bg=red`, `default`) and display notifications.
- [src/pinger.ts](file:///home/y_ohi/program/akane/src/pinger.ts): Adapter for `client.session.prompt` to inject the ping message into the active session.
- [src/clock.ts](file:///home/y_ohi/program/akane/src/clock.ts): DI Clock wrapper (`RealClock` and `FakeClock`) enabling fast time-advance testing.
- [src/config.ts](file:///home/y_ohi/program/akane/src/config.ts): Merges config priorities: env > project config (jsonc) > defaults.

---

## 5. Key Architectural Rules & Constraints

### 5.1 Duplication Protection
OpenCode has a known behavior of initializing the plugin multiple times within a single process.
* **The Rule**: A global `ACTIVE_INSTANCES` (`Set<string>`) tracks active directory paths (`input.directory`).
* **Implementation**: If a path is already registered, the initialization must return a no-op hook:
  ```typescript
  return { event: async () => {}, dispose: async () => {} };
  ```
  And must delete the entry from the Set in the `dispose` hook.

### 5.2 Arm Lock & Manual Recovery Bypass
* **Arm Lock**: After injecting a ping, an arm lock (`lockDuration = Math.max(stage2Ms * 2, 30000)`) is enabled to suppress delayed assistant replies or transient API errors from resetting the state.
* **The Bypass Rule**: Fresh human intervention must bypass this lock immediately.
* **Event Classification**:
  * `message.updated` (role: user) and user-originated `message.part.updated` (where `agentName === undefined` and `text` is non-empty) are classified as manual user messages.
  * These events **bypass** the arm lock checks in `src/index.ts` and call `watchdog.onUserMessage(...)` immediately to restore the session from `SILENCED` or `PINGED` to the `WATCHING` state.

### 5.3 Zero-Crash Fallback
* Watchdog errors must **never** crash the host OpenCode process.
* Wrap all external process calls (`Bun.spawn` for Tmux) and async boundaries in try/catch blocks. Swallow rejections and log them locally.

### 5.4 Injection Prevention
* When calling `tmux`, never pass arguments as a concatenated string shell script. Always pass arguments as an array (`[this.tmuxPath, "display-message", message]`) to avoid shell command injections.

---

## 6. Gotchas & Anti-Patterns

### ⚠️ Performance Flooding in Tests
- **Gotcha**: The core `Watchdog` defaults to log via `console.info`. If a stress test (e.g., 1000 sessions) executes, it will output hundreds of thousands of lines, causing the test runner to hang or run extremely slow.
- **Remedy**: Always pass an empty logger (`log: () => {}`) when instantiating `Watchdog` in unit or stress tests.

### ⚠️ Late Event Rearming after Session Stop
- **Gotcha**: When a session ends via `session.idle` or `session.error`, calling `clearTimeout` and deleting the session entry from the Map is not enough. Delayed assistant stream packets arriving after stop will cause `onActivity` to re-create a phantom session.
- **Remedy**: Sessions are tombstoned into a FIFO Set (`stoppedSessions` with a limit of 10,000) upon calling `stop()`. Any `onActivity` matching a tombstoned session is immediately discarded. The tombstone is only cleared on `onUserMessage` (new user prompt).
