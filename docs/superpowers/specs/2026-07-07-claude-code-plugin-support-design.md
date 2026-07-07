# akane Claude Code プラグイン対応 設計仕様 (SPEC)

- **対象**: akane（OpenCode 用ハング検知ウォッチドッグ）を **Claude Code プラグイン**としても動作させる
- **方針**: 既存 `src/` コアを共有する単一リポジトリ構成。OpenCode 側（`index.ts`・TUI）は非改変
- **配布**: `yohi/nexus` の「GitHub(source) → GitHub Actions → Bitbucket(配布) マーケットプレイス」パターンを踏襲
- **ステータス**: 設計承認済み（brainstorming 完了）。次工程は `writing-plans`
- **作成日**: 2026-07-07

---

## 1. 背景・目的

### 1.1 課題
akane は OpenCode のストリーム停止（ハング）を検出し、Tmux/OS 通知と自動リカバリ Ping 注入で対応するプラグインである。同種の「エージェント応答ハング」は Claude Code でも発生し得るため、akane の監視価値を Claude Code にも提供したい。

### 1.2 ゴール
1. Claude Code セッションのハング（応答の沈黙）を一定時間内に検出する。
2. 一次対応として Tmux/OS 通知で人間に知らせる。
3. 二次対応として自動 Ping を注入し、エージェントの自己復旧を試みる。
4. テレメトリ（ハング数・Ping 数・回復率）を収集する。
5. 上記を **Claude Code 標準のプラグイン機構（hooks + monitors）** で実装し、Claude Code 本体には手を入れない。
6. 既存 akane コアを最大限再利用し、OpenCode 版の動作・テストを一切壊さない。

### 1.3 非ゴール
- OpenCode 版 akane の挙動変更（`src/index.ts`・TUI・既存 202 テストは非改変）。
- Claude Code 本体・SDK の fork。
- marketplace カタログ repo（Bitbucket 配布側）の実インフラ構築（本設計では参照手順として記載するのみ）。
- ハング原因の LLM プロバイダ側自動診断（時間閾値検知までが責務）。

---

## 2. 前提: Claude Code 拡張モデル（公式ドキュメントで確認済み）

本設計は以下の Claude Code 機構に依存する。いずれも公式ドキュメント（docs.claude.com / code.claude.com のHooks・Plugins リファレンス）で実在を確認済み。

| 機構 | 内容 | akane での用途 |
|---|---|---|
| **hooks（短命プロセス）** | イベント毎に起動し stdin から JSON を受け取り即終了。設定は `plugin.json` の `hooks` にインライン宣言可 | 活性イベントのセンサー |
| **monitors（常駐プロセス）** | `monitors/monitors.json` に宣言。プラグイン有効時に自動起動され、**stdout の各行が Claude への通知として配信**される | Watchdog 状態機械のホスト＋Ping 配信 |
| **`MessageDisplay` フック** | アシスタントのメッセージ表示中に発火（display-only、既定 timeout 10s） | ストリーミング活性シグナル（`message.part.delta` 相当） |
| **`Stop` / `StopFailure`** | ターン正常終了 / API エラー終了（`error_type` matcher: rate_limit 等） | 監視解除 / エラー分類 |
| **`Notification`（matcher: permission_prompt / idle_prompt 等）** | 承認要求・アイドル待ち等 | PAUSED / 監視解除 |
| **`PermissionRequest`** | 権限ダイアログ表示 | PAUSED（入力待ち） |
| **`UserPromptSubmit`** | ユーザー入力送信 | タイマー arm / 手動復帰 |
| **`SessionStart` / `SessionEnd`** | セッション開始 / 終了 | 監視準備 / 破棄 |
| **`SubagentStart` / `SubagentStop`** | サブエージェント起動 / 終了 | サブエージェント監視 |
| **`${CLAUDE_PLUGIN_ROOT}`** | プラグインルートの実行時展開変数 | manifest 内のパス参照 |
| **`asyncRewake`（hook option）** | バックグラウンド実行し exit code 2 で Claude を起床。stderr/stdout を system reminder として提示 | Ping 補助ベクタ（検証対象） |

