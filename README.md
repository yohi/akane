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
- ⚡ **Auto-Duplication Prevention**: プラグインが同一プロセスで重複ロードされた場合でも、自動的に2回目以降の初期化をブロックするガードレールを搭載。
- 🔄 **Manual Recovery Bypass**: 赤色警告（SILENCED）となった後も、ユーザーがチャットから新しいメッセージを入力・送信することで、即座に警告表示をクリアし監視を再始動します。

## ⚙️ Configuration

環境変数または `opencode.jsonc` の設定から、動作設定やタイムアウト時間をミリ秒単位でカスタマイズできます。

| 環境変数 | 用途 | デフォルト値 |
|---|---|---|
| `OPENCODE_WATCHDOG_ENABLED` | プラグインの有効/無効化 | `true` |
| `OPENCODE_WATCHDOG_STAGE1_MS` | 黄色警告（STAGE1）になるまでの応答なし時間 | `180000` (3分) |
| `OPENCODE_WATCHDOG_STAGE2_MS` | 赤色警告（STAGE2）および自動Ping注入までの時間 | `180000` (3分) |
| `OPENCODE_WATCHDOG_MAX_PINGS` | 自動Pingを実行する上限回数 | `1` |

## 🚀 Build & Deployment

### 1. 依存関係のインストール
```bash
bun install
```

### 2. ビルド
TypeScript ソースコードをコンパイルしてバンドルを作成します。
```bash
bun run build
```

### 3. リリース (開発者向け)
このプロジェクトは Conventional Commits に基づき、GitHub Actions によって自動的にリリースされます。
`master` ブランチにプッシュされると、`release-please` がリリース PR を作成します。PR がマージされると、GitHub Packages への公開と GitHub Release の作成が行われます。

### 4. インストール・デプロイ (ローカル)
開発中にローカルビルドをテストする場合は、`dist/index.js` と `package.json` を OpenCode のプラグインディレクトリに配置します。
```bash
mkdir -p ~/.config/opencode/plugins/akane
cp -r package.json dist ~/.config/opencode/plugins/akane/
```

### 5. OpenCode への登録と設定
`~/.config/opencode/opencode.jsonc` の `plugins` セクションにプラグイン（パッケージ名とバージョン）を追加し、必要に応じて設定を記述します。

```jsonc
{
  "plugins": [
    // GitHub Packages から最新版をインストールする場合
    "@yohi/akane@latest"
  ],
  "experimental": {
    "watchdog": {
      "enabled": true,
      "stage1Ms": 180000,
      "stage2Ms": 180000,
      "maxPings": 1,
      "tmux": {
        "highlightWindow": true
      }
    }
  }
}
```

### 6. 実行テスト
単体テストおよびストレステストは `bun test` で実行できます。
```bash
bun test
```

## 🛠️ Recovery Procedure (手動復旧手順)

1. ハング検知により赤色（SILENCED）に移行した後は、自動Pingの連投を防ぐため、アシスタントの出力等による自動リセットは動作しません。
2. ネットワーク環境などを復旧させた後、**チャット欄に任意の新規メッセージを入力して送信**します。
3. プラグインがユーザーの新規発話を検知した瞬間に、Tmux の赤色警告表示がクリア（通常色へ復帰）され、再び通常監視状態に戻ります。
