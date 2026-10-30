import { resolveConfig, type ConfigSources, type WarnFn, type WatchdogConfig } from "../config";

type Options = NonNullable<ConfigSources["project"]>;

export function resolveReporterInterval(
  env: Record<string, string | undefined>,
  warn: WarnFn = (message) => console.warn(message),
): number {
  const raw = env.OPENCODE_WATCHDOG_REPORT_MS;
  if (raw === undefined) return 60_000;
  const interval = Number(raw);
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    warn("[watchdog] Invalid OPENCODE_WATCHDOG_REPORT_MS; using the 60000ms default.");
    return 60_000;
  }
  return interval;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveV2Options(
  value: unknown,
  env: Record<string, string | undefined>,
  warn: WarnFn = (message) => console.warn(message),
): WatchdogConfig {
  const options: Options = {};
  if (isRecord(value)) {
    for (const key of ["stage1Ms", "stage2Ms", "maxPings", "maxToolGateCycles"] as const) {
      const item = value[key];
      if (item === undefined) continue;
      if (typeof item === "number" && Number.isSafeInteger(item) && item > 0) options[key] = item;
      else warn(`[watchdog] Invalid option ${key}; using fallback.`);
    }
    for (const key of ["enabled", "suppressPingWhileToolRunning", "pauseOnInputRequest", "notifyWaiting", "verboseLog"] as const) {
      const item = value[key];
      if (item === undefined) continue;
      if (typeof item === "boolean") options[key] = item;
      else warn(`[watchdog] Invalid option ${key}; using fallback.`);
    }
    if (typeof value.pingMessage === "string") options.pingMessage = value.pingMessage;
    if (value.delivery === "steer" || value.delivery === "queue") options.delivery = value.delivery;
    if (value.notifierType === "tmux" || value.notifierType === "os") options.notifierType = value.notifierType;
    if (isRecord(value.tmux)) {
      const tmux: NonNullable<Options["tmux"]> = {};
      for (const key of ["enabled", "displayMessage", "highlightWindow"] as const) {
        if (typeof value.tmux[key] === "boolean") tmux[key] = value.tmux[key];
        else if (value.tmux[key] !== undefined) warn(`[watchdog] Invalid option tmux.${key}; using fallback.`);
      }
      options.tmux = tmux;
    }
    if (isRecord(value.agents)) {
      const agents: NonNullable<Options["agents"]> = {};
      for (const key of ["include", "exclude"] as const) {
        const item: unknown = value.agents[key];
        if (Array.isArray(item) && item.every((entry: unknown) => typeof entry === "string")) agents[key] = item;
        else if (item !== undefined) warn(`[watchdog] Invalid option agents.${key}; using fallback.`);
      }
      options.agents = agents;
    }
    if (isRecord(value.subagentDisplay)) {
      const display: NonNullable<Options["subagentDisplay"]> = {};
      const { enabled, maxPanes } = value.subagentDisplay;
      if (typeof enabled === "boolean") display.enabled = enabled;
      else if (enabled !== undefined) warn("[watchdog] Invalid option subagentDisplay.enabled; using fallback.");
      if (typeof maxPanes === "number" && Number.isSafeInteger(maxPanes) && maxPanes > 0) display.maxPanes = maxPanes;
      else if (maxPanes !== undefined) warn("[watchdog] Invalid option subagentDisplay.maxPanes; using fallback.");
      options.subagentDisplay = display;
    }
    if (isRecord(value.subagentTermination)) {
      const termination: NonNullable<Options["subagentTermination"]> = {};
      const { enabled, keepOnError, graceMs } = value.subagentTermination;
      if (typeof enabled === "boolean") termination.enabled = enabled;
      else if (enabled !== undefined) warn("[watchdog] Invalid option subagentTermination.enabled; using fallback.");
      if (typeof keepOnError === "boolean") termination.keepOnError = keepOnError;
      else if (keepOnError !== undefined) warn("[watchdog] Invalid option subagentTermination.keepOnError; using fallback.");
      if (typeof graceMs === "number" && Number.isSafeInteger(graceMs) && graceMs > 0) termination.graceMs = graceMs;
      else if (graceMs !== undefined) warn("[watchdog] Invalid option subagentTermination.graceMs; using fallback.");
      options.subagentTermination = termination;
    }
  } else if (value !== undefined) {
    warn("[watchdog] Invalid options; using fallback.");
  }
  return resolveConfig({ project: options, env }, (message) => {
    // Shared V1 parser includes input values in its warnings; never forward them.
    warn(message.replace(/:.*$/, ": invalid value; using fallback."));
  });
}
