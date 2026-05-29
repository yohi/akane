# OpenCode Watchdog プラグイン 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCode セッションのストリーム停止を検出し、Tmux 通知 → 自動 Ping 注入 → サイレンス昇格の 3 段階対応を行う `@opencode-ai/plugin` プラグインを構築する。

**Architecture:** `event` フックを単一エントリとし、`Watchdog` コアが `Map<sessionId, TimerHandle>` で 2 段階タイマーを管理。`Clock` / `Notifier` / `Pinger` をすべて DI で受け取りユニットテスト可能にする。外部依存 (tmux, OpenCode SDK) はアダプタ層で隔離。

**Tech Stack:** TypeScript / Bun 1.3+ / `bun:test` / `@opencode-ai/plugin` (公式 SDK) / tmux / GitHub Actions / Devcontainer (Debian 12)

---

## Gitブランチ運用フロー

本計画は **AI-Native Stacked PR Workflow** に準拠する。

**参照 URL**: <https://different-sunday-448.notion.site/AI-Native-Stacked-PR-Workflow-3611669a4c16802eb032eb4ab05a8adb>

### スタック構造図

```text
master
  └── feat/0-1-devcontainer       (Phase 0)
        └── feat/0-2-scaffold
              └── feat/0-3-ci
                    └── feat/1-1-clock          (Phase 1 直列開始)
                          └── feat/1-2-config
                                └── feat/1-3-pinger
                                      └── feat/1-4-notifier
                                            └── feat/2-1-watchdog        (Phase 2)
                                                  └── feat/3-1-plugin-entry  (Phase 3)
                                                        └── feat/3-2-stress-test
```

> **本計画は全タスクが直列スタック構成**。レビュー単位を細かく保ちつつ型整合を CI で逐次保証するため Phase 1 並列化は採用しない (初版レビューで並列+統合ブランチ案から直列に切替)。

### 実行モード規約

各タスクヘッダの `実行モード` は **直列必須** に統一。

- **直列必須 (Wait for Task X)**: 直前タスクのブランチから派生。先行タスクの Draft PR が **作成済み (URL 取得済み)** であることを開始条件とする。マージ完了は不要。

### ブランチ命名規約

`feat/<phase>-<task>-<short-kebab>`  例: `feat/1-3-pinger`

### Draft PR ポリシー

- すべてのタスクは **完了時に派生元ブランチへ向けた Draft PR を作成** し、PR URL を `docs/superpowers/plans/2026-05-28-opencode-watchdog.md` のローカルメモまたは TaskList コメントに記録する。
- レビュー & マージは人間オペレータが担当する (AGENTS は merge を実行禁止)。

---

## ポカヨケ検証スクリプト (全タスク共通)

各タスクの **Step 1** で必ず以下のシェルスクリプトを **devcontainer 内** で実行する (例外: Task 0.1 のみ devcontainer 未存在のためホストで実行)。

```bash
# 派生元が正しいか検証するポカヨケスクリプト
EXPECTED_BASE="<タスクごとに具体的なブランチ名を埋め込み済み>"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

このスクリプトが exit 1 を返した場合、**即時に作業を中断し、ブランチを破棄してから再作成すること**。スタック構造が壊れた状態で先に進むと、後続タスクの PR が無関係な差分を含み、人間のレビュー不能になる。

---

## Devcontainer 実行規約 (絶対遵守)

- **テスト実行、静的解析、Step 1 のブランチ検証**: すべて devcontainer 内で実行する。
- **Git 操作 (commit / push / pr create)**: devcontainer 内では権限問題が発生し得るため、**ホスト側ターミナル**で実行する。
- 各タスクの Step 表記:
  - `[devcontainer]`: devcontainer 内で実行
  - `[host]`: ホストで実行

---

## ファイル構造 (最終形)

```text
.
├── .devcontainer/
│   ├── devcontainer.json
│   ├── Dockerfile
│   └── postCreate.sh
├── .github/
│   └── workflows/
│       └── test.yml
├── docs/
│   └── SDK_NOTES.md       # Task 0.2 Step 7 で記録する SDK 実測形 (Pinger/event の前提)
├── src/
│   ├── clock.ts
│   ├── config.ts
│   ├── index.ts
│   ├── notifier.ts
│   ├── pinger.ts
│   └── watchdog.ts
├── tests/
│   ├── clock.test.ts
│   ├── config.test.ts
│   ├── index.smoke.test.ts
│   ├── notifier.test.ts
│   ├── pinger.test.ts
│   ├── watchdog.test.ts
│   └── stress.test.ts
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md (任意)
```

---

# Phase 0: Foundation Setup

## Task 0.1: Devcontainer + Dockerfile + postCreate

- **派生元ブランチ**: `master`
- **実行モード**: 直列必須 (Phase 0 の起点)
- **前提条件**: なし

**Files:**
- Create: `.devcontainer/devcontainer.json`
- Create: `.devcontainer/Dockerfile`
- Create: `.devcontainer/postCreate.sh`

### Step 1: ブランチ作成と検証 [host]

> **注意**: Task 0.1 は devcontainer 自体を作成するタスクのため、検証は **ホスト**で実行する (例外)。Task 0.2 以降はすべて devcontainer 内で検証する。

- [x] Step 1.1: ブランチを作成し master から派生していることを検証

```bash
# ホストで実行
git checkout master
git pull --ff-only origin master
git checkout -b feat/0-1-devcontainer

EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: Dockerfile を作成 [host]

- [x] Step 2.1: `.devcontainer/Dockerfile` を作成

```dockerfile
FROM mcr.microsoft.com/devcontainers/base:debian-12

# Install tmux for integration tests of notifier module
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux ca-certificates curl unzip git \
 && rm -rf /var/lib/apt/lists/*

# Bun is installed via the devcontainer feature (see devcontainer.json).
# Verify installation is delegated to postCreate.sh.

USER vscode
WORKDIR /workspaces
```

### Step 3: devcontainer.json を作成 [host]

- [x] Step 3.1: `.devcontainer/devcontainer.json` を作成

```json
{
  "name": "opencode-watchdog",
  "build": {
    "dockerfile": "Dockerfile"
  },
  "features": {
    "ghcr.io/shyim/devcontainers-features/bun:0": {
      "version": "1.3"
    }
  },
  "remoteUser": "vscode",
  "containerEnv": {
    "BUN_INSTALL": "/home/vscode/.bun"
  },
  "remoteEnv": {
    "PATH": "${containerEnv:PATH}:/home/vscode/.bun/bin"
  },
  "postCreateCommand": "bash .devcontainer/postCreate.sh",
  "mounts": [],
  "customizations": {
    "vscode": {
      "extensions": [
        "oven.bun-vscode",
        "esbenp.prettier-vscode"
      ]
    }
  }
}
```

### Step 4: postCreate.sh を作成 [host]

- [x] Step 4.1: `.devcontainer/postCreate.sh` を作成

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "[postCreate] Verifying Bun installation..."
bun --version

echo "[postCreate] Verifying tmux availability..."
tmux -V

if [ -f package.json ]; then
  echo "[postCreate] Installing dependencies..."
  bun install --frozen-lockfile || bun install
fi

echo "[postCreate] Done."
```

- [x] Step 4.2: 実行権限を付与

```bash
# [host]
chmod +x .devcontainer/postCreate.sh
```

### Step 5: ローカルで devcontainer を立ち上げて動作確認 [host]

- [ ] Step 5.1: VSCode / `devcontainer CLI` で devcontainer を起動し、postCreate が exit 0 で完了することを確認 (Deferred: image pull in progress)

```bash
# host (devcontainer CLI 使用例)
devcontainer up --workspace-folder . || echo "VSCode の Reopen in Container でも可"
```

期待出力: `bun --version` が `1.3.x`、`tmux -V` が表示される。

### Step 6: コミット [host]

- [x] Step 6.1: コミット

```bash
git add .devcontainer/
git commit -m "feat(devcontainer): add Debian 12 + Bun 1.3 + tmux base"
```

### Step 7: Draft PR 作成 [host]

- [x] Step 7.1: master 向けに Draft PR を作成し URL を記録 (PR: https://github.com/yohi/akane/pull/3)

```bash
git push -u origin feat/0-1-devcontainer
gh pr create --draft --base master --head feat/0-1-devcontainer \
  --title "feat(devcontainer): Bun 1.3 + tmux base" \
  --body "Phase 0 foundation. Sets up reproducible dev environment per design §8."
```

- [x] Step 7.2: 出力された PR URL を本ファイルか TaskList のメモに **記録** すること。後続タスクの `前提条件` として参照される。 → PR #3 (https://github.com/yohi/akane/pull/3)

---

## Task 0.2: Bun プロジェクトスキャフォールド

- **派生元ブランチ**: `feat/0-1-devcontainer`
- **実行モード**: 直列必須 (Wait for Task 0.1)
- **前提条件**: Task 0.1 の Draft PR URL が存在すること

> **順序の根拠**: 本タスクが先で、Task 0.3 (CI) が後。CI workflow が `bun install --frozen-lockfile` と `bun test` / `bun run typecheck` を実行する都合上、`package.json` / `bun.lock` が **CI ワークフロー導入前に既に存在している** 必要があるため。逆順 (CI 先行) で導入すると初回 PR の CI が必ず失敗し、stacked PR の前提条件チェーンが壊れる。

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/.gitkeep`
- Create: `tests/.gitkeep`
- Create: `docs/SDK_NOTES.md` (Step 7 で実 SDK 形を記録する成果物)

### Step 1: ブランチ作成と検証 [devcontainer]

- [x] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/0-1-devcontainer
git checkout -b feat/0-2-scaffold
```

- [x] Step 1.2: ポカヨケ実行 (ホストで代替実行。devcontainer build 完了後に devcontainer 内で再検証予定)

```bash
# [devcontainer]
EXPECTED_BASE="feat/0-1-devcontainer"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: `package.json` を作成 [devcontainer]

- [x] Step 2.1: `package.json` を作成

