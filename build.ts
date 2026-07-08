import solidPlugin from "@opentui/solid/bun-plugin";

const EXTERNALS = ["node:fs", "node:path"];
const TUI_EXTERNALS = [...EXTERNALS, "solid-js", "@opentui/solid", "@opentui/core"];

export async function buildServer(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    outdir: "./dist",
    target: "node",
    external: EXTERNALS,
    naming: { entry: "index.js" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Server plugin build failed");
  }
}

export async function buildTui(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/tui.tsx"],
    outdir: "./dist",
    target: "bun",
    external: TUI_EXTERNALS,
    plugins: [solidPlugin],
    naming: { entry: "tui.js" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("TUI plugin build failed");
  }
}

export async function buildClaudeHook(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/claude/hook-main.ts"],
    outdir: "./dist/claude",
    target: "node",
    external: EXTERNALS,
    naming: { entry: "hook.js" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Claude hook build failed");
  }
}

export async function buildClaudeMonitor(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/claude/monitor-main.ts"],
    outdir: "./dist/claude",
    target: "node",
    external: EXTERNALS,
    naming: { entry: "monitor.js" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Claude monitor build failed");
  }
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
