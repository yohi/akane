# akane Watchdog: プロンプト注入ゲーティング設計 (Design Spec)

- **対象**: `@yohi/akane` OpenCode Watchdog プラグイン
- **作成日**: 2026-06-16
- **ステータス**: 設計確定（実装前）
- **関連**: [SPEC.md](../../../SPEC.md), [README.md](../../../README.md)

---

## 1. 背景と目的

現行の Watchdog は、ストリーム停止を検知すると `client.session.prompt()` で復旧 Ping を注入する。
この注入ロジックに 2 つの問題と、付随して 1 つの運用上の問題がある。

### 1.1 解決対象の問題

1. **#1 キューに溜まって意味がない**
   現行 `OpenCodeAdapter.inject` は legacy 形 `prompt({ path:{id}, body:{parts} })`（実質 `queue` 配信相当）で注入する。
   エージェントがハングして固まったターンの裏に Ping が積まれ、そのターンが処理されない限り Ping も処理されない＝**復旧効果がない**。

2. **#2 ユーザー応答待ち（Ask ツール等）でも注入される**
   現行検知は「ストリーム停止＝ハング」という単純なチャンクタイマー判定のみ。
   permission 承認待ち・question(Ask) 待ちといった**正常な沈黙**をハングと誤認し、Ping を注入してしまう。

3. **#3（付随）ログ肥大**
   `index.ts` が全イベントの完全 JSON をログ出力しているため、ログが **1.1GB / 93 万行**規模に肥大している（`message.part.delta` だけで 6 万件超）。

### 1.2 ゴール

- 復旧 Ping を `delivery:"steer"`（割り込み注入）で届け、固まったターンに実際に作用させる（#1）。
- permission/question 待ちの間は注入・警告エスカレーションを停止し、代わりに「入力待ち」通知を出す（#2）。
- `steer` 化に伴う「正当な長時間ツール実行の誤中断」を防ぐ（tool 実行を活性扱い＋ steer 抑止ゲート）。
- 高頻度イベントの完全 JSON ログを廃し、ログ肥大を抑制する（#3）。

### 1.3 非ゴール

- ハングしたツール（`bash` 等）自体の自動復旧（`steer` では不可。`abort` 採用は今回見送り）。
- session.status 駆動への検知コア全面再設計（案 B 不採用）。
- 通知バックエンドの追加（Slack 等）や履歴永続化（既存 SPEC の非ゴールを踏襲）。

---

## 2. 実証されたランタイムのイベント/API surface

本設計は、ユーザーの実稼働ログ（`~/opencode-watchdog.log` 直近テール）から**実測確認**した以下の事実に基づく。
SDK 型定義（`*.v2.*`）と実ランタイムのイベント名が食い違うため、**実ランタイムの名前を正**とする。

| 信号 | イベント type | ペイロード抽出 | 備考 |
|---|---|---|---|
| 稼働状態 | `session.status` | `properties.sessionID`, `properties.status.type` | `status.type` は `busy` / `idle` / `retry` |
| 承認要求 | `permission.asked` | `properties.id`(=`per_...`), `properties.sessionID` | `.v2.` ではない |
| 承認応答 | `permission.replied` | `properties.requestID`(=`per_...`), `properties.sessionID`, `properties.reply` | asked の `id` と requestID が対応 |
| 質問要求 | `question.asked` | `properties.id`(=`que_...`), `properties.sessionID` | Ask ツール使用時に発火 |
| 質問応答 | `question.replied` | `properties.requestID`, `properties.sessionID` | |
| ツール状態 | `message.part.updated` (`part.type==="tool"`) | `part.state.status`, `part.callID`, `properties.sessionID` | status: `pending`/`running`/`completed`/`error` |
| ストリーム | `message.part.delta` | `properties.sessionID`, `properties.messageID`, `properties.partID`, `properties.field`, `properties.delta` | 最高頻度。`agentName` 無し。`messageID` あり（自己 ping 除外に利用可） |

### 注入 API（#1 の修正対象）

- `client.session.prompt({ sessionID, prompt/parts, delivery: "steer" | "queue" })`。
- `delivery:"steer"` は進行中ターンに割り込んで即注入、`"queue"` は完了後配信（現行の事実上の挙動）。
- ランタイムの正確な `prompt` 形は**実装時に要確認**し、`OpenCodeAdapter` 内に隔離する（SPEC §8.2 方針）。非対応時は legacy 形へフォールバック。

### 設計上の重要な前提