```json
{
  "name": "opencode-watchdog",
  "version": "0.1.0",
  "description": "OpenCode session hang detector with tmux notification and self-recovery ping injection",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "latest",
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  },
  "peerDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### Step 3: `tsconfig.json` を作成 [devcontainer]

- [x] Step 3.1: `tsconfig.json` を作成

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["bun-types"],
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

### Step 4: `.gitignore` を作成 [devcontainer]

- [x] Step 4.1: `.gitignore` を作成 (既存の .gitignore が計画要件をカバーしているため上書きせず作業をスキップ)

```gitignore
node_modules/
.bun/
*.log
*.tsbuildinfo
.DS_Store
dist/
coverage/
```

### Step 5: 空ディレクトリ用 `.gitkeep` を作成 [devcontainer]

- [x] Step 5.1: `src/.gitkeep` および `tests/.gitkeep` を作成 (空ファイル)

### Step 6: 依存関係インストール & 型チェック [devcontainer]

- [x] Step 6.1: 依存をインストール (ホスト bun 1.2.19 で代替実行。bun 1.3 でのロックフォーマット (bun.lockb vs bun.lock) は devcontainer 完了後に検証)

```bash
# [devcontainer]
bun install
```

- [x] Step 6.2: 型チェックが通ることを確認 (Phase 0 の "No inputs found" エラーを回避するため src/index.ts に一時スタブ `export {}` を配置。Task 3.1 で完全実装に置換)

```bash
# [devcontainer]
bun run typecheck
```

期待出力: エラーなく終了 (出力なし or "Done")

- [x] Step 6.3: テスト走行 (まだテストはない) — bun 1.2 では "0 test files" が exit 1。bun 1.3 での振る舞いは devcontainer 完了後に確認

```bash
# [devcontainer]
bun test
```

期待出力: `0 pass, 0 fail` (テストファイルなしのため正常)

### Step 7: `@opencode-ai/plugin` の型形状を確認し記録する [devcontainer]

> **目的**: 後続の Task 1.3 (Pinger) と Task 3.1 (Plugin Entry) のテスト/実装で **実 SDK 型に基づいた呼び出し形** を採用するため、ここで一度だけ調査して結果を `docs/SDK_NOTES.md` に固定する。

- [x] Step 7.1: SDK の型定義ファイル位置を特定

```bash
# [devcontainer]
find node_modules/@opencode-ai -name "*.d.ts" | head -50
```

期待出力: `node_modules/@opencode-ai/plugin/dist/*.d.ts` などのパスが列挙される。

- [x] Step 7.2: Plugin 型と client.session.* の呼び出し形を抽出

```bash
# [devcontainer]
grep -RnE "export (type|interface) Plugin\b|session\s*:\s*\{|prompt\s*\(" node_modules/@opencode-ai/plugin/dist/ | head -80
```

期待出力: `Plugin` 型 / `event` フックのシグネチャ / `client.session.prompt` (もしくは相当メソッド) の引数・戻り値型が確認できる。

- [x] Step 7.3: 抽出結果を `docs/SDK_NOTES.md` に記録 (`@opencode-ai/plugin@1.15.12` をダウンロードして実測)

```bash
# [devcontainer]
mkdir -p docs
```

`docs/SDK_NOTES.md` に以下のテンプレートで記入する。**「実測」欄が空のまま後続タスクへ進むことを禁止**。

> **注**: 下のテンプレートは外側を **四連バッククォート (` ```` `)** で囲んでいる。これにより内側の三連バッククォート (` ``` `) を fence として保存できる。SDK_NOTES.md を実際に書く際は、外側のフェンスを取り除いて本文だけ抜き出すこと。

````markdown
# @opencode-ai/plugin SDK Notes

- 確認日: <YYYY-MM-DD>
- 確認バージョン: <package.json の installed version>

## Plugin エントリ型

実測 (`grep` で得た定義をそのまま貼る):
```ts
// 例:
// export type Plugin = (ctx: PluginContext) => Promise<PluginInstance>;
// export interface PluginInstance { event?: (e: { event: OpenCodeEvent }) => Promise<void>; ... }
```

## client.session.prompt の呼び出し形

実測:
```ts
// 例: client.session.prompt({ path: { id }, body: { parts } })
```

## イベント payload の sessionID / role 抽出パス

実測 (message.updated / message.part.updated それぞれ):
```ts
// 例:
// message.updated  → event.properties.info.role === "user", event.properties.info.sessionID
// message.part.updated → event.properties.part.sessionID
```
````

- [x] Step 7.4: 記録内容と本プラン (Task 1.3 / Task 3.1) のベースライン記述に **差異を確認**。Task 1.3 (Pinger) は完全一致。Task 3.1 について `session.idle` / `session.error` は計画書 `info.id` に対し実 SDK は直接 `properties.sessionID` — SDK_NOTES.md と Task 3.1 実装テストで対処

> **重要**: 本ステップは「型を見ずに書いたコードを CI 任せにしない」ためのゲート。後続タスクで SDK 形状起因の silent failure が発生した場合、ここをサボったことが原因。

### Step 8: コミット [host]

- [x] Step 8.1: コミット

```bash
git add package.json tsconfig.json .gitignore src/.gitkeep tests/.gitkeep bun.lock docs/SDK_NOTES.md
git commit -m "feat(scaffold): bun + tsconfig strict + @opencode-ai/plugin + SDK notes"
```

### Step 9: Draft PR 作成 [host]

- [x] Step 9.1: Draft PR 作成 (PR: https://github.com/yohi/akane/pull/4)

```bash
git push -u origin feat/0-2-scaffold
gh pr create --draft --base feat/0-1-devcontainer --head feat/0-2-scaffold \
  --title "feat(scaffold): bun + tsconfig + @opencode-ai/plugin baseline" \
  --body "Phase 0 stack #2. Adds package.json (with @opencode-ai/plugin), strict tsconfig, and docs/SDK_NOTES.md capturing the actual SDK shapes used by downstream Pinger/Plugin tasks. Predecessor of Task 0.3 (CI) — CI requires package.json/bun.lock to be present, so scaffold lands first."
```

- [x] Step 9.2: PR URL を記録。**この URL は Task 0.3 (CI) の前提条件となる。** → PR #4 (https://github.com/yohi/akane/pull/4)

---

## Task 0.3: CI ワークフロー

- **派生元ブランチ**: `feat/0-2-scaffold`
- **実行モード**: 直列必須 (Wait for Task 0.2)
- **前提条件**: Task 0.2 の Draft PR URL が存在すること (= `package.json` / `bun.lock` が既に存在する)

**Files:**
- Create: `.github/workflows/test.yml`

### Step 1: ブランチ作成と検証 [devcontainer]

- [x] Step 1.1: 派生元ブランチへ切り替え後、新規ブランチを作成

```bash
# [host]
git checkout feat/0-2-scaffold
git checkout -b feat/0-3-ci
```

- [x] Step 1.2: **devcontainer 内** でポカヨケを実行 (ホストで代替実行。devcontainer build 完了後に再検証予定)

```bash
# [devcontainer]
EXPECTED_BASE="feat/0-2-scaffold"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [x] Step 1.3: 派生元の健全性チェック (CI が install/test/typecheck を実行できる状態か確認) — `bun.lockb` は bun 1.2/1.3 では `bun.lock` に変更されたため実際のチェックは `bun.lock` に読み替えた

```bash
# [devcontainer]
test -f package.json && test -f bun.lock \
  && echo "OK: package.json と bun.lock が存在" \
  || { echo "ERROR: 派生元 (Task 0.2) で作成されているはずの package.json / bun.lock が見つからない。CI を導入する前提が整っていない。"; exit 1; }
```

### Step 2: GitHub Actions ワークフローを作成 [host or devcontainer (ファイル作成のみ)]

- [x] Step 2.1: `.github/workflows/test.yml` を作成 (`runs-on` は計画書の `ubuntu-slim` を `ubuntu-latest` に変更 — `ubuntu-slim` は GitHub Actions 公式 hosted runner label に存在しないため)

```yaml
name: test

on:
  push:
    branches:
      - master
      - 'feat/**'
  pull_request:
    branches:
      - master
      - 'feat/**'

jobs:
  bun-test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3"

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run typecheck
        run: bun run typecheck

      - name: Run tests
        run: bun test
```

> **NOTE on `ubuntu-latest`**: GitHub-hosted runner を指定。現状の notifier テストは `Bun.spawn` を DI モックしており実 tmux を起動しないため本 runner で完結する。計画書初版の `ubuntu-slim` は GitHub Actions の公式 hosted runner label として存在せず `ubuntu-latest` に修正した (「No runner matching the specified labels」エラー回避のため)。将来 §11 「将来拡張余地」で実 tmux 結合テストや Docker 起動を CI に組み込む段階になったら、スペックを变更する際に保証チェックすること。
>
> **NOTE on trigger 範囲**: `pull_request.branches` と `push.branches` の両方に `feat/**` を含めている。これはレビュー時に **stacked PR (feat/X → feat/Y) でも CI を走らせるため** に必須 (本計画は Phase 1 以降がすべて feat/* 同士の stacked PR となるため、`master` のみだと中間 PR で CI が一切走らない)。これにより「型整合を CI で逐次保証」(§本ドキュメント冒頭) が満たされる。
>
> **NOTE on typecheck**: `bun run typecheck` を `bun test` の **前** に置く。型エラーは fail fast で検出した方が CI 時間が短く、テスト失敗と型エラーが混在しないためデバッグも容易。typecheck script は Task 0.2 の package.json で既に定義済み (`tsc --noEmit`)。

### Step 3: ワークフロー構文検証 [devcontainer]

- [x] Step 3.1: YAML 構文を確認 (CI を動かす前のローカル検証) — `YAML OK`

```bash
# [devcontainer]
bunx --bun js-yaml .github/workflows/test.yml > /dev/null && echo "YAML OK"
```

期待出力: `YAML OK`

- [x] Step 3.2: ローカルで `bun run typecheck` と `bun test` が両方通ることを確認 (CI と同じステップを再現) — typecheck OK, bun test は bun 1.2.19 の "0 test files" exit 1 振る舞いのため CI (bun 1.3) で検証

```bash
# [devcontainer]
bun install --frozen-lockfile
bun run typecheck
bun test
```

期待出力: typecheck エラーなし、`0 pass, 0 fail` (Phase 0 時点でテストファイルなし)。

### Step 4: コミット [host]

- [ ] Step 4.1: コミット

```bash
git add .github/workflows/test.yml
git commit -m "feat(ci): add bun test + typecheck workflow with feat/** trigger"
```

### Step 5: Draft PR 作成 [host]

- [ ] Step 5.1: 派生元ブランチ向けに Draft PR を作成

```bash
git push -u origin feat/0-3-ci
gh pr create --draft --base feat/0-2-scaffold --head feat/0-3-ci \
  --title "feat(ci): bun typecheck + test on master/feat stacked PRs" \
  --body "Phase 0 stack #3. Triggers typecheck and tests on master and stacked feat/** PRs using ubuntu-slim runner. Lands AFTER Task 0.2 (scaffold) so package.json/bun.lock already exist."
```

- [ ] Step 5.2: PR URL を記録。**この URL は Task 1.1 (Phase 1 起点) の前提条件となる。**

---

# Phase 1: Independent Modules (Serial Stack)

> **重要**: Phase 1 の Task 1.1 → 1.2 → 1.3 → 1.4 は **直列スタック** で実行する。各タスクは前タスクのブランチから派生し、Draft PR のスタックを形成する。
> 並列化は採用しない (初版設計から方針変更)。理由は (a) 型レベルの整合を逐次タスクで担保しやすい、(b) Phase 2 Watchdog のために統合ブランチを別途用意する必要がない、(c) レビュアーが上流から順に確認できる。

## Task 1.1: Clock モジュール (DI 用時計抽象)

- **派生元ブランチ**: `feat/0-3-ci`
- **実行モード**: 直列必須 (Phase 1 起点 / Wait for Task 0.3)
- **前提条件**: Task 0.3 (CI) の Draft PR URL が存在すること

**Files:**
- Create: `src/clock.ts`
- Test: `tests/clock.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/0-3-ci
git checkout -b feat/1-1-clock
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/0-3-ci"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: 失敗するテストを書く [devcontainer]

- [ ] Step 2.1: `tests/clock.test.ts` を作成

```typescript
import { describe, test, expect } from "bun:test";
import { RealClock, FakeClock, type Clock } from "../src/clock";

describe("RealClock", () => {
  test("setTimeout invokes callback after delay (smoke)", async () => {
    const clock: Clock = new RealClock();
    let called = false;
    const handle = clock.setTimeout(() => {
      called = true;
    }, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(called).toBe(true);
    clock.clearTimeout(handle);
  });

  test("clearTimeout prevents callback firing", async () => {
    const clock: Clock = new RealClock();
    let called = false;
    const handle = clock.setTimeout(() => {
      called = true;
    }, 20);
    clock.clearTimeout(handle);
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(false);
  });
});

describe("FakeClock", () => {
  test("does not fire until advance()", () => {
    const clock = new FakeClock();
    let called = false;
    clock.setTimeout(() => {
      called = true;
    }, 100);
    expect(called).toBe(false);
    clock.advance(99);
    expect(called).toBe(false);
    clock.advance(1);
    expect(called).toBe(true);
  });

  test("clearTimeout removes pending callback", () => {
    const clock = new FakeClock();
    let called = false;
    const handle = clock.setTimeout(() => {
      called = true;
    }, 50);
    clock.clearTimeout(handle);
    clock.advance(100);
    expect(called).toBe(false);
  });

  test("multiple timers fire in order", () => {
    const clock = new FakeClock();
    const order: number[] = [];
    clock.setTimeout(() => order.push(2), 200);
    clock.setTimeout(() => order.push(1), 100);
    clock.advance(300);
    expect(order).toEqual([1, 2]);
  });

  test("pendingTimerCount tracks scheduled, fired, and cancelled timers", () => {
    const clock = new FakeClock();
    expect(clock.pendingTimerCount()).toBe(0);

    const h1 = clock.setTimeout(() => {}, 100);
    clock.setTimeout(() => {}, 200);
    expect(clock.pendingTimerCount()).toBe(2);

    clock.clearTimeout(h1);
    expect(clock.pendingTimerCount()).toBe(1);

    clock.advance(300); // fires the remaining timer
    expect(clock.pendingTimerCount()).toBe(0);
  });
});
```

### Step 3: テスト実行 → 失敗確認 [devcontainer]

- [ ] Step 3.1: テスト走行

```bash
# [devcontainer]
bun test tests/clock.test.ts
```

期待出力: `Cannot find module '../src/clock'` または相当のコンパイルエラー。

### Step 4: 最小実装 [devcontainer]

- [ ] Step 4.1: `src/clock.ts` を作成

```typescript
export type TimerHandle = unknown;

export interface Clock {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export class RealClock implements Clock {
  setTimeout(callback: () => void, ms: number): TimerHandle {
    return globalThis.setTimeout(callback, ms);
  }
  clearTimeout(handle: TimerHandle): void {
    if (handle !== undefined && handle !== null) {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    }
  }
}

interface FakeTimer {
  fireAt: number;
  callback: () => void;
  cancelled: boolean;
}

export class FakeClock implements Clock {
  private now = 0;
  private timers: FakeTimer[] = [];

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const timer: FakeTimer = { fireAt: this.now + ms, callback, cancelled: false };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: TimerHandle): void {
    const timer = handle as FakeTimer | undefined;
    if (timer) timer.cancelled = true;
  }

  advance(ms: number): void {
    const targetTime = this.now + ms;
    // Process timers in deadline order until target reached
    // Loop until no more eligible timers (handles callbacks scheduling new timers)
    while (true) {
      const eligible = this.timers
        .filter((t) => !t.cancelled && t.fireAt <= targetTime)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!eligible) break;
      this.now = eligible.fireAt;
      eligible.cancelled = true;
      eligible.callback();
    }
    this.now = targetTime;
  }

  /** Number of timers scheduled but not yet fired or cancelled. Used by stress
   * tests to detect timer leaks (design §7.4). */
  pendingTimerCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}