> **重要な相違**: Claude Code は OpenCode のような「単一の長命プラグインプロセスが全イベントを in-process 受信」するモデルではない。フックは短命・イベント駆動で、タイマーを保持できない。よって「沈黙（無イベント）の検知」には常駐プロセス（monitors）が必須である。

---

## 3. アーキテクチャ & データフロー

akane を「**センサー（フック）**」と「**頭脳（常駐 monitor）**」に分離する。頭脳側は既存 `watchdog.ts` コアをそのまま搭載する。

```text
┌───────────────────────── Claude Code セッション ─────────────────────────┐
│ イベント毎に短命フック起動（stdin = JSON）                                  │
│  UserPromptSubmit / MessageDisplay / PreToolUse / PostToolUse /            │
│  PostToolUseFailure / Stop / StopFailure / Notification /                  │
│  PermissionRequest / SessionStart / SessionEnd / SubagentStart|Stop        │
│       │                                                                    │
│       │  akane-hook CLI (dist/claude/hook.js): JSON正規化 → 1行追記         │
│       ▼                                                                    │
│  <stateDir>/.akane/events.ndjson   ← append-only（アトミック追記）          │
│       │  tail / poll                                                       │
│       ▼                                                                    │
│  ┌──────────── monitors/monitors.json 常駐プロセス ────────────────┐       │
│  │ dist/claude/monitor.js（Watchdog ホスト）                        │       │
│  │  • events.ndjson 読取 → Watchdog メソッド投入                     │       │
│  │  • Clock タイマー(stage1/stage2) = 沈黙検知                       │       │
│  │  • 状態機械 WATCHING/STAGE1_NOTIFIED/PINGED/SILENCED/PAUSED/IDLE  │       │
│  │  • Notifier → tmux/OS 警告色・デスクトップ通知                    │       │
│  │  • Pinger(ClaudeCodeAdapter) → stdout に Ping行 → Claudeへ通知     │       │
│  │  • Telemetry / WatchdogStateStore（可観測性・デバッグ）           │       │
│  └────────────────────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────────────┘
```

**要点**:
1. **フック = センサー（状態を持たない）**: Claude Code の JSON を受け取り、正規化イベントを `events.ndjson` に追記するだけ。全フックは単一の薄い CLI（`akane-hook`）に集約し、`hook_event_name` で分岐。
2. **monitor = 頭脳（状態を持つ）**: Claude Code が自動起動/停止。既存 Watchdog・Clock・Notifier・Telemetry・errors をほぼそのまま搭載。**タイマーを保持できる唯一の場所**＝沈黙検知の心臓部。
3. **結合 = 一方向 IPC（`events.ndjson`）**: `shared-state.ts` のアトミック書込パターンを踏襲。フックが write、monitor が read（既存「monitor→TUI」パターンの鏡像）。
4. **Ping 経路**: Watchdog が Ping を打つと、Claude Code 版 Pinger は monitor プロセスの stdout に1行出力 → Claude Code がそれを通知として配信。
5. **ライフサイクル**: monitor の起動/終了は Claude Code 管理（lifecycle 用の自前 PID 追跡は不要）。多重起動ガードのみ自前実装し、その stale 検知に限り PID を用いる（§8.3）。

**核心的制約**: monitor は stdout の各行が Claude 通知になるため、デバッグ・テレメトリ・要約ログは必ず stderr / ログファイルへ分離する。stdout は「Ping/通知として意図した行」だけに厳格に限定する。

---

## 4. コンポーネント再利用マップ & 新規モジュール

### 4.1 既存 `src/` の扱い

| モジュール | 扱い | 理由 |
|---|---|---|
| `watchdog.ts` | そのまま再利用 | DI・プラットフォーム非依存の状態機械（頭脳） |
| `clock.ts` | そのまま再利用 | RealClock タイマー |
| `notifier.ts` | そのまま再利用 | tmux/OS（spawn DI） |
| `telemetry.ts` | そのまま再利用 | 計測・定期レポート |
| `errors.ts` | そのまま再利用 | `classifyError`/`reasonToJa`（StopFailure 分類に流用） |
| `shared-state.ts` | そのまま再利用 | 可観測性・デバッグ状態出力 |
| `pinger.ts` | IF 再利用＋新 Adapter | `Pinger` IF は不変、`ClaudeCodeAdapter` を新規実装 |
| `config.ts` | 小改修 | Claude Code 用の設定ソース/env キーを追加 |

