export type NotifierType = "tmux" | "os";

export type DeliveryMode = "steer" | "queue";

export interface WatchdogConfig {
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
}

export interface ConfigSources {
  project?: Omit<Partial<WatchdogConfig>, "tmux" | "agents"> & {
    tmux?: Partial<WatchdogConfig["tmux"]>;
    agents?: Partial<WatchdogConfig["agents"]>;
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

  const envEnabled = parseBool(env.OPENCODE_WATCHDOG_ENABLED, "OPENCODE_WATCHDOG_ENABLED", warn);
  const projEnabled = validateBool(project.enabled, "enabled", warn);

  const envStage1 = parsePositiveInt(env.OPENCODE_WATCHDOG_STAGE1_MS, "OPENCODE_WATCHDOG_STAGE1_MS", warn);
  const envStage2 = parsePositiveInt(env.OPENCODE_WATCHDOG_STAGE2_MS, "OPENCODE_WATCHDOG_STAGE2_MS", warn);
  const envMaxPings = parsePositiveInt(env.OPENCODE_WATCHDOG_MAX_PINGS, "OPENCODE_WATCHDOG_MAX_PINGS", warn);
  const envMaxToolGateCycles = parsePositiveInt(
    env.OPENCODE_WATCHDOG_MAX_TOOL_GATE_CYCLES,
    "OPENCODE_WATCHDOG_MAX_TOOL_GATE_CYCLES",
    warn,
  );

  const envNotifierType = parseNotifierType(
    env.OPENCODE_WATCHDOG_NOTIFIER_TYPE,
    "OPENCODE_WATCHDOG_NOTIFIER_TYPE",
    warn,
  );
  const projNotifierType = parseNotifierType(
    project.notifierType,
    "notifierType",
    warn,
  );

  const projStage1 = validateNumber(project.stage1Ms, "stage1Ms", warn, true);
  const projStage2 = validateNumber(project.stage2Ms, "stage2Ms", warn, true);
  const projMaxPings = validateNumber(project.maxPings, "maxPings", warn, true);
  const projMaxToolGateCycles = validateNumber(project.maxToolGateCycles, "maxToolGateCycles", warn, true);

  const envDelivery = parseDelivery(env.OPENCODE_WATCHDOG_DELIVERY, "OPENCODE_WATCHDOG_DELIVERY", warn);
  const projDelivery = parseDelivery(project.delivery, "delivery", warn);

  const envSuppressTool = parseBool(env.OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL, "OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL", warn);
  const projSuppressTool = validateBool(project.suppressPingWhileToolRunning, "suppressPingWhileToolRunning", warn);

  const envPauseOnInput = parseBool(env.OPENCODE_WATCHDOG_PAUSE_ON_INPUT, "OPENCODE_WATCHDOG_PAUSE_ON_INPUT", warn);
  const projPauseOnInput = validateBool(project.pauseOnInputRequest, "pauseOnInputRequest", warn);

  const envNotifyWaiting = parseBool(env.OPENCODE_WATCHDOG_NOTIFY_WAITING, "OPENCODE_WATCHDOG_NOTIFY_WAITING", warn);
  const projNotifyWaiting = validateBool(project.notifyWaiting, "notifyWaiting", warn);

  const envVerbose = parseBool(env.OPENCODE_WATCHDOG_VERBOSE, "OPENCODE_WATCHDOG_VERBOSE", warn);
  const projVerbose = validateBool(project.verboseLog, "verboseLog", warn);

  return {
    enabled: envEnabled ?? projEnabled ?? DEFAULT_CONFIG.enabled,
    stage1Ms: envStage1 ?? projStage1 ?? DEFAULT_CONFIG.stage1Ms,
    stage2Ms: envStage2 ?? projStage2 ?? DEFAULT_CONFIG.stage2Ms,
    maxPings: envMaxPings ?? projMaxPings ?? DEFAULT_CONFIG.maxPings,
    maxToolGateCycles:
      envMaxToolGateCycles ?? projMaxToolGateCycles ?? DEFAULT_CONFIG.maxToolGateCycles,
    pingMessage: project.pingMessage ?? DEFAULT_CONFIG.pingMessage,
    notifierType: envNotifierType ?? projNotifierType ?? DEFAULT_CONFIG.notifierType,
    delivery: envDelivery ?? projDelivery ?? DEFAULT_CONFIG.delivery,
    suppressPingWhileToolRunning:
      envSuppressTool ?? projSuppressTool ?? DEFAULT_CONFIG.suppressPingWhileToolRunning,
    pauseOnInputRequest: envPauseOnInput ?? projPauseOnInput ?? DEFAULT_CONFIG.pauseOnInputRequest,
    notifyWaiting: envNotifyWaiting ?? projNotifyWaiting ?? DEFAULT_CONFIG.notifyWaiting,
    verboseLog: envVerbose ?? projVerbose ?? DEFAULT_CONFIG.verboseLog,
    tmux: {
      enabled: project.tmux?.enabled ?? DEFAULT_CONFIG.tmux.enabled,
      displayMessage: project.tmux?.displayMessage ?? DEFAULT_CONFIG.tmux.displayMessage,
      highlightWindow: project.tmux?.highlightWindow ?? DEFAULT_CONFIG.tmux.highlightWindow,
    },
    agents: {
      include: project.agents?.include,
      exclude: project.agents?.exclude,
    },
  };
}
