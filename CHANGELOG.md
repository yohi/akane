# Changelog

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