- **真のハングは常に `busy` 状態**（`idle` に到達しないまま固まる）。したがって「busy なら抑止」は核心機能を殺すため不可。
  判別すべきは "permission/question pending"（ユーザー待ち）であって busy 一般ではない。
- `steer` は LLM ストリームのハングにのみ有効。tool ハングは `steer` では直せない（中断するだけ）。

---

## 3. 採用アプローチ: 加算型シグナル層（案 A）

実績ある chunk-timer ベースの Watchdog コアを温存し、新イベントを消費する薄い**シグナル追跡層**を加算する。
既存ロジックの破壊的変更は最小に留め、Zero-Crash 思想（SPEC §6）とグレースフルデグレードを維持する。

不採用案:

- **案 B（status 駆動再設計）**: `busy` がハングと長時間ツールを区別できず、結局 tool-awareness と chunk-timer が必要で複雑さが減らない。実績コアの大規模書き換えで回帰リスク大。
- **案 C（最小パッチ）**: tool-awareness と入力待ち通知を欠き、`steer` 単独でビルド誤中断の危険が残る。合意スコープ未達。

---

## 4. 拡張ステートマシン

現行 4 状態（`WATCHING` / `STAGE1_NOTIFIED` / `PINGED` / `SILENCED`）に `PAUSED` を追加する。

```text
                          activity (chunk / delta / tool-update)
   ┌──────────────────────────────────────────────────────┐
   │                                                        │
   ▼                                                        │
WATCHING ──stage1──▶ STAGE1_NOTIFIED ──stage2──▶ ◇ tool running?
   ▲   ▲                  (yellow)              ├─ yes ─▶ steer抑止 (critical通知/据え置き, 再スケジュール)
   │   │                                        └─ no ──▶ ◇ pingCount < max?
   │   │                                                  ├ yes ▶ PINGED (steer注入, red)
   │   │                                                  └ no  ▶ SILENCED (red)
   │   │                                                              │
   │   └──────────────── user message / *.replied ───────────────────┘
   │
   │  ┌─ (任意状態) ── permission.asked / question.asked ──▶ PAUSED ─┐
   └──┤                  [タイマー停止 + 「入力待ち」通知(cyan)]        │
      └◀── 全 *.replied で WATCHING 復帰 (stage1 再アーム + 通知クリア)─┘

  (任意状態) ── session.idle / session.error / session.deleted ──▶ IDLE(停止/tombstone)
  (任意状態) ── session.status:retry ──▶ escalation 抑止 ── status:busy / activity で復帰
```

### 2 つの核心ゲート

1. **#2 解消**: `*.asked` で `PAUSED` 化しタイマー停止。注入も警告エスカレーションも起きない。`*.replied` で復帰。
2. **#1 解消＋誤中断防止**: stage2 到達時、`runningTools` が非空なら **steer しない**（critical 通知のみ・pingCount 据え置き・stage2 再スケジュール）。

---

## 5. シグナル → アクション対応表

| 実イベント | 条件 | Watchdog アクション |
|---|---|---|
| `message.part.delta` | — | 活性（タイマー reset）。自己 ping(`IGNORED_PING_MESSAGE_IDS`)・arm-lock を経由 |
| `message.part.updated` | assistant | 活性（従来どおり） |
| `message.part.updated` | `part.type==="tool"`, `state.status==="running"` | `onToolRunning`（runningTools 追加 ＋ 活性） |
| `message.part.updated` | `part.type==="tool"`, `status` ∈ {`completed`,`error`} | `onToolSettled`（runningTools 削除 ＋ 活性） |
| `permission.asked` / `question.asked` | — | `onInputRequested`（pending 追加 → PAUSED、user message 同格で arm-lock バイパス） |
| `permission.replied` / `question.replied` | — | `onInputResolved`（pending 削除 → 空なら WATCHING 復帰） |
| `session.status` | `retry` | escalation 抑止 |
| `session.status` | `busy` / `idle` | 補助情報（停止は既存 `session.idle` を一次とする） |
| `session.idle` / `session.error` / `session.deleted` | — | 停止（従来どおり） |

---

## 6. コンポーネント別の変更内容

### 6.1 `watchdog.ts`