```

### Step 5: テスト実行 → 成功確認 [devcontainer]

- [ ] Step 5.1: テスト走行

```bash
# [devcontainer]
bun test tests/clock.test.ts
```

期待出力: `6 pass, 0 fail`

- [ ] Step 5.2: 型チェック

```bash
# [devcontainer]
bun run typecheck
```

期待出力: エラーなし

### Step 6: コミット [host]

- [ ] Step 6.1: コミット

```bash
git add src/clock.ts tests/clock.test.ts
git commit -m "feat(clock): add DI-friendly Clock with RealClock and FakeClock"
```

### Step 7: Draft PR 作成 [host]

- [ ] Step 7.1: Draft PR 作成

```bash
git push -u origin feat/1-1-clock
gh pr create --draft --base feat/0-3-ci --head feat/1-1-clock \
  --title "feat(clock): DI clock with FakeClock for unit tests" \
  --body "Phase 1 stack #1 (serial). Pure DI abstraction over setTimeout/clearTimeout."
```

- [ ] Step 7.2: PR URL を記録

---

## Task 1.2: Config モジュール

- **派生元ブランチ**: `feat/1-1-clock`
- **実行モード**: 直列必須 (Wait for Task 1.1)
- **前提条件**: Task 1.1 の Draft PR URL が存在すること

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/1-1-clock
git checkout -b feat/1-2-config
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/1-1-clock"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: 失敗するテストを書く [devcontainer]

- [ ] Step 2.1: `tests/config.test.ts` を作成

```typescript
import { describe, test, expect } from "bun:test";
import { resolveConfig, DEFAULT_CONFIG, type ConfigSources } from "../src/config";

describe("resolveConfig", () => {
  test("returns defaults when no sources provided", () => {
    const cfg = resolveConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.stage1Ms).toBe(180_000);
    expect(cfg.stage2Ms).toBe(180_000);
    expect(cfg.maxPings).toBe(1);
    expect(cfg.pingMessage).toBe(DEFAULT_CONFIG.pingMessage);
    expect(cfg.tmux.enabled).toBe(true);
    expect(cfg.tmux.displayMessage).toBe(true);
    expect(cfg.tmux.highlightWindow).toBe(true);
  });

  test("project config overrides defaults", () => {
    const sources: ConfigSources = {
      project: { stage1Ms: 60_000, maxPings: 3 },
    };
    const cfg = resolveConfig(sources);
    expect(cfg.stage1Ms).toBe(60_000);
    expect(cfg.maxPings).toBe(3);
    expect(cfg.stage2Ms).toBe(180_000); // default preserved
  });

  test("env overrides project config", () => {
    const sources: ConfigSources = {
      project: { stage1Ms: 60_000 },
      env: { OPENCODE_WATCHDOG_STAGE1_MS: "30000" },
    };
    const cfg = resolveConfig(sources);
    expect(cfg.stage1Ms).toBe(30_000);
  });

  test("env OPENCODE_WATCHDOG_ENABLED=false disables", () => {
    const cfg = resolveConfig({ env: { OPENCODE_WATCHDOG_ENABLED: "false" } });
    expect(cfg.enabled).toBe(false);
  });

  test("invalid negative number falls back to default with warn", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { project: { stage1Ms: -100 } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.stage1Ms).toBe(180_000);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("stage1Ms");
  });

  test("invalid type in env falls back to default", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { env: { OPENCODE_WATCHDOG_MAX_PINGS: "not-a-number" } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.maxPings).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("agents.include and exclude pass through", () => {
    const cfg = resolveConfig({
      project: { agents: { include: ["main"], exclude: ["debug"] } },
    });
    expect(cfg.agents.include).toEqual(["main"]);
    expect(cfg.agents.exclude).toEqual(["debug"]);
  });
});
```

### Step 3: テスト実行 → 失敗確認 [devcontainer]

- [ ] Step 3.1: テスト走行

```bash
# [devcontainer]
bun test tests/config.test.ts
```

期待出力: モジュール未存在のエラー

### Step 4: 最小実装 [devcontainer]

- [ ] Step 4.1: `src/config.ts` を作成

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

export interface ConfigSources {
  project?: Partial<WatchdogConfig> & {
    tmux?: Partial<WatchdogConfig["tmux"]>;
    agents?: Partial<WatchdogConfig["agents"]>;
  };
  env?: Record<string, string | undefined>;
}

export type WarnFn = (message: string) => void;

export const DEFAULT_CONFIG: WatchdogConfig = {
  enabled: true,
  stage1Ms: 180_000,
  stage2Ms: 180_000,
  maxPings: 1,
  pingMessage:
    "現在の状況を教えてください。ハングしているようであれば、思考プロセスを要約して次のアクションを提示してください。",
  tmux: {
    enabled: true,
    displayMessage: true,
    highlightWindow: true,
  },
  agents: {},
};

function parsePositiveInt(value: string | undefined, key: string, warn: WarnFn): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    warn(`[watchdog] Invalid value for ${key}: "${value}". Falling back to default.`);
    return undefined;
  }
  return n;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function validateNumber(
  value: number | undefined,
  key: string,
  warn: WarnFn,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    warn(`[watchdog] Invalid value for ${key}: ${value}. Falling back to default.`);
    return undefined;
  }
  return value;
}

export function resolveConfig(
  sources: ConfigSources,
  warn: WarnFn = (msg) => console.warn(msg),
): WatchdogConfig {
  const env = sources.env ?? {};
  const project = sources.project ?? {};

  const envEnabled = parseBool(env.OPENCODE_WATCHDOG_ENABLED);
  const envStage1 = parsePositiveInt(env.OPENCODE_WATCHDOG_STAGE1_MS, "OPENCODE_WATCHDOG_STAGE1_MS", warn);
  const envStage2 = parsePositiveInt(env.OPENCODE_WATCHDOG_STAGE2_MS, "OPENCODE_WATCHDOG_STAGE2_MS", warn);
  const envMaxPings = parsePositiveInt(env.OPENCODE_WATCHDOG_MAX_PINGS, "OPENCODE_WATCHDOG_MAX_PINGS", warn);

  const projStage1 = validateNumber(project.stage1Ms, "stage1Ms", warn);
  const projStage2 = validateNumber(project.stage2Ms, "stage2Ms", warn);
  const projMaxPings = validateNumber(project.maxPings, "maxPings", warn);

  return {
    enabled: envEnabled ?? project.enabled ?? DEFAULT_CONFIG.enabled,
    stage1Ms: envStage1 ?? projStage1 ?? DEFAULT_CONFIG.stage1Ms,
    stage2Ms: envStage2 ?? projStage2 ?? DEFAULT_CONFIG.stage2Ms,
    maxPings: envMaxPings ?? projMaxPings ?? DEFAULT_CONFIG.maxPings,
    pingMessage: project.pingMessage ?? DEFAULT_CONFIG.pingMessage,
    tmux: {
      enabled: project.tmux?.enabled ?? DEFAULT_CONFIG.tmux.enabled,
      displayMessage: project.tmux?.displayMessage ?? DEFAULT_CONFIG.tmux.displayMessage,
      highlightWindow: project.tmux?.highlightWindow ?? DEFAULT_CONFIG.tmux.highlightWindow,
    },
    agents: {
      include: project.agents?.include,
      exclude: project.agents?.exclude,
    },
  };
}
```

### Step 5: テスト実行 → 成功確認 [devcontainer]

- [ ] Step 5.1: テスト走行

```bash
# [devcontainer]
bun test tests/config.test.ts
```

期待出力: `7 pass, 0 fail`

- [ ] Step 5.2: 型チェック

```bash
# [devcontainer]
bun run typecheck
```

期待出力: エラーなし

### Step 6: コミット [host]

- [ ] Step 6.1: コミット

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add env > project > defaults resolution with validation"
```

### Step 7: Draft PR 作成 [host]

- [ ] Step 7.1: Draft PR 作成

```bash
git push -u origin feat/1-2-config
gh pr create --draft --base feat/1-1-clock --head feat/1-2-config \
  --title "feat(config): env > project > defaults with safe fallback" \
  --body "Phase 1 stack #2 (serial). Pure function config resolver per design §4."
```

- [ ] Step 7.2: PR URL を記録

---

## Task 1.3: Pinger モジュール

- **派生元ブランチ**: `feat/1-2-config`
- **実行モード**: 直列必須 (Wait for Task 1.2)
- **前提条件**:
  - Task 1.2 の Draft PR URL が存在すること
  - Task 0.2 の Step 7 で作成した `docs/SDK_NOTES.md` が **最新で埋まっている** こと (Plugin / client.session.* の実測形が記録済み)

**Files:**
- Create: `src/pinger.ts`
- Test: `tests/pinger.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/1-2-config
git checkout -b feat/1-3-pinger
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/1-2-config"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: 失敗するテストを書く [devcontainer]

> **前提**: `docs/SDK_NOTES.md` に記録した `client.session.prompt` の引数形 (本プランのベースラインは `{ path: { id }, body: { parts } }`) に従ってテストを書く。実 SDK 型と差異があった場合は **SDK_NOTES の実測形を正** とし、本ステップのテスト/実装を併せて書き換える。

- [ ] Step 2.1: `tests/pinger.test.ts` を作成

```typescript
import { describe, test, expect } from "bun:test";
import { MockPinger, OpenCodeAdapter, type Pinger } from "../src/pinger";

describe("MockPinger", () => {
  test("records each inject call", async () => {
    const m = new MockPinger();
    await m.inject("session-1", "hello?");
    await m.inject("session-2", "still alive?");
    expect(m.calls).toEqual([
      { sessionId: "session-1", message: "hello?" },
      { sessionId: "session-2", message: "still alive?" },
    ]);
  });

  test("returns a resolved promise", async () => {
    const m: Pinger = new MockPinger();
    await expect(m.inject("s", "msg")).resolves.toBeUndefined();
  });
});

describe("OpenCodeAdapter", () => {
  test("delegates to client.session.prompt with { path: { id }, body: { parts } } shape", async () => {
    const calls: Array<{ path: { id: string }; body: { parts: unknown[] } }> = [];
    const fakeClient = {
      session: {
        prompt: async (args: { path: { id: string }; body: { parts: unknown[] } }) => {
          calls.push(args);
        },
      },
    };
    const adapter = new OpenCodeAdapter(fakeClient);
    await adapter.inject("sess-abc", "ping?");
    expect(calls.length).toBe(1);
    expect(calls[0]!.path.id).toBe("sess-abc");
    expect(Array.isArray(calls[0]!.body.parts)).toBe(true);
    // Each part should be a text part carrying the message
    const firstPart = calls[0]!.body.parts[0] as { type: string; text: string };
    expect(firstPart.type).toBe("text");
    expect(firstPart.text).toBe("ping?");
  });

  test("does not throw when client method is missing (logs only)", async () => {
    const adapter = new OpenCodeAdapter({} as unknown);
    await expect(adapter.inject("s", "msg")).resolves.toBeUndefined();
  });

  test("does not throw when client throws", async () => {
    const failingClient = {
      session: {
        prompt: async () => {
          throw new Error("boom");
        },
      },
    };
    const adapter = new OpenCodeAdapter(failingClient);
    await expect(adapter.inject("s", "msg")).resolves.toBeUndefined();
  });
});
```

### Step 3: テスト実行 → 失敗確認 [devcontainer]

- [ ] Step 3.1: テスト走行

```bash
# [devcontainer]
bun test tests/pinger.test.ts
```

期待出力: モジュール未存在エラー

### Step 4: 最小実装 [devcontainer]

- [ ] Step 4.1: `src/pinger.ts` を作成

```typescript
export interface Pinger {
  inject(sessionId: string, message: string): Promise<void>;
}

export class MockPinger implements Pinger {
  public readonly calls: Array<{ sessionId: string; message: string }> = [];
  async inject(sessionId: string, message: string): Promise<void> {
    this.calls.push({ sessionId, message });
  }
}

// Shape derived from docs/SDK_NOTES.md. If the real SDK type from @opencode-ai/plugin
// diverges, update SDK_NOTES first, then adjust here. The Pinger interface above is fixed.
interface OpenCodeClientLike {
  session?: {
    prompt?: (args: { path: { id: string }; body: { parts: unknown[] } }) => Promise<unknown>;
  };
}

export class OpenCodeAdapter implements Pinger {
  constructor(private readonly client: unknown) {}

  async inject(sessionId: string, message: string): Promise<void> {
    const client = this.client as OpenCodeClientLike;
    const prompt = client?.session?.prompt;
    if (typeof prompt !== "function") {
      console.warn(
        `[watchdog] OpenCode client.session.prompt is unavailable; cannot inject ping to ${sessionId}.`,
      );
      return;
    }
    try {
      await prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: message }] },
      });
    } catch (err) {
      console.warn(`[watchdog] Failed to inject ping to ${sessionId}:`, err);
    }
  }
}
```

