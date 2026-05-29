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
    expect(warnings[0]).toContain("lower-priority source");
  });

  test("invalid 0 falls back to default with warn", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { project: { stage1Ms: 0 } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.stage1Ms).toBe(180_000);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("lower-priority source");
  });

  test("env OPENCODE_WATCHDOG_MAX_PINGS=0 falls back to default", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { env: { OPENCODE_WATCHDOG_MAX_PINGS: "0" } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.maxPings).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("lower-priority source");
  });

  test("invalid type in env falls back to default", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { env: { OPENCODE_WATCHDOG_MAX_PINGS: "not-a-number" } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.maxPings).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("lower-priority source");
  });

  test("uses project config when env is invalid", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      {
        env: { OPENCODE_WATCHDOG_MAX_PINGS: "0" },
        project: { maxPings: 5 },
      },
      (msg) => warnings.push(msg),
    );
    expect(cfg.maxPings).toBe(5);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("OPENCODE_WATCHDOG_MAX_PINGS");
    expect(warnings[0]).toContain("lower-priority source");
  });

  test("validateNumber rejects non-integers for millisecond and ping settings", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { project: { stage1Ms: 123.45 } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.stage1Ms).toBe(DEFAULT_CONFIG.stage1Ms);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("stage1Ms");
    expect(warnings[0]).toContain("lower-priority source");
  });

  test("agents.include and exclude pass through", () => {
    const cfg = resolveConfig({
      project: { agents: { include: ["main"], exclude: ["debug"] } },
    });
    expect(cfg.agents.include).toEqual(["main"]);
    expect(cfg.agents.exclude).toEqual(["debug"]);
  });

  test("allows partial tmux config in project", () => {
    const sources: ConfigSources = {
      project: {
        tmux: { enabled: false }
      }
    };
    const cfg = resolveConfig(sources);
    expect(cfg.tmux.enabled).toBe(false);
    expect(cfg.tmux.displayMessage).toBe(true);
  });

  test("parseBool handles TRUE/FALSE case-insensitively", () => {
    expect(resolveConfig({ env: { OPENCODE_WATCHDOG_ENABLED: "TRUE" } }).enabled).toBe(true);
    expect(resolveConfig({ env: { OPENCODE_WATCHDOG_ENABLED: "FALSE" } }).enabled).toBe(false);
  });

  test("parseBool handles yes/no", () => {
    expect(resolveConfig({ env: { OPENCODE_WATCHDOG_ENABLED: "yes" } }).enabled).toBe(true);
    expect(resolveConfig({ env: { OPENCODE_WATCHDOG_ENABLED: "no" } }).enabled).toBe(false);
  });

  test("parseBool warns on invalid value", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { env: { OPENCODE_WATCHDOG_ENABLED: "maybe" } },
      (msg) => warnings.push(msg),
    );
    expect(cfg.enabled).toBe(true); // デフォルト
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("OPENCODE_WATCHDOG_ENABLED");
    expect(warnings[0]).toContain("lower-priority source");
  });
});
