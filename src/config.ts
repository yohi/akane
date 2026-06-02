export type NotifierType = "tmux" | "os";

export interface WatchdogConfig {
  enabled: boolean;
  stage1Ms: number;
  stage2Ms: number;
  maxPings: number;
  pingMessage: string;
  notifierType: NotifierType;
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
  pingMessage:
    "現在の状況を教えてください。ハングしているようであれば、思考プロセスを要約して次のアクションを提示してください。",
  notifierType: "tmux",
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

function parseBool(value: string | undefined, key: string, warn: WarnFn): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "1") return true;
  if (lower === "false" || lower === "no" || lower === "0") return false;
  warn(`[watchdog] Invalid value for ${key}: "${value}". Falling back to lower-priority source.`);
  return undefined;
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

export function resolveConfig(
  sources: ConfigSources,
  warn: WarnFn = (msg) => console.warn(msg),
): WatchdogConfig {
  const env = sources.env ?? {};
  const project = sources.project ?? {};

  const envEnabled = parseBool(env.OPENCODE_WATCHDOG_ENABLED, "OPENCODE_WATCHDOG_ENABLED", warn);
  const envStage1 = parsePositiveInt(env.OPENCODE_WATCHDOG_STAGE1_MS, "OPENCODE_WATCHDOG_STAGE1_MS", warn);
  const envStage2 = parsePositiveInt(env.OPENCODE_WATCHDOG_STAGE2_MS, "OPENCODE_WATCHDOG_STAGE2_MS", warn);
  const envMaxPings = parsePositiveInt(env.OPENCODE_WATCHDOG_MAX_PINGS, "OPENCODE_WATCHDOG_MAX_PINGS", warn);
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

  return {
    enabled: envEnabled ?? project.enabled ?? DEFAULT_CONFIG.enabled,
    stage1Ms: envStage1 ?? projStage1 ?? DEFAULT_CONFIG.stage1Ms,
    stage2Ms: envStage2 ?? projStage2 ?? DEFAULT_CONFIG.stage2Ms,
    maxPings: envMaxPings ?? projMaxPings ?? DEFAULT_CONFIG.maxPings,
    pingMessage: project.pingMessage ?? DEFAULT_CONFIG.pingMessage,
    notifierType: envNotifierType ?? projNotifierType ?? DEFAULT_CONFIG.notifierType,
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
