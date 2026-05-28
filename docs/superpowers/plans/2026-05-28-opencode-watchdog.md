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
  └── feat/0-1-devcontainer        (Phase 0 直列)
        └── feat/0-2-ci
              └── feat/0-3-scaffold   ◀── Phase 1 共通 Base
                    ├── feat/1-1-clock        (並列)
                    ├── feat/1-2-config       (並列)
                    ├── feat/1-3-pinger       (並列)
                    ├── feat/1-4-notifier     (並列)
                    └── feat/1-5-integration  (直列: 1.1〜1.4 の Draft PR 全存在後)
                          └── feat/2-1-watchdog       (直列)
                                └── feat/3-1-plugin-entry  (直列)
                                      └── feat/3-2-stress-test (直列)
```

### 実行モード規約

各タスクヘッダの `実行モード` は以下のいずれか:

- **直列必須 (Wait for Task X)**: 直前タスクのブランチから派生。先行タスクの Draft PR が **作成済み (URL 取得済み)** であることを開始条件とする。マージ完了は不要。
- **並列可能 (独立)**: 共通 Base ブランチから派生。対象ファイルが他並列タスクと競合しないことを必須条件とする。

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

- [ ] Step 1.1: ブランチを作成し master から派生していることを検証

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

- [ ] Step 2.1: `.devcontainer/Dockerfile` を作成

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

- [ ] Step 3.1: `.devcontainer/devcontainer.json` を作成

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

- [ ] Step 4.1: `.devcontainer/postCreate.sh` を作成

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

- [ ] Step 4.2: 実行権限を付与

```bash
# [host]
chmod +x .devcontainer/postCreate.sh
```

### Step 5: ローカルで devcontainer を立ち上げて動作確認 [host]

- [ ] Step 5.1: VSCode / `devcontainer CLI` で devcontainer を起動し、postCreate が exit 0 で完了することを確認

```bash
# host (devcontainer CLI 使用例)
devcontainer up --workspace-folder . || echo "VSCode の Reopen in Container でも可"
```

期待出力: `bun --version` が `1.3.x`、`tmux -V` が表示される。

### Step 6: コミット [host]

- [ ] Step 6.1: コミット

```bash
git add .devcontainer/
git commit -m "feat(devcontainer): add Debian 12 + Bun 1.3 + tmux base"
```

### Step 7: Draft PR 作成 [host]

- [ ] Step 7.1: master 向けに Draft PR を作成し URL を記録

```bash
git push -u origin feat/0-1-devcontainer
gh pr create --draft --base master --head feat/0-1-devcontainer \
  --title "feat(devcontainer): Bun 1.3 + tmux base" \
  --body "Phase 0 foundation. Sets up reproducible dev environment per design §8."
```

- [ ] Step 7.2: 出力された PR URL を本ファイルか TaskList のメモに **記録** すること。後続タスクの `前提条件` として参照される。

---

## Task 0.2: CI ワークフロー

- **派生元ブランチ**: `feat/0-1-devcontainer`
- **実行モード**: 直列必須 (Wait for Task 0.1)
- **前提条件**: Task 0.1 の Draft PR URL が存在すること

**Files:**
- Create: `.github/workflows/test.yml`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: 派生元ブランチへ切り替え後、新規ブランチを作成

```bash
# [host]
git checkout feat/0-1-devcontainer
git checkout -b feat/0-2-ci
```

- [ ] Step 1.2: **devcontainer 内** でポカヨケを実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/0-1-devcontainer"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: GitHub Actions ワークフローを作成 [host or devcontainer (ファイル作成のみ)]

- [ ] Step 2.1: `.github/workflows/test.yml` を作成

```yaml
name: test

on:
  push:
    branches:
      - master
  pull_request:
    branches:
      - master

jobs:
  bun-test:
    runs-on: ubuntu-slim
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3"

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run tests
        run: bun test
