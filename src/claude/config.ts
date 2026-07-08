import { resolveConfig, type WatchdogConfig, type WarnFn } from "../config";

// Claude Code delivers userConfig values as AKANE_* env vars (SPEC §7.2). We
// translate them onto the existing OPENCODE_WATCHDOG_* env contract so the
// battle-tested resolveConfig validation/precedence is reused verbatim
// (SPEC §4.2 config.ts row).
const ENV_MAP: ReadonlyArray<readonly [string, string]> = [
  ["AKANE_ENABLED", "OPENCODE_WATCHDOG_ENABLED"],
  ["AKANE_STAGE1_MS", "OPENCODE_WATCHDOG_STAGE1_MS"],
  ["AKANE_STAGE2_MS", "OPENCODE_WATCHDOG_STAGE2_MS"],
  ["AKANE_MAX_PINGS", "OPENCODE_WATCHDOG_MAX_PINGS"],
  ["AKANE_MAX_TOOL_GATE_CYCLES", "OPENCODE_WATCHDOG_MAX_TOOL_GATE_CYCLES"],
  ["AKANE_NOTIFIER_TYPE", "OPENCODE_WATCHDOG_NOTIFIER_TYPE"],
  ["AKANE_SUPPRESS_PING_WHILE_TOOL", "OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL"],
  ["AKANE_PAUSE_ON_INPUT", "OPENCODE_WATCHDOG_PAUSE_ON_INPUT"],
  ["AKANE_NOTIFY_WAITING", "OPENCODE_WATCHDOG_NOTIFY_WAITING"],
  ["AKANE_DELIVERY", "OPENCODE_WATCHDOG_DELIVERY"],
  ["AKANE_VERBOSE", "OPENCODE_WATCHDOG_VERBOSE"],
];

export function resolveClaudeConfig(
  env: Record<string, string | undefined>,
  warn: WarnFn = (msg) => console.warn(msg),
): WatchdogConfig {
  const mappedEnv: Record<string, string | undefined> = {};
  for (const [claudeKey, opencodeKey] of ENV_MAP) {
    const value = env[claudeKey];
    if (value !== undefined) mappedEnv[opencodeKey] = value;
  }
  return resolveConfig({ env: mappedEnv }, warn);
}
