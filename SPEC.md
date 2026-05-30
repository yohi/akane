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

---

## 2. 統合方式

### 2.1 採用方式: `@opencode-ai/plugin` 公式プラグイン API
OpenCode の Plugin API (`event` フックや `client` SDK) を利用する。

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

### 3.1 状態マシンと遷移

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

### 3.2 堅牢な多重起動防止ガード
OpenCode が同じプラグインファイルを多重ロード（または同一プロセス内で2回初期化を実行）するバグから防衛するため、グローバルなインスタンス管理を行います。
* `ACTIVE_INSTANCES` (`Set<string>`) をファイルスコープで管理。
* 初期化時、対象ディレクトリ（`input.directory`）が既に登録されている場合は、初期化をスキップしダミーの no-op Hook（`event: async () => {}, dispose: async () => {}`）を返却する。
* `dispose` が呼び出された際に対象ディレクトリを Set から削除する。

### 3.3 アームロック（Arm Lock）機構と手動復帰バイパス
* **アームロックの目的**: Ping 注入後、非同期処理の遅延により古いアシスタント応答や API エラー等のイベントが遅れて到達し、それによって監視状態が誤リセットされるのを防ぐ。
* **ロック時間**: Ping 注入後、最小30秒間（`lockDuration = Math.max(stage2Ms * 2, 30000)`）は、アシスタントからの応答や通常のアクティビティをすべてブロック（無視）する。
* **手動復帰バイパス（重要）**: アームロック期間中であっても、ユーザー自身が手動で送信した新規メッセージ（`isUserMessage(event)` またはユーザー起源の非空な `message.part.updated`）だけは、アームロック判定をバイパスして即座に `onUserMessage` を実行し、`SILENCED`（赤色）状態を解除して `WATCHING` に復帰させる。

---

## 4. 設定スキーマ

### 4.1 優先順位解決
1. **環境変数**
   - `OPENCODE_WATCHDOG_ENABLED`
   - `OPENCODE_WATCHDOG_STAGE1_MS` (デフォルト: 180,000ms / 3分)
   - `OPENCODE_WATCHDOG_STAGE2_MS` (デフォルト: 180,000ms / 3分)
   - `OPENCODE_WATCHDOG_MAX_PINGS` (デフォルト: 1)
2. **`opencode.json` の `experimental.watchdog`**（または `watchdog`）
3. **Defaults**

---

## 5. Tmux 連携と通知ステージ

| ステージ | 動作 | Tmux表示色 |
|---|---|---|
| `stage1` (警告) | `tmux display-message` で沈黙を通知 | `bg=yellow` (黄色) |
| `stage2` (Ping注入) | 自動Pingメッセージを注入 | `bg=red` (赤色) |
| `SILENCED` (停止) | 自動Pingの上限に達し、人間の介入を待機 | `bg=red` (赤色) |
| `正常終了 / 復帰` | 表示のクリア | `default` (通常色) |

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
