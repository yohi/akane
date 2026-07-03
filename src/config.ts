export type NotifierType = "tmux" | "os";

export type DeliveryMode = "steer" | "queue";

export interface WatchdogConfig {
  // NOTE: This interface represents the fully normalized / defaulted configuration
  // after parsing. Optional user input is expressed in ConfigSources, not here.
  enabled: boolean;
  stage1Ms: number;
  stage2Ms: number;
  maxPings: number;
  maxToolGateCycles: number;
  pingMessage: string;
  notifierType: NotifierType;
  delivery: DeliveryMode;
  suppressPingWhileToolRunning: boolean;
  pauseOnInputRequest: boolean;
  notifyWaiting: boolean;
  verboseLog: boolean;
  tmux: {
    enabled: boolean;
    displayMessage: boolean;
    highlightWindow: boolean;
  };
  agents: {
    include?: string[];
    exclude?: string[];
  };
  subagentDisplay: {
    enabled: boolean;
    maxPanes: number;
  };
  subagentTermination: {
    enabled: boolean;
    graceMs: number;
    keepOnError: boolean;
  };
}

export interface ConfigSources {
  // Primary route: opencode.jsonc's `experimental.watchdog` namespace.
  experimental?: {
    watchdog?: Omit<Partial<WatchdogConfig>, "tmux" | "agents" | "subagentDisplay" | "subagentTermination"> & {
      tmux?: Partial<WatchdogConfig["tmux"]>;
      agents?: Partial<WatchdogConfig["agents"]>;
      subagentDisplay?: Partial<WatchdogConfig["subagentDisplay"]>;
      subagentTermination?: Partial<WatchdogConfig["subagentTermination"]>;
    };
  };
  // Compatibility alias: flat / top-level `watchdog` settings. Lower priority than `experimental`.
  project?: Omit<Partial<WatchdogConfig>, "tmux" | "agents" | "subagentDisplay" | "subagentTermination"> & {
    tmux?: Partial<WatchdogConfig["tmux"]>;
    agents?: Partial<WatchdogConfig["agents"]>;
    subagentDisplay?: Partial<WatchdogConfig["subagentDisplay"]>;
    subagentTermination?: Partial<WatchdogConfig["subagentTermination"]>;
  };
  env?: Record<string, string | undefined>;
}

export type WarnFn = (message: string) => void;

export const DEFAULT_CONFIG: WatchdogConfig = {
  enabled: true,
  stage1Ms: 180_000,
  stage2Ms: 180_000,
  maxPings: 1,
  maxToolGateCycles: 1,
  pingMessage:
    "現在の状況を教えてください。ハングしているようであれば、思考プロセスを要約して次のアクションを提示してください。",
  notifierType: "tmux",
  delivery: "steer",
  suppressPingWhileToolRunning: true,
  pauseOnInputRequest: true,
  notifyWaiting: true,
  verboseLog: false,
  tmux: {
    enabled: true,
    displayMessage: true,
    highlightWindow: true,
  },
  agents: {},
  subagentDisplay: {
    enabled: false,
    maxPanes: 4,
  },
  subagentTermination: {
    enabled: false,
    graceMs: 60_000,
    keepOnError: true,
  },
};

function parsePositiveInt(value: string | undefined, key: string, warn: WarnFn): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    warn(`[watchdog] Invalid value for ${key}: "${value}". Falling back to lower-priority source.`);
    return undefined;
  }
  return n;
}

function parseNotifierType(
  value: string | undefined,
  key: string,
  warn: WarnFn,
): NotifierType | undefined {
  if (value === undefined) return undefined;
  if (value === "tmux" || value === "os") return value;
  warn(`[watchdog] Invalid value for ${key}: "${value}". Falling back to lower-priority source.`);
  return undefined;
}

function parseDelivery(
  value: string | undefined,
  key: string,
  warn: WarnFn,
): DeliveryMode | undefined {
  if (value === undefined) return undefined;
  if (value === "steer" || value === "queue") return value;
  warn(`[watchdog] Invalid value for ${key}: "${value}". Falling back to lower-priority source.`);
  return undefined;
}

function parseBool(value: string | undefined, key: string, warn: WarnFn): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "1") return true;
  if (lower === "false" || lower === "no" || lower === "0") return false;
  warn(`[watchdog] Invalid value for ${key}: "${value}". Falling back to lower-priority source.`);
  return undefined;
}