### 4.2 新規モジュール `src/claude/`

| ファイル | 責務 | OpenCode 版の対応 |
|---|---|---|
| `event-types.ts` | 正規化イベント型 `AkaneClaudeEvent` の定義 | （新規） |
| `hook.ts` | `akane-hook` CLI。Claude Code stdin JSON をイベント別に解析→正規化→追記。CC ペイロード抽出を集約 | `index.ts` の `extractSessionId` 等 |
| `event-log.ts` | `events.ndjson` の追記（hook側）／読取・tail（monitor側）＝一方向 IPC | （新規、shared-state 踏襲） |
| `event-map.ts` | 正規化イベント → Watchdog メソッドへの dispatch | `index.ts` の `event` ルーティング switch |
| `pinger.ts` | `ClaudeCodeAdapter`（Pinger 実装 = stdout へ Ping 出力） | `pinger.ts` の `OpenCodeAdapter` |
| `monitor.ts` | 常駐エントリ。Watchdog＋依存を組立て、event-log を消費、ライフサイクル・多重起動ガード | `index.ts` の `plugin()` bootstrap |
| `config.ts` | Claude Code 設定解決（既存 `resolveConfig` を env 経路で流用） | `index.ts` の `readProjectConfig` |

**方針**: 各新規モジュールは単一責務・DI で単体テスト可能に保つ（既存の設計規律を踏襲）。

### 4.3 `stateDir` 解決と `events` ライフサイクル

hook（短命）と monitor（常駐）は別プロセスのため、両者が**決定論的に同一の `stateDir`** を解決できることが一方向 IPC（§3-3）の前提となる。

- **`stateDir` 解決順（優先順位固定）**:
  1. `AKANE_STATE_DIR`（明示指定・最優先）
  2. `XDG_STATE_HOME/akane`（XDG Base Directory 準拠）
  3. `$HOME/.local/state/akane`（XDG 既定へのフォールバック）
- **events パス（セッション単位）**: `<stateDir>/.akane/<sessionId>.ndjson`。`sessionId` は hook が Claude Code stdin から抽出（既存 `extractSessionId` 流用）、monitor は `<stateDir>/.akane/` を tail する。§3 図中の `events.ndjson` はこのセッション単位ファイルの総称。
- **マルチセッション/複数 monitor**: セッション毎にファイルを分離し、同時実行時のイベント混線と追記競合を回避する（複数 monitor 可否は §10-1 で確定）。
- **ローテーション/クリーンアップ**（append-only の無制限成長防止）:
  - `SessionEnd` 受信時、monitor は当該 `<sessionId>.ndjson` を tombstone 記録後に削除する。
  - monitor 起動時、tombstone 済み・または最終更新から TTL（既定 24h）超過の孤児ファイルを掃除する（クラッシュで `SessionEnd` を取りこぼした場合の保険）。
  - 単一セッションが上限行数（既定 100,000 行）を超えた場合、monitor は読取オフセット以前の処理済みプレフィックスを破棄し未処理分のみで再書込（atomic `.tmp→rename`）するコンパクションを行う。
- env による値受け渡し（hook/monitor が同一 `stateDir`/設定を得る手段）は §7.2 の env マッピングに従い実機で確定する（§10-2）。

---

## 5. イベントマッピング & ハング検知セマンティクス

### 5.1 マッピング（Claude Code フック → Watchdog）

| Claude Code フック (matcher) | 正規化イベント | Watchdog メソッド | 意味 |
|---|---|---|---|
| `UserPromptSubmit` | user_message | `onUserMessage` | タイマー arm / 手動復帰バイパス（SILENCED 解除） |
| `MessageDisplay` | activity | `onActivity` | ストリーミング活性（`message.part.delta` 相当） |
| `PreToolUse` | tool_running | `onToolRunning` | ツール実行開始（ツールゲート） |
| `PostToolUse` / `PostToolUseFailure` | tool_settled | `onToolSettled`＋`onActivity` | ツール完了 |
| `PermissionRequest` | input_requested | `onInputRequested` | PAUSED（承認待ち） |
| `Notification(permission_prompt)` | input_requested | `onInputRequested` | PAUSED（冗長シグナル） |
| `Notification(idle_prompt)` | idle | `stop` | 応答完了・次入力待ち → 監視解除 |
| `Stop` | turn_end | `stop` | ターン正常終了 → 監視解除 |
| `StopFailure(rate_limit/overloaded/…)` | error | `routeSessionError`→`noteError`/`stop` | エラー分類（recoverable は note 継続） |
| `SessionStart` | session_start | （準備） | 監視開始準備 |
| `SessionEnd` | session_end | `stop`＋tombstone | セッション破棄 |
| `SubagentStart` / `SubagentStop` | activity / settle | `onActivity` / `onToolSettled` | サブエージェント監視 |

