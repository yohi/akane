# akane Watchdog Injection Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the akane Watchdog deliver recovery pings via interrupt (`delivery:"steer"`), pause during permission/question waits, avoid falsely interrupting running tools, and stop bloating the log — all without regressing the existing chunk-timer core.

**Architecture:** Additive signal-tracking layer (design 案A). The proven chunk-timer `Watchdog` core is preserved; new event consumers (`PAUSED` state, `pendingRequests`/`runningTools`, steer delivery, `"waiting"` notification, verbosity-aware logging) are added on top. All new behavior is config-gated and degrades gracefully on runtimes that do not emit the new events (Zero-Crash, SPEC §6).

**Tech Stack:** Bun 1.2.19+/TypeScript (strict, no `any`), `@opencode-ai/plugin@1.15.12`, `bun:test` with `FakeClock` + DI mocks. CI = GitHub Actions (`ubuntu-slim`); dev/test = Devcontainer (Debian 12 + tmux + Bun).

**Source design:** [docs/superpowers/specs/2026-06-16-watchdog-injection-gating-design.md](../specs/2026-06-16-watchdog-injection-gating-design.md)

---

## Git Branch Operation Flow (MANDATORY — AI-Native Stacked PR Workflow v1.0.1)

This plan is executed under the **AI-Native Stacked PR Workflow**. Authoritative protocol:
**https://different-sunday-448.notion.site/AI-Native-Stacked-PR-Workflow-3611669a4c16802eb032eb4ab05a8adb**

### Naming (STRICT — `feat/`/`fix/` are FORBIDDEN)

- **Phase base branch:** `feature/phase[N]-[機能名]__base` (branched from `master`)
- **Task branch:** `feature/phase[N]-task[M]-[サブ機能名]`

### Branch-derivation rule (派生元の判断ルール)

For every Task, decide its parent by whether it is self-contained:

| Condition | Parent (派生元) | Branch from |
|---|---|---|
| Task is **self-contained** (単体で完結する: compiles, tests pass, and does NOT call code introduced by a sibling task) | **Base** | the Phase `__base` |
| Task **depends on the previous task's code** (前タスクの新規コードを呼ぶ) | **直前Task** | the previous task branch (stack) |

### Incremental rules

1. Each task's diff against **its parent branch** (Base or previous task) MUST be **≤ 200 LOC** (incremental, not cumulative vs base). Tests count toward LOC.
2. Unit tests MUST be **100% PASS** before opening the PR.
3. Every Task PR targets the Phase `__base` and is opened as **Draft**.
4. When a preceding task merges into `__base`, immediately `git rebase` `__base` onto all subsequent task branches (cascading propagation).

### Forbidden actions

- Generic naming (`feat/`, `fix/`).
- Opening a PR whose incremental diff vs parent exceeds 200 LOC.
- Direct `push` to any `__base` branch.
- Merging anything to `master` (human-only).

### Phase ordering

Phases merge **sequentially**: Phase 1 → 2 → 3 → 4 → 5. Each Phase `__base` is created from `master` **after the previous phase merges** (so later phases inherit earlier config knobs / methods). Phase 2 and Phase 3 are mutually independent (both need only Phase 1) and MAY proceed in parallel if desired; Phase 4 needs Phase 3 (and conceptually Phase 2); Phase 5 needs Phase 4.

### Per-task completion report (use this exact format)

> **AI**: Phase [N] のタスクを以下の通り実行しました。
> **作成ブランチ**: `feature/phase[N]-task[M]-[名称]` / **派生元**: `[Parent Branch]`
> **増分差分**: [XXX] LOC (派生元との比較) / **ステータス**: テスト [PASS] / リベース [完了]
> **次のアクション**: `task[M+1]` の実装に移行します。

---

## Devcontainer Execution Convention (MANDATORY)

**All test / typecheck / build commands run INSIDE the devcontainer. Never on the host.**

```bash
# Once per session, from the host, in the repo root:
devcontainer up --workspace-folder .

# Every test/typecheck/build command in this plan is run as:
devcontainer exec --workspace-folder . <command>
# e.g.
devcontainer exec --workspace-folder . bun test tests/config.test.ts
devcontainer exec --workspace-folder . bun run typecheck
```

If the `@devcontainers/cli` is unavailable, open the project in VS Code, "Reopen in Container", and run the same `bun ...` commands in the container's integrated terminal.

**Git operations (`branch`, `commit`, `push`, `gh pr`, `rebase`, `worktree`) run ON THE HOST, never inside the devcontainer** (per AGENTS.md — git inside the container has permission issues). In each task, "Commit" / "Push + Draft PR" steps are host-side; "Run tests" / "Run typecheck" steps are devcontainer-side.

---

## File Structure

Files touched by this plan and their responsibilities:

- `src/config.ts` — config schema + resolution. **Adds 5 knobs** (`delivery`, `suppressPingWhileToolRunning`, `pauseOnInputRequest`, `notifyWaiting`, `verboseLog`).
- `src/index.ts` — plugin entry + event-routing (signal layer). **Adds** verbosity-aware `logEvent`, `message.part.delta` activity, `permission.*`/`question.*` routing + `extractRequestId`, tool-part routing, `session.status` retry routing.
- `src/pinger.ts` — injection adapter. **Adds** V2 `delivery` form with per-call legacy fallback (isolated in `OpenCodeAdapter`).
- `src/notifier.ts` — tmux/OS notifications. **Adds** `"waiting"` stage (`bg=cyan` / urgency `low`).
- `src/watchdog.ts` — state machine. **Adds** `PAUSED` state, `pendingRequests`/`runningTools` sets, `onInputRequested`/`onInputResolved`/`onToolRunning`/`onToolSettled`, steer-suppression gate in `onStage2Expire`, retry suppression.
- `src/telemetry.ts` — counters (optional Phase 5).
- Tests mirror each source file under `tests/`.

---

## Phase 0: Pre-flight Verification & Clean Baseline

**Conclusion of infra audit: CI/CD and Devcontainer ALREADY EXIST and satisfy all stated requirements — no construction task is needed.**

- CI: [.github/workflows/test.yml](../../../.github/workflows/test.yml) already triggers on `master` (push + PR) and uses `runs-on: ubuntu-slim`, running `bun run typecheck` + `bun test`. ✅ Meets "master trigger + ubuntu-slim".
- Devcontainer: [.devcontainer/devcontainer.json](../../../.devcontainer/devcontainer.json) + `Dockerfile` (Debian 12 + tmux + Bun 1.2.19) + `postCreate.sh` already exist. ✅ Meets "devcontainer.json + Dockerfile".

Phase 0 therefore only verifies the environment and establishes a green baseline. It produces **no source change**, so there is **no Draft PR for Phase 0** (the per-task Draft PR rule applies to implementation tasks; a verification phase with no diff has nothing to PR).

- [ ] **Step 1: Create an isolated worktree (host)** — use the `superpowers:using-git-worktrees` skill.

```bash
# Host. Detect existing isolation first (Step 0 of the skill); if not isolated:
git worktree add .worktrees/watchdog-gating -b feature/scratch-baseline
cd .worktrees/watchdog-gating
git check-ignore -q .worktrees   # MUST be ignored; if not, add to .gitignore + commit
```

- [ ] **Step 2: Confirm CI meets requirements (host, read-only)**

Open [.github/workflows/test.yml](../../../.github/workflows/test.yml) and confirm:
- `on.push.branches` and `on.pull_request.branches` include `master`.
- `jobs.bun-test.runs-on` is `ubuntu-slim`.
- Steps include `bun run typecheck` and `bun test`.
Expected: all present → no change. (If any were missing, you would add a `Phase 0` fix task that edits `test.yml` and opens a Draft PR; they are present, so skip.)

- [ ] **Step 3: Bring up the devcontainer**

```bash
devcontainer up --workspace-folder .
```
Expected: container builds, `postCreate.sh` prints Bun + tmux versions and installs deps.

- [ ] **Step 4: Establish green baseline (devcontainer)**

```bash
devcontainer exec --workspace-folder . bun install --frozen-lockfile
devcontainer exec --workspace-folder . bun run typecheck
devcontainer exec --workspace-folder . bun test
```
Expected: typecheck clean; **all 130 tests pass** in < 1500ms.

- [ ] **Step 5: Record the baseline** — note the passing test count. If tests fail here, STOP and report (do not proceed with feature work on a red baseline).

---

## Phase 1: Foundation — Config Knobs, Log Reduction (#3), Delta Signal