- `State` に `"PAUSED"` を追加。
- `SessionEntry` に `pendingRequests: Set<string>`（permission/question の id）、`runningTools: Set<string>`（tool callID）を追加。
- 新メソッド（permission と question は挙動同一のため統合）:
  - `onInputRequested(sessionId, requestId)`: pending に追加 → `PAUSED` 遷移、タイマー停止、初回のみ `notifier.notify(…, "waiting", …)`。
  - `onInputResolved(sessionId, requestId)`: pending から削除 → 空なら `armOrReset`（WATCHING 復帰・通知クリア）。
  - `onToolRunning(sessionId, callId)`: runningTools 追加 ＋ 活性扱い（`armOrReset`）。
  - `onToolSettled(sessionId, callId)`: runningTools 削除 ＋ 活性扱い。
- `onStage2Expire` に **steer 抑止ゲート**を追加: `runningTools.size > 0` なら `inject` せず・`pingCount` 据え置き・critical 通知（初回のみ。再スケジュール中は再通知しない＝OS通知スパム防止）・stage2 再スケジュール。
- `session.status:retry` 抑止フラグ（軽量）: retry 中は escalation せず、`busy`/活性で復帰。

### 6.2 `index.ts`（シグナル追跡層・追加の大半）

- `extractSessionId` に `session.status` / `permission.*` / `question.*` の case を追加（いずれも `properties.sessionID`）。
- 新ヘルパ `extractRequestId`（asked=`properties.id`、replied=`properties.requestID`）。
- イベントルーティング追加:
  - `message.part.delta` → 活性（既存 ping-ignore / arm-lock パイプライン経由。`messageID` で自己 ping 除外）。
  - `message.part.updated` で `part.type==="tool"` → `state.status` により `onToolRunning` / `onToolSettled`。
  - `permission.asked` / `question.asked` → `onInputRequested`（user message 同格の高優先＝ arm-lock バイパス）。
  - `permission.replied` / `question.replied` → `onInputResolved`。
  - `session.status` → `retry` 抑止 / `busy`・`idle` 補助。
- 優先順位: (1) user message / input(asked,replied) バイパス → (2) 自己 ping 除外 → (3) arm-lock（tool/delta は尊重） → (4) 活性。

### 6.3 `pinger.ts`（steer 配信 ＋ フォールバック）

- `OpenCodeAdapter.inject` を V2 形 `prompt({ sessionID, …, delivery })` で呼び、`delivery` を config から注入。
- runtime が `delivery` 非対応で失敗したら legacy 形（`{ path, body }`）へ try/catch フォールバック。
- `Pinger` インタフェースは不変。変更は adapter 内に隔離（SPEC §8.2）。

### 6.4 `notifier.ts`（「入力待ち」バリアント）

- `NotifierStage` に `"waiting"` を追加。
- Tmux: 非警告色（例 `bg=cyan`）。OS: urgency=low で「Agent is waiting for your input」。
- 外部コマンド引数は配列渡し（インジェクション耐性維持・SPEC §6）。

### 6.5 `config.ts`（最小限の新ノブ）

| キー | 既定 | env |
|---|---|---|
| `delivery` (`"steer"`/`"queue"`) | `"steer"` | `OPENCODE_WATCHDOG_DELIVERY` |
| `suppressPingWhileToolRunning` | `true` | `OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL` |
| `pauseOnInputRequest` | `true` | `OPENCODE_WATCHDOG_PAUSE_ON_INPUT` |
| `notifyWaiting` | `true` | `OPENCODE_WATCHDOG_NOTIFY_WAITING` |
| `verboseLog` | `false` | `OPENCODE_WATCHDOG_VERBOSE` |

- 不正値は warn ログで defaults へフォールバック（既存規約踏襲）。

### 6.6 ログ削減（#3）

- `index.ts` の `Event received: ${JSON.stringify(event)}` を廃し、種別で verbosity 分岐する `logEvent(event)` を導入:
  - 高頻度（`message.part.delta`, `message.part.updated`）→ 1 行要約のみ（`type` / `sessionID` / 必要なら part type・tool status）。
  - 状態遷移・判断・注入・エラーは従来どおり記録。
  - `verboseLog`（env opt-in）時のみ完全 JSON を出力。

### 6.7 `telemetry.ts`（任意）

- `inputWaits` / `steerSuppressedByTool` カウンタ追加で可観測性向上（スコープ任意）。

---

## 7. エッジケースと不変条件

