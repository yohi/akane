# Akane 拡張ロードマップ 設計（Phase 1–3）

- 作成日: 2026-05-31
- 対象: Akane watchdog/pinger プラグイン（Bun + TypeScript）
- ステータス: 承認済み（実装計画へ移行）

## 0. 背景と前提の確定

タスク記述は古いスナップショットを前提にしていたため、実コードとの差分を以下に確定する。

1. **Notifier はすでに抽象化済みでシグネチャがリッチ**
   実コードの `Notifier` は次の契約を持つ。タスク記述の `notify(message: string)` はこれの上位互換とみなし、**既存のリッチ IF を維持**する。
   ```ts
   notify(sessionId: string, stage: NotifierStage, message: string): Promise<void>;
   clear(sessionId: string): Promise<void>;
   ```
2. **`opencode.jsonc` は存在しない**。設定は OpenCode プラグインの `options`（`readProjectConfig`）+ 環境変数経由で `resolveConfig` に流れる。`notifierType` もこの経路に乗せる。
3. **`session.error` のペイロードは現在破棄されている**。`index.ts` は `session.error` で `watchdog.stop(sessionId)` を呼ぶのみ。Phase 3 ではここを「捕捉 → Watchdog 保持 → Pinger プロンプト注入」まで配線する。
4. **`Clock` に `setInterval` は無い**（`setTimeout`/`clearTimeout`/`now` のみ）。定期レポートは Clock を変更せず、自己再スケジュールする `setTimeout` ループで実装し、`FakeClock` でテスト可能にする。

## 1. 依存グラフと実装順序

```
config.ts (notifierType 追加)
  → notifier.ts (OSNotifier + createNotifier Factory)
  → telemetry.ts (新規 TelemetryCollector / NoopTelemetry)
  → errors.ts (新規 classifyError / HangReason / reasonToJa)
  → pinger.ts (inject context 拡張 + buildPingPrompt)
  → watchdog.ts (telemetry 配線 + noteError + recovery 検出)
  → index.ts (Factory 配線 + error 分類ルーティング + 定期レポート)
  → tests/ (全フェーズ)
```

## 2. Phase 1 — Notifier 抽象化 + OSNotifier + Factory

既存リッチ IF（`notify(sessionId, stage, message)` / `clear(sessionId)`）を維持し、OSNotifier もこの契約に準拠させる。

### 2.1 OSNotifier（`src/notifier.ts` に追加）
- `class OSNotifier implements Notifier`
- deps: `{ platform: string; spawn: SpawnFn; which: WhichFn; log?: (level, message) => void }`
  - 既存 `SpawnFn` / `WhichFn` / `SpawnResult` 型を再利用（DI による単体テスト容易性を踏襲）。
- 検出ロジック（TmuxNotifier の `detection: "unknown" | "ok" | "disabled"` パターン踏襲）:
  - `platform === "darwin"` → `osascript` を使用
  - それ以外 → `which("notify-send")` を解決。null なら無効化
  - どちらも不可なら **静かに無効化**（throw しない）
- `notify(sessionId, stage, message)`:
  - stage → 緊急度マップ: `warn → normal`、`critical → critical`、`silenced → critical`
  - Linux: `["notify-send", "-u", urgency, "Akane Watchdog", message]`
  - macOS: `["osascript", "-e", 'display notification "<message>" with title "Akane Watchdog"']`
    - message 内のダブルクォートはエスケープ（`"` → `\"`）。引数は配列渡しのみ（シェル経由禁止、injection 回避）。
- `clear(sessionId)`: **no-op**（OS 通知は一過性。消去対象なし）。常に解決。
- 失敗時は `safeSpawn` 相当で握り潰し、`log("warn", ...)`。

### 2.2 Factory（`src/notifier.ts` に追加）
- `createNotifier(type: NotifierType, deps): Notifier`
  - `type === "tmux"` → `new TmuxNotifier(...)`、`type === "os"` → `new OSNotifier(...)`
  - deps は両 Notifier の依存を内包する型（`env` / `spawn` / `which` / `platform` / `log`）。

### 2.3 Config（`src/config.ts`）
- `WatchdogConfig` に `notifierType: NotifierType`（`"tmux" | "os"`）を追加。デフォルト `"tmux"`。
- `DEFAULT_CONFIG.notifierType = "tmux"`。
- env `OPENCODE_WATCHDOG_NOTIFIER_TYPE` で上書き。
- バリデーション: 値が `"tmux"`/`"os"` 以外なら warn + 下位ソースへフォールバック（既存 `parseBool`/`parsePositiveInt` と同様の様式で `parseNotifierType` を追加）。
- 優先順位は既存規約どおり: env > project > default。

### 2.4 配線（`src/index.ts`）
- `new TmuxNotifier({...})` を `createNotifier(config.notifierType, { env, spawn: bunSpawn(), which: bunWhich(), platform: process.platform, log: instLog })` に置換。

