import { describe, expect, it } from "bun:test";

type PackFile = {
  readonly path: string;
};

type PackResult = {
  readonly files: readonly PackFile[];
};

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout);
}

describe("published package contents", () => {
  it("includes the built TUI entry and OpenCode plugin wrapper after build", () => {
    const cwd = process.cwd();

    run(["bun", "run", "build"], cwd);

    const output = run(["npm", "pack", "--dry-run", "--json"], cwd);
    const packs = JSON.parse(output) as readonly PackResult[];
    expect(packs.length).toBeGreaterThan(0);
    const pack = packs[0];
    if (!pack) {
      throw new Error("expected npm pack to return at least one package result");
    }
    const filePaths = new Set(pack.files.map((file) => file.path));

    expect(filePaths.has("dist/tui.js")).toBe(true);
    expect(filePaths.has(".opencode/plugins/akane.tui.js")).toBe(true);
  }, { timeout: 30000 });
});
