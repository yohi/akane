# 要件定義書: サブエージェント自動表示 & セッション終了

- **対象プロダクト**: `@yohi/akane`（OpenCode watchdog プラグイン）
- **ステータス**: ドラフト（設計・計画フェーズ / 未実装）
- **関連ドキュメント**: [SPEC.md](../SPEC.md), [AGENTS.md](../AGENTS.md), [README.md](../README.md)
- **前提バージョン**: `@opencode-ai/plugin@1.15.12` / `@opencode-ai/sdk@1.15.12`
- **設計との差分（supersession）**: 本書はドラフトであり、レジストリの**配置**については[設計書](subagent-display-and-termination-design.md) D-1 が優先する。設計では新規 [`src/subagent-registry.ts`](../src/subagent-registry.ts) の **server plugin プロセス内 in-memory Map** に一元化し、[`src/shared-state.ts`](../src/shared-state.ts) は**無改変**・**TUI は本レジストリを参照しない**。よって本書中で `shared-state.ts`（file-based アトミック共有）や TUI 共有を前提とする記述（§4 図・§4.1・§9・§14 Phase B）は、実装時は設計書 D-1 に従うこと。

---

## 1. 概要と背景

### 1.1 背景

現状の akane は「ハング検知 → tmux ステータスライン着色 / OS 通知 → Ping 注入」を担う watchdog プラグインであり、tmux 連携は `display-message` とウィンドウ色変更のみ。**サブエージェント用のペイン生成や `opencode attach` 表示は持たない**。

一方で、OmO（oh-my-openagent）のような別プラグインはサブエージェントを tmux ペインに表示するが、その表示は「ペインにフォーカスするまでプレースホルダのまま（遅延 attach）」であり、また完了したサブエージェントの OpenCode セッションを削除しない（`abort` のみで、セッション実体は蓄積し続ける）。

本要件は、この 2 点を akane 側で解決する新機能を定義する。

### 1.2 目的

1. **サブエージェントを、フォーカス不要で即時に tmux 上へ自動表示する。**
2. **サブエージェントの完了後、結果が親に消費されたことを確認したうえで、その OpenCode セッションを自動削除する。**

### 1.3 非ゴール

- メインエージェント（ルートセッション）の表示・削除。**対象は常にサブエージェント(子)のみ。**
- OpenCode 本体やオーケストレーション側（OmO / ネイティブ task ツール）の改変。
- サブエージェントのトランスクリプト永続保管・履歴ダッシュボード。
- フォーカス連動の遅延 attach（本要件は「即時 attach」を採用）。

---

## 2. 用語定義

| 用語 | 定義 |
|---|---|
| サブエージェント / 子セッション | `Session.parentID` が非空の OpenCode セッション。 |
| メイン / ルートセッション | `parentID` を持たないセッション。**本機能の対象外（保護対象）**。 |
| オーケストレーター | サブエージェントを spawn し、その結果を消費する主体（OmO の background-agent、またはネイティブ task ツール）。 |
| 即時 attach（eager attach） | ペイン生成と同時に `opencode attach` を起動し、フォーカス無しでライブ表示する方式。 |
| 結果消費 | オーケストレーターが子セッションのメッセージを読み取り、親セッションへ結果を反映する処理。 |

---

## 3. スコープと役割分担

### 3.1 責務分担（OmO 併用時）

akane と OmO を同時に稼働させる。ただし **tmux 表示は排他**とし、以下のように役割を分ける。

| 主体 | 責務 |
|---|---|
| **OmO（オーケストレーション）** | サブエージェントの spawn・実行・結果の親への注入。**tmux サブエージェント表示は OFF にする。** |
| **akane（表示 + 掃除）** | `session.created`(parentID 有り) を検出し、(1) tmux ペインへ即時自動表示、(2) 結果消費後にセッション削除。 |

> **排他制約**: OmO の tmux サブエージェント表示と akane の表示が同時に有効だと、同一サブエージェントに二重にペインが生成される。運用上、OmO 側の tmux 統合を無効化することを前提とする（§8 参照）。

### 3.2 対象範囲

- **IN**: `parentID` を持つ子セッション。
- **OUT**: `parentID` を持たないメイン/ルートセッション（表示も削除も一切行わない）。