function validateNumber(
  value: number | undefined,
  key: string,
  warn: WarnFn,
  requireInteger = false,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (requireInteger && !Number.isInteger(value))
  ) {
    warn(`[watchdog] Invalid value for ${key}: ${value}. Falling back to lower-priority source.`);
    return undefined;
  }
  return value;
}

function validateBool(value: boolean | undefined, key: string, warn: WarnFn): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    warn(`[watchdog] Invalid value for ${key}: ${value}. Falling back to lower-priority source.`);
    return undefined;
  }
  return value;
}

export function resolveConfig(
  sources: ConfigSources,
  warn: WarnFn = (msg) => console.warn(msg),
): WatchdogConfig {
  const env = sources.env ?? {};
  const project = sources.project ?? {};
  const experimental = sources.experimental?.watchdog ?? {};

  // Primary configuration source order: env > experimental.watchdog > project (flat alias) > defaults.
  // For nested objects (tmux/agents/subagentDisplay/subagentTermination), each namespace is merged
  // independently with the same priority order.

  const envEnabled = parseBool(env.OPENCODE_WATCHDOG_ENABLED, "OPENCODE_WATCHDOG_ENABLED", warn);
  const expEnabled = validateBool(experimental.enabled, "enabled", warn);
  const projEnabled = validateBool(project.enabled, "enabled", warn);

  const envStage1 = parsePositiveInt(env.OPENCODE_WATCHDOG_STAGE1_MS, "OPENCODE_WATCHDOG_STAGE1_MS", warn);
  const expStage1 = validateNumber(experimental.stage1Ms, "stage1Ms", warn, true);
  const projStage1 = validateNumber(project.stage1Ms, "stage1Ms", warn, true);

  const envStage2 = parsePositiveInt(env.OPENCODE_WATCHDOG_STAGE2_MS, "OPENCODE_WATCHDOG_STAGE2_MS", warn);
  const expStage2 = validateNumber(experimental.stage2Ms, "stage2Ms", warn, true);
  const projStage2 = validateNumber(project.stage2Ms, "stage2Ms", warn, true);

  const envMaxPings = parsePositiveInt(env.OPENCODE_WATCHDOG_MAX_PINGS, "OPENCODE_WATCHDOG_MAX_PINGS", warn);
  const expMaxPings = validateNumber(experimental.maxPings, "maxPings", warn, true);
  const projMaxPings = validateNumber(project.maxPings, "maxPings", warn, true);

  const envMaxToolGateCycles = parsePositiveInt(
    env.OPENCODE_WATCHDOG_MAX_TOOL_GATE_CYCLES,
    "OPENCODE_WATCHDOG_MAX_TOOL_GATE_CYCLES",
    warn,
  );
  const expMaxToolGateCycles = validateNumber(experimental.maxToolGateCycles, "maxToolGateCycles", warn, true);
  const projMaxToolGateCycles = validateNumber(project.maxToolGateCycles, "maxToolGateCycles", warn, true);

  const envNotifierType = parseNotifierType(
    env.OPENCODE_WATCHDOG_NOTIFIER_TYPE,
    "OPENCODE_WATCHDOG_NOTIFIER_TYPE",
    warn,
  );
  const expNotifierType = parseNotifierType(experimental.notifierType, "notifierType", warn);
  const projNotifierType = parseNotifierType(project.notifierType, "notifierType", warn);

  const envDelivery = parseDelivery(env.OPENCODE_WATCHDOG_DELIVERY, "OPENCODE_WATCHDOG_DELIVERY", warn);
  const expDelivery = parseDelivery(experimental.delivery, "delivery", warn);
  const projDelivery = parseDelivery(project.delivery, "delivery", warn);

  const envSuppressTool = parseBool(env.OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL, "OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL", warn);
  const expSuppressTool = validateBool(experimental.suppressPingWhileToolRunning, "suppressPingWhileToolRunning", warn);
  const projSuppressTool = validateBool(project.suppressPingWhileToolRunning, "suppressPingWhileToolRunning", warn);

  const envPauseOnInput = parseBool(env.OPENCODE_WATCHDOG_PAUSE_ON_INPUT, "OPENCODE_WATCHDOG_PAUSE_ON_INPUT", warn);
  const expPauseOnInput = validateBool(experimental.pauseOnInputRequest, "pauseOnInputRequest", warn);
  const projPauseOnInput = validateBool(project.pauseOnInputRequest, "pauseOnInputRequest", warn);

  const envNotifyWaiting = parseBool(env.OPENCODE_WATCHDOG_NOTIFY_WAITING, "OPENCODE_WATCHDOG_NOTIFY_WAITING", warn);
  const expNotifyWaiting = validateBool(experimental.notifyWaiting, "notifyWaiting", warn);
  const projNotifyWaiting = validateBool(project.notifyWaiting, "notifyWaiting", warn);

  const envVerbose = parseBool(env.OPENCODE_WATCHDOG_VERBOSE, "OPENCODE_WATCHDOG_VERBOSE", warn);
  const expVerbose = validateBool(experimental.verboseLog, "verboseLog", warn);
  const projVerbose = validateBool(project.verboseLog, "verboseLog", warn);

  return {
    enabled: envEnabled ?? expEnabled ?? projEnabled ?? DEFAULT_CONFIG.enabled,
    stage1Ms: envStage1 ?? expStage1 ?? projStage1 ?? DEFAULT_CONFIG.stage1Ms,
    stage2Ms: envStage2 ?? expStage2 ?? projStage2 ?? DEFAULT_CONFIG.stage2Ms,
    maxPings: envMaxPings ?? expMaxPings ?? projMaxPings ?? DEFAULT_CONFIG.maxPings,
    maxToolGateCycles:
      envMaxToolGateCycles ?? expMaxToolGateCycles ?? projMaxToolGateCycles ?? DEFAULT_CONFIG.maxToolGateCycles,
    pingMessage: experimental.pingMessage ?? project.pingMessage ?? DEFAULT_CONFIG.pingMessage,
    notifierType: envNotifierType ?? expNotifierType ?? projNotifierType ?? DEFAULT_CONFIG.notifierType,
    delivery: envDelivery ?? expDelivery ?? projDelivery ?? DEFAULT_CONFIG.delivery,
    suppressPingWhileToolRunning:
      envSuppressTool ?? expSuppressTool ?? projSuppressTool ?? DEFAULT_CONFIG.suppressPingWhileToolRunning,
    pauseOnInputRequest: envPauseOnInput ?? expPauseOnInput ?? projPauseOnInput ?? DEFAULT_CONFIG.pauseOnInputRequest,
    notifyWaiting: envNotifyWaiting ?? expNotifyWaiting ?? projNotifyWaiting ?? DEFAULT_CONFIG.notifyWaiting,
    verboseLog: envVerbose ?? expVerbose ?? projVerbose ?? DEFAULT_CONFIG.verboseLog,
    tmux: {
      enabled: experimental.tmux?.enabled ?? project.tmux?.enabled ?? DEFAULT_CONFIG.tmux.enabled,
      displayMessage: experimental.tmux?.displayMessage ?? project.tmux?.displayMessage ?? DEFAULT_CONFIG.tmux.displayMessage,
      highlightWindow: experimental.tmux?.highlightWindow ?? project.tmux?.highlightWindow ?? DEFAULT_CONFIG.tmux.highlightWindow,
    },
    agents: {
      include: experimental.agents?.include ?? project.agents?.include,
      exclude: experimental.agents?.exclude ?? project.agents?.exclude,
    },
    subagentDisplay: {
      enabled:
        experimental.subagentDisplay?.enabled ??
        project.subagentDisplay?.enabled ??
        DEFAULT_CONFIG.subagentDisplay.enabled,
      maxPanes:
        experimental.subagentDisplay?.maxPanes ??
        project.subagentDisplay?.maxPanes ??
        DEFAULT_CONFIG.subagentDisplay.maxPanes,
    },
    subagentTermination: {
      enabled:
        experimental.subagentTermination?.enabled ??
        project.subagentTermination?.enabled ??
        DEFAULT_CONFIG.subagentTermination.enabled,
      graceMs:
        experimental.subagentTermination?.graceMs ??
        project.subagentTermination?.graceMs ??
        DEFAULT_CONFIG.subagentTermination.graceMs,
      keepOnError:
        experimental.subagentTermination?.keepOnError ??
        project.subagentTermination?.keepOnError ??
        DEFAULT_CONFIG.subagentTermination.keepOnError,
    },
  };
}
