# Claude Code プラグイン 実機検証結果 (2026-07-08)

Task 15（実機検証ランブック）の実測結果。SPEC §9.3 / §10 の未確定事項の確定状況を記録する。

## 検証環境

- **Claude Code CLI**: `claude` v2.1.159（`/home/y_ohi/.local/bin/claude`）— 利用可能。
- **制約**: 対話型 Claude Code セッション、Bitbucket 配布 repo、marketplace catalog、GitHub Actions シークレットは本環境では利用不可。そのため、実 CLI で完結する検証（マニフェスト検証）と、ビルド済み成果物（`dist/claude/hook.js`・`monitor.js`）を直接実行する end-to-end スモークで達成可能範囲を検証し、対話型セッション/外部インフラ依存項目は deferred/blocked として記録する。

## ✅ 確定・検証済み

### Step 2: マニフェストスキーマ（`claude plugin validate . --strict`）
- **初回失敗（実 CLI が検出）**: `userConfig` の 4 エントリ（`stage1_ms`/`stage2_ms`/`max_pings`/`notifier_type`）に必須の `title`・`description`（string）が欠落（8 errors）＋ `author` 情報欠落（1 warning、`--strict` で error 扱い）。
- **修正**: `.claude-plugin/plugin.json` に各 userConfig の `title`/`description` と `author` を追加（commit c5f53d0）。
- **結果**: `claude plugin validate . --strict` → **✔ Validation passed**（exit 0）。
- 配布ワークフロー（Task 14）が `claude plugin validate ./ --strict` を実行するため、この修正はプラグインの出荷可能性に必須だった。スモークテスト（`manifest.smoke.test.ts`）に title/description/author の回帰ガードを追加。

### ビルド成果物 end-to-end スモーク（Step 1/3/6 の達成可能な代替検証）

**hook.js（センサー、短命 CLI）** — `AKANE_STATE_DIR` を指定し実 Claude hook JSON を stdin 投入:
- `UserPromptSubmit` → `{"kind":"user_message",...,"agentName":"tester"}` を ndjson 追記、exit 0。
- `PreToolUse`(tool_use_id) → `tool_running`(callId)、`Stop` → `turn_end`、いずれも exit 0。
- 不正 stdin（`NOT JSON`）→ **exit 0・無書込**（Zero-Crash / AC #7 を実挙動で確認）。

**monitor.js（頭脳、常駐 CLI）**:
- 起動 → 常駐継続、`<stateDir>/.akane/monitor.lock` 生成（pid/startedAt/heartbeatAt 正常）。
- 既存 ndjson イベントを tail し Watchdog へ dispatch（user_message→arm、turn_end→stop/tombstone）。
- `SIGTERM` → 正常終了・**lock 解放**（monitor.lock 削除）。

**ハング検知 → Ping（AC #3/#4/#10、§6.4、§3.7）** — `AKANE_STAGE1_MS=500 AKANE_STAGE2_MS=500 AKANE_MAX_PINGS=1`、stdout/stderr 分離:
- stderr トレース: onUserMessage → stage1(500ms) → STAGE1 expired → stage2(500ms) → STAGE2 expired → **Injecting Ping (count 1/1)** → `PINGER stdout inject sessionId=hang***`。
- **stdout = ちょうど 1 行**（Ping 本文のみ。デバッグ/テレメトリの混入なし）→ stdout 規律（AC #10 / §6.4）を本番配線で実証。
- sessionId が `hang***` にマスク（§3.7）。
- `max_pings: 1` の再注入抑止は Task 10/11 の単体テストで決定論的に担保済み（AC #5）。

## ⏸ Deferred / Blocked（対話型セッション・外部インフラ依存）

| 項目 | 状態 | 理由 |
|---|---|---|
| Step 1b: marketplace install/reload（AC #1） | `[blocked]` | Bitbucket 配布 repo と marketplace catalog が本環境に未整備。ローカル `--plugin-dir` smoke を marketplace install の代替として過剰主張しない。 |
| Step 3: 実 stdin フィールド名確定（§10-3） | `[deferred]` | hook は best-estimate 名（`hook_event_name`/`session_id`/`tool_use_id`/`error_type`/`notification_type`）を使用。全生フィールドアクセスを `CCHookStdin` + 抽出関数に集約済み（実機確認後は 1 箇所修正で済む）。実 `claude` セッションのフック発火による確定は未実施。 |
| Step 4: userConfig→env 受け渡し（§10-2） | `[deferred]` | 実プラグインロード + userConfig 設定を伴う monitor 起動が必要。写像契約（AKANE_* → OPENCODE_WATCHDOG_*）は Task 3 で単体検証済み。 |
| Step 6（一部）: MessageDisplay cadence 計測 / tmux・OS 通知の目視 | `[deferred]` | 対話型セッション + tmux 環境が必要。 |
| Step 7: 配布 CI 冪等性（AC #11） | `[deferred]` | GitHub Actions 実行 + Bitbucket シークレットが必要。冪等ガード（`git ls-remote` の `\|\| true` 削除による fail-fast）は Task 14 で実装・レビュー済み。 |

## まとめ

- Task 1–14（TDD コア）は完成・出荷可能。フルスイート 306 pass / 0 fail、typecheck 0 errors、`bun run build` 4 バンドル、`claude plugin validate . --strict` 通過。
- 実成果物の end-to-end 動作（sensor → 一方向 IPC → brain → Ping、stdout 規律、Zero-Crash、lock ライフサイクル、マスキング）を実機で確認。
- 残る未確定事項は全て対話型 Claude Code セッションまたは外部配布インフラに依存し、それらが利用可能な環境での追検証を要する。実フィールド名が判明した場合の修正は `src/claude/hook.ts` の `CCHookStdin` + 抽出関数の 1 箇所に限定される。