---

## 4. 全体アーキテクチャ

```text
OpenCode ──session.created(parentID)──▶ akane event hook (src/index.ts)
                                          │
                                          ▼
                                  Subagent Registry (shared-state)   ← single source of truth
                                          │  (parent↔child マップ + ライフサイクル状態)
                        ┌─────────────────┼──────────────────────────┐
                        ▼                 ▼                          ▼
                  TUI オーバーレイ    Pane Manager               Session Terminator
                  (既存/着色)        (inline split + 即時 attach   (親活動再開 or grace で
                                      / 上限4 / 最古 evict)         session.delete)

OmO ── サブエージェント spawn（tmux 表示は OFF）──┘
```

### 4.1 設計原則

- **単一レジストリ**: サブエージェントの追跡状態（親子マップ・生成時刻・pane 情報・完了保留フラグ）は [`src/shared-state.ts`](../src/shared-state.ts) のアトミック共有ストアに一元化し、既存 TUI オーバーレイ・新規 Pane Manager・新規 Session Terminator が同一の状態を参照する（追跡器の乱立を防ぐ）。
- **モジュール分離**: 状態は共有しつつ、実装は独立モジュールに分ける（表示 / 削除 / TUI）。
- **zero-crash**: すべての外部プロセス呼び出し（tmux / opencode attach / SDK）は try/catch で内包し、失敗してもプラグイン本体を落とさない（既存の akane 方針を踏襲）。

---

## 5. 機能要件

### FR-1: サブエージェント自動表示（フォーカス不要）

| ID | 要件 |
|---|---|
| FR-1.1 | `parentID` を持つ子セッションを検出したら、tmux ペインを生成して**即時** `opencode attach --session <id> --dir <dir>` を起動する（フォーカス操作を要求しない）。 |
| FR-1.2 | レイアウトは **inline split**（現ウィンドウ内 `split-window`）を採用する。 |
| FR-1.3 | 対象は**全サブエージェント**。ただし同時表示ペインの**上限は 4**。 |
| FR-1.4 | 上限 4 を超える場合、**最古のサブエージェントペインを evict（`kill-pane` で表示のみ除去）**する。evict はペインを閉じるだけで、**OpenCode セッションは削除しない**（表示から外れるだけ）。 |
| FR-1.5 | tmux 外（`TMUX` 環境変数が空、または `tmux` バイナリ未検出）では表示を静かに無効化する（既存 `ensureTmux` 検出ロジックを流用）。 |
| FR-1.6 | `serverUrl` は `PluginInput.serverUrl` から取得する。attach コマンド引数はすべて配列渡し（シェル展開なし）とし、インジェクションを防ぐ。 |
| FR-1.7 | ペイン↔セッションの対応をレジストリに記録し、セッション停止（§FR-3）時に確実にペインを閉じる。 |

**注記（設計上の含意）**:
- 「全サブエージェント × 即時 attach」は、サブエージェント数ぶんの `opencode attach`（フル TUI クライアント）が起動するため負荷が高い。上限 4 + evict はこの負荷とペイン潰れの両方を抑える安全弁である。
- attach がセッション準備完了前に走る可能性に備え、失敗時は軽量リトライを行う（ハードな ready 待ちは実装しない）。

### FR-2: サブエージェント完了時の OpenCode セッション削除

| ID | 要件 |
|---|---|
| FR-2.1 | サブエージェント(子)が完了(`session.idle`)しても、**その時点では削除しない**（結果取りこぼし防止。理由は §11.1）。 |
| FR-2.2 | 子 idle 後、**親セッション(parentID)が活動を再開**（親セッションに対する新たな assistant 活動イベント）したら「結果消費済み」とみなし、子セッションを `client.session.delete({ path: { id } })` で削除する。 |
| FR-2.3 | 親活動再開が観測されない場合の保険として、**grace タイムアウト 60,000ms（60s）**経過で削除する。 |
| FR-2.4 | **`error` 終了の子セッションは削除しない**（デバッグ用に残す）。 |
| FR-2.5 | **メイン/ルートセッション（`parentID` 無し）は絶対に削除しない。** |
| FR-2.6 | 削除は zero-crash 方針で内包し、SDK 失敗時もログのみとする。 |