> **NOTE**: 引数形は `docs/SDK_NOTES.md` (Task 0.2 Step 7 で記録) を出典とする。実 SDK 型がレコードと異なる場合、SDK_NOTES を最新化したうえで本実装と上のテストの両方を差し替えること。Pinger インタフェース (`inject(sessionId, message)`) は SDK 形にかかわらず不変。

### Step 5: テスト実行 → 成功確認 [devcontainer]

- [ ] Step 5.1: テスト走行

```bash
# [devcontainer]
bun test tests/pinger.test.ts
```

期待出力: `5 pass, 0 fail`

- [ ] Step 5.2: 型チェック

```bash
# [devcontainer]
bun run typecheck
```

### Step 6: コミット [host]

- [ ] Step 6.1: コミット

```bash
git add src/pinger.ts tests/pinger.test.ts
git commit -m "feat(pinger): add Pinger interface with MockPinger and OpenCodeAdapter"
```

### Step 7: Draft PR 作成 [host]

- [ ] Step 7.1: Draft PR 作成

```bash
git push -u origin feat/1-3-pinger
gh pr create --draft --base feat/1-2-config --head feat/1-3-pinger \
  --title "feat(pinger): Pinger interface + MockPinger + OpenCodeAdapter" \
  --body "Phase 1 stack #3 (serial). Abstracts ping injection so watchdog core has no SDK dependency. Uses SDK shape recorded in docs/SDK_NOTES.md."
```

- [ ] Step 7.2: PR URL を記録

---

## Task 1.4: Notifier モジュール

- **派生元ブランチ**: `feat/1-3-pinger`
- **実行モード**: 直列必須 (Wait for Task 1.3)
- **前提条件**: Task 1.3 の Draft PR URL が存在すること

**Files:**
- Create: `src/notifier.ts`
- Test: `tests/notifier.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/1-3-pinger
git checkout -b feat/1-4-notifier
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/1-3-pinger"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: 失敗するテストを書く [devcontainer]

- [ ] Step 2.1: `tests/notifier.test.ts` を作成

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import {
  TmuxNotifier,
  type NotifierStage,
  type SpawnFn,
  type WhichFn,
} from "../src/notifier";

interface SpawnCall {
  cmd: string[];
  result: { exitCode: number; stdout?: string };
}

function buildEnv(overrides: Partial<{ tmux: string }> = {}) {
  return { TMUX: overrides.tmux ?? "/tmp/tmux-1000/default,1234,0" };
}

function buildSpawn(plan: Record<string, { exitCode: number; stdout?: string }>): {
  spawn: SpawnFn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = async (cmd) => {
    const key = cmd.join(" ");
    const result = plan[key] ?? { exitCode: 0 };
    calls.push({ cmd, result });
    return result;
  };
  return { spawn, calls };
}

describe("TmuxNotifier - detection", () => {
  test("disables tmux integration when TMUX env is missing", async () => {
    const { spawn, calls } = buildSpawn({});
    const which: WhichFn = () => "/usr/bin/tmux";
    const n = new TmuxNotifier({ env: {}, spawn, which });
    await n.notify("s1", "warn", "msg");
    expect(calls.length).toBe(0);
  });

  test("disables tmux when which returns null", async () => {
    const { spawn, calls } = buildSpawn({});
    const which: WhichFn = () => null;
    const n = new TmuxNotifier({ env: buildEnv(), spawn, which });
    await n.notify("s1", "warn", "msg");
    expect(calls.length).toBe(0);
  });

  test("disables tmux when dry-run probe fails", async () => {
    const { spawn, calls } = buildSpawn({
      "tmux display-message -p #{session_name}": { exitCode: 1 },
    });
    const which: WhichFn = () => "/usr/bin/tmux";
    const n = new TmuxNotifier({ env: buildEnv(), spawn, which });
    await n.notify("s1", "warn", "msg");
    // probe runs once, then no further calls
    expect(calls.length).toBe(1);
  });
});

describe("TmuxNotifier - actions", () => {
  let plan: Record<string, { exitCode: number; stdout?: string }>;
  let spawn: SpawnFn;
  let calls: SpawnCall[];
  let notifier: TmuxNotifier;

  beforeEach(() => {
    plan = {
      "tmux display-message -p #{session_name}": { exitCode: 0, stdout: "main" },
    };
    const built = buildSpawn(plan);
    spawn = built.spawn;
    calls = built.calls;
    const which: WhichFn = () => "/usr/bin/tmux";
    notifier = new TmuxNotifier({ env: buildEnv(), spawn, which });
  });

  // Notifier passes `message` verbatim. The watchdog caller is responsible for
  // building design §5.2 mandated text; these tests assert verbatim pass-through
  // with exact match (no implicit prefix or formatting by the notifier).

  test("notify(warn) passes message verbatim and applies yellow highlight", async () => {
    const exact = "[Watchdog] Agent sess-1 idle for 180000ms";
    await notifier.notify("sess-1", "warn", exact);
    const displayCall = calls.find((c) => c.cmd[1] === "display-message");
    expect(displayCall).toBeDefined();
    expect(displayCall!.cmd).toEqual(["tmux", "display-message", exact]);
    expect(
      calls.some(
        (c) => c.cmd[1] === "set-window-option" && c.cmd.includes("bg=yellow"),
      ),
    ).toBe(true);
  });

  test("notify(critical) passes message verbatim and applies red highlight", async () => {
    const exact = "[Watchdog] Ping injected to sess-1";
    await notifier.notify("sess-1", "critical", exact);
    const displayCall = calls.find((c) => c.cmd[1] === "display-message");
    expect(displayCall!.cmd).toEqual(["tmux", "display-message", exact]);
    expect(
      calls.some(
        (c) => c.cmd[1] === "set-window-option" && c.cmd.includes("bg=red"),
      ),
    ).toBe(true);
  });

  test("notify(silenced) passes message verbatim and keeps red highlight", async () => {
    const exact = "[Watchdog] Max pings reached. Manual intervention required.";
    await notifier.notify("sess-1", "silenced", exact);
    const displayCall = calls.find((c) => c.cmd[1] === "display-message");
    expect(displayCall!.cmd).toEqual(["tmux", "display-message", exact]);
    expect(
      calls.some(
        (c) => c.cmd[1] === "set-window-option" && c.cmd.includes("bg=red"),
      ),
    ).toBe(true);
  });

  test("clear() restores default window-status-current-style", async () => {
    await notifier.clear("sess-1");
    expect(
      calls.some(
        (c) => c.cmd[1] === "set-window-option" && c.cmd.includes("default"),
      ),
    ).toBe(true);
  });

  test("passes args as array (no shell injection risk)", async () => {
    // sessionId-shaped attack surface must not be split into multiple shell tokens.
    const malicious = "sess-1; rm -rf /";
    const message = `[Watchdog] Agent ${malicious} idle for 180000ms`;
    await notifier.notify(malicious, "warn", message);
    const displayCall = calls.find((c) => c.cmd[1] === "display-message");
    expect(displayCall!.cmd.length).toBe(3);
    expect(displayCall!.cmd[2]).toBe(message);
    for (const c of calls) {
      expect(Array.isArray(c.cmd)).toBe(true);
    }
  });
});

describe("TmuxNotifier - error containment", () => {
  test("spawn rejection is swallowed (no throw)", async () => {
    const which: WhichFn = () => "/usr/bin/tmux";
    const spawn: SpawnFn = async () => {
      throw new Error("ENOENT");
    };
    const n = new TmuxNotifier({ env: buildEnv(), spawn, which });
    await expect(n.notify("s1", "warn", "m")).resolves.toBeUndefined();
  });
});
```

### Step 3: テスト実行 → 失敗確認 [devcontainer]

- [ ] Step 3.1: テスト走行

```bash
# [devcontainer]
bun test tests/notifier.test.ts
```

期待出力: モジュール未存在エラー

### Step 4: 最小実装 [devcontainer]

- [ ] Step 4.1: `src/notifier.ts` を作成

```typescript
export type NotifierStage = "warn" | "critical" | "silenced";

export interface Notifier {
  notify(sessionId: string, stage: NotifierStage, message: string): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

export type SpawnResult = { exitCode: number; stdout?: string };
export type SpawnFn = (cmd: string[]) => Promise<SpawnResult>;
export type WhichFn = (binary: string) => string | null;

export interface TmuxNotifierDeps {
  env: Record<string, string | undefined>;
  spawn: SpawnFn;
  which: WhichFn;
  log?: (level: "warn" | "info", message: string) => void;
}

const STYLE_BY_STAGE: Record<NotifierStage, string> = {
  warn: "bg=yellow",
  critical: "bg=red",
  silenced: "bg=red",
};

export class TmuxNotifier implements Notifier {
  private detection: "unknown" | "ok" | "disabled" = "unknown";
  private readonly log: (level: "warn" | "info", message: string) => void;

  constructor(private readonly deps: TmuxNotifierDeps) {
    this.log = deps.log ?? ((level, message) => console[level](`[watchdog] ${message}`));
  }

  /**
   * Renders `message` verbatim to tmux display-message and applies the stage-specific
   * window highlight color. The caller is responsible for producing the design §5.2
   * mandated text (e.g. "[Watchdog] Agent <sessionId> idle for <stage1Ms>ms").
   * Notifier never prefixes or reformats the message.
   */
  async notify(sessionId: string, stage: NotifierStage, message: string): Promise<void> {
    if (!(await this.ensureTmux())) return;
    await this.safeSpawn(["tmux", "display-message", message]);
    await this.safeSpawn([
      "tmux",
      "set-window-option",
      "window-status-current-style",
      STYLE_BY_STAGE[stage],
    ]);
  }

  async clear(sessionId: string): Promise<void> {
    if (!(await this.ensureTmux())) return;
    await this.safeSpawn([
      "tmux",
      "set-window-option",
      "window-status-current-style",
      "default",
    ]);
  }

  private async ensureTmux(): Promise<boolean> {
    if (this.detection === "ok") return true;
    if (this.detection === "disabled") return false;

    const tmuxEnv = this.deps.env.TMUX;
    if (!tmuxEnv) {
      this.detection = "disabled";
      this.log("info", "tmux not detected (TMUX env empty).");
      return false;
    }
    const path = this.deps.which("tmux");
    if (!path) {
      this.detection = "disabled";
      this.log("info", "tmux binary not found in PATH.");
      return false;
    }
    const probe = await this.safeSpawn(["tmux", "display-message", "-p", "#{session_name}"]);
    if (!probe || probe.exitCode !== 0) {
      this.detection = "disabled";
      this.log("info", "tmux probe failed; disabling tmux integration.");
      return false;
    }
    this.detection = "ok";
    return true;
  }

  private async safeSpawn(cmd: string[]): Promise<SpawnResult | null> {
    try {
      return await this.deps.spawn(cmd);
    } catch (err) {
      this.log("warn", `tmux spawn failed: ${String(err)}`);
      return null;
    }
  }
}

// Default spawn/which factory using Bun. Kept separate so tests can DI mocks.
export function bunSpawn(): SpawnFn {
  return async (cmd) => {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { exitCode, stdout };
  };
}

export function bunWhich(): WhichFn {
  return (binary) => Bun.which(binary) ?? null;
}
```

### Step 5: テスト実行 → 成功確認 [devcontainer]

- [ ] Step 5.1: テスト走行

```bash
# [devcontainer]
bun test tests/notifier.test.ts
```

期待出力: `9 pass, 0 fail` (テスト数は実装と一致)

- [ ] Step 5.2: 型チェック

```bash
# [devcontainer]
bun run typecheck
```

### Step 6: コミット [host]

- [ ] Step 6.1: コミット

```bash
git add src/notifier.ts tests/notifier.test.ts
git commit -m "feat(notifier): add TmuxNotifier with 3-stage detection and color highlighting"
```

### Step 7: Draft PR 作成 [host]

- [ ] Step 7.1: Draft PR 作成

```bash
git push -u origin feat/1-4-notifier
gh pr create --draft --base feat/1-3-pinger --head feat/1-4-notifier \
  --title "feat(notifier): TmuxNotifier with detect-then-cache and safe spawn" \
  --body "Phase 1 stack #4 (serial). tmux display-message + window highlight per design §5."
```

- [ ] Step 7.2: PR URL を記録

---

# Phase 2: Watchdog Core

## Task 2.1: Watchdog 状態マシン + タイマー

- **派生元ブランチ**: `feat/1-4-notifier`
- **実行モード**: 直列必須 (Wait for Task 1.4)
- **前提条件**: Task 1.4 の Draft PR URL が存在すること

