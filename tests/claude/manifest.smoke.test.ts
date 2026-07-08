import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";

const plugin = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf8")) as {
  name: string;
  version: string;
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  userConfig: Record<string, { type: string; default: unknown }>;
};
const monitors = JSON.parse(fs.readFileSync("monitors/monitors.json", "utf8")) as Array<{
  name: string;
  command: string;
}>;
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };

describe("plugin.json", () => {
  test("identifies akane and matches package.json version", () => {
    expect(plugin.name).toBe("akane");
    expect(plugin.version).toBe(pkg.version);
  });

  test("registers the core hook events, all routed to the single hook.js", () => {
    const required = [
      "UserPromptSubmit", "MessageDisplay", "PreToolUse", "PostToolUse",
      "Stop", "Notification", "SessionStart", "SessionEnd",
    ];
    for (const name of required) {
      const entry = plugin.hooks[name];
      expect(Array.isArray(entry)).toBe(true);
      const command = entry![0]!.hooks[0]!.command;
      expect(command).toContain("${CLAUDE_PLUGIN_ROOT}");
      expect(command).toContain("dist/claude/hook.js");
    }
  });

  test("exposes the userConfig knobs with defaults", () => {
    expect(plugin.userConfig.stage1_ms!.default).toBe(180000);
    expect(plugin.userConfig.stage2_ms!.default).toBe(180000);
    expect(plugin.userConfig.max_pings!.default).toBe(1);
    expect(plugin.userConfig.notifier_type!.default).toBe("tmux");
  });

  test("uses only CLAUDE_PLUGIN_ROOT-relative paths (no absolute paths)", () => {
    const raw = fs.readFileSync(".claude-plugin/plugin.json", "utf8");
    expect(raw.includes("/home/")).toBe(false);
    expect(raw.includes("/Users/")).toBe(false);
  });
});

describe("monitors.json", () => {
  test("declares the akane-watchdog resident monitor -> monitor.js", () => {
    expect(Array.isArray(monitors)).toBe(true);
    const m = monitors[0]!;
    expect(m.name).toBe("akane-watchdog");
    expect(m.command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(m.command).toContain("dist/claude/monitor.js");
  });
});