**Phase base:** `feature/phase1-config-log-signal__base` (from `master`).
**Mergeable independently:** adds dormant config knobs + reduces log volume (#3) + routes stream deltas as activity. No steer/gating behavior yet.

### Task 1.1: Config knobs

**派生元: Base** (self-contained — touches only `config.ts` and config literals/tests).
**Branch:** `feature/phase1-task1-config-knobs`

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/watchdog.test.ts:57-66` (baseConfig literal — add new required fields)
- Modify: `tests/stress.test.ts:13-22` (cfg literal — add new required fields)

- [ ] **Step 1: Write failing tests** — append to `tests/config.test.ts` inside the existing `describe("resolveConfig", ...)`:

```ts
  test("new knobs default correctly", () => {
    const cfg = resolveConfig({});
    expect(cfg.delivery).toBe("steer");
    expect(cfg.suppressPingWhileToolRunning).toBe(true);
    expect(cfg.pauseOnInputRequest).toBe(true);
    expect(cfg.notifyWaiting).toBe(true);
    expect(cfg.verboseLog).toBe(false);
  });

  test("env overrides delivery and boolean knobs", () => {
    const cfg = resolveConfig({
      env: {
        OPENCODE_WATCHDOG_DELIVERY: "queue",
        OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL: "false",
        OPENCODE_WATCHDOG_PAUSE_ON_INPUT: "no",
        OPENCODE_WATCHDOG_NOTIFY_WAITING: "0",
        OPENCODE_WATCHDOG_VERBOSE: "true",
      },
    });
    expect(cfg.delivery).toBe("queue");
    expect(cfg.suppressPingWhileToolRunning).toBe(false);
    expect(cfg.pauseOnInputRequest).toBe(false);
    expect(cfg.notifyWaiting).toBe(false);
    expect(cfg.verboseLog).toBe(true);
  });

  test("project config sets delivery; env overrides project", () => {
    expect(resolveConfig({ project: { delivery: "queue" } }).delivery).toBe("queue");
    expect(
      resolveConfig({ project: { delivery: "queue" }, env: { OPENCODE_WATCHDOG_DELIVERY: "steer" } }).delivery,
    ).toBe("steer");
  });

  test("invalid delivery falls back to default with warn", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig({ env: { OPENCODE_WATCHDOG_DELIVERY: "yeet" } }, (m) => warnings.push(m));
    expect(cfg.delivery).toBe("steer");
    expect(warnings[0]).toContain("OPENCODE_WATCHDOG_DELIVERY");
    expect(warnings[0]).toContain("lower-priority source");
  });
```

- [ ] **Step 2: Run tests to verify they fail** (devcontainer)

Run: `devcontainer exec --workspace-folder . bun test tests/config.test.ts`
Expected: FAIL — `cfg.delivery` undefined / type errors on `WatchdogConfig`.

- [ ] **Step 3: Add the knobs to `src/config.ts`**

Add the exported type and extend the interface (insert after the `notifierType: NotifierType;` line, then the booleans after it):

```ts
export type DeliveryMode = "steer" | "queue";
```

```ts
export interface WatchdogConfig {
  enabled: boolean;
  stage1Ms: number;
  stage2Ms: number;
  maxPings: number;
  pingMessage: string;
  notifierType: NotifierType;
  delivery: DeliveryMode;
  suppressPingWhileToolRunning: boolean;
  pauseOnInputRequest: boolean;
  notifyWaiting: boolean;
  verboseLog: boolean;
  tmux: {
    enabled: boolean;
    displayMessage: boolean;
    highlightWindow: boolean;
  };
  agents: {
    include?: string[];
    exclude?: string[];
  };
}
```

Extend `DEFAULT_CONFIG` (add after `notifierType: "tmux",`):

```ts
  delivery: "steer",
  suppressPingWhileToolRunning: true,
  pauseOnInputRequest: true,
  notifyWaiting: true,
  verboseLog: false,
```

Add a parser (next to `parseNotifierType`):

```ts
function parseDelivery(
  value: string | undefined,
  key: string,
  warn: WarnFn,
): DeliveryMode | undefined {
  if (value === undefined) return undefined;
  if (value === "steer" || value === "queue") return value;
  warn(`[watchdog] Invalid value for ${key}: "${value}". Falling back to lower-priority source.`);
  return undefined;
}
```

In `resolveConfig`, add env/project parsing (after the existing `projNotifierType` block):

```ts
  const envDelivery = parseDelivery(env.OPENCODE_WATCHDOG_DELIVERY, "OPENCODE_WATCHDOG_DELIVERY", warn);
  const projDelivery = parseDelivery(project.delivery, "delivery", warn);
  const envSuppressTool = parseBool(env.OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL, "OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL", warn);
  const envPauseOnInput = parseBool(env.OPENCODE_WATCHDOG_PAUSE_ON_INPUT, "OPENCODE_WATCHDOG_PAUSE_ON_INPUT", warn);
  const envNotifyWaiting = parseBool(env.OPENCODE_WATCHDOG_NOTIFY_WAITING, "OPENCODE_WATCHDOG_NOTIFY_WAITING", warn);
  const envVerbose = parseBool(env.OPENCODE_WATCHDOG_VERBOSE, "OPENCODE_WATCHDOG_VERBOSE", warn);
```

And add to the returned object (after `notifierType: ...,`):

```ts
    delivery: envDelivery ?? projDelivery ?? DEFAULT_CONFIG.delivery,
    suppressPingWhileToolRunning:
      envSuppressTool ?? project.suppressPingWhileToolRunning ?? DEFAULT_CONFIG.suppressPingWhileToolRunning,
    pauseOnInputRequest: envPauseOnInput ?? project.pauseOnInputRequest ?? DEFAULT_CONFIG.pauseOnInputRequest,
    notifyWaiting: envNotifyWaiting ?? project.notifyWaiting ?? DEFAULT_CONFIG.notifyWaiting,
    verboseLog: envVerbose ?? project.verboseLog ?? DEFAULT_CONFIG.verboseLog,
```

- [ ] **Step 4: Fix the now-broken `WatchdogConfig` literals in tests**

In `tests/watchdog.test.ts` `baseConfig` (after `notifierType: "tmux",`):

```ts
  delivery: "steer",
  suppressPingWhileToolRunning: true,
  pauseOnInputRequest: true,
  notifyWaiting: true,
  verboseLog: false,
```

In `tests/stress.test.ts` `cfg` (after `notifierType: "tmux",`): add the identical five lines.

- [ ] **Step 5: Run tests + typecheck (devcontainer)**

Run: `devcontainer exec --workspace-folder . bun test tests/config.test.ts && devcontainer exec --workspace-folder . bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Run full suite (devcontainer)** — `devcontainer exec --workspace-folder . bun test` → all pass (no regression).

- [ ] **Step 7: Commit (host)**

```bash
git add src/config.ts tests/config.test.ts tests/watchdog.test.ts tests/stress.test.ts
git commit -m "feat(config): delivery/tool-gate/pause/notify-waiting/verbose ノブを追加"
```

- [ ] **Step 8: Push + create Draft PR → Phase Base (host)**

```bash
git push -u origin feature/phase1-task1-config-knobs
gh pr create --draft --base feature/phase1-config-log-signal__base \
  --title "feat(config): 注入ゲーティング用の設定ノブ追加" \
  --body "派生元: feature/phase1-config-log-signal__base (Base) / 増分 ≤200 LOC / tests PASS"
```

- [ ] **Step 9: Tick this task's checkboxes in the plan and emit the completion report.**

### Task 1.2: Log reduction (#3)

**派生元: 直前Task (1.1)** — uses `config.verboseLog` introduced in 1.1.
**Branch:** `feature/phase1-task2-log-reduction` (from `feature/phase1-task1-config-knobs`)

**Files:**
- Modify: `src/index.ts` (add `summarizeEvent`/`logEvent`; replace the log call at `:313`)
- Modify: `tests/index.test.ts` (replace the stub with real tests)

- [ ] **Step 1: Write failing tests** — replace the contents of `tests/index.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { logEvent, summarizeEvent, type OpenCodeEvent } from "../src/index";

describe("logEvent verbosity (#3 log reduction)", () => {
  test("high-frequency delta is summarized (no full JSON) when verbose=false", () => {
    const logs: string[] = [];
    const ev: OpenCodeEvent = {
      type: "message.part.delta",
      properties: { sessionID: "s1", messageID: "m1", delta: "X".repeat(500) },
    };
    logEvent(ev, false, (_l, m) => logs.push(m));
    expect(logs.length).toBe(1);
    expect(logs[0]).not.toContain("XXXXX"); // delta body must NOT be logged
    expect(logs[0]).toContain("type=message.part.delta");
    expect(logs[0]).toContain("sessionID=s1");
  });

  test("verbose=true emits full JSON", () => {
    const logs: string[] = [];
    const ev: OpenCodeEvent = { type: "message.part.delta", properties: { sessionID: "s1", delta: "HELLO" } };
    logEvent(ev, true, (_l, m) => logs.push(m));
    expect(logs[0]).toContain("HELLO");
  });

  test("summarizeEvent includes part type + tool status for tool parts", () => {
    const ev: OpenCodeEvent = {
      type: "message.part.updated",
      properties: { part: { sessionID: "s1", type: "tool", state: { status: "running" } } },
    };
    const s = summarizeEvent(ev);
    expect(s).toContain("partType=tool");
    expect(s).toContain("toolStatus=running");
  });
});
```