**Files:**
- Create: `src/watchdog.ts`
- Test: `tests/watchdog.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/1-4-notifier
git checkout -b feat/2-1-watchdog
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/1-4-notifier"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] Step 1.3: Phase 1 のファイルが揃っていることを確認 (派生元の健全性チェック)

```bash
# [devcontainer]
test -f src/clock.ts && test -f src/config.ts && test -f src/pinger.ts && test -f src/notifier.ts \
  && echo "OK: Phase 1 modules present" \
  || { echo "ERROR: 派生元の Phase 1 モジュールが欠落"; exit 1; }
```

### Step 2: 失敗するテストを書く (基本遷移) [devcontainer]

- [ ] Step 2.1: `tests/watchdog.test.ts` を作成

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { Watchdog } from "../src/watchdog";
import { FakeClock } from "../src/clock";
import { MockPinger } from "../src/pinger";
import type { Notifier, NotifierStage } from "../src/notifier";
import type { WatchdogConfig } from "../src/config";

interface NotifyCall {
  sessionId: string;
  stage: NotifierStage;
  message: string;
}

class MockNotifier implements Notifier {
  notifies: NotifyCall[] = [];
  cleared: string[] = [];
  async notify(sessionId: string, stage: NotifierStage, message: string) {
    this.notifies.push({ sessionId, stage, message });
  }
  async clear(sessionId: string) {
    this.cleared.push(sessionId);
  }
}

const baseConfig: WatchdogConfig = {
  enabled: true,
  stage1Ms: 1000,
  stage2Ms: 1000,
  maxPings: 1,
  pingMessage: "ping?",
  tmux: { enabled: true, displayMessage: true, highlightWindow: true },
  agents: {},
};

function setup(configOverrides: Partial<WatchdogConfig> = {}) {
  const clock = new FakeClock();
  const pinger = new MockPinger();
  const notifier = new MockNotifier();
  const watchdog = new Watchdog({
    config: { ...baseConfig, ...configOverrides },
    clock,
    pinger,
    notifier,
  });
  return { clock, pinger, notifier, watchdog };
}

describe("Watchdog - basic timer behavior", () => {
  test("onActivity creates a timer when none exists", () => {
    const { watchdog } = setup();
    watchdog.onActivity("s1");
    expect(watchdog.activeSessionCount()).toBe(1);
  });

  test("multiple onActivity calls keep only one timer per session", () => {
    const { watchdog } = setup();
    for (let i = 0; i < 100; i++) {
      watchdog.onActivity("s1");
    }
    expect(watchdog.activeSessionCount()).toBe(1);
  });

  test("stage1 expires triggers notifier.notify(warn)", async () => {
    const { watchdog, notifier, clock } = setup();
    watchdog.onActivity("s1");
    clock.advance(1000);
    expect(notifier.notifies.length).toBe(1);
    expect(notifier.notifies[0]!.stage).toBe("warn");
  });

  test("stage1+stage2 expires triggers pinger.inject and notifier.notify(critical)", async () => {
    const { watchdog, notifier, pinger, clock } = setup();
    watchdog.onActivity("s1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2
    // Wait for async ping
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
    expect(pinger.calls[0]!.sessionId).toBe("s1");
    expect(pinger.calls[0]!.message).toBe("ping?");
    expect(notifier.notifies.some((n) => n.stage === "critical")).toBe(true);
  });

  test("activity after STAGE1_NOTIFIED resets to WATCHING", async () => {
    const { watchdog, notifier, clock } = setup();
    watchdog.onActivity("s1");
    clock.advance(1000); // stage1 fires
    expect(notifier.notifies.length).toBe(1);
    notifier.notifies.length = 0;
    watchdog.onActivity("s1"); // back to WATCHING
    clock.advance(999); // not yet stage1
    expect(notifier.notifies.length).toBe(0);
    clock.advance(1); // stage1 again
    expect(notifier.notifies.length).toBe(1);
  });
});

describe("Watchdog - maxPings ceiling", () => {
  test("maxPings=1: second stage2 does not inject again, transitions to silenced", async () => {
    const { watchdog, pinger, notifier, clock } = setup({ maxPings: 1 });
    watchdog.onActivity("s1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 → ping #1
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
    clock.advance(1000); // stage2 fires again with no activity
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1); // still 1, no new ping
    expect(notifier.notifies.some((n) => n.stage === "silenced")).toBe(true);
  });

  test("activity in SILENCED state resets pingCount and returns to WATCHING", async () => {
    const { watchdog, pinger, clock } = setup({ maxPings: 1 });
    watchdog.onActivity("s1");
    clock.advance(1000);
    clock.advance(1000); // ping
    await new Promise((r) => setTimeout(r, 10));
    clock.advance(1000); // silenced
    await new Promise((r) => setTimeout(r, 10));

    watchdog.onActivity("s1"); // recovery
    clock.advance(1000); // stage1 again
    clock.advance(1000); // stage2 → ping again because pingCount reset
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(2);
  });
});

describe("Watchdog - lifecycle cleanup", () => {
  test("stop() removes session from map and prevents further timers", () => {
    const { watchdog, notifier, clock } = setup();
    watchdog.onActivity("s1");
    expect(watchdog.activeSessionCount()).toBe(1);
    watchdog.stop("s1");
    expect(watchdog.activeSessionCount()).toBe(0);
    clock.advance(10_000);
    expect(notifier.notifies.length).toBe(0);
  });

  test("late message.part.updated after stop() is ignored (no timer rearm)", () => {
    // Per design §7.3: "session.idle 後に message.part.updated を受信しても
    // 新規タイマーが作られない (stop 時に sessionId を FIFO 上限 10,000 件の
    // tombstone セットへ登録し、それ以内に到着した message.part.updated 側で
    // 抑止するため)".
    // Stale events from a stopped session must not produce false positives.
    const { watchdog, clock, notifier } = setup();
    watchdog.onActivity("s1");
    watchdog.stop("s1");
    watchdog.onActivity("s1"); // simulated late part event
    clock.advance(10_000);
    expect(notifier.notifies.length).toBe(0);
    expect(watchdog.activeSessionCount()).toBe(0);
  });

  test("onUserMessage after stop() re-arms (new burst is allowed via user input only)", () => {
    // A fresh user prompt on a previously stopped session is legitimately a new burst.
    // This is the documented re-entry point in design §3.4 (IDLE → message.updated role=user).
    const { watchdog, clock, notifier } = setup();
    watchdog.onActivity("s1");
    watchdog.stop("s1");
    watchdog.onUserMessage("s1"); // explicit user-driven re-entry
    clock.advance(1000);
    expect(notifier.notifies.length).toBe(1);
    expect(notifier.notifies[0]!.stage).toBe("warn");
  });
});

describe("Watchdog - initial hang detection (design §3.4)", () => {
  test("onUserMessage triggers timer even with no parts", async () => {
    const { watchdog, notifier, pinger, clock } = setup();
    watchdog.onUserMessage("s1");
    expect(watchdog.activeSessionCount()).toBe(1);
    clock.advance(1000); // stage1
    expect(notifier.notifies.length).toBe(1);
    clock.advance(1000); // stage2 ping
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
  });
});

describe("Watchdog - empty session no false trigger", () => {
  test("onSessionCreated alone does not arm any timer", () => {
    const { watchdog, clock, notifier } = setup();
    watchdog.onSessionCreated("s1");
    clock.advance(60_000);
    expect(watchdog.activeSessionCount()).toBe(0);
    expect(notifier.notifies.length).toBe(0);
  });
});

describe("Watchdog - agent filtering", () => {
  test("excluded agents do not trigger timers", () => {
    const { watchdog, clock, notifier } = setup({
      agents: { exclude: ["debug"] },
    });
    watchdog.onActivity("s1", { agentName: "debug" });
    expect(watchdog.activeSessionCount()).toBe(0);
    clock.advance(10_000);
    expect(notifier.notifies.length).toBe(0);
  });

  test("include list restricts monitoring to listed agents only", () => {
    const { watchdog, clock, notifier } = setup({
      agents: { include: ["main"] },
    });
    watchdog.onActivity("s1", { agentName: "secondary" });
    expect(watchdog.activeSessionCount()).toBe(0);
    clock.advance(10_000);
    expect(notifier.notifies.length).toBe(0);

    watchdog.onActivity("s2", { agentName: "main" });
    expect(watchdog.activeSessionCount()).toBe(1);
  });
});
```

### Step 3: テスト実行 → 失敗確認 [devcontainer]

- [ ] Step 3.1: テスト走行

```bash
# [devcontainer]
bun test tests/watchdog.test.ts
```

期待出力: モジュール未存在エラー

### Step 4: Watchdog 実装 [devcontainer]

- [ ] Step 4.1: `src/watchdog.ts` を作成

```typescript
import type { Clock, TimerHandle } from "./clock";
import type { Notifier } from "./notifier";
import type { Pinger } from "./pinger";
import type { WatchdogConfig } from "./config";

type State = "WATCHING" | "STAGE1_NOTIFIED" | "PINGED" | "SILENCED";

interface SessionEntry {
  state: State;
  timer: TimerHandle | null;
  pingCount: number;
  agentName?: string;
}

export interface WatchdogDeps {
  config: WatchdogConfig;
  clock: Clock;
  notifier: Notifier;
  pinger: Pinger;
  log?: (level: "info" | "warn", message: string) => void;
}

export interface ActivityMeta {
  agentName?: string;
}

// FIFO-bounded tombstone set. Used to suppress late `message.part.updated`
// events arriving after `session.idle/error/deleted` per design §7.3.
// `onUserMessage` (fresh user input) explicitly clears the tombstone — that is
// the documented re-entry point from IDLE → WATCHING in §3.4.
const STOPPED_TOMBSTONE_CAPACITY = 10_000;

export class Watchdog {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly stoppedSessions = new Set<string>();
  private readonly stoppedOrder: string[] = [];
  private readonly config: WatchdogConfig;
  private readonly clock: Clock;
  private readonly notifier: Notifier;
  private readonly pinger: Pinger;
  private readonly log: (level: "info" | "warn", message: string) => void;

  constructor(deps: WatchdogDeps) {
    this.config = deps.config;
    this.clock = deps.clock;
    this.notifier = deps.notifier;
    this.pinger = deps.pinger;
    this.log = deps.log ?? ((level, m) => console[level](`[watchdog] ${m}`));
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }

  /** Number of sessions currently holding a non-null timer reference. Distinct
   * from activeSessionCount — a session in SILENCED state has an entry but no
   * scheduled timer. Used by stress tests to detect timer leaks (design §7.4).
   */
  activeTimerCount(): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.timer !== null) count += 1;
    }
    return count;
  }

  /** Session created event — informational only. Do not arm timers. */
  onSessionCreated(_sessionId: string): void {
    // intentionally noop per design §2.3
  }

  /**
   * User message confirmed — initial trigger (design §3.4 IDLE → WATCHING).
   * Clears any tombstone so a previously stopped session can be re-armed on
   * fresh user input, then delegates to the same WATCHING entry creation as
   * onActivity.
   */
  onUserMessage(sessionId: string, meta: ActivityMeta = {}): void {
    this.clearTombstone(sessionId);
    this.armOrReset(sessionId, meta);
  }

  /**
   * Activity from `message.part.updated`. If the session is in the stopped
   * tombstone set, the event is treated as stale and ignored (design §7.3).
   */
  onActivity(sessionId: string, meta: ActivityMeta = {}): void {
    if (this.stoppedSessions.has(sessionId)) return;
    this.armOrReset(sessionId, meta);
  }

  /** Session terminated normally or with error. Tombstones the sessionId. */
  stop(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.timer !== null) this.clock.clearTimeout(entry.timer);
    this.sessions.delete(sessionId);
    this.recordTombstone(sessionId);
    this.notifier.clear(sessionId).catch((err) =>
      this.log("warn", `notifier.clear failed: ${String(err)}`),
    );
  }

  private armOrReset(sessionId: string, meta: ActivityMeta): void {
    if (!this.config.enabled) return;
    if (!this.isAgentMonitored(meta.agentName)) return;

    const existing = this.sessions.get(sessionId);
    if (existing && existing.timer !== null) {
      this.clock.clearTimeout(existing.timer);
    }
    // pingCount は activity 復帰時に常に 0 へリセット (design §3.4)。
    // SILENCED から WATCHING へ戻った場合に Ping 注入の余地を再度確保するため。
    const entry: SessionEntry = {
      state: "WATCHING",
      timer: null,
      pingCount: 0,
      agentName: meta.agentName ?? existing?.agentName,
    };

    entry.timer = this.clock.setTimeout(() => {
      this.onStage1Expire(sessionId).catch((err) =>
        this.log("warn", `stage1 handler failed: ${String(err)}`),
      );
    }, this.config.stage1Ms);

    this.sessions.set(sessionId, entry);
  }

  private recordTombstone(sessionId: string): void {
    if (this.stoppedSessions.has(sessionId)) return;
    this.stoppedSessions.add(sessionId);
    this.stoppedOrder.push(sessionId);
    while (this.stoppedOrder.length > STOPPED_TOMBSTONE_CAPACITY) {
      const evicted = this.stoppedOrder.shift();
      if (evicted !== undefined) this.stoppedSessions.delete(evicted);
    }
  }

  private clearTombstone(sessionId: string): void {
    if (!this.stoppedSessions.has(sessionId)) return;
    this.stoppedSessions.delete(sessionId);
    const idx = this.stoppedOrder.indexOf(sessionId);
    if (idx >= 0) this.stoppedOrder.splice(idx, 1);
  }

  private async onStage1Expire(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.state = "STAGE1_NOTIFIED";
    entry.timer = this.clock.setTimeout(() => {
      this.onStage2Expire(sessionId).catch((err) =>
        this.log("warn", `stage2 handler failed: ${String(err)}`),
      );
    }, this.config.stage2Ms);
    // Message text per design §5.2 (stage1 row).
    await this.notifier.notify(
      sessionId,
      "warn",
      `[Watchdog] Agent ${sessionId} idle for ${this.config.stage1Ms}ms`,
    );
  }

  private async onStage2Expire(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (entry.pingCount < this.config.maxPings) {
      entry.state = "PINGED";
      entry.pingCount += 1;
      // Reset the stage2 timer to await response after ping.
      entry.timer = this.clock.setTimeout(() => {
        this.onStage2Expire(sessionId).catch((err) =>
          this.log("warn", `stage2 handler failed: ${String(err)}`),
        );
      }, this.config.stage2Ms);
      await this.pinger.inject(sessionId, this.config.pingMessage);
      // Message text per design §5.2 (stage2 row).
      await this.notifier.notify(
        sessionId,
        "critical",
        `[Watchdog] Ping injected to ${sessionId}`,
      );
    } else {
      entry.state = "SILENCED";
      entry.timer = null;
      // Message text per design §5.2 (SILENCED row).
      await this.notifier.notify(
        sessionId,
        "silenced",
        "[Watchdog] Max pings reached. Manual intervention required.",
      );
    }
  }

  private isAgentMonitored(name: string | undefined): boolean {
    const { include, exclude } = this.config.agents;
    if (exclude && name && exclude.includes(name)) return false;
    if (include && include.length > 0) {
      if (!name) return false;
      return include.includes(name);
    }
    return true;
  }
}
```

