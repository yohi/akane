# OpenCode Watchdog プラグイン 設計仕様

- **作成日**: 2026-05-28
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
3. 二次対応として自動的に Ping メッセージを投入し、エージェントの自己復旧を試みる。
4. 上記をプラグインとして実装し、OpenCode 本体には手を入れない。

### 1.3 非ゴール

- LLM プロバイダ側のハング原因の自動診断 (タイムアウト判定までしか責務を持たない)。
- 完全な障害復旧 (Ping で復旧しない場合は通知のみで人間の介入に委ねる)。
- 監視ダッシュボード・履歴永続化 (将来拡張余地として残す)。

---

## 2. 統合方式の決定

### 2.1 採用方式: `@opencode-ai/plugin` 公式プラグイン API

OpenCode が公式ドキュメントで公開している Plugin API (`event` フックや `client` SDK) を利用する。

**根拠**:

- `@/bus` の直接 import はモノレポ内部パスエイリアスであり、外部プラグインからは到達不能。
- OpenCode 本体の fork は保守追従コストが高く、長期運用に耐えない。
- 外部ラッパープロセス案はストリーミングチャンクの粒度で検出できず、要件「チャンク受信ベースのタイマーリセット」と整合しない。

### 2.2 利用するプラグインフック

- `event` フック: すべての検出ロジックの入口。後述のイベント型を分岐処理する。
- `client.app.log()`: Tmux フォールバック時の構造化ログ出力。
- `client.session.*`: Ping 注入のため。実メソッド名は SDK 確定時に確定 (本仕様では `Pinger` インタフェースで抽象化)。

### 2.3 監視対象イベント

| イベント | 用途 |
|---|---|
| `message.updated` (role=user) | **初期タイマー起動トリガ**。ユーザーが入力を確定し、エージェントが応答を開始することが期待される瞬間。これにより初期ハング (一度も `message.part.updated` を発火させずにハングするケース) を検知できる |
| `message.part.updated` | 活性シグナル。受信のたびにタイマーをリセット |
| `session.idle` | 正常終端。タイマーと内部状態を破棄 |
| `session.error` | 異常終端。タイマーを破棄し赤色ハイライト解除 |
| `session.deleted` | セッション破棄。同上 |
| `session.created` | 情報イベントのみ。**タイマーは即時にはアームしない** (空のセッションが放置されただけで誤検知するのを避けるため、起動条件はユーザー入力確定時に限定) |

**初期トリガのイベント名について**: `message.updated` (role=user) は OpenCode のメッセージイベント体系に基づく想定であり、正確なイベント名 (またはペイロードの判別方法) は実装フェーズで `@opencode-ai/plugin` の型定義を確認して確定する。代替候補として `tui.prompt.append` がある。この不確実性は `Pinger` 抽象 (§6) と同じ方針で、Watchdog コアロジック側は「初期トリガを 1 種類受け取る」インタフェースとして抽象化する。

---

## 3. アーキテクチャ

### 3.1 モジュール構成

```
src/
├── config.ts        # 設定の読み込み・マージ・defaults
├── watchdog.ts      # セッション単位のタイマーと状態マシン
├── notifier.ts      # Tmux 検出と display-message / window highlight
├── pinger.ts        # Pinger インタフェースと OpenCodeAdapter
├── clock.ts         # setTimeout を抽象化した Clock (テスト用 DI)
└── index.ts         # OpenCode プラグインエントリ
```

### 3.2 責務境界

| モジュール | 責務 | 主な依存 |
|---|---|---|
| `config` | 設定ソースの優先順位解決・型安全な defaults | なし (純粋関数) |
| `watchdog` | 各 sessionId のタイマー管理、状態遷移、活性検知 | `Notifier`, `Pinger`, `Clock` (すべて DI) |
| `notifier` | Tmux 有無判定、`tmux display-message`、ウィンドウ色制御、フォールバック | `Bun.spawn`, `Bun.which`, `process.env.TMUX` |
| `pinger` | `Pinger` インタフェース定義と `OpenCodeAdapter` 実装 | OpenCode `client` SDK |
| `clock` | `setTimeout` / `clearTimeout` の DI 化 | なし |
| `index` | プラグインエントリ。`event` を `watchdog` に委譲 | 上記すべて |

**Notifier インタフェース統一**: `Notifier` は `notify(sessionId, stage, message)` と `clear(sessionId)` の 2 メソッドのみを公開する。stage1 は `stage="warn"`、stage2 (Ping 注入) は `stage="critical"`、SILENCED 突入は `stage="silenced"` で区別する (`escalate` メソッドは設けない)。stage 値は §5.2 で表色を一意に決定する。

