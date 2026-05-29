# デザインスペック: src/config.ts の不具合修正

## 1. 目的
`src/config.ts` における設定解析および型定義に関する3つの問題を修正し、堅牢性とユーザー体験を向上させる。

## 2. 修正内容

### 2.1 Issue 1: `parseBool` の改善
- **問題**: `TRUE`, `yes` などの値を無視し、不正値に対して警告を出さない。
- **解決策**:
    - 引数に `key` と `warn` を追加。
    - 入力を小文字化して判定。
    - 対応値: `true`, `yes`, `1` (true) / `false`, `no`, `0` (false)。
    - 未知の値に対しては `warn` を呼び出し `undefined` を返す。

### 2.2 Issue 2: `project.tmux` の型定義の修正
- **問題**: 交差型の解決順序により、`project.tmux` に部分的なオブジェクトを渡すとコンパイルエラーになる。
- **解決策**:
    - `Omit` を使用して `WatchdogConfig` から `tmux` と `agents` を除外したものを `Partial` にし、改めてネストされたプロパティを `Partial` として定義する。

### 2.3 Issue 3: `parsePositiveInt` の境界値判定
- **問題**: 「正の整数」を期待しながら `0` を許容している。
- **解決策**:
    - 判定条件を `n < 0` から `n <= 0` に変更。
    - `validateNumber` も同様に修正。

## 3. 影響範囲
- `src/config.ts` 内の内部関数および `ConfigSources` インターフェース。
- `resolveConfig` の呼び出し側（テストコードを含む）。

## 4. 変更案 (コードイメージ)

```typescript
// Issue 2
export interface ConfigSources {
  project?: Partial<Omit<WatchdogConfig, "tmux" | "agents">> & {
    tmux?: Partial<WatchdogConfig["tmux"]>;
    agents?: Partial<WatchdogConfig["agents"]>;
  };
  env?: Record<string, string | undefined>;
}

// Issue 3
function parsePositiveInt(value: string | undefined, key: string, warn: WarnFn): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) { // <= 0 に修正
    warn(`[watchdog] Invalid value for ${key}: "${value}". Falling back to default.`);
    return undefined;
  }
  return n;
}

// Issue 1
function parseBool(value: string | undefined, key: string, warn: WarnFn): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  if (v === "true" || v === "yes" || v === "1") return true;
  if (v === "false" || v === "no" || v === "0") return false;

  warn(`[watchdog] Invalid value for ${key}: "${value}". Falling back to default.`);
  return undefined;
}
```

## 5. 検証計画
- `tests/config.test.ts` (存在すれば) または新規テストを作成し、以下のケースを確認する。
    - `OPENCODE_WATCHDOG_ENABLED=FALSE` が正常に `false` と判定され、警告が出ないこと。
    - `OPENCODE_WATCHDOG_ENABLED=invalid` で警告が出ること。
    - `project: { tmux: { enabled: false } }` が型エラーなしでコンパイルできること。
    - `OPENCODE_WATCHDOG_MAX_PINGS=0` で警告が出てデフォルト値になること。