### FR-3: セッション停止時のペイン後始末（両機能共通）

| ID | 要件 |
|---|---|
| FR-3.1 | `session.idle`（子）では、対象サブエージェントの**ペインを閉じるのみ**とし、レコードはレジストリに**保持**する（`deletePending`/`idleAt`/親子索引を残し、FR-2 の削除判定に供する）。idle 時点でレジストリから除去しない。 |
| FR-3.2 | レコードのレジストリ除去は、akane 自身の `session.delete` 成功後、または `session.deleted` 受信時に行い、あわせて残存ペインがあれば後始末する。参照する「既存 stop 経路（[`src/index.ts`](../src/index.ts) L417-424）」は `session.deleted`/`session.idle` を同一分岐で `watchdog.stop()` に流すが、**新レジストリのレコード除去はイベント種別で分岐**すること（idle では除去しない）。 |
| FR-3.3 | FR-2 による削除を実行した場合、その後に届く `session.deleted` は既に無い状態を許容する（冪等）。 |

---

## 6. 非機能要件

| 区分 | 要件 |
|---|---|
| 堅牢性 | tmux / opencode attach / SDK 呼び出しの失敗でプラグインを落とさない（try/catch 内包、ログのみ）。 |
| セキュリティ | 外部コマンド引数は配列渡し。ログに `sessionId` 全体やメッセージ本文を出さない（既存のマスク方針に準拠、先頭数文字のみ）。 |
| パフォーマンス | 同時 attach クライアントは上限 4。evict によりペイン数を一定に保つ。高頻度イベントでの要約ログを維持。 |
| メモリ | レジストリは停止/削除時にエントリを確実に除去。長期稼働でリークしないこと（既存の FIFO/tombstone 方針と整合）。 |
| 多重起動耐性 | 既存 `ACTIVE_INSTANCES` ガードと整合し、二重にペイン生成しないこと。 |
| 移植性 | 絶対パスをコード/設定に埋め込まない（`$HOME`/相対パス）。 |

---

## 7. 設定スキーマ

`experimental.watchdog` 名前空間に以下を追加する（すべて optional・未指定は default、不正値は warn してデフォルト採用）。両機能とも**デフォルト無効（opt-in）**とする。

```typescript
export interface WatchdogConfig {
  // ...既存フィールド...

  subagentDisplay: {
    enabled: boolean;          // default: false（opt-in）
    layout: "inline-split";    // 今回は inline-split 固定
    maxPanes: number;          // default: 4
    eviction: "oldest";        // 上限超過時に最古を evict
    attach: "eager";           // フォーカス不要の即時 attach
  };

  subagentTermination: {
    enabled: boolean;          // default: false（opt-in）
    trigger: "parent-resume-or-grace";
    graceMs: number;           // default: 60000
    keepOnError: boolean;      // default: true（error 終了の子は残す）
  };
}
```

### 7.1 環境変数（akane の `OPENCODE_WATCHDOG_*` 流儀に準拠）

| 環境変数 | 用途 | デフォルト |
|---|---|---|
| `OPENCODE_WATCHDOG_SUBAGENT_DISPLAY` | サブエージェント自動表示の有効化 | `false` |
| `OPENCODE_WATCHDOG_SUBAGENT_MAX_PANES` | 同時表示ペイン上限 | `4` |
| `OPENCODE_WATCHDOG_SUBAGENT_DELETE` | 完了時セッション削除の有効化 | `false` |
| `OPENCODE_WATCHDOG_SUBAGENT_DELETE_GRACE_MS` | 削除の grace タイムアウト | `60000` |
| `OPENCODE_WATCHDOG_SUBAGENT_KEEP_ON_ERROR` | error 終了の子を残すか | `true` |

### 7.2 設定例（`opencode.jsonc`）

```jsonc
{
  "experimental": {
    "watchdog": {
      "subagentDisplay": {
        "enabled": true,
        "layout": "inline-split",
        "maxPanes": 4,
        "eviction": "oldest",
        "attach": "eager"
      },
      "subagentTermination": {
        "enabled": true,
        "trigger": "parent-resume-or-grace",
        "graceMs": 60000,
        "keepOnError": true
      }
    }
  }
}
```

---

