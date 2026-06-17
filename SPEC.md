# OpenCode Watchdog プラグイン設計仕様 (SPEC)

- **対象プロダクト**: OpenCode (sst/opencode, ホスト: anomalyco/opencode)
- **ランタイム**: Bun 1.3+
- **配布形態**: `@opencode-ai/plugin` 公式 API に準拠した TypeScript プラグイン

---

## 1. 背景と目的

### 1.1 課題
OpenCode のメインエージェントおよびサブエージェントにタスクを委譲した際、ストリーミング応答が止まったままハングアップする事象が観測されている。
ユーザーは TUI を凝視し続けるか、明示的にプロセスを中断するまで状態を把握できない。

### 1.2 ゴール
1. 各セッションのストリーム停止を一定時間内に検出する。
2. 一次対応として Tmux/TUI 通知で人間に知らせる。
3. 二次対応として自動的に Ping メッセージを注入し、エージェントの自己復旧を試みる。
4. 上記をプラグインとして実装し、OpenCode 本体には手を入れない。

### 1.3 非ゴール
- LLM プロバイダ側のハング原因の自動診断（タイムアウト判定までしか責務を持たない）。
- 完全な障害復旧（Ping で復旧しない場合は通知のみで人間の介入に委ねる）。
- 監視ダッシュボード・履歴永続化（将来拡張余地として残す）。

---

## 2. 統合方式

### 2.1 採用方式: `@opencode-ai/plugin` 公式プラグイン API
OpenCode の Plugin API (`event` フックや `client` SDK) を利用する。

**選択根拠**:
- `@/bus` の直接 import はモノレポ内部パスエイリアスであり、外部プラグインからは到達不能。
- OpenCode 本体の fork は保守追従コストが高く、長期運用に耐えない。
- 外部ラッパープロセス案はストリーミングチャンクの粒度で検出できず、「チャンク受信ベースのタイマーリセット」要件と整合しない。

### 2.2 監視対象イベント

| イベント | 用途 | 備考 |
|---|---|---|
| `message.updated` (role=user) | **初期タイマー起動トリガ**。空のメッセージシェル（parts なし）は無視し、実データ送信時に起動。 | ユーザー入力時の復帰トリガとしても機能する。 |
| `message.part.delta` | 活性シグナル。ストリームの受信毎にタイマーをリセット。 | `agentName` が非空（アシスタント応答）のみ活性扱い。自己 Ping delta は ID 除外。 |
| `message.part.updated` | 活性およびツール追跡シグナル。 | `part.type === "tool"` の場合、`status === "running"` で tool 追跡に追加、`status` が `completed`/`error` で削除。 |
| `permission.asked` / `question.asked` | 監視一時停止シグナル。セッションを `PAUSED` 状態へ移行。 | 監視タイマーを一時停止し、waiting 通知を発火。 |
| `permission.replied` / `question.replied` | 監視再開シグナル。 | 全ての pending されている入力要求が解消された場合に通常監視（`WATCHING`）へ復帰。 |
| `session.status` | 実行ステータス監視。 | `status.type === "retry"` で retry 抑止（タイマークリア）、`busy` または活性検出で抑止解除（`PAUSED` 優先）。 |
| `session.idle` | 正常終端。タイマーと内部状態を破棄。 | |
| `session.error` | 異常終端または recoverable エラー一時記録。 | recoverable な場合はエラー理由を記録し監視継続、その他は破棄し終了。 |
| `session.deleted` | セッション破棄。同上。 | |

---

## 3. アーキテクチャ

### 3.1 モジュール構成と責務境界

