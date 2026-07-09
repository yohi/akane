# Changelog

## [1.6.0](https://github.com/yohi/akane/compare/v1.5.1...v1.6.0) (2026-07-09)


### Features

* **claude:** akane を Claude Code プラグインとして動作させる（src/claude/ + マニフェスト + 配布ワークフロー） ([b55e3a0](https://github.com/yohi/akane/commit/b55e3a01c193368e2b0b5d9b6b64d14088a99c00))
* **claude:** AKANE_* env を resolveConfig へ写像する設定解決を追加 ([280edf3](https://github.com/yohi/akane/commit/280edf37d83046ef9a2e7dd02639fb129779ff2c))
* **claude:** CC stdin を正規化・追記する akane-hook センサーCLI を追加 ([2fbd0f8](https://github.com/yohi/akane/commit/2fbd0f8af54d043d6cfa45cfc640107d950ca042))
* **claude:** events.ndjson の追記・tail(EventTailer, read-offset)を追加 ([6446a52](https://github.com/yohi/akane/commit/6446a52eb5350c1db7ec7625cc734379ae3fc821))
* **claude:** monitor 単一起動ロック(MonitorLock)と stale 奧取を追加 ([8eacf66](https://github.com/yohi/akane/commit/8eacf66f431e80c977d05f29be16d7995be66808))
* **claude:** plugin.json / monitors.json マニフェストとスモーク検証を追加 ([efa782f](https://github.com/yohi/akane/commit/efa782fbdd28b58a7927a56bc0022c0e01723ad1))
* **claude:** stateDir 解決と events パス生成・sessionId サニタイズを追加 ([cf5d26e](https://github.com/yohi/akane/commit/cf5d26e9b8332be229b6eb0a0c926113587f0d2c))
* **claude:** stdout へ Ping を出力する ClaudeCodeAdapter を追加 ([284006a](https://github.com/yohi/akane/commit/284006a71d27c895fd4905a02ca9cbb254899193))
* **claude:** tombstone 永続化・セッションログ削除・孤児掃除を追加 ([2a78de5](https://github.com/yohi/akane/commit/2a78de50a7de985a3cfb5c92693358d46db6e86e))
* **claude:** 常駐 monitor(ClaudeMonitor)と lock ガード付き Notifier/Pinger を追加 ([8d4dfac](https://github.com/yohi/akane/commit/8d4dfacaf59c1cc0ab18adc1687211e7868051fc))
* **claude:** 正規化イベントを Watchdog メソッドへ dispatch する event-map を追加 ([d6fdb87](https://github.com/yohi/akane/commit/d6fdb87c2dbfcb5e5a1e0a6fb9bacc7424d646ac))
* **claude:** 正規化イベント型 AkaneClaudeEvent と型ガードを追加 ([6389a71](https://github.com/yohi/akane/commit/6389a713a446dd5af3c5e830fedc2130faaf2db6))


### Bug Fixes

* **claude:** build.ts の Bun.build に root:"。" を設定し bun test での ../errors 解決失敗を修正 ([3951be4](https://github.com/yohi/akane/commit/3951be41516e4ea61f19dea76db40087572de5ea))
* **claude:** CCHookStdinのエージェント識別フィールドを公式仕様に修正 ([0c0313d](https://github.com/yohi/akane/commit/0c0313d20e32669ad80a51ed42844e99a7ac7871))
* **claude:** EventTailerのカーソルを永続化し再起動後のイベント重複ディスパッチを防止 ([0b4b414](https://github.com/yohi/akane/commit/0b4b414b5fb64874ad94f4281af613bf0b7c8d01))
* **claude:** heartbeat の一時的I/Oエラーで即終了せずリトライを許容 ([986305f](https://github.com/yohi/akane/commit/986305f693e355e1d703e2238e613c06bc053e95))
* **claude:** lock.tsの疑似乱数トークン生成をcrypto.randomUUID()に置換 ([af96024](https://github.com/yohi/akane/commit/af96024d721d9943ff423d9e72e33c26e5c30ce8))
* **claude:** manifest未登録の5フックイベントを追加登録 ([15fed49](https://github.com/yohi/akane/commit/15fed494e7b77068bb75d80e2a82092634bd1edb))
* **claude:** monitor.lock の一時ファイル名を PID 付与で一意化し多重起動時の rename 競合(ENOENT)を回避 ([b4924d8](https://github.com/yohi/akane/commit/b4924d8fb1fc56674daf92c5e7e7bf4b5c315219))
* **claude:** monitor.lockのクロスプロセス排他制御をアトミックなゲートに変更 ([25aade5](https://github.com/yohi/akane/commit/25aade5bccf63e7a4812268e1348ffe481e08cd4))
* **claude:** MonitorLock.write を zero-crash 化し tryAcquire/heartbeat の I/O 失敗時 throw を防止 ([5f0aadf](https://github.com/yohi/akane/commit/5f0aadf553419b1176dbb0cfe923bcc060e9ef69))
* **claude:** pingerの改行正規化をsafe-error.tsと統一しcatch内ログ呼び出しも保護 ([3b57a87](https://github.com/yohi/akane/commit/3b57a87278f9de7dd78571a7810d3ab27a550f1b))
* **claude:** plugin.json に userConfig title/description と author を追加し claude plugin validate --strict を通過 ([c5f53d0](https://github.com/yohi/akane/commit/c5f53d046d837da317e2a5f4d9e0c36950850bba))
* **claude:** solid plugin を遅延 import 化し bun test 時の Bun.build グローバルプラグイン干渉(../errors 解決失敗)を修正 ([dbe48d1](https://github.com/yohi/akane/commit/dbe48d16594e388d372fb0cd313622a25a4425ca))
* **claude:** TombstoneStore の flush tmp ファイル名をPID一意化 ([c29fb61](https://github.com/yohi/akane/commit/c29fb612e8097227575dbd782bd6dac7c3749631))
* **claude:** TombstoneStore.flush()がディスク上の最新tombstoneをマージするよう修正 ([0cacad0](https://github.com/yohi/akane/commit/0cacad0b053f1457e7aeaa44931735889c579cab))
* **claude:** エラーログのサニタイズを改行全種対応にし共有ヘルパーに統一 ([1cffb6e](https://github.com/yohi/akane/commit/1cffb6e788fc88999be80c48d790379a72f2c764))
* **claude:** ロック喪失時のstateStore解放漏れとsession_end処理のO(n^2)I/Oを修正 ([bca7d62](https://github.com/yohi/akane/commit/bca7d62aab15c831d2038d0deae0654a66be400c))
* **claude:** 配布ワークフローの GitHub コンテキストを env 経由化し run ブロックのスクリプトインジェクション面を除去 ([2399aa0](https://github.com/yohi/akane/commit/2399aa09f3d850e1eafaae54cbe51fe85aca472a))

## [1.5.1](https://github.com/yohi/akane/compare/v1.5.0...v1.5.1) (2026-07-05)


### Bug Fixes

* **tui:** file:指定のTUIプラグイン登録時にディレクトリではなくdist/tui.jsを登録する ([de29f1b](https://github.com/yohi/akane/commit/de29f1bde396855a9695fe1aca0cb094b8915dfb))
* **tui:** file:指定のTUIプラグイン登録時にディレクトリではなくdist/tui.jsを登録する ([2623988](https://github.com/yohi/akane/commit/2623988d0b6d5e81be837c8fbdeff20ee5ce3178))
* **tui:** TUIプラグイン登録のレビュー指摘3件に対応 ([3de368d](https://github.com/yohi/akane/commit/3de368dbba32e6b9b878b0816bd71cdec7b4e4e5))
* **tui:** TUIプラグイン登録のレビュー指摘4件に対応 ([ce0bd8f](https://github.com/yohi/akane/commit/ce0bd8fd9d320cdd10fc86f3d2e26107fba134d2))

## [1.5.0](https://github.com/yohi/akane/compare/v1.4.1...v1.5.0) (2026-07-05)


### Features

* experimental.watchdog 正規ルート化と subagent 設定の型・解決処理追加 ([4327ed3](https://github.com/yohi/akane/commit/4327ed395b5fd9310362f46a338eb7d2cbdeb17e))
* **tui:** add automatic TUI plugin registration on startup ([61498a6](https://github.com/yohi/akane/commit/61498a64d9d47cd2c5f04d0ba3b51041c5cf1492))
* **tui:** プラグイン起動時の tui.json 自動登録機能を追加 ([a7950f3](https://github.com/yohi/akane/commit/a7950f36f60f6ceb2ea9987f9cfaecb7a1ddb0f0))


### Bug Fixes

* **typecheck:** file: パス解析時における basename の undefined チェックガードの追加 ([c8590fc](https://github.com/yohi/akane/commit/c8590fcbb23e7a55b240bf4f937d72016b303b2b))

## [1.4.1](https://github.com/yohi/akane/compare/v1.4.0...v1.4.1) (2026-06-28)


### Bug Fixes

* TUI公開物を同梱する ([1b23d13](https://github.com/yohi/akane/commit/1b23d1342a7040362305fb33a2774606cbef52df))
* TUI公開物を同梱する ([6e390f0](https://github.com/yohi/akane/commit/6e390f058b15c511e4bb5347fae484a8b20c58c9))

## [1.4.0](https://github.com/yohi/akane/compare/v1.3.1...v1.4.0) (2026-06-26)


### Features

* **shared-state:** サーバーと TUI 間で共有するファイルベースの状態ストアを追加 ([6914345](https://github.com/yohi/akane/commit/6914345ae8672a99537b68de13ad56db77209ed9))
* **tui:** OpenCode TUI サイドバーに watchdog 状態を表示 ([7490d35](https://github.com/yohi/akane/commit/7490d35cf892f09b4c0d352e144716a49047decb))
* **tui:** 見出しにカラーとサブエージェント経過時間を追加 ([33d8028](https://github.com/yohi/akane/commit/33d8028217ffeeaaaf39b18e182c3642a8685cd9))


### Bug Fixes

* **akane:** message.part.delta の agent 名なしイベントを誤ってユーザー入力と判定していた問題を修正 ([cf9c77b](https://github.com/yohi/akane/commit/cf9c77b92facdf98d28e242ca03d31c6b4631cbb))
* **akane:** ユーザーのストリーミング入力 (message.part.delta) でも watchdog を arm するよう修正 ([3a06a46](https://github.com/yohi/akane/commit/3a06a46b6e0c1b534eef29d67a1af3524cca4944))
* **akane:** 回復ピング注入失敗時のフォールバックとデバッグログを追加 ([7200ca1](https://github.com/yohi/akane/commit/7200ca13075b7366068f4969238267cbc7f136ed))
* **akane:** 状態ファイルの保存先を input.directory から input.worktree に変更 ([a030fcb](https://github.com/yohi/akane/commit/a030fcbadbd6b7dcbab93a307d0fd120f1a3fe3b))
* CodeRabbitレビュー指摘に対応（型ガード強化・参照リーク修正・重複排除・test片付け） ([cd3202b](https://github.com/yohi/akane/commit/cd3202bfe64114e5f54a63980b4ceb3575a646bd))
* **opencode:** TUI プラグインが auto-discovery されない問題を修正し、file ベース配置に変更 ([c69beb3](https://github.com/yohi/akane/commit/c69beb3fe3d671600018b2633ad9520ccbc9d577))
* OpenTUIの色指定をstyle.fgへ統一 ([3090454](https://github.com/yohi/akane/commit/3090454b8dfc44af81989fa0eeaddcdbf9bf4231))
* OpenTUIの色指定をstyle.fgへ統一＋CodeRabbitレビュー指摘対応 ([6001427](https://github.com/yohi/akane/commit/60014274648c503d4af6cdd911f7de077779974b))
* **pinger:** SDKのsession.promptにレガシー形状を使用 ([224f36a](https://github.com/yohi/akane/commit/224f36a67c9d8168246caec97d7795a7a821b59b))
* **tui:** stateファイルパスをworktreeに修正し誤検知エージェントイベントを除去 ([ed47d11](https://github.com/yohi/akane/commit/ed47d11a06682726c9ed79141544a548596a1d02))
* **tui:** サブエージェント検出に session.created/updated/deleted イベントを追加 ([fe143a6](https://github.com/yohi/akane/commit/fe143a69b8d2a92a898b53c36fd7f36becf85fac))
* **tui:** 同じエージェント名の subagent も個別に表示できるよう key を session ID ベースに変更 ([3704ff5](https://github.com/yohi/akane/commit/3704ff55846fad5ad865eed533fc821eb7aad2e2))
* **watchdog,tui:** 最終活動時刻を記録しActive sessionsをIDLEを除いてカウント ([4be286e](https://github.com/yohi/akane/commit/4be286e279c1fcd484341e0bd505566b97373eba))
* **watchdog:** tombstone セッションの削除漏れによるメモリリークを修正 ([4ad1ac4](https://github.com/yohi/akane/commit/4ad1ac435169d0493ddb0754773665aec5332761))
* **watchdog:** コードレビュー指摘対応（インデント・重複コメント修正、破棄済みストアのキャッシュ残存バグ修正） ([1caede9](https://github.com/yohi/akane/commit/1caede9cca73b7daf607de5bc2cdad6431157d2a))
* **watchdog:** セッション停止時にshared stateにIDLEスナップショットを残す ([75b7f47](https://github.com/yohi/akane/commit/75b7f4720ff4f3689e119929edfc3bd4a5afadbf))

## [1.3.1](https://github.com/yohi/akane/compare/v1.3.0...v1.3.1) (2026-06-23)


### Bug Fixes

* 重複するtool runningでゲートがリセットされる問題を修正 ([9bf9b95](https://github.com/yohi/akane/commit/9bf9b958282e6fad51b908be1ce3f44a4fd39d38))
* 重複するtool runningでゲートがリセットされる問題を修正 ([d33dd58](https://github.com/yohi/akane/commit/d33dd58e60045ad9ffc3f9b57b29531ff12d2a3d))

## [1.3.0](https://github.com/yohi/akane/compare/v1.2.0...v1.3.0) (2026-06-22)


### Features

* **config:** maxToolGateCycles設定を追加しツール実行中ゲートに猶予上限を設ける ([9a1a0da](https://github.com/yohi/akane/commit/9a1a0dab312fb4ae58289ca67b960145bf63ee22))
* **watchdog:** ツール実行中のStage2ゲートにmaxToolGateCycles上限を追加 ([3fe56a5](https://github.com/yohi/akane/commit/3fe56a557802f40fc93e850eea7d42a1632e0762))
* **watchdog:** ツール実行中のStage2ゲートにツールゲートサイクル上限を実装 ([54af22e](https://github.com/yohi/akane/commit/54af22ec3979a249fe5ff579c821bdf76a32f481))


### Bug Fixes

* コードレビュー指摘事項の修正（重複行削除、コメント修正） ([d319e52](https://github.com/yohi/akane/commit/d319e52eb5ca2919af500f5a361f144252d62b67))

## [1.2.0](https://github.com/yohi/akane/compare/v1.1.1...v1.2.0) (2026-06-17)


### Features

* **config:** delivery/tool-gate/pause/notify-waiting/verbose ノブを追加 ([6c54731](https://github.com/yohi/akane/commit/6c547310a30a1441240723625629a26871798dcd))
* **config:** delivery/tool-gate/pause/notify-waiting/verbose ノブを追加 ([d825bab](https://github.com/yohi/akane/commit/d825babd9803a8a1487939a28ca5f90cc697799c))
* **config:** delivery/tool-gate/pause/notify-waiting/verbose ノブを追加 ([19589b5](https://github.com/yohi/akane/commit/19589b548fef17f39f919c300c94f8362f202d72))
* **config:** delivery/tool-gate/pause/notify-waiting/verbose ノブを追加 ([c77620a](https://github.com/yohi/akane/commit/c77620a382658b6588827407e02e8cc37ffc8448))
* **config:** delivery/tool-gate/pause/notify-waiting/verbose ノブを追加 ([1c7073d](https://github.com/yohi/akane/commit/1c7073d31e76504c558776a098e0e410eb3ebd15))
* **config:** delivery/tool-gate/pause/notify-waiting/verbose ノブを追加 ([4d144ef](https://github.com/yohi/akane/commit/4d144ef3938544dba7377987078d6b2280d1a4c3))
* **config:** 注入ゲーティング用の設定ノブ追加 ([1c48cb7](https://github.com/yohi/akane/commit/1c48cb774ef67582c42f3dbeecfab5dcafb43b4a))
* **index:** permission/question を入力待ちゲートへルーティング ([#2](https://github.com/yohi/akane/issues/2)) ([0e734cd](https://github.com/yohi/akane/commit/0e734cdc2743d965c88a6cc70df50de1ce4f30a6))
* **index:** tool パートを running/settled へルーティング ([11167bd](https://github.com/yohi/akane/commit/11167bddee1be7d3c03e0cd6bb5abdd5fd4fd4b6))
* **index:** tool ルーティング ([5d4ecb0](https://github.com/yohi/akane/commit/5d4ecb082dc407a6c9a69e6ab300582d1b6222c9))
* **index:** 入力待ちルーティング ([#2](https://github.com/yohi/akane/issues/2)) ([4c8d824](https://github.com/yohi/akane/commit/4c8d824415d97e9186071e173768c679d2b43d91))
* **log:** ログ肥大抑制 ([#3](https://github.com/yohi/akane/issues/3)) ([5445c9b](https://github.com/yohi/akane/commit/5445c9b75158ea4618d535d23ffc12115bf65313))
* **log:** 高頻度イベントの完全JSONログを廃しverboseLog分岐を導入 ([#3](https://github.com/yohi/akane/issues/3)) ([b8ce626](https://github.com/yohi/akane/commit/b8ce62643d2ef4b289e20f5011e95e920ad83eb7))
* **notifier:** waiting ステージ(cyan/urgency=low)を追加 ([e8ce57f](https://github.com/yohi/akane/commit/e8ce57fa63bc57496c124135ff0e0b193672dcae))
* **notifier:** waiting ステージ(cyan/urgency=low)を追加 ([d613ecf](https://github.com/yohi/akane/commit/d613ecf9f00f12b8d597dad6f364a5a89b5d727f))
* **notifier:** waiting ステージ(cyan/urgency=low)を追加 ([6e1481a](https://github.com/yohi/akane/commit/6e1481a3cea0c4ad5a9c1ca353561694098866f3))
* **notifier:** waiting ステージ(cyan/urgency=low)を追加 ([f0be580](https://github.com/yohi/akane/commit/f0be580a92b4d7dc23bd002285e88e76c97a3e87))
* **notifier:** waiting ステージ(cyan/urgency=low)を追加 ([e74a41d](https://github.com/yohi/akane/commit/e74a41d3d74605241c4108606f5d957ce0d0571e))
* **notifier:** waiting 通知 ([a11f13c](https://github.com/yohi/akane/commit/a11f13cd4b61d5bbe08926601105c22f1c620c1d))
* **pinger:** delivery:steer 注入とlegacyフォールバックを実装 ([#1](https://github.com/yohi/akane/issues/1)) ([b092989](https://github.com/yohi/akane/commit/b09298936e1b432b4619861f55e1dce557893714))
* **pinger:** steer 注入 ([#1](https://github.com/yohi/akane/issues/1)) ([be76ea7](https://github.com/yohi/akane/commit/be76ea7022a167e980b4abe369efa16db0739d2c))
* **signal:** delta 活性化 ([af01c0f](https://github.com/yohi/akane/commit/af01c0fe7a72edb122f92f40e11c0e6bf4907aa5))
* **signal:** message.part.delta をストリーム活性として扱う ([3c770d7](https://github.com/yohi/akane/commit/3c770d72e9ae55010af232222f5aaaab8f60a744))
* **watchdog:** PAUSED ゲート ([#2](https://github.com/yohi/akane/issues/2)) ([b0bf76d](https://github.com/yohi/akane/commit/b0bf76d94ff2b53f775240b80cfddb8822c3e218))
* **watchdog:** PAUSED 状態と入力待ちゲートを追加 ([#2](https://github.com/yohi/akane/issues/2)) ([aec2b7f](https://github.com/yohi/akane/commit/aec2b7f05312d4415d840f04c9591b5be29bac5f))
* **watchdog:** PAUSED 状態と入力待ちゲートを追加 ([#2](https://github.com/yohi/akane/issues/2)) ([919920a](https://github.com/yohi/akane/commit/919920aa2ffb1efd9089a5ed2b6bb51de8dbb55d))
* **watchdog:** PAUSED 状態と入力待ちゲートを追加 ([#2](https://github.com/yohi/akane/issues/2)) ([b5fe376](https://github.com/yohi/akane/commit/b5fe376a0db90cb2d13969149752c4311a45a6cf))
* **watchdog:** PAUSED 状態と入力待ちゲートを追加 ([#2](https://github.com/yohi/akane/issues/2)) ([a7da342](https://github.com/yohi/akane/commit/a7da3427bc0d0bc280a975cc18a7f10afb211e44))
* **watchdog:** retry 抑止 ([d2df2d2](https://github.com/yohi/akane/commit/d2df2d29d6eca57ded201429b6bfc79bded4ea9a))
* **watchdog:** session.status:retry のescalation抑止を追加 ([fa16345](https://github.com/yohi/akane/commit/fa16345c21443c892f388a7a02c8ba81d759f10e))
* **watchdog:** tool-gate ([db34fd7](https://github.com/yohi/akane/commit/db34fd72e16e6412a38412600673156209cc5f91))
* **watchdog:** tool実行中のsteer抑止ゲートを追加 ([b55b1d4](https://github.com/yohi/akane/commit/b55b1d406cb9920ebe8160a0fcf6c9c7195583b1))
* **watchdog:** tool実行中のsteer抑止ゲートを追加 ([58f057f](https://github.com/yohi/akane/commit/58f057f861f7b6934dc41dbf4439af39a2db3952))
* **watchdog:** tool実行中のsteer抑止ゲートを追加 ([f16655d](https://github.com/yohi/akane/commit/f16655d3662f0cfac48ef1f9484f23ab868c9c85))


### Bug Fixes

* **log:** サマリーログのセッションID取得ロジック改善とフィールド名の汎用化 ([0b7fe95](https://github.com/yohi/akane/commit/0b7fe9541c54478c812f90248baac564cb54fbdb))
* **notifier:** OSNotifier の safeSpawn エラー分類で as any を除去 ([0cae478](https://github.com/yohi/akane/commit/0cae47877c6047301a4c4bc5a1326c553624298d))
* **pinger:** V2フォールバックを形状拒否エラーのみに限定し警告ログを追加 ([5036851](https://github.com/yohi/akane/commit/5036851632de8c5e7f3e4adf31c1483ca306b4f6))
* readProjectConfig に suppressPingWhileToolRunning のバリデーション追加 ([5cac187](https://github.com/yohi/akane/commit/5cac187e3bd1dacfcc62948e3233a2f8830afe8d))
* requestIdが未取得時にwarnログを出力する ([12c04f7](https://github.com/yohi/akane/commit/12c04f7c0c2534309699935dcfd26017e5e4c005))
* **routing:** コードレビュー指摘3件に対応 ([f911c61](https://github.com/yohi/akane/commit/f911c6164e923ceaf5c7c1752edb7de996ed6a59))
* **test:** resolve 'Object is possibly undefined' error in smoke test ([7b2a0c6](https://github.com/yohi/akane/commit/7b2a0c6c7cdc3d6b9819240273b919fa6bd3bf74))
* **watchdog:** message.part.delta における agentName チェックの追加とテストの強化 ([344329c](https://github.com/yohi/akane/commit/344329c87e5d9db36ddefe1f05a9b5b01526c40f))
* **watchdog:** onToolSettled のファントムセッション生成とツールゲート通知フラグ流用を修正 ([aac476d](https://github.com/yohi/akane/commit/aac476da2dd12cc47d4d903a95bbb59da502aaf1))
* **watchdog:** pauseOnInputRequest=false 時の誤タイマーリセットを修正し delivery TODO を追記 ([3a8d917](https://github.com/yohi/akane/commit/3a8d91754c630c487267b1c1a6cffb7c0282f122))
* **watchdog:** retry抑止中のタイマー再起動とSILENCEDの不正解除を修正 ([401bade](https://github.com/yohi/akane/commit/401bade35cda46bd1fa96d5e14cf2ce826ef4126))
* **watchdog:** SILENCED セッションへのツールイベントによる不正リセットを修正 ([69741b0](https://github.com/yohi/akane/commit/69741b0a1e6aabc23070c49917b4a341e3ccd529))
* **watchdog:** SILENCED 状態のセッションが入力要求によって遷移する問題を修正 ([58ffc3d](https://github.com/yohi/akane/commit/58ffc3d6a0e93518d9f77e4220a323134e2a30bf))
* **watchdog:** SILENCEDセッションへのonStatusRetryでretrySuppressedが永続化する問題を修正 ([17d2773](https://github.com/yohi/akane/commit/17d277323413ac8a51256b0a02d60bfaf2e4017f))
* **watchdog:** SILENCEDバイパスと非監視エージェントのゾンビエントリを修正 ([274c929](https://github.com/yohi/akane/commit/274c929c19b2c57c5bed984a623cd77aa88c4cc3))
* **watchdog:** ゲートパスの再スケジュールタイマーを await 前に移動 ([140b3a8](https://github.com/yohi/akane/commit/140b3a87f103abec2836f8464e2c222b5d89ef3d))

## [1.1.1](https://github.com/yohi/akane/compare/v1.1.0...v1.1.1) (2026-06-04)


### Bug Fixes

* **docs:** プロジェクトドキュメントの整理と不要ファイルの削除 ([e37443c](https://github.com/yohi/akane/commit/e37443c5beb8ba2f85261b1f4d6b4c8ac7beae25))

## [1.1.0](https://github.com/yohi/akane/compare/v1.0.0...v1.1.0) (2026-06-04)


### Features

* **config:** notifierType 設定を追加（tmux/os, env 上書き対応） ([3c9d239](https://github.com/yohi/akane/commit/3c9d23990668e05a9507ecbed2413511b95925fb))
* **config:** notifierType 設定を追加（tmux/os, env 上書き対応） ([b811eae](https://github.com/yohi/akane/commit/b811eae87559d8e4094f4e36129a665a9687b0f9))
* **config:** notifierType 設定を追加（tmux/os, env 上書き対応） ([6cbd29a](https://github.com/yohi/akane/commit/6cbd29a4aaf63fe0960b4720362f4c10b12ac904))
* **config:** notifierType 設定追加 ([5f2229d](https://github.com/yohi/akane/commit/5f2229d134bab63657cce7734b0a44dafd48f25d))
* **errors:** classifyError と reasonToJa を追加 ([ee07c7d](https://github.com/yohi/akane/commit/ee07c7d4d8739bba358ebf6ec5cc11bf38edf8c3))
* **errors:** エラー分類ヒューリスティック追加 ([4df2a5c](https://github.com/yohi/akane/commit/4df2a5cbe1dad082337e30e0fb6c6ff7556aae0a))
* **errors:** 数値コードの抽出と429エラーの厳密な判定に対応 ([9292904](https://github.com/yohi/akane/commit/929290486eab5b1368de68ced8f85700bfc0a146))
* **index:** notifier Factory 配線 ([5508236](https://github.com/yohi/akane/commit/5508236bcbd72a18d677b1717c71e3429aaf2ed2))
* **index:** notifier 生成を createNotifier(config.notifierType) へ配線 ([bcf32e4](https://github.com/yohi/akane/commit/bcf32e41a7cf80bf503e8eea5987aab6488c4970))
* **index:** session.error ルーティング（recoverable=note / terminal=stop）を実装 ([fd514f3](https://github.com/yohi/akane/commit/fd514f33f299fb2f8aaca9a07b14fb6fe90b89ee))
* **index:** session.error ルーティング実装 ([47c64d6](https://github.com/yohi/akane/commit/47c64d6eb471c0de2e428849ec4b5868da5594db))
* **index:** session.errorイベントのルーティング処理とテストを追加 ([464aa9e](https://github.com/yohi/akane/commit/464aa9e5b18cadc95a1fc8cd3cb0098884155228))
* **index:** 定期テレメトリレポートと graceful shutdown を追加 ([8152d27](https://github.com/yohi/akane/commit/8152d27e7a1c124c673ad08428add415759f289f))
* **index:** 定期レポート + graceful shutdown ([9af3086](https://github.com/yohi/akane/commit/9af3086801d67e0a3a702482823561519afa638f))
* **notifier:** createNotifier Factory を追加（type で tmux/os を分岐） ([53ccc5b](https://github.com/yohi/akane/commit/53ccc5b60adc66df4e7b90efc397cc7434f69b65))
* **notifier:** createNotifier Factory 追加 ([bdf9a08](https://github.com/yohi/akane/commit/bdf9a08f20cba9fa9e41309e1ec6b6730f78b296))
* **notifier:** macOS通知機能の改行処理改善とコマンド存在チェックを追加 ([5752019](https://github.com/yohi/akane/commit/5752019f6473e0e02b98a164e6c6d6ed1fd5c18c))
* **notifier:** OSNotifier を追加（linux notify-send / macOS osascript） ([e8124c4](https://github.com/yohi/akane/commit/e8124c4e3149828aec85c2032d9b393d1fa77640))
* **notifier:** OSNotifier 追加 ([33dd4c8](https://github.com/yohi/akane/commit/33dd4c88ea3c3f07a78a0221cb2a2f8fd3f417ad))
* **pinger:** injectメソッドにcontext引数を追加しエラー理由をプロンプトに埋め込む ([f19ab55](https://github.com/yohi/akane/commit/f19ab55dcb2905f8e1beadab46b83ef3cfad7916))
* **pinger:** PingContext / buildPingPrompt 追加 ([338336e](https://github.com/yohi/akane/commit/338336e2a6552cf3ac63d8e2e2829fe99df1144b))
* **pinger:** PingContext と buildPingPrompt を追加（reason をプロンプトに反映） ([2f3bbc1](https://github.com/yohi/akane/commit/2f3bbc1eb8811fc31b136e3db02e4eeaa8d84206))
* **ping:** pingイベントの検出ロジックを拡張メッセージ対応に修正 ([0346b46](https://github.com/yohi/akane/commit/0346b4665f59720dd85380566e7fe36012f7e0ce))
* **telemetry:** TelemetryCollector と NoopTelemetry を追加 ([97a497b](https://github.com/yohi/akane/commit/97a497b0f312b33381e543b3b48d4b55e3e55a06))
* **telemetry:** TelemetryCollector と NoopTelemetry を追加 ([45f0f7a](https://github.com/yohi/akane/commit/45f0f7ab9483b45a64951a09ad16f7af9ccdd08b))
* **telemetry:** テレメトリレポーターの設定による有効化制御と報告処理の堅牢化 ([2eba00a](https://github.com/yohi/akane/commit/2eba00a5bf65f7f84612c83bb18e8760ddc7f7d9))
* **telemetry:** 設定が有効な場合のみテレメトリを報告するように変更 ([7b07da8](https://github.com/yohi/akane/commit/7b07da8549c4aef2be5c2059813a51f8593f8daa))
* **telemetry:** 集計モジュール追加 ([745b8cb](https://github.com/yohi/akane/commit/745b8cb885f38c4bda32a64575405d9bb27a866a))
* **watchdog:** noteError + reason 付き ping ([11c0d2b](https://github.com/yohi/akane/commit/11c0d2bd037fc243290fd78a97c90612193a7c27))
* **watchdog:** noteError と reason 付き ping プロンプトを追加 ([a930fa0](https://github.com/yohi/akane/commit/a930fa0ed74abb4d3b6d30c9b77bdeddb32ac33d))
* **watchdog:** pingメッセージ生成ロジックの修正とnoteError挙動の調整 ([647e0f8](https://github.com/yohi/akane/commit/647e0f8e965479b0466c3dcda3d155887405fc96))
* **watchdog:** telemetry を配線（hangup/ping/recovery/failure） ([797f24d](https://github.com/yohi/akane/commit/797f24d8d1010b6ae604dfa9ace020cb94ec4265))
* **watchdog:** telemetry 配線 ([84e3a92](https://github.com/yohi/akane/commit/84e3a92d2a07290dbc96be4447cee2c3dc078742))


### Bug Fixes

* **notifier:** macOSの通知メッセージにおけるエスケープ処理を改善しLinuxのurgency設定を追加 ([dcaaf45](https://github.com/yohi/akane/commit/dcaaf45206b57e282bc86086dedfaba8f1e149c3))
* **notifier:** OS通知のspawn失敗時のログにコマンド名とエラー詳細を追加 ([0b0180d](https://github.com/yohi/akane/commit/0b0180d914ad660dc2932f65f9e734e436b89868))
* **notifier:** エラーログから通知メッセージを含む可能性があるコマンドラインを除外 ([8cb9e9e](https://github.com/yohi/akane/commit/8cb9e9e67060b3d9de62dbef9ed5af3d2ddcfb17))

## 1.0.0 (2026-05-30)


### Features

* **ci:** add bun typecheck + test workflow with feat/** trigger ([22af395](https://github.com/yohi/akane/commit/22af3958708733e332237454d46ea89c95a42d32))
* **ci:** bun typecheck + test on master/feat stacked PRs ([4b0ef8f](https://github.com/yohi/akane/commit/4b0ef8fd8dba0b75d7dd61e54a16abea1b5a303a))
* **clock:** add DI-friendly Clock with RealClock and FakeClock ([159d67d](https://github.com/yohi/akane/commit/159d67d59c460269d9b27068bb3a2fb304f1916f))
* **clock:** add DI-friendly Clock with RealClock and FakeClock ([8f1af4f](https://github.com/yohi/akane/commit/8f1af4fff92560c7801e4400e9e09944a368eb14))
* **clock:** DI clock with FakeClock for unit tests ([92e7e07](https://github.com/yohi/akane/commit/92e7e07fa99309e068f0a864468f90859ea12df2))
* **config:** add env &gt; project &gt; defaults resolution with validation ([e5a654c](https://github.com/yohi/akane/commit/e5a654c3f30fbcee641082941a4ecbfaf0361fed))
* **config:** env &gt; project &gt; defaults with safe fallback ([d7111ab](https://github.com/yohi/akane/commit/d7111abd3aae7e33d1ae7e6f3438b01c2c1085b3))
* **config:** 設定のバリデーション強化とパースロジックの改善 ([eb8c484](https://github.com/yohi/akane/commit/eb8c4841763b16a60b06dc4fb420033adb7b3ac9))
* **devcontainer:** add Debian 12 + Bun 1.3 + tmux base ([4bac540](https://github.com/yohi/akane/commit/4bac5407e43e238002aedcbeb772e1cdb2be0e2e))
* **devcontainer:** Bun 1.3 + tmux base ([3ff3d5d](https://github.com/yohi/akane/commit/3ff3d5d8334e473a0406559b41984137a7e5ccd0))
* **index:** エージェント名抽出の拡張とセッション更新イベントのスキップ対応 ([05c35e2](https://github.com/yohi/akane/commit/05c35e2049d8fe029d92a7a16b51894be06c620b))
* **index:** ピン検知ロジックの修正とユーザー介入の優先処理を追加 ([6352b36](https://github.com/yohi/akane/commit/6352b362a9750531bd3bfec8f7c5203bf56dfa6c))
* **notifier:** add TmuxNotifier with 3-stage detection and color highlighting ([a4e1ae2](https://github.com/yohi/akane/commit/a4e1ae2b2f69b27bce4c85bc064708322ff5be04))
* **notifier:** TmuxNotifier with detect-then-cache and safe spawn ([374605a](https://github.com/yohi/akane/commit/374605a896b6ea52086391885f1887fad0eba964))
* **notifier:** tmuxコマンドをセッションIDで対象化 ([6d715fd](https://github.com/yohi/akane/commit/6d715fdfd7d879c3c3cb4a5eeea978d14053b507))
* **notifier:** tmuxコマンド失敗時のエラーハンドリングを追加しテストを修正 ([e42f42f](https://github.com/yohi/akane/commit/e42f42f557c81f9804944b4af7be139d81dd0c76))
* **pinger:** add Pinger interface with MockPinger and OpenCodeAdapter ([f34713f](https://github.com/yohi/akane/commit/f34713f9abf3bcca1bc80d31514e68b3484db49f))
* **pinger:** Pinger interface + MockPinger + OpenCodeAdapter ([159593d](https://github.com/yohi/akane/commit/159593dbc6061bf3f4103a558cbfa55d2df06eb3))
* **plugin:** plugin entry wiring all modules to OpenCode event hook ([10ac621](https://github.com/yohi/akane/commit/10ac6219465e408dae3afaa383e3bbf0bd2a902f))
* **plugin:** wire watchdog to OpenCode event hook (replaces Phase 0 stub) ([b78b163](https://github.com/yohi/akane/commit/b78b16392149fe2e8ca64112d5131fcb5dd84cba))
* **scaffold:** bun + tsconfig + @opencode-ai/plugin baseline ([c56b8d2](https://github.com/yohi/akane/commit/c56b8d25bfd524a23fb736e6c69b8f28e7a12560))
* **scaffold:** bun + tsconfig strict + @opencode-ai/plugin + SDK notes ([1b237a2](https://github.com/yohi/akane/commit/1b237a208c1e69369ec71dc0a77a261a0483c2d9))
* **watchdog:** add state machine with stage1/stage2 timers and maxPings ceiling ([a55fa37](https://github.com/yohi/akane/commit/a55fa37c0780754e94ac74735ca59feefe1fcf2d))
* **watchdog:** add state machine with stage1/stage2 timers and maxPings ceiling ([80c7121](https://github.com/yohi/akane/commit/80c7121305a32ae304e2982dcdaa4ccedc573211))
* **watchdog:** armOrResetメソッドでのエージェント名解決ロジックを改善 ([68f316e](https://github.com/yohi/akane/commit/68f316e1b4887b055a6162c8d63a5f4021c6e0b0))
* **watchdog:** state machine + 2-stage timers + ping ceiling + tombstone ([1b1766c](https://github.com/yohi/akane/commit/1b1766c5f1fca4af7663076606f5054c218468db))
* **watchdog:** 全セッションを破棄しタイマーをクリアするstopAllメソッドを追加 ([a75b0ce](https://github.com/yohi/akane/commit/a75b0cee84a0961f2f79e4ba2f15ef429a3fba8c))
* **watchdog:** 設定拡張とセッション管理の改善 ([d59d228](https://github.com/yohi/akane/commit/d59d2286847d343fe2fd0d4c473540d5a4838ff6))
* クロックの入力検証強化とTmuxNotifierのパス指定を追加 ([580a3d6](https://github.com/yohi/akane/commit/580a3d60047f579a52bd91504663ad975f288241))


### Bug Fixes

* **clock:** タイマー管理の堅牢化と無限ループ対策の実装 ([627d819](https://github.com/yohi/akane/commit/627d819bbdf120f44f20b5cae74a8ea116e095ac))
* **config:** allow partial tmux and agents config in project source ([ac36ea8](https://github.com/yohi/akane/commit/ac36ea8115898c12cc5cc8597f320d1c9a8ba8ee))
* **config:** ensure parsePositiveInt and validateNumber reject zero ([e47b5ba](https://github.com/yohi/akane/commit/e47b5bad8129a98f8f72af7895f0ae48e9331ad3))
* **config:** improve parseBool flexibility and add warnings for invalid values ([e2dfd58](https://github.com/yohi/akane/commit/e2dfd58292f0124c2cdeb8691b95a167c2b35d3b))
* maintain this binding when calling client.session.prompt ([d974bb5](https://github.com/yohi/akane/commit/d974bb5864bac5fe3901b8c46d1295c0828c6909))
* **notifier:** remove invalid -t sessionId from tmux commands ([e62fc43](https://github.com/yohi/akane/commit/e62fc43c5980aa86255bbbbb953415fa87246079))
* **watchdog:** セッション終了時およびタイムアウト時の通知クリーンアップを強化 ([f66e314](https://github.com/yohi/akane/commit/f66e314e9898ae43a627ccb377362757eeafc99d))
* **watchdog:** 多重起動の防止およびアームロック解除ロジックの修正 ([1426940](https://github.com/yohi/akane/commit/1426940f0b006609c2282cec5898c86fa5fe6397))