## 8. OmO 併用（tmux 表示の排他）

- **前提**: OmO 側の tmux サブエージェント表示を OFF にする（OmO の tmux 統合を無効化）。akane が表示を専有する。
- **検出と警告**: akane 起動時、OmO の tmux サブエージェント表示が有効と推測できる状況（例: 同一ウィンドウに OmO 由来のサブエージェントペインが既に存在する等）を検出できた場合は、二重表示防止のため warn ログを出す（強制無効化はしない）。
- **spawn 自体は OmO に委譲**: akane はサブエージェントを spawn しない。あくまで OpenCode の `session.created`(parentID) を受けて表示・掃除するのみ。

---

## 9. データ / 状態モデル

`shared-state.ts` に単一の Subagent レジストリを保持する（サーバー hook と TUI 間で共有）。

```typescript
interface SubagentRecord {
  sessionId: string;
  parentId: string;
  paneId?: string;            // 表示中のペイン（未表示なら undefined）
  createdAt: number;
  idleAt?: number;            // 子が idle になった時刻（削除保留の起点）
  terminalReason?: "idle" | "error"; // error は削除対象外
  deletePending?: boolean;    // FR-2 の削除保留フラグ
}
```

- レジストリは atomic 書き込み（`.tmp` → `renameSync`）で更新（既存 shared-state 方針を踏襲）。
- evict / 削除 / 停止時にエントリを整合的に更新・除去する。

---

## 10. イベントフロー

| イベント | 抽出 | akane の動作 |
|---|---|---|
| `session.created` | `info.parentID` | parentID 有り → レジストリ登録。表示有効なら inline split でペイン生成 + 即時 attach（上限 4 超過は最古 evict）。parentID 無し → 無視。 |
| （子）`message.part.delta` 等 | `part.sessionID` | 活性更新（既存 watchdog と共存。表示側は特段の処理不要）。 |
| （子）`session.idle` | `sessionID` | `terminalReason="idle"`、`idleAt` 記録、`deletePending=true`。ペインは閉じる。**セッション削除はまだしない**。 |
| （親）活動再開 | 親 `sessionID` | 対象の子で `deletePending` が立っていれば → `session.delete` 実行。 |
| grace 経過 | タイマー | `deletePending` の子を削除（60s 上限）。 |
| （子）`session.error` | `sessionID` | `terminalReason="error"`。ペインは閉じるが**削除しない**（keepOnError）。 |
| `session.deleted` | `info.id` | ペイン後始末 + レジストリ除去（冪等）。 |

---

## 11. リスクと対策

### 11.1 【最重要】結果取りこぼし（idle 即時削除の禁止根拠）

- **事象**: オーケストレーター（OmO の background-agent 等）は、子セッションの **idle 後に子のメッセージを再読込して結果を親へ反映**する（OmO の `parent-wake-notifier` が `client.session.messages(...)` を呼ぶ実装を確認済み）。
- **リスク**: akane が `session.idle` で即 `session.delete` すると、この結果読込とレースして結果が消失する。ネイティブ task ツールも完了時に子出力を読むため同様。
- **対策**: FR-2.2/2.3。idle では消さず、**親活動再開**（結果消費の代理シグナル）または **grace 60s** で削除する。

### 11.2 二重表示（OmO との競合）

- **対策**: §8。OmO の tmux 表示を OFF にする運用前提 + akane 側の検出 warn。

### 11.3 attach クライアント多数による負荷

- **対策**: 同時表示上限 4 + 最古 evict（FR-1.3/1.4）。

### 11.4 attach 実行がセッション準備前

- **対策**: 失敗時の軽量リトライ（FR-1 注記）。

### 11.5 メイン/ルートの誤削除・誤表示

- **対策**: `parentID` 無しは全処理の対象外（FR-2.5 / §3.2）。

---

## 12. 受け入れ条件（Acceptance Criteria）

