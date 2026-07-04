# サブエージェント自動表示 & セッション終了 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `parentID` を持つ子 OpenCode セッションを、フォーカス不要で tmux ペインに即時表示し、結果消費後に安全に削除する akane 新機能を実装する。

**Architecture:** 単一の in-memory `SubagentRegistry`（`src/subagent-registry.ts`）が親子マップ・ペイン対応・idle 保留状態を保持し、独立した `PaneManager`（`src/pane-manager.ts`）が tmux split + `opencode attach --mini` を担当、`SessionTerminator`（`src/session-terminator.ts`）が親再開または grace で `client.session.delete` を発行する。`src/index.ts` は既存 watchdog 経路を維持しつつ `session.created` / `session.idle` / `session.error` / `session.deleted` / 親 assistant 活動イベントを新モジュールに配線する。`src/shared-state.ts` と `src/tui.tsx` は無改変。

**Tech Stack:** TypeScript / Bun (`bun test`, `bun run typecheck`, `bun run build`), tmux, `opencode attach`, `@opencode-ai/sdk` クライアント。

## Global Constraints

- 対象は **`parentID` を持つ子セッション** のみ。`parentID` 無しのメイン / ルートセッションは一切表示・削除しない。
- 両機能とも **デフォルト無効（opt-in）**（`subagentDisplay.enabled=false`, `subagentTermination.enabled=false`）。
- tmux 非検出環境・外部コマンド失敗・SDK 失敗時も **zero-crash**（try/catch 内包、binary 名 + exit code / エラー型のみログ）。
- すべての外部コマンド引数は **配列（argv）渡し**；`opencode attach` コマンドも tmux `split-window` への引数として別々の argv 要素に分解し shell 経由を防ぐ。
- ログには `sessionId` 全体やペイロード本文を出さず、先頭 4 文字のみ残しマスクする（既存 `summarizeEvent` 方針と整合）。
- 追加デバッグログは `AKANE_DEBUG === "true"` のときのみ出力する。
- 絶対パスはコード / 設定に埋め込まない（`$HOME` または相対パスを使用）。
- `bun test` の全テストを pass させる（202 tests を維持）。

---

## File Structure

| ファイル | 区分 | 責務 |
|---|---|---|
| `src/subagent-registry.ts` | 新規 | 子セッションの in-memory 登録、`deletePending`、最古 evict 対象選定、親子索引 `byParent` の整合。 |
| `src/pane-manager.ts` | 新規 | tmux 検出、split-window、最古 evict、`opencode attach --mini` 起動、ペインクローズ。 |
| `src/session-terminator.ts` | 新規 | 子 idle → 保留、親再開 or grace で `session.delete`、`keepOnError`、root 除外。 |
| `src/index.ts` | 拡張 | イベントルータ配線：created→登録・表示、idle→保留・pane close、親 assistant 活動→削除、error/deleted→掃除。 |
| `src/config.ts` | 拡張済 | `subagentDisplay` / `subagentTermination` デフォルトと解決ロジックは既存。今回は新 env パーサー追加。 |
| `src/shared-state.ts` | 無改変 | — |
| `src/tui.tsx` | 無改変 | — |

---

### Task 1: `SubagentRegistry`（状態保持 + 親子索引）

**Files:**
- Create: `src/subagent-registry.ts`
- Test: `tests/subagent-registry.test.ts`

**Interfaces:**
- Consumes: `Clock`（`src/clock.ts` から `Clock`, `FakeClock`, `RealClock`）
- Produces:
  - `interface SubagentRecord { sessionId, parentId, paneId?, createdAt, idleAt?, terminalReason?, deletePending? }`
  - `class SubagentRegistry`
    - `register(sessionId: string, parentId: string): SubagentRecord`
    - `markIdle(sessionId: string): void`
    - `markError(sessionId: string): void`
    - `setPaneId(sessionId: string, paneId: string): void`
    - `clearPaneId(sessionId: string): void`
    - `findOldestPaneToEvict(): SubagentRecord | undefined`（`paneId` ありのレコードで `createdAt` 最小。`deletePending` でも OK。）
    - `remove(sessionId: string): void`
    - `getPendingChildrenOf(parentId: string): SubagentRecord[]`（`deletePending=true` の子）
    - `get(sessionId: string): SubagentRecord | undefined`
    - `has(sessionId: string): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { SubagentRegistry } from "../src/subagent-registry";
import { FakeClock } from "../src/clock";

describe("SubagentRegistry", () => {
  test("registers child and maintains parent index", () => {
    const clock = new FakeClock();
    const reg = new SubagentRegistry(clock);
    const r = reg.register("child-1", "parent-1");
    expect(r.sessionId).toBe("child-1");
    expect(r.parentId).toBe("parent-1");
    expect(r.createdAt).toBe(0);
    expect(reg.get("child-1")?.parentId).toBe("parent-1");
    expect(reg.getPendingChildrenOf("parent-1")).toHaveLength(0);
  });

  test("markIdle sets deletePending and returns child on parent query", () => {
    const clock = new FakeClock();
    const reg = new SubagentRegistry(clock);
    reg.register("child-1", "parent-1");
    reg.markIdle("child-1");
    const pending = reg.getPendingChildrenOf("parent-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe("child-1");
    expect(pending[0].deletePending).toBe(true);
    expect(pending[0].terminalReason).toBe("idle");
  });

  test("remove deletes record and parent index", () => {
    const clock = new FakeClock();
    const reg = new SubagentRegistry(clock);
    reg.register("child-1", "parent-1");
    reg.markIdle("child-1");
    reg.remove("child-1");
    expect(reg.has("child-1")).toBe(false);
    expect(reg.getPendingChildrenOf("parent-1")).toHaveLength(0);
  });

  test("findOldestPaneToEvict picks createdAt minimum among paneId holders", () => {
    const clock = new FakeClock();
    const reg = new SubagentRegistry(clock);
    reg.register("c1", "p1");
    reg.setPaneId("c1", "%1");
    clock.advance(10);
    reg.register("c2", "p1");
    reg.setPaneId("c2", "%2");
    clock.advance(10);
    reg.register("c3", "p1");
    reg.setPaneId("c3", "%3");
    const oldest = reg.findOldestPaneToEvict();
    expect(oldest?.sessionId).toBe("c1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/subagent-registry.test.ts`