- [ ] **Step 2: Run to verify fail** (devcontainer)

Run: `devcontainer exec --workspace-folder . bun test tests/index.test.ts`
Expected: FAIL — `logEvent`/`summarizeEvent` not exported.

- [ ] **Step 3: Implement in `src/index.ts`** — add near the other exported helpers (e.g. after `extractMessageId`):

```ts
function readAnySessionId(props: Record<string, unknown>): string | undefined {
  const direct = (props as { sessionID?: string }).sessionID;
  if (typeof direct === "string") return direct;
  const part = (props as { part?: { sessionID?: string } }).part;
  if (typeof part?.sessionID === "string") return part.sessionID;
  const info = (props as { info?: { sessionID?: string } }).info;
  if (typeof info?.sessionID === "string") return info.sessionID;
  return undefined;
}

export function summarizeEvent(event: OpenCodeEvent): string {
  const props = (event.properties ?? {}) as Record<string, unknown>;
  const segs: string[] = [`type=${event.type}`];
  const sid = readAnySessionId(props);
  if (sid) segs.push(`sessionID=${sid}`);
  if (event.type === "message.part.updated") {
    const part = (props as { part?: { type?: string; state?: { status?: string } } }).part;
    if (part?.type) segs.push(`partType=${part.type}`);
    if (part?.state?.status) segs.push(`toolStatus=${part.state.status}`);
  }
  return segs.join(" ");
}

export function logEvent(
  event: OpenCodeEvent,
  verbose: boolean,
  log: (level: "info" | "warn", message: string) => void,
): void {
  if (verbose) {
    log("info", `Event received (verbose): ${JSON.stringify(event)}`);
    return;
  }
  log("info", `Event: ${summarizeEvent(event)}`);
}
```

Replace the call site (currently `src/index.ts:313`):

```ts
        logEvent(event, config.verboseLog, instLog);
```

- [ ] **Step 4: Run tests + typecheck (devcontainer)** — `devcontainer exec --workspace-folder . bun test tests/index.test.ts && devcontainer exec --workspace-folder . bun run typecheck` → PASS / clean.

- [ ] **Step 5: Run full suite (devcontainer)** — `devcontainer exec --workspace-folder . bun test` → all pass.

- [ ] **Step 6: Commit (host)**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat(log): 高頻度イベントの完全JSONログを廃しverboseLog分岐を導入 (#3)"
```

- [ ] **Step 7: Push + Draft PR → Phase Base (host)**

```bash
git push -u origin feature/phase1-task2-log-reduction
gh pr create --draft --base feature/phase1-config-log-signal__base \
  --title "feat(log): ログ肥大抑制 (#3)" \
  --body "派生元: feature/phase1-task1-config-knobs (直前Task) / 増分 ≤200 LOC / tests PASS"
```

- [ ] **Step 8: Tick checkboxes + emit completion report.**

### Task 1.3: Stream-delta as activity signal

**派生元: Base** (self-contained — adds `message.part.delta` cases to `extractSessionId`/`extractMessageId` and one routing branch; does NOT depend on 1.1/1.2 code). *Note:* it edits the same `index.ts` event hook as 1.2, so after 1.2 merges to base, rebase this branch onto the updated base (workflow STEP 3).
**Branch:** `feature/phase1-task3-delta-activity`

**Files:**
- Modify: `src/index.ts` (`extractSessionId`, `extractMessageId`, event hook activity section)
- Modify: `tests/index.smoke.test.ts` (extract assertions + no-throw smoke)

- [ ] **Step 1: Write failing tests** — append to `tests/index.smoke.test.ts`:

```ts
describe("message.part.delta signal (design §5)", () => {
  test("extractSessionId reads delta sessionID from properties.sessionID", () => {
    expect(
      extractSessionId({ type: "message.part.delta", properties: { sessionID: "s-delta" } }),
    ).toBe("s-delta");
  });

  test("extractMessageId reads delta messageID from properties.messageID", () => {
    expect(
      extractMessageId({ type: "message.part.delta", properties: { messageID: "m-delta" } }),
    ).toBe("m-delta");
  });

  test("event hook does not throw on a delta payload", async () => {
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/delta-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx);
    try {
      await instance.event({
        event: { type: "message.part.delta", properties: { sessionID: "s1", messageID: "m1", delta: "hi" } },
      });
    } finally {
      await instance.dispose();
    }
  });
});
```

(Add `extractMessageId` to the existing import from `../src/index` at the top of the file.)

- [ ] **Step 2: Run to verify fail** (devcontainer) — `devcontainer exec --workspace-folder . bun test tests/index.smoke.test.ts` → FAIL on the extract assertions.

- [ ] **Step 3: Implement in `src/index.ts`.** Add a `case` to `extractSessionId` (alongside `session.idle`/`session.error`, since delta also uses `properties.sessionID`):

```ts
    case "message.part.delta": {
      const sid = (props as { sessionID?: string }).sessionID;
      return typeof sid === "string" ? sid : undefined;
    }
```

Add a branch to `extractMessageId` (before the final `return undefined;`):

```ts
  if (event.type === "message.part.delta") {
    const mid = (props as { messageID?: string }).messageID;
    return typeof mid === "string" ? mid : undefined;
  }
```

In the event hook's activity section (after the `message.updated` empty-user guard and before the `message.part.updated` branch), add:

```ts
        if (event.type === "message.part.delta") {
          instLog("info", `Event triggered onActivity (stream delta) for session ${sessionId}`);
          watchdog.onActivity(sessionId, { agentName });
          return;
        }
```

Self-ping deltas are already excluded upstream: the ping's `messageID` is registered in `IGNORED_PING_MESSAGE_IDS`, and delta chunks carry the same `messageID` (now resolvable via `extractMessageId`), so they hit the existing `IGNORED_PING_MESSAGE_IDS.has(messageId)` guard.

- [ ] **Step 4: Run tests + typecheck (devcontainer)** — `devcontainer exec --workspace-folder . bun test tests/index.smoke.test.ts && devcontainer exec --workspace-folder . bun run typecheck` → PASS / clean.

- [ ] **Step 5: Full suite (devcontainer)** — `devcontainer exec --workspace-folder . bun test` → all pass.

- [ ] **Step 6: Commit (host)**

```bash
git add src/index.ts tests/index.smoke.test.ts
git commit -m "feat(signal): message.part.delta をストリーム活性として扱う"
```

- [ ] **Step 7: Push + Draft PR → Phase Base (host)**

```bash
git push -u origin feature/phase1-task3-delta-activity
gh pr create --draft --base feature/phase1-config-log-signal__base \
  --title "feat(signal): delta 活性化" \
  --body "派生元: feature/phase1-config-log-signal__base (Base, 1.2とは独立) / 増分 ≤200 LOC / tests PASS"
```

- [ ] **Step 8: Tick checkboxes + emit completion report.**

---

## Phase 2: Steer Delivery (#1)

**Phase base:** `feature/phase2-steer-delivery__base` (from `master`, **after Phase 1 merges** — consumes `config.delivery`).
**Mergeable independently:** changes only the injection adapter + its construction.

### Task 2.1: V2 steer delivery with per-call legacy fallback

**派生元: Base** (self-contained — `pinger.ts` + one line in `index.ts` construction + `pinger.test.ts`).
**Branch:** `feature/phase2-task1-steer-adapter`

**Files:**
- Modify: `src/pinger.ts` (`OpenCodeAdapter` constructor + `inject`, client type)
- Modify: `src/index.ts:280` (pass `config.delivery`)
- Modify: `tests/pinger.test.ts` (update shape assertions to V2; add delivery + fallback tests)

- [ ] **Step 1: Update + add failing tests in `tests/pinger.test.ts`.** Replace the two existing shape-asserting tests ("delegates to client.session.prompt with `{ path: { id }, body: { parts } }` shape" and the context test) with V2-shape versions, and add two new tests:

```ts
  test("delegates with V2 { sessionID, parts, delivery } shape", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = { session: { prompt: async (a: Record<string, unknown>) => { calls.push(a); } } };
    const adapter = new OpenCodeAdapter(fakeClient, "steer");
    await adapter.inject("sess-abc", "ping?");
    expect(calls.length).toBe(1);
    expect(calls[0]!.sessionID).toBe("sess-abc");
    expect(calls[0]!.delivery).toBe("steer");
    const parts = calls[0]!.parts as Array<{ type: string; text: string }>;
    expect(parts[0]!.type).toBe("text");
    expect(parts[0]!.text).toBe("ping?");
  });

  test("V2 form carries the reason-enriched message (buildPingPrompt)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = { session: { prompt: async (a: Record<string, unknown>) => { calls.push(a); } } };
    const adapter = new OpenCodeAdapter(fakeClient, "steer");
    await adapter.inject("sess-abc", "ping?", { reason: "rate_limit" });
    const parts = calls[0]!.parts as Array<{ type: string; text: string }>;
    expect(parts[0]!.text).toContain("[Watchdog]");
    expect(parts[0]!.text).toContain("APIレート制限に到達しました");
  });

  test("passes delivery=queue when configured so", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = { session: { prompt: async (a: Record<string, unknown>) => { calls.push(a); } } };
    const adapter = new OpenCodeAdapter(fakeClient, "queue");
    await adapter.inject("s", "ping?");
    expect(calls[0]!.delivery).toBe("queue");
  });

  test("falls back to legacy { path, body } when the V2 form throws", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = {
      session: {
        prompt: async (a: Record<string, unknown>) => {
          calls.push(a);
          if ("delivery" in a) throw new Error("unknown field: delivery");
          return undefined;
        },
      },
    };
    const adapter = new OpenCodeAdapter(fakeClient, "steer");
    await adapter.inject("sess-xyz", "ping?");
    expect(calls.length).toBe(2);
    expect("delivery" in calls[0]!).toBe(true);
    const legacy = calls[1] as { path?: { id?: string }; body?: { parts?: unknown[] } };
    expect(legacy.path?.id).toBe("sess-xyz");
    expect(Array.isArray(legacy.body?.parts)).toBe(true);
  });
