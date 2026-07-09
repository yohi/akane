
const EXTERNALS = ["node:fs", "node:path"];
const TUI_EXTERNALS = [...EXTERNALS, "solid-js", "@opentui/solid", "@opentui/core"];

/**
 * 共通の Bun.build ハンドリング関数
 * @param config Bun.build の設定オブジェクト
 * @param errorMessage ビルド失敗時に投げるエラーメッセージ
 */
async function runBunBuild(
  config: Parameters<typeof Bun.build>[0],
  errorMessage: string
): Promise<void> {
  const result = await Bun.build(config);
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(errorMessage);
  }
}
export async function buildServer(): Promise<void> {
  await runBunBuild(
    {
      entrypoints: ["./src/index.ts"],
      outdir: "./dist",
      target: "node",
      external: EXTERNALS,
      naming: { entry: "index.js" },
    },
    "Server plugin build failed"
  );
}

export async function buildTui(): Promise<void> {
  const solidPlugin = (await import("@opentui/solid/bun-plugin")).default;
  await runBunBuild(
    {
      entrypoints: ["./src/tui.tsx"],
      outdir: "./dist",
      target: "bun",
      external: TUI_EXTERNALS,
      plugins: [solidPlugin],
      naming: { entry: "tui.js" },
    },
    "TUI plugin build failed"
  );
}

export async function buildClaudeHook(): Promise<void> {
  await runBunBuild(
    {
      entrypoints: ["./src/claude/hook-main.ts"],
      outdir: "./dist/claude",
      target: "node",
      external: EXTERNALS,
      naming: { entry: "hook.js" },
    },
    "Claude hook build failed"
  );
}

export async function buildClaudeMonitor(): Promise<void> {
  await runBunBuild(
    {
      entrypoints: ["./src/claude/monitor-main.ts"],
      outdir: "./dist/claude",
      target: "node",
      external: EXTERNALS,
      naming: { entry: "monitor.js" },
    },
    "Claude monitor build failed"
  );
}

if (import.meta.main) {
  try {
    await buildServer();
    console.log("Built dist/index.js");
    await buildTui();
    console.log("Built dist/tui.js");
    await buildClaudeHook();
    console.log("Built dist/claude/hook.js");
    await buildClaudeMonitor();
    console.log("Built dist/claude/monitor.js");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