| モジュール | 責務 | 主な依存 |
|---|---|---|
| `config` | 設定ソースの優先順位解決・型安全な defaults。新機能向けの 5 つのノブ (`delivery`, `suppressPingWhileToolRunning`, `pauseOnInputRequest`, `notifyWaiting`, `verboseLog`) の解析・解決をサポート。 | なし (純粋関数) |
| `watchdog` | 各 sessionId のタイマー管理、状態遷移、活性検知、回復・ハング・ping テレメトリフック。新状態 `PAUSED` や、`pendingRequests`/`runningTools` セットを管理するゲーティング機構を追加。 | `Notifier`, `Pinger`, `Clock`, `Telemetry` (すべて DI) |
| `notifier` | Tmux / OS デスクトップ通知 (Factory経由で TmuxNotifier / OSNotifier を生成)。非警告色（cyan/low）の `waiting` 通知ステージを追加。 | `Bun.spawn`, `Bun.which`, `process` (OS判定用), `env` |
| `telemetry` | ハング・ping・回復・失敗の回数および回復率の収集、自己再スケジュール型定期レポートループ | `Clock` (タイマー用) |
| `errors` | `session.error` ペイロードのヒューリスティック解析によるエラー分類 (`HangReason` の抽出と日本語化) | なし |
| `pinger` | `Pinger` インタフェース定義と `OpenCodeAdapter` 実装。割り込み注入（`steer`）用 V2 形式と、スキーマ拒否時限定の legacy 形式への try/catch フォールバックを実装。 | OpenCode `client` SDK, `errors` |
| `clock` | `setTimeout` / `clearTimeout` の DI 化 | なし |
| `index` | プラグインエントリ。`event` のルーティング、重複起動防止、エラー種別に基づく制御。`logEvent` による要約ログ出力（ログ肥大抑制）を実装。 | 上記すべて |

### 3.2 状態マシンと遷移

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

- **状態の説明**:
  - `WATCHING`: 通常の監視状態。活性シグナル（`message.part.delta` やツールの更新など）を受信するたびに `stage1` タイマーが再アームされます。
  - `STAGE1_NOTIFIED`: `stage1` タイマーが満了した状態。黄色の Tmux/OS 通知を発火させ、`stage2` タイマーを起動します。
  - `PINGED`: `stage2` タイマーが満了し、Ping を送信（`steer` 注入）した状態。赤色の通知を出します。
  - `SILENCED`: Ping 注入数が最大値（`maxPings`）に達し、人手による復旧メッセージ入力を待機している状態。タイマーは解除されています。
  - `PAUSED` (新規): ユーザーへの質問・承認要求（`*.asked`）を受信し、一時的にタイマーをクリアして監視を休止している状態。青色の通知（waiting）を出します。

- **2つの核心ゲート**:
  1. **入力待ちゲート**: `permission.asked` / `question.asked` で `PAUSED` 状態に遷移し、タイマーが停止します。全ての入力要求が解決（`*.replied` により `pendingRequests` が空になる）された場合にのみ `WATCHING` に復帰します。それ以前のアクティビティによる誤解除は禁止されます。
  2. **ツール実行ゲート**: `stage2` タイマー満了時、現在実行中のツール（`runningTools`）が存在する場合、Ping 注入を抑止してタイマーを `stage2Ms` 後に再スケジュールします。

- **telemetry フックのタイミング**:
  - `recordHangup`: `onStage1Expire` 内で STAGE1_NOTIFIED への遷移直後（遷移時）に発火。
  - `recordPing`: `onStage2Expire` 内で ping 送信直前に発火。
  - `recordRecovery`: `armOrReset` 内で、`pingCount > 0` かつ `state !== "SILENCED"` のセッションでアシスタント活動が復帰した際に発火。
  - `recordFailure`: `onStage2Expire` 内で `maxPings` 上限に達して SILENCED 状態に遷移した際に発火。

### 3.3 post-stop 抑止と FIFO Tombstone メモリ管理
`session.idle / session.error / session.deleted` を受信して IDLE へ遷移した sessionId は、後続の遅延して届く `message.part.updated`（stale event）では再アームしません。
* stop された sessionId は、FIFO 上限 10,000 件の tombstone セット（`stoppedSessions`）に記録して抑止します。
* ユーザーによる新規メッセージ（`onUserMessage`）受信時に、この tombstone から解除されます。
* 長期稼働プロセスでのメモリ無制限増加を回避するため、上限を超えた場合は最古の sessionId から FIFO evict されます。

