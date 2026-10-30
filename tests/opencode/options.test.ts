import { expect, test } from "bun:test";
import { resolveReporterInterval, resolveV2Options } from "../../src/opencode/options";

test("environment overrides validated V2 options", () => {
  const result = resolveV2Options({ stage1Ms: 5678 }, { OPENCODE_WATCHDOG_STAGE1_MS: "1234" });
  expect(result.stage1Ms).toBe(1234);
});

test("invalid options fall back without exposing their values", () => {
  const warnings: string[] = [];
  const result = resolveV2Options({ stage1Ms: "private-sentinel" }, {}, (message) => warnings.push(message));
  expect(result.stage1Ms).toBe(180000);
  expect(warnings.join(" ")).not.toContain("private-sentinel");
});

test("legacy nested options do not alter V2 settings", () => {
  expect(resolveV2Options({ watchdog: { stage1Ms: 1234 } }, {}).stage1Ms).toBe(180000);
});

test("nested options preserve valid values and defaults", () => {
  const result = resolveV2Options({ tmux: { enabled: false }, agents: { include: ["build"] } }, {});
  expect(result.tmux.enabled).toBe(false);
  expect(result.tmux.highlightWindow).toBe(true);
  expect(result.agents.include).toEqual(["build"]);
});

test("subagent settings are validated and preserved", () => {
  const result = resolveV2Options({
    subagentDisplay: { enabled: true, maxPanes: 3 },
    subagentTermination: { enabled: true, graceMs: 5000, keepOnError: false },
  }, {});
  expect(result.subagentDisplay).toEqual({ enabled: true, maxPanes: 3 });
  expect(result.subagentTermination).toEqual({ enabled: true, graceMs: 5000, keepOnError: false });
});

test("report interval defaults to one minute and validates the environment override", () => {
  expect(resolveReporterInterval({})).toBe(60000);
  expect(resolveReporterInterval({ OPENCODE_WATCHDOG_REPORT_MS: "25000" })).toBe(25000);
  expect(resolveReporterInterval({ OPENCODE_WATCHDOG_REPORT_MS: "secret" }, () => {})).toBe(60000);
});
