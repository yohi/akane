# 設計書: サブエージェント自動表示 & セッション終了

- **対象プロダクト**: `@yohi/akane`（OpenCode watchdog プラグイン）
- **ステータス**: 設計確定（実装計画フェーズへ移行可 / 未実装）
- **派生元**: [要件定義書](subagent-display-and-termination-requirements.md)
- **関連ドキュメント**: [SPEC.md](../SPEC.md), [README.md](../README.md), [AGENTS.md](../AGENTS.md)
- **前提バージョン**: プラグイン API は `@opencode-ai/plugin@1.15.12` / `@opencode-ai/sdk@1.15.12`。`opencode` CLI は 1.17.13 で `attach` を実測確認（§16）。

---

## 1. 概要

本設計は[要件定義書](subagent-display-and-termination-requirements.md)を、既存コード（[index.ts](../src/index.ts) / [shared-state.ts](../src/shared-state.ts) / [notifier.ts](../src/notifier.ts) / [tui.tsx](../src/tui.tsx) / [config.ts](../src/config.ts)）の実測に基づいて具体化したものである。

akane に次の 2 機能を追加する。

1. **サブエージェント自動表示**: `parentID` を持つ子セッションを、フォーカス不要で即時に tmux ペインへライブ表示する。
2. **サブエージェント完了時削除**: 子セッションの結果が親に消費されたことを確認したうえで、その OpenCode セッションを自動削除する。

両機能とも**デフォルト無効（opt-in）**。tmux 非起動環境・外部コマンド失敗時もプラグイン本体を落とさない（zero-crash）。

### 1.1 スコープ（要件書 §3 準拠）

- **IN**: `parentID` を持つ子セッションの「表示」と「完了後削除」。
- **OUT**: メイン/ルートセッション（`parentID` 無し）の表示・削除、OmO / ネイティブ task ツール側の改変、トランスクリプト永続化、フォーカス連動の遅延 attach。

---

## 2. 確定した設計判断（要件書からの差分）

ブレインストーミングで確定した、要件書に対する主要な設計判断。

| # | 判断 | 内容 | 理由 |
|---|---|---|---|
| **D-1** | レジストリ配置 | server plugin プロセス内の **in-memory** モジュール（新規 [`subagent-registry.ts`](../src/subagent-registry.ts)）に一元化。[`shared-state.ts`](../src/shared-state.ts) は**無改変**。 | レジストリの消費者（Pane Manager / Session Terminator / 既存 watchdog 経路）はすべて **server plugin と同一プロセス**。TUI は別プロセスだが、既に `session.created` / `message.part.updated` から**独自にサブエージェントを追跡・表示**しており本レジストリを参照しない。file-based アトミックストアは「server plugin ↔ 別プロセス TUI」の橋渡し専用であり、本用途では不要。アトミック書き込み・JSON スキーマ検証・スロットルの複雑さを回避できる。既存 `ACTIVE_INSTANCES` / `stoppedSessions` / `IGNORED_PING_MESSAGE_IDS` と同系譜。 |
| **D-2** | attach 描画モード | `opencode attach … --mini` **固定**。 | inline-split で最大 4 分割 + メインとなり各ペインが狭い。フル TUI は幅を要求し潰れる。CLI の `--mini`（minimal interactive interface）が適合。目的は「進捗のライブ表示」であり `--mini` で足りる。 |
| **D-3** | 終了トリガ | **parent-resume を主、grace(60s) を孤児バックストップ**（要件書 §11.1 の設計を維持）。 | grace 単独（子 idle から一定時間で削除）は、親が複数の子をまとめて後で消費するケースで「読了前削除」の data-loss を再発させる。「子 idle = 結果を読める状態」かつ「親の新活動は読了後に発生」という不変条件により、parent-resume が消費済みの安全なシグナルになる。grace は「親が二度と再開しない孤児セッション」専用の保険。 |
| **D-4** | config ノブ削減 | `layout` / `eviction` / `attach` を **config から除外**し固定値化。`subagentDisplay` は `enabled` / `maxPanes`、`subagentTermination` は `enabled` / `graceMs` / `keepOnError` のみ。 | いずれも固定値（inline-split / oldest / eager+`--mini`）のため YAGNI。ノブ最小化。将来必要になれば §15 の拡張余地で追加。 |

---

## 3. アーキテクチャ

