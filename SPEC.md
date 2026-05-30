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

| イベント | 用途 |
|---|---|
| `message.updated` (role=user) | **初期タイマー起動トリガ**。空のメッセージシェル（parts なし）は無視し、実データ送信時に起動。 |
| `message.part.updated` | 活性シグナル。受信のたびにタイマーをリセット。ユーザー起源のものは復旧トリガとしても扱う。 |
| `session.idle` | 正常終端。タイマーと内部状態を破棄。 |
| `session.error` | 異常終端。タイマーを破棄し赤色ハイライト解除。 |
| `session.deleted` | セッション破棄。同上。 |

---

## 3. アーキテクチャ

### 3.1 モジュール構成と責務境界

| モジュール | 責務 | 主な依存 |
|---|---|---|
| `config` | 設定ソースの優先順位解決・型安全な defaults | なし (純粋関数) |
| `watchdog` | 各 sessionId のタイマー管理、状態遷移、活性検知 | `Notifier`, `Pinger`, `Clock` (すべて DI) |
| `notifier` | Tmux 有無判定、`tmux display-message`、ウィンドウ色制御、フォールバック | `Bun.spawn`, `Bun.which`, `process.env.TMUX` |
| `pinger` | `Pinger` インタフェース定義と `OpenCodeAdapter` 実装 | OpenCode `client` SDK |
| `clock` | `setTimeout` / `clearTimeout` の DI 化 | なし |
| `index` | プラグインエントリ。`event` を `watchdog` に委譲 | 上記すべて |

### 3.2 状態マシンと遷移

```text
        ┌──────┐
        │ IDLE │  ← 初期状態 (Map にエントリ無し / タイマー無し)
        └──┬───┘
           │ message.updated (role=user)   ※初期タイマー起動 / post-stop 再アーム
           │ または message.part.updated   ※ユーザー発話による手動復帰
           ▼
                    activity (assistant)
        ┌──────────────────────────────────────┐
        ▼                                       │
   ┌─────────┐  stage1 expire  ┌────────────────────┐
   │WATCHING ├────────────────►│ STAGE1_NOTIFIED    │
   └─────────┘                 └─────────┬──────────┘
        ▲                                │ stage2 expire
        │                                ▼
        │                          pingCount < max ?
        │                          ┌─────┴─────┐
        │                         yes          no
        │                          │            │
        │                          ▼            ▼
        │                     ┌─────────┐  ┌──────────┐
        └─── user message ────┤ PINGED  │  │ SILENCED │
              (bypass lock)   └─────────┘  └──────────┘
                                   │            │
                                   └─user msg───┘ (手動介入メッセージで WATCHING へ復帰)
```

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

---

## 4. 設定スキーマ

### 4.1 型定義

```typescript
export interface WatchdogConfig {
  enabled: boolean;
  stage1Ms: number;
  stage2Ms: number;
  maxPings: number;
  pingMessage: string;
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

| ステージ | 動作 | Tmux表示色 |
|---|---|---|
| `stage1` (警告) | `tmux display-message` で沈黙を通知 | `bg=yellow` (黄色) |
| `stage2` (Ping注入) | 自動Pingメッセージを注入 | `bg=red` (赤色) |
| `SILENCED` (停止) | 自動Pingの上限に達し、人間の介入を待機 | `bg=red` (赤色) |
| `正常終了 / 復帰` | `tmux set-window-option window-status-current-style 'default'` | `default` (通常色) |

---

## 6. セキュリティと安全性

- **例外の完全な内包（Zero-Crash Fallback）**:
  プラグイン由来の例外で OpenCode 本体を絶対に落とさない設計を行います。
  Tmux 検出失敗時や、`Bun.spawn` 自体が失敗した場合（ENOENT 等）も、例外を try/catch で握りつぶしてログ出力のみとし、呼び出し元へはエラーを伝播させません。
- **インジェクション脆弱性の排除**:
  `Bun.spawn` で外部コマンド（tmux）を呼び出す際、引数は文字列連結ではなく配列引数として渡し、シェル展開（シェルインジェクション）を経由させないようにします。
- **絶対パスのコミット禁止**:
  パス指定に絶対パスを使用せず、`$HOME` または相対パスで表現します。
- **機密情報の保護**:
  ログには API キーやセッションのメッセージ本文を出さず、sessionId と状態遷移のみを出力します。

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
export interface Pinger {
  inject(sessionId: string, message: string): Promise<void>;
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
- Tmux 以外の通知バックエンド（Slack、OS native notification 等）。
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

> **⚠️ 重要な差異**: `session.idle` / `session.error` のセッション ID は `event.properties.sessionID`（直接）。設計初版で想定していた `event.properties.info.id` とは異なる。この差異は smoke test の fake event payload にも影響し、実 SDK の型定義に合わせる必要がある。

### `client.session.prompt` 呼び出し形 (確認日: 2026-05-29, v1.15.12)

```typescript
client.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: "text", text: message }] }
});
```

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