### 3.4 堅牢な多重起動防止ガード
OpenCode が同じプラグインファイルを多重ロード（または同一プロセス内で2回初期化を実行）するバグから防衛するため、グローバルなインスタンス管理を行います。
* `ACTIVE_INSTANCES` (`Set<string>`) をファイルスコープで管理。
* 初期化時、対象ディレクトリ（`input.directory`）が既に登録されている場合は、初期化をスキップしダミーの no-op Hook（`event: async () => {}, dispose: async () => {}`）を返却する。
* `dispose` が呼び出された際に対象ディレクトリを Set から削除する。

### 3.5 アームロック（Arm Lock）機構と手動復帰バイパス
* **アームロックの目的**: Ping 注入後、非同期処理の遅延により古いアシスタント応答や API エラー等のイベントが遅れて到達し、それによって監視状態が誤リセットされるのを防ぐ。
* **ロック時間**: Ping 注入後、最小30秒間（`lockDuration = Math.max(stage2Ms * 2, 30000)`）は、アシスタントからの応答や通常のアクティビティをすべてブロック（無視）する。
* **手動復帰バイパス（重要）**: アームロック期間中であっても、ユーザー自身が手動で送信した新規メッセージ（`isUserMessage(event)` またはユーザー起源の非空な `message.part.updated`）だけは、アームロック判定をバイパスして即座に `onUserMessage` を実行し、`SILENCED`（赤色）状態を解除して `WATCHING` に復帰させる。

### 3.6 デスクトップ通知 (OSNotifier)
Tmux 以外の通知方法として、デスクトップ環境向けの OS デスクトップ通知に対応します。
* **通知バックエンド**:
  - `darwin` (macOS): `osascript -e 'display notification "<message>" with title "Akane Watchdog"'` を実行。メッセージ内のダブルクォートやバックスラッシュ、改行は安全にエスケープ・平坦化。
  - `linux` (Ubuntu 等): `notify-send -u <urgency> "Akane Watchdog" <message>` を実行。警告度（`urgency`）は `warn` 時は `normal`、`critical` / `silenced` 時は `critical` にマッピング。
  - いずれも利用不可、または別 OS の場合は静かに無効化（throw しない）。
* **インジェクション脆弱性の排除**: 外部プロセス呼び出し時には引数を配列渡しとし、シェル展開を経由しないようにすることでコマンドインジェクションを防止。

### 3.7 テレメトリ収集と定期レポート
プラグインの可観測性を高めるため、稼働状況テレメトリを収集・出力します。
* **収集指標**: 検出ハングアップ数 (`hangupsDetected`)、送信 Ping 数 (`pingsSent`)、自己回復数 (`recoveries`)、自動復旧失敗数 (`silencedFailures`)、および自己回復率 (`recoveryRate = recoveries / (recoveries + silencedFailures)`)。
* **定期レポートループ**: 自己再スケジュール型の `clock.setTimeout` ループを用い、指定間隔（`OPENCODE_WATCHDOG_REPORT_MS`、デフォルト 60秒）で人間可読な1行サマリ（`[Telemetry] hangups=... pings=... recoveries=... failures=... recoveryRate=...`）を出力。
* **NoopTelemetry**: テスト互換性および非稼働時のオーバーヘッド低減のため、すべての計測メソッドが no-op になるダミー実装も提供。
* **終了時レポート**: プラグインの `dispose` が呼び出された際、定期レポートタイマーをクリアした上で、最終的な集計結果をログへ出力。

### 3.8 エラー解析と recoverable / terminal 分岐
OpenCode から送られてくる `session.error` イベントのペイロードを解析し、適切な処理経路にルーティングします。
* **エラー分類 (`classifyError`)**: OpenCode の `session.error` の properties 形状は SDK のバージョンアップ等で変更される可能性があるため、特定のオブジェクト構造に依存しないヒューリスティックな走査を行います。ペイロードの `name` / `message` / `error` / `code` / `type` フィールドを深さ 4 まで再帰的に走査し、得られた文字列情報から以下のいずれかに分類します。
  - `"rate_limit"`: APIレート制限（正規表現: `/rate.?limit|\b429\b|too many requests/i`）
  - `"provider_timeout"`: 応答タイムアウト（正規表現: `/timeout|timed out|etimedout|deadline/i`）
  - `"unknown"`: その他（上記以外でエラー文字列が存在する場合）
