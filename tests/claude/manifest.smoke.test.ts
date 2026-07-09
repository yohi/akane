import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";

const plugin = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf8")) as {
  name: string;
  version: string;
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  userConfig: Record<string, { type: string; default: unknown; title: string; description: string }>;
  author?: { name?: string; url?: string };
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
      // Registered per design §5.4 target hook set even though Claude Code's
      // real-machine registrability/matcher syntax for these five remains
      // unconfirmed (§10-3, CC_VERIFICATION-2026-07-08.md). hook.ts already
      // handles them (normalizeEvent), and its documented fallback paths
      // (Stop error-field inspection, Notification permission_prompt, etc.)
      // keep the watchdog safe even if Claude Code never fires them.
      "PostToolUseFailure", "StopFailure", "PermissionRequest",
      "SubagentStart", "SubagentStop",
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

  test("userConfig entries have title + description and manifest has author (required by claude plugin validate --strict)", () => {
    for (const key of Object.keys(plugin.userConfig)) {
      const entry = plugin.userConfig[key]!;
      expect(typeof entry.title).toBe("string");
      expect(entry.title.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
    }
    expect(plugin.author).toBeDefined();
    expect(typeof plugin.author!.name).toBe("string");
  });

  test("uses only CLAUDE_PLUGIN_ROOT-relative paths (no absolute paths)", () => {
    // Inspect every registered hook command directly (not a raw-text substring
    // scan) so any absolute-path form — Unix (`/...`) or Windows (`C:\...`,
    // `\\...`) — is rejected, not just the two hardcoded dev-machine prefixes.
    const absolutePathPattern = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
    for (const entries of Object.values(plugin.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(absolutePathPattern.test(hook.command)).toBe(false);
        }
      }
    }
    for (const monitor of monitors) {
      expect(absolutePathPattern.test(monitor.command)).toBe(false);
    }
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
