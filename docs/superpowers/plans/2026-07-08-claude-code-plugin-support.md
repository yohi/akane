# akane Claude Code プラグイン対応 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 既存 akane コア（`src/watchdog.ts` 等）を共有したまま、akane を Claude Code プラグイン（短命 hooks センサー + 常駐 monitor 頭脳）としても動作させる新モジュール群 `src/claude/` とマニフェスト・配布ワークフローを追加する。

**Architecture:** Claude Code の各イベントで起動する短命 CLI（`dist/claude/hook.js`）が stdin JSON を正規化イベント `AkaneClaudeEvent` に変換し `<stateDir>/.akane/<sessionId>.ndjson` へ追記（センサー）。プラグイン有効時に自動起動される常駐プロセス（`dist/claude/monitor.js`）が ndjson を tail し、既存 `Watchdog` 状態機械へ投入してタイマーで沈黙を検知（頭脳）。Ping は monitor の stdout 1 行として出力され Claude Code が通知配信する。両プロセスは決定論的な `stateDir` 解決で同一の一方向 IPC ファイルを共有する。OpenCode 版（`src/index.ts`・TUI）と既存 202 テストは一切改変しない。

**Tech Stack:** TypeScript (strict) / Bun 1.3+（`bun test`・`bun run typecheck`・`bun run build`）/ Bun バンドラ（`target: "node"`）/ tmux・`notify-send`・`osascript`（既存 Notifier）/ Claude Code hooks + monitors / GitHub Actions → Bitbucket 配布。

## Global Constraints

これらはプロジェクト全体の要件であり、全タスクの要件に暗黙的に含まれる。値は SPEC からの逐語コピー。

- **OpenCode 版非改変**: `src/index.ts`・`src/tui*.ts(x)`・既存 202 テストは一切変更しない（SPEC §1.3・AC #12）。新規追加のみ。
- **ランタイム**: monitor / hook は `node` 実行（`target: "node"` でバンドル、`external: ["node:fs", "node:path"]`）。利用者マシンに bun 不要（SPEC §7.3）。
- **stdout 規律（絶対制約）**: monitor の stdout は「Ping/通知として意図した行のみ」。デバッグ・テレメトリ・要約ログは全て stderr / ログファイルへ（SPEC §6.4・AC #10）。monitor の logger は stdout を使わない。
- **Zero-Crash**: hooks（短命）は全処理を try/catch し**常に exit 0**、ターン/ツールを block しない（SPEC §8.1・AC #7）。monitor（常駐）は per-event try/catch で 1 イベント失敗が全体を止めない。
- **stateDir 解決順（優先順位固定）**: 1) `AKANE_STATE_DIR` 2) `XDG_STATE_HOME/akane` 3) `$HOME/.local/state/akane`（SPEC §4.3）。
- **events パス**: `<stateDir>/.akane/<sessionId>.ndjson`（セッション単位・append-only、アトミック追記）（SPEC §4.3）。
- **Atomic 書込**: 共有状態・ロック（および任意の read-offset）は一時ファイル（`.tmp`）へ書込後 `fs.renameSync` で置換（SPEC §8.2・§3.5）。events 本体は追記のみで書き換えない。
- **Late-event tombstone（FIFO 10,000）**: 既存 `Watchdog` 内 `stoppedSessions` をそのまま流用（SPEC §8.2）。
- **Secure logging / masking**: `sessionId` は先頭 4 文字のみ（`xxxx***`）、エラーは 30 文字で truncate。ユーザ入力・通知本文を生ログしない（SPEC §8.2・§3.7）。
- **Raw payload logging 禁止**: `AKANE_DEBUG=true` でも Claude hook stdin の raw JSON、ユーザープロンプト、通知本文、コマンド全文、未 scrub の例外文字列は出力しない。ログ可能なのは event 名、field 名一覧、redacted metadata、30 文字 truncate 済み error のみ。
- **No shell injection**: 外部コマンドは配列引数（既存 Notifier をそのまま利用）（SPEC §8.2）。
- **No absolute paths**: `plugin.json`/`monitors.json` は `${CLAUDE_PLUGIN_ROOT}` 相対、events は stateDir 相対（SPEC §8.2）。
- **Debug log gating**: 追加デバッグログは `AKANE_DEBUG === "true"` のときのみ出力（SPEC §8.2・§3.7）。
- **Color validation**: 既存の厳格 hex 検証（`/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/`）を再利用（新規に色を導入しない）（SPEC §8.2）。
- **テストランナー**: `bun test`（組み込み）のみ。追加ランナー無し（SPEC §9）。
- **バージョン**: `.claude-plugin/plugin.json` の `version` は `package.json`（現在 `1.5.1`）と一致（SPEC §7.2）。

---

## File Structure

新規モジュールは全て `src/claude/` 配下。各ファイルは単一責務・DI で単体テスト可能に保つ（既存設計規律を踏襲）。純粋ロジックと `process` IO を分離するため、CLI エントリは薄い `*-main.ts` に切り出す。

| ファイル | 区分 | 責務 |
|---|---|---|
| `src/claude/event-types.ts` | 新規 | 正規化イベント型 `AkaneClaudeEvent` と型ガード `isAkaneClaudeEvent`。 |
| `src/claude/state-dir.ts` | 新規 | `stateDir` 決定論的解決、events パス生成、`sessionId` サニタイズ（パストラバーサル防止）。 |
| `src/claude/config.ts` | 新規 | `AKANE_*` env → 既存 `OPENCODE_WATCHDOG_*` env へ写像し `resolveConfig` を流用。 |
| `src/claude/event-log.ts` | 新規 | 一方向 IPC：`appendEvent`（hook 側追記）＋ `EventTailer`（monitor 側 tail・破損行スキップ・read-offset。アクティブファイルは非 rewrite）。 |
| `src/claude/event-store.ts` | 新規 | ディスク衛生：`TombstoneStore`（永続化）＋ `deleteSessionLog` ＋ `sweepOrphans`。 |
| `src/claude/pinger.ts` | 新規 | `ClaudeCodeAdapter`（`Pinger` 実装 = stdout へ Ping 1 行）。stdout 規律。 |
| `src/claude/event-map.ts` | 新規 | 正規化イベント → `Watchdog` メソッド dispatch（PAUSED 解除の簡略化含む）。 |
| `src/claude/hook.ts` | 新規 | `runHook`/`normalizeEvent`：CC stdin JSON → 正規化 → 追記（純粋・例外内包）。 |
| `src/claude/hook-main.ts` | 新規 | hook CLI エントリ（stdin 読取 → `runHook` → 常に exit 0）。 |
| `src/claude/lock.ts` | 新規 | `MonitorLock`：単一起動保証（PID＋起動時刻＋ハートビート、stale 奪取、退場整合チェック）。 |
| `src/claude/monitor.ts` | 新規 | `ClaudeMonitor` ファクトリ＋poll ループ、lock ガード付き Notifier/Pinger、session_end 掃除。 |
| `src/claude/monitor-main.ts` | 新規 | monitor 常駐エントリ（実依存を組立て、lock 取得、シグナル処理）。 |
| `build.ts` | 拡張 | `buildClaudeHook()` / `buildClaudeMonitor()` を追加し `dist/claude/` へ出力。既存 export 化。 |
| `.claude-plugin/plugin.json` | 新規 | Claude Code マニフェスト（hooks インライン＋userConfig）。SPEC §7.6 でユーザ承認済み成果物。 |
| `monitors/monitors.json` | 新規 | 常駐 monitor 宣言。SPEC §7.6 でユーザ承認済み成果物。 |
| `.github/workflows/deploy-claude-to-bitbucket.yml` | 新規 | nexus パターンの bun 化配布ワークフロー。 |
| `src/index.ts` / `src/tui*.ts(x)` | 無改変 | — |

**依存グラフ（実装順の目安）**: Task 1–9 は相互に概ね独立（`event-types` と `state-dir` を土台に各葉モジュール）。Task 10（monitor）が全体を統合。Task 11–14 は梱包。Task 15 は実機検証。

---

## Task 1: `event-types.ts`（正規化イベント型 + 型ガード）

**Files:**
- Create: `src/claude/event-types.ts`
- Test: `tests/claude/event-types.test.ts`

**Interfaces:**
- Consumes: `HangReason`（`src/errors.ts` の `type HangReason = "rate_limit" | "provider_timeout" | "unknown"`）。
- Produces:
  - `type AkaneClaudeEventKind = "user_message" | "activity" | "tool_running" | "tool_settled" | "input_requested" | "idle" | "turn_end" | "error" | "session_start" | "session_end"`
  - `interface AkaneClaudeEvent { kind: AkaneClaudeEventKind; sessionId: string; ts: number; agentName?: string; callId?: string; requestId?: string; errorReason?: HangReason; }`
  - `function isAkaneClaudeEvent(value: unknown): value is AkaneClaudeEvent`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { isAkaneClaudeEvent, type AkaneClaudeEvent } from "../../src/claude/event-types";