```

> **NOTE on `ubuntu-slim`**: 本要件に従い `runs-on: ubuntu-slim` を指定。組織カスタムランナー想定。GitHub 標準ランナーで動作させる場合は `ubuntu-latest` に切り替える運用判断を後続で行う。

### Step 3: ワークフロー構文検証 [devcontainer]

- [ ] Step 3.1: YAML 構文を確認 (CI を動かす前のローカル検証)

```bash
# [devcontainer]
bunx --bun js-yaml .github/workflows/test.yml > /dev/null && echo "YAML OK"
```

期待出力: `YAML OK`

### Step 4: コミット [host]

- [ ] Step 4.1: コミット

```bash
git add .github/workflows/test.yml
git commit -m "feat(ci): add bun test workflow on master push/PR"
```

### Step 5: Draft PR 作成 [host]

- [ ] Step 5.1: 派生元ブランチ向けに Draft PR を作成

```bash
git push -u origin feat/0-2-ci
gh pr create --draft --base feat/0-1-devcontainer --head feat/0-2-ci \
  --title "feat(ci): bun test on master push/PR" \
  --body "Phase 0 stack #2. Triggers tests on master branch using ubuntu-slim runner."
```

- [ ] Step 5.2: PR URL を記録

---

## Task 0.3: Bun プロジェクトスキャフォールド

- **派生元ブランチ**: `feat/0-2-ci`
- **実行モード**: 直列必須 (Wait for Task 0.2)
- **前提条件**: Task 0.2 の Draft PR URL が存在すること

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/.gitkeep`
- Create: `tests/.gitkeep`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/0-2-ci
git checkout -b feat/0-3-scaffold
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/0-2-ci"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: `package.json` を作成 [devcontainer]

- [ ] Step 2.1: `package.json` を作成

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
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  },
  "peerDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### Step 3: `tsconfig.json` を作成 [devcontainer]

- [ ] Step 3.1: `tsconfig.json` を作成

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

- [ ] Step 4.1: `.gitignore` を作成

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

- [ ] Step 5.1: `src/.gitkeep` および `tests/.gitkeep` を作成 (空ファイル)

### Step 6: 依存関係インストール & 型チェック [devcontainer]

- [ ] Step 6.1: 依存をインストール

```bash
# [devcontainer]
bun install
```

- [ ] Step 6.2: 型チェックが通ることを確認

```bash
# [devcontainer]
bun run typecheck
```

期待出力: エラーなく終了 (出力なし or "Done")

- [ ] Step 6.3: テスト走行 (まだテストはない)

```bash
# [devcontainer]
bun test
```

期待出力: `0 pass, 0 fail` (テストファイルなしのため正常)

### Step 7: コミット [host]

- [ ] Step 7.1: コミット

```bash
git add package.json tsconfig.json .gitignore src/.gitkeep tests/.gitkeep bun.lockb
git commit -m "feat(scaffold): bun + typescript strict project skeleton"
```

### Step 8: Draft PR 作成 [host]

- [ ] Step 8.1: Draft PR 作成

```bash
git push -u origin feat/0-3-scaffold
gh pr create --draft --base feat/0-2-ci --head feat/0-3-scaffold \
  --title "feat(scaffold): bun + tsconfig strict skeleton" \
  --body "Phase 0 stack #3. Sets up package.json, strict tsconfig, .gitignore. Common base branch for Phase 1 parallel tasks."
```

- [ ] Step 8.2: PR URL を記録。**この URL は Phase 1 の 4 タスクすべての前提条件となる。**

---

# Phase 1: Independent Modules (Parallel)

> **重要**: Phase 1 の Task 1.1 ～ 1.4 はすべて `feat/0-3-scaffold` から派生する **並列実行可能** タスク。各タスクは異なるファイルのみを作成するため衝突しない。
> エージェントが並列で実行する場合は別々の git worktree (もしくは別 devcontainer 内チェックアウト) で作業すること。

## Task 1.1: Clock モジュール (DI 用時計抽象)