- **pending 集合の境界**: `pendingRequests` はセッション単位で通常 1 件。`session.idle/error/deleted` でエントリごと破棄＝既存と同じ上界。`*.replied` が来なければ PAUSED 継続（＝本当に入力待ちなので正しい）。
- **tombstone 尊重**: `permission/question.asked` が停止済み（tombstone）セッションに遅延到達したら無視（idle 後の権限要求は stale）。tombstone 解除は user message のみ（SPEC §3.4 不変）。
- **arm-lock との関係**: `permission/question.*` は user message 同格で arm-lock バイパス。`delta`/`tool` は従来のアシスタント活性同様 arm-lock を尊重（ping 直後の stale 再アーム防止を維持）。
- **delta × 自己 ping**: delta の `messageID` を `IGNORED_PING_MESSAGE_IDS` と照合してスキップ。
- **PAUSED 中の停止**: PAUSED 中の `session.idle/error/deleted` は通常停止（エントリ破棄・tombstone・通知色クリア）。
- **tool ハングの割り切り（承認済み）**: `running` が永遠に解除されない tool は赤通知のまま・steer せず・自動回復なし。`steer` は tool ハングを直せないため人間に委ねる。

---

## 8. グレースフルデグレード（Zero-Crash 維持）

- 新イベントが来ない旧ランタイム → PAUSED / tool-gate / waiting 通知は発火せず、**今日と完全に同一挙動**（chunk-timer）。
- `delivery:"steer"` をランタイムが拒否 → adapter が catch して legacy queue prompt にフォールバック（#1 は今日と同等動作に縮退）。
- すべて既存の event-hook try/catch 内＝**絶対にプロセスを落とさない**。

---

## 9. テスト戦略

`bun test`（組み込み）のみ。fake Clock・DI モックで決定論的に検証（SPEC §7 準拠）。

| ファイル | 追加テスト |
|---|---|
| `watchdog.test.ts` | PAUSED 遷移（`onInputRequested` でタイマー停止＆ `waiting` 通知が初回 1 回）、複数 pending → 全 `Resolved` で WATCHING 復帰＆通知クリア、tool-gate（stage2 で tool running 中は inject されず critical 通知＋再スケジュール）、`onToolRunning/Settled` の活性扱い、retry 抑止、tombstone 尊重 |
| `index.test.ts` | `extractSessionId`（status/permission/question）、`extractRequestId`（id vs requestID）、ルーティング（asked→Requested / replied→Resolved / tool パート→Running/Settled / delta→活性）、delta 自己 ping 除外（messageID×IGNORED 集合）、arm-lock バイパス(input)/尊重(tool・delta) |
| `pinger.test.ts` | `delivery:"steer"` が V2 形で渡る、steer 失敗時に legacy へフォールバック |
| `notifier.test.ts` | `"waiting"` ステージ→ tmux 非警告色(cyan)・OS urgency=low、引数配列渡し |
| `config.test.ts` | 新ノブ（delivery / suppressPingWhileToolRunning / pauseOnInputRequest / notifyWaiting / verboseLog）＋ env ＋不正値フォールバック |
| `stress.test.ts` | permission/question/tool の churn 1000 セッションで `pendingRequests`/`runningTools` リークなし、idle 後に Map が 0 復帰 |
| (logging) | 高頻度イベントが完全 JSON ログされない（要約のみ）、`verboseLog` 時のみ完全出力 |

---

## 10. 受け入れ条件（追加分・SPEC §9 拡張）

1. permission/question pending 中は Ping 非注入＋「入力待ち」通知を出し、`*.replied` で通常監視へ復帰する。
2. stage2 で tool running 中は steer されない。tool 完了後は通常進行に戻る。
3. ハング注入は `delivery:"steer"` で行われ、非対応ランタイムでは legacy へ縮退する。
4. `message.part.delta` の完全 JSON がログ出力されない（ログ肥大抑制）。
5. 新イベントが来ない環境でも従来挙動を保ち、プロセスは落ちない。
6. 既存テストはすべて pass（回帰なし）。

---

## 11. 実装時の検証項目（要確認）

- ランタイムの `client.session.prompt` の正確な引数形（V2 `delivery` 対応可否）。`OpenCodeAdapter` 内で吸収。
- `message.part.delta` を活性に含めた場合の timer reset 頻度（必要ならスロットリングを検討。既定は素直に reset）。
- `session.status:idle` を補助停止に使うか（既定は既存 `session.idle` を一次とし二重処理を避ける）。

---

## 12. 影響範囲まとめ

- 変更ファイル: `watchdog.ts` / `index.ts` / `pinger.ts` / `notifier.ts` / `config.ts`（＋任意で `telemetry.ts`）。
- 新規概念: `PAUSED` 状態、`pendingRequests` / `runningTools`、`"waiting"` 通知、`logEvent` verbosity 分岐、`delivery` 設定。
- 後方互換: 旧ランタイム・steer 非対応時は現行挙動へ縮退。既存テストは維持。