```

(The existing "does not throw when client method is missing", "does not throw when client throws", and "maintains 'this' binding" tests remain valid and unchanged.)

- [ ] **Step 2: Run to verify fail** (devcontainer) — `devcontainer exec --workspace-folder . bun test tests/pinger.test.ts` → FAIL (V2 shape / fallback not implemented).

- [ ] **Step 3: Implement `src/pinger.ts`.** Add the import and replace the client interface + `OpenCodeAdapter`:

```ts
import { reasonToJa, type HangReason } from "./errors";
import type { DeliveryMode } from "./config";
```

```ts
// V2: prompt({ sessionID, parts, delivery }); legacy: prompt({ path:{id}, body:{parts} }).
// Exact runtime shape is isolated here (SPEC §8.2). Loosely typed because two
// shapes share the method.
interface OpenCodeClientLike {
  session?: {
    prompt?: (args: Record<string, unknown>) => Promise<unknown>;
  };
}

export class OpenCodeAdapter implements Pinger {
  constructor(
    private readonly client: unknown,
    private readonly delivery: DeliveryMode = "steer",
  ) {}

  async inject(sessionId: string, message: string, context?: PingContext): Promise<void> {
    const client = this.client as OpenCodeClientLike;
    const session = client?.session;
    if (typeof session?.prompt !== "function") {
      console.warn(
        `[watchdog] OpenCode client.session.prompt is unavailable; cannot inject ping to ${sessionId}.`,
      );
      return;
    }
    const finalMessage = buildPingPrompt(message, context?.reason);
    const parts = [{ type: "text", text: finalMessage }];
    try {
      // Preferred V2 interrupt delivery. Per-call attempt (no permanent switch).
      await session.prompt({ sessionID: sessionId, parts, delivery: this.delivery });
    } catch {
      // V2 threw → runtime rejected the shape/field. Fall back to legacy queue form.
      try {
        await session.prompt({ path: { id: sessionId }, body: { parts } });
      } catch {
        console.warn(
          `[watchdog] Failed to inject ping to ${sessionId} (V2 steer and legacy both failed).`,
        );
      }
    }
  }
}
```

In `src/index.ts:280`, pass the configured delivery:

```ts
  const pinger = new OpenCodeAdapter(input?.client, config.delivery);
```

- [ ] **Step 4: Run tests + typecheck (devcontainer)** — `devcontainer exec --workspace-folder . bun test tests/pinger.test.ts && devcontainer exec --workspace-folder . bun run typecheck` → PASS / clean.

- [ ] **Step 5: Full suite (devcontainer)** — `devcontainer exec --workspace-folder . bun test` → all pass.

- [ ] **Step 6: Commit (host)**

```bash
git add src/pinger.ts src/index.ts tests/pinger.test.ts
git commit -m "feat(pinger): delivery:steer 注入とlegacyフォールバックを実装 (#1)"
```

- [ ] **Step 7: Push + Draft PR → Phase Base (host)**

```bash
git push -u origin feature/phase2-task1-steer-adapter
gh pr create --draft --base feature/phase2-steer-delivery__base \
  --title "feat(pinger): steer 注入 (#1)" \
  --body "派生元: feature/phase2-steer-delivery__base (Base) / 依存: Phase1 config.delivery / 増分 ≤200 LOC / tests PASS"
```

- [ ] **Step 8: Tick checkboxes + emit completion report.**

---

## Phase 3: Input-Wait Gating (#2) — PAUSED state

**Phase base:** `feature/phase3-input-wait-gating__base` (from `master`, after Phase 1; independent of Phase 2).
**Mergeable independently:** pausing on permission/question + "waiting" notification.

### Task 3.1: Notifier `"waiting"` stage

**派生元: Base** (self-contained — `notifier.ts` + `notifier.test.ts`).
**Branch:** `feature/phase3-task1-notifier-waiting`

**Files:**
- Modify: `src/notifier.ts` (`NotifierStage`, `STYLE_BY_STAGE`, `OS_URGENCY_BY_STAGE`)
- Modify: `tests/notifier.test.ts`

- [ ] **Step 1: Write failing tests.** In `tests/notifier.test.ts`, add to the `describe("TmuxNotifier - actions", ...)` block (which has the `beforeEach` setup):

```ts
  test("notify(waiting) passes message verbatim and applies cyan highlight", async () => {
    const exact = "[Watchdog] Agent is waiting for your input";
    await notifier.notify("sess-1", "waiting", exact);
    const displayCall = calls.find((c) => c.cmd.length === 3 && c.cmd[1] === "display-message");
    expect(displayCall!.cmd).toEqual(["/usr/bin/tmux", "display-message", exact]);
    expect(
      calls.some((c) => c.cmd[1] === "set-window-option" && c.cmd.includes("bg=cyan")),
    ).toBe(true);
  });
```

And in `describe("OSNotifier - linux (notify-send)", ...)`:

```ts
  test("waiting maps to low urgency", async () => {
    const { spawn, calls } = buildSpawn({});
    const which: WhichFn = () => "/usr/bin/notify-send";
    const n = new OSNotifier({ platform: "linux", spawn, which, log: () => {} });
    await n.notify("s1", "waiting", "hi");
    expect(calls[0]!.cmd).toEqual(["/usr/bin/notify-send", "-u", "low", "Akane Watchdog", "hi"]);
  });
```

- [ ] **Step 2: Run to verify fail** (devcontainer) — `devcontainer exec --workspace-folder . bun test tests/notifier.test.ts` → FAIL (type error: `"waiting"` not in `NotifierStage`).

- [ ] **Step 3: Implement `src/notifier.ts`.**

```ts
export type NotifierStage = "warn" | "critical" | "silenced" | "waiting";
```

```ts
const STYLE_BY_STAGE: Record<NotifierStage, string> = {
  warn: "bg=yellow",
  critical: "bg=red",
  silenced: "bg=red",
  waiting: "bg=cyan",
};
```

```ts
const OS_URGENCY_BY_STAGE: Record<NotifierStage, "low" | "normal" | "critical"> = {
  warn: "normal",
  critical: "critical",
  silenced: "critical",
  waiting: "low",
};
```

No change to `notify()` bodies — they already index these tables by `stage` and pass `message` verbatim.

- [ ] **Step 4: Run tests + typecheck (devcontainer)** — `devcontainer exec --workspace-folder . bun test tests/notifier.test.ts && devcontainer exec --workspace-folder . bun run typecheck` → PASS / clean.

- [ ] **Step 5: Full suite (devcontainer)** — all pass.

- [ ] **Step 6: Commit (host)**

```bash
git add src/notifier.ts tests/notifier.test.ts
git commit -m "feat(notifier): waiting ステージ(cyan/urgency=low)を追加"
```

- [ ] **Step 7: Push + Draft PR → Phase Base (host)**

```bash
git push -u origin feature/phase3-task1-notifier-waiting
gh pr create --draft --base feature/phase3-input-wait-gating__base \
  --title "feat(notifier): waiting 通知" \
  --body "派生元: feature/phase3-input-wait-gating__base (Base) / 増分 ≤200 LOC / tests PASS"
