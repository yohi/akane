import solidPlugin from "@opentui/solid/bun-plugin";

const EXTERNALS = ["node:fs", "node:path"];
const TUI_EXTERNALS = [...EXTERNALS, "solid-js", "@opentui/solid", "@opentui/core"];

async function buildServer(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    outdir: "./dist",
    target: "node",
    external: EXTERNALS,
    naming: {
      entry: "index.js",
    },
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Server plugin build failed");
  }
}

async function buildTui(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/tui.tsx"],
    outdir: "./dist",
    target: "bun",
    external: TUI_EXTERNALS,
    plugins: [solidPlugin],
    naming: {
      entry: "tui.js",
    },
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("TUI plugin build failed");
  }
}

try {
  await buildServer();
  console.log("Built dist/index.js");
  await buildTui();
  console.log("Built dist/tui.js");
} catch (err) {
  console.error(err);
  process.exit(1);
}