1. `subagentDisplay.enabled=true` かつ tmux 内で、サブエージェント起動時に**フォーカス操作なし**でそのセッションが tmux ペインにライブ表示される。
2. サブエージェントが 5 個以上同時に走っても、同時表示ペインは最大 4 に保たれ、超過分は最古から evict される（evict されたセッション自体は削除されない）。
3. `subagentTermination.enabled=true` で、子が idle した**直後には削除されず**、親が処理を再開した後（または 60s 経過後）に `session.delete` が 1 回だけ実行される。
4. `error` 終了した子セッションは削除されない。
5. `parentID` を持たないメイン/ルートセッションは、いかなる場合も表示・削除の対象にならない。
6. tmux 非起動環境でも、両機能が有効でもプラグインが落ちず、ログのみ残る。
7. OmO の tmux 表示 OFF + akane 表示 ON の構成で、サブエージェントのペインが二重に生成されない。
8. `bun test` がすべて pass する（新規モジュールのユニットテスト含む）。

---

## 13. テスト戦略

`bun test`（組み込み）のみを使用する（既存方針を踏襲）。

| レイヤ | 対象 | 手法 |
|---|---|---|
| Unit | Subagent レジストリの登録/evict/削除保留の状態遷移 | 純粋関数 + fake clock |
| Unit | Pane Manager の split/attach/evict | `Bun.spawn` を DI モックし引数（配列）を検証 |
| Unit | Session Terminator の削除トリガ（親再開 / grace） | fake clock + モック SDK。idle 直後に delete が呼ばれないことを検証 |
| Unit | 設定マージ・env 解決・不正値フォールバック | 入出力検証 |
| Smoke | `parentID` 抽出（`session.created`）| SDK 実測 payload 形状に対する整合 |

**必須アサーション（抜粋）**:
- 子 `session.idle` の直後に `session.delete` が呼ばれないこと。親活動再開で 1 回だけ呼ばれること。
- 5 個目のサブエージェント表示で最古ペインが evict され、対応セッションは `delete` されないこと。
- `parentID` 無しセッションに対し、pane 生成も delete も発火しないこと。

---

## 14. 実装フェーズ（計画）

| Phase | 内容 |
|---|---|
| A | SDK 実測固め: `session.created` の `parentID` 実 payload 形状、`client.session.delete` のシグネチャをテスト fixture 化。 |
| B | Subagent レジストリを新規 `subagent-registry.ts`（**server plugin プロセス内 in-memory**・親子マップ + `byParent` 索引 + ライフサイクル）に追加。**`shared-state.ts` は無改変**（設計書 D-1 で確定。TUI は本レジストリを参照しないため file-based 共有ストアは不要）。 |
| C | Pane Manager モジュール新規（inline split / 即時 attach / 上限4 / 最古 evict）+ config + tests。 |
| D | Session Terminator モジュール新規（親再開 or grace で delete / keepOnError）+ config + tests。 |
| E | [`src/index.ts`](../src/index.ts) の event ルータ配線（created→登録/表示・child記録、idle→保留・pane close、親活動→delete、deleted→掃除）。 |
| F | ドキュメント更新（[SPEC.md](../SPEC.md) / [README.md](../README.md) / [AGENTS.md](../AGENTS.md) に新責務・config・OmO 排他・リスクを反映）。 |

---

## 15. 将来拡張余地（非ゴール）

- レイアウト方式の追加（`new-window` / 専用ウィンドウへのグリッド集約）。
- evict ポリシーの選択肢追加（LRU 以外）。
- 削除トリガの高度化（オーケストレーター種別ごとの「結果消費完了」正確検出）。
- メインセッションの表示対応。

---

## 16. SDK 前提（実測）

| 項目 | 実測 |
|---|---|
| サブエージェント判別 | `Session.parentID` が存在（`@opencode-ai/sdk@1.15.12` 型定義で確認）。非空 = 子。 |
| セッション削除 | `DELETE /session/{id}` エンドポイント存在（`client.session.delete({ path: { id } })`）。 |
| 表示 | `opencode attach <serverUrl> --session <id> --dir <dir>` を tmux ペイン内で起動。`serverUrl` は `PluginInput.serverUrl`。 |

---

## 付録: 参考実装（外部）

本要件の表示ロジックは、OmO（oh-my-openagent）の tmux サブエージェント表示（`spawnTmuxSession` / ペイン activate / `opencode attach` コマンド構築）を「即時 attach 版」として参考にする。一方、完了時のセッション削除は OmO には存在しない挙動（OmO は `abort` のみ）であり、本要件独自の追加である。
