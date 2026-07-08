import { describe, test, expect } from "bun:test";
import { resolveClaudeConfig } from "../../src/claude/config";
import { DEFAULT_CONFIG } from "../../src/config";

describe("resolveClaudeConfig", () => {
  test("returns defaults for empty env", () => {
    const cfg = resolveClaudeConfig({});
    expect(cfg.stage1Ms).toBe(180_000);
    expect(cfg.maxPings).toBe(1);
    expect(cfg.notifierType).toBe("tmux");
  });

  test("maps AKANE_* env onto the OPENCODE_WATCHDOG_* contract", () => {
    const cfg = resolveClaudeConfig({
      AKANE_STAGE1_MS: "30000",
      AKANE_STAGE2_MS: "45000",
      AKANE_MAX_PINGS: "2",
      AKANE_NOTIFIER_TYPE: "os",
    });
    expect(cfg.stage1Ms).toBe(30_000);
    expect(cfg.stage2Ms).toBe(45_000);
    expect(cfg.maxPings).toBe(2);
    expect(cfg.notifierType).toBe("os");
  });

  test("AKANE_ENABLED=false disables", () => {
    expect(resolveClaudeConfig({ AKANE_ENABLED: "false" }).enabled).toBe(false);
  });

  test("invalid value warns and falls back to default", () => {
    const warnings: string[] = [];
    const cfg = resolveClaudeConfig({ AKANE_MAX_PINGS: "0" }, (m) => warnings.push(m));
    expect(cfg.maxPings).toBe(DEFAULT_CONFIG.maxPings);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