describe("isAkaneClaudeEvent", () => {
  test("accepts a minimal valid event", () => {
    const e: AkaneClaudeEvent = { kind: "activity", sessionId: "s1", ts: 100 };
    expect(isAkaneClaudeEvent(e)).toBe(true);
  });

  test("accepts an event with all optional fields", () => {
    const e = { kind: "error", sessionId: "s1", ts: 1, agentName: "a", callId: "c", requestId: "r", errorReason: "rate_limit" };
    expect(isAkaneClaudeEvent(e)).toBe(true);
  });

  test("rejects unknown kind", () => {
    expect(isAkaneClaudeEvent({ kind: "boom", sessionId: "s1", ts: 1 })).toBe(false);
  });

  test("rejects empty sessionId", () => {
    expect(isAkaneClaudeEvent({ kind: "activity", sessionId: "", ts: 1 })).toBe(false);
  });

  test("rejects non-number ts", () => {
    expect(isAkaneClaudeEvent({ kind: "activity", sessionId: "s1", ts: "1" })).toBe(false);
  });

  test("rejects invalid errorReason", () => {
    expect(isAkaneClaudeEvent({ kind: "error", sessionId: "s1", ts: 1, errorReason: "nope" })).toBe(false);
  });

  test("rejects non-object", () => {
    expect(isAkaneClaudeEvent(null)).toBe(false);
    expect(isAkaneClaudeEvent("x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/event-types.test.ts`
Expected: FAIL — `Cannot find module '../../src/claude/event-types'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { HangReason } from "../errors";

export type AkaneClaudeEventKind =
  | "user_message"
  | "activity"
  | "tool_running"
  | "tool_settled"
  | "input_requested"
  | "idle"
  | "turn_end"
  | "error"
  | "session_start"
  | "session_end";

export interface AkaneClaudeEvent {
  kind: AkaneClaudeEventKind;
  sessionId: string;
  ts: number;
  agentName?: string;
  callId?: string;
  requestId?: string;
  errorReason?: HangReason;
}

const EVENT_KINDS: ReadonlySet<string> = new Set<AkaneClaudeEventKind>([
  "user_message",
  "activity",
  "tool_running",
  "tool_settled",
  "input_requested",
  "idle",
  "turn_end",
  "error",
  "session_start",
  "session_end",
]);

const HANG_REASONS: ReadonlySet<string> = new Set<HangReason>([
  "rate_limit",
  "provider_timeout",
  "unknown",
]);

export function isAkaneClaudeEvent(value: unknown): value is AkaneClaudeEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<AkaneClaudeEvent>;
  return (
    typeof e.kind === "string" &&
    EVENT_KINDS.has(e.kind) &&
    typeof e.sessionId === "string" &&
    e.sessionId.length > 0 &&
    typeof e.ts === "number" &&
    Number.isFinite(e.ts) &&
    (e.agentName === undefined || typeof e.agentName === "string") &&
    (e.callId === undefined || typeof e.callId === "string") &&
    (e.requestId === undefined || typeof e.requestId === "string") &&
    (e.errorReason === undefined || (typeof e.errorReason === "string" && HANG_REASONS.has(e.errorReason)))
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/claude/event-types.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/claude/event-types.ts tests/claude/event-types.test.ts
git commit -m "feat(claude): 正規化イベント型 AkaneClaudeEvent と型ガードを追加"
```

---

## Task 2: `state-dir.ts`（stateDir 解決 + events パス + サニタイズ）

**Files:**
- Create: `src/claude/state-dir.ts`
- Test: `tests/claude/state-dir.test.ts`

**Interfaces:**
- Consumes: `node:path`。
- Produces:
  - `function resolveStateDir(env: Record<string, string | undefined>): string`（優先順位: `AKANE_STATE_DIR` > `XDG_STATE_HOME/akane` > `$HOME/.local/state/akane`。`HOME` 未設定時は `"."`（cwd 相対）ではなく `os.homedir()` で決定論的に解決し、§4.3 の hook/monitor 同一 stateDir 不変条件を担保）
  - `function eventsDir(stateDir: string): string`（`<stateDir>/.akane`）
  - `function sanitizeSessionId(sessionId: string): string`（`[^A-Za-z0-9_.-]` を `_` 置換）
  - `function eventsPathFor(stateDir: string, sessionId: string): string`（`<stateDir>/.akane/<sanitized>.ndjson`）

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { resolveStateDir, eventsDir, sanitizeSessionId, eventsPathFor } from "../../src/claude/state-dir";
import * as os from "node:os";
import * as path from "node:path";

describe("resolveStateDir", () => {
  test("AKANE_STATE_DIR wins", () => {
    expect(resolveStateDir({ AKANE_STATE_DIR: "/x/state", XDG_STATE_HOME: "/y", HOME: "/h" })).toBe("/x/state");
  });

  test("falls back to XDG_STATE_HOME/akane", () => {
    expect(resolveStateDir({ XDG_STATE_HOME: "/y", HOME: "/h" })).toBe("/y/akane");
  });

  test("falls back to HOME/.local/state/akane", () => {
    expect(resolveStateDir({ HOME: "/h" })).toBe("/h/.local/state/akane");
  });

  test("ignores blank AKANE_STATE_DIR", () => {
    expect(resolveStateDir({ AKANE_STATE_DIR: "  ", XDG_STATE_HOME: "/y" })).toBe("/y/akane");
  });

  test("HOME 未設定でも cwd 相対でなく決定論的な絶対パスに解決する (SPEC §4.3)", () => {
    const dir = resolveStateDir({});
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(path.join(os.homedir(), ".local", "state", "akane"));
  });
});

describe("sanitizeSessionId", () => {
  test("neutralizes path separators and traversal", () => {
    expect(sanitizeSessionId("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeSessionId("a/b")).toBe("a_b");
  });

  test("keeps safe uuid-like ids", () => {
    expect(sanitizeSessionId("ses_01AB-cd.9")).toBe("ses_01AB-cd.9");
  });
});

describe("eventsPathFor", () => {
  test("composes under <stateDir>/.akane and stays inside it", () => {
    expect(eventsDir("/s")).toBe("/s/.akane");
    expect(eventsPathFor("/s", "abc")).toBe("/s/.akane/abc.ndjson");
    const p = eventsPathFor("/s", "../evil");
    expect(p.startsWith("/s/.akane/")).toBe(true);
    expect(p.includes("/../")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/state-dir.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
import * as path from "node:path";
import * as os from "node:os";

const STATE_SUBDIR = ".akane";

export function resolveStateDir(env: Record<string, string | undefined>): string {
  const explicit = env.AKANE_STATE_DIR;
  if (explicit && explicit.trim().length > 0) return explicit;
  const xdg = env.XDG_STATE_HOME;
  if (xdg && xdg.trim().length > 0) return path.join(xdg, "akane");
  // HOME 未設定でも cwd 相対 "." にフォールバックしない: hook/monitor は別プロセスで cwd 一致の
  // 保証がなく、相対 stateDir は §4.3「決定論的に同一の stateDir」を破壊し IPC (.ndjson) が食い違う。
  // os.homedir() は同一 uid で決定論的に解決される。
  const home = env.HOME && env.HOME.trim().length > 0 ? env.HOME : os.homedir();
  return path.join(home, ".local", "state", "akane");
}

export function eventsDir(stateDir: string): string {
  return path.join(stateDir, STATE_SUBDIR);
}

// Claude Code stdin is untrusted. Replacing every non-safe char with "_" keeps
// the ndjson file strictly inside eventsDir (SPEC §8.2 path safety). Distinct
// raw ids sharing only unsafe chars may collide; acceptable given ids are
// uuid-like in practice.
export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function eventsPathFor(stateDir: string, sessionId: string): string {
  return path.join(eventsDir(stateDir), `${sanitizeSessionId(sessionId)}.ndjson`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/claude/state-dir.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/claude/state-dir.ts tests/claude/state-dir.test.ts
git commit -m "feat(claude): stateDir 解決と events パス生成・sessionId サニタイズを追加"
```

---

## Task 3: `config.ts`（Claude Code 設定解決 = AKANE_* env 写像）

**Files:**
- Create: `src/claude/config.ts`
- Test: `tests/claude/config.test.ts`

**Interfaces:**
- Consumes: `resolveConfig`, `WatchdogConfig`, `WarnFn`（`src/config.ts`）。
- Produces:
  - `function resolveClaudeConfig(env: Record<string, string | undefined>, warn?: WarnFn): WatchdogConfig`
  - env 写像契約（本タスクで確定する AKANE_* 名。manifest 側の env 受け渡しは §10-2 実機検証で確認）:
    `AKANE_ENABLED`→`OPENCODE_WATCHDOG_ENABLED`, `AKANE_STAGE1_MS`→`OPENCODE_WATCHDOG_STAGE1_MS`, `AKANE_STAGE2_MS`→`OPENCODE_WATCHDOG_STAGE2_MS`, `AKANE_MAX_PINGS`→`OPENCODE_WATCHDOG_MAX_PINGS`, `AKANE_MAX_TOOL_GATE_CYCLES`→`OPENCODE_WATCHDOG_MAX_TOOL_GATE_CYCLES`, `AKANE_NOTIFIER_TYPE`→`OPENCODE_WATCHDOG_NOTIFIER_TYPE`, `AKANE_SUPPRESS_PING_WHILE_TOOL`→`OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL`, `AKANE_PAUSE_ON_INPUT`→`OPENCODE_WATCHDOG_PAUSE_ON_INPUT`, `AKANE_NOTIFY_WAITING`→`OPENCODE_WATCHDOG_NOTIFY_WAITING`, `AKANE_DELIVERY`→`OPENCODE_WATCHDOG_DELIVERY`, `AKANE_VERBOSE`→`OPENCODE_WATCHDOG_VERBOSE`。

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { resolveClaudeConfig } from "../../src/claude/config";
import { DEFAULT_CONFIG } from "../../src/config";

describe("resolveClaudeConfig", () => {
  test("returns defaults for empty env", () => {
    const cfg = resolveClaudeConfig({});
    expect(cfg.stage1Ms).toBe(180_000);
    expect(cfg.maxPings).toBe(1);
    expect(cfg.notifierType).toBe("tmux");
  });

  test("maps AKANE_* env onto the OPENCODE_WATCHDOG_* contract", () => {
    const cfg = resolveClaudeConfig({
      AKANE_STAGE1_MS: "30000",
      AKANE_STAGE2_MS: "45000",
      AKANE_MAX_PINGS: "2",
      AKANE_NOTIFIER_TYPE: "os",
    });
    expect(cfg.stage1Ms).toBe(30_000);
    expect(cfg.stage2Ms).toBe(45_000);
    expect(cfg.maxPings).toBe(2);
    expect(cfg.notifierType).toBe("os");
  });

  test("AKANE_ENABLED=false disables", () => {
    expect(resolveClaudeConfig({ AKANE_ENABLED: "false" }).enabled).toBe(false);
  });

  test("invalid value warns and falls back to default", () => {
    const warnings: string[] = [];
    const cfg = resolveClaudeConfig({ AKANE_MAX_PINGS: "0" }, (m) => warnings.push(m));
    expect(cfg.maxPings).toBe(DEFAULT_CONFIG.maxPings);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { resolveConfig, type WatchdogConfig, type WarnFn } from "../config";

// Claude Code delivers userConfig values as AKANE_* env vars (SPEC §7.2). We
// translate them onto the existing OPENCODE_WATCHDOG_* env contract so the
// battle-tested resolveConfig validation/precedence is reused verbatim
// (SPEC §4.2 config.ts row).
const ENV_MAP: ReadonlyArray<readonly [string, string]> = [
  ["AKANE_ENABLED", "OPENCODE_WATCHDOG_ENABLED"],
  ["AKANE_STAGE1_MS", "OPENCODE_WATCHDOG_STAGE1_MS"],
  ["AKANE_STAGE2_MS", "OPENCODE_WATCHDOG_STAGE2_MS"],
  ["AKANE_MAX_PINGS", "OPENCODE_WATCHDOG_MAX_PINGS"],
  ["AKANE_MAX_TOOL_GATE_CYCLES", "OPENCODE_WATCHDOG_MAX_TOOL_GATE_CYCLES"],
  ["AKANE_NOTIFIER_TYPE", "OPENCODE_WATCHDOG_NOTIFIER_TYPE"],
  ["AKANE_SUPPRESS_PING_WHILE_TOOL", "OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL"],
  ["AKANE_PAUSE_ON_INPUT", "OPENCODE_WATCHDOG_PAUSE_ON_INPUT"],
  ["AKANE_NOTIFY_WAITING", "OPENCODE_WATCHDOG_NOTIFY_WAITING"],
  ["AKANE_DELIVERY", "OPENCODE_WATCHDOG_DELIVERY"],
  ["AKANE_VERBOSE", "OPENCODE_WATCHDOG_VERBOSE"],
];

export function resolveClaudeConfig(
  env: Record<string, string | undefined>,
  warn: WarnFn = (msg) => console.warn(msg),
): WatchdogConfig {
  const mappedEnv: Record<string, string | undefined> = {};
  for (const [claudeKey, opencodeKey] of ENV_MAP) {
    const value = env[claudeKey];
    if (value !== undefined) mappedEnv[opencodeKey] = value;
  }
  return resolveConfig({ env: mappedEnv }, warn);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/claude/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/claude/config.ts tests/claude/config.test.ts
git commit -m "feat(claude): AKANE_* env を resolveConfig へ写像する設定解決を追加"
```

---

## Task 4: `event-log.ts`（一方向 IPC: 追記 + tail + read-offset）

**Files:**
- Create: `src/claude/event-log.ts`
- Test: `tests/claude/event-log.test.ts`

**Interfaces:**
- Consumes: `AkaneClaudeEvent`, `isAkaneClaudeEvent`（`event-types.ts`）；`sanitizeSessionId`（`state-dir.ts`）；`node:fs`, `node:path`。
- Produces:
  - `function appendEvent(filePath: string, event: AkaneClaudeEvent): void`（親 dir 作成 + 1 行 NDJSON アトミック追記）
  - `class EventTailer`
    - `constructor(dir: string)`（dir = `eventsDir(stateDir)`）
    - `poll(): AkaneClaudeEvent[]`（dir 内 `*.ndjson` を名前順に走査、各ファイルの未読完全行のみ返す。破損行スキップ、末尾の不完全行は保留）
    - `forget(sessionId: string): void`（当該ファイルの読取オフセットを破棄）

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendEvent, EventTailer } from "../../src/claude/event-log";
import type { AkaneClaudeEvent } from "../../src/claude/event-types";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-evlog-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function ev(kind: AkaneClaudeEvent["kind"], sessionId: string, ts = 1): AkaneClaudeEvent {
  return { kind, sessionId, ts };
}

describe("appendEvent + EventTailer", () => {
  test("append then poll returns the event once", () => {
    const file = path.join(dir, "s1.ndjson");
    appendEvent(file, ev("activity", "s1"));
    const tailer = new EventTailer(dir);
    const first = tailer.poll();
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe("activity");
    expect(first[0]!.sessionId).toBe("s1");
    // Second poll sees nothing new (offset advanced).
    expect(tailer.poll()).toHaveLength(0);
  });

  test("tails only newly appended complete lines", () => {
    const file = path.join(dir, "s1.ndjson");
    const tailer = new EventTailer(dir);
    appendEvent(file, ev("activity", "s1"));
    expect(tailer.poll()).toHaveLength(1);
    appendEvent(file, ev("turn_end", "s1"));
    const second = tailer.poll();
    expect(second).toHaveLength(1);
    expect(second[0]!.kind).toBe("turn_end");
  });

  test("skips corrupt lines but keeps valid ones", () => {
    const file = path.join(dir, "s1.ndjson");
    fs.writeFileSync(file, `{"kind":"activity","sessionId":"s1","ts":1}\nNOT-JSON\n{"kind":"idle","sessionId":"s1","ts":2}\n`);
    const tailer = new EventTailer(dir);
    const events = tailer.poll();
    expect(events.map((e) => e.kind)).toEqual(["activity", "idle"]);
  });

  test("does not emit a partial trailing line until completed", () => {
    const file = path.join(dir, "s1.ndjson");
    fs.writeFileSync(file, `{"kind":"activity","sessionId":"s1","ts":1}\n{"kind":"idle"`);
    const tailer = new EventTailer(dir);
    expect(tailer.poll().map((e) => e.kind)).toEqual(["activity"]);
    fs.appendFileSync(file, `,"sessionId":"s1","ts":2}\n`);
    expect(tailer.poll().map((e) => e.kind)).toEqual(["idle"]);
  });

  test("poll on missing dir returns empty", () => {
    const tailer = new EventTailer(path.join(dir, "does-not-exist"));
    expect(tailer.poll()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/event-log.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import { isAkaneClaudeEvent, type AkaneClaudeEvent } from "./event-types";
import { sanitizeSessionId } from "./state-dir";

const NEWLINE = 0x0a;

export function appendEvent(filePath: string, event: AkaneClaudeEvent): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Single write of one line. POSIX append (O_APPEND) is atomic for small
  // writes, satisfying the one-way IPC append requirement (SPEC §3-3/§8.2).
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
}

interface FileCursor {
  offset: number;
}

export class EventTailer {
  private readonly cursors = new Map<string, FileCursor>();

  constructor(private readonly dir: string) {}

  poll(): AkaneClaudeEvent[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".ndjson")).sort();
    } catch {
      return []; // dir not created yet
    }
    const out: AkaneClaudeEvent[] = [];
    for (const name of names) {
      out.push(...this.readFile(name));
    }
    return out;
  }

  private readFile(name: string): AkaneClaudeEvent[] {
    const filePath = path.join(this.dir, name);
    let content: Buffer;
    try {
      content = fs.readFileSync(filePath);
    } catch {
      this.cursors.delete(name);
      return [];
    }
    const cursor = this.cursors.get(name) ?? { offset: 0 };
    if (content.length < cursor.offset) cursor.offset = 0; // truncated / rotated
    const slice = content.subarray(cursor.offset);
    const lastNl = slice.lastIndexOf(NEWLINE);
    if (lastNl === -1) {
      this.cursors.set(name, cursor); // no complete line yet
      return [];
    }
    const complete = slice.subarray(0, lastNl).toString("utf8");
    cursor.offset += lastNl + 1;
    this.cursors.set(name, cursor);
    const events: AkaneClaudeEvent[] = [];
    for (const line of complete.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isAkaneClaudeEvent(parsed)) events.push(parsed);
      } catch {
        // Skip corrupt / partial line (SPEC §8.1 robustness).
      }
    }
    return events;
  }

  forget(sessionId: string): void {
    this.cursors.delete(`${sanitizeSessionId(sessionId)}.ndjson`);
  }

}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/claude/event-log.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/claude/event-log.ts tests/claude/event-log.test.ts
git commit -m "feat(claude): events.ndjson の追記・tail(EventTailer, read-offset)を追加"
```

---

## Task 5: `event-store.ts`（tombstone 永続化 + 削除 + 孤児掃除）

**Files:**
- Create: `src/claude/event-store.ts`
- Create: `src/claude/safe-error.ts`（共有エラー秘匿ヘルパ。`event-store.ts`・`monitor.ts` が import）
- Test: `tests/claude/event-store.test.ts`

**Interfaces:**
- Consumes: `eventsPathFor`, `sanitizeSessionId`（`state-dir.ts`）；`safeError`（`safe-error.ts`）；`node:fs`, `node:path`。
- Produces:
  - `function deleteSessionLog(stateDir: string, sessionId: string): void`
  - `class TombstoneStore`（`<eventsDir>/tombstones.json` へ FIFO 10,000 上限で永続化）
    - `constructor(dir: string)`（dir = `eventsDir(stateDir)`）
    - `has(sessionId: string): boolean`
    - `record(sessionId: string): void`
  - `interface SweepDeps { now: number; ttlMs: number; isTombstoned: (fileStem: string) => boolean }`
  - `function sweepOrphans(dir: string, deps: SweepDeps): string[]`（tombstone 済み or mtime 超過の `*.ndjson` を削除、削除した stem を返す）
  - （`safe-error.ts`）`function safeError(err: unknown): string`（共有純関数。`err.message`（非 Error は `String(err)`）を 30 字 truncate + `... (redacted)` 付与。SPEC/AGENTS.md §3.7 秘匿不変条件の単一実装。`event-store.ts`・`monitor.ts` が import）

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteSessionLog, TombstoneStore, sweepOrphans } from "../../src/claude/event-store";
import { eventsDir, eventsPathFor } from "../../src/claude/state-dir";

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-store-"));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("deleteSessionLog", () => {
  test("removes the session ndjson and tolerates absence", () => {
    const file = eventsPathFor(stateDir, "s1");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x\n");
    deleteSessionLog(stateDir, "s1");
    expect(fs.existsSync(file)).toBe(false);
    expect(() => deleteSessionLog(stateDir, "s1")).not.toThrow(); // idempotent
  });
});

describe("TombstoneStore", () => {
  test("records and persists across instances", () => {
    const dir = eventsDir(stateDir);
    const a = new TombstoneStore(dir);
    a.record("s1");
    expect(a.has("s1")).toBe(true);
    const b = new TombstoneStore(dir);
    expect(b.has("s1")).toBe(true);
    expect(b.has("s2")).toBe(false);
  });
});

describe("sweepOrphans", () => {
  test("deletes tombstoned files and TTL-expired files, keeps fresh ones", () => {
    const dir = eventsDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "dead.ndjson"), "x\n");
    fs.writeFileSync(path.join(dir, "old.ndjson"), "x\n");
    fs.writeFileSync(path.join(dir, "fresh.ndjson"), "x\n");
    const now = 1_000_000_000_000;
    // Backdate "old" beyond the TTL.
    fs.utimesSync(path.join(dir, "old.ndjson"), new Date(now - 100_000_000), new Date(now - 100_000_000));
    fs.utimesSync(path.join(dir, "fresh.ndjson"), new Date(now), new Date(now));
    fs.utimesSync(path.join(dir, "dead.ndjson"), new Date(now), new Date(now));
    const swept = sweepOrphans(dir, {
      now,
      ttlMs: 86_400_000,
      isTombstoned: (stem) => stem === "dead",
    });
    expect(swept.sort()).toEqual(["dead", "old"]);
    expect(fs.existsSync(path.join(dir, "fresh.ndjson"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "dead.ndjson"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "old.ndjson"))).toBe(false);
  });

  test("returns empty for a missing dir", () => {
    expect(sweepOrphans(path.join(stateDir, "nope"), { now: 0, ttlMs: 1, isTombstoned: () => false })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/event-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/claude/safe-error.ts`（共有ヘルパ。`event-store.ts`・`monitor.ts` が import する単一実装）:

```typescript
/**
 * Redacts + truncates an error into a log-safe string. The 30-char cap and the
 * "... (redacted)" suffix are the SPEC / AGENTS.md §3.7 secrecy invariant, kept
 * as a single implementation so the behavior cannot drift between call sites.
 */
export function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 30 ? `${msg.slice(0, 30)}... (redacted)` : msg;
}
```

`src/claude/event-store.ts`:
```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import { eventsPathFor, sanitizeSessionId } from "./state-dir";
import { safeError } from "./safe-error";

const TOMBSTONE_FILE = "tombstones.json";
const TOMBSTONE_CAPACITY = 10_000;
const NDJSON_EXT = ".ndjson";

export function deleteSessionLog(stateDir: string, sessionId: string): void {
  try {
    fs.rmSync(eventsPathFor(stateDir, sessionId));
  } catch {
    // Already gone (SessionEnd race / prior sweep). Tolerated.
  }
}

export class TombstoneStore {
  private readonly filePath: string;
  private ids: string[];

  constructor(private readonly dir: string) {
    this.filePath = path.join(dir, TOMBSTONE_FILE);
    this.ids = this.load();
  }

  private load(): string[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed as string[];
      }
    } catch {
      // Missing / corrupt — start empty.
    }
    return [];
  }

  has(sessionId: string): boolean {
    return this.ids.includes(sanitizeSessionId(sessionId));
  }

  record(sessionId: string): void {
    const id = sanitizeSessionId(sessionId);
    if (this.ids.includes(id)) return;
    this.ids.push(id);
    if (this.ids.length > TOMBSTONE_CAPACITY) {
      this.ids = this.ids.slice(-TOMBSTONE_CAPACITY);
    }
    this.flush();
  }

  private flush(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.ids));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn(`[akane] tombstone flush failed: ${safeError(err)}`);
    }
  }
}

export interface SweepDeps {
  now: number;
  ttlMs: number;
  isTombstoned: (fileStem: string) => boolean;
}

export function sweepOrphans(dir: string, deps: SweepDeps): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(NDJSON_EXT));
  } catch {
    return [];
  }
  const swept: string[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    const stem = name.slice(0, -NDJSON_EXT.length);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    const expired = deps.now - mtimeMs > deps.ttlMs;
    if (deps.isTombstoned(stem) || expired) {
      try {
        fs.rmSync(filePath);
        swept.push(stem);
      } catch {
        // Race with another deleter — ignore.
      }
    }
  }
  return swept;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/claude/event-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/claude/safe-error.ts src/claude/event-store.ts tests/claude/event-store.test.ts
git commit -m "feat(claude): tombstone 永続化・セッションログ削除・孤児掃除を追加"
```

---

## Task 6: `pinger.ts`（ClaudeCodeAdapter = stdout へ Ping 1 行）

**Files:**
- Create: `src/claude/pinger.ts`
- Test: `tests/claude/pinger.test.ts`

**Interfaces:**
- Consumes: `buildPingPrompt`, `Pinger`, `PingContext`（`src/pinger.ts`）。
- Produces:
  - `type StdoutWriter = (line: string) => void`
  - `class ClaudeCodeAdapter implements Pinger`
    - `constructor(writeStdout: StdoutWriter, log?: (message: string) => void)`
    - `inject(sessionId: string, message: string, context?: PingContext): Promise<void>`（`buildPingPrompt` で理由付き文を生成、改行除去して stdout に 1 行出力。ログは `log`（=stderr）へ、sessionId マスク・err 30 字 truncate）

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { ClaudeCodeAdapter } from "../../src/claude/pinger";

describe("ClaudeCodeAdapter", () => {
  test("writes exactly one stdout line with the base message", async () => {
    const out: string[] = [];
    const adapter = new ClaudeCodeAdapter((line) => out.push(line));
    await adapter.inject("sess-abc", "ping?");
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("ping?\n");
  });

  test("enriches the message with the Japanese reason (buildPingPrompt)", async () => {
    const out: string[] = [];
    const adapter = new ClaudeCodeAdapter((line) => out.push(line));
    await adapter.inject("sess-abc", "ping?", { reason: "rate_limit" });
    expect(out[0]).toContain("[Watchdog]");
    expect(out[0]).toContain("APIレート制限に到達しました");
  });

  test("collapses embedded newlines so it stays a single stdout line", async () => {
    const out: string[] = [];
    const adapter = new ClaudeCodeAdapter((line) => out.push(line));
    await adapter.inject("sess-abc", "ping?", { reason: "unknown" });
    // Exactly one trailing newline, none in the middle.
    expect(out[0]!.endsWith("\n")).toBe(true);
    expect(out[0]!.slice(0, -1).includes("\n")).toBe(false);
  });

  test("stdout discipline: logs go to the log sink, never to stdout", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    const adapter = new ClaudeCodeAdapter((line) => out.push(line), (m) => logs.push(m));
    await adapter.inject("sess-abcdef", "ping?");
    expect(out).toHaveLength(1); // only the ping line
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join(" ")).toContain("sess***"); // sessionId masked (first 4 chars)
    expect(logs.join(" ")).not.toContain("sess-abcdef");
  });

  test("never throws when the writer throws", async () => {
    const adapter = new ClaudeCodeAdapter(() => {
      throw new Error("pipe closed");
    });
    await expect(adapter.inject("s", "msg")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/pinger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { buildPingPrompt, type Pinger, type PingContext } from "../pinger";

export type StdoutWriter = (line: string) => void;

// Emits the ping as a single stdout line. Claude Code delivers monitor stdout
// lines to the session as notifications (SPEC §6.2). stdout is RESERVED for
// ping/notification lines only — all logs go through `log` (stderr) so the
// monitor's stdout discipline holds (SPEC §6.4).
export class ClaudeCodeAdapter implements Pinger {
  constructor(
    private readonly writeStdout: StdoutWriter,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async inject(sessionId: string, message: string, context?: PingContext): Promise<void> {
    const maskedSessionId = sessionId.length > 4 ? `${sessionId.slice(0, 4)}***` : "***";
    const finalMessage = buildPingPrompt(message, context?.reason);
    try {
      // Strip embedded newlines so the ping is exactly one stdout line.
      this.writeStdout(`${finalMessage.replace(/\r?\n/g, " ")}\n`);
      this.log(`PINGER stdout inject sessionId=${maskedSessionId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const maskedErr = msg.length > 30 ? `${msg.slice(0, 30)}... (redacted)` : msg;
      this.log(`PINGER stdout failed sessionId=${maskedSessionId} err=${maskedErr}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/claude/pinger.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/claude/pinger.ts tests/claude/pinger.test.ts
git commit -m "feat(claude): stdout へ Ping を出力する ClaudeCodeAdapter を追加"
```

---

## Task 7: `event-map.ts`（正規化イベント → Watchdog dispatch）

**Files:**
- Create: `src/claude/event-map.ts`
- Test: `tests/claude/event-map.test.ts`

**Interfaces:**
- Consumes: `AkaneClaudeEvent`（`event-types.ts`）。実 `Watchdog`（`src/watchdog.ts`）は下記 `WatchdogTarget` を構造的に満たす。
- Produces:
  - `interface WatchdogTarget`（使用する Watchdog メソッドの部分集合：`onUserMessage`, `onActivity`, `onToolRunning`, `onToolSettled`, `onInputRequested`, `onInputResolved`, `onSessionCreated`, `noteError`, `stop`）
  - `const CC_PERMISSION_REQUEST_ID = "cc-permission"`
  - `function dispatchEvent(w: WatchdogTarget, e: AkaneClaudeEvent): void`

**設計メモ**: Claude Code には `permission.replied` 相当の明示イベントが無い（SPEC §5.3-2）。そのため `input_requested` で単一の合成 requestId（`CC_PERMISSION_REQUEST_ID`）で PAUSED に入り、次の activity 系イベントでは先に `onInputResolved(sessionId, CC_PERMISSION_REQUEST_ID)` を呼んで PAUSED を解除してから本体を dispatch する（`onInputResolved` は非 PAUSED 時 no-op なので冪等）。`tool_settled` は SPEC §5.1 に合わせ、`callId` がある場合は `onToolSettled` の後に `onActivity` も呼ぶ。`callId` が無い場合は settle 対象が特定できないため、縮退動作として `onActivity` のみ呼んで再アームする。

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { dispatchEvent, CC_PERMISSION_REQUEST_ID, type WatchdogTarget } from "../../src/claude/event-map";
import type { AkaneClaudeEvent } from "../../src/claude/event-types";

type Call = [method: string, ...args: unknown[]];

function recorder(): { w: WatchdogTarget; calls: Call[] } {
  const calls: Call[] = [];
  const w: WatchdogTarget = {
    onUserMessage: (s, m) => calls.push(["onUserMessage", s, m]),
    onActivity: (s, m) => calls.push(["onActivity", s, m]),
    onToolRunning: (s, c) => calls.push(["onToolRunning", s, c]),
    onToolSettled: (s, c) => calls.push(["onToolSettled", s, c]),
    onInputRequested: (s, r) => calls.push(["onInputRequested", s, r]),
    onInputResolved: (s, r) => calls.push(["onInputResolved", s, r]),
    onSessionCreated: (s) => calls.push(["onSessionCreated", s]),
    noteError: (s, r) => calls.push(["noteError", s, r]),
    stop: (s) => calls.push(["stop", s]),
  };
  return { w, calls };
}

function ev(partial: Partial<AkaneClaudeEvent> & Pick<AkaneClaudeEvent, "kind">): AkaneClaudeEvent {
  return { sessionId: "s1", ts: 1, ...partial };
}

describe("dispatchEvent", () => {
  test("user_message -> onUserMessage with agentName", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "user_message", agentName: "a" }));
    expect(calls).toEqual([["onUserMessage", "s1", { agentName: "a" }]]);
  });

  test("activity releases pending permission then re-arms", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "activity", agentName: "a" }));
    expect(calls).toEqual([
      ["onInputResolved", "s1", CC_PERMISSION_REQUEST_ID],
      ["onActivity", "s1", { agentName: "a" }],
    ]);
  });

  test("tool_running with callId releases then tracks the tool", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "tool_running", callId: "c1" }));
    expect(calls).toEqual([
      ["onInputResolved", "s1", CC_PERMISSION_REQUEST_ID],
      ["onToolRunning", "s1", "c1"],
    ]);
  });

  test("tool_running without callId falls back to activity", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "tool_running" }));
    expect(calls).toEqual([
      ["onInputResolved", "s1", CC_PERMISSION_REQUEST_ID],
      ["onActivity", "s1", { agentName: undefined }],
    ]);
  });

  test("tool_settled with callId releases then settles", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "tool_settled", callId: "c1" }));
    expect(calls).toEqual([
      ["onInputResolved", "s1", CC_PERMISSION_REQUEST_ID],
      ["onToolSettled", "s1", "c1"],
      ["onActivity", "s1", { agentName: undefined }],
    ]);
  });

  test("input_requested always uses the synthetic request id", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "input_requested", requestId: "ignored" }));
    expect(calls).toEqual([["onInputRequested", "s1", CC_PERMISSION_REQUEST_ID]]);
  });

  test("idle / turn_end / session_end all stop", () => {
    for (const kind of ["idle", "turn_end", "session_end"] as const) {
      const { w, calls } = recorder();
      dispatchEvent(w, ev({ kind }));
      expect(calls).toEqual([["stop", "s1"]]);
    }
  });

  test("error routes recoverable to noteError, else stop", () => {
    const rec = recorder();
    dispatchEvent(rec.w, ev({ kind: "error", errorReason: "rate_limit" }));
    expect(rec.calls).toEqual([["noteError", "s1", "rate_limit"]]);

    const term = recorder();
    dispatchEvent(term.w, ev({ kind: "error", errorReason: "unknown" }));
    expect(term.calls).toEqual([["stop", "s1"]]);

    const none = recorder();
    dispatchEvent(none.w, ev({ kind: "error" }));
    expect(none.calls).toEqual([["stop", "s1"]]);
  });

  test("session_start -> onSessionCreated", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "session_start" }));
    expect(calls).toEqual([["onSessionCreated", "s1"]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/event-map.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { AkaneClaudeEvent } from "./event-types";

// Structural subset of Watchdog consumed by the dispatcher. The real Watchdog
// (src/watchdog.ts) satisfies this; tests use a recording mock.
export interface WatchdogTarget {
  onUserMessage(sessionId: string, meta?: { agentName?: string }): void;
  onActivity(sessionId: string, meta?: { agentName?: string }): void;
  onToolRunning(sessionId: string, callId: string): void;
  onToolSettled(sessionId: string, callId: string): void;
  onInputRequested(sessionId: string, requestId: string): void;
  onInputResolved(sessionId: string, requestId: string): void;
  onSessionCreated(sessionId: string): void;
  noteError(sessionId: string, reason: "rate_limit" | "provider_timeout" | "unknown"): void;
  stop(sessionId: string): void;
}

// Claude Code has no explicit "permission replied" event (SPEC §5.3-2). We pause
// on this single synthetic request id and release it before the next
// activity-class event, matching the design's simplified PAUSED model.
export const CC_PERMISSION_REQUEST_ID = "cc-permission";

export function dispatchEvent(w: WatchdogTarget, e: AkaneClaudeEvent): void {
  switch (e.kind) {
    case "user_message":
      w.onUserMessage(e.sessionId, { agentName: e.agentName });
      return;
    case "activity":
      w.onInputResolved(e.sessionId, CC_PERMISSION_REQUEST_ID);
      w.onActivity(e.sessionId, { agentName: e.agentName });
      return;
    case "tool_running":
      w.onInputResolved(e.sessionId, CC_PERMISSION_REQUEST_ID);
      if (e.callId) w.onToolRunning(e.sessionId, e.callId);
      else w.onActivity(e.sessionId, { agentName: e.agentName });
      return;
    case "tool_settled":
      w.onInputResolved(e.sessionId, CC_PERMISSION_REQUEST_ID);
      if (e.callId) {
        w.onToolSettled(e.sessionId, e.callId);
        w.onActivity(e.sessionId, { agentName: e.agentName });
      }
      else w.onActivity(e.sessionId, { agentName: e.agentName });
      return;
    case "input_requested":
      // Ignore any real requestId: the release path uses the same synthetic id.
      w.onInputRequested(e.sessionId, CC_PERMISSION_REQUEST_ID);
      return;
    case "idle":
    case "turn_end":
    case "session_end":
      w.stop(e.sessionId);
      return;
    case "error":
      if (e.errorReason === "rate_limit" || e.errorReason === "provider_timeout") {
        w.noteError(e.sessionId, e.errorReason);
      } else {
        w.stop(e.sessionId);
      }
      return;
    case "session_start":
      w.onSessionCreated(e.sessionId);
      return;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/claude/event-map.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/claude/event-map.ts tests/claude/event-map.test.ts
git commit -m "feat(claude): 正規化イベントを Watchdog メソッドへ dispatch する event-map を追加"
```

---

## Task 8: `hook.ts` + `hook-main.ts`（akane-hook センサーCLI）

**Files:**
- Create: `src/claude/hook.ts`（純粋ロジック・テスト対象）
- Create: `src/claude/hook-main.ts`（CLI エントリ・常に exit 0）
- Test: `tests/claude/hook.test.ts`

**Interfaces:**
- Consumes: `classifyError`, `HangReason`（`src/errors.ts`）；`appendEvent`（`event-log.ts`）；`resolveStateDir`, `eventsPathFor`（`state-dir.ts`）；`AkaneClaudeEvent`, `AkaneClaudeEventKind`（`event-types.ts`）。
- Produces:
  - `function extractCCSessionId(input): string | undefined`
  - `function extractCCAgentName(input): string | undefined`
  - `function extractCCCallId(input): string | undefined`
  - `function errorReasonFromStop(input): HangReason | null`
  - `function normalizeEvent(input: unknown, now: number): AkaneClaudeEvent | null`
  - `function runHook(io: HookIO): void`（`interface HookIO { stdinText: string; env: Record<string,string|undefined>; now: number; logError: (m: string) => void }`）
  - `function readStdin(stream): Promise<string>`

**重要**: Claude Code stdin のフィールド名（`hook_event_name` / `session_id` / `tool_use_id` / `error_type` / Notification の subtype 等）は未確定（SPEC §10-3）。**全ての生フィールドアクセスを `CCHookStdin` 型と抽出関数に集約**し、実機検証（Task 15）で 1 箇所のみ修正できるようにする。

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeEvent, errorReasonFromStop, runHook } from "../../src/claude/hook";
import { eventsPathFor } from "../../src/claude/state-dir";

describe("normalizeEvent", () => {
  const now = 12345;
  test("UserPromptSubmit -> user_message", () => {
    const e = normalizeEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", agent: "a" }, now);
    expect(e).toEqual({ kind: "user_message", sessionId: "s1", ts: now, agentName: "a" });
  });

  test("MessageDisplay -> activity", () => {
    expect(normalizeEvent({ hook_event_name: "MessageDisplay", session_id: "s1" }, now)?.kind).toBe("activity");
  });

  test("PreToolUse -> tool_running with callId", () => {
    const e = normalizeEvent({ hook_event_name: "PreToolUse", session_id: "s1", tool_use_id: "c1" }, now);
    expect(e?.kind).toBe("tool_running");
    expect(e?.callId).toBe("c1");
  });

  test("PostToolUse and PostToolUseFailure -> tool_settled", () => {
    expect(normalizeEvent({ hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: "c1" }, now)?.kind).toBe("tool_settled");
    expect(normalizeEvent({ hook_event_name: "PostToolUseFailure", session_id: "s1", tool_use_id: "c1" }, now)?.kind).toBe("tool_settled");
  });

  test("PermissionRequest -> input_requested", () => {
    expect(normalizeEvent({ hook_event_name: "PermissionRequest", session_id: "s1" }, now)?.kind).toBe("input_requested");
  });

  test("Notification subtype routing", () => {
    expect(normalizeEvent({ hook_event_name: "Notification", session_id: "s1", notification_type: "permission_prompt" }, now)?.kind).toBe("input_requested");
    expect(normalizeEvent({ hook_event_name: "Notification", session_id: "s1", notification_type: "idle_prompt" }, now)?.kind).toBe("idle");
    expect(normalizeEvent({ hook_event_name: "Notification", session_id: "s1", notification_type: "other" }, now)).toBeNull();
  });

  test("Stop without error -> turn_end", () => {
    expect(normalizeEvent({ hook_event_name: "Stop", session_id: "s1" }, now)?.kind).toBe("turn_end");
  });

  test("Stop WITH error fields -> error with classified reason (SPEC 5.4-1 fallback)", () => {
    const e = normalizeEvent({ hook_event_name: "Stop", session_id: "s1", error_type: "rate_limit_error" }, now);
    expect(e?.kind).toBe("error");
    expect(e?.errorReason).toBe("rate_limit");
  });

  test("StopFailure -> error (unknown when unclassifiable)", () => {
    expect(normalizeEvent({ hook_event_name: "StopFailure", session_id: "s1" }, now)?.errorReason).toBe("unknown");
    expect(normalizeEvent({ hook_event_name: "StopFailure", session_id: "s1", stop_reason: "overloaded 529" }, now)?.kind).toBe("error");
  });

  test("SessionStart/SessionEnd", () => {
    expect(normalizeEvent({ hook_event_name: "SessionStart", session_id: "s1" }, now)?.kind).toBe("session_start");
    expect(normalizeEvent({ hook_event_name: "SessionEnd", session_id: "s1" }, now)?.kind).toBe("session_end");
  });

  test("SubagentStart -> activity, SubagentStop -> tool_settled", () => {
    expect(normalizeEvent({ hook_event_name: "SubagentStart", session_id: "s1" }, now)?.kind).toBe("activity");
    const stopped = normalizeEvent({ hook_event_name: "SubagentStop", session_id: "s1", tool_use_id: "c1" }, now);
    expect(stopped?.kind).toBe("tool_settled");
    expect(stopped?.callId).toBe("c1");
  });

  test("returns null for missing sessionId or unknown hook", () => {
    expect(normalizeEvent({ hook_event_name: "MessageDisplay" }, now)).toBeNull();
    expect(normalizeEvent({ hook_event_name: "Nope", session_id: "s1" }, now)).toBeNull();
    expect(normalizeEvent({ session_id: "s1" }, now)).toBeNull();
  });
});

describe("errorReasonFromStop", () => {
  test("null when no error signals present", () => {
    expect(errorReasonFromStop({})).toBeNull();
  });
  test("classifies rate limit / timeout", () => {
    expect(errorReasonFromStop({ error_type: "429 too many requests" })).toBe("rate_limit");
    expect(errorReasonFromStop({ stop_reason: "deadline exceeded timeout" })).toBe("provider_timeout");
  });
});

describe("runHook", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-hook-"));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("appends a normalized event line to the session ndjson", () => {
    runHook({
      stdinText: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1" }),
      env: { AKANE_STATE_DIR: stateDir },
      now: 7,
      logError: () => {},
    });
    const file = eventsPathFor(stateDir, "s1");
    const line = fs.readFileSync(file, "utf8").trim();
    expect(JSON.parse(line)).toEqual({ kind: "user_message", sessionId: "s1", ts: 7 });
  });

  test("malformed stdin does not throw and writes nothing", () => {
    const errs: string[] = [];
    expect(() =>
      runHook({ stdinText: "NOT JSON", env: { AKANE_STATE_DIR: stateDir }, now: 1, logError: (m) => errs.push(m) }),
    ).not.toThrow();
    expect(errs.length).toBeGreaterThan(0);
  });

  test("unknown hook writes nothing and does not throw", () => {
    runHook({
      stdinText: JSON.stringify({ hook_event_name: "Nope", session_id: "s1" }),
      env: { AKANE_STATE_DIR: stateDir },
      now: 1,
      logError: () => {},
    });
    expect(fs.existsSync(eventsPathFor(stateDir, "s1"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/hook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation (`hook.ts`)**

```typescript
import { classifyError, type HangReason } from "../errors";
import { appendEvent } from "./event-log";
import { resolveStateDir, eventsPathFor } from "./state-dir";
import type { AkaneClaudeEvent, AkaneClaudeEventKind } from "./event-types";

// ── Claude Code stdin field contract ───────────────────────────────────
// These field names are a best-effort mapping from the Claude Code Hooks
// reference and MUST be confirmed against a live `claude` install (SPEC §10-3).
// Keep every raw-field access in this block so Task 15 has a single fix point.
export interface CCHookStdin {
  hook_event_name?: string;
  session_id?: string;
  sessionId?: string;
  agent?: string;
  agent_name?: string;
  tool_use_id?: string;
  callID?: string;
  error_type?: string;
  error?: unknown;
  stop_reason?: string;
  notification_type?: string;
  matcher?: string;
}

export function extractCCSessionId(input: CCHookStdin): string | undefined {
  const raw = input.session_id ?? input.sessionId;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function extractCCAgentName(input: CCHookStdin): string | undefined {
  return input.agent ?? input.agent_name;
}

export function extractCCCallId(input: CCHookStdin): string | undefined {
  return input.tool_use_id ?? input.callID;
}

function notificationSubtype(input: CCHookStdin): string | undefined {
  return input.notification_type ?? input.matcher;
}

// Extracts a HangReason when a Stop/StopFailure payload carries error signals
// (SPEC §5.4-1: Stop-with-error fallback when StopFailure is unregistrable).
export function errorReasonFromStop(input: CCHookStdin): HangReason | null {
  if (input.error === undefined && input.error_type === undefined && input.stop_reason === undefined) {
    return null;
  }
  return classifyError({ error_type: input.error_type, message: input.stop_reason, error: input.error });
}

export function normalizeEvent(rawInput: unknown, now: number): AkaneClaudeEvent | null {
  if (typeof rawInput !== "object" || rawInput === null) return null;
  const input = rawInput as CCHookStdin;
  const name = input.hook_event_name;
  if (typeof name !== "string") return null;
  const sessionId = extractCCSessionId(input);
  if (!sessionId) return null;
  const agentName = extractCCAgentName(input);

  const emit = (kind: AkaneClaudeEventKind, extra: Partial<AkaneClaudeEvent> = {}): AkaneClaudeEvent => ({
    kind,
    sessionId,
    ts: now,
    agentName,
    ...extra,
  });

  switch (name) {
    case "UserPromptSubmit":
      return emit("user_message");
    case "MessageDisplay":
      return emit("activity");
    case "PreToolUse":
      return emit("tool_running", { callId: extractCCCallId(input) });
    case "PostToolUse":
    case "PostToolUseFailure":
      return emit("tool_settled", { callId: extractCCCallId(input) });
    case "PermissionRequest":
      return emit("input_requested");
    case "Notification": {
      const sub = notificationSubtype(input);
      if (sub === "permission_prompt") return emit("input_requested");
      if (sub === "idle_prompt") return emit("idle");
      return null; // unknown notification subtype: ignore
    }
    case "Stop": {
      // SPEC §5.4-1: inspect error fields even on Stop so rate_limit/overloaded
      // terminations route to error (not turn_end) when StopFailure is absent.
      const reason = errorReasonFromStop(input);
      return reason ? emit("error", { errorReason: reason }) : emit("turn_end");
    }
    case "StopFailure":
      return emit("error", { errorReason: errorReasonFromStop(input) ?? "unknown" });
    case "SessionStart":
      return emit("session_start");
    case "SessionEnd":
      return emit("session_end");
    case "SubagentStart":
      return emit("activity");
    case "SubagentStop":
      // SPEC §5.1 treats subagent stop as settle. If Claude Code does not provide
      // a call/tool id, dispatchEvent degrades this to activity-only re-arm.
      return emit("tool_settled", { callId: extractCCCallId(input) });
    default:
      return null;
  }
}

export interface HookIO {
  stdinText: string;
  env: Record<string, string | undefined>;
  now: number;
  logError: (message: string) => void;
}

// Pure core: parse -> normalize -> append. Never throws (SPEC §8.1 exit-0).
export function runHook(io: HookIO): void {
  try {
    const parsed = JSON.parse(io.stdinText) as unknown;
    const event = normalizeEvent(parsed, io.now);
    if (!event) return;
    const stateDir = resolveStateDir(io.env);
    appendEvent(eventsPathFor(stateDir, event.sessionId), event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.logError(`hook error (contained): ${msg.length > 30 ? `${msg.slice(0, 30)}... (redacted)` : msg}`);
  }
}

export async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}
```

- [ ] **Step 4: Write the CLI entry (`hook-main.ts`)**

This thin entry has no unit test (pure `process` IO); it is exercised by the build (Task 12) and live verification (Task 15). It MUST NOT run on import — hence a separate file from the tested `hook.ts`.

```typescript
import { runHook, readStdin } from "./hook";

// akane-hook CLI. Observation-only sensor: always exit 0, never block a turn
// or tool (SPEC §8.1 / AC #7).
async function main(): Promise<void> {
  const stdinText = await readStdin(process.stdin).catch(() => "");
  runHook({
    stdinText,
    env: process.env as Record<string, string | undefined>,
    now: Date.now(),
    logError: (m) => {
      if (process.env.AKANE_DEBUG === "true") process.stderr.write(`[akane-hook] ${m}\n`);
    },
  });
}

main().finally(() => process.exit(0));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/claude/hook.test.ts`
Expected: PASS (all normalizeEvent / errorReasonFromStop / runHook cases).

- [ ] **Step 6: Commit**

```bash
git add src/claude/hook.ts src/claude/hook-main.ts tests/claude/hook.test.ts
git commit -m "feat(claude): CC stdin を正規化・追記する akane-hook センサーCLI を追加"
```

---

## Task 9: `lock.ts`（monitor 単一起動保証 + stale 奧取 + 退場整合）

**Files:**
- Create: `src/claude/lock.ts`
- Test: `tests/claude/lock.test.ts`

**Interfaces:**
- Consumes: `node:fs`, `node:path`。
- Produces:
  - `interface LockRecord { pid: number; startedAt: number; heartbeatAt: number }`
  - `interface MonitorLockDeps { dir: string; pid: number; startedAt: number; now: () => number; ttlMs: number; isAlive?: (pid: number) => boolean; procStartTime?: (pid: number) => number | null }`
  - `class MonitorLock`：`tryAcquire(): boolean` / `heartbeat(): boolean` / `isOwned(): boolean` / `release(): void`
  - `function computeStartedAt(pid: number, procStartTime?, fallbackNow?): number`

**設計メモ（SPEC §8.3）**: ロックレコードは `<eventsDir>/monitor.lock`。`startedAt` は OS プロセス起動時刻（Linux `/proc/<pid>/stat` 第22フィールド）を優先し、取得不可な環境では論理ブート時刻（`Date.now()`）にフォールバック。stale 判定は (1) `process.kill(pid,0)` で死亡 → stale、(2) `procStartTime` が非 null でレコードと不一致 → PID 再利用として stale、(3) ハートビートが TTL 超過 → stale。退場整合チェック：`heartbeat()` は書込前に lock を読み直し自 PID/起動時刻と不一致なら false（奥われた）を返す。`isOwned()` は副作用直前の同期チェック用。

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MonitorLock } from "../../src/claude/lock";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-lock-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const alwaysAlive = () => true;
const neverAlive = () => false;
const noProcTime = () => null;

describe("MonitorLock", () => {
  test("acquires when no lock file exists", () => {
    const lock = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isOwned()).toBe(true);
  });

  test("refuses when a healthy foreign owner holds a fresh lock", () => {
    const owner = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(owner.tryAcquire()).toBe(true);
    const other = new MonitorLock({ dir, pid: 200, startedAt: 2, now: () => 1001, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(other.tryAcquire()).toBe(false);
    expect(other.isOwned()).toBe(false);
  });

  test("steals a lock whose PID is dead", () => {
    const dead = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(dead.tryAcquire()).toBe(true);
    const fresh = new MonitorLock({ dir, pid: 200, startedAt: 2, now: () => 1001, ttlMs: 30000, isAlive: neverAlive, procStartTime: noProcTime });
    expect(fresh.tryAcquire()).toBe(true);
    expect(fresh.isOwned()).toBe(true);
  });

  test("steals a lock whose PID was reused (start time mismatch)", () => {
    const original = new MonitorLock({ dir, pid: 100, startedAt: 555, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: () => 555 });
    expect(original.tryAcquire()).toBe(true);
    // Same pid 100 is alive but /proc reports a different start time -> reused.
    const reuser = new MonitorLock({ dir, pid: 200, startedAt: 2, now: () => 1001, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: () => 999 });
    expect(reuser.tryAcquire()).toBe(true);
  });

  test("steals a lock whose heartbeat exceeded the TTL", () => {
    const stale = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(stale.tryAcquire()).toBe(true); // heartbeatAt = 1000
    const later = new MonitorLock({ dir, pid: 200, startedAt: 2, now: () => 1000 + 40000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(later.tryAcquire()).toBe(true);
  });

  test("heartbeat returns false after the lock is stolen", () => {
    let t = 1000;
    const a = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => t, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(a.tryAcquire()).toBe(true);
    t = 1000 + 40000;
    const b = new MonitorLock({ dir, pid: 200, startedAt: 2, now: () => t, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(b.tryAcquire()).toBe(true); // b steals
    // a now detects it lost ownership on its next heartbeat.
    expect(a.heartbeat()).toBe(false);
    expect(a.isOwned()).toBe(false);
    expect(b.heartbeat()).toBe(true);
  });

  test("release removes the lock only when owned", () => {
    const a = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(a.tryAcquire()).toBe(true);
    a.release();
    expect(fs.existsSync(path.join(dir, "monitor.lock"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
import * as fs from "node:fs";
import * as path from "node:path";

export interface LockRecord {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

export interface MonitorLockDeps {
  dir: string; // eventsDir
  pid: number;
  startedAt: number;
  now: () => number;
  ttlMs: number;
  isAlive?: (pid: number) => boolean;
  procStartTime?: (pid: number) => number | null;
}

const LOCK_FILE = "monitor.lock";

export class MonitorLock {
  private readonly filePath: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly procStartTime: (pid: number) => number | null;

  constructor(private readonly deps: MonitorLockDeps) {
    this.filePath = path.join(deps.dir, LOCK_FILE);
    this.isAlive = deps.isAlive ?? defaultIsAlive;
    this.procStartTime = deps.procStartTime ?? defaultProcStartTime;
  }

  private read(): LockRecord | null {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LockRecord>;
      if (
        typeof parsed.pid === "number" &&
        typeof parsed.startedAt === "number" &&
        typeof parsed.heartbeatAt === "number"
      ) {
        return parsed as LockRecord;
      }
    } catch {
      // Missing / corrupt — treat as no lock.
    }
    return null;
  }

  private write(record: LockRecord): void {
    fs.mkdirSync(this.deps.dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, this.filePath);
  }

  private isMine(record: LockRecord): boolean {
    return record.pid === this.deps.pid && record.startedAt === this.deps.startedAt;
  }

  private isStale(record: LockRecord): boolean {
    if (!this.isAlive(record.pid)) return true; // dead PID (SPEC §8.3-2)
    const started = this.procStartTime(record.pid);
    if (started !== null && started !== record.startedAt) return true; // PID reused
    return this.deps.now() - record.heartbeatAt > this.deps.ttlMs; // heartbeat expired (§8.3-3)
  }

  tryAcquire(): boolean {
    const existing = this.read();
    if (existing && !this.isMine(existing) && !this.isStale(existing)) {
      return false; // healthy foreign owner (SPEC §8.3-4)
    }
    this.write({ pid: this.deps.pid, startedAt: this.deps.startedAt, heartbeatAt: this.deps.now() });
    return true;
  }

  // SPEC §8.3 退場手順-1: re-read before writing; if we no longer own the lock,
  // report loss so the caller tears down instead of clobbering the new owner.
  heartbeat(): boolean {
    const current = this.read();
    if (!current || !this.isMine(current)) return false;
    this.write({ pid: this.deps.pid, startedAt: this.deps.startedAt, heartbeatAt: this.deps.now() });
    return true;
  }

  // SPEC §8.3 退場手順-2: synchronous ownership gate before side effects.
  isOwned(): boolean {
    const current = this.read();
    return current !== null && this.isMine(current);
  }

  release(): void {
    if (this.isOwned()) {
      try {
        fs.rmSync(this.filePath);
      } catch {
        // Already removed — tolerated.
      }
    }
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Linux /proc start time (clock ticks since boot, stable per process). Returns
// null on any other platform, degrading staleness detection to heartbeat TTL.
function defaultProcStartTime(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const starttime = Number(afterComm[19]); // field 22 (1-based) after (pid,comm)
    return Number.isFinite(starttime) ? starttime : null;
  } catch {
    return null;
  }
}

// The monitor's startedAt MUST come from the same source used in isStale so a
// healthy owner never looks reused: OS proc start time, else a boot timestamp.
export function computeStartedAt(
  pid: number,
  procStartTime: (pid: number) => number | null = defaultProcStartTime,
  fallbackNow: number = Date.now(),
): number {
  return procStartTime(pid) ?? fallbackNow;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/claude/lock.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/claude/lock.ts tests/claude/lock.test.ts
git commit -m "feat(claude): monitor 単一起動ロック(MonitorLock)と stale 奧取を追加"
```

---

## Task 10: `monitor.ts` + `monitor-main.ts`（常駐頭脳：統合・poll・lock ガード）

**Files:**
- Create: `src/claude/monitor.ts`（`ClaudeMonitor` ファクトリ + lock ガードラッパー）
- Create: `src/claude/monitor-main.ts`（実依存組立・lock 取得・シグナル処理）
- Test: `tests/claude/monitor.test.ts`

**Interfaces:**
- Consumes: `Clock`（`src/clock.ts`）；`Notifier`（`src/notifier.ts`）；`Pinger`（`src/pinger.ts`）；`Watchdog`（`src/watchdog.ts`）；`dispatchEvent`/`WatchdogTarget`（`event-map.ts`）；`EventTailer`（`event-log.ts`）；`TombstoneStore`/`deleteSessionLog`/`sweepOrphans`（`event-store.ts`）；`MonitorLock`（`lock.ts`）；`eventsDir`（`state-dir.ts`）；`AkaneClaudeEvent`（`event-types.ts`）。
- Produces:
  - `interface ClaudeMonitorDeps { stateDir; watchdog: Watchdog; tailer: EventTailer; tombstones: TombstoneStore; lock: MonitorLock; clock: Clock; pollMs: number; maintenanceIntervalMs: number; orphanTtlMs: number; log: (level: "info"|"warn", message: string) => void; onLockLost: () => void }`
  - `class ClaudeMonitor`：`start(): void` / `tick(): void` / `shutdown(): void`
  - `function lockGuardedNotifier(inner: Notifier, lock: MonitorLock, onLost: () => void): Notifier`
  - `function lockGuardedPinger(inner: Pinger, lock: MonitorLock, onLost: () => void): Pinger`

**設計メモ**: `Watchdog` は非改変で再利用するため、副作用直前の lock 整合チェック（SPEC §8.3 退場手順-2）は **Notifier/Pinger を lock ガードラッパーで包んで Watchdog に DI** することで実現（Watchdog 内部の stage1/stage2 発火がガードを通る）。`tick()` 冒頭で `lock.heartbeat()` を呼び、失っていたら shutdown + `onLockLost()`（退場手順-1）。孤児掃除は `maintenanceIntervalMs` 毎の周期処理で行い（events 本体は rewrite しない）、毎イベントの全ファイル読取を避ける。`stdout` は ClaudeCodeAdapter のみが使う（monitor logger は stderr/ファイル、SPEC §6.4）。

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeMonitor, lockGuardedNotifier, lockGuardedPinger } from "../../src/claude/monitor";
import { Watchdog } from "../../src/watchdog";
import { TelemetryCollector } from "../../src/telemetry";
import { FakeClock } from "../../src/clock";
import { EventTailer, appendEvent } from "../../src/claude/event-log";
import { TombstoneStore } from "../../src/claude/event-store";
import { MonitorLock } from "../../src/claude/lock";
import { ClaudeCodeAdapter } from "../../src/claude/pinger";
import { eventsDir, eventsPathFor } from "../../src/claude/state-dir";
import { resolveClaudeConfig } from "../../src/claude/config";
import type { Notifier, NotifierStage } from "../../src/notifier";
import type { AkaneClaudeEvent } from "../../src/claude/event-types";

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-mon-"));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

interface Harness {
  monitor: ClaudeMonitor;
  clock: FakeClock;
  watchdog: Watchdog;
  telemetry: TelemetryCollector;
  notifies: NotifierStage[];
  stdout: string[];
  lock: MonitorLock;
}

function makeHarness(): Harness {
  const clock = new FakeClock();
  const dir = eventsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const notifies: NotifierStage[] = [];
  const stdout: string[] = [];
  const lock = new MonitorLock({
    dir, pid: 111, startedAt: 1, now: () => clock.now(), ttlMs: 60_000,
    isAlive: () => true, procStartTime: () => null,
  });
  expect(lock.tryAcquire()).toBe(true);
  const onLockLost = () => {};
  const baseNotifier: Notifier = {
    async notify(_id, stage) { notifies.push(stage); },
    async clear() {},
  };
  const notifier = lockGuardedNotifier(baseNotifier, lock, onLockLost);
  const pinger = lockGuardedPinger(new ClaudeCodeAdapter((line) => stdout.push(line)), lock, onLockLost);
  const config = resolveClaudeConfig({ AKANE_STAGE1_MS: "1000", AKANE_STAGE2_MS: "1000", AKANE_MAX_PINGS: "1" });
  const telemetry = new TelemetryCollector();
  const watchdog = new Watchdog({ config, clock, notifier, pinger, telemetry, log: () => {} });
  const monitor = new ClaudeMonitor({
    stateDir, watchdog, tailer: new EventTailer(dir), tombstones: new TombstoneStore(dir), lock, clock,
    pollMs: 100, maintenanceIntervalMs: 3_600_000, orphanTtlMs: 86_400_000,
    log: () => {}, onLockLost,
  });
  return { monitor, clock, watchdog, notifies, stdout, lock, telemetry };
}

describe("ClaudeMonitor", () => {
  test("ingests a hang and escalates: stage1 warn, stage2 ping to stdout", async () => {
    const h = makeHarness();
    appendEvent(eventsPathFor(stateDir, "s1"), { kind: "user_message", sessionId: "s1", ts: 0 });
    h.monitor.tick(); // ingest -> watchdog arms stage1
    h.clock.advance(1000); // stage1 fires
    expect(h.notifies).toContain("warn");
    h.clock.advance(1000); // stage2 fires -> ping
    await new Promise((r) => setTimeout(r, 10)); // flush fire-and-forget inject
    expect(h.stdout.length).toBe(1);
    expect(h.stdout[0]!.endsWith("\n")).toBe(true);
  });

  test("max_pings=1 suppresses a second stage2 ping", async () => {
    const h = makeHarness();
    appendEvent(eventsPathFor(stateDir, "s1"), { kind: "user_message", sessionId: "s1", ts: 0 });
    h.monitor.tick();
    h.clock.advance(1000); // stage1
    h.clock.advance(1000); // first stage2 -> ping
    await new Promise((r) => setTimeout(r, 10));
    expect(h.stdout).toHaveLength(1);
    h.clock.advance(1000); // next stage2 after max_pings reached
    await new Promise((r) => setTimeout(r, 10));
    expect(h.stdout).toHaveLength(1);
  });

  test("stdout discipline: no non-ping bytes reach stdout across a full cycle", async () => {
    const h = makeHarness();
    appendEvent(eventsPathFor(stateDir, "s1"), { kind: "user_message", sessionId: "s1", ts: 0 });
    h.monitor.tick();
    h.clock.advance(1000);
    h.clock.advance(1000);
    await new Promise((r) => setTimeout(r, 10));
    // Exactly one line, and it is the ping (no debug/telemetry leaked to stdout).
    expect(h.stdout).toHaveLength(1);
  });

  test("turn_end clears monitoring before stage1", () => {
    const h = makeHarness();
    const file = eventsPathFor(stateDir, "s1");
    appendEvent(file, { kind: "user_message", sessionId: "s1", ts: 0 });
    appendEvent(file, { kind: "turn_end", sessionId: "s1", ts: 1 });
    h.monitor.tick();
    h.clock.advance(5000);
    expect(h.notifies).toHaveLength(0);
    expect(h.watchdog.activeSessionCount()).toBe(0);
  });

  test("telemetry records hang and ping without writing telemetry to stdout", async () => {
    const h = makeHarness();
    appendEvent(eventsPathFor(stateDir, "s1"), { kind: "user_message", sessionId: "s1", ts: 0 });
    h.monitor.tick();
    h.clock.advance(1000);
    h.clock.advance(1000);
    await new Promise((r) => setTimeout(r, 10));
    const snap = h.telemetry.snapshot();
    expect(snap.hangupsDetected).toBe(1);
    expect(snap.pingsSent).toBe(1);
    // stdout must still contain only the ping line (no telemetry/debug leaked).
    expect(h.stdout).toHaveLength(1);
  });

  test("session_end deletes the session ndjson and tombstones it", () => {
    const h = makeHarness();
    const file = eventsPathFor(stateDir, "s1");
    appendEvent(file, { kind: "user_message", sessionId: "s1", ts: 0 });
    appendEvent(file, { kind: "session_end", sessionId: "s1", ts: 1 });
    h.monitor.tick();
    expect(fs.existsSync(file)).toBe(false);
    expect(h.watchdog.activeSessionCount()).toBe(0);
  });

  test("tick reports lock loss and stops when lock is stolen", () => {
    const h = makeHarness();
    let lost = false;
    // Steal the lock out from under the monitor.
    const thief = new MonitorLock({
      dir: eventsDir(stateDir), pid: 999, startedAt: 9, now: () => h.clock.now() + 999_999, ttlMs: 60_000,
      isAlive: () => true, procStartTime: () => null,
    });
    expect(thief.tryAcquire()).toBe(true);
    // Re-wire onLockLost via a fresh monitor sharing the same (now-stolen) lock.
    const m = new ClaudeMonitor({
      stateDir, watchdog: h.watchdog, tailer: new EventTailer(eventsDir(stateDir)),
      tombstones: new TombstoneStore(eventsDir(stateDir)), lock: h.lock, clock: h.clock,
      pollMs: 100, maintenanceIntervalMs: 3_600_000, orphanTtlMs: 86_400_000,
      log: () => {}, onLockLost: () => { lost = true; },
    });
    m.tick();
    expect(lost).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/monitor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation (`monitor.ts`)**

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock, TimerHandle } from "../clock";
import type { Notifier } from "../notifier";
import type { Pinger } from "../pinger";
import type { Watchdog } from "../watchdog";
import { dispatchEvent, type WatchdogTarget } from "./event-map";
import type { EventTailer } from "./event-log";
import { deleteSessionLog, sweepOrphans, type TombstoneStore } from "./event-store";
import type { MonitorLock } from "./lock";
import { eventsDir } from "./state-dir";
import { safeError } from "./safe-error";
import type { AkaneClaudeEvent } from "./event-types";

export interface ClaudeMonitorDeps {
  stateDir: string;
  watchdog: Watchdog;
  tailer: EventTailer;
  tombstones: TombstoneStore;
  lock: MonitorLock;
  clock: Clock;
  pollMs: number;
  maintenanceIntervalMs: number;
  orphanTtlMs: number;
  log: (level: "info" | "warn", message: string) => void;
  onLockLost: () => void;
}

export class ClaudeMonitor {
  private timer: TimerHandle = null;
  private stopped = false;
  private sinceMaintenanceMs = 0;

  constructor(private readonly deps: ClaudeMonitorDeps) {}

  start(): void {
    this.maintenance(); // startup orphan sweep (SPEC §4.3)
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = this.deps.clock.setTimeout(() => {
      this.tick();
      this.schedule();
    }, this.deps.pollMs);
  }

  /** One poll iteration. Exposed for deterministic testing. */
  tick(): void {
    if (!this.deps.lock.heartbeat()) {
      this.deps.log("warn", "[akane] monitor lock lost; shutting down");
      this.shutdown();
      this.deps.onLockLost();
      return;
    }
    let events: AkaneClaudeEvent[] = [];
    try {
      events = this.deps.tailer.poll();
    } catch (err) {
      this.deps.log("warn", `poll failed: ${safeError(err)}`);
    }
    for (const event of events) {
      try {
        dispatchEvent(this.deps.watchdog as WatchdogTarget, event);
        if (event.kind === "session_end") this.onSessionEnd(event.sessionId);
      } catch (err) {
        this.deps.log("warn", `dispatch failed: ${safeError(err)}`);
      }
    }
    this.sinceMaintenanceMs += this.deps.pollMs;
    if (this.sinceMaintenanceMs >= this.deps.maintenanceIntervalMs) {
      this.maintenance();
      this.sinceMaintenanceMs = 0;
    }
  }

  private onSessionEnd(sessionId: string): void {
    this.deps.tombstones.record(sessionId);
    deleteSessionLog(this.deps.stateDir, sessionId);
    this.deps.tailer.forget(sessionId);
  }

  private maintenance(): void {
    const dir = eventsDir(this.deps.stateDir);
    try {
      sweepOrphans(dir, {
        now: this.deps.clock.now(),
        ttlMs: this.deps.orphanTtlMs,
        isTombstoned: (stem) => this.deps.tombstones.has(stem),
      });
    } catch (err) {
      this.deps.log("warn", `sweep failed: ${safeError(err)}`);
    }
  }

  shutdown(): void {
    this.stopped = true;
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer);
    this.timer = null;
    try {
      this.deps.watchdog.stopAll();
    } catch {
      // Contained.
    }
    this.deps.lock.release();
  }
}

// SPEC §8.3 退場手順-2: gate every side effect on current lock ownership so a
// resumed old monitor cannot fire a duplicate notify/ping in the gap before its
// next heartbeat detects the loss.
export function lockGuardedNotifier(inner: Notifier, lock: MonitorLock, onLost: () => void): Notifier {
  return {
    async notify(sessionId, stage, message) {
      if (!lock.isOwned()) { onLost(); return; }
      await inner.notify(sessionId, stage, message);
    },
    async clear(sessionId) {
      if (!lock.isOwned()) { onLost(); return; }
      await inner.clear(sessionId);
    },
  };
}

export function lockGuardedPinger(inner: Pinger, lock: MonitorLock, onLost: () => void): Pinger {
  return {
    async inject(sessionId, message, context) {
      if (!lock.isOwned()) { onLost(); return; }
      await inner.inject(sessionId, message, context);
    },
  };
}
```

- [ ] **Step 4: Write the resident entry (`monitor-main.ts`)**

This wiring entry has no unit test (real `process`/timers/`stdout`); it is exercised by the build (Task 12) and live verification (Task 15).

```typescript
import { RealClock } from "../clock";
import { Watchdog } from "../watchdog";
import { createNotifier, bunSpawn, bunWhich } from "../notifier";
import { TelemetryCollector } from "../telemetry";
import { getStateStore } from "../shared-state";
import { resolveClaudeConfig } from "./config";
import { resolveStateDir, eventsDir } from "./state-dir";
import { EventTailer } from "./event-log";
import { TombstoneStore } from "./event-store";
import { MonitorLock, computeStartedAt } from "./lock";
import { ClaudeCodeAdapter } from "./pinger";
import { ClaudeMonitor, lockGuardedNotifier, lockGuardedPinger } from "./monitor";

const POLL_MS = 1000;
const MAINTENANCE_INTERVAL_MS = 3_600_000; // hourly orphan sweep
const ORPHAN_TTL_MS = 86_400_000; // 24h (SPEC §4.3)

function main(): void {
  const env = process.env as Record<string, string | undefined>;
  const config = resolveClaudeConfig(env);
  if (!config.enabled) process.exit(0);

  const stateDir = resolveStateDir(env);
  const dir = eventsDir(stateDir);
  const clock = new RealClock();
  const lock = new MonitorLock({
    dir,
    pid: process.pid,
    startedAt: computeStartedAt(process.pid),
    now: () => clock.now(),
    ttlMs: Math.max(config.stage2Ms * 2, 30_000), // (SPEC §8.3)
  });
  if (!lock.tryAcquire()) process.exit(0); // healthy monitor already running

  const onLockLost = () => process.exit(0);
  const stdoutAdapter = new ClaudeCodeAdapter((line) => process.stdout.write(line), (m) => logStderr(env, m));
  const notifier = lockGuardedNotifier(
    createNotifier(config.notifierType, {
      env,
      spawn: bunSpawn(),
      which: bunWhich(),
      platform: process.platform,
      log: (level, message) => logStderr(env, `[${level}] ${message}`),
    }),
    lock,
    onLockLost,
  );
  const pinger = lockGuardedPinger(stdoutAdapter, lock, onLockLost);
  const stateStore = getStateStore(stateDir);
  const watchdog = new Watchdog({
    config, clock, notifier, pinger, telemetry: new TelemetryCollector(),
    log: (level, message) => logStderr(env, `[${level}] ${message}`),
    stateStore,
  });
  const monitor = new ClaudeMonitor({
    stateDir, watchdog, tailer: new EventTailer(dir), tombstones: new TombstoneStore(dir), lock, clock,
    pollMs: POLL_MS, maintenanceIntervalMs: MAINTENANCE_INTERVAL_MS,
    orphanTtlMs: ORPHAN_TTL_MS,
    log: (level, message) => logStderr(env, `[${level}] ${message}`),
    onLockLost,
  });

  const shutdown = () => {
    try { monitor.shutdown(); } finally { try { stateStore.dispose(); } catch { /* ignore */ } process.exit(0); }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  monitor.start();
}

// NEVER write logs to stdout — that channel is reserved for ping/notification
// lines delivered to Claude (SPEC §6.4). Debug logs gate on AKANE_DEBUG.
function logStderr(env: Record<string, string | undefined>, message: string): void {
  if (env.AKANE_DEBUG === "true") process.stderr.write(`[akane-monitor] ${message}\n`);
}

main();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/claude/monitor.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Full typecheck + test sweep**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; all tests pass (existing 202 + new). If any pre-existing failure is unrelated, note it.

- [ ] **Step 7: Commit**

```bash
git add src/claude/monitor.ts src/claude/monitor-main.ts tests/claude/monitor.test.ts
git commit -m "feat(claude): 常駐 monitor(ClaudeMonitor)と lock ガード付き Notifier/Pinger を追加"
```

---

## Task 11: monitor ストレス・ディスク衛生テスト（AC #9 / #13）

**Files:**
- Test: `tests/claude/monitor.stress.test.ts`（新規テストのみ。既存 `tests/stress.test.ts` は不変）

**Interfaces:**
- Consumes: `ClaudeMonitor`, `lockGuardedNotifier`, `lockGuardedPinger`（`monitor.ts`）；`Watchdog`（`src/watchdog.ts`）；`FakeClock`（`src/clock.ts`）；`EventTailer`（`event-log.ts`）；`TombstoneStore`（`event-store.ts`）；`MonitorLock`（`lock.ts`）；`MockPinger`（`src/pinger.ts`）；`eventsDir`, `eventsPathFor`（`state-dir.ts`）。
- Produces: なし（テストのみ）。

**設計メモ**: 既存 `stress.test.ts` の 1000 セッション×複数イベントを `events.ndjson` 経由で再現し、(a) 全 `session_end` 後に `activeSessionCount`/`activeTimerCount`/`clock.pendingTimerCount()` が 0、(b) 全セッションファイルが削除済み（SPEC §4.3 ディスク衛生）を検証する。I/O 削減のため 1 セッションのファイルを 1 回の書込で生成する。

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeMonitor, lockGuardedNotifier, lockGuardedPinger } from "../../src/claude/monitor";
import { Watchdog } from "../../src/watchdog";
import { FakeClock } from "../../src/clock";
import { MockPinger } from "../../src/pinger";
import { EventTailer } from "../../src/claude/event-log";
import { TombstoneStore } from "../../src/claude/event-store";
import { MonitorLock } from "../../src/claude/lock";
import { eventsDir, eventsPathFor } from "../../src/claude/state-dir";
import { resolveClaudeConfig } from "../../src/claude/config";
import type { Notifier, NotifierStage } from "../../src/notifier";

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-stress-"));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const noopNotifier: Notifier = { async notify(_i: string, _s: NotifierStage) {}, async clear() {} };

describe("ClaudeMonitor stress & disk hygiene (design 4.3 / AC #9 #13)", () => {
  test("1000 sessions x 100 events then session_end: zero leaks and zero files", () => {
    const dir = eventsDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    const SESSIONS = 1000;
    const EVENTS = 100;
    for (let s = 0; s < SESSIONS; s++) {
      const sid = `sess-${s}`;
      const lines: string[] = [];
      for (let c = 0; c < EVENTS; c++) {
        lines.push(JSON.stringify({ kind: "activity", sessionId: sid, ts: c }));
      }
      lines.push(JSON.stringify({ kind: "session_end", sessionId: sid, ts: EVENTS }));
      fs.writeFileSync(eventsPathFor(stateDir, sid), lines.join("\n") + "\n");
    }

    const clock = new FakeClock();
    const lock = new MonitorLock({
      dir, pid: 1, startedAt: 1, now: () => clock.now(), ttlMs: 60_000,
      isAlive: () => true, procStartTime: () => null,
    });
    expect(lock.tryAcquire()).toBe(true);
    const onLost = () => {};
    const config = resolveClaudeConfig({ AKANE_STAGE1_MS: "1000", AKANE_STAGE2_MS: "1000" });
    const watchdog = new Watchdog({
      config, clock,
      notifier: lockGuardedNotifier(noopNotifier, lock, onLost),
      pinger: lockGuardedPinger(new MockPinger(), lock, onLost),
      log: () => {},
    });
    const monitor = new ClaudeMonitor({
      stateDir, watchdog, tailer: new EventTailer(dir), tombstones: new TombstoneStore(dir), lock, clock,
      pollMs: 100, maintenanceIntervalMs: 3_600_000, orphanTtlMs: 86_400_000,
      log: () => {}, onLockLost: onLost,
    });

    monitor.tick(); // single poll ingests all files (activity* then session_end each)

    expect(watchdog.activeSessionCount()).toBe(0);
    expect(watchdog.activeTimerCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
    const remaining = fs.readdirSync(dir).filter((n) => n.endsWith(".ndjson"));
    expect(remaining).toEqual([]);
  });

  test("interleaved appends during polling are consumed once and the log is never rewritten (§4.3 read-offset)", () => {
    const dir = eventsDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = eventsPathFor(stateDir, "concurrent");
    const tailer = new EventTailer(dir);
    const seen = new Set<number>();
    let prevSize = 0;
    const TOTAL = 500;
    for (let i = 0; i < TOTAL; i++) {
      fs.appendFileSync(file, JSON.stringify({ kind: "activity", sessionId: "concurrent", ts: i }) + "\n");
      const size = fs.statSync(file).size;
      expect(size).toBeGreaterThanOrEqual(prevSize); // monitor は active log を rewrite/縮小しない
      prevSize = size;
      if (i % 7 === 0) for (const e of tailer.poll()) seen.add(e.ts);
    }
    for (const e of tailer.poll()) seen.add(e.ts);
    expect(seen.size).toBe(TOTAL); // interleaved append + poll でロストなし
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/monitor.stress.test.ts`
Expected: FAIL initially only if Task 10 modules are absent; otherwise this locks the leak/hygiene behavior. If it fails on counts/files, fix the monitor (Task 10) — do not weaken the assertions.

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test tests/claude/monitor.stress.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/claude/monitor.stress.test.ts
git commit -m "test(claude): events.ndjson 経由のストレスとディスク衛生テストを追加"
```

---

## Task 12: `build.ts`（dist/claude 向けビルド追加）

**Files:**
- Modify: `build.ts`（export 化 + `if (import.meta.main)` ガード + claude ビルド 2 関数）
- Test: `tests/claude/build.test.ts`

**Interfaces:**
- Consumes: `Bun.build`。
- Produces:
  - `async function buildClaudeHook(): Promise<void>`（entry `./src/claude/hook-main.ts` → `./dist/claude/hook.js`）
  - `async function buildClaudeMonitor(): Promise<void>`（entry `./src/claude/monitor-main.ts` → `./dist/claude/monitor.js`）
  - 既存 `buildServer()` / `buildTui()` は export 化しエントリ実行を `if (import.meta.main)` で囲う（import 時の副作用を防ぎテスト可能にする）。

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import { buildClaudeHook, buildClaudeMonitor } from "../../build";

describe("claude bundles", () => {
  afterAll(() => {
    // Leave dist/claude in place for downstream tasks; no teardown required.
  });

  test("buildClaudeHook emits a non-empty dist/claude/hook.js", async () => {
    await buildClaudeHook();
    expect(fs.existsSync("dist/claude/hook.js")).toBe(true);
    expect(fs.statSync("dist/claude/hook.js").size).toBeGreaterThan(0);
  });

  test("buildClaudeMonitor emits a non-empty dist/claude/monitor.js", async () => {
    await buildClaudeMonitor();
    expect(fs.existsSync("dist/claude/monitor.js")).toBe(true);
    expect(fs.statSync("dist/claude/monitor.js").size).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/build.test.ts`
Expected: FAIL — `buildClaudeHook`/`buildClaudeMonitor` are not exported from `../../build`.

- [ ] **Step 3: Modify `build.ts`**

Add `export` to the existing `buildServer` / `buildTui`, add the two claude builders, and wrap the top-level execution so importing `build.ts` (as the test does) does not run a build. The full resulting file:

```typescript
import solidPlugin from "@opentui/solid/bun-plugin";

const EXTERNALS = ["node:fs", "node:path"];
const TUI_EXTERNALS = [...EXTERNALS, "solid-js", "@opentui/solid", "@opentui/core"];

export async function buildServer(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    outdir: "./dist",
    target: "node",
    external: EXTERNALS,
    naming: { entry: "index.js" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Server plugin build failed");
  }
}

export async function buildTui(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/tui.tsx"],
    outdir: "./dist",
    target: "bun",
    external: TUI_EXTERNALS,
    plugins: [solidPlugin],
    naming: { entry: "tui.js" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("TUI plugin build failed");
  }
}

export async function buildClaudeHook(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/claude/hook-main.ts"],
    outdir: "./dist/claude",
    target: "node",
    external: EXTERNALS,
    naming: { entry: "hook.js" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Claude hook build failed");
  }
}

export async function buildClaudeMonitor(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/claude/monitor-main.ts"],
    outdir: "./dist/claude",
    target: "node",
    external: EXTERNALS,
    naming: { entry: "monitor.js" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Claude monitor build failed");
  }
}

if (import.meta.main) {
  try {
    await buildServer();
    console.log("Built dist/index.js");
    await buildTui();
    console.log("Built dist/tui.js");
    await buildClaudeHook();
    console.log("Built dist/claude/hook.js");
    await buildClaudeMonitor();
    console.log("Built dist/claude/monitor.js");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run the test + a real build to verify**

Run: `bun test tests/claude/build.test.ts && bun run build`
Expected: test PASS (2 tests); `bun run build` prints all four "Built ..." lines and exits 0. Confirm `dist/index.js` and `dist/tui.js` are still produced (OpenCode outputs unchanged, AC #12).

- [ ] **Step 5: Commit**

```bash
git add build.ts tests/claude/build.test.ts
git commit -m "build(claude): dist/claude/hook.js・monitor.js のビルドを追加"
```

---

## Task 13: マニフェスト（plugin.json + monitors.json）+ スモーク検証

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `monitors/monitors.json`
- Test: `tests/claude/manifest.smoke.test.ts`

**Interfaces:**
- Consumes: なし（静的 JSON + スモークテスト）。`package.json` の `version` と一致させる。
- Produces: Claude Code が読む 2 マニフェスト。SPEC §7.6 により「プラグインの成果物そのもの」としてユーザー承認済み（AGENTS.md「No New Agent Config Files」の対象外）。

**メモ**: `hooks` は全て単一 `hook.js` に集約し `hook_event_name` で分岐（SPEC §7.2）。`StopFailure` / `PostToolUseFailure` / `PermissionRequest` / `SubagentStart|Stop` の登録可否と matcher 構文、および userConfig→env 受け渡し構文は実機検証（Task 15 / SPEC §10）で確定する。本タスクでは登録確実な 8 イベント（§7.2 骨子）を先行実装する。

- [ ] **Step 1: Write the failing smoke test**

```typescript
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";

const plugin = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf8")) as {
  name: string;
  version: string;
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  userConfig: Record<string, { type: string; default: unknown }>;
};
const monitors = JSON.parse(fs.readFileSync("monitors/monitors.json", "utf8")) as Array<{
  name: string;
  command: string;
}>;
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };

describe("plugin.json", () => {
  test("identifies akane and matches package.json version", () => {
    expect(plugin.name).toBe("akane");
    expect(plugin.version).toBe(pkg.version);
  });

  test("registers the core hook events, all routed to the single hook.js", () => {
    const required = [
      "UserPromptSubmit", "MessageDisplay", "PreToolUse", "PostToolUse",
      "Stop", "Notification", "SessionStart", "SessionEnd",
    ];
    for (const name of required) {
      const entry = plugin.hooks[name];
      expect(Array.isArray(entry)).toBe(true);
      const command = entry![0]!.hooks[0]!.command;
      expect(command).toContain("${CLAUDE_PLUGIN_ROOT}");
      expect(command).toContain("dist/claude/hook.js");
    }
  });

  test("exposes the userConfig knobs with defaults", () => {
    expect(plugin.userConfig.stage1_ms!.default).toBe(180000);
    expect(plugin.userConfig.stage2_ms!.default).toBe(180000);
    expect(plugin.userConfig.max_pings!.default).toBe(1);
    expect(plugin.userConfig.notifier_type!.default).toBe("tmux");
  });

  test("uses only CLAUDE_PLUGIN_ROOT-relative paths (no absolute paths)", () => {
    const raw = fs.readFileSync(".claude-plugin/plugin.json", "utf8");
    expect(raw.includes("/home/")).toBe(false);
    expect(raw.includes("/Users/")).toBe(false);
  });
});

describe("monitors.json", () => {
  test("declares the akane-watchdog resident monitor -> monitor.js", () => {
    expect(Array.isArray(monitors)).toBe(true);
    const m = monitors[0]!;
    expect(m.name).toBe("akane-watchdog");
    expect(m.command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(m.command).toContain("dist/claude/monitor.js");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/manifest.smoke.test.ts`
Expected: FAIL — manifest files do not exist.

- [ ] **Step 3: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "akane",
  "version": "1.5.1",
  "description": "Claude Code session hang detector with tmux/OS notification + recovery ping",
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "MessageDisplay": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }]
  },
  "userConfig": {
    "stage1_ms": { "type": "number", "default": 180000 },
    "stage2_ms": { "type": "number", "default": 180000 },
    "max_pings": { "type": "number", "default": 1 },
    "notifier_type": { "type": "string", "default": "tmux" }
  }
}
```

> NOTE: `release-please` (release-type node) は `package.json` の version のみを更新する。`plugin.json` の version は同期が必要（スモークテストが不一致を検出）。将来 release-please の `extra-files` に `plugin.json` を登録することを推奨（本タスクのスコープ外）。

- [ ] **Step 4: Create `monitors/monitors.json`**

```json
[
  {
    "name": "akane-watchdog",
    "description": "Hang detector state machine",
    "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/monitor.js"
  }
]
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/claude/manifest.smoke.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json monitors/monitors.json tests/claude/manifest.smoke.test.ts
git commit -m "feat(claude): plugin.json / monitors.json マニフェストとスモーク検証を追加"
```

---

## Task 14: `deploy-claude-to-bitbucket.yml`（nexus 準拠の bun 化配布）

**Files:**
- Create: `.github/workflows/deploy-claude-to-bitbucket.yml`
- Test: `tests/claude/deploy-workflow.test.ts`

**Interfaces:**
- Consumes: なし（CI 定義）。既存 `.github/workflows/test.yml` / `release.yml` のスタイル（`ubuntu-slim`, `oven-sh/setup-bun@v2`, bun 1.3）に揃える。
- Produces: `workflow_dispatch` で発火する Bitbucket 配布ワークフロー（SPEC §7.4）。

**メモ**: SPEC §7.4 は nexus の `deploy-to-bitbucket.yml` をベースに変更点のみ定義する。認証・冪等スキップ・force-push・GIT_ASKPASS トークン秘匿は nexus のまま流用。以下は自己完結した参照実装であり、nexus の実績ある認証/冪等ブロックと相違があれば nexus 側を正とする。ステージング規則は配布 repo に `.claude-plugin/plugin.json` / `dist/claude/` / `monitors/monitors.json` のみ含め、**`dist/index.js`・`dist/tui.js` の OpenCode 成果物は除外**（SPEC §7.4）。

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";

const wf = fs.readFileSync(".github/workflows/deploy-claude-to-bitbucket.yml", "utf8");

describe("deploy-claude-to-bitbucket workflow", () => {
  test("is manually dispatchable", () => {
    expect(wf).toContain("workflow_dispatch");
  });

  test("runs the bun-based build/verify pipeline", () => {
    expect(wf).toContain("bun run typecheck");
    expect(wf).toContain("bun test");
    expect(wf).toContain("bun run build");
    expect(wf).toContain("claude plugin validate");
    expect(wf).toContain("--strict");
  });

  test("stages only Claude artifacts and excludes OpenCode outputs", () => {
    expect(wf).toContain(".claude-plugin/plugin.json");
    expect(wf).toContain("dist/claude");
    expect(wf).toContain("monitors/monitors.json");
    // OpenCode server/tui bundles must NOT be copied into the dist repo.
    expect(wf).not.toContain("dist/index.js");
    expect(wf).not.toContain("dist/tui.js");
  });

  test("targets the akane-dist Bitbucket repo and keeps the token out of the URL", () => {
    expect(wf).toContain("akane-dist.git");
    expect(wf).toContain("GIT_ASKPASS");
  });

  test("is idempotent: skips when the dist tag already matches the release tag", () => {
    expect(wf.toLowerCase()).toContain("skip");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/claude/deploy-workflow.test.ts`
Expected: FAIL — workflow file does not exist.

- [ ] **Step 3: Create the workflow**

```yaml
name: deploy-claude-to-bitbucket

on:
  workflow_dispatch:
    inputs:
      ref:
        description: "GitHub Release tag to publish (defaults to latest)"
        required: false
        type: string

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-slim
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3"
          cache: "bun"

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Typecheck
        run: bun run typecheck

      - name: Test
        run: bun test

      - name: Build
        run: bun run build

      - name: Validate Claude plugin (post-build, matches nexus)
        run: npx --yes claude plugin validate ./ --strict

      - name: Resolve release tag
        id: tag
        run: |
          TAG="${{ inputs.ref }}"
          if [ -z "$TAG" ]; then
            TAG="$(git describe --tags --abbrev=0)"
          fi
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"

      - name: Idempotent skip when Bitbucket already has this tag
        id: guard
        env:
          BB_USER: ${{ secrets.BITBUCKET_USER }}
          BB_TOKEN: ${{ secrets.BITBUCKET_TOKEN }}
        run: |
          # Query the dist repo's tags WITHOUT putting the token on the URL/args
          # (token supplied via a credential helper; mirrors nexus).
          DIST_URL="https://bitbucket.org/${{ vars.BITBUCKET_ORG }}/akane-dist.git"
          export GIT_ASKPASS="$(mktemp)"
          # set -e (Actions 既定シェル) で後続が失敗しても資格情報スクリプトを確実に破棄 (SPEC §7.4)
          trap 'rm -f "$GIT_ASKPASS"' EXIT
          printf '#!/bin/sh\ncase "$1" in *Username*) echo "$BB_USER";; *) echo "$BB_TOKEN";; esac\n' > "$GIT_ASKPASS"
          chmod +x "$GIT_ASKPASS"
          REMOTE_TAG="$(git ls-remote --tags "$DIST_URL" "refs/tags/${{ steps.tag.outputs.tag }}" || true)"
          if [ -n "$REMOTE_TAG" ]; then
            echo "Dist repo already has ${{ steps.tag.outputs.tag }} - skip."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          else
            echo "skip=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Stage Claude distribution
        if: steps.guard.outputs.skip != 'true'
        run: |
          STAGE="$(mktemp -d)"
          mkdir -p "$STAGE/.claude-plugin" "$STAGE/dist/claude" "$STAGE/monitors"
          cp .claude-plugin/plugin.json "$STAGE/.claude-plugin/plugin.json"
          cp -r dist/claude/. "$STAGE/dist/claude/"
          cp monitors/monitors.json "$STAGE/monitors/monitors.json"
          # Copy only scripts referenced by the manifests, if any exist.
          if [ -d scripts ]; then
            mkdir -p "$STAGE/scripts"
            find scripts -maxdepth 1 -type f -exec cp {} "$STAGE/scripts/" \;
          fi
          echo "STAGE=$STAGE" >> "$GITHUB_ENV"

      - name: Push to Bitbucket dist repo (force, token via GIT_ASKPASS)
        if: steps.guard.outputs.skip != 'true'
        env:
          BB_USER: ${{ secrets.BITBUCKET_USER }}
          BB_TOKEN: ${{ secrets.BITBUCKET_TOKEN }}
        run: |
          DIST_URL="https://bitbucket.org/${{ vars.BITBUCKET_ORG }}/akane-dist.git"
          export GIT_ASKPASS="$(mktemp)"
          # git push 失敗 (set -e) でも資格情報スクリプトを確実に破棄 (SPEC §7.4)
          trap 'rm -f "$GIT_ASKPASS"' EXIT
          printf '#!/bin/sh\ncase "$1" in *Username*) echo "$BB_USER";; *) echo "$BB_TOKEN";; esac\n' > "$GIT_ASKPASS"
          chmod +x "$GIT_ASKPASS"
          cd "$STAGE"
          git init -q
          git checkout -q -b main
          git add -A
          git -c user.email=ci@akane -c user.name=akane-ci commit -q -m "release ${{ steps.tag.outputs.tag }}"
          git tag "${{ steps.tag.outputs.tag }}"
          git push -q --force "$DIST_URL" main
          git push -q --force "$DIST_URL" "${{ steps.tag.outputs.tag }}"
```

> `secrets.BITBUCKET_USER` / `secrets.BITBUCKET_TOKEN`（`repository:write` の Access Token）と `vars.BITBUCKET_ORG` は repo 設定で事前登録する。トークンは URL/引数/ログに出さない（GIT_ASKPASS 経由、SPEC §7.4）。

> **[レビュー指摘対応メモ / 実装時 TODO — Task 14]** 上記 `guard` ステップの `REMOTE_TAG="$(git ls-remote --tags ... || true)"` は、**実装時に末尾の `|| true` を削除**すること。`|| true` は `git ls-remote` の接続失敗（認証・ネットワークエラー = 終了コード 128）まで握り潰し、`REMOTE_TAG` を空にして「タグ未存在」と誤判定 → `skip=false` となり force push へ進んでしまう。`git ls-remote` は対象タグが無くても接続が成功していれば終了コード 0 を返すため、`|| true` を外しても正常系（タグ未存在）は壊れず、**接続失敗時のみ fail-fast** する。これは冪等性ガード（AC #11「既存タグは上書きしない」）の設計意図に合致する（PR #77 レビュー指摘）。

- [ ] **Step 4: Run test + local YAML sanity check**

Run: `bun test tests/claude/deploy-workflow.test.ts`
Expected: PASS (5 tests).
実 CI 実行による冪等性（AC #11）の完全検証は Task 15 で行う。

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy-claude-to-bitbucket.yml tests/claude/deploy-workflow.test.ts
git commit -m "ci(claude): Bitbucket 配布ワークフロー(deploy-claude-to-bitbucket)を追加"
```

---

## Task 15: 実機検証ランブック（SPEC §9.3 / §10 の未確定事項確定）— 非 TDD

**Files:**
- Modify（検証結果に応じてのみ）: `src/claude/hook.ts`（`CCHookStdin` フィールド名）、`.claude-plugin/plugin.json`（matcher / env マッピング）、`monitors/monitors.json`（スキーマ）
- Create（成果物）: `docs/superpowers/notes/CC_VERIFICATION-2026-07-08.md`（実測結果の記録）

**前提**: 本タスクは **実の Claude Code インストール（`claude` CLI）が必要**。CLI が無い環境では Task 1–14 の TDD コアは完成・出荷可能であり、本タスクだけを保留する（Task 1–14 を本タスクでブロックしない）。検証で判明した実フィールド名 / 構文は上記の集約箇所のみ修正し、`bun test` を再実行して回帰が無いことを確認する。

- [ ] **Step 1: ローカルビルドを作りプラグインを導入（smoke）**

Run:

```bash
bun run build
claude --plugin-dir "$PWD"
```

Expected: エラーなく起動し、`akane` プラグインと `akane-watchdog` monitor がロードされる。monitor プロセスが起動し `<stateDir>/.akane/monitor.lock` が生成される。

- [ ] **Step 1b: Bitbucket marketplace 経由の install/reload を検証（AC #1）**

Run（配布 repo と marketplace catalog が利用可能な環境で実施）:

```text
/plugin marketplace add git@bitbucket.org:<org>/claude-plugins-marketplace.git
/plugin install akane@<org>-internal-plugins
/reload-plugins
```

Expected: marketplace 経由で `akane` を install でき、`/reload-plugins` 後に `akane-watchdog` monitor が起動する。marketplace catalog repo が未整備の環境では AC #1 は `[blocked]` として `CC_VERIFICATION-2026-07-08.md` に記録し、Task 1–14 のローカル plugin-dir smoke を AC #1 の代替として過剰主張しない。

- [ ] **Step 2: §10-3 登録可否 & matcher 構文を確定**

Run: `npx --yes claude plugin validate ./ --strict`
Expected: PASS。失敗した場合はエラーに従い `plugin.json` の hooks イベント名/matcher を修正。`StopFailure` / `PostToolUseFailure` / `PermissionRequest` / `SubagentStart` / `SubagentStop` が登録可なら `plugin.json` に追加（全て同じ `hook.js`）。**登録不可なら SPEC §5.4 のフォールバックが既に `hook.ts` に実装済み**（`StopFailure`→Stop の error フィールド検査 / `PermissionRequest`→Notification(permission_prompt)）なので追加実装は不要。`PostToolUseFailure` は既存 PostToolUse・MessageDisplay で縮退し、`SubagentStart` は activity、`SubagentStop` は `tool_settled` として扱う。SubagentStop に call/tool id が無い場合のみ activity-only re-arm へ縮退する（§5.4-3/4）。確定結果を `CC_VERIFICATION-2026-07-08.md` に記録。

- [ ] **Step 3: §10-3 stdin フィールド名を実測し `CCHookStdin` を確定**

フックの実際の stdin を確認するため、一時的に `AKANE_DEBUG=true` で hook の **event 名・field 名一覧・redacted metadata のみ**を stderr に出力する（または `claude` の hook ドキュメントを参照）。raw JSON、ユーザープロンプト、通知本文、コマンド全文は出力しない。`session_id` / `hook_event_name` / `tool_use_id` / `error_type` / Notification subtype の実フィールド名を確認。
Expected: `hook.ts` の `CCHookStdin` と抽出関数（`extractCCSessionId` 等）を実名に一致させる。変更後は `bun test tests/claude/hook.test.ts` のサンプル JSON も実名に更新して PASS させる。

- [ ] **Step 4: §10-2 userConfig→env 受け渡し構文を確定**

`plugin.json` の `userConfig`（`stage1_ms` 等）を hook/monitor に env として渡す構文（nexus が `mcpServers.env` で `${user_config.x}` を渡す方式に倣う）を実機で確認。例: `stage1_ms` を `10000` に設定し、monitor が `AKANE_STAGE1_MS=10000` を受け取るか（`AKANE_DEBUG=true` の monitor 起動ログで resolved config を確認）。
Expected: userConfig 値が `AKANE_*` env として monitor/hook に届くことを確認（AC #2）。届かない場合は `plugin.json`/`monitors.json` の env マッピングを実機の構文に修正（Task 3 の AKANE_* 名は不変、manifest 側の写像のみ調整）。

- [ ] **Step 5: §10-1 monitors.json スキーマ & §10-4 staging 検証**

`monitors/monitors.json` の完全スキーマ（`when` トリガ、変数展開、複数 monitor 可否）を実機で確認。`npx claude plugin validate ./ --strict` が `monitors/` を含む構成で通ることを確認（§10-4）。
Expected: 単一 monitor 前提が妥当。複数 monitor が強制される場合やスキーマ相違があれば `monitors.json` を修正しスモークテスト（Task 13）を更新。

- [ ] **Step 6: §9.3 ハング検知 & Ping 実効性を実測**

1. `MessageDisplay` 発火 cadence を計測し、`stage1_ms` 既定値の妥当性を判断（SPEC §5.3-1）。
2. 意図的ハング（応答を止める）で stage1→黄・stage2→赤 + tmux/OS 警告が出ること（AC #3, #4）。
3. **monitor stdout → Claude 通知でハング中ターンが動くか**の可否判定。動かない場合は補助ベクタ（`asyncRewake` 専用エントリ `rewake.js` 、`Stop` `decision:"block"`）を評価（SPEC §6.3）。補助ベクタ採用時は別途タスク化し、`hook.js` の exit-0 保証（AC #7）を侵さない（§8.1）。
4. `max_pings: 1` で 2 度目の stage2 相当まで待機しても、monitor stdout の Ping 行が 1 件から増えないこと（AC #5）。
5. Telemetry でハング数・Ping 数・回復/停止結果が記録され、telemetry/report/debug 出力が monitor stdout に混入しないこと（SPEC §1.2-4 / §6.4）。
6. 正常終了・入力待ち（PermissionRequest / Notification(permission_prompt)）で誤検知しないこと（SPEC §5.4-2）。
7. tmux 非起動環境でも monitor が落ちずログのみ残ること（AC #6）。
Expected: 全項目を `CC_VERIFICATION-2026-07-08.md` に記録。Ping が実効しなくても tmux/OS 警告（akane の主要な可視価値）は維持されることを確認。

- [ ] **Step 7: ロック奧取 & 冪等性を実機確認（AC #11, #14, #15）**

1. monitor を `kill -9` し残留 `monitor.lock` を作り、プラグインを再ロード → 新 monitor が stale 判定で奧取し起動すること（AC #14）。
2. `deploy-claude-to-bitbucket.yml` を `workflow_dispatch` で 2 回実行し、2 回目が冪等スキップすること（AC #11）。
Expected: AC #11/#14/#15 が実機で成立（#15 の二重通知/二重 Ping 防止は Task 10 の lock ガードテストで単体担保済み、本ステップでは実機確認）。

- [ ] **Step 8: 回帰確認 & コミット**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; 全テスト（既存 202 + 新規）PASS（AC #8, #12）。実名修正による回帰が無いことを確認。

```bash
git add -A
git commit -m "test(claude): 実機検証結果を反映し未確定事項(§10)を確定"
```

---

## Self-Review

### 1. Spec coverage（SPEC 各節 / AC → タスク対応）

| SPEC 節 / AC | 実装タスク |
|---|---|
| §3 センサー/頭脳分離・一方向 IPC | Task 4（event-log）/ Task 8（hook）/ Task 10（monitor） |
| §4.1 既存 `src/` 再利用 | 全タスクが既存 watchdog/clock/notifier/telemetry/errors/shared-state/pinger を import（非改変） |
| §4.2 新規 `src/claude/` 各モジュール | Task 1–10（event-types/hook/event-log/event-map/pinger/monitor/config + state-dir/event-store/lock） |
| §4.3 stateDir 解決 / events ライフサイクル / ローテーション | Task 2（state-dir）/ Task 5（tombstone/sweep）/ Task 4（read-offset tail）/ Task 10（session_end 削除・孤児掃除） |
| §5.1 イベントマッピング | Task 8（normalizeEvent）+ Task 7（dispatchEvent） |
| §5.2 ハング検知セマンティクス | 既存 `watchdog.ts` をそのまま利用（Task 10 統合テストで検証） |
| §5.3 パリティ限界 | Task 7（PAUSED 解除の簡略化）/ Task 15（cadence 実測） |
| §5.4 登録不可フックのフォールバック | Task 8（`StopFailure`→Stop-with-error 検査 / `PermissionRequest`→Notification(permission_prompt)。`PostToolUseFailure` は既存 PostToolUse・MessageDisplay で縮退。`SubagentStart` は activity、`SubagentStop` は tool_settled とし、callId 不在時のみ activity へ縮退） |
| §6.1 警告表示 | 既存 Notifier を Task 10 で DI（lock ガード付） |
| §6.2 Ping 注入 | Task 6（ClaudeCodeAdapter） |
| §6.3 Ping 実効性・補助ベクタ | Task 15（実機評価） |
| §6.4 stdout 規律 | Task 6（adapter）/ Task 10（logger は stderr、stdout 規律テスト） |
| §7.1–7.3 dist 構成・build | Task 12（build.ts）/ Task 13（manifests） |
| §7.4 配布ワークフロー | Task 14 |
| §7.5 マーケットプレイス登録 | 本 repo 外（非ゴール、SPEC §1.3）— タスク化しない |
| §7.6 ガバナンス | Task 13（マニフェストは承認済成果物） |
| §8.1 Zero-Crash | Task 8（hook exit-0）/ Task 10（monitor per-event try/catch） |
| §8.2 安全不変条件 | 全タスク（tombstone/マスク/atomic/相対パス/配列引数/AKANE_DEBUG） |
| §8.3 単一起動保証・退場手順 | Task 9（MonitorLock）/ Task 10（heartbeat・lock ガード） |
| §9.1 Unit | Task 1–9 の各テスト |
| §9.2 Integration/Smoke/Stress | Task 10（integration）/ Task 13（smoke）/ Task 11（stress） |
| §9.3 実機検証 | Task 15 |
| §10 未確定事項 1–5 | Task 15（Step 2–5） |
| AC #1 install/reload | Task 13 + Task 15（Step 1b）。Step 1 の `--plugin-dir` は smoke であり marketplace install の代替として過剰主張しない |
| AC #2 userConfig 反映 | Task 3 + Task 15（Step 4） |
| AC #3–#4 stage1/stage2 Ping | Task 10（integration）+ Task 15（Step 6） |
| AC #5 `max_pings: 1` 再注入抑止 | Task 10（2度目 stage2 で stdout が増えない統合テスト）+ Task 15（Step 6-4） |
| AC #6 tmux 非起動 | 既存 Notifier の振舞い + Task 15（Step 6-5） |
| AC #7 malformed exit-0 | Task 8 |
| AC #8 bun test 全 pass | Task 10 Step 6 / Task 15 Step 8 |
| AC #9 stress leak 0 | Task 11 |
| AC #10 stdout 規律 | Task 6 / Task 10（telemetry/debug が stdout に混入しない検証を含む） |
| AC #11 配布冪等 | Task 14 + Task 15（Step 7-2） |
| AC #12 OpenCode 非改変 | 全タスク新規追加のみ / Task 12 Step 4 で確認 |
| AC #13 events 削除 | Task 11 |
| AC #14 ロック stale 奧取 | Task 9 + Task 15（Step 7-1） |
| AC #15 二重通知/Ping 防止 | Task 9（heartbeat/isOwned）/ Task 10（lock ガード） |

**ギャップ**: repo 内実装タスクとしてのギャップは無し。ただし AC #1 の marketplace install/reload は marketplace catalog repo と Bitbucket 配布 repo が利用可能な環境に依存するため、Task 15 Step 1b で外部検証する。外部 repo 未整備時は `[blocked]` と記録し、ローカル `--plugin-dir` smoke を marketplace install の代替として扱わない。

### 2. Placeholder scan
「TBD/TODO/implement later/適切なエラー処理/Similar to Task N/テストコード省略」などのプレースホルダーは無し。各コードステップは完全な実コードを含む。実 `claude` stdin フィールド名だけが実機依存だが、ベスト推定の具体名 + 集約抽出関数 + Task 15 の確定ステップで完結（プレースホルダーではなく動作する実装）。

### 3. Type consistency（タスク間の型/名前整合）
- `AkaneClaudeEvent`（Task 1）のフィールド（`kind`/`sessionId`/`ts`/`agentName`/`callId`/`requestId`/`errorReason`）を Task 4/7/8/10/11 が一貫使用。
- `WatchdogTarget`（Task 7）のメソッド名は実 `Watchdog`（`src/watchdog.ts`）のシグネチャと一致（`onUserMessage`/`onActivity`/`onToolRunning`/`onToolSettled`/`onInputRequested`/`onInputResolved`/`onSessionCreated`/`noteError`/`stop`）。
- `MonitorLock`（Task 9）の `tryAcquire`/`heartbeat`/`isOwned`/`release` を Task 10 がそのまま使用。`computeStartedAt` は monitor-main のみが使用。
- `EventTailer`（Task 4）の `poll`/`forget` を Task 10/11 が使用。`forget` は `sanitizeSessionId` でファイル名を導出し、hook 側の `eventsPathFor`（同じ sanitize）とキー一致。
- `resolveClaudeConfig`（Task 3）→ `WatchdogConfig`（既存 `src/config.ts`）を返し、Task 10 の `Watchdog` コンストラクタにそのまま渡せる。
- `ClaudeCodeAdapter`（Task 6）は `Pinger`（`src/pinger.ts`）を実装し、`buildPingPrompt` を流用。`PingContext.reason` は `HangReason` と整合。

不一致なし。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-08-claude-code-plugin-support.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Task ごとに fresh subagent を dispatch、Task 間でレビュー、高速イテレーション。Task 1–9 は相互に概ね独立なので並行ディスパッチ可能（Task 10 の前に全部完了させる）。

**2. Inline Execution** — このセッションで `superpowers:executing-plans` を用い、チェックポイント付きバッチ実行。

どちらのアプローチで進めますか？（Task 15 の実機検証は `claude` CLI が必要なため、CLI が無い環境では Task 1–14 完了時点で一旦保留して良い）