## 3. Phase 2 — TelemetryCollector

### 3.1 `src/telemetry.ts`（新規）
- `interface Telemetry`:
  - `recordHangup(): void`
  - `recordPing(): void`
  - `recordRecovery(): void`
  - `recordFailure(): void`
  - `snapshot(): TelemetrySnapshot`
  - `report(): string`
- `interface TelemetrySnapshot { hangupsDetected; pingsSent; recoveries; silencedFailures; recoveryRate: number | null }`
- `class TelemetryCollector implements Telemetry`:
  - 4 カウンタを保持。
  - `recoveryRate = recoveries / (recoveries + silencedFailures)`。分母 0 のとき `null`。
  - `report()` は人間可読な 1 行サマリ文字列（例: `[Telemetry] hangups=3 pings=4 recoveries=2 failures=1 recoveryRate=66.7%`）。
- `class NoopTelemetry implements Telemetry`: 全メソッド no-op、`snapshot()` はゼロ値、`report()` は空相当。既存テスト非破壊のための既定実装。

### 3.2 Watchdog 配線（`src/watchdog.ts`）
- `WatchdogDeps` に `telemetry?: Telemetry` を追加。未指定時は `new NoopTelemetry()`。
- フック箇所:
  - `onStage1Expire`（アイドル検出 = hang-up）→ `telemetry.recordHangup()`
  - `onStage2Expire` の ping 注入直前 → `telemetry.recordPing()`
  - **recovery 検出**: `armOrReset` で、既存 entry が `pingCount > 0` かつ `state !== "SILENCED"` の場合、pingCount を 0 にリセットする**前**に `telemetry.recordRecovery()` を呼ぶ（ping 後に活動が復帰したことを意味する）。
  - SILENCED 遷移時（`onStage2Expire` の else 枝）→ `telemetry.recordFailure()`。

### 3.3 定期レポートと graceful shutdown（`src/index.ts`）
- 自己再スケジュールする `clock.setTimeout` ループで `report()` を定期出力。
  - 間隔: 既定 60_000ms、env `OPENCODE_WATCHDOG_REPORT_MS`（正整数バリデーション）で上書き。
  - 出力先: `instLog("info", telemetry.report())`（既存ログ基盤に乗せ stdout/ファイルへ）。
- `dispose()`: `watchdog.stopAll()` の後に最終 `telemetry.report()` を出力し、レポートタイマーを `clock.clearTimeout` で解除。

## 4. Phase 3 — エラー解析サポート

### 4.1 `src/errors.ts`（新規）
- `type HangReason = "rate_limit" | "provider_timeout" | "unknown"`
- `classifyError(payload: unknown): HangReason | null`
  - payload の `name` / `message` / `error` 文字列に対するヒューリスティック:
    - `/rate.?limit|429|too many requests/i` → `"rate_limit"`
    - `/timeout|timed out|etimedout|deadline/i` → `"provider_timeout"`
    - その他で抽出可能なエラーがあれば `"unknown"`、抽出不能なら `null`
- `reasonToJa(reason: HangReason): string`
  - `rate_limit` → 「APIレート制限に到達しました」
  - `provider_timeout` → 「プロバイダ応答がタイムアウトしました」
  - `unknown` → 「原因不明のエラーが発生しました」

### 4.2 index.ts ルーティング改修
- `session.error` 受信時に `classifyError(properties)` を実行:
  - **recoverable**（`rate_limit` / `provider_timeout`）→ `watchdog.noteError(sessionId, reason)` を呼び、**`stop()` を呼ばない**。アイドル→ping フローを継続させ、理由を次の ping に乗せる。
  - **terminal / 分類不能（`unknown` / `null`）** → 従来どおり `watchdog.stop(sessionId)`。
- `session.deleted` / `session.idle` のルーティングは不変（従来どおり `stop()`）。
- 補足: `stop()` 自体のロジックは不変。recoverable / terminal の振り分けは index.ts に集約する。これが Q&A の「stop() 従来通り」の正確な範囲。

#### recoverable エラーの扱い（継続監視と終端遷移）

- **継続監視**: `classifyError` が recoverable（`rate_limit` / `provider_timeout`）と判定した場合、index.ts は `watchdog.noteError(sessionId, reason)` を呼ぶのみで `stop()` を呼ばない。Watchdog の状態機械は停止されず、既存のアイドル検出（stage1）→ ping（stage2）フローがそのまま継続する。`noteError` で保持した `lastErrorReason` は次の ping の `buildPingPrompt` に乗り、エージェントへ「なぜハングしたか」を伝える。
- **エラー継続時の終端遷移**: recoverable エラーが解消されず ping への応答も無いまま `onStage2Expire` が `maxPings`（既定 1）に達した場合、状態機械は従来どおり SILENCED へ遷移し、`telemetry.recordFailure()` 相当が走り、以降の ping は送られない（`watchdog.stop()` 相当でタイマーを停止）。すなわち recoverable であっても無限に ping し続けることはなく、上限は既存の `maxPings` で頭打ちになる。
- **検証項目（リソース消費の上界）**: recoverable ルートで監視を継続する際の最大リソース消費を検証する。1 セッションあたりの追加 ping 回数は `maxPings` を超えず、SILENCED までの最大監視時間は概ね `stage1Ms + maxPings × stage2Ms` で上界が定まることをテストで確認する（タイマーリークが無いことは `FakeClock.pendingTimerCount()` で担保 / 設計 §7.4）。