```

- [ ] **Step 8: Tick checkboxes + emit completion report.**

### Task 3.2: `PAUSED` state + input pending in `watchdog.ts`

**派生元: 直前Task (3.1)** — `onInputRequested` calls `notifier.notify(..., "waiting", ...)` introduced in 3.1.
**Branch:** `feature/phase3-task2-paused-state` (from `feature/phase3-task1-notifier-waiting`)

**Files:**
- Modify: `src/watchdog.ts` (`State`, `SessionEntry`, `armOrReset`, `onActivity` guard, `onInputRequested`, `onInputResolved`)
- Modify: `tests/watchdog.test.ts`

- [ ] **Step 1: Write failing tests** — append a describe block to `tests/watchdog.test.ts`:

```ts
describe("Watchdog - PAUSED input-wait gating (design §4/§6.1)", () => {
  test("onInputRequested stops timer, transitions to PAUSED, notifies waiting once", () => {
    const { watchdog, notifier } = setup();
    watchdog.onActivity("s1");
    expect(watchdog.activeTimerCount()).toBe(1);
    watchdog.onInputRequested("s1", "per_1");
    expect(watchdog.activeTimerCount()).toBe(0);
    expect(notifier.notifies.filter((n) => n.stage === "waiting").length).toBe(1);
    watchdog.onInputRequested("s1", "que_2"); // second pending → no second notify
    expect(notifier.notifies.filter((n) => n.stage === "waiting").length).toBe(1);
  });

  test("PAUSED suppresses stage1/stage2 (no notify, no ping)", async () => {
    const { watchdog, notifier, pinger, clock } = setup();
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1");
    clock.advance(10_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(notifier.notifies.some((n) => n.stage === "warn" || n.stage === "critical")).toBe(false);
    expect(pinger.calls.length).toBe(0);
  });

  test("partial resolve keeps PAUSED; full resolve returns to WATCHING and clears notifier", () => {
    const { watchdog, notifier, clock } = setup();
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1");
    watchdog.onInputRequested("s1", "que_2");
    watchdog.onInputResolved("s1", "per_1");
    expect(watchdog.activeTimerCount()).toBe(0); // still PAUSED
    watchdog.onInputResolved("s1", "que_2");
    expect(watchdog.activeTimerCount()).toBe(1); // re-armed WATCHING
    expect(notifier.cleared).toContain("s1");
    clock.advance(1000);
    expect(notifier.notifies.some((n) => n.stage === "warn")).toBe(true);
  });

  test("assistant activity does NOT un-pause while pending (design §7)", () => {
    const { watchdog } = setup();
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1");
    watchdog.onActivity("s1"); // must be ignored
    expect(watchdog.activeTimerCount()).toBe(0);
  });

  test("onInputRequested respects tombstone (stopped session ignored)", () => {
    const { watchdog, notifier } = setup();
    watchdog.onActivity("s1");
    watchdog.stop("s1");
    watchdog.onInputRequested("s1", "per_1");
    expect(notifier.notifies.some((n) => n.stage === "waiting")).toBe(false);
    expect(watchdog.activeSessionCount()).toBe(0);
  });

  test("pauseOnInputRequest=false makes onInputRequested a no-op", () => {
    const { watchdog, notifier } = setup({ pauseOnInputRequest: false });
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1");
    expect(watchdog.activeTimerCount()).toBe(1); // unchanged
    expect(notifier.notifies.some((n) => n.stage === "waiting")).toBe(false);
  });

  test("notifyWaiting=false pauses without a waiting notification", () => {
    const { watchdog, notifier } = setup({ notifyWaiting: false });
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1");
    expect(watchdog.activeTimerCount()).toBe(0);
    expect(notifier.notifies.some((n) => n.stage === "waiting")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail** (devcontainer) — `devcontainer exec --workspace-folder . bun test tests/watchdog.test.ts` → FAIL (`onInputRequested` not defined).

- [ ] **Step 3: Implement `src/watchdog.ts`.**

State + entry field:

```ts
type State = "WATCHING" | "STAGE1_NOTIFIED" | "PINGED" | "SILENCED" | "PAUSED";
```

```ts
interface SessionEntry {
  state: State;
  timer: TimerHandle | null;
  pingCount: number;
  agentName?: string;
  lastPingTime?: number;
  lastErrorReason?: HangReason;
  pendingRequests: Set<string>;
}
```

In `armOrReset`, add `pendingRequests` to the new entry literal (preserve across re-arm):

```ts
    const entry: SessionEntry = {
      state: "WATCHING",
      timer: null,
      pingCount: 0,
      agentName: effectiveName,
      pendingRequests: existing?.pendingRequests ?? new Set(),
    };
```

Guard `onActivity` against un-pausing (insert after the SILENCED guard):

```ts
    if (existing && existing.state === "PAUSED" && existing.pendingRequests.size > 0) {
      this.log("info", `[Watchdog] onActivity ignored: session ${sessionId} is PAUSED (awaiting input)`);
      return;
    }
```

Add the two methods (e.g. after `onActivity`):

```ts
  /** permission/question asked → pause (design §4/§6.1). */
  onInputRequested(sessionId: string, requestId: string): void {
    if (!this.config.pauseOnInputRequest) return;
    if (this.stoppedSessions.has(sessionId)) {
      this.log("info", `[Watchdog] onInputRequested ignored: session ${sessionId} tombstoned`);
      return;
    }
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { state: "PAUSED", timer: null, pingCount: 0, pendingRequests: new Set() };
      this.sessions.set(sessionId, entry);
    }
    const wasEmpty = entry.pendingRequests.size === 0;
    entry.pendingRequests.add(requestId);
    if (entry.timer !== null) {
      this.clock.clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.state = "PAUSED";
    this.log("info", `[Watchdog] onInputRequested: session ${sessionId} PAUSED (pending=${entry.pendingRequests.size})`);
    if (wasEmpty && this.config.notifyWaiting) {
      this.notifier
        .notify(sessionId, "waiting", "[Watchdog] Agent is waiting for your input")
        .catch((err) => this.log("warn", `notifier.notify(waiting) failed: ${String(err)}`));
    }
  }

  /** permission/question replied → resume when all pending cleared. */
  onInputResolved(sessionId: string, requestId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.pendingRequests.delete(requestId);
    if (entry.pendingRequests.size === 0) {
      this.log("info", `[Watchdog] onInputResolved: all input resolved for ${sessionId}, resuming WATCHING`);
      this.armOrReset(sessionId, { agentName: entry.agentName });
    }
  }
```

*Edge case (documented):* if a PAUSED entry was created with no `agentName` (input before any assistant activity) and an `agents.include` list is configured, `armOrReset` treats it as unmonitored and leaves an inert empty-pending PAUSED entry (no timer). It is harmless and reset by the next user message/activity.

- [ ] **Step 4: Run tests + typecheck (devcontainer)** — `devcontainer exec --workspace-folder . bun test tests/watchdog.test.ts && devcontainer exec --workspace-folder . bun run typecheck` → PASS / clean.

- [ ] **Step 5: Full suite (devcontainer)** — all pass.

- [ ] **Step 6: Commit (host)**

```bash
git add src/watchdog.ts tests/watchdog.test.ts
git commit -m "feat(watchdog): PAUSED 状態と入力待ちゲートを追加 (#2)"
```

- [ ] **Step 7: Push + Draft PR → Phase Base (host)**

```bash
git push -u origin feature/phase3-task2-paused-state
gh pr create --draft --base feature/phase3-input-wait-gating__base \
  --title "feat(watchdog): PAUSED ゲート (#2)" \
  --body "派生元: feature/phase3-task1-notifier-waiting (直前Task) / 増分 ≤200 LOC / tests PASS"
```

- [ ] **Step 8: Tick checkboxes + emit completion report.**

### Task 3.3: Route `permission.*` / `question.*` in `index.ts`

**派生元: 直前Task (3.2)** — calls `watchdog.onInputRequested`/`onInputResolved` from 3.2.
**Branch:** `feature/phase3-task3-input-routing` (from `feature/phase3-task2-paused-state`)

**Files:**
- Modify: `src/index.ts` (`extractSessionId` cases, `extractRequestId`, hook routing)
- Modify: `tests/index.smoke.test.ts`

- [ ] **Step 1: Write failing tests** — append to `tests/index.smoke.test.ts` (add `extractRequestId` to the import):

```ts
describe("input-wait routing (design §5/§6.2)", () => {
  test("extractSessionId reads permission/question sessionID from properties.sessionID", () => {
    for (const t of ["permission.asked", "permission.replied", "question.asked", "question.replied"]) {
      expect(extractSessionId({ type: t, properties: { sessionID: "s-in" } })).toBe("s-in");
    }
  });

  test("extractRequestId: asked→properties.id, replied→properties.requestID", () => {
    expect(extractRequestId({ type: "permission.asked", properties: { id: "per_1" } })).toBe("per_1");
    expect(extractRequestId({ type: "question.asked", properties: { id: "que_1" } })).toBe("que_1");
    expect(extractRequestId({ type: "permission.replied", properties: { requestID: "per_1" } })).toBe("per_1");
    expect(extractRequestId({ type: "question.replied", properties: { requestID: "que_1" } })).toBe("que_1");
    expect(extractRequestId({ type: "message.updated", properties: {} })).toBeUndefined();
  });

  test("event hook does not throw on asked/replied payloads", async () => {
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/input-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx);
    try {
      await instance.event({ event: { type: "permission.asked", properties: { sessionID: "s1", id: "per_1" } } });
      await instance.event({ event: { type: "permission.replied", properties: { sessionID: "s1", requestID: "per_1" } } });
      await instance.event({ event: { type: "question.asked", properties: { sessionID: "s1", id: "que_1" } } });
      await instance.event({ event: { type: "question.replied", properties: { sessionID: "s1", requestID: "que_1" } } });
    } finally {
      await instance.dispose();
    }
  });
});
```

> Testing note: behavioral correctness of pause/resume is proven deterministically at the watchdog layer (Task 3.2 with `FakeClock`). At the index layer we test the pure extractors + a no-throw smoke of the hook, matching the repo's existing `index.smoke.test.ts` style (the plugin builds its own `Watchdog` with no DI seam, so timing assertions belong in `watchdog.test.ts`).

- [ ] **Step 2: Run to verify fail** (devcontainer) — `devcontainer exec --workspace-folder . bun test tests/index.smoke.test.ts` → FAIL (`extractRequestId` undefined).

- [ ] **Step 3: Implement `src/index.ts`.** Add `case`s to `extractSessionId` (alongside `session.idle`/`session.error`):

```ts
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied": {
      const sid = (props as { sessionID?: string }).sessionID;
      return typeof sid === "string" ? sid : undefined;
    }
```

Add `extractRequestId` (export, near `extractMessageId`):

```ts
export function extractRequestId(event: OpenCodeEvent): string | undefined {
  const props = event.properties ?? {};
  if (event.type === "permission.asked" || event.type === "question.asked") {
    const id = (props as { id?: string }).id;
    return typeof id === "string" ? id : undefined;
  }
  if (event.type === "permission.replied" || event.type === "question.replied") {
    const rid = (props as { requestID?: string }).requestID;
    return typeof rid === "string" ? rid : undefined;
  }
  return undefined;
}
```

In the event hook, **insert right after the `if (!sessionId) { ... return; }` guard** (so it bypasses the ping-filter and arm-lock — input is user-message-equivalent priority):

```ts
        // --- Input-Wait Gating (Priority 1, user-message-equivalent) ---
        if (event.type === "permission.asked" || event.type === "question.asked") {
          const requestId = extractRequestId(event);
          if (requestId) watchdog.onInputRequested(sessionId, requestId);
          return;
        }
        if (event.type === "permission.replied" || event.type === "question.replied") {
          const requestId = extractRequestId(event);
          if (requestId) watchdog.onInputResolved(sessionId, requestId);
          return;
        }
```

- [ ] **Step 4: Run tests + typecheck (devcontainer)** — `devcontainer exec --workspace-folder . bun test tests/index.smoke.test.ts && devcontainer exec --workspace-folder . bun run typecheck` → PASS / clean.

- [ ] **Step 5: Full suite (devcontainer)** — all pass.

- [ ] **Step 6: Commit (host)**

```bash
git add src/index.ts tests/index.smoke.test.ts
git commit -m "feat(index): permission/question を入力待ちゲートへルーティング (#2)"
```

- [ ] **Step 7: Push + Draft PR → Phase Base (host)**

```bash
git push -u origin feature/phase3-task3-input-routing
gh pr create --draft --base feature/phase3-input-wait-gating__base \
  --title "feat(index): 入力待ちルーティング (#2)" \
  --body "派生元: feature/phase3-task2-paused-state (直前Task) / 増分 ≤200 LOC / tests PASS"
```

- [ ] **Step 8: Tick checkboxes + emit completion report.**

---

## Phase 4: Tool-Awareness Steer-Suppression & Retry

**Phase base:** `feature/phase4-tool-gate-retry__base` (from `master`, after Phase 3 — needs `pendingRequests` for the PAUSED×retry invariant; the gate prevents steer from falsely interrupting running tools).

### Task 4.1: Tool tracking + steer-suppression gate in `watchdog.ts`

**派生元: Base** (self-contained — `watchdog.ts` + `watchdog.test.ts`; consumes `config.suppressPingWhileToolRunning` from Phase 1).
**Branch:** `feature/phase4-task1-tool-gate`

**Files:**
- Modify: `src/watchdog.ts` (`SessionEntry.runningTools`, `armOrReset` preserve, `onToolRunning`/`onToolSettled`, gate in `onStage2Expire`)
- Modify: `tests/watchdog.test.ts`

- [ ] **Step 1: Write failing tests** — append to `tests/watchdog.test.ts`:

```ts
describe("Watchdog - tool-aware steer suppression (design §4/§6.1)", () => {
  test("stage2 with a running tool suppresses ping, holds pingCount, notifies critical, reschedules", async () => {
    const { watchdog, pinger, notifier, clock } = setup();
    watchdog.onToolRunning("s1", "call_1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 → gate
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(0); // steer suppressed
    expect(notifier.notifies.some((n) => n.stage === "critical")).toBe(true);
    expect(watchdog.activeTimerCount()).toBe(1); // rescheduled
  });

  test("repeated stage2 while tool runs does not spam critical notifications", async () => {
    const { watchdog, notifier, clock } = setup();
    watchdog.onToolRunning("s1", "call_1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 (1st gate → critical)
    await new Promise((r) => setTimeout(r, 10));
    const after1 = notifier.notifies.filter((n) => n.stage === "critical").length;
    clock.advance(1000); // stage2 again (still gated)
    await new Promise((r) => setTimeout(r, 10));
    const after2 = notifier.notifies.filter((n) => n.stage === "critical").length;
    expect(after2).toBe(after1); // no re-notify while still gated
  });

  test("after tool settles, normal stage2 ping resumes", async () => {
    const { watchdog, pinger, clock } = setup();
    watchdog.onToolRunning("s1", "call_1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 gated
    await new Promise((r) => setTimeout(r, 10));
    watchdog.onToolSettled("s1", "call_1"); // re-arms WATCHING
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 → ping now allowed
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
  });

  test("suppressPingWhileToolRunning=false lets the ping fire even with a running tool", async () => {
    const { watchdog, pinger, clock } = setup({ suppressPingWhileToolRunning: false });
    watchdog.onToolRunning("s1", "call_1");
    clock.advance(1000);
    clock.advance(1000);
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
  });

  test("two running tools: settling one keeps suppression until both settle", async () => {
    const { watchdog, pinger, clock } = setup();
    watchdog.onToolRunning("s1", "call_1");
    watchdog.onToolRunning("s1", "call_2");
    watchdog.onToolSettled("s1", "call_1");
    clock.advance(1000);
    clock.advance(1000);
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(0); // call_2 still running
  });
});
```

- [ ] **Step 2: Run to verify fail** (devcontainer) — FAIL (`onToolRunning` not defined).

- [ ] **Step 3: Implement `src/watchdog.ts`.** Add the field:

```ts
interface SessionEntry {
  state: State;
  timer: TimerHandle | null;
  pingCount: number;
  agentName?: string;
  lastPingTime?: number;
  lastErrorReason?: HangReason;
  pendingRequests: Set<string>;
  runningTools: Set<string>;
}
```

Preserve `runningTools` across `armOrReset` (add to the entry literal):

```ts
      runningTools: existing?.runningTools ?? new Set(),
```

Also add `runningTools: new Set()` to the entry literal created in `onInputRequested` (so PAUSED entries carry the field).

Add the methods (after `onInputResolved`):

```ts
  /** tool part reached `running` — active + tracked for steer suppression. */
  onToolRunning(sessionId: string, callId: string): void {
    if (this.stoppedSessions.has(sessionId)) return;
    this.armOrReset(sessionId, {});
    const entry = this.sessions.get(sessionId);
    if (entry) entry.runningTools.add(callId);
  }

  /** tool part reached `completed`/`error` — untrack + active. */
  onToolSettled(sessionId: string, callId: string): void {
    if (this.stoppedSessions.has(sessionId)) return;
    const existing = this.sessions.get(sessionId);
    existing?.runningTools.delete(callId);
    this.armOrReset(sessionId, {});
    const entry = this.sessions.get(sessionId);
    if (entry && existing) {
      for (const id of existing.runningTools) entry.runningTools.add(id);
    }
  }
```

> `armOrReset` preserves `runningTools` from `existing`, so `onToolRunning` adding after re-arm is safe; in `onToolSettled` we delete first, then re-arm (which carries over the remaining set).

Add the **steer-suppression gate** at the top of `onStage2Expire` (after the `if (!entry) return;` guard, before the `pingCount < maxPings` block):

```ts
    if (this.config.suppressPingWhileToolRunning && entry.runningTools.size > 0) {
      this.log("info", `[Watchdog] STAGE2 gated: ${entry.runningTools.size} tool(s) running for ${sessionId}; not injecting`);
      const reNotify = entry.state !== "STAGE1_NOTIFIED" && entry.state !== "PINGED";
      // Notify critical only on first gate to avoid OS-notification spam while still gated.
      if (entry.state !== "PINGED") {
        entry.state = "PINGED";
        await this.notifier.notify(
          sessionId,
          "critical",
          `[Watchdog] Agent ${sessionId} stalled but a tool is running; holding.`,
        );
      }
      void reNotify;
      entry.timer = this.clock.setTimeout(() => {
        this.onStage2Expire(sessionId).catch((err) =>
          this.log("warn", `stage2 handler failed: ${String(err)}`),
        );
      }, this.config.stage2Ms);
      return;
    }
```

> The gate sets state to `PINGED` once so the next gated stage2 (still `PINGED`) skips the notification — matching the "critical 通知（初回のみ）" + "再スケジュール" requirement. `pingCount` is left untouched (held).

- [ ] **Step 4: Run tests + typecheck (devcontainer)** — `devcontainer exec --workspace-folder . bun test tests/watchdog.test.ts && devcontainer exec --workspace-folder . bun run typecheck` → PASS / clean.

- [ ] **Step 5: Full suite (devcontainer)** — all pass.

- [ ] **Step 6: Commit (host)**

```bash
git add src/watchdog.ts tests/watchdog.test.ts
git commit -m "feat(watchdog): tool実行中のsteer抑止ゲートを追加"
```

- [ ] **Step 7: Push + Draft PR → Phase Base (host)**

```bash
git push -u origin feature/phase4-task1-tool-gate
gh pr create --draft --base feature/phase4-tool-gate-retry__base \
  --title "feat(watchdog): tool-gate" \
  --body "派生元: feature/phase4-tool-gate-retry__base (Base) / 依存: Phase1 config / 増分 ≤200 LOC / tests PASS"
```

- [ ] **Step 8: Tick checkboxes + emit completion report.**

### Task 4.2: Route tool parts in `index.ts`

**派生元: 直前Task (4.1)** — calls `watchdog.onToolRunning`/`onToolSettled` from 4.1.
**Branch:** `feature/phase4-task2-tool-routing` (from `feature/phase4-task1-tool-gate`)

**Files:**
- Modify: `src/index.ts` (tool-part branch inside the `message.part.updated` handling)
- Modify: `tests/index.smoke.test.ts`

- [ ] **Step 1: Write failing tests** — append to `tests/index.smoke.test.ts`:

```ts
describe("tool-part routing (design §5)", () => {
  test("event hook does not throw on tool part status transitions", async () => {
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/tool-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx);
    try {
      for (const status of ["pending", "running", "completed", "error"]) {
        await instance.event({
          event: {
            type: "message.part.updated",
            properties: { part: { sessionID: "s1", type: "tool", callID: "call_1", state: { status } } },
          },
        });
      }
    } finally {
      await instance.dispose();
    }
  });
});
```

- [ ] **Step 2: Run to verify fail** (devcontainer) — runs but provides no coverage of the new branch yet; this smoke guards against throwing once implemented. (Behavior is covered in Task 4.1.)

- [ ] **Step 3: Implement `src/index.ts`.** In the `if (event.type === "message.part.updated") { ... }` block, **before** the existing `agentName !== undefined` activity check, add the tool-part branch:

```ts
          const toolPart = (event.properties as {
            part?: { type?: string; callID?: string; state?: { status?: string } };
          } | undefined)?.part;
          if (toolPart?.type === "tool") {
            const status = toolPart.state?.status;
            const callId = toolPart.callID;
            if (status === "running" && callId) {
              instLog("info", `Tool running for session ${sessionId} (callID: ${callId})`);
              watchdog.onToolRunning(sessionId, callId);
              return;
            }
            if ((status === "completed" || status === "error") && callId) {
              instLog("info", `Tool settled (${status}) for session ${sessionId} (callID: ${callId})`);
              watchdog.onToolSettled(sessionId, callId);
              return;
            }
            // pending = active but not yet running → refresh stage1 without tracking.
            instLog("info", `Tool pending for session ${sessionId}`);
            watchdog.onActivity(sessionId, { agentName });
            return;
          }
```

- [ ] **Step 4: Run tests + typecheck (devcontainer)** — `devcontainer exec --workspace-folder . bun test tests/index.smoke.test.ts && devcontainer exec --workspace-folder . bun run typecheck` → PASS / clean.

- [ ] **Step 5: Full suite (devcontainer)** — all pass.

- [ ] **Step 6: Commit (host)**

```bash
git add src/index.ts tests/index.smoke.test.ts
git commit -m "feat(index): tool パートを running/settled へルーティング"
```

- [ ] **Step 7: Push + Draft PR → Phase Base (host)**

```bash
git push -u origin feature/phase4-task2-tool-routing
gh pr create --draft --base feature/phase4-tool-gate-retry__base \
  --title "feat(index): tool ルーティング" \
  --body "派生元: feature/phase4-task1-tool-gate (直前Task) / 増分 ≤200 LOC / tests PASS"
```

- [ ] **Step 8: Tick checkboxes + emit completion report.**

### Task 4.3: `session.status:retry` suppression

**派生元: Base** (logically independent of the tool-gate; needs only Phase 3's `pendingRequests` for the PAUSED×retry invariant, already merged). *Note:* edits the same `watchdog.ts`/`index.ts` regions as 4.1/4.2, so rebase onto base after 4.1/4.2 merge (workflow STEP 3).
**Branch:** `feature/phase4-task3-retry-suppression`

**Files:**
- Modify: `src/watchdog.ts` (`SessionEntry.retrySuppressed`, `onStatusRetry`, `onStatusActive`)
- Modify: `src/index.ts` (`extractSessionId` `session.status` case, `extractStatusType`, routing)
- Modify: `tests/watchdog.test.ts`, `tests/index.smoke.test.ts`

- [ ] **Step 1: Write failing tests** — append to `tests/watchdog.test.ts`:

```ts
describe("Watchdog - retry suppression (design §6.1/§7)", () => {
  test("onStatusRetry stops escalation timer; onStatusActive(busy) re-arms", async () => {
    const { watchdog, notifier, clock } = setup();
    watchdog.onActivity("s1");
    watchdog.onStatusRetry("s1");
    expect(watchdog.activeTimerCount()).toBe(0);
    clock.advance(10_000);
    expect(notifier.notifies.length).toBe(0); // no escalation while retrying
    watchdog.onStatusActive("s1");
    expect(watchdog.activeTimerCount()).toBe(1); // re-armed
    clock.advance(1000);
    expect(notifier.notifies.some((n) => n.stage === "warn")).toBe(true);
  });

  test("PAUSED × retry: busy recovery keeps PAUSED while input is pending (§7)", () => {
    const { watchdog } = setup();
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1");
    watchdog.onStatusRetry("s1");
    watchdog.onStatusActive("s1"); // busy returns, but input still pending
    expect(watchdog.activeTimerCount()).toBe(0); // remains PAUSED, not re-armed
  });
});
```

Append to `tests/index.smoke.test.ts` (add `extractStatusType` to the import):

```ts
describe("session.status routing (design §5)", () => {
  test("extractSessionId reads session.status sessionID from properties.sessionID", () => {
    expect(extractSessionId({ type: "session.status", properties: { sessionID: "s-st" } })).toBe("s-st");
  });
  test("extractStatusType reads properties.status.type", () => {
    expect(extractStatusType({ type: "session.status", properties: { status: { type: "retry" } } })).toBe("retry");
    expect(extractStatusType({ type: "session.status", properties: { status: { type: "busy" } } })).toBe("busy");
    expect(extractStatusType({ type: "message.updated", properties: {} })).toBeUndefined();
  });
  test("event hook does not throw on session.status payloads", async () => {
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/status-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx);
    try {
      await instance.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "retry" } } } });
      await instance.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } });
      await instance.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } } });
    } finally {
      await instance.dispose();
    }
  });
});
```

- [ ] **Step 2: Run to verify fail** (devcontainer) — FAIL (`onStatusRetry`/`extractStatusType` undefined).

- [ ] **Step 3: Implement.** In `src/watchdog.ts`, add `retrySuppressed?: boolean;` to `SessionEntry`, and the methods:

```ts
  /** session.status:retry → suppress escalation, stop the running timer. */
  onStatusRetry(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.retrySuppressed = true;
    if (entry.timer !== null) {
      this.clock.clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.log("info", `[Watchdog] retry suppression ON for ${sessionId}`);
  }

  /** session.status:busy or activity → clear retry suppression and resume,
   *  unless still PAUSED with pending input (design §7). */
  onStatusActive(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.retrySuppressed) return;
    entry.retrySuppressed = false;
    if (entry.state === "PAUSED" && entry.pendingRequests.size > 0) {
      this.log("info", `[Watchdog] retry cleared but ${sessionId} stays PAUSED (pending input)`);
      return;
    }
    this.armOrReset(sessionId, { agentName: entry.agentName });
  }
```

In `src/index.ts`, add a `session.status` case to `extractSessionId`:

```ts
    case "session.status": {
      const sid = (props as { sessionID?: string }).sessionID;
      return typeof sid === "string" ? sid : undefined;
    }
```

Add `extractStatusType` (export):

```ts
export function extractStatusType(event: OpenCodeEvent): string | undefined {
  if (event.type !== "session.status") return undefined;
  const status = (event.properties as { status?: { type?: string } } | undefined)?.status;
  return typeof status?.type === "string" ? status.type : undefined;
}
```

Route in the hook — insert after the input-wait gating block (Task 3.3), before message-id/ping handling:

```ts
        if (event.type === "session.status") {
          const statusType = extractStatusType(event);
          if (statusType === "retry") {
            watchdog.onStatusRetry(sessionId);
          } else if (statusType === "busy") {
            watchdog.onStatusActive(sessionId);
          }
          // "idle" is auxiliary; session.idle event is the primary stop signal.
          return;
        }
```

- [ ] **Step 4: Run tests + typecheck (devcontainer)** — `devcontainer exec --workspace-folder . bun test tests/watchdog.test.ts tests/index.smoke.test.ts && devcontainer exec --workspace-folder . bun run typecheck` → PASS / clean.

- [ ] **Step 5: Full suite (devcontainer)** — all pass.

- [ ] **Step 6: Commit (host)**

```bash
git add src/watchdog.ts src/index.ts tests/watchdog.test.ts tests/index.smoke.test.ts
git commit -m "feat(watchdog): session.status:retry のescalation抑止を追加"
```

- [ ] **Step 7: Push + Draft PR → Phase Base (host)**

```bash
git push -u origin feature/phase4-task3-retry-suppression
gh pr create --draft --base feature/phase4-tool-gate-retry__base \
  --title "feat(watchdog): retry 抑止" \
  --body "派生元: feature/phase4-tool-gate-retry__base (Base, tool-gateとは独立) / 増分 ≤200 LOC / tests PASS"
```

- [ ] **Step 8: Tick checkboxes + emit completion report.**

---

## Phase 5: Integration Hardening & Telemetry (optional)

**Phase base:** `feature/phase5-hardening-telemetry__base` (from `master`, after Phase 4).

### Task 5.1: Stress / leak / vertical-chain integration

**派生元: Base** (self-contained — `stress.test.ts` only; exercises merged behavior).
**Branch:** `feature/phase5-task1-stress-integration`

**Files:**
- Modify: `tests/stress.test.ts`

- [ ] **Step 1: Add tests** — append to `tests/stress.test.ts` (the `cfg` literal already has the Phase-1 fields after Phase 1 merged):

```ts
describe("Watchdog - input/tool churn leak (design §7.4)", () => {
  test("1000 sessions of asked→running→settled→replied leave no leaks", () => {
    const clock = new FakeClock();
    const watchdog = new Watchdog({
      config: cfg, clock, pinger: new MockPinger(), notifier: new NoopNotifier(), log: () => {},
    });
    for (let s = 0; s < 1000; s++) {
      const sid = `sess-${s}`;
      watchdog.onActivity(sid);
      watchdog.onInputRequested(sid, `per_${s}`);
      watchdog.onInputResolved(sid, `per_${s}`);
      watchdog.onToolRunning(sid, `call_${s}`);
      watchdog.onToolSettled(sid, `call_${s}`);
    }
    expect(watchdog.activeSessionCount()).toBe(1000);
    for (let s = 0; s < 1000; s++) watchdog.stop(`sess-${s}`);
    expect(watchdog.activeSessionCount()).toBe(0);
    expect(watchdog.activeTimerCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  test("vertical chain: permission.asked→tool running→settled→replied keeps gate+pause order", async () => {
    const clock = new FakeClock();
    const pinger = new MockPinger();
    const notifies: NotifierStage[] = [];
    const notifier: Notifier = { async notify(_id, s) { notifies.push(s); }, async clear() {} };
    const watchdog = new Watchdog({ config: cfg, clock, pinger, notifier, log: () => {} });

    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1"); // PAUSED
    clock.advance(5000);
    expect(pinger.calls.length).toBe(0); // paused: no ping
    watchdog.onToolRunning("s1", "call_1"); // still paused (activity ignored while pending)
    watchdog.onToolSettled("s1", "call_1");
    watchdog.onInputResolved("s1", "per_1"); // resume WATCHING
    clock.advance(cfg.stage1Ms);
    clock.advance(cfg.stage2Ms);
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1); // pings after resume
  });
});
```

- [ ] **Step 2: Run + typecheck (devcontainer)** — `devcontainer exec --workspace-folder . bun test tests/stress.test.ts && devcontainer exec --workspace-folder . bun run typecheck` → PASS / clean.

- [ ] **Step 3: Full suite (devcontainer)** — all pass.

- [ ] **Step 4: Commit + Push + Draft PR (host)**

```bash
git add tests/stress.test.ts
git commit -m "test(stress): 入力/tool churn と縦統合チェーンを追加"
git push -u origin feature/phase5-task1-stress-integration
gh pr create --draft --base feature/phase5-hardening-telemetry__base \
  --title "test(stress): 統合ハードニング" \
  --body "派生元: feature/phase5-hardening-telemetry__base (Base) / 増分 ≤200 LOC / tests PASS"
```

- [ ] **Step 5: Tick checkboxes + emit completion report.**

### Task 5.2 (OPTIONAL): Telemetry counters

**派生元: Base** (self-contained — `telemetry.ts` + wiring + tests). Skip if telemetry is out of scope (design §6.7 marks it optional).
**Branch:** `feature/phase5-task2-telemetry`

**Files:**
- Modify: `src/telemetry.ts` (add `recordInputWait()`, `recordSteerSuppressed()` to the `Telemetry` interface + collector + snapshot)
- Modify: `src/watchdog.ts` (call `recordInputWait` in `onInputRequested` first-pending; `recordSteerSuppressed` in the gate)
- Modify: `tests/telemetry.test.ts`, `tests/watchdog.test.ts`

- [ ] **Step 1: Read `src/telemetry.ts` and `tests/telemetry.test.ts`** to match the existing counter pattern, then add `inputWaits`/`steerSuppressedByTool` counters mirroring `recordHangup` etc.
- [ ] **Step 2: Write failing tests** for the two new counters (collector increments + snapshot fields).
- [ ] **Step 3: Implement** counters + wire calls in `watchdog.ts` (first-pending in `onInputRequested`; inside the steer-suppression gate first-gate branch).
- [ ] **Step 4: Run tests + typecheck (devcontainer)** → PASS / clean.
- [ ] **Step 5: Full suite (devcontainer)** → all pass.
- [ ] **Step 6: Commit + Push + Draft PR → Phase Base (host)** (`--base feature/phase5-hardening-telemetry__base`).
- [ ] **Step 7: Tick checkboxes + emit completion report.**

---

## Acceptance Verification (design §10) — run after Phase 4 (and 5)

Run in the devcontainer unless noted; the final integration check uses a real terminal.

- [ ] permission/question pending → ping suppressed + waiting notification; `*.replied` resumes. (Tasks 3.1–3.3 tests)
- [ ] stage2 with a running tool → no steer; resumes after settle. (Task 4.1 tests)
- [ ] hang injection uses `delivery:"steer"`; legacy fallback on throw. (Task 2.1 tests)
- [ ] `message.part.delta` full JSON not logged. (Task 1.2 tests)
- [ ] new events absent → unchanged behavior, never crashes. (existing smoke + Zero-Crash try/catch)
- [ ] all existing tests pass (`devcontainer exec --workspace-folder . bun test` → 130 + new tests).
- [ ] **Manual integration QA (host + devcontainer):** `devcontainer exec --workspace-folder . bun run build`, install the built `dist/index.js` + `package.json` into `~/.config/opencode/plugins/akane/`, run an OpenCode session under tmux, and confirm: (a) a permission prompt turns the tmux status cyan and no ping fires; (b) replying clears it; (c) a long `bash` tool does not get interrupted at stage2 (status goes red, no steer). Use `interactive_bash` (tmux) to drive and read the rendered output.

---

## Self-Review (writing-plans)

- **Spec coverage:** §6.1 watchdog (Tasks 3.2/4.1/4.3) · §6.2 index signal layer (1.2/1.3/3.3/4.2/4.3) · §6.3 pinger steer (2.1) · §6.4 notifier waiting (3.1) · §6.5 config (1.1) · §6.6 logging (1.2) · §6.7 telemetry (5.2, optional). §7 edge cases (PAUSED guard, PAUSED×retry, tombstone, arm-lock bypass, delta self-ping) covered in 3.2/4.3/3.3/1.3. §9 tests mapped per file. §10 acceptance section above.
- **Placeholders:** none — every code step shows full code; only the optional 5.2 references reading `telemetry.ts` first (it is gated as optional and instructs reading the existing pattern before writing, by design).
- **Type consistency:** `DeliveryMode` (config) reused in pinger; `NotifierStage` extended once; `SessionEntry.pendingRequests` (Phase 3) and `runningTools` (Phase 4) added additively and preserved in `armOrReset`; method names `onInputRequested/onInputResolved/onToolRunning/onToolSettled/onStatusRetry/onStatusActive` used consistently between watchdog impl and index routing.
