import { describe, expect, it } from "bun:test";

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    console.error(`Command failed: ${command.join(" ")}\n${stderr}`);
  }

  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("published package contents", () => {
  it("publishes an importable V2 server without a TUI entry or wrapper", async () => {
    const cwd = process.cwd();

    run(["bun", "run", "build"], cwd);

    const output = run(["bun", "pm", "pack", "--dry-run"], cwd);
    const filePaths = new Set(
      [...output.matchAll(/^packed\s+\S+\s+(.+)$/gm)].map((match) => match[1]),
    );

    expect(filePaths.has("dist/index.js")).toBe(true);
    expect(filePaths.has("dist/tui.js")).toBe(false);
    expect(filePaths.has(".opencode/plugins/akane.tui.js")).toBe(false);
    const modulePath = new URL("../dist/index.js", import.meta.url).href;
    const loaded: unknown = await import(modulePath);
    if (!isRecord(loaded) || !isRecord(loaded.default)) throw new Error("V2 package entrypoint is not an object");
    expect(loaded.default.id).toBe("opencode-watchdog");
    expect(typeof loaded.default.setup).toBe("function");
    expect("server" in loaded.default).toBe(false);
  }, { timeout: 30000 });
});