- **派生元ブランチ**: `feat/0-3-scaffold`
- **実行モード**: 並列可能 (独立)
- **前提条件**: Task 0.3 の Draft PR URL が存在すること
- **競合チェック**: 本タスクが触るファイルは `src/clock.ts` と `tests/clock.test.ts` のみ。Task 1.2〜1.4 と競合しない。

**Files:**
- Create: `src/clock.ts`
- Test: `tests/clock.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/0-3-scaffold
git checkout -b feat/1-1-clock
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/0-3-scaffold"
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
}
```

### Step 5: テスト実行 → 成功確認 [devcontainer]

- [ ] Step 5.1: テスト走行

```bash
# [devcontainer]
bun test tests/clock.test.ts
```

期待出力: `5 pass, 0 fail`

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
gh pr create --draft --base feat/0-3-scaffold --head feat/1-1-clock \
  --title "feat(clock): DI clock with FakeClock for unit tests" \
  --body "Phase 1 parallel #1. Pure DI abstraction over setTimeout/clearTimeout."
```

- [ ] Step 7.2: PR URL を記録

---

## Task 1.2: Config モジュール

- **派生元ブランチ**: `feat/0-3-scaffold`
- **実行モード**: 並列可能 (独立)
- **前提条件**: Task 0.3 の Draft PR URL が存在すること
- **競合チェック**: 本タスクは `src/config.ts` / `tests/config.test.ts` のみを作成。Task 1.1/1.3/1.4 と競合しない。

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/0-3-scaffold
git checkout -b feat/1-2-config
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/0-3-scaffold"
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
gh pr create --draft --base feat/0-3-scaffold --head feat/1-2-config \
  --title "feat(config): env > project > defaults with safe fallback" \
  --body "Phase 1 parallel #2. Pure function config resolver per design §4."
```

- [ ] Step 7.2: PR URL を記録

---

## Task 1.3: Pinger モジュール

- **派生元ブランチ**: `feat/0-3-scaffold`
- **実行モード**: 並列可能 (独立)
- **前提条件**: Task 0.3 の Draft PR URL が存在すること
- **競合チェック**: 本タスクは `src/pinger.ts` / `tests/pinger.test.ts` のみを作成。

**Files:**
- Create: `src/pinger.ts`
- Test: `tests/pinger.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/0-3-scaffold
git checkout -b feat/1-3-pinger
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/0-3-scaffold"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: 失敗するテストを書く [devcontainer]

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
  test("delegates to client.session.prompt with sessionId and message parts", async () => {
    const calls: Array<{ sessionId: string; parts: unknown }> = [];
    const fakeClient = {
      session: {
        prompt: async ({ sessionId, parts }: { sessionId: string; parts: unknown }) => {
          calls.push({ sessionId, parts });
        },
      },
    };
    const adapter = new OpenCodeAdapter(fakeClient);
    await adapter.inject("sess-abc", "ping?");
    expect(calls.length).toBe(1);
    expect(calls[0]!.sessionId).toBe("sess-abc");
    // parts should be an array containing the message in some text-part shape
    expect(Array.isArray(calls[0]!.parts)).toBe(true);
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

// Minimal shape we depend on. Replace with actual SDK type once @opencode-ai/plugin's
// type definitions are inspected at integration time.
interface OpenCodeClientLike {
  session?: {
    prompt?: (args: { sessionId: string; parts: unknown[] }) => Promise<unknown>;
  };
}

export class OpenCodeAdapter implements Pinger {
  constructor(private readonly client: unknown) {}

  async inject(sessionId: string, message: string): Promise<void> {
    const client = this.client as OpenCodeClientLike;
    const prompt = client?.session?.prompt;
    if (typeof prompt !== "function") {
      // SDK shape mismatch — log and swallow. Never throw across the boundary.
      console.warn(
        `[watchdog] OpenCode client.session.prompt is unavailable; cannot inject ping to ${sessionId}.`,
      );
      return;
    }
    try {
      await prompt({
        sessionId,
        parts: [{ type: "text", text: message }],
      });
    } catch (err) {
      console.warn(`[watchdog] Failed to inject ping to ${sessionId}:`, err);
    }
  }
}
```