Expected: FAIL with module not found / class not defined

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { Clock } from "./clock";

export interface SubagentRecord {
  sessionId: string;
  parentId: string;
  paneId?: string;
  createdAt: number;
  idleAt?: number;
  terminalReason?: "idle" | "error";
  deletePending?: boolean;
}

export class SubagentRegistry {
  private records = new Map<string, SubagentRecord>();
  private byParent = new Map<string, Set<string>>();

  constructor(private readonly clock: Clock) {}

  register(sessionId: string, parentId: string): SubagentRecord {
    const record: SubagentRecord = { sessionId, parentId, createdAt: this.clock.now() };
    this.records.set(sessionId, record);
    const set = this.byParent.get(parentId) ?? new Set<string>();
    set.add(sessionId);
    this.byParent.set(parentId, set);
    return record;
  }

  get(sessionId: string): SubagentRecord | undefined {
    return this.records.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.records.has(sessionId);
  }

  setPaneId(sessionId: string, paneId: string): void {
    const r = this.records.get(sessionId);
    if (r) r.paneId = paneId;
  }

  clearPaneId(sessionId: string): void {
    const r = this.records.get(sessionId);
    if (r) delete r.paneId;
  }

  markIdle(sessionId: string): void {
    const r = this.records.get(sessionId);
    if (!r) return;
    r.idleAt = this.clock.now();
    r.terminalReason = "idle";
    r.deletePending = true;
  }

  markError(sessionId: string): void {
    const r = this.records.get(sessionId);
    if (!r) return;
    r.terminalReason = "error";
    r.deletePending = false;
  }

  remove(sessionId: string): void {
    const r = this.records.get(sessionId);
    if (!r) return;
    this.records.delete(sessionId);
    const set = this.byParent.get(r.parentId);
    if (set) {
      set.delete(sessionId);
      if (set.size === 0) this.byParent.delete(r.parentId);
    }
  }

  getPendingChildrenOf(parentId: string): SubagentRecord[] {
    const set = this.byParent.get(parentId);
    if (!set) return [];
    return Array.from(set)
      .map((id) => this.records.get(id))
      .filter((r): r is SubagentRecord => r !== undefined && r.deletePending === true);
  }

  paneCount(): number {
    let count = 0;
    for (const r of this.records.values()) {
      if (r.paneId) count += 1;
    }
    return count;
  }