### 5.2 ハング検知セマンティクス
- **arm**: `UserPromptSubmit` で stage1 タイマー起動
- **reset**: `MessageDisplay` / `PreToolUse` / `PostToolUse(Failure)` で stage1 再アーム
- **clear（正常終了）**: `Stop` / `Notification(idle_prompt)` / `SessionEnd`
- **PAUSE**: `PermissionRequest` / `Notification(permission_prompt)`
- **hang 判定**: 「活性も `Stop` も無いまま stage1 満了」→ STAGE1_NOTIFIED（黄）→ stage2 満了 → PINGED（Ping＋赤）→ SILENCED（赤）
- 状態機械本体・タイマー本数・ツールゲート・アームロックは既存 `watchdog.ts` の実装をそのまま利用する。

### 5.3 パリティ限界（正直に明示）
本設計では OpenCode 版との完全一致は目標だが、Claude Code のイベントモデル上、以下は原理的に一致しない。設計として明示し、実機検証（§9.3）で挙動を確定する。

1. **MessageDisplay の粒度**: `message.part.delta` は文字チャンク毎だが `MessageDisplay` は「表示中」イベント。長い単一メッセージ生成中の発火頻度が不明。→ **対策**: `stage1Ms` を保守的に設定し、全ツールイベントも活性に含める。実機で cadence を計測し閾値を調整。
2. **PAUSED 解除信号の不在**: Claude Code に `permission.replied` 相当の明示イベントが無い。→ `PermissionRequest` で PAUSED に入り、**次の活性イベント（PreToolUse/PostToolUse/MessageDisplay）または UserPromptSubmit で WATCHING 復帰**に簡略化する（`pendingRequests` の厳密なカウント追跡は行わない）。
3. **thinking 中の沈黙**: 拡張思考中に MessageDisplay もツールも発火しない区間があり得る。長考とハングの区別は本質的に時間閾値依存（OpenCode でも同様の割り切り）。

### 5.4 登録不可フックのフォールバック（§7.2・§10-3 依存）

`StopFailure` / `PermissionRequest` は登録可否が未確定（§10-3）。**登録不可と判明した場合の代替経路**を以下に固定し、主経路の欠落でハング検知セマンティクスが破綻しないことを保証する。

1. **`StopFailure`（監視解除＝クリア経路の担保）**: 登録可能なら `error_type` matcher 付きで登録。不可の場合、単一 `hook.js` が **`Stop` 受信時に stdin JSON の `error_type`/失敗フィールドを検査**し、存在すれば `turn_end` ではなく `error` 正規化イベントを発行して `routeSessionError` 経路へ合流させる。これにより rate_limit/overloaded 終了でも Watchdog が WATCHING に留まらず、既にエラー終了したセッションへの誤 Ping（stage2）を防ぐ。最悪でも `SessionEnd` の tombstone が監視を破棄する。
2. **`PermissionRequest`（PAUSED 経路の担保）**: 登録可能なら PAUSED 主経路。不可の場合、`Notification(permission_prompt)`（§5.1・冗長シグナル）を PAUSED の唯一経路とする。両者は同義イベントのため PAUSED 機能自体は縮退しない。残る懸念は `Notification` 配信遅延中に stage1（既定 180s）が満了する誤検知だが、(a) 配信遅延は通常サブ秒で 180s 窓に対し無視可能、(b) 誤 stage1 は黄色警告のみで Ping ではなく `UserPromptSubmit` で即クリアされる低害・自己回復状態。実機で配信 cadence と誤検知不発を確認する（§9.3-4）。

---

## 6. Ping & 通知配信