* **エラー分類の日本語化 (`reasonToJa`)**: 分類された理由を日本語の解説（例: `「APIレート制限に到達しました」`）に変換。
* **ルーティング処理 (`routeSessionError`)**:
  - **recoverable なエラー** (`rate_limit` / `provider_timeout`): `watchdog.noteError` を呼び出してセッションエントリにエラー理由を保持し、監視は `stop()` せず継続。次に発生するハングの Ping 注入時に、プロンプトの末尾に日本語のエラー原因付きヒント文（`[Watchdog] 直前に次のエラーを検出しました...`）を追記してエージェントの自己復旧を促す。
  - **terminal なエラー / 分類不能**: 従来通り `watchdog.stop(sessionId)` を呼び出し、監視を終了して Tmux/OS ハイライトをリセット。
* **エラー継続時の終端遷移（リソース消費の上界）**: recoverable なエラーにより監視が継続された場合でも、回復応答がないままハングが継続すると `maxPings`（デフォルト 1）で頭打ちになり、SILENCED 状態に遷移してタイマーは解除されます。これにより最大監視時間は `stage1Ms + (maxPings + 1) × stage2Ms` で上界が定まり、無限に ping を打ち続けてトークンを浪費することはありません。
* **メモリリークガード**: `noteError` は監視中のセッション（`sessions` Map 内）にのみ適用され、監視外や停止済みのセッションにエラー理由を退避・保持しないことでメモリリークを防ぐ。

### 3.9 ゲーティングにおけるエッジケースと不変条件

入力待ち（`PAUSED`）およびツール実行中（`steer` 抑止）の各種状態遷移について、以下のエッジケースと不変条件を定義・維持します。

* **PAUSED と retry 状態の併存**:
  セッションが `PAUSED` かつ `pendingRequests` が存在する状態で `session.status:retry` に遷移し、その後 `busy`/活性によって復帰する際、`pendingRequests` が非空である限り `PAUSED` 状態を維持し、タイマーを再スケジュール（`armOrReset`）しません。`PAUSED` の解除は `*.replied` により `pendingRequests` が空になった時のみ許可され、他イベントによるアクティビティ誤解除は禁止されます。また、入力待ち解消時点で retry 抑止中であれば、タイマーアームは抑止され続け、retry 解除時に初めてタイマーが再起動されます。
* **Tombstone（停止済み）セッションの尊重**:
  `session.idle` 等で一度停止された（`stoppedSessions` に入っている）セッションに対して、遅延した `permission.asked` / `question.asked` が到達した場合は無視します（tombstone の保護を優先）。
* **アームロック（Arm Lock）との相互作用**:
  `permission.asked` / `question.asked` および `permission.replied` / `question.replied` は、ユーザー自身によるメッセージと同様に扱い、アームロック期間であってもバイパスして即時反映します。一方、`delta` および `tool` イベントは、従来のアシスタント活性シグナルと同様にアームロック期間を尊重し、ロック中は無視されます。
* **自己 Ping 判定**:
  ストリーム delta（`message.part.delta`）受信時、その `messageID` を `IGNORED_PING_MESSAGE_IDS`（自己注入した Ping の ID 履歴）と照合し、一致した場合はタイマーのリセット（活性化）をスキップします。
* **PAUSED 中の停止イベント**:
  `PAUSED` 状態の監視中にセッションの正常終了（`session.idle`）、異常終了（`session.error`）、破棄（`session.deleted`）を受信した場合、通常と同様に監視を停止し、セッションエントリの破棄、tombstone の記録、および Tmux/OS 通知のクリアを実行します。
* **ツールハングの割り切り**:
  実行ステータスが `running` のまま完了（`completed` / `error`）に遷移しないハングアップしたツールプロセス（`bash` など）は、`steer` 注入では修復できないため、自動回復は行わずに critical 警告状態を維持し、人間の介入に委ねます。

---

## 4. 設定スキーマ

### 4.1 型定義