### 3.3 イベントフロー

```text
message.updated (role=user)   ◀── 初期タイマー起動 / post-stop 再アームトリガ
    └─► watchdog.onUserMessage(sessionId)
            ├─ tombstone セットから sessionId を削除 (post-stop 再アーム用)
            └─ 以降は onActivity と同一経路 (Map のエントリを WATCHING にリセット、stage1 タイマー setTimeout)

message.part.updated
    └─► watchdog.onActivity(sessionId)
            ├─ tombstone セットに sessionId が含まれる場合は即 return (stale event 抑止)
            ├─ Map<sessionId, TimerHandle> から既存タイマーを clearTimeout
            ├─ state を WATCHING にリセット、pingCount を 0 へリセット (PINGED/SILENCED からも復帰可)
            └─ stage1 タイマーを setTimeout (default 180s)

stage1 expire
    └─► state = STAGE1_NOTIFIED
        notifier.notify(sessionId, stage="warn")
        stage2 タイマーを setTimeout (default 180s)

stage2 expire
    ├─ pingCount < maxPings:
    │    state = PINGED
    │    pinger.inject(sessionId, config.pingMessage)
    │    pingCount += 1
    │    notifier.notify(sessionId, "critical", message)
    │    stage2 タイマーを再セット (Ping への応答待ち)
    │
    └─ pingCount >= maxPings:
         state = SILENCED
         notifier.notify(sessionId, "silenced", message)
         以降は通知のみ。Ping は発火しない。

session.idle / session.error / session.deleted
    └─► watchdog.stop(sessionId)
            ├─ 全タイマー clearTimeout
            ├─ notifier.clear(sessionId) (ウィンドウ色復帰)
            └─ Map から sessionId エントリを削除
```

### 3.4 状態マシン

```text
        ┌──────┐
        │ IDLE │  ← 初期状態 (Map にエントリ無し / タイマー無し)
        └──┬───┘
           │ message.updated (role=user)   ※初期タイマー起動トリガ / post-stop の再アーム
           │ または message.part.updated   ※未停止セッションでの再活性のみ (post-stop は抑止)
           ▼
                    activity
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
        └─── activity ────────┤ PINGED  │  │ SILENCED │
                              └─────────┘  └──────────┘
                                   │            │
                                   └─activity───┘ (activity で WATCHING へ復帰、pingCount リセット)

  session.idle / session.error / session.deleted → 全状態から IDLE へ (cleanup)
```

**IDLE 状態の意味**: `Map<sessionId, ...>` にエントリが存在しない状態。タイマーは存在しない。`message.updated (role=user)` を初回受信した時点で WATCHING へ遷移し、エントリと stage1 タイマーが生成される。これにより、**初回チャンクを一度も受信せずにハングするケース (初期ハング) が stage1 タイマーの満了で検知可能** となる。

**IDLE への post-stop 抑止 (§7.3 の補足)**: `session.idle / session.error / session.deleted` を受信して IDLE へ遷移した sessionId は、後続の `message.part.updated` (遅延配信された stale event) では **再アームしない**。再アームは `message.updated (role=user)` (= 新規ユーザー入力) を受信した場合に限る。これは §7.3 の必須アサーション「`session.idle` 後に `message.part.updated` を受信しても新規タイマーが作られない」を satisfy するための制約で、実装上は stop された sessionId を **FIFO 上限 10,000 件の tombstone セット** に記録して `message.part.updated` 側で抑止し、`message.updated (role=user)` 側で tombstone を解除する。**上限を超えた場合は最古の sessionId から FIFO evict** され、退避済みエントリへの遅延 event は新規セッション扱いになる (長期稼働プロセスでのメモリ無制限増加を回避するためのトレードオフ)。

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
| `pingMessage` | (下記定型文) | 要件指定 |
| `tmux.enabled` | `true` | Tmux 検出時のみ実効 |
| `tmux.displayMessage` | `true` | display-message を使用 |
| `tmux.highlightWindow` | `true` | window-status-current-style を使用 |
| `agents.include` | `undefined` | 未指定時はすべて監視 |
| `agents.exclude` | `undefined` | 未指定時は除外なし |

**pingMessage の既定値**:

> 現在の状況を教えてください。ハングしているようであれば、思考プロセスを要約して次のアクションを提示してください。

### 4.3 設定ソースと優先順位

優先度が高い順に:

