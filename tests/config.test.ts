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

  test("invalid 0 falls back to default with warn", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { project: { stage1Ms: 0 } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.stage1Ms).toBe(180_000);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("env OPENCODE_WATCHDOG_MAX_PINGS=0 falls back to default", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { env: { OPENCODE_WATCHDOG_MAX_PINGS: "0" } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.maxPings).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
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