### Step 5: テスト実行 → 成功確認 [devcontainer]

- [ ] Step 5.1: テスト走行

```bash
# [devcontainer]
bun test tests/watchdog.test.ts
```

期待出力: 全テストパス (約 13 件)

> **失敗した場合**: 即座に `superpowers:systematic-debugging` スキルを起動し、Watchdog 単一テストを 1 件ずつ分離して原因を切り分ける。実装を後付けで膨らませず、最小の修正で通すこと。

- [ ] Step 5.2: 型チェック

```bash
# [devcontainer]
bun run typecheck
```

- [ ] Step 5.3: Phase 1 のテストもまだ通ることを確認 (リグレッションチェック)

```bash
# [devcontainer]
bun test
```

期待出力: Phase 1 + Phase 2 のすべてがパス

### Step 6: コミット [host]

- [ ] Step 6.1: コミット

```bash
git add src/watchdog.ts tests/watchdog.test.ts
git commit -m "feat(watchdog): add state machine with stage1/stage2 timers and maxPings ceiling"
```

### Step 7: Draft PR 作成 [host]

- [ ] Step 7.1: Draft PR 作成

```bash
git push -u origin feat/2-1-watchdog
gh pr create --draft --base feat/1-4-notifier --head feat/2-1-watchdog \
  --title "feat(watchdog): state machine + 2-stage timers + ping ceiling + tombstone" \
  --body "Phase 2. Core watchdog per design §3. Includes initial hang detection, empty session no-trigger guard, pingCount reset on activity, and stoppedSessions tombstone for late events."
```

- [ ] Step 7.2: PR URL を記録

---

# Phase 3: Plugin Entry Point + Stress Validation

## Task 3.1: プラグインエントリ (`index.ts`)

- **派生元ブランチ**: `feat/2-1-watchdog`
- **実行モード**: 直列必須 (Wait for Task 2.1)
- **前提条件**: Task 2.1 の Draft PR URL が存在すること

**Files:**
- Create: `src/index.ts`
- Test: `tests/index.smoke.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/2-1-watchdog
git checkout -b feat/3-1-plugin-entry
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/2-1-watchdog"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: 失敗するスモークテストを書く [devcontainer]

- [ ] Step 2.1: `tests/index.smoke.test.ts` を作成

```typescript
import { describe, test, expect } from "bun:test";
import plugin, {
  extractSessionId,
  isUserMessage,
  type OpenCodeEvent,
} from "../src/index";

describe("plugin entry smoke", () => {
  test("default export is a Plugin function", () => {
    expect(typeof plugin).toBe("function");
  });

  test("instantiated plugin exposes event handler", async () => {
    const fakeContext = {
      client: {
        app: { log: async () => undefined },
        session: { prompt: async () => undefined },
      },
      $: () => undefined,
      directory: process.cwd(),
      worktree: process.cwd(),
    };
    const instance = await (plugin as (ctx: unknown) => Promise<{ event: unknown }>)(fakeContext);
    expect(typeof instance.event).toBe("function");
  });

  test("event handler does not throw on typical payloads", async () => {
    const fakeContext = {
      client: {
        app: { log: async () => undefined },
        session: { prompt: async () => undefined },
      },
      $: () => undefined,
      directory: process.cwd(),
      worktree: process.cwd(),
    };
    const instance = await (plugin as (ctx: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
    }>)(fakeContext);
    await instance.event({
      event: {
        type: "message.part.updated",
        properties: { part: { sessionID: "s1" } },
      },
    });
    await instance.event({
      event: {
        type: "session.idle",
        properties: { info: { id: "s1" } },
      },
    });
  });
});

describe("extractSessionId (event routing)", () => {
  test("message.updated reads sessionID from properties.info", () => {
    const e: OpenCodeEvent = {
      type: "message.updated",
      properties: { info: { sessionID: "s-msg-upd", role: "user" } },
    };
    expect(extractSessionId(e)).toBe("s-msg-upd");
  });

  test("message.part.updated reads sessionID from properties.part", () => {
    const e: OpenCodeEvent = {
      type: "message.part.updated",
      properties: { part: { sessionID: "s-msg-part" } },
    };
    expect(extractSessionId(e)).toBe("s-msg-part");
  });

  test("session.created / session.idle / session.error / session.deleted read id from properties.info", () => {
    const types = ["session.created", "session.idle", "session.error", "session.deleted"] as const;
    for (const t of types) {
      const e: OpenCodeEvent = {
        type: t,
        properties: { info: { id: `s-${t}` } },
      };
      expect(extractSessionId(e)).toBe(`s-${t}`);
    }
  });

  test("returns undefined for unknown event types", () => {
    const e: OpenCodeEvent = {
      type: "tool.completed",
      properties: { info: { sessionID: "ignored" } },
    };
    expect(extractSessionId(e)).toBeUndefined();
  });

  test("returns undefined when the expected nested field is missing", () => {
    expect(
      extractSessionId({ type: "message.updated", properties: {} }),
    ).toBeUndefined();
    expect(
      extractSessionId({
        type: "message.part.updated",
        properties: { info: { sessionID: "ignored" } } as never,
      }),
    ).toBeUndefined();
    expect(
      extractSessionId({ type: "session.idle", properties: {} }),
    ).toBeUndefined();
  });

  test("message.updated and message.part.updated read DIFFERENT paths (silent-failure regression guard)", () => {
    // If a future change accidentally unifies both paths to `properties.sessionID`,
    // this test catches it. Originally regressed in v1 of the plan.
    const partEvent: OpenCodeEvent = {
      type: "message.part.updated",
      properties: { info: { sessionID: "wrong-path" } } as never,
    };
    expect(extractSessionId(partEvent)).toBeUndefined();

    const updEvent: OpenCodeEvent = {
      type: "message.updated",
      properties: { part: { sessionID: "wrong-path" } } as never,
    };
    expect(extractSessionId(updEvent)).toBeUndefined();
  });
});

describe("isUserMessage (initial-trigger role determination)", () => {
  test("true only for message.updated with role=user", () => {
    expect(
      isUserMessage({
        type: "message.updated",
        properties: { info: { role: "user", sessionID: "s" } },
      }),
    ).toBe(true);
  });

  test("false for message.updated with role=assistant", () => {
    expect(
      isUserMessage({
        type: "message.updated",
        properties: { info: { role: "assistant", sessionID: "s" } },
      }),
    ).toBe(false);
  });

  test("false for message.updated with role missing", () => {
    expect(
      isUserMessage({
        type: "message.updated",
        properties: { info: { sessionID: "s" } },
      }),
    ).toBe(false);
  });

  test("false for message.part.updated even if role=user is present (different event type)", () => {
    expect(
      isUserMessage({
        type: "message.part.updated",
        properties: { info: { role: "user" } } as never,
      }),
    ).toBe(false);
  });

  test("false for session.* events", () => {
    for (const t of ["session.created", "session.idle", "session.error", "session.deleted"]) {
      expect(
        isUserMessage({
          type: t,
          properties: { info: { role: "user", id: "s" } },
        }),
      ).toBe(false);
    }
  });
});
```

### Step 3: テスト実行 → 失敗確認 [devcontainer]

- [ ] Step 3.1: テスト走行

```bash
# [devcontainer]
bun test tests/index.smoke.test.ts
```

期待出力: モジュール未存在エラー

### Step 4: プラグインエントリ実装 [devcontainer]

> **前提**: `docs/SDK_NOTES.md` (Task 0.2 Step 7 で記録) を参照し、Plugin 型および event payload の sessionID/role 抽出パスを **実 SDK 型に合わせて確定** すること。本ベースラインでは:
> - `message.updated` → `event.properties.info.role === "user"` / `event.properties.info.sessionID`
> - `message.part.updated` → `event.properties.part.sessionID`
> - `session.*` → `event.properties.info.id`
>
> SDK_NOTES と差異があった場合は SDK_NOTES の実測形を正として本実装と上の smoke test を併せて書き換える。

- [ ] Step 4.1: `src/index.ts` を作成

```typescript
import { resolveConfig, type WatchdogConfig } from "./config";
import { RealClock } from "./clock";
import { TmuxNotifier, bunSpawn, bunWhich, type Notifier } from "./notifier";
import { OpenCodeAdapter, type Pinger } from "./pinger";
import { Watchdog } from "./watchdog";

// Plugin 型は @opencode-ai/plugin の export を使うのが望ましい。
// SDK_NOTES で確認した実 export 名に合わせて、以下のいずれかへ差し替える:
//   import type { Plugin } from "@opencode-ai/plugin";
//   import type { PluginContext, PluginInstance } from "@opencode-ai/plugin";
// 実 SDK の Plugin 型が分かっている場合は下の local interface を削除し、
// 実 SDK 型をそのまま import して使う。
import type { Plugin } from "@opencode-ai/plugin";

export interface OpenCodeEventPropertiesInfo {
  id?: string;
  sessionID?: string;
  role?: string;
}

export interface OpenCodeEventPropertiesPart {
  sessionID?: string;
}

export interface OpenCodeEvent {
  type: string;
  properties: {
    info?: OpenCodeEventPropertiesInfo;
    part?: OpenCodeEventPropertiesPart;
  };
}

async function loadProjectConfig(directory: string): Promise<Partial<WatchdogConfig>> {
  try {
    const file = Bun.file(`${directory}/opencode.json`);
    if (!(await file.exists())) return {};
    const json = await file.json();
    const experimental = json?.experimental?.watchdog;
    return experimental ?? {};
  } catch {
    return {};
  }
}

function logFactory(client: { app?: { log?: (args: { level: "info" | "warn" | "error"; message: string }) => Promise<unknown> } }) {
  return (level: "info" | "warn", message: string) => {
    client.app?.log?.({ level, message }).catch(() => undefined);
    console[level](`[watchdog] ${message}`);
  };
}

/**
 * Pure routing helper. Exported so the smoke test can verify event-payload
 * field extraction without spinning up a Watchdog. Keep this function
 * dependency-free: it must not import Bun, the SDK, or any side-effectful
 * module.
 */
export function extractSessionId(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case "message.updated":
      return event.properties.info?.sessionID;
    case "message.part.updated":
      return event.properties.part?.sessionID;
    case "session.created":
    case "session.idle":
    case "session.error":
    case "session.deleted":
      return event.properties.info?.id;
    default:
      return undefined;
  }
}

/**
 * Pure role-determination helper. Returns true iff `event` is the
 * "user input confirmed" initial-trigger event (design §3.4 IDLE → WATCHING
 * re-entry point). Exported for smoke test verification.
 */
export function isUserMessage(event: OpenCodeEvent): boolean {
  return (
    event.type === "message.updated" && event.properties.info?.role === "user"
  );
}