1. **環境変数** — CI や一時的な上書き向け
   - `OPENCODE_WATCHDOG_ENABLED`
   - `OPENCODE_WATCHDOG_STAGE1_MS`
   - `OPENCODE_WATCHDOG_STAGE2_MS`
   - `OPENCODE_WATCHDOG_MAX_PINGS`
2. **`opencode.json` の `experimental.watchdog`** — プロジェクト固定
3. **defaults** — 上記いずれも未指定時

### 4.4 設定マージ規約

- すべてのキーは optional として受け取り、未指定はデフォルトへフォールバック。
- 不正な値 (負の数、型不一致) は warn ログを出して defaults を採用。プラグインを落とさない。

---

## 5. Tmux 連携

### 5.1 Tmux 環境検出 (3 段階)

1. `process.env.TMUX` が非空であること (Tmux 内実行)。
2. `Bun.which("tmux")` が解決可能であること。
3. `tmux display-message -p "#{session_name}"` の dry-run が exit 0 で返ること。

3 まで通過した場合のみ Tmux 連携を有効化。結果は `notifier` 内部にキャッシュし、再判定は行わない。

### 5.2 通知アクション

| トリガ | 動作 |
|---|---|
| `stage1` 到達 | `tmux display-message "[Watchdog] Agent <sessionId> idle for <stage1Ms>ms"`<br/>`tmux set-window-option window-status-current-style 'bg=yellow'` |
| `stage2` 到達 (Ping 発火) | `tmux display-message "[Watchdog] Ping injected to <sessionId>"`<br/>`tmux set-window-option window-status-current-style 'bg=red'` |
| `SILENCED` 突入 | `tmux display-message "[Watchdog] Max pings reached. Manual intervention required."` (色は赤を維持) |
| `session.idle/error/deleted` | `tmux set-window-option window-status-current-style 'default'` |

### 5.3 フォールバック

- Tmux 検出失敗時: `client.app.log({ level: "warn" })` で OpenCode 内部ログのみ。
- `Bun.spawn` 自体が失敗した場合 (ENOENT 等): try/catch で握りつぶし、log を残す。
- **絶対条件**: フォールバック経路でも例外を上位に伝播させない。Watchdog 起因で OpenCode を落とさない。

---

## 6. Pinger 抽象

### 6.1 インタフェース

```typescript
export interface Pinger {
  inject(sessionId: string, message: string): Promise<void>;
}
```

### 6.2 実装

```typescript
export class OpenCodeAdapter implements Pinger {
  constructor(private client: unknown /* OpenCode SDK */) {}

  async inject(sessionId: string, message: string): Promise<void> {
    // ベースライン: 現行 @opencode-ai/plugin の SDK 形に従う。
    //   client.session.prompt({
    //     path: { id: sessionId },
    //     body: { parts: [{ type: "text", text: message }] }
    //   })
    // 正式形は実装フェーズで `docs/SDK_NOTES.md` に記録される実測値に従う。
    // 旧候補 (履歴。SDK 形状不確定時の検討メモ):
    //   client.session.promptAsync({ sessionId, parts: [...] })
    //   client.session.message({ sessionId, parts: [...] })
  }
}

export class MockPinger implements Pinger {
  public calls: Array<{ sessionId: string; message: string }> = [];
  async inject(sessionId: string, message: string): Promise<void> {
    this.calls.push({ sessionId, message });
  }
}
```

### 6.3 不確実性の取り扱い

- 実 SDK のメソッド名・引数形は実装フェーズで `@opencode-ai/plugin` の型定義を確認して確定する。
- `OpenCodeAdapter` 内部だけが変更点となる。Watchdog コアは一切影響を受けない。

---

## 7. テスト戦略

### 7.1 テストランナー

`bun test` (組み込み) のみを使用する。**追加のテストランナー依存は導入しない** (jest / mocha / vitest / chai 等を持ち込まず、Bun 組み込みアサーションで完結させる方針)。SDK 型整合のために `@opencode-ai/plugin` を `devDependencies` へ追加するのは本方針に反しない (テストランナーではなく被テスト対象の SDK であるため)。

### 7.2 テストレイヤ

| レイヤ | 対象 | 手法 |
|---|---|---|
| Unit | `config` のマージ・defaults・不正値処理 | 純粋関数の入出力検証 |
| Unit | `watchdog` の状態遷移とタイマー管理 | `Clock` を fake にし、stage1/stage2 を任意時点に進める |
| Unit | `notifier` の Tmux 呼び出し | `Bun.spawn` を DI 経由のモックに差し替え、引数を検証 |
| Unit | `pinger` の `MockPinger` | 副作用の有無のみ確認 |
| Smoke | プラグインロード | `@opencode-ai/plugin` 型に対するインポート整合のみ確認 (OpenCode 本体は起動しない) |

