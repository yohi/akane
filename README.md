# 🚨 akane

**OpenCode Agent Watchdog Plugin**

> 「エージェントの色相はクリアか？ 監視官が介入する。」

`akane` は、[OpenCode](https://github.com/anomalyco/opencode) 環境下で稼働する自律型エージェントのプロセスを監視し、タスクのハングアップを未然に防ぐための Watchdog プラグインです。

アニメ『PSYCHO-PASS』の監視官（常守朱）をコンセプトとし、エージェントからのストリーム応答（色相）を常時モニタリングします。応答が一定時間途絶え、状態が濁った（ハングアップの疑いがある）と判定された場合、Tmux連携による即時警告と、対象エージェントへの自動介入（執行：Pingメッセージの注入）を行い、システムを正常な稼働状態へと導きます。

## ✨ Features

- 👁️ **Event Bus Monitoring**: OpenCode内部のストリーム受信イベントを直接フックし、ミリ秒単位で「色相」を監視。
- 🚨 **Tmux Integration**: 沈黙（Stage1）を検知すると、Tmuxのステータスラインを警告色（Yellow/Red）に染め上げ、メッセージをポップアップ通知。
- 🔫 **Auto-Intervention (Dominator)**: 危険領域（Stage2）に達した場合、エージェントに対して「現在の状況を教えてください」と自動Pingを1度だけ注入し、再起を促します。
- 🛡️ **Zero-Crash Fallback**: Tmuxが存在しない環境下でも安全にフォールバック。絶対にプロセスを落とさない堅牢な設計。