```text
OpenCode ──event──▶ akane server plugin (src/index.ts) ─── 単一プロセス ─────────────┐
                          │  (event router: created / activity / idle / error / deleted)
                          ▼
                 SubagentRegistry (src/subagent-registry.ts)   ← in-memory・単一の真実
                 Map<sessionId, SubagentRecord> + parent→children 索引
                          │  （3 消費者が同一インスタンスを直接参照）
          ┌───────────────┼─────────────────────────┐
          ▼               ▼                          ▼
   PaneManager        SessionTerminator        既存 Watchdog（無改変）
   (pane-manager.ts)  (session-terminator.ts)  hang 監視・ping はそのまま。
   split-window +     idle→保留、親再開 or      子 idle/error/deleted で
   attach --mini /    grace で                  従来通り stop。
   上限4 / 最古 evict  client.session.delete

TUI プラグイン (src/tui.tsx) は別プロセス・現状維持
   （既に独自にサブエージェントを追跡・表示。本レジストリは参照しない）
```

### 3.1 モジュール構成と責務境界

| モジュール | 区分 | 責務 | 主な依存（DI） |
|---|---|---|---|
| [`subagent-registry.ts`](../src/subagent-registry.ts) | 新規 | 親子マップ + ライフサイクル状態の単一保持。純粋な状態遷移（登録 / idle 記録 / `deletePending` / 最古 evict 対象選定 / 除去 / 親子索引整合）。 | `Clock`（fake 可） |
| [`pane-manager.ts`](../src/pane-manager.ts) | 新規 | tmux `split-window` + `opencode attach … --mini` 起動、上限 4・最古 evict、pane close。tmux 検出は既存 `ensureTmux` 相当を流用。 | `SpawnFn` / `WhichFn` / `env`、`serverUrl`、config |
| [`session-terminator.ts`](../src/session-terminator.ts) | 新規 | 子 idle → `deletePending`、親再開 or grace で `client.session.delete`、`keepOnError`。 | `Clock`、SDK `client` |
| [`config.ts`](../src/config.ts) | 拡張 | `subagentDisplay` / `subagentTermination` の 2 namespace を追加（env > project > default）。 | なし（純粋関数） |
| [`index.ts`](../src/index.ts) | 拡張 | event ルータ配線（§7）。3 モジュールを `ACTIVE_INSTANCES` ガード後に生成。 | 上記すべて |
| [`shared-state.ts`](../src/shared-state.ts) | 無改変 | — | — |
| [`tui.tsx`](../src/tui.tsx) | 無改変 | — | — |

### 3.2 設計原則

- **単一レジストリ（in-memory）**: 追跡状態を [`subagent-registry.ts`](../src/subagent-registry.ts) に一元化し、追跡器の乱立を防ぐ。
- **モジュール分離**: 状態は共有しつつ、表示 / 削除 / 状態保持を独立モジュールに分ける。
- **zero-crash**: すべての外部プロセス呼び出し（tmux / `opencode attach` / SDK）は try/catch で内包し、失敗してもプラグイン本体を落とさない（既存 akane 方針を踏襲）。

---

## 4. データ / 状態モデル（in-memory）

要件書 §9 の `SubagentRecord` を採用するが、**保持先を in-memory の Map に変更**する。

```typescript
interface SubagentRecord {
  sessionId: string;
  parentId: string;
  paneId?: string;                    // 表示中ペイン（未表示なら undefined）
  createdAt: number;
  idleAt?: number;                    // 子 idle 時刻（削除保留の起点 / 最古 evict 判定に流用）
  terminalReason?: "idle" | "error";  // error は削除対象外
  deletePending?: boolean;            // FR-2 削除保留フラグ
}
```

`SubagentRegistry` が内部に保持する（server plugin プロセスのメモリのみ）:

- `records: Map<string, SubagentRecord>` — key = 子 `sessionId`。
- `byParent: Map<string, Set<string>>` — 親 `sessionId` → 子 `sessionId` 集合。親活動再開イベント（子ではなく親の `sessionID` で届く）から `deletePending` の子を **O(1)** で逆引きするための索引。

**整合性**: stop / delete / evict の各タイミングで `records` と `byParent` の両方を整合的に更新・除去する（メモリリーク防止。既存 FIFO/tombstone 方針と整合）。grace タイマーもレコード除去時にクリアする。表示ペイン上限は 4 で、レコード自体はセッション寿命に束縛され有限。

---

## 5. 表示フロー（FR-1: `--mini`）