### 7.3 必須アサーション

- `message.part.updated` を N 回連続で受け取っても、Map 内のタイマーは常に 1 つだけ。
- `session.idle` 後に `message.part.updated` を受信しても新規タイマーが作られない (stop 時に sessionId を **FIFO 上限 10,000 件の tombstone セット** へ登録し、それ以内に到着した `message.part.updated` 側で抑止するため。Map 削除だけでは `onActivity` 経由で再エントリが生成されるため不十分。**上限超過時は最古から FIFO evict** され、退避済み sessionId への遅延 event は新規セッション扱いとなる。詳細は §3.4 「IDLE への post-stop 抑止」を参照)。
- `maxPings = 1` の設定で stage2 を 2 度連続発火させても、`pinger.inject` の呼び出しは 1 回のみ。
- Tmux 検出失敗時に notifier を呼んでもプロセスが落ちない。
- **初期ハング検知**: `message.updated (role=user)` のみを受信し、その後一切 `message.part.updated` が来ない状態で stage1Ms が経過した場合、`notifier.notify` が呼ばれること。さらに stage2Ms 経過で `pinger.inject` が 1 回呼ばれること。
- **空セッションの誤検知防止**: `session.created` のみを受信し、`message.updated (role=user)` が一度も来ない場合、stage1Ms が経過してもタイマーは存在せず `notifier.notify` も呼ばれないこと。

### 7.4 メモリリーク検証

- 1000 セッション × 100 チャンクのストレステストを実施し、`Map` のサイズが `session.idle` 後に 0 に戻ること、active timer 数が 0 になることを検証。

---

## 8. Devcontainer

### 8.1 目的

- ホスト環境を汚さずに Bun 1.3+ と tmux を再現可能にする。
- CI でも同一手順でテスト可能にする。

### 8.2 構成

```text
.devcontainer/
├── devcontainer.json
├── Dockerfile
└── postCreate.sh
```

- **ベース**: `mcr.microsoft.com/devcontainers/base:debian-12`。
- **Bun**: `ghcr.io/shyim/devcontainers-features/bun:0` で 1.3+ 系を導入。
- **tmux**: Dockerfile で apt 経由インストール (テスト時に containerized tmux で完結させる)。
- **マウント**: ソースのみ。ホストの `~/.config/opencode` 等は mount しない。
- **postCreate**: `bun install` のみ。

---

## 9. セキュリティと安全性

- 絶対パスをコミットしない (`$HOME`, 相対パスで表現)。
- ログに API キーやセッションの本文を出さない (sessionId と状態遷移のみ)。
- `Bun.spawn` で外部コマンド (tmux) を呼ぶ際、引数は文字列連結ではなく配列引数で渡し、シェル展開を経由させない。
- プラグイン由来の例外で OpenCode 本体を落とさない。すべての非同期境界に try/catch を置く。

---

## 10. 受け入れ条件 (Acceptance Criteria)

1. プラグインを `~/.config/opencode/plugins/` に置くだけで有効化される。
2. `OPENCODE_WATCHDOG_STAGE1_MS=1000` 等の環境変数で挙動が変わる。
3. 180 秒 (デフォルト) のストリーム停止で Tmux 黄色ハイライトと display-message が出る。
4. さらに 180 秒経過で Ping が 1 回注入され、Tmux が赤色に切り替わる。
5. `maxPings: 1` の状態で 2 度目の stage2 を迎えても Ping は再注入されない。
6. Tmux 非起動環境でプラグインを動かしてもプロセスが落ちず、ログのみ残る。
7. `bun test` がすべて pass する。
8. `Map` 内タイマー数が `session.idle` 後に 0 になることを stress test で確認できる。
9. **初期ハング検知**: ユーザーがプロンプトを送信した直後にエージェントが一度も応答チャンクを返さずハングした場合でも、stage1Ms 経過で通知が出て、さらに stage2Ms 経過で Ping が注入される。
10. **空セッション誤検知なし**: 新規セッションを作成しただけでユーザー入力が無い状態では、いかなる時間が経過しても Watchdog はトリガしない。

---

## 11. 将来拡張余地 (非ゴール)

- ハング原因の自動診断 (LLM プロバイダ側の HTTP ステータス監視等)。
- Tmux 以外の通知バックエンド (Slack, OS native notification 等)。
- 状態遷移の永続化と再起動後の復元。
- ダッシュボード UI。