### 6.1 警告表示（確実に動作）
monitor 内の既存 `Notifier` が tmux ウィンドウ色 / OS 通知を発火する。
- stage1（警告）= 黄、stage2 / SILENCED = 赤、PAUSED（入力待ち）= cyan、正常復帰 = default。
- monitor は Claude Code の子プロセスとして **同一 `TMUX` 環境を継承**するため、tmux 制御は OpenCode 版と同じ経路で動作する。

### 6.2 Ping 注入（新規 `ClaudeCodeAdapter`）
`Watchdog` が `pinger.inject()` を呼ぶと、`ClaudeCodeAdapter` は Ping 文（`buildPingPrompt` により recoverable エラー理由付き）を **monitor の stdout に1行出力**する。Claude Code が monitor stdout を「通知」として Claude へ配信する。

### 6.3 Ping 実効性と補助ベクタ
「ハング中のターンへ Ping を差し込んで実際に自己復旧させられるか」は Claude Code の仕様上不確実であり、実機検証（§9.3）で可否を判定する。フルパリティ方針に基づき、以下の配信ベクタを検証し、有効なものを採用/併用する。
- **主**: monitor stdout → Claude 通知（§6.2）。
- **補助1**: `asyncRewake` フック（exit code 2 で Claude を起床、stderr/stdout を system reminder 提示）。
- **補助2**: `Stop` フックの `decision:"block"`（ターン終了を阻止し理由注入 ＝「早期終了の抑止」用途。ハング中断とは目的が異なるため限定的）。

Ping が実効しない場合でも、§6.1 の tmux/OS 警告表示（akane の主要な可視価値）は維持される。

### 6.4 stdout 規律（絶対制約）
monitor の stdout は「Ping/通知として意図した行のみ」。デバッグ・テレメトリ・要約ログは全て stderr / ログファイルへ出力する。monitor の logger は stdout を使わない設計に固定する（テストで保証、§9.1）。

---

## 7. ビルド・dist 構成・Bitbucket 配布

### 7.1 akane repo への追加物
```text
akane/
├── .claude-plugin/
│   └── plugin.json                 # Claude Code マニフェスト（hooks インライン＋userConfig）
├── monitors/
│   └── monitors.json               # 常駐 monitor 宣言
├── src/claude/…                    # 新規モジュール（§4.2）
├── scripts/
│   └── akane-cc-setup.sh           # 任意: plugin.json/monitors.json が参照する場合のみ（ワンタイム初期化）
├── .github/workflows/
│   └── deploy-claude-to-bitbucket.yml   # nexus パターンを bun 化
└── dist/
    ├── index.js  tui.js            # OpenCode（既存・不変）
    └── claude/  monitor.js  hook.js # Claude Code（新規）
```

### 7.2 マニフェスト（骨子）

`.claude-plugin/plugin.json`（全フックを単一 `hook.js` に集約し `hook_event_name` で分岐）:
```jsonc
{
  "name": "akane",
  "version": "1.5.1",
  "description": "Claude Code session hang detector with tmux/OS notification + recovery ping",
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command",
      "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "MessageDisplay":  [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "PreToolUse":      [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "PostToolUse":     [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "Stop":            [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "Notification":    [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "SessionStart":    [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }],
    "SessionEnd":      [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/hook.js" }] }]
  },
  "userConfig": {
    "stage1_ms": { "type": "number", "default": 180000 },
    "stage2_ms": { "type": "number", "default": 180000 },
    "max_pings": { "type": "number", "default": 1 },
    "notifier_type": { "type": "string", "default": "tmux" }
  }
}
```
> `StopFailure` / `PostToolUseFailure` / `PermissionRequest` / `SubagentStart` / `SubagentStop` の登録可否と matcher 構文は実機の `claude plugin validate` で確定する（§10）。登録不可時の代替経路は §5.4 に定義する。

`monitors/monitors.json`（常駐 Watchdog ホスト）:
```jsonc
[{
  "name": "akane-watchdog",
  "description": "Hang detector state machine",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/dist/claude/monitor.js"
}]
```
> `userConfig` 値は env 経由で hook/monitor へ渡す（nexus が `mcpServers.env` で `${user_config.x}` を渡す方式に倣う）。monitor/hook 側は既存 `resolveConfig` の env 経路で解決する。hooks/monitors の env 受け渡し構文は実機検証で確定する（§10）。