```typescript
export type NotifierType = "tmux" | "os";

export interface WatchdogConfig {
  enabled: boolean;
  stage1Ms: number;
  stage2Ms: number;
  maxPings: number;
  pingMessage: string;
  notifierType: NotifierType;
  delivery: "steer" | "queue";
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

### 4.2 デフォルト値

| キー | デフォルト | 根拠 |
|---|---|---|
| `enabled` | `true` | プラグインを置けば有効。Off は env で切れる |
| `stage1Ms` | `180000` (3 min) | 要件指定 |
| `stage2Ms` | `180000` (3 min) | stage1 と対称。トータル 6 min で Ping |
| `maxPings` | `1` | 無限ループ・トークン浪費・レート制限の二次障害を回避 |
| `pingMessage` | `"現在の状況を教えてください。ハングしているようであれば、思考プロセスを要約して次のアクションを提示してください。"` | 要件指定 |
| `notifierType` | `"tmux"` | Tmux 連携をデフォルトの通知方式とする |
| `delivery` | `"steer"` | 進行中のターンに割り込んで即注入（steer）を優先 |
| `suppressPingWhileToolRunning` | `true` | 長時間の正当なツール実行による誤中断を防ぐ |
| `pauseOnInputRequest` | `true` | ユーザー待ちによる正常な沈黙をハングと誤認するのを防ぐ |
| `notifyWaiting` | `true` | 監視一時停止時（入力待ち状態）に低優先度の通知を送る |
| `verboseLog` | `false` | ログ肥大化を防ぐため通常時は要約ログとし完全JSON出力を抑止 |
| `tmux.enabled` | `true` | Tmux 検出時のみ実効 |
| `tmux.displayMessage` | `true` | display-message を使用 |
| `tmux.highlightWindow` | `true` | window-status-current-style を使用 |
| `agents.include` | `undefined` | 未指定時はすべて監視 |
| `agents.exclude` | `undefined` | 未指定時は除外なし |

### 4.3 優先順位解決
1. **環境変数** — CI や一時的な上書き向け
   - `OPENCODE_WATCHDOG_ENABLED`
   - `OPENCODE_WATCHDOG_STAGE1_MS` (デフォルト: 180,000ms / 3分)
   - `OPENCODE_WATCHDOG_STAGE2_MS` (デフォルト: 180,000ms / 3分)
   - `OPENCODE_WATCHDOG_MAX_PINGS` (デフォルト: 1)
   - `OPENCODE_WATCHDOG_NOTIFIER_TYPE` (デフォルト: "tmux")
   - `OPENCODE_WATCHDOG_REPORT_MS` (デフォルト: 60,000ms / 1分)
   - `OPENCODE_WATCHDOG_DELIVERY` (デフォルト: "steer")
   - `OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL` (デフォルト: "true")
   - `OPENCODE_WATCHDOG_PAUSE_ON_INPUT` (デフォルト: "true")
   - `OPENCODE_WATCHDOG_NOTIFY_WAITING` (デフォルト: "true")
   - `OPENCODE_WATCHDOG_VERBOSE` (デフォルト: "false")
2. **`opencode.json` の `experimental.watchdog`**（または `watchdog`）
3. **Defaults**

### 4.4 設定マージ規約
- すべてのキーは optional として受け取り、未指定はデフォルトへフォールバック。
- 不正な値（負の数、型不一致）は warn ログを出して defaults を採用。プラグインを落とさない。

---

## 5. Tmux 連携

### 5.1 Tmux 環境検出 (3 段階キャッシュ)
次の3つのチェックをすべてパスした場合のみ Tmux 連携を有効化します。結果は `notifier` 内部にキャッシュされ、再判定は行われません。
1. `process.env.TMUX` が非空であること (Tmux 内実行)。
2. `Bun.which("tmux")` が解決可能であること。
3. `tmux display-message -p "#{session_name}"` の dry-run が exit 0 で返ること。

### 5.2 通知ステージと動作

| ステージ | 動作 | Tmux表示色 | OS通知 (Linux) |
|---|---|---|---|
| `stage1` (警告) | `tmux display-message` で沈黙を通知 | `bg=yellow` (黄色) | urgency=normal |
| `stage2` (Ping注入) | 自動Pingメッセージを注入 | `bg=red` (赤色) | urgency=critical |
| `SILENCED` (停止) | 自動Pingの上限に達し、人間の介入を待機 | `bg=red` (赤色) | urgency=critical |
| `waiting` (入力待ち) | ユーザーの質問・承認待機中にタイマーを停止して通知 | `bg=cyan` (シアン) | urgency=low |
| `正常終了 / 復帰` | `tmux set-window-option window-status-current-style 'default'` | `default` (通常色) | （OS通知なし/Tmux色クリア） |

---

## 6. セキュリティと安全性

- **例外の完全な内包（Zero-Crash Fallback）**:
  プラグイン由来の例外で OpenCode 本体を絶対に落とさない設計を行います。
  Tmux/OS 検出失敗時や、`Bun.spawn` 自体が失敗した場合（ENOENT 等）も、例外を try/catch で握りつぶしてログ出力のみとし、呼び出し元へはエラーを伝播させません。
- **インジェクション脆弱性の排除**:
  `Bun.spawn` で外部コマンド（tmux, notify-send, osascript）を呼び出す際、引数は文字列連結ではなく配列引数として渡し、シェル展開（シェルインジェクション）を経由させないようにします。macOSの `osascript` 呼び出しに際しては、メッセージ内のダブルクォートやバックスラッシュなどの文字を厳密にエスケープ処理します。
- **絶対パスのコミット禁止**:
  パス指定に絶対パスを使用せず、`$HOME` または相対パスで表現します。
- **機密情報の保護（ログのセキュア化）**:
  ログには API キーやセッションのメッセージ本文を出さず、sessionId と状態遷移のみを出力します。また、TmuxNotifier/OSNotifier において外部コマンドの実行が失敗した際、エラーログに通知メッセージ本文（任意のセッション内容やエラー分類情報）が出力されるのを防ぐため、コマンド引数全体を出力せず、バイナリ名と終了コードのみを記録するようにします。

---

## 7. テスト戦略

### 7.1 テストランナー
`bun test`（組み込み）のみを使用する。jest / mocha / vitest / chai 等の追加テストランナーは導入しない。

### 7.2 テストレイヤ

| レイヤ | 対象 | 手法 |
|---|---|---|
| Unit | `config` のマージ・defaults・不正値処理 | 純粋関数の入出力検証 |
| Unit | `watchdog` の状態遷移とタイマー管理 | `Clock` を fake にし、stage1/stage2 を任意時点に進める |
| Unit | `notifier` の Tmux 呼び出し | `Bun.spawn` を DI 経由のモックに差し替え、引数を検証 |
| Unit | `pinger` の `MockPinger` | 副作用の有無のみ確認 |
| Smoke | プラグインロード | `@opencode-ai/plugin` 型に対するインポート整合のみ確認 |

### 7.3 必須アサーション
- `message.part.updated` を N 回連続で受け取っても、Map 内のタイマーは常に 1 本のみ。
- `session.idle` 後に `message.part.updated` を受信しても新規タイマーが作られない（tombstone による抑止）。
- `maxPings = 1` の設定で stage2 を 2 度連続発火させても、`pinger.inject` の呼び出しは 1 回のみ。
- Tmux 検出失敗時に notifier を呼んでもプロセスが落ちない。
- **初期ハング検知**: `message.updated (role=user)` のみを受信し、その後一切 `message.part.updated` が来ない状態で stage1Ms が経過した場合、`notifier.notify` が呼ばれること。さらに stage2Ms 経過で `pinger.inject` が 1 回呼ばれること。
- **空セッション誤検知防止**: `session.created` のみを受信し、`message.updated (role=user)` が一度も来ない場合、いかなる時間が経過しても `notifier.notify` は呼ばれないこと。

### 7.4 メモリリーク検証
1000 セッション × 100 チャンクのストレステストを実施し、`session.idle` 後に `Map` のサイズが 0 に戻ること、アクティブタイマー数が 0 になることを検証する。

---

## 8. Pinger インタフェース

### 8.1 インタフェース定義

```typescript
export interface PingContext {
  reason?: HangReason;
}