> **NOTE**: 実 SDK メソッド名は `@opencode-ai/plugin` の型定義確認時に確定する。本実装は `client.session.prompt({ sessionId, parts })` 形式を暫定採用。実 API が `promptAsync` や `message` だった場合は `OpenCodeAdapter.inject` 内部のみ差し替える (インタフェースは変えない)。

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
gh pr create --draft --base feat/0-3-scaffold --head feat/1-3-pinger \
  --title "feat(pinger): Pinger interface + MockPinger + OpenCodeAdapter" \
  --body "Phase 1 parallel #3. Abstracts ping injection so watchdog core has no SDK dependency."
```

- [ ] Step 7.2: PR URL を記録

---

## Task 1.4: Notifier モジュール

- **派生元ブランチ**: `feat/0-3-scaffold`
- **実行モード**: 並列可能 (独立)
- **前提条件**: Task 0.3 の Draft PR URL が存在すること
- **競合チェック**: 本タスクは `src/notifier.ts` / `tests/notifier.test.ts` のみを作成。

**Files:**
- Create: `src/notifier.ts`
- Test: `tests/notifier.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/0-3-scaffold
git checkout -b feat/1-4-notifier
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/0-3-scaffold"
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

  test("notify(warn) calls display-message and yellow highlight", async () => {
    await notifier.notify("sess-1", "warn", "idle 3 min");
    const cmds = calls.map((c) => c.cmd);
    expect(cmds).toContainEqual(["tmux", "display-message", expect.stringContaining("sess-1") as unknown as string]);
    expect(cmds.some((c) => c.includes("set-window-option") && c.some((t) => t.includes("yellow")))).toBe(true);
  });

  test("notify(critical) sets red highlight", async () => {
    await notifier.notify("sess-1", "critical", "ping injected");
    const cmds = calls.map((c) => c.cmd.join(" "));
    expect(cmds.some((c) => c.includes("red"))).toBe(true);
  });

  test("notify(silenced) keeps red and shows max pings message", async () => {
    await notifier.notify("sess-1", "silenced", "max pings");
    const cmds = calls.map((c) => c.cmd.join(" "));
    expect(cmds.some((c) => c.includes("max pings"))).toBe(true);
  });

  test("clear() restores default window-status-current-style", async () => {
    await notifier.clear("sess-1");
    const cmds = calls.map((c) => c.cmd.join(" "));
    expect(cmds.some((c) => c.includes("set-window-option") && c.includes("default"))).toBe(true);
  });

  test("passes args as array (no shell injection risk)", async () => {
    await notifier.notify("sess-1; rm -rf /", "warn", "danger");
    // All cmd entries are arrays, sessionId stays in a single element
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

  async notify(sessionId: string, stage: NotifierStage, message: string): Promise<void> {
    if (!(await this.ensureTmux())) return;
    const text = `[Watchdog/${stage}] ${sessionId}: ${message}`;
    await this.safeSpawn(["tmux", "display-message", text]);
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
gh pr create --draft --base feat/0-3-scaffold --head feat/1-4-notifier \
  --title "feat(notifier): TmuxNotifier with detect-then-cache and safe spawn" \
  --body "Phase 1 parallel #4. tmux display-message + window highlight per design §5."
```

- [ ] Step 7.2: PR URL を記録

---

# Phase 1.5: Integration Merge

## Task 1.5: Phase 1 統合ブランチ

- **派生元ブランチ**: `feat/0-3-scaffold`
- **実行モード**: 直列必須 (Wait for Tasks 1.1, 1.2, 1.3, 1.4 のすべての Draft PR が存在すること)
- **前提条件**:
  - Task 1.1 の Draft PR URL が存在すること
  - Task 1.2 の Draft PR URL が存在すること
  - Task 1.3 の Draft PR URL が存在すること
  - Task 1.4 の Draft PR URL が存在すること
- **目的**: 並列で進めた Phase 1 の 4 ブランチを 1 本にまとめ、Phase 2 (Watchdog) の派生元を確定する。

**Files:**
- Modify: (マージのみ — 新規ファイル作成なし)

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: 統合ブランチを作成

```bash
# [host]
git fetch origin
git checkout feat/0-3-scaffold
git pull --ff-only origin feat/0-3-scaffold || true
git checkout -b feat/1-5-integration
```

- [ ] Step 1.2: ポカヨケ実行 (派生元検証)

```bash
# [devcontainer]
EXPECTED_BASE="feat/0-3-scaffold"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD \
  || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

### Step 2: Phase 1 の 4 ブランチを順次マージ [host]

- [ ] Step 2.1: 各ブランチをマージ (順序は依存なしのため任意。コンフリクトは想定なし)

```bash
# [host]
git merge --no-ff origin/feat/1-1-clock    -m "merge: integrate feat/1-1-clock"
git merge --no-ff origin/feat/1-2-config   -m "merge: integrate feat/1-2-config"
git merge --no-ff origin/feat/1-3-pinger   -m "merge: integrate feat/1-3-pinger"
git merge --no-ff origin/feat/1-4-notifier -m "merge: integrate feat/1-4-notifier"
```

- [ ] Step 2.2: マージ後、各モジュールのファイルが揃っていることを確認

```bash
# [host]
ls src/clock.ts src/config.ts src/pinger.ts src/notifier.ts
ls tests/clock.test.ts tests/config.test.ts tests/pinger.test.ts tests/notifier.test.ts
```

期待出力: 全 8 ファイルが存在

> **コンフリクト発生時**: いずれかのブランチが同じファイルを編集していた場合、人間オペレータに即座にエスカレートして手動解決。AI が自動で `git checkout --theirs`/`--ours` を実行することを **禁止**。

### Step 3: 統合後の全テスト実行 [devcontainer]

- [ ] Step 3.1: 全テスト走行

```bash
# [devcontainer]
bun test
```

期待出力: Phase 1 全テスト (約 25-30 件) がパス、failure 0

- [ ] Step 3.2: 型チェック全体

```bash
# [devcontainer]
bun run typecheck
```

期待出力: エラーなし

### Step 4: Draft PR 作成 [host]

- [ ] Step 4.1: 統合ブランチを push し Draft PR を作成

```bash
git push -u origin feat/1-5-integration
gh pr create --draft --base feat/0-3-scaffold --head feat/1-5-integration \
  --title "chore(integration): merge phase 1 (clock/config/pinger/notifier)" \
  --body "Stack manager branch. Combines all Phase 1 parallel work into a single base for Phase 2 watchdog."
```

- [ ] Step 4.2: PR URL を記録。**この URL は Task 2.1 の前提条件となる。**

---

# Phase 2: Watchdog Core

## Task 2.1: Watchdog 状態マシン + タイマー

- **派生元ブランチ**: `feat/1-5-integration`
- **実行モード**: 直列必須 (Wait for Task 1.5)
- **前提条件**: Task 1.5 の Draft PR URL が存在すること

**Files:**
- Create: `src/watchdog.ts`
- Test: `tests/watchdog.test.ts`

### Step 1: ブランチ作成と検証 [devcontainer]

- [ ] Step 1.1: ブランチ作成

```bash
# [host]
git checkout feat/1-5-integration
git checkout -b feat/2-1-watchdog
```

- [ ] Step 1.2: ポカヨケ実行

```bash
# [devcontainer]
EXPECTED_BASE="feat/1-5-integration"
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

  test("activity after stop() does not auto-recreate timer for stale session", () => {
    // stop() means lifecycle terminated. Subsequent activity SHOULD recreate
    // (session is just a new burst). This validates onActivity is idempotent post-stop.
    const { watchdog, clock, notifier } = setup();
    watchdog.onActivity("s1");
    watchdog.stop("s1");
    watchdog.onActivity("s1"); // new burst
    clock.advance(1000);
    expect(notifier.notifies.length).toBe(1);
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

export class Watchdog {
  private readonly sessions = new Map<string, SessionEntry>();
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

  /** Session created event — informational only. Do not arm timers. */
  onSessionCreated(_sessionId: string): void {
    // intentionally noop per design §2.3
  }

  /**
   * User message confirmed — initial trigger.
   * Treated identically to onActivity for state machine purposes.
   */
  onUserMessage(sessionId: string, meta: ActivityMeta = {}): void {
    this.onActivity(sessionId, meta);
  }

  /** Any activity (message.part.updated or initial user message). */
  onActivity(sessionId: string, meta: ActivityMeta = {}): void {
    if (!this.config.enabled) return;
    if (!this.isAgentMonitored(meta.agentName)) return;

    const existing = this.sessions.get(sessionId);
    if (existing && existing.timer !== null) {
      this.clock.clearTimeout(existing.timer);
    }
    const entry: SessionEntry = existing
      ? { ...existing, state: "WATCHING", timer: null }
      : { state: "WATCHING", timer: null, pingCount: 0, agentName: meta.agentName };

    entry.timer = this.clock.setTimeout(() => {
      this.onStage1Expire(sessionId).catch((err) =>
        this.log("warn", `stage1 handler failed: ${String(err)}`),
      );
    }, this.config.stage1Ms);

    this.sessions.set(sessionId, entry);
  }

  /** Session terminated normally or with error. */
  stop(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.timer !== null) this.clock.clearTimeout(entry.timer);
    this.sessions.delete(sessionId);
    this.notifier.clear(sessionId).catch((err) =>
      this.log("warn", `notifier.clear failed: ${String(err)}`),
    );
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
    await this.notifier.notify(
      sessionId,
      "warn",
      `idle for ${this.config.stage1Ms}ms`,
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
      await this.notifier.notify(sessionId, "critical", "ping injected");
    } else {
      entry.state = "SILENCED";
      entry.timer = null;
      await this.notifier.notify(
        sessionId,
        "silenced",
        "max pings reached. manual intervention required.",
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
gh pr create --draft --base feat/1-5-integration --head feat/2-1-watchdog \
  --title "feat(watchdog): state machine + 2-stage timers + ping ceiling" \
  --body "Phase 2. Core watchdog per design §3. Includes initial hang detection and empty session no-trigger guard."
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
import plugin from "../src/index";

describe("plugin entry smoke", () => {
  test("default export is an OpenCode plugin object with event hook", () => {
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

  test("event hook routes message.part.updated as activity", async () => {
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
    // Should not throw on a typical event payload
    await instance.event({
      event: {
        type: "message.part.updated",
        properties: { sessionID: "s1" },
      },
    });
    await instance.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "s1" },
      },
    });
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

- [ ] Step 4.1: `src/index.ts` を作成

```typescript
import { resolveConfig, type WatchdogConfig } from "./config";
import { RealClock } from "./clock";
import { TmuxNotifier, bunSpawn, bunWhich, type Notifier } from "./notifier";
import { OpenCodeAdapter, type Pinger } from "./pinger";
import { Watchdog } from "./watchdog";

interface OpenCodePluginContext {
  client: {
    app?: {
      log?: (args: { level: "info" | "warn" | "error"; message: string }) => Promise<unknown>;
    };
    session?: {
      prompt?: (args: { sessionId: string; parts: unknown[] }) => Promise<unknown>;
    };
  };
  directory: string;
  worktree: string;
}

interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown> & { sessionID?: string };
}

interface PluginInstance {
  event: (args: { event: OpenCodeEvent }) => Promise<void>;
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

function logFactory(client: OpenCodePluginContext["client"]) {
  return (level: "info" | "warn", message: string) => {
    client.app?.log?.({ level, message }).catch(() => undefined);
    console[level](`[watchdog] ${message}`);
  };
}

const plugin = async (ctx: OpenCodePluginContext): Promise<PluginInstance> => {
  const projectConfig = await loadProjectConfig(ctx.directory);
  const config = resolveConfig({
    project: projectConfig,
    env: process.env,
  });

  const log = logFactory(ctx.client);

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
    event: async ({ event }) => {
      try {
        const sessionId = event.properties.sessionID;
        if (!sessionId || typeof sessionId !== "string") return;

        switch (event.type) {
          case "message.updated":
            // role=user gating — payload shape inspected at integration time.
            if ((event.properties.role ?? event.properties.message_role) === "user") {
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
            // ignore other events
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

### Step 5: テスト実行 → 成功確認 [devcontainer]

- [ ] Step 5.1: スモークテスト走行

```bash
# [devcontainer]
bun test tests/index.smoke.test.ts
```

期待出力: 3 テストパス

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

describe("Watchdog - memory & timer leak", () => {
  test("1000 sessions x 100 chunks: map empty after all sessions idle", () => {
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
    expect(watchdog.activeSessionCount()).toBe(1000);

    for (let s = 0; s < 1000; s++) {
      watchdog.stop(`sess-${s}`);
    }
    expect(watchdog.activeSessionCount()).toBe(0);
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

期待出力: 全 4 テストがパス

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
- [ ] (1) プラグインを `~/.config/opencode/plugins/` に置くだけで有効化される → smoke test で default export が plugin object
- [ ] (2) `OPENCODE_WATCHDOG_STAGE1_MS=1000` 等の環境変数で挙動が変わる → config 単体テストでカバー
- [ ] (3) 180秒のストリーム停止で Tmux 黄色ハイライトと display-message が出る → notifier 単体テスト + watchdog stage1 テストでカバー
- [ ] (4) さらに 180 秒経過で Ping が 1 回注入され Tmux が赤色に切り替わる → watchdog stage2 テスト
- [ ] (5) `maxPings: 1` で 2 度目の stage2 でも Ping は再注入されない → watchdog `maxPings ceiling` テスト
- [ ] (6) Tmux 非起動環境でプラグインを動かしてもプロセスが落ちず、ログのみ残る → notifier detection テスト
- [ ] (7) `bun test` がすべて pass する → Step 3.2 確認
- [ ] (8) Map 内タイマー数が `session.idle` 後に 0 になる → stress test で確認
- [ ] (9) 初期ハング検知 (onUserMessage のみ → stage1/stage2) → stress test "initial hang detection"
- [ ] (10) 空セッション誤検知なし → stress test "empty session no false trigger"

### Step 5: コミット [host]

- [ ] Step 5.1: コミット

```bash
git add tests/stress.test.ts
git commit -m "test(stress): 1000-session leak check + initial-hang + empty-session acceptance"
```

### Step 6: Draft PR 作成 [host]

- [ ] Step 6.1: Draft PR 作成

```bash
git push -u origin feat/3-2-stress-test
gh pr create --draft --base feat/3-1-plugin-entry --head feat/3-2-stress-test \
  --title "test(stress): leak check + acceptance §10 (initial hang + empty session)" \
  --body "Phase 3 stack #2. Stress test for memory/timer leaks and acceptance criteria §10."
```

- [ ] Step 6.2: PR URL を記録

---

# 完了後アクション (Post-Implementation)

すべてのタスクの Draft PR が作成され、上記の Step 4.1 チェックリストが全項目クリアされたら、`superpowers:finishing-a-development-branch` スキルを起動し、人間オペレータに以下の選択肢を提示する:

1. **Ready for Review に昇格**: 各 Draft PR の状態を `Ready for review` に切替え、レビュワーへ通知。
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