### 7.3 ランタイム & ビルド
- monitor/hook は **`node` 実行**（`target: "node"` でバンドル）。利用者マシンに bun 不要（nexus と同方針）。
- `build.ts` に `buildClaudeMonitor()` / `buildClaudeHook()` を追加し `dist/claude/` へ出力する。

### 7.4 `deploy-claude-to-bitbucket.yml`（nexus 準拠、bun 化）
nexus の `deploy-to-bitbucket.yml` を基に、以下のみ変更する。
- **ビルド系**: `npm ci/build/test/lint` → `bun install` → `bun run typecheck` → `bun test` → `bun run build`
- **検証**: `npx claude plugin validate ./ --strict` を **ビルド後**に実行（nexus と同じ）
- **staging 規則の調整**: 配布 repo には次のみを含める。
  - `.claude-plugin/plugin.json`
  - `dist/claude/`（**`dist/index.js`・`dist/tui.js` の OpenCode 成果物は除外**）
  - `monitors/monitors.json`
  - `plugin.json` / `monitors.json` が参照する `scripts/` 内ファイル
- **除外**: `src/`・`tests/`・`node_modules/`・`.github/`・TS/lint/test 設定・ドキュメント・`.env`
- **認証・冪等スキップ・force-push・`GIT_ASKPASS` によるトークン秘匿**は nexus のまま流用（Bitbucket Access Token `repository:write`、`~/.netrc` または `GIT_ASKPASS`、URL/引数/ログに出さない）。
- **発火**: `workflow_dispatch`（nexus 準拠）。将来 `release: published` への自動連携も選択肢。akane は release-please 運用のため GitHub Release は自動生成される。
- **配布先**: `bitbucket.org/<org>/akane-dist.git`

### 7.5 マーケットプレイス登録（本 repo 外・リファレンス）
別 repo `claude-plugins-marketplace` の `.claude-plugin/marketplace.json` に akane エントリを追加し、marketplace deploy workflow が akane の最新 Release タグに `source.ref` を更新する。
```jsonc
{
  "id": "<org>-internal-plugins",
  "name": "Company Internal Plugins",
  "plugins": {
    "akane": {
      "name": "Akane Watchdog",
      "source": { "repo": "git@bitbucket.org:<org>/akane-dist.git", "ref": "vX.Y.Z" }
    }
  }
}
```
利用者手順: `/plugin marketplace add git@bitbucket.org:<org>/claude-plugins-marketplace.git` → `/plugin install akane@<org>-internal-plugins` → `/reload-plugins`

### 7.6 ガバナンス整理
本設計は `.claude-plugin/plugin.json`・`monitors/monitors.json` の新規作成を伴う。これらは AGENTS.md「No New Agent Config Files」が禁ずる SSOT 上書き用設定ではなく、**プラグインの成果物そのもの**（本作業の明示目的）と整理し、ユーザー承認済みとする。

---

## 8. エラー処理・安全不変条件

### 8.1 Zero-Crash（akane 憲法の継承）
- **hooks（短命）**: 全処理を try/catch し **常に exit 0**、ターン/ツールを block しない（観測専用センサー）。malformed stdin は stderr/ログに退避して exit 0。
- **monitor（常駐）**: 別プロセスで隔離。per-event try/catch で1イベントの失敗が全体を止めない（既存 `index.ts` の containment と同型）。tmux/OS 呼出・stdout 書込も try/catch。
- **events.ndjson 堅牢性**: 破損/部分行は `JSON.parse` の try/catch でスキップ（`shared-state.ts` の `load()` と同思想）。

### 8.2 安全不変条件のマッピング

