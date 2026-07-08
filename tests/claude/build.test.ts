import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import { buildClaudeHook, buildClaudeMonitor } from "../../build";

describe("claude bundles", () => {
  afterAll(() => {
    // Leave dist/claude in place for downstream tasks; no teardown required.
  });

  test("buildClaudeHook emits a non-empty dist/claude/hook.js", async () => {
    await buildClaudeHook();
    expect(fs.existsSync("dist/claude/hook.js")).toBe(true);
    expect(fs.statSync("dist/claude/hook.js").size).toBeGreaterThan(0);
  });

  test("buildClaudeMonitor emits a non-empty dist/claude/monitor.js", async () => {
    await buildClaudeMonitor();
    expect(fs.existsSync("dist/claude/monitor.js")).toBe(true);
    expect(fs.statSync("dist/claude/monitor.js").size).toBeGreaterThan(0);
  });
});