  findOldestPaneToEvict(): SubagentRecord | undefined {
    let oldest: SubagentRecord | undefined;
    for (const r of this.records.values()) {
      if (!r.paneId) continue;
      if (!oldest || r.createdAt < oldest.createdAt) oldest = r;
    }
    return oldest;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/subagent-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/subagent-registry.ts tests/subagent-registry.test.ts
git commit -m "feat: add SubagentRegistry for in-memory subagent lifecycle tracking"
```

---

### Task 2: `config.ts` の新 env パーサー追加

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`（既存ファイルを拡張）

**Interfaces:**
- Consumes: なし
- Produces: `resolveConfig` が以下の env 変数を解決する：
  - `OPENCODE_WATCHDOG_SUBAGENT_DISPLAY` → boolean
  - `OPENCODE_WATCHDOG_SUBAGENT_MAX_PANES` → positive integer
  - `OPENCODE_WATCHDOG_SUBAGENT_DELETE` → boolean
  - `OPENCODE_WATCHDOG_SUBAGENT_DELETE_GRACE_MS` → positive integer
  - `OPENCODE_WATCHDOG_SUBAGENT_KEEP_ON_ERROR` → boolean

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts` の末尾に追加：

```typescript
  test("env subagent display knobs resolve", () => {
    const cfg = resolveConfig({
      env: {
        OPENCODE_WATCHDOG_SUBAGENT_DISPLAY: "true",
        OPENCODE_WATCHDOG_SUBAGENT_MAX_PANES: "2",
        OPENCODE_WATCHDOG_SUBAGENT_DELETE: "true",
        OPENCODE_WATCHDOG_SUBAGENT_DELETE_GRACE_MS: "30000",
        OPENCODE_WATCHDOG_SUBAGENT_KEEP_ON_ERROR: "false",
      },
    });
    expect(cfg.subagentDisplay.enabled).toBe(true);
    expect(cfg.subagentDisplay.maxPanes).toBe(2);
    expect(cfg.subagentTermination.enabled).toBe(true);
    expect(cfg.subagentTermination.graceMs).toBe(30_000);
    expect(cfg.subagentTermination.keepOnError).toBe(false);
  });

  test("invalid subagent env values fall back to defaults with warn", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      {
        env: {
          OPENCODE_WATCHDOG_SUBAGENT_MAX_PANES: "0",
          OPENCODE_WATCHDOG_SUBAGENT_DELETE_GRACE_MS: "abc",
          OPENCODE_WATCHDOG_SUBAGENT_KEEP_ON_ERROR: "maybe",
        },
      },
      (msg) => warnings.push(msg),
    );
    expect(cfg.subagentDisplay.maxPanes).toBe(4);
    expect(cfg.subagentTermination.graceMs).toBe(60_000);
    expect(cfg.subagentTermination.keepOnError).toBe(true);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL（`subagentDisplay.enabled` などが正しく解決されない）

- [ ] **Step 3: Write minimal implementation**

`src/config.ts` の `resolveConfig` 内、既存 env 解決の直下に追加：

```typescript
  const envSubagentDisplay = parseBool(env.OPENCODE_WATCHDOG_SUBAGENT_DISPLAY, "OPENCODE_WATCHDOG_SUBAGENT_DISPLAY", warn);
  const expSubagentDisplay = validateBool(experimental.subagentDisplay?.enabled, "subagentDisplay.enabled", warn);
  const projSubagentDisplay = validateBool(project.subagentDisplay?.enabled, "subagentDisplay.enabled", warn);

  const envSubagentMaxPanes = parsePositiveInt(env.OPENCODE_WATCHDOG_SUBAGENT_MAX_PANES, "OPENCODE_WATCHDOG_SUBAGENT_MAX_PANES", warn);
  const expSubagentMaxPanes = validateNumber(experimental.subagentDisplay?.maxPanes, "subagentDisplay.maxPanes", warn, true);
  const projSubagentMaxPanes = validateNumber(project.subagentDisplay?.maxPanes, "subagentDisplay.maxPanes", warn, true);

  const envSubagentDelete = parseBool(env.OPENCODE_WATCHDOG_SUBAGENT_DELETE, "OPENCODE_WATCHDOG_SUBAGENT_DELETE", warn);
  const expSubagentDelete = validateBool(experimental.subagentTermination?.enabled, "subagentTermination.enabled", warn);
  const projSubagentDelete = validateBool(project.subagentTermination?.enabled, "subagentTermination.enabled", warn);

  const envSubagentGrace = parsePositiveInt(env.OPENCODE_WATCHDOG_SUBAGENT_DELETE_GRACE_MS, "OPENCODE_WATCHDOG_SUBAGENT_DELETE_GRACE_MS", warn);
  const expSubagentGrace = validateNumber(experimental.subagentTermination?.graceMs, "subagentTermination.graceMs", warn, true);
  const projSubagentGrace = validateNumber(project.subagentTermination?.graceMs, "subagentTermination.graceMs", warn, true);

  const envSubagentKeepOnError = parseBool(env.OPENCODE_WATCHDOG_SUBAGENT_KEEP_ON_ERROR, "OPENCODE_WATCHDOG_SUBAGENT_KEEP_ON_ERROR", warn);
  const expSubagentKeepOnError = validateBool(experimental.subagentTermination?.keepOnError, "subagentTermination.keepOnError", warn);
  const projSubagentKeepOnError = validateBool(project.subagentTermination?.keepOnError, "subagentTermination.keepOnError", warn);
```

`return { ... }` 内の `subagentDisplay` / `subagentTermination` ブロックを差し替え：

```typescript
    subagentDisplay: {
      enabled: envSubagentDisplay ?? expSubagentDisplay ?? projSubagentDisplay ?? DEFAULT_CONFIG.subagentDisplay.enabled,
      maxPanes: envSubagentMaxPanes ?? expSubagentMaxPanes ?? projSubagentMaxPanes ?? DEFAULT_CONFIG.subagentDisplay.maxPanes,
    },
    subagentTermination: {
      enabled: envSubagentDelete ?? expSubagentDelete ?? projSubagentDelete ?? DEFAULT_CONFIG.subagentTermination.enabled,
      graceMs: envSubagentGrace ?? expSubagentGrace ?? projSubagentGrace ?? DEFAULT_CONFIG.subagentTermination.graceMs,
      keepOnError: envSubagentKeepOnError ?? expSubagentKeepOnError ?? projSubagentKeepOnError ?? DEFAULT_CONFIG.subagentTermination.keepOnError,
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: wire subagent env config knobs"
```

---

### Task 3: `PaneManager`（tmux split + `opencode attach --mini`）

**Files:**
- Create: `src/pane-manager.ts`
- Test: `tests/pane-manager.test.ts`

**Interfaces:**
- Consumes:
  - `SpawnFn`, `WhichFn` from `src/notifier.ts`
  - `SubagentRegistry` from `src/subagent-registry.ts`
  - `WatchdogConfig["subagentDisplay"]` from `src/config.ts`
  - `Clock` from `src/clock.ts`
- Produces:
  - `interface PaneManagerDeps { registry, config, spawn, which, env, serverUrl, directory, log, debugLog?, clock }`
  - `class PaneManager`
    - `async onChildCreated(sessionId: string): Promise<void>`
    - `async closePane(sessionId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { PaneManager } from "../src/pane-manager";
import { SubagentRegistry } from "../src/subagent-registry";
import { FakeClock } from "../src/clock";

describe("PaneManager", () => {
  function setup() {
    const clock = new FakeClock();
    const registry = new SubagentRegistry(clock);
    const calls: { cmd: string[] }[] = [];
    const spawn = async (cmd: string[]) => {
      calls.push({ cmd });
      return { exitCode: 0, stdout: cmd[1] === "split-window" ? "%42" : "" };
    };
    const which = (b: string) => (b === "tmux" ? "/usr/bin/tmux" : null);
    const logs: string[] = [];
    const manager = new PaneManager({
      registry,
      config: { enabled: true, maxPanes: 4 },
      spawn,
      which,
      env: { TMUX: "/tmp/tmux-0" },
      serverUrl: "http://localhost:8080",
      directory: "/tmp",
      log: (_l, m) => logs.push(m),
      clock,
    });
    return { manager, registry, calls, logs, clock };
  }

  test("creates tmux split + attach --mini for child", async () => {
    const { manager, registry, calls } = setup();
    registry.register("child-1", "parent-1");
    await manager.onChildCreated("child-1");
    const split = calls.find((c) => c.cmd[1] === "split-window");
    expect(split).toBeDefined();
    expect(split!.cmd).toContain("--mini");
    expect(split!.cmd).toContain("http://localhost:8080");
    expect(split!.cmd).toContain("--session");
    expect(split!.cmd).toContain("child-1");
    expect(split!.cmd).toContain("--dir");
    expect(split!.cmd).toContain("/tmp");
    expect(registry.get("child-1")?.paneId).toBe("%42");
  });

  test("does nothing when display disabled", async () => {
    const { manager: _, ...rest } = setup();
    const manager2 = new PaneManager({ ...rest, config: { enabled: false, maxPanes: 4 } });
    registry.register("child-1", "parent-1");
    await manager2.onChildCreated("child-1");
    expect(calls).toHaveLength(0);
  });

  test("evicts oldest pane when maxPanes reached", async () => {
    const { manager, registry, calls } = setup();
    for (let i = 0; i < 5; i++) {
      registry.register(`child-${i}`, "parent-1");
      await manager.onChildCreated(`child-${i}`);
    }
    const kills = calls.filter((c) => c.cmd[1] === "kill-pane");
    expect(kills).toHaveLength(1);
    expect(kills[0].cmd).toContain("%42"); // oldest pane id
    const splits = calls.filter((c) => c.cmd[1] === "split-window");
    expect(splits).toHaveLength(5);
  });

  test("closePane issues kill-pane", async () => {
    const { manager, registry, calls } = setup();
    registry.register("child-1", "parent-1");
    await manager.onChildCreated("child-1");
    await manager.closePane("child-1");
    const kill = calls.find((c) => c.cmd[1] === "kill-pane");
    expect(kill).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pane-manager.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { SubagentRegistry } from "./subagent-registry";
import type { WatchdogConfig } from "./config";
import type { SpawnFn, WhichFn } from "./notifier";
import type { Clock } from "./clock";

export interface PaneManagerDeps {
  registry: SubagentRegistry;
  config: WatchdogConfig["subagentDisplay"];
  spawn: SpawnFn;
  which: WhichFn;
  env: Record<string, string | undefined>;
  serverUrl: string;
  directory?: string;
  log: (level: "info" | "warn", message: string) => void;
  debugLog?: (message: string) => void;
  clock: Clock;
}

export class PaneManager {
  private detection: "unknown" | "ok" | "disabled" = "unknown";
  private tmuxPath = "tmux";

  constructor(private readonly deps: PaneManagerDeps) {}

  async onChildCreated(sessionId: string): Promise<void> {
    if (!this.deps.config.enabled) return;
    if (!(await this.ensureTmux())) return;

    const oldest = this.deps.registry.findOldestPaneToEvict();
    const currentPanes = this.countPanes();
    if (oldest && currentPanes >= this.deps.config.maxPanes) {
      await this.killPane(oldest.sessionId);
    }

    const args = [
      this.tmuxPath,
      "split-window",
      "-P",
      "-F",
      "#{pane_id}",
      "opencode",
      "attach",
      this.deps.serverUrl,
      "--session",
      sessionId,
    ];
    if (this.deps.directory) {
      args.push("--dir", this.deps.directory);
    }
    args.push("--mini");

    try {
      const result = await this.deps.spawn(args);
      if (result.exitCode === 0) {
        const paneId = result.stdout?.trim();
        if (paneId) {
          this.deps.registry.setPaneId(sessionId, paneId);
          this.deps.debugLog?.(`pane ${paneId} attached for ${sessionId.slice(0, 4)}`);
        }
      } else {
        this.deps.log("warn", `tmux split-window failed (exitCode: ${result.exitCode})`);
      }
    } catch (err) {
      this.deps.log("warn", `tmux split-window spawn failed: ${String(err).slice(0, 30)}`);
    }
  }

  async closePane(sessionId: string): Promise<void> {
    await this.killPane(sessionId);
  }

  private async killPane(sessionId: string): Promise<void> {
    const paneId = this.deps.registry.get(sessionId)?.paneId;
    if (!paneId) return;
    if (!(await this.ensureTmux())) return;
    try {
      const result = await this.deps.spawn([this.tmuxPath, "kill-pane", "-t", paneId]);
      if (result.exitCode !== 0) {
        this.deps.log("warn", `tmux kill-pane failed (exitCode: ${result.exitCode})`);
      }
    } catch (err) {
      this.deps.log("warn", `tmux kill-pane spawn failed: ${String(err).slice(0, 30)}`);
    }
    this.deps.registry.clearPaneId(sessionId);
  }

  private countPanes(): number {
    return this.deps.registry.paneCount();
  }

  private async ensureTmux(): Promise<boolean> {
    if (this.detection === "ok") return true;
    if (this.detection === "disabled") return false;
    if (!this.deps.env.TMUX) {
      this.detection = "disabled";
      this.deps.log("info", "tmux not detected (TMUX env empty); subagent display disabled.");
      return false;
    }
    const path = this.deps.which("tmux");
    if (!path) {
      this.detection = "disabled";
      this.deps.log("info", "tmux binary not found; subagent display disabled.");
      return false;
    }
    this.tmuxPath = path;
    try {
      const result = await this.deps.spawn([this.tmuxPath, "display-message", "-p", "#{session_name}"]);
      if (result.exitCode !== 0) {
        this.detection = "disabled";
        this.deps.log("info", "tmux probe failed; subagent display disabled.");
        return false;
      }
    } catch (err) {
      this.detection = "disabled";
      this.deps.log("info", `tmux probe spawn failed: ${String(err).slice(0, 30)}`);
      return false;
    }
    this.detection = "ok";
    return true;
  }
}
```

> 注: `countPanes` は private `records` にアクセスしているためテスト時に不便。設計上 `SubagentRegistry` に `paneCount(): number` メソッドを追加する方が良い。`SubagentRegistry` の Step 3 で追加し、`PaneManager` でも最初から使うこと。

`PaneManager.countPanes` は既に `this.deps.registry.paneCount()` を使用しているため、追加の差し替えは不要。

- [ ] **Step 4: Adjust `SubagentRegistry` to expose `paneCount()`**

`SubagentRegistry` の Step 3 で `paneCount()` を追加済みなので、ここでは `PaneManager.countPanes` が `this.deps.registry.paneCount()` を使用していることを確認するだけ。

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/pane-manager.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/pane-manager.ts tests/pane-manager.test.ts src/subagent-registry.ts tests/subagent-registry.test.ts
git commit -m "feat: add PaneManager for tmux split and opencode attach --mini"
```

---

### Task 4: `SessionTerminator`（親再開 / grace / keepOnError）

**Files:**
- Create: `src/session-terminator.ts`
- Test: `tests/session-terminator.test.ts`

**Interfaces:**
- Consumes:
  - `SubagentRegistry` from `src/subagent-registry.ts`
  - `WatchdogConfig["subagentTermination"]` from `src/config.ts`
  - `Clock` from `src/clock.ts`
  - SDK client: `unknown` を `{ session: { delete: (args: { path: { id: string } }) => Promise<unknown> } }` としてキャストして使用
- Produces:
  - `interface SessionTerminatorDeps { registry, config, client, log, clock }`
  - `class SessionTerminator`
    - `onChildIdle(sessionId: string): void`
    - `onChildError(sessionId: string): void`
    - `onParentActivity(parentId: string): void`
    - `onSessionDeleted(sessionId: string): void`
    - `dispose(): void`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { SessionTerminator } from "../src/session-terminator";
import { SubagentRegistry } from "../src/subagent-registry";
import { FakeClock } from "../src/clock";

describe("SessionTerminator", () => {
  function setup() {
    const clock = new FakeClock();
    const registry = new SubagentRegistry(clock);
    const deletions: string[] = [];
    const client = {
      session: {
        delete: async ({ path }: { path: { id: string } }) => {
          deletions.push(path.id);
          return {};
        },
      },
    };
    const logs: string[] = [];
    const terminator = new SessionTerminator({
      registry,
      config: { enabled: true, graceMs: 60_000, keepOnError: true },
      client,
      log: (_l, m) => logs.push(m),
      clock,
    });
    return { terminator, registry, clock, deletions, logs };
  }

  test("does not delete immediately on child idle", async () => {
    const { terminator, registry, clock, deletions } = setup();
    registry.register("child-1", "parent-1");
    terminator.onChildIdle("child-1");
    expect(deletions).toHaveLength(0);
    clock.advance(59_999);
    expect(deletions).toHaveLength(0);
  });

  test("deletes on parent activity", async () => {
    const { terminator, registry, deletions } = setup();
    registry.register("child-1", "parent-1");
    terminator.onChildIdle("child-1");
    await terminator.onParentActivity("parent-1");
    expect(deletions).toEqual(["child-1"]);
    expect(registry.has("child-1")).toBe(false);
  });

  test("deletes on grace timeout", async () => {
    const { terminator, registry, clock, deletions } = setup();
    registry.register("child-1", "parent-1");
    terminator.onChildIdle("child-1");
    clock.advance(60_001);
    await Promise.resolve();
    await Promise.resolve();
    expect(deletions).toEqual(["child-1"]);
  });

  test("keeps error child session and removes registry record", async () => {
    const { terminator, registry, deletions } = setup();
    registry.register("child-1", "parent-1");
    terminator.onChildError("child-1");
    expect(deletions).toHaveLength(0);
    expect(registry.has("child-1")).toBe(false);
  });

  test("disabled terminator does not delete", async () => {
    const { terminator: _, registry, clock, deletions } = setup();
    const disabled = new SessionTerminator({
      registry,
      config: { enabled: false, graceMs: 60_000, keepOnError: true },
      client: { session: { delete: async () => {} } },
      log: () => {},
      clock,
    });
    registry.register("child-1", "parent-1");
    disabled.onChildIdle("child-1");
    await disabled.onParentActivity("parent-1");
    expect(deletions).toHaveLength(0);
  });

  test("onSessionDeleted is idempotent", async () => {
    const { terminator, registry } = setup();
    registry.register("child-1", "parent-1");
    terminator.onChildIdle("child-1");
    await terminator.onParentActivity("parent-1");
    expect(registry.has("child-1")).toBe(false);
    await terminator.onSessionDeleted("child-1");
    expect(registry.has("child-1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/session-terminator.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { SubagentRegistry } from "./subagent-registry";
import type { WatchdogConfig } from "./config";
import type { Clock } from "./clock";

export interface SessionTerminatorDeps {
  registry: SubagentRegistry;
  config: WatchdogConfig["subagentTermination"];
  client: unknown;
  log: (level: "info" | "warn", message: string) => void;
  clock: Clock;
}

interface DeleteClient {
  session: {
    delete: (args: { path: { id: string } }) => Promise<unknown>;
  };
}

export class SessionTerminator {
  private timers = new Map<string, ReturnType<Clock["setTimeout"]>>();

  constructor(private readonly deps: SessionTerminatorDeps) {}

  onChildIdle(sessionId: string): void {
    if (!this.deps.config.enabled) return;
    if (!this.deps.registry.has(sessionId)) return;
    this.deps.registry.markIdle(sessionId);
    const handle = this.deps.clock.setTimeout(() => {
      this.timers.delete(sessionId);
      void this.deleteSession(sessionId, "grace");
    }, this.deps.config.graceMs);
    this.timers.set(sessionId, handle);
  }

  onChildError(sessionId: string): void {
    if (!this.deps.config.enabled) return;
    if (!this.deps.registry.has(sessionId)) return;
    this.deps.registry.markError(sessionId);
    this.clearTimer(sessionId);
    this.deps.registry.remove(sessionId);
  }

  async onParentActivity(parentId: string): Promise<void> {
    if (!this.deps.config.enabled) return;
    const children = this.deps.registry.getPendingChildrenOf(parentId);
    for (const child of children) {
      this.clearTimer(child.sessionId);
      await this.deleteSession(child.sessionId, "parent-resume");
    }
  }

  async onSessionDeleted(sessionId: string): Promise<void> {
    this.clearTimer(sessionId);
    this.deps.registry.remove(sessionId);
  }

  dispose(): void {
    for (const handle of this.timers.values()) {
      this.deps.clock.clearTimeout(handle);
    }
    this.timers.clear();
  }

  private clearTimer(sessionId: string): void {
    const handle = this.timers.get(sessionId);
    if (handle !== undefined) {
      this.deps.clock.clearTimeout(handle);
      this.timers.delete(sessionId);
    }
  }

  private async deleteSession(sessionId: string, reason: string): Promise<void> {
    if (!this.deps.registry.has(sessionId)) return;
    const client = this.deps.client as DeleteClient;
    try {
      await client.session.delete({ path: { id: sessionId } });
      this.deps.log("info", `Deleted subagent ${sessionId.slice(0, 4)}… via ${reason}`);
    } catch (err) {
      this.deps.log("warn", `session.delete failed: ${String(err).slice(0, 30)}`);
      return;
    }
    this.deps.registry.remove(sessionId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/session-terminator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session-terminator.ts tests/session-terminator.test.ts
git commit -m "feat: add SessionTerminator with parent-resume and grace delete"
```

---

### Task 5: `src/index.ts` イベントルータ配線

**Files:**
- Modify: `src/index.ts`（主に `plugin` 関数内 event hook）
- Test: `tests/index.test.ts`（既存テストを拡張）

**Interfaces:**
- Consumes: `SubagentRegistry`, `PaneManager`, `SessionTerminator`
- Produces: 外部 API 変更なし

- [ ] **Step 1: Add helper `extractParentId`**

`src/index.ts` に追加（`extractSessionId` 直下が望ましい）：

```typescript
export function extractParentId(event: OpenCodeEvent): string | undefined {
  if (event.type !== "session.created") return undefined;
  const info = (event.properties as { info?: { parentID?: string } } | undefined)?.info;
  return typeof info?.parentID === "string" && info.parentID.length > 0 ? info.parentID : undefined;
}
```

- [ ] **Step 2: Write the failing test for parentId extraction**

`tests/index.test.ts` に追加：

```typescript
describe("extractParentId", () => {
  test("returns parentID for session.created with non-empty parent", async () => {
    const mod = await import("../src/index");
    const ev: OpenCodeEvent = { type: "session.created", properties: { info: { id: "child-1", parentID: "parent-1" } } };
    expect(mod.extractParentId(ev)).toBe("parent-1");
  });

  test("returns undefined when parentID is missing", async () => {
    const mod = await import("../src/index");
    const ev: OpenCodeEvent = { type: "session.created", properties: { info: { id: "main-1" } } };
    expect(mod.extractParentId(ev)).toBeUndefined();
  });
});
```

Run: `bun test tests/index.test.ts -t "extractParentId"`
Expected: FAIL

- [ ] **Step 3: Implement `extractParentId` and run the test**

既に Step 1 で追加済み。Run: `bun test tests/index.test.ts -t "extractParentId"`
Expected: PASS

- [ ] **Step 4: Wire modules in `plugin` function**

`src/index.ts` の `plugin` 関数内、watchdog 生成後に追加：

```typescript
  const subagentRegistry = new SubagentRegistry(clock);
  const paneManager = new PaneManager({
    registry: subagentRegistry,
    config: config.subagentDisplay,
    spawn: bunSpawn(),
    which: bunWhich(),
    env,
    serverUrl: input.serverUrl ?? "",
    directory: inputDir,
    log: instLog,
    debugLog,
    clock,
  });
  const sessionTerminator = new SessionTerminator({
    registry: subagentRegistry,
    config: config.subagentTermination,
    client: input.client,
    log: instLog,
    clock,
  });
```

`import` 文を追加：

```typescript
import { SubagentRegistry } from "./subagent-registry";
import { PaneManager } from "./pane-manager";
import { SessionTerminator } from "./session-terminator";
```

`PluginInputLike` インターフェースを拡張して `serverUrl` を追加：

```typescript
interface PluginInputLike {
  client?: unknown;
  directory?: string;
  worktree?: string;
  serverUrl?: string;
}
```

- [ ] **Step 5: Modify event hook**

既存の `session.created` / `session.updated` 無視ブロックを以下に置き換える：

```typescript
        if (event.type === "session.created") {
          const childId = sessionId;
          const parentId = extractParentId(event);
          if (childId && parentId) {
            subagentRegistry.register(childId, parentId);
            instLog("info", `Subagent registered: ${childId.slice(0, 4)}… parent=${parentId.slice(0, 4)}…`);
            await paneManager.onChildCreated(childId);
          } else {
            instLog("info", `Event ignored (informational session event)`);
          }
          return;
        }

        if (event.type === "session.updated") {
          instLog("info", `Event ignored (informational session event)`);
          return;
        }
```

`session.deleted` / `session.idle` 処理ブロックを置き換える：

```typescript
        if (event.type === "session.deleted" || event.type === "session.idle") {
          instLog("info", `Stop event received for session ${sessionId}`);
          if (sessionId) {
            if (event.type === "session.idle" && subagentRegistry.has(sessionId)) {
              await paneManager.closePane(sessionId);
              sessionTerminator.onChildIdle(sessionId);
            } else if (event.type === "session.deleted" && subagentRegistry.has(sessionId)) {
              await paneManager.closePane(sessionId);
              await sessionTerminator.onSessionDeleted(sessionId);
            }
            watchdog.stop(sessionId);
          }
          return;
        }
```

`session.error` 処理ブロックを拡張：

```typescript
        if (event.type === "session.error") {
          instLog("info", `Error event received for session ${sessionId}`);
          if (sessionId) {
            if (subagentRegistry.has(sessionId)) {
              await paneManager.closePane(sessionId);
              sessionTerminator.onChildError(sessionId);
            }
            const route = routeSessionError(event.properties);
            if (route.action === "note") {
              watchdog.noteError(sessionId, route.reason);
            } else {
              watchdog.stop(sessionId);
            }
          }
          return;
        }
```

親 assistant 活動検出：activity 分岐（`watchdog.onActivity` 呼び出し箇所）で、呼び出し直前または直後に `sessionTerminator.onParentActivity(sessionId)` を呼ぶ。ただし arm-lock 早期 return より前に入れると ping 後の稀なケースで勝手に削除される可能性があるため、arm-lock を通過した assistant 活動イベントに限定する（`// --- Assistant Activity & Other Events (Priority 4) ---` 内、各 `watchdog.onActivity` 呼び出しの直前 / 直後）。

`message.part.delta` 内：

```typescript
            instLog("info", `Event triggered onActivity (stream delta) for session ${sessionId}`);
            debugLog(`ACTION onActivity (delta) sessionId=${sessionId} agentName=${agentName}`);
            await sessionTerminator.onParentActivity(sessionId);
            watchdog.onActivity(sessionId, { agentName });
            return;
```

`message.part.updated` assistant 分岐内：

```typescript
            instLog(
              "info",
              `Event triggered onActivity (assistant part update) for session ${sessionId}`,
            );
            debugLog(`ACTION onActivity (part) sessionId=${sessionId} agentName=${agentName}`);
            await sessionTerminator.onParentActivity(sessionId);
            watchdog.onActivity(sessionId, { agentName });
            return;
```

`message.updated` assistant 分岐内：

```typescript
          if (info?.role === "assistant") {
            instLog("info", `Event triggered onActivity (assistant message update) for session ${sessionId}`);
            await sessionTerminator.onParentActivity(sessionId);
            watchdog.onActivity(sessionId, { agentName: extractAgentName(event) });
            return;
          }
```

- [ ] **Step 6: Update dispose**

`dispose` 内に `sessionTerminator.dispose()` を追加：

```typescript
      try {
        sessionTerminator.dispose();
      } catch (err) {
        instLog("warn", `Error disposing session terminator: ${String(err)}`);
      }
```

- [ ] **Step 7: Run tests**

Run: `bun test tests/index.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat: wire SubagentRegistry, PaneManager, SessionTerminator into event router"
```

---

### Task 6: 統合テストと受け入れ条件

**Files:**
- Create: `tests/subagent-integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import plugin from "../src/index";

describe("subagent integration", () => {
  function makeClient(deletions: string[]) {
    return {
      session: {
        delete: async ({ path }: { path: { id: string } }) => {
          deletions.push(path.id);
          return {};
        },
      },
    };
  }

  async function setup(deletions: string[]) {
    const calls: { cmd: string[] }[] = [];
    const logs: string[] = [];
    const hooks = await plugin(
      {
        client: makeClient(deletions),
        directory: "/tmp/project",
        serverUrl: "http://localhost:8080",
      },
      {
        experimental: {
          watchdog: {
            subagentDisplay: { enabled: true, maxPanes: 4 },
            subagentTermination: { enabled: true, graceMs: 60_000, keepOnError: true },
          },
        },
      },
    );
    return { hooks, calls, logs };
  }

  test("root session is not displayed nor deleted", async () => {
    const deletions: string[] = [];
    const { hooks } = await setup(deletions);
    await hooks.event({
      event: { type: "session.created", properties: { info: { id: "root-1" } } },
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "root-1" } },
    });
    expect(deletions).toHaveLength(0);
  });

  test("child idle followed by parent assistant activity deletes child once", async () => {
    const deletions: string[] = [];
    const { hooks } = await setup(deletions);
    await hooks.event({
      event: { type: "session.created", properties: { info: { id: "child-1", parentID: "parent-1" } } },
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "child-1" } },
    });
    expect(deletions).toHaveLength(0);
    await hooks.event({
      event: { type: "message.updated", properties: { info: { id: "m1", sessionID: "parent-1", role: "assistant" } } },
    });
    expect(deletions).toEqual(["child-1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/subagent-integration.test.ts`
Expected: FAIL（spawn モックが注入できないため、実際の tmux / opencode attach が走る。統合テストで PaneManager の spawn を差し替える必要がある）

- [ ] **Step 3: Decide how to mock spawn in integration tests**

`plugin` 関数は内部で `bunSpawn()` / `bunWhich()` を固定で呼んでいる。統合テストで外部コマンドをモック化するには、`_watchdog` と同様に DI ポイントを追加するのが最もクリーン。

`PluginInputLike` に `serverUrl` を追加したのと同じく、options に `_paneManagerDeps?: Partial<PaneManagerDeps>` のようなエスケープハッチを追加するか、または `_spawn?: SpawnFn`, `_which?: WhichFn` を追加する。

設計指針：既存 `_watchdog` パターンに倣い、`options` に `_spawn?: SpawnFn` と `_which?: WhichFn` を追加し、`PaneManager` 生成時に優先使用する。

`src/index.ts` の `plugin` 関数内：

```typescript
  const paneManager = new PaneManager({
    ...
    spawn: (options as { _spawn?: SpawnFn })._spawn ?? bunSpawn(),
    which: (options as { _which?: WhichFn })._which ?? bunWhich(),
    ...
  });
```

`SpawnFn`, `WhichFn` の import を `src/notifier.ts` から追加。

- [ ] **Step 4: Update integration test with mocks**

```typescript
async function setup(deletions: string[]) {
  const calls: { cmd: string[] }[] = [];
  const logs: string[] = [];
  const hooks = await plugin(
    {
      client: makeClient(deletions),
      directory: "/tmp/project",
      serverUrl: "http://localhost:8080",
    },
    {
      experimental: {
        watchdog: {
          subagentDisplay: { enabled: true, maxPanes: 4 },
          subagentTermination: { enabled: true, graceMs: 60_000, keepOnError: true },
        },
      },
      _spawn: async (cmd) => {
        calls.push({ cmd });
        return { exitCode: 0, stdout: cmd[0] === "tmux" && cmd[1] === "split-window" ? "%42" : "" };
      },
      _which: (b) => (b === "tmux" ? "/usr/bin/tmux" : null),
    },
  );
  return { hooks, calls, logs };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/subagent-integration.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: PASS（202 tests）

- [ ] **Step 7: Type check and build**

Run: `bun run typecheck`
Expected: no errors

Run: `bun run build`
Expected: `dist/index.js` 生成完了

- [ ] **Step 8: Commit**

```bash
git add src/index.ts tests/subagent-integration.test.ts
git commit -m "test: add subagent integration tests and DI hooks"
```

---

### Task 7: ドキュメント更新

**Files:**
- Modify: `README.md`
- Modify: `SPEC.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update `README.md` 機能一覧と設定表**

`README.md` の Features セクション末尾に追加：

```markdown
- 🔲 **Subagent Live Display**: `parentID` を持つ子セッションを tmux ペインに即時表示（`opencode attach --mini`）。最大 4 ペイン、最古 evict。
- 🗑️ **Subagent Auto-Cleanup**: 子セッションが idle しても即削除せず、親の活動再開または grace タイムアウト後に `session.delete` を 1 回だけ実行。`error` 終了の子は保持可能。
```

環境変数表の末尾に追加：

```markdown
| `OPENCODE_WATCHDOG_SUBAGENT_DISPLAY` | サブエージェント自動表示の有効化 | `false` |
| `OPENCODE_WATCHDOG_SUBAGENT_MAX_PANES` | 同時表示ペイン上限 | `4` |
| `OPENCODE_WATCHDOG_SUBAGENT_DELETE` | 完了時セッション削除の有効化 | `false` |
| `OPENCODE_WATCHDOG_SUBAGENT_DELETE_GRACE_MS` | 削除の grace タイムアウト | `60000` |
| `OPENCODE_WATCHDOG_SUBAGENT_KEEP_ON_ERROR` | error 終了の子を残すか | `true` |
```

`opencode.jsonc` 設定例の `experimental.watchdog` 内に追加：

```jsonc
      "subagentDisplay": {
        "enabled": true,
        "maxPanes": 4
      },
      "subagentTermination": {
        "enabled": true,
        "graceMs": 60000,
        "keepOnError": true
      }
```

- [ ] **Step 2: Update `SPEC.md` と `AGENTS.md`**

`SPEC.md` と `AGENTS.md` に以下を反映：
- 新モジュールの責務（`subagent-registry.ts`, `pane-manager.ts`, `session-terminator.ts`）。
- 新しい env 変数と `experimental.watchdog` 設定キー。
- 受け入れ条件（上記 8 項目を簡潔に）。
- OmO 併用時の tmux 表示排他制約。
- 結果取りこぼし防止（idle 即削除禁止）の理由。

- [ ] **Step 3: Verify markdown lint**

Run: `markdownlint-cli2 README.md SPEC.md AGENTS.md`（利用可能なら）
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add README.md SPEC.md AGENTS.md
git commit -m "docs: document subagent display and termination features"
```

---

## Self-Review

### 1. Spec coverage

| 設計書 / 要件書 セクション | 担当 Task |
|---|---|
| D-1 in-memory registry | Task 1 |
| D-2 `--mini` attach | Task 3 |
| D-3 parent-resume + grace | Task 4 |
| D-4 config ノブ削減 | Task 2（既存 `config.ts` 拡張） |
| FR-1 表示（上限 4 / evict / argv 渡し） | Task 3 |
| FR-2 削除（親再開 / grace / keepOnError） | Task 4 |
| FR-3 停止時ペイン後始末 | Task 3 + Task 5 |
| 8 受け入れ条件 | Task 6（統合テスト） |
| OmO 排他 | Task 7（ドキュメント）+ Task 3（二重 spawn は起こさない設計） |

### 2. Placeholder scan

- TBD/TODO/実装後の「適宜」は含まない。
- すべての code step に実際の TypeScript コードを含んだ。
- すべての test step に実際のテストコードを含んだ。
- 参照型（`SubagentRecord`, `PaneManagerDeps`, `SessionTerminatorDeps`）は Task 1〜4 で定義済み。

### 3. Type consistency

- `SubagentRegistry.findOldestPaneToEvict()` → `PaneManager` で使用。
- `SubagentRegistry.getPendingChildrenOf(parentId)` → `SessionTerminator` で使用。
- `SubagentRegistry.setPaneId` / `clearPaneId` → `PaneManager` で使用。
- `WatchdogConfig["subagentDisplay"]` / `["subagentTermination"]` → 既存 config.ts に定義済み。
- 全 `sessionId` マスクは `.slice(0, 4)` で統一。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-04-subagent-display-and-termination.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
   - **REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development`

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.
   - **REQUIRED SUB-SKILL:** `superpowers:executing-plans`

**Which approach?**