| 不変条件（AGENTS.md / SPEC） | Claude Code 版での実現 |
|---|---|
| Late-event tombstone（FIFO 10,000） | monitor 内の既存 `BoundedSet`/`stoppedSessions` を流用（Stop/SessionEnd で記録） |
| Arm lock ＋ 手動バイパス | 既存 watchdog ロジックそのまま。`UserPromptSubmit` が手動バイパス |
| Atomic 書込 | events.ndjson は追記型（アトミック追記）／shared-state は既存 `.tmp→rename` |
| Secure logging / masking | 既存 Pinger マスク（sessionId 先頭4字・err 30字）流用。hooks/monitor もユーザ入力・通知本文を生出力しない |
| Color validation regex | 既存の厳格 hex 検証（`/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/`）を再利用 |
| Debug log gating（`AKANE_DEBUG`） | hooks/monitor にも適用（高頻度フックのログ肥大防止） |
| No shell injection | spawn は配列引数（Notifier そのまま） |
| No absolute paths | plugin.json/monitors.json は `${CLAUDE_PLUGIN_ROOT}` 相対、events は stateDir 相対 |

### 8.3 新規の不変条件（Claude Code 固有）
- **monitor stdout 規律**: stdout は Ping/通知行のみ（§6.4）。デバッグ出力が stdout に漏れないことをテストで保証。
- **monitor 単一起動保証（stale lock 回復付き）**: Claude Code が多重起動しない前提だが、既存 `ACTIVE_INSTANCES` 相当のガードを monitor に設置する。in-memory `Set` はプロセス死亡で自動消滅するが、別プロセス跨ぎの排他には `<stateDir>/.akane/monitor.lock`（記録: PID＋起動時刻＋ハートビート時刻）を用いる。取得手順:
  1. lock 不在なら自 PID/時刻を atomic 書込（§8.2 `.tmp→rename`）して取得。
  2. lock 存在時は記録 PID の生存を確認（`process.kill(pid, 0)`）。**死亡していれば stale と判定し奪取**。PID 再利用による誤判定を避けるため、生存確認は記録された起動時刻とも照合し、不一致なら死亡（stale）扱いとする。
  3. 生存かつ起動時刻一致でもハートビートが TTL（既定 = `max(stage2Ms*2, 30000)`）超過で未更新なら stale とみなし奪取。
  4. 生存・起動時刻一致・ハートビート新鮮（＝健全な所有者が存在）なら、新 monitor はロックを取得せず即 exit する（多重稼動させない）。
- **退場手順（ロック整合チェック — 二重稼働防止）**: 奪取（取得手順 2・3）は、奪われた側の旧 monitor を退場させて初めて単一起動を保証する。稼働中 monitor は次を必須とする:
  1. ハートビート書込の直前に `monitor.lock` の PID を読み直し、自 PID（＋起動時刻）と不一致なら「ロックを奪われた」と判断して全タイマーを破棄し即 exit する。これにより旧 monitor が上書き書込でロックを奪還する競合（lock ピンポン）も防ぐ。
  2. stage1/stage2 の通知・Ping 注入といった副作用の実行直前にも同一チェックを行い、サスペンド/レジューム等で復帰した旧 monitor が「次のハートビートまでの隙間」で発火する二重通知・二重 Ping を防ぐ。
  - これによりクラッシュ残留ロックで monitor が永続的に起動不能になる事態を防ぎ（lifecycle 管理は Claude Code（§3-5）だが、クラッシュ→再起動の窓を stale 検知で吸収する）、かつ生存中の旧 monitor が存在する場合も「奪取＋自己退場」で単一起動保証が成立する。

---

## 9. テスト戦略

`bun test`（組み込み）のみを使用する（SPEC §7.1 遵守、追加ランナー無し）。

### 9.1 Unit（新規モジュール）
- `hook.ts`: Claude Code の各 stdin JSON サンプル → 正規化イベント出力のテーブルテスト。exit 0 保証・malformed 入力の握り潰し。
- `event-log.ts`: 追記/読取/tail の往復、破損行スキップ、並行追記の安全性。
- `event-map.ts`: 正規化イベント → Watchdog メソッド呼出のマッピング（MockWatchdog で呼出メソッドをアサート）。
- `ClaudeCodeAdapter`: `inject()` が stdout に1行だけ出力、`buildPingPrompt` 流用、マスク。**stdout 規律テスト**（デバッグ出力が stdout に混入しない）。
- `config.ts (claude)`: env / userConfig の解決。