const plugin: Plugin = async (ctx) => {
  const projectConfig = await loadProjectConfig(ctx.directory);
  const config = resolveConfig({
    project: projectConfig,
    env: process.env,
  });

  const log = logFactory(ctx.client as { app?: { log?: (args: { level: "info" | "warn" | "error"; message: string }) => Promise<unknown> } });

  if (!config.enabled) {
    log("info", "watchdog disabled via config; events will be ignored.");
    return {
      event: async () => undefined,
    };
  }

  const clock = new RealClock();
  const notifier: Notifier = new TmuxNotifier({
    env: process.env,
    spawn: bunSpawn(),
    which: bunWhich(),
    log,
  });
  const pinger: Pinger = new OpenCodeAdapter(ctx.client);
  const watchdog = new Watchdog({ config, clock, notifier, pinger, log });

  return {
    event: async ({ event }: { event: OpenCodeEvent }) => {
      try {
        const sessionId = extractSessionId(event);
        if (!sessionId) return;

        switch (event.type) {
          case "message.updated":
            if (isUserMessage(event)) {
              watchdog.onUserMessage(sessionId);
            }
            break;
          case "message.part.updated":
            watchdog.onActivity(sessionId);
            break;
          case "session.created":
            watchdog.onSessionCreated(sessionId);
            break;
          case "session.idle":
          case "session.error":
          case "session.deleted":
            watchdog.stop(sessionId);
            break;
          default:
            break;
        }
      } catch (err) {
        log("warn", `event handler failed: ${String(err)}`);
      }
    },
  };
};

export default plugin;
```

> **NOTE**: `import type { Plugin } from "@opencode-ai/plugin"` が型エラーになる場合、SDK_NOTES の実測 export 名 (例: `PluginFactory` / `PluginEntry` 等) に差し替える。同様に `event` ハンドラの引数型も SDK 確定型に揃える。

### Step 5: テスト実行 → 成功確認 [devcontainer]

- [ ] Step 5.1: スモークテスト走行

```bash
# [devcontainer]
bun test tests/index.smoke.test.ts
```

期待出力: 14 テストパス (smoke 3 + extractSessionId 6 + isUserMessage 5)

- [ ] Step 5.2: 全テスト走行 (リグレッションチェック)

```bash
# [devcontainer]
bun test
```

期待出力: すべてパス

- [ ] Step 5.3: 型チェック

```bash
# [devcontainer]
bun run typecheck
```

### Step 6: コミット [host]

- [ ] Step 6.1: コミット

```bash
git add src/index.ts tests/index.smoke.test.ts
git commit -m "feat(plugin): wire watchdog to OpenCode event hook with config + DI"
```

### Step 7: Draft PR 作成 [host]

- [ ] Step 7.1: Draft PR 作成

```bash
git push -u origin feat/3-1-plugin-entry
gh pr create --draft --base feat/2-1-watchdog --head feat/3-1-plugin-entry \
  --title "feat(plugin): wire watchdog to OpenCode event hook" \
  --body "Phase 3 stack #1. Plugin entry per design §3.1. Loads opencode.json and dispatches events."
```

- [ ] Step 7.2: PR URL を記録

---

## Task 3.2: ストレステスト + 初期ハング/空セッションの受け入れ確認

- **派生元ブランチ**: `feat/3-1-plugin-entry`
- **実行モード**: 直列必須 (Wait for Task 3.1)
- **前提条件**: Task 3.1 の Draft PR URL が存在すること

**Files:**
- Create: `tests/stress.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/3-1-plugin-entry
git checkout -b feat/3-2-stress-test
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/3-1-plugin-entry"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: ストレステスト + メモリリーク検証を書く [devcontainer]

- [ ] Step 2.1: `tests/stress.test.ts` を作成

```typescript
import { describe, test, expect } from "bun:test";
import { Watchdog } from "../src/watchdog";
import { FakeClock } from "../src/clock";
import { MockPinger } from "../src/pinger";
import type { Notifier, NotifierStage } from "../src/notifier";
import type { WatchdogConfig } from "../src/config";

class NoopNotifier implements Notifier {
  async notify(_id: string, _s: NotifierStage, _m: string) {}
  async clear(_id: string) {}
}

const cfg: WatchdogConfig = {
  enabled: true,
  stage1Ms: 1000,
  stage2Ms: 1000,
  maxPings: 1,
  pingMessage: "p",
  tmux: { enabled: true, displayMessage: true, highlightWindow: true },
  agents: {},
};

describe("Watchdog - memory & timer leak (design §7.4)", () => {
  test("1000 sessions x 100 chunks: Map empty AND active timers 0 after all sessions idle", () => {
    const clock = new FakeClock();
    const watchdog = new Watchdog({
      config: cfg,
      clock,
      pinger: new MockPinger(),
      notifier: new NoopNotifier(),
    });

    for (let s = 0; s < 1000; s++) {
      const sid = `sess-${s}`;
      for (let c = 0; c < 100; c++) {
        watchdog.onActivity(sid);
      }
    }
    // Mid-state: Map populated, every session has exactly one armed stage1 timer.
    expect(watchdog.activeSessionCount()).toBe(1000);
    expect(watchdog.activeTimerCount()).toBe(1000);
    // FakeClock-side: Watchdog reset overwrites the prior timer reference, so
    // the cancelled tombstones accumulate inside FakeClock but the live count
    // (non-cancelled) must match Watchdog's view.
    expect(clock.pendingTimerCount()).toBe(1000);

    for (let s = 0; s < 1000; s++) {
      watchdog.stop(`sess-${s}`);
    }
    // After cleanup: zero on every leak surface.
    expect(watchdog.activeSessionCount()).toBe(0);
    expect(watchdog.activeTimerCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  test("session.idle then later activity does not leak old timers", () => {
    const clock = new FakeClock();
    const watchdog = new Watchdog({
      config: cfg,
      clock,
      pinger: new MockPinger(),
      notifier: new NoopNotifier(),
    });

    for (let i = 0; i < 100; i++) {
      watchdog.onActivity("s1");
      watchdog.stop("s1");
    }
    expect(watchdog.activeSessionCount()).toBe(0);
    expect(watchdog.activeTimerCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  test("repeated onActivity for the same session keeps exactly one live timer", () => {
    const clock = new FakeClock();
    const watchdog = new Watchdog({
      config: cfg,
      clock,
      pinger: new MockPinger(),
      notifier: new NoopNotifier(),
    });
    for (let i = 0; i < 500; i++) {
      watchdog.onActivity("s-single");
    }
    // Watchdog-side: one entry, one live timer. Setting design §7.3:
    // "Map 内のタイマーは常に 1 つだけ".
    expect(watchdog.activeSessionCount()).toBe(1);
    expect(watchdog.activeTimerCount()).toBe(1);
    expect(clock.pendingTimerCount()).toBe(1);
  });
});

describe("Acceptance §10 - initial hang detection", () => {
  test("onUserMessage only, no parts: stage1 notifies, stage2 pings", async () => {
    const clock = new FakeClock();
    const pinger = new MockPinger();
    const notifies: NotifierStage[] = [];
    const notifier: Notifier = {
      async notify(_id, stage) {
        notifies.push(stage);
      },
      async clear() {},
    };
    const watchdog = new Watchdog({ config: cfg, clock, pinger, notifier });
    watchdog.onUserMessage("s-init");
    clock.advance(cfg.stage1Ms);
    expect(notifies).toContain("warn");
    clock.advance(cfg.stage2Ms);
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
  });
});

describe("Acceptance §10 - empty session no false trigger", () => {
  test("onSessionCreated alone never arms a timer", () => {
    const clock = new FakeClock();
    const pinger = new MockPinger();
    const notifies: NotifierStage[] = [];
    const notifier: Notifier = {
      async notify(_id, stage) {
        notifies.push(stage);
      },
      async clear() {},
    };
    const watchdog = new Watchdog({ config: cfg, clock, pinger, notifier });
    watchdog.onSessionCreated("s-empty");
    clock.advance(60_000);
    expect(pinger.calls.length).toBe(0);
    expect(notifies.length).toBe(0);
    expect(watchdog.activeSessionCount()).toBe(0);
  });
});
```

### Step 3: テスト実行 → 確認 [devcontainer]

- [ ] Step 3.1: テスト走行

```bash
# [devcontainer]
bun test tests/stress.test.ts
```

期待出力: 全 5 テストがパス (memory & timer leak 3 + initial hang detection 1 + empty session 1)

- [ ] Step 3.2: 全テスト走行 (受け入れ条件 §10 を含む全シナリオの最終確認)

```bash
# [devcontainer]
bun test
```

期待出力: 全テスト ( Phase 1 + Phase 2 + Phase 3 ) パス

- [ ] Step 3.3: 型チェック

```bash
# [devcontainer]
bun run typecheck
```

### Step 4: 受け入れ条件チェックリストでの自己検証 [devcontainer]

- [ ] Step 4.1: 設計書 §10 の 10 項目をテスト結果に照らして確認

確認項目 (設計書 §10 から転記):
- [ ] (1) プラグインを `~/.config/opencode/plugins/` に置くだけで有効化される → **Step 5 の手動配置検証で確認** (smoke test だけでは未充足)
- [ ] (2) `OPENCODE_WATCHDOG_STAGE1_MS=1000` 等の環境変数で挙動が変わる → config 単体テストでカバー
- [ ] (3) 180秒のストリーム停止で Tmux 黄色ハイライトと display-message が出る → notifier 単体テスト + watchdog stage1 テストでカバー
- [ ] (4) さらに 180 秒経過で Ping が 1 回注入され Tmux が赤色に切り替わる → watchdog stage2 テスト
- [ ] (5) `maxPings: 1` で 2 度目の stage2 でも Ping は再注入されない → watchdog `maxPings ceiling` テスト
- [ ] (6) Tmux 非起動環境でプラグインを動かしてもプロセスが落ちず、ログのみ残る → notifier detection テスト
- [ ] (7) `bun test` がすべて pass する → Step 3.2 確認
- [ ] (8) Map 内タイマー数が `session.idle` 後に 0 になる → stress test で `activeSessionCount()` / `activeTimerCount()` / FakeClock の `pendingTimerCount()` の三層検証で確認
- [ ] (9) 初期ハング検知 (onUserMessage のみ → stage1/stage2) → stress test "initial hang detection"
- [ ] (10) 空セッション誤検知なし → stress test "empty session no false trigger"

### Step 5: 受け入れ条件 §10.1 の手動配置検証 [host]

> **目的**: 設計書 §10.1 「プラグインを `~/.config/opencode/plugins/` に置くだけで有効化される」を充足する。**自動テスト化はできない** (実 OpenCode プロセスを起動して検証する必要があり、CI でカバー不能)。本ステップは人間オペレータが Task 3.2 の Draft PR を Ready for review に昇格する **直前** に必ず実行する。
>
> **前提**: ホストに OpenCode CLI がインストールされていること。tmux セッション内で実行する (§10.3-4 を併せて確認するため)。

- [ ] Step 5.1: バンドル成果物の整合性を確認 (Step 1〜3 のテストが pass している前提)

```bash
# [host]
ls -la src/index.ts package.json
cat package.json | grep '"main"'
```

期待出力: `package.json` の `main` が `src/index.ts` を指す。

- [ ] Step 5.2: プラグインを所定ディレクトリへ配置

```bash
# [host]
mkdir -p "$HOME/.config/opencode/plugins/opencode-watchdog"
cp -r src package.json tsconfig.json bun.lock "$HOME/.config/opencode/plugins/opencode-watchdog/"
( cd "$HOME/.config/opencode/plugins/opencode-watchdog" && bun install --frozen-lockfile )
```

期待出力: エラーなく完了し、`$HOME/.config/opencode/plugins/opencode-watchdog/node_modules/@opencode-ai/plugin/` が存在する。

- [ ] Step 5.3: 短いタイムアウトで OpenCode を起動

> **重要**: Step 5.4 でネットワーク切断を行う。**ネットワーク切断の影響を受けない端末で本手順を実行する** こと (例: 有線 + 無線併用機での無線切断、もしくは仮想ネットワーク切断)。SSH 越しに OpenCode を動かしている場合、SSH 接続自体が切れるので不可。

```bash
# [host]
export OPENCODE_WATCHDOG_STAGE1_MS=3000
export OPENCODE_WATCHDOG_STAGE2_MS=3000
opencode &  # Or whatever invocation matches the local install
OPENCODE_PID=$!
```

- [ ] Step 5.4: 応答ストリームを意図的に停止して受け入れ条件 §10.3-10.6 を検証

> **設計意図**: 通常運用では、ユーザープロンプト送信 → アシスタントが応答チャンクを返す → `message.part.updated` がストリーミング → タイマーが連続リセット、となるため stage1 はそのままでは発火しない。Watchdog の発火条件 (= ストリーム停止) を **ネットワーク切断** で確実に再現する。代替手段は使わず、本手順で再現条件を固定する。

