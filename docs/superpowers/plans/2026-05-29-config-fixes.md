# src/config.ts 不具合修正 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `src/config.ts` における `parseBool` の挙動改善、`ConfigSources` の型定義修正、および `parsePositiveInt` の境界値チェックの厳格化を完了する。

**Architecture:** 
1. `parseBool` に警告機能と柔軟な文字列判定を追加。
2. `ConfigSources.project` の型を `Omit` と `Partial` を組み合わせて再定義し、ネストしたプロパティの部分指定を可能にする。
3. `parsePositiveInt` と `validateNumber` のガード条件を `0` を含めるように修正。

**Tech Stack:** TypeScript, Bun (tests)

---

### Task 1: `parsePositiveInt` と `validateNumber` の境界値チェック修正 (Issue 3)

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: 境界値 0 で失敗するテストを追加**

```typescript
// tests/config.test.ts に追加
  test("invalid 0 falls back to default with warn", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { project: { stage1Ms: 0 } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.stage1Ms).toBe(180_000);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("env OPENCODE_WATCHDOG_MAX_PINGS=0 falls back to default", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { env: { OPENCODE_WATCHDOG_MAX_PINGS: "0" } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.maxPings).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bun test tests/config.test.ts`
Expected: FAIL (境界値 0 が通過してしまい、デフォルト値に戻らない)

- [ ] **Step 3: 境界値チェックの修正**

```typescript
// src/config.ts

function parsePositiveInt(value: string | undefined, key: string, warn: WarnFn): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  // n < 0 を n <= 0 に変更
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    warn(`[watchdog] Invalid value for ${key}: "${value}". Falling back to default.`);
    return undefined;
  }
  return n;
}

function validateNumber(
  value: number | undefined,
  key: string,
  warn: WarnFn,
): number | undefined {
  if (value === undefined) return undefined;
  // value < 0 を value <= 0 に変更
  if (!Number.isFinite(value) || value <= 0) {
    warn(`[watchdog] Invalid value for ${key}: ${value}. Falling back to default.`);
    return undefined;
  }
  return value;
}
```

- [ ] **Step 4: テストを実行してパスすることを確認**

Run: `bun test tests/config.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "fix(config): ensure parsePositiveInt and validateNumber reject zero"
```

---

### Task 2: `ConfigSources` の型定義修正 (Issue 2)

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (コンパイル確認)

- [ ] **Step 1: 型エラーを再現するテストケースを追加**

```typescript
// tests/config.test.ts に追加
  test("allows partial tmux config in project", () => {
    // 現在の型定義ではこれがコンパイルエラーになる
    const sources: ConfigSources = {
      project: {
        tmux: { enabled: false }
      }
    };
    const cfg = resolveConfig(sources);
    expect(cfg.tmux.enabled).toBe(false);
    expect(cfg.tmux.displayMessage).toBe(true); // default preserved
  });
```

- [ ] **Step 2: 型チェックを実行して失敗を確認**

Run: `bun x tsc --noEmit`
Expected: FAIL (Property 'displayMessage' is missing in type '{ enabled: false; }' but required in type '{ enabled: boolean; displayMessage: boolean; highlightWindow: boolean; }'.)

- [ ] **Step 3: `ConfigSources` インターフェースの修正**

```typescript
// src/config.ts

export interface ConfigSources {
  project?: Partial<Omit<WatchdogConfig, "tmux" | "agents">> & {
    tmux?: Partial<WatchdogConfig["tmux"]>;
    agents?: Partial<WatchdogConfig["agents"]>;
  };
  env?: Record<string, string | undefined>;
}
```

- [ ] **Step 4: 型チェックを実行してパスすることを確認**

Run: `bun x tsc --noEmit`
Expected: PASS

- [ ] **Step 5: テストを実行して実行時挙動を確認**

Run: `bun test tests/config.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "fix(config): allow partial tmux and agents config in project source"
```

---

### Task 3: `parseBool` の挙動改善 (Issue 1)

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: 柔軟な真偽値判定と警告のテストを追加**

```typescript
// tests/config.test.ts に追加
  test("parseBool handles TRUE/FALSE case-insensitively", () => {
    expect(resolveConfig({ env: { OPENCODE_WATCHDOG_ENABLED: "TRUE" } }).enabled).toBe(true);
    expect(resolveConfig({ env: { OPENCODE_WATCHDOG_ENABLED: "FALSE" } }).enabled).toBe(false);
  });

  test("parseBool handles yes/no", () => {
    expect(resolveConfig({ env: { OPENCODE_WATCHDOG_ENABLED: "yes" } }).enabled).toBe(true);
    expect(resolveConfig({ env: { OPENCODE_WATCHDOG_ENABLED: "no" } }).enabled).toBe(false);
  });

  test("parseBool warns on invalid value", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { env: { OPENCODE_WATCHDOG_ENABLED: "maybe" } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.enabled).toBe(true); // default
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("OPENCODE_WATCHDOG_ENABLED");
  });
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bun test tests/config.test.ts`
Expected: FAIL (`TRUE`, `yes` などが `undefined` になり、警告も出ない)

- [ ] **Step 3: `parseBool` の実装変更と呼び出し側の修正**

```typescript
// src/config.ts

function parseBool(value: string | undefined, key: string, warn: WarnFn): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  if (v === "true" || v === "yes" || v === "1") return true;
  if (v === "false" || v === "no" || v === "0") return false;

  warn(`[watchdog] Invalid value for ${key}: "${value}". Falling back to default.`);
  return undefined;
}

// resolveConfig 内の呼び出しを修正
export function resolveConfig(
  sources: ConfigSources,
  warn: WarnFn = (msg) => console.warn(msg),
): WatchdogConfig {
  const env = sources.env ?? {};
  // ...
  const envEnabled = parseBool(env.OPENCODE_WATCHDOG_ENABLED, "OPENCODE_WATCHDOG_ENABLED", warn);
  // ...
}
```

- [ ] **Step 4: テストを実行してパスすることを確認**

Run: `bun test tests/config.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "fix(config): improve parseBool flexibility and add warnings for invalid values"
```