### 9.2 Integration / Smoke / Stress
- **Integration（monitor）**: fake `Clock` ＋ `events.ndjson` にイベント列を流し込み、stage1/stage2 の発火・`Notifier` 呼出・Ping stdout 出力を検証（既存 `watchdog.test.ts` のシナリオを Claude Code イベント列で再現）。
- **Smoke**: `plugin.json` / `monitors.json` の JSON 妥当性・`claude plugin validate --strict` 相当の構造検証。
- **Stress**: 既存の 1000 セッション × 100 イベントを `events.ndjson` 経由で再現し、Map / アクティブタイマー数が 0 に戻ること、かつ `SessionEnd` 後に全セッションファイルが削除される（disk 側衛生・§4.3）ことを確認。
- **既存 202 テストは不変**（OpenCode 側は非改変）。新規テストを追加する。

### 9.3 実機検証（実装計画の検証ステップ・別途）
実 Claude Code に `--plugin-dir` で導入し、以下を実測してパリティ限界（§5.3）と Ping 実効性（§6.3）を確定する。
1. `MessageDisplay` の発火 cadence 計測（stage1Ms 閾値の妥当性判断）。
2. 意図的ハングで stage1/stage2 が発火し、tmux/OS 警告色が出ること。
3. **monitor stdout → Claude 通知でハング中ターンが動くか**の可否判定（＋ `asyncRewake` / `Stop` block の補助ベクタ評価）。
4. 正常終了・入力待ち（PermissionRequest）で誤検知しないこと。

---

## 10. 実装計画で確定する検証項目（既知の未確定事項）

以下は本設計の前提だが、Claude Code の実機/最新スキーマで最終確定する。`writing-plans` 工程で検証タスクとして計画する。
1. `monitors/monitors.json` の完全スキーマ（`when` トリガ、変数展開、複数 monitor 可否）。
2. hooks / monitors への **userConfig → env 受け渡し構文**（`plugin.json` の env マッピングが hooks/monitors に効くか）。
3. 登録可能なフックイベント名の最終確定（`StopFailure` / `PostToolUseFailure` / `PermissionRequest` / `SubagentStart|Stop` の matcher 構文）。登録不可時のフォールバック設計は §5.4。
4. staging に `monitors/` を含める調整が `claude plugin validate --strict` を通ること。
5. `MessageDisplay` の発火粒度（§5.3-1）。

---

## 11. 受け入れ条件 (Acceptance Criteria)

1. Bitbucket マーケットプレイス経由で `/plugin install akane@<id>` によりインストールでき、`/reload-plugins` で有効化される。
2. `stage1_ms` / `stage2_ms` 等の userConfig（または env）で挙動が変わる。
3. Claude Code の応答が既定時間停止すると tmux 黄色ハイライトと通知が出る。
4. さらに既定時間経過で Ping が 1 回（`max_pings`）注入され、tmux が赤色に切り替わる。
5. `max_pings: 1` で 2 度目の stage2 を迎えても Ping は再注入されない。
6. tmux 非起動環境でも Claude Code / monitor が落ちず、ログのみ残る。
7. フックが malformed 入力を受けても常に exit 0 で Claude Code の動作を妨げない。
8. `bun test` が全て pass する（既存 202 ＋ 新規テスト）。
9. `events.ndjson` 経由の stress test で monitor の Map / タイマー数が停止後 0 に戻る。
10. monitor の stdout に Ping/通知以外の行が出力されない（stdout 規律テスト pass）。
11. `deploy-claude-to-bitbucket.yml` が冪等（Bitbucket 最新タグ == GitHub Release タグならスキップ）に動作する。
12. OpenCode 版の既存挙動・テストが一切変化しない。
13. 長時間セッションで `events` ファイルが無制限に成長せず、`SessionEnd`（および孤児掃除）でセッションファイルが削除される（§4.3）。
14. monitor クラッシュで `monitor.lock` が残留しても、次回起動時に stale 判定で奪取され再起動できる（§8.3）。
15. 生存中の旧 monitor がロックを奪われた際、ハートビート／副作用直前のロック整合チェックで自己終了し、二重通知・二重 Ping が発生しない（§8.3 退場手順）。

---

## 12. 将来拡張余地（非ゴール）
- `release: published` トリガによる Bitbucket 配布の完全自動化。
- Claude Code 版 TUI（現状は OpenCode 版のみ）。
- Ping 実効性が低い場合の代替復旧 UX（人手介入誘導の高度化）。
- marketplace カタログ repo のテンプレート同梱。