### 4.3 Watchdog（`src/watchdog.ts`）
- `SessionEntry` に `lastErrorReason?: HangReason` を追加。
- `noteError(sessionId: string, reason: HangReason): void`:
  - `sessions.get(sessionId)` で取得した既存 entry に対してのみ `lastErrorReason` を更新する。
  - entry が無いセッション（監視対象外 / タイマー未武装）は**何も保持せず早期リターン**する。別ストレージや tombstone への退避は行わない（メモリリーク防止 / 副作用を `sessions` Map に限定）。これにより、`buildPingPrompt(this.config.pingMessage, entry.lastErrorReason)` と `pinger.inject(sessionId, prompt, { reason: entry.lastErrorReason })` は常に既存 entry に対して一貫して動作する。
  - 停止済みセッション（tombstone）は `stoppedSessions` を見て無視する。
- ping 注入時: `buildPingPrompt(this.config.pingMessage, entry.lastErrorReason)` を生成して `pinger.inject(sessionId, prompt, { reason: entry.lastErrorReason })` へ渡す。

### 4.4 Pinger（`src/pinger.ts`）
- `interface Pinger`: `inject(sessionId: string, message: string, context?: PingContext): Promise<void>`
  - `interface PingContext { reason?: HangReason }`（任意引数 = 後方互換）。
- `buildPingPrompt(base: string, reason?: HangReason): string`（純粋関数、単体テスト対象）:
  - `reason` が無ければ `base` をそのまま返す。
  - あれば `base` の末尾に「\n\n[Watchdog] 直前に次のエラーを検出しました（Why it hung）: <reasonToJa(reason)>。これを踏まえて状況を立て直してください。」を追記。
- `MockPinger`: `calls` に `context` も記録する（`{ sessionId, message, context }`）。
- `OpenCodeAdapter`: `context` は SDK 呼び出しでは未使用（プロンプト本文に既に反映済みのため）。シグネチャ整合のみ。

## 5. テスト方針（`bun test`、devcontainer 内実行前提）

- **`tests/notifier.test.ts`**: OSNotifier（linux=notify-send / macOS=osascript / 両不可で無効化 / clear no-op / DI による spawn 捕捉 / 引数配列渡し）、`createNotifier` の型分岐。
- **`tests/config.test.ts`**: `notifierType` の default / project 上書き / env 上書き / 不正値フォールバック（warn 検証）。
- **`tests/telemetry.test.ts`（新規）**: カウンタ集計、`recoveryRate`（分母 0 で null）、`report()` 整形、`NoopTelemetry` のゼロ値。
- **`tests/watchdog.test.ts`**: telemetry フック発火（hangup/ping/recovery/silenced）、`noteError` 保存 + ping プロンプトへの reason 注入、recovery 検出（PINGED→活動復帰）。
- **`tests/pinger.test.ts`**: `buildPingPrompt` の reason 有無、`inject` の context 受け渡し（既存 `calls` 期待値を `context` 付きに更新）。
- **`tests/errors.test.ts`（新規）**: `classifyError`（rate_limit / timeout / unknown / null）、`reasonToJa`。
- **`tests/index.smoke.test.ts`**: `session.error` の recoverable（noteError 呼び・stop 非呼び）/ terminal（stop 呼び）ルーティング分岐。

## 6. 後方互換・制約

- Notifier IF・Watchdog 既存メソッドのシグネチャは不変（`telemetry` は任意 DI、ping `context` は任意引数）。
- 既存テストは原則非破壊。例外は `tests/pinger.test.ts` の `calls` 期待値のみ（`context` 記録に合わせて更新、範囲限定）。
- `any` 不使用、strict TypeScript 維持。
- 実行・テスト・静的解析はすべて `.devcontainer` 内前提（ホスト実行を前提にしない）。
- セキュリティ: 外部コマンドは配列引数渡しのみ。macOS の `osascript` 文字列はクォートエスケープを行う。

## 7. 未解決事項

- OpenCode の `session.error` ペイロードの正確な形状（`properties` 配下のキー名）。`classifyError` は構造に依存しないヒューリスティック（文字列走査）で堅牢化し、実ペイロードが判明したら `docs/SDK_NOTES.md` を更新してから精緻化する。