export interface Pinger {
  inject(sessionId: string, message: string, context?: PingContext): Promise<void>;
}
```

### 8.2 実装
`OpenCodeAdapter` が実インタフェースを実装し、`MockPinger` がテスト用スタブとして機能する。`OpenCodeAdapter` 内部の SDK 呼び出し形状のみが変更対象となり、Watchdog コアロジックは一切影響を受けない設計とする（詳細は付録を参照）。

---

## 9. 受け入れ条件 (Acceptance Criteria)

1. プラグインを `~/.config/opencode/plugins/` に置くだけで有効化される。
2. `OPENCODE_WATCHDOG_STAGE1_MS=1000` 等の環境変数で挙動が変わる。
3. 180 秒（デフォルト）のストリーム停止で Tmux 黄色ハイライトと display-message が出る。
4. さらに 180 秒経過で Ping が 1 回注入され、Tmux が赤色に切り替わる。
5. `maxPings: 1` の状態で 2 度目の stage2 を迎えても Ping は再注入されない。
6. Tmux 非起動環境でプラグインを動かしてもプロセスが落ちず、ログのみ残る。
7. `bun test` がすべて pass する。
8. `Map` 内タイマー数が `session.idle` 後に 0 になることを stress test で確認できる。
9. **初期ハング検知**: ユーザーがプロンプトを送信した直後にエージェントが一度も応答チャンクを返さずハングした場合でも、stage1Ms 経過で通知が出て、さらに stage2Ms 経過で Ping が注入される。
10. **空セッション誤検知なし**: 新規セッションを作成しただけでユーザー入力が無い状態では、いかなる時間が経過しても Watchdog はトリガしない。

---

## 10. 将来拡張余地（非ゴール）

- ハング原因の自動診断（LLM プロバイダ側の HTTP ステータス監視等）。
- Tmux 以外の追加の通知バックエンド（Slack 等）。
- 状態遷移の永続化と再起動後の復元。
- ダッシュボード UI。
- CI での実 tmux 結合テスト（現状は `Bun.spawn` を DI モックで代替）。

---

## 付録: @opencode-ai/plugin SDK 形状実測

### Plugin エントリ型
```typescript
export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;
    project: Project;
    directory: string;
    worktree: string;
    experimental_workspace: { register(type: string, adapter: WorkspaceAdapter): void };
    serverUrl: URL;
    $: BunShell;
};
export type PluginOptions = Record<string, unknown>;
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
```

### イベント payload 抽出パス

| イベント type | sessionID 抽出パス | role 判定 (user) |
| --- | --- | --- |
| `message.updated` | `event.properties.info.sessionID` | `info.role === "user"` |
| `message.part.updated` | `event.properties.part.sessionID` | (roleなし。agentNameが存在しなければユーザー起源) |
| `session.created` / `session.deleted` | `event.properties.info.id` | - |
| `session.idle` / `session.error` | `event.properties.sessionID` | - |
| `permission.asked` / `permission.replied` | `event.properties.sessionID` | - |
| `question.asked` / `question.replied` | `event.properties.sessionID` | - |
| `session.status` | `event.properties.sessionID` | - |

> **⚠️ 重要な差異**: `session.idle` / `session.error` のセッション ID は `event.properties.sessionID`（直接）。設計初版で想定していた `event.properties.info.id` とは異なる。この差異は smoke test の fake event payload にも影響し、実 SDK の型定義に合わせる必要がある。

### `client.session.prompt` 呼び出し形 (確認日: 2026-06-18, V2 割り込み対応)

#### V2 形式 (優先試行形状):
```typescript
client.session.prompt({
  sessionID: sessionId,
  parts: [{ type: "text", text: message }],
  delivery: "steer" | "queue"
});
```

#### legacy 形式 (フォールバック形状):
```typescript
client.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: "text", text: message }] }
});
```

`OpenCodeAdapter` はまず V2 形式での送信を試み、ランタイムからスキーマ拒否（例外送出され、エラーメッセージに `unknown_field` や `unrecognized_field` を含む）を検知した場合のみ、 legacy 形式へ try/catch フォールバックします。それ以外の接続エラーやランタイムエラーでは二重送信を防止するためフォールバックしません。

`TextPartInput` の主要フィールド:

```typescript
export type TextPartInput = {
  id?: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
};
```