`session.created`（現状 [index.ts L412-415](../src/index.ts#L412-L415) で「informational session event」として無視）を起点に処理する。

1. `event.properties.info.id`（子 `sessionId`）と `event.properties.info.parentID` を抽出する（新規 `extractParentId` ヘルパ）。
2. `parentID` が空/未定義 → **root/メインセッション** → **従来通り無視**（FR-2.5 / §3.2）。
3. `parentID` 有 → `SubagentRegistry` に登録（`createdAt = clock.now()`）。
4. `subagentDisplay.enabled` かつ tmux 有効なら:
   1. 表示中ペイン数（`paneId` 設定済みレコード数）が `maxPanes`(4) 以上 → **最古を evict**（`createdAt` 最小のものを `tmux kill-pane` で閉じ、`paneId` をクリア。**OpenCode セッションは削除しない**、表示から外れるだけ）。
   2. ペイン生成 + attach を **1 コマンド**で発行:
      ```sh
      tmux split-window -P -F "#{pane_id}" \
        opencode attach <serverUrl> --session <childSessionId> --dir <dir> --mini
      ```
      attach コマンドを **別々の argv 要素**として渡すことで tmux が execvp 実行し、**shell を経由しない**（インジェクション安全）。`-P -F "#{pane_id}"` で新規ペイン ID を stdout から取得し、レコードの `paneId` に格納する。
   3. `serverUrl` は `PluginInput.serverUrl` から取得する。
5. spawn 失敗（exit != 0 / 例外）時は**軽量リトライ**（数回・短間隔）。ハードな ready 待ちは実装しない（FR-1 注記）。
6. ペイン↔セッションの対応をレジストリに記録し、セッション停止（§6）時に確実に閉じる。

**分割方向・整列**: 分割方向（`-h`/`-v`）と `select-layout tiled` 等によるペイン整列は実装詳細とし、Phase A の spike で最適値を確定する。

---

## 6. 終了フロー（FR-2）

| トリガ | 抽出 | 動作 |
|---|---|---|
| 子 `session.idle` | `sessionID` | `terminalReason="idle"`、`idleAt=now`、`deletePending=true`。**ペインを閉じる**（§6.1）。**セッションは削除しない**。 |
| 親の assistant 活動再開 | 親 `sessionID` | `byParent` 索引で当該親の `deletePending` 子を引き、`client.session.delete({ path: { id } })` を実行 → レコード除去。 |
| grace 経過(既定 60,000ms) | 子ごとの `clock.setTimeout` | 満了時にまだ `deletePending` なら delete → レコード除去（孤児バックストップ）。 |
| 子 `session.error` | `sessionID` | `terminalReason="error"`、**ペインを閉じる**。`keepOnError=true`（既定）なら **セッションは残す**が、**レジストリレコードは除去**する（以後アクションせずリークも防ぐ）。 |
| `session.deleted` | `info.id` | ペイン後始末 + レコード除去（冪等, FR-3.2）。 |

### 6.1 ペイン後始末（FR-3, 両機能共通）

対象サブエージェントの `paneId` があれば、いずれのイベントでも `tmux kill-pane` でペインを閉じる。ただし**レジストリレコードの除去タイミングはイベントごとに異なる**（§6 表と整合）:

- **`session.idle`**: ペインのみ閉じ、**レコードは `deletePending=true` のまま保持する**。ここでレコードを除去すると `byParent` 索引と `deletePending` が失われ、親活動再開（§6 表）でも grace（§6 表）でも対象子を発見できず `session.delete` が実行されない（＝削除対象の子セッションが残留する）。実レコード除去は実 `session.delete` 完了後（parent-resume / grace）に行う。
- **`session.error`（`keepOnError=true`）**: ペインを閉じ、**レコードは除去する**（セッション自体は残すが以後アクション不要のため。§6 表と整合）。
- **`session.deleted`**: ペイン後始末 + レコード除去。FR-2 による delete を実行した後に届く `session.deleted` は、既にレコードが無い状態を許容する（冪等, FR-3.2）。

### 6.2 parent-resume の安全性根拠（要件書 §11.1）

子が `idle` に達した時点で、オーケストレータ（OmO の `parent-wake-notifier` / ネイティブ task ツール）は**その子のメッセージを読み取れる/読み取る**状態にある。両者とも**子 idle 時点で個別に結果を読む**実装であり、親が新たな assistant 活動を発生させるのは読了後である。したがって「親再開時に、その親の idle 済み子を削除する」処理は安全であり、`grace` は「親が二度と再開しない孤児セッション」専用の保険として機能する。

---

## 7. イベント配線（[index.ts](../src/index.ts) 変更点）

1. **`session.created` / `session.updated` の分離**: 現状の一括無視（L412-415）を分離し、`created` は §5 の表示フローへ、`updated` は従来通り無視する。
2. **assistant 活動での parent-resume 検出**: assistant 活動イベント（`message.part.delta` で agentName 有 / `message.part.updated` で agentName 有 / `message.updated` role=assistant）で、`watchdog.onActivity` に加えて **`terminator.onParentActivity(sessionId)`** を呼ぶ。`byParent` に該当があれば `deletePending` 子を削除する。
3. **停止イベントへの後始末追加**: `session.idle`（既存 stop 経路 L417-424）に「登録済みサブエージェントなら §6 の idle 処理 + pane close」を追加してから `watchdog.stop`。`session.error` / `session.deleted` にも §6 の後始末を追加。
4. **arm-lock との関係（既知の割り切り）**: 現行 event router では arm-lock 期間中（ping 注入後の回復判定窓）の活動イベントは早期 return され、`onParentActivity` に到達しない。これは ping 後の稀なケースに限られ、**grace(60s) が backstop** するため、繊細な event router の順序は変更しない。正確な配置は実装計画で詰める。
5. **多重起動耐性**: 新モジュールは既存 `ACTIVE_INSTANCES` ガード後に生成するため、二重にペインを生成しない。

---

## 8. 設定スキーマ

`experimental.watchdog` 名前空間に 2 つの optional な object を追加する（未指定は default、不正値は warn してデフォルト採用）。両機能とも**デフォルト無効（opt-in）**。設定の読み込み優先順位は **env > `experimental.watchdog` > project（flat 互換 alias）> defaults** とし、`tmux` / `agents` / `subagentDisplay` / `subagentTermination` などの nested object も同じ優先順位で個別にマージする。`experimental.watchdog` が正規ルートであり、`project`（flat/top-level フィールドまたは `watchdog` キー）は後方互換 alias として扱う。これらの方針は [`src/config.ts`](../src/config.ts) の `ConfigSources` / `resolveConfig` で実装済み。

```typescript
export interface WatchdogConfig {
  // ...既存フィールド...
  // NOTE: WatchdogConfig は parse 後の正規化済み・デフォルト埋め込み済み設定を表す。
  // 未指定フィールドは ConfigSources で optional として受け取り、resolveConfig で埋める。

  subagentDisplay: {
    enabled: boolean;   // default: false（opt-in）
    maxPanes: number;   // default: 4
  };

  subagentTermination: {
    enabled: boolean;      // default: false（opt-in）
    graceMs: number;       // default: 60000
    keepOnError: boolean;  // default: true（error 終了の子は残す）
  };
}
```

> 要件書 §7 の `layout` / `eviction` / `attach` は固定値（inline-split / oldest / eager+`--mini`）のため **config 化しない**（D-4）。

### 8.1 デフォルト値

| キー | デフォルト | 根拠 |
|---|---|---|
| `subagentDisplay.enabled` | `false` | opt-in。attach クライアント多数起動の負荷があるため既定無効。 |
| `subagentDisplay.maxPanes` | `4` | 同時 attach 負荷とペイン潰れの安全弁。 |
| `subagentTermination.enabled` | `false` | opt-in。セッション削除は破壊的操作のため既定無効。 |
| `subagentTermination.graceMs` | `60000` | 孤児セッション削除までの上限。 |
| `subagentTermination.keepOnError` | `true` | error 終了の子はデバッグ用に残す。 |

### 8.2 環境変数（akane の `OPENCODE_WATCHDOG_*` 流儀に準拠）

| 環境変数 | 用途 | デフォルト |
|---|---|---|
| `OPENCODE_WATCHDOG_SUBAGENT_DISPLAY` | サブエージェント自動表示の有効化 | `false` |
| `OPENCODE_WATCHDOG_SUBAGENT_MAX_PANES` | 同時表示ペイン上限 | `4` |
| `OPENCODE_WATCHDOG_SUBAGENT_DELETE` | 完了時セッション削除の有効化 | `false` |
| `OPENCODE_WATCHDOG_SUBAGENT_DELETE_GRACE_MS` | 削除の grace タイムアウト | `60000` |
| `OPENCODE_WATCHDOG_SUBAGENT_KEEP_ON_ERROR` | error 終了の子を残すか | `true` |

### 8.3 設定例（`opencode.jsonc`）

```jsonc
{
  "experimental": {
    "watchdog": {
      "subagentDisplay": {
        "enabled": true,
        "maxPanes": 4
      },
      "subagentTermination": {
        "enabled": true,
        "graceMs": 60000,
        "keepOnError": true
      }
    }
  }
}
```

---

## 9. エッジケース & 非機能要件

| 区分 | 内容 |
|---|---|
| OmO 排他（§8） | OmO 側の tmux サブエージェント表示を OFF にする運用前提。akane 起動時に二重表示を検出できれば warn（強制無効化はしない・best-effort）。akane はサブエージェントを spawn せず、`session.created`(parentID) を受けて表示・掃除するのみ。 |
| 既存 watchdog との共存 | サブエージェントの hang 監視・ping は**無改変**。子 idle で watchdog も停止し、akane の `session.delete` は `session.deleted` 経由で watchdog も掃除するため競合しない。 |
| attach 認証 | サーバに `OPENCODE_SERVER_PASSWORD` 等が設定されている場合 attach が失敗しうる → zero-crash で内包し、binary 名 + exit code のみログ。`-p/-u` 対応は非ゴール。 |
| バージョン差 | CLI 1.17.13 / plugin 1.15.12。attach CLI は安定・疎結合のため実害は低いが、本差分を明記。 |
| 堅牢性 | tmux / `opencode attach` / SDK 呼び出しの失敗でプラグインを落とさない（try/catch 内包、ログのみ）。 |
| パフォーマンス | 同時 attach クライアントは上限 4。evict によりペイン数を一定に保つ。高頻度イベントの要約ログを維持。 |
| メモリ | `records` + `byParent` + grace タイマーを stop/delete/evict で整合除去。長期稼働でリークしない。 |
| 移植性 | 絶対パスをコード/設定に埋め込まない（`$HOME`/相対パス）。 |

---

## 10. セキュリティ

- **インジェクション排除**: すべての tmux / attach 引数は配列（argv）渡し。`split-window` への attach コマンドも別々の argv 要素として渡し、shell 展開を経由しない。
- **ログのセキュア化**: `sessionId` は先頭 4 文字のみ残しマスク。エラー詳細は 30 文字程度に截断（既存方針に準拠）。spawn 失敗時は binary 名 + exit code のみ記録し、コマンド全体は出力しない。
- **絶対パス禁止**: `$HOME` / 相対パスで表現。
- **デバッグログ制御**: 追加のデバッグログは既存 `AKANE_DEBUG` フラグに従う。

---

## 11. テスト戦略（`bun test` のみ）

| レイヤ | 対象 | 手法 |
|---|---|---|
| Unit | `SubagentRegistry` の登録 / idle 記録 / `deletePending` / 最古 evict 選定 / 除去 / 親子索引整合 | 純粋関数 + fake clock |
| Unit | `PaneManager` の split / attach 引数（`--mini` 含む argv 検証）/ 上限4 / 最古 evict / closePane | `Bun.spawn` を DI モックし引数（配列）を検証 |
| Unit | `SessionTerminator` の削除トリガ（親再開 / grace / keepOnError / root 除外） | fake clock + モック SDK。idle 直後に delete が呼ばれないことを検証 |
| Unit | 設定マージ・env 解決・不正値フォールバック（新 2 namespace） | 入出力検証 |
| Smoke | `parentID` 抽出（`session.created`）、`client.session.delete` シグネチャ | SDK 実測 payload 形状に対する整合 |

**必須アサーション（要件書 §13 準拠）**:

- 子 `session.idle` の直後に `session.delete` が呼ばれないこと。親活動再開で **1 回だけ**呼ばれること。
- 5 個目のサブエージェント表示で最古ペインが evict され、対応セッションは `delete` されないこと。
- `parentID` 無しセッションに対し、pane 生成も delete も発火しないこと。
- tmux 検出失敗時に PaneManager を呼んでもプロセスが落ちないこと。

---

## 12. 受け入れ条件（要件書 §12 準拠）

1. `subagentDisplay.enabled=true` かつ tmux 内で、サブエージェント起動時に**フォーカス操作なし**でそのセッションが tmux ペイン（`--mini`）にライブ表示される。
2. サブエージェントが 5 個以上同時に走っても、同時表示ペインは最大 4 に保たれ、超過分は最古から evict される（evict されたセッション自体は削除されない）。
3. `subagentTermination.enabled=true` で、子が idle した**直後には削除されず**、親が処理を再開した後（または grace 経過後）に `session.delete` が 1 回だけ実行される。
4. `error` 終了した子セッションは削除されない（`keepOnError=true`）。
5. `parentID` を持たないメイン/ルートセッションは、いかなる場合も表示・削除の対象にならない。
6. tmux 非起動環境でも、両機能が有効でもプラグインが落ちず、ログのみ残る。
7. OmO の tmux 表示 OFF + akane 表示 ON の構成で、サブエージェントのペインが二重に生成されない。
8. `bun test` がすべて pass する（新規モジュールのユニットテスト含む）。

---

## 13. 実装フェーズ（計画）

| Phase | 内容 |
|---|---|
| A | SDK/CLI 実測固め: `session.created` の `parentID` 実 payload 形状、`client.session.delete` シグネチャをテスト fixture 化。`opencode attach … --mini` を tmux ペインで起動する spike（分割方向・整列・retry 挙動の確認）。 |
| B | `SubagentRegistry`（in-memory・親子マップ + ライフサイクル + 親子索引）を新規追加 + tests。 |
| C | `PaneManager` モジュール新規（inline split / `attach --mini` / 上限4 / 最古 evict / closePane）+ config + tests。 |
| D | `SessionTerminator` モジュール新規（親再開 or grace で delete / keepOnError / root 除外）+ config + tests。 |
| E | [index.ts](../src/index.ts) の event ルータ配線（created→登録/表示・子記録、idle→保留・pane close、親活動→delete、error/deleted→掃除）。 |
| F | ドキュメント更新（[SPEC.md](../SPEC.md) / [README.md](../README.md) / [AGENTS.md](../AGENTS.md) に新責務・config・OmO 排他・リスクを反映）。 |

---

## 14. リスクと対策（要件書 §11 準拠）

| リスク | 対策 |
|---|---|
| 【最重要】結果取りこぼし（idle 即時削除の禁止） | idle では消さず、parent-resume（消費済みの代理シグナル）または grace 60s で削除（§6.2 / D-3）。 |
| 二重表示（OmO との競合） | OmO の tmux 表示 OFF 運用前提 + akane 側の検出 warn（§9）。 |
| attach クライアント多数による負荷 | 同時表示上限 4 + 最古 evict。 |
| attach 実行がセッション準備前 | 失敗時の軽量リトライ（§5-5）。 |
| メイン/ルートの誤削除・誤表示 | `parentID` 無しは全処理の対象外（FR-2.5 / §1.1）。 |
| 狭い inline-split でのペイン潰れ | `--mini` 描画 + 上限4 + evict（D-2）。 |

---

## 15. 将来拡張余地（非ゴール）

- レイアウト方式の追加（`new-window` / 専用ウィンドウへのグリッド集約）と、それに伴う `layout` config の復活。
- evict ポリシーの選択肢追加（LRU 以外）と `eviction` config の復活。
- attach 描画モードの config 化（`attachMode: "mini" | "full"`）。
- 削除トリガの高度化（オーケストレータ種別ごとの「結果消費完了」正確検出）。
- attach サーバ認証（`-p/-u`）対応。
- メインセッションの表示対応。

---

## 16. SDK / CLI 前提（実測）

| 項目 | 実測 |
|---|---|
| サブエージェント判別 | `Session.parentID` が存在（`@opencode-ai/sdk@1.15.12` 型定義で確認）。非空 = 子。`session.created` payload の抽出パスは `event.properties.info.id`（子 ID）/ `event.properties.info.parentID`（親 ID）。 |
| セッション削除 | `DELETE /session/{id}` エンドポイント存在（`client.session.delete({ path: { id } })`）。 |
| 表示（`opencode attach`） | CLI 1.17.13 で実測確認。`opencode attach <url>`（url は必須 positional）+ `--session <id>`(`-s`) + `--dir <dir>` + `--mini`（minimal interactive interface）。`serverUrl` は `PluginInput.serverUrl`。認証時は `-p/--password`（`OPENCODE_SERVER_PASSWORD`）が必要（非ゴール）。 |

---

## 付録: 参考実装（外部）

本設計の表示ロジックは、OmO（oh-my-openagent）の tmux サブエージェント表示（`spawnTmuxSession` / ペイン activate / `opencode attach` コマンド構築）を「即時 attach + `--mini`」版として参考にする。完了時のセッション削除は OmO には存在しない挙動（OmO は `abort` のみ）であり、本設計独自の追加である。