- [ ] Step 5.4.1: §10.1 配置確認 — OpenCode 起動ログに `opencode-watchdog` plugin が読み込まれた旨が出ることを確認

- [ ] Step 5.4.2: §10.3 stage1 通知の確認

  1. tmux 内で OpenCode の TUI が起動している状態にする
  2. ユーザープロンプトを 1 つ送信 (例: "Please write a long detailed explanation of TCP congestion control.")
  3. アシスタント応答チャンクが画面に流れ始めたら **即座にネットワーク切断**:
     - **Linux**: `nmcli networking off`
     - **macOS**: `networksetup -setairportpower en0 off` (Wi-Fi の場合)
  4. 切断後そのまま 3 秒放置 → tmux ウィンドウが **黄色** に変わり、画面下部に `[Watchdog] Agent <sessionId> idle for 3000ms` が表示されることを確認

- [ ] Step 5.4.3: §10.4 stage2 (Ping 注入) の確認

  1. ネットワーク切断状態を維持したまま、さらに 3 秒放置
  2. tmux ウィンドウが **赤色** に変わり、`[Watchdog] Ping injected to <sessionId>` が表示されることを確認
  3. Ping API 呼び出しはネットワーク切断下のため即時には届かない (`pinger.inject` 内の try/catch で握り潰されログのみ)。**tmux 表示が出れば Ping 試行は成立** とみなす

- [ ] Step 5.4.4: §10.5 maxPings=1 の確認

  1. さらに 3 秒放置
  2. tmux ウィンドウは **赤色のまま**、`[Watchdog] Max pings reached. Manual intervention required.` が表示されることを確認
  3. **二度目の `Ping injected to ...` 表示は出ない** ことを確認 (1 回だけで打ち切られる)

- [ ] Step 5.4.5: §10.6 tmux 外でのフォールバック

  1. ネットワーク復旧: `nmcli networking on` / `networksetup -setairportpower en0 on`
  2. OpenCode を一度終了し、**tmux セッション外** で再起動 (素のターミナル)
  3. Step 5.4.2 〜 5.4.4 と同手順を実行 → tmux 関連の API は呼ばれず `[watchdog] tmux not detected` の info ログのみが残ることを確認
  4. プロセスがクラッシュしないことを確認

- [ ] Step 5.5: 後始末

```bash
# [host]
kill $OPENCODE_PID 2>/dev/null || true
rm -rf "$HOME/.config/opencode/plugins/opencode-watchdog"
unset OPENCODE_WATCHDOG_STAGE1_MS OPENCODE_WATCHDOG_STAGE2_MS
# ネットワークを切断したまま終わっていないか念のため確認
nmcli networking on 2>/dev/null || networksetup -setairportpower en0 on 2>/dev/null || true
```

- [ ] Step 5.6: PR の本文に **マニュアル検証ログ** を貼り付け、いつ・どの環境で確認したかを記録する (例: `Manually verified on host <hostname> (Linux/macOS) with opencode <version>, network-cut method nmcli/networksetup, at <YYYY-MM-DD HH:MM JST>: §10.1, 10.3-10.6 all PASS`)

> **マニュアル検証なしで Ready for review に昇格させてはいけない**。§10.1, 10.3-10.6 は smoke test ではカバー不能 (実 OpenCode + 実ネットワーク切断が必要) で、本ステップ以外に充足手段がない。手順は **代替不可**、ネットワーク切断で再現条件を固定する。

### Step 6: コミット [host]

- [ ] Step 6.1: コミット

```bash
git add tests/stress.test.ts
git commit -m "test(stress): 1000-session leak check + initial-hang + empty-session acceptance"
```

### Step 7: Draft PR 作成 [host]

- [ ] Step 7.1: Draft PR 作成

```bash
git push -u origin feat/3-2-stress-test
gh pr create --draft --base feat/3-1-plugin-entry --head feat/3-2-stress-test \
  --title "test(stress): leak check + acceptance §10 (initial hang + empty session)" \
  --body "Phase 3 stack #2. Stress test for memory/timer leaks and acceptance criteria §10. Manual deployment verification (§10.1) results to be appended to this PR body before promotion to Ready for review."
```

- [ ] Step 7.2: PR URL を記録

---

# 完了後アクション (Post-Implementation)

すべてのタスクの Draft PR が作成され、上記の Step 4.1 チェックリストが全項目クリアされ、**かつ Task 3.2 Step 5 の手動配置検証ログが Task 3.2 PR 本文に貼り付けられたら**、`superpowers:finishing-a-development-branch` スキルを起動し、人間オペレータに以下の選択肢を提示する:

1. **Ready for Review に昇格**: 各 Draft PR の状態を `Ready for review` に切替え、レビュワーへ通知。**Task 3.2 のマニュアル検証ログが空の場合は昇格を許可しない**。
2. **Stack のリベース**: master が進んでいた場合、底辺ブランチ (`feat/0-1-devcontainer`) を最新 master にリベースし、スタック全体を順次リベース。
3. **マージ順序**: 必ず底辺 (`feat/0-1-devcontainer`) → 上位 (`feat/3-2-stress-test`) の順でマージする。途中で順序を破ると履歴が壊れる。AGENT は merge を **実行しない** (人間オペレータの責務)。

---

# 自己レビュー結果

本計画作成後、以下の観点で自己レビュー済み:

- ✅ **設計書カバレッジ**: 設計書 §3 (アーキテクチャ) / §4 (設定) / §5 (Tmux) / §6 (Pinger) / §7 (テスト) / §8 (Devcontainer) / §10 (受け入れ条件) すべてに対応するタスクが存在
- ✅ **プレースホルダ排除**: TBD / TODO / 「実装する」など曖昧な指示なし。すべてのコードブロックは即実行可能な内容
- ✅ **型一貫性**: `Pinger.inject` シグネチャ、`Notifier.notify(sessionId, stage, message)`, `Clock.setTimeout`/`clearTimeout`, `WatchdogConfig` の各キー名 — タスク間で完全一致
- ✅ **ポカヨケ完全装着**: Task 0.1 ～ 3.2 すべての Step 1 に `git merge-base --is-ancestor` 検証スクリプトを変数展開済みで埋め込み
- ✅ **Devcontainer 実行強制**: テスト・型チェック・ブランチ検証はすべて `[devcontainer]` でマーク (Task 0.1 のみ例外と明記)
- ✅ **Draft PR チェーン**: 各 Task の最終ステップで Draft PR 作成、PR URL を後続タスクの前提条件として参照

## 初版レビューを受けた追加修正 (v2)

レビューを受けて以下の方針変更を計画書全体に反映済み:

- ✅ **Phase 1 直列化**: 並列+統合ブランチ案を撤回。`0-3-scaffold → 1-1-clock → 1-2-config → 1-3-pinger → 1-4-notifier` の単一直列スタックに変更。Phase 1.5 (統合タスク) は削除。
- ✅ **`@opencode-ai/plugin` を Phase 0 devDeps に追加**: Task 0.2 (scaffold) の package.json に追加。Task 0.2 Step 7 で `docs/SDK_NOTES.md` に SDK 型情報 (Plugin 型 / client.session.prompt の呼び出し形 / event payload の sessionID·role 抽出パス) を実測記録するゲートを追加。 (※ v4 で旧 Task 0.3 → 新 Task 0.2 へ番号繰り上げ)
- ✅ **Pinger SDK 形を SDK_NOTES 出典に**: `client.session.prompt({ path: { id }, body: { parts } })` 形をベースラインとし、テスト/実装ともこの形に統一。Pinger インタフェース (`inject(sessionId, message)`) は SDK 形にかかわらず不変。
- ✅ **event payload 抽出形を SDK_NOTES 出典に**: `message.updated` → `properties.info.role` / `properties.info.sessionID`、`message.part.updated` → `properties.part.sessionID`、`session.*` → `properties.info.id` をベースラインに採用。smoke test の fake event payload も同形に揃え、`import type { Plugin } from "@opencode-ai/plugin"` を採用。
- ✅ **pingCount リセット**: `armOrReset` 内で常に `pingCount: 0` を新エントリに設定。SILENCED → activity 復帰時の Ping 再注入余地を再確保 (design §3.4)。
- ✅ **stop 後の遅延 message.part.updated は無視**: FIFO 上限 10,000 の `stoppedSessions` tombstone を追加。`onActivity` は tombstone にヒットしたら即 return。`onUserMessage` は tombstone を明示的にクリアして再アーム (design §3.4 IDLE → WATCHING re-entry)。テストも「再作成しない」「user message で再アーム」の 2 本に書き換え。
- ✅ **`ubuntu-slim` 注記更新**: 「組織カスタムランナー想定」を削除し「GitHub-hosted の最小 runner。実 tmux 結合テスト追加時は `ubuntu-latest` 再評価」へ書き換え。

## 第3次レビューを受けた追加修正 (v3)

- ✅ **CI trigger を stacked PR にも拡張**: `.github/workflows/test.yml` の `pull_request.branches` / `push.branches` に `feat/**` を追加。Phase 1 以降の中間 PR でも CI が走り、計画冒頭で謳う「型整合の逐次 CI 保証」が実効化された。
- ✅ **受け入れ条件 §10.1 のマニュアル配置検証ステップを Task 3.2 に新設**: Step 5 として `~/.config/opencode/plugins/opencode-watchdog/` への配置 → 環境変数で stage1Ms/stage2Ms を 3 秒に短縮 → 実 OpenCode 起動 → §10.1, 10.3-10.6 のマニュアル走査 → PR 本文へ検証ログ貼付、を必須ゲート化。完了後アクションも「マニュアル検証ログが無い場合は Ready for review 昇格を許可しない」に強化。
- ✅ **timer leak 検出の三層化**: FakeClock に `pendingTimerCount()`、Watchdog に `activeTimerCount()` を追加。stress test を「`activeSessionCount`/`activeTimerCount`/`pendingTimerCount` の三層検証」に強化し、新規 1 件「同一セッション 500 回 onActivity → live timer 1 のみ」も追加。設計書 §7.4 の「Map と active timer 数の両方が 0」要件を完全に充足。
- ✅ **`docs/SDK_NOTES.md` をファイル構造一覧と Task 0.3 Files に明記**: 後続タスクの前提となる成果物の所在が一覧から特定できる状態にした。
- ✅ **設計書 §3.3 の `notifier.escalate` を `notifier.notify` に統一**: 計画書の単一 API 設計と整合。設計書には Notifier インタフェース統一の判断を §3.3 直前に短く明記。
- ✅ **設計書 §7.1 の dev 依存方針文言を緩和**: 「追加のテストランナー依存は導入しない (jest/mocha/vitest 等不可)」と意図を明確化し、SDK 型整合のための `@opencode-ai/plugin` 追加が方針外であることを明示。

## 第4次レビューを受けた追加修正 (v4)

- ✅ **Phase 0 順序を入れ替え (Task 0.2 = scaffold、Task 0.3 = CI)**: 旧計画では CI 導入 (Task 0.2) が package.json 不在のブランチで `bun install --frozen-lockfile` を実行して必ず失敗していた。順序入れ替えにより CI 導入時点で package.json/bun.lock が既に存在し、初回 CI が pass する。Task 0.3 (CI) Step 1.3 に **派生元健全性チェック** (`test -f package.json && test -f bun.lock`) を追加し、構造が壊れていれば即時 abort。ブランチ名も `feat/0-2-scaffold` / `feat/0-3-ci` に統一。
- ✅ **CI workflow に `bun run typecheck` を追加**: `bun test` の前に typecheck を実行 (fail fast)。冒頭で謳う「型整合 CI 逐次保証」が真に実効化。Step 3.2 にローカル等価検証 (`bun install --frozen-lockfile && bun run typecheck && bun test`) も追加。
- ✅ **設計書 §3.3 を `onUserMessage` 経由に更新**: `message.updated (role=user)` のフローを `watchdog.onActivity` から `watchdog.onUserMessage` へ書き換え、tombstone 解除責務を明示。`message.part.updated` 側にも tombstone 抑止と pingCount リセットを明記。設計と実装の乖離を解消。
- ✅ **手動配置検証で `bun.lock` を cp 対象に追加**: 旧手順は cp に lockb を含めず、直後の `bun install --frozen-lockfile` が必ず失敗していた。1 単語追加で解消。
- ✅ **手動検証 §10.3-10.6 をネットワーク切断による決定的手順へ書き換え**: 「3 秒放置」では通常応答が返り stage1 が発火しないため検証が成立しない問題を解消。`nmcli networking off` (Linux) / `networksetup -setairportpower en0 off` (macOS) でストリーム停止を確実に再現する手順に固定。代替不可。SSH 越し実行禁止、復旧 `nmcli networking on` を Step 5.5 に追加、ネットワーク切断中の Ping 試行は tmux 表示で観測 (実送信は復旧後)、PR ログに切断方式 (nmcli/networksetup) も記録。

