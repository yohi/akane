// OpenCode plugin entry. Replaces Phase 0 stub.
//
// SDK shapes captured in docs/SDK_NOTES.md (@opencode-ai/plugin@1.15.12 実測):
// - Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
// - Hooks.event = (input: { event: Event }) => Promise<void>
// - extractSessionId per event type:
//   * message.updated         → properties.info.sessionID
//   * message.part.updated    → properties.part.sessionID
//   * session.created/deleted → properties.info.id
//   * session.idle/error      → properties.sessionID (直接 — info.id ではない)

import { Watchdog } from "./watchdog";
import { RealClock } from "./clock";
import type { Clock, TimerHandle } from "./clock";
import { OpenCodeAdapter } from "./pinger";
import { createNotifier, bunSpawn, bunWhich } from "./notifier";
import { resolveConfig, type WatchdogConfig, type ConfigSources } from "./config";
import { classifyError, type HangReason } from "./errors";
import { TelemetryCollector, type Telemetry, startTelemetryReporter } from "./telemetry";
import { getStateStore } from "./shared-state";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, modify, applyEdits } from "jsonc-parser";


// Loose, structural Event type. We do NOT import the full @opencode-ai/sdk
// Event union here so the plugin remains decoupled from upstream churn.
// Full payloads are validated in tests via SDK_NOTES.
export interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export function extractSessionId(event: OpenCodeEvent): string | undefined {
  const props = event.properties ?? {};
  switch (event.type) {
    case "message.updated": {
      const info = (props as { info?: { sessionID?: string } }).info;
      return typeof info?.sessionID === "string" ? info.sessionID : undefined;
    }
    case "message.part.updated": {
      const part = (props as { part?: { sessionID?: string } }).part;
      return typeof part?.sessionID === "string" ? part.sessionID : undefined;
    }
    case "session.created":
    case "session.updated":
    case "session.deleted": {
      const info = (props as { info?: { id?: string } }).info;
      return typeof info?.id === "string" ? info.id : undefined;
    }
    case "session.idle":
    case "session.error":
    case "message.part.delta":
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "session.status": {
      const sid = (props as { sessionID?: string }).sessionID;
      return typeof sid === "string" ? sid : undefined;
    }
    default:
      return undefined;
  }
}

export function extractStatusType(event: OpenCodeEvent): string | undefined {
  if (event.type !== "session.status") return undefined;
  const status = (event.properties as { status?: { type?: string } } | undefined)?.status;
  return typeof status?.type === "string" ? status.type : undefined;
}

export function extractRequestId(event: OpenCodeEvent): string | undefined {
  const props = event.properties ?? {};
  if (event.type === "permission.asked" || event.type === "question.asked") {
    const id = (props as { id?: string }).id;
    return typeof id === "string" ? id : undefined;
  }
  if (event.type === "permission.replied" || event.type === "question.replied") {
    const rid = (props as { requestID?: string }).requestID;
    return typeof rid === "string" ? rid : undefined;
  }
  return undefined;
}
export function isUserMessage(event: OpenCodeEvent): boolean {
  if (event.type !== "message.updated") return false;
  const info = (event.properties as { info?: { role?: string; parts?: unknown[] } } | undefined)?.info;
  if (info?.role !== "user") return false;
  // Ignore empty message shell creation events (without parts) to avoid premature timer arming.
  if (!info.parts || info.parts.length === 0) {
    return false;
  }
  return true;
}

export function isPingEvent(event: OpenCodeEvent, pingMessage: string): boolean {
  const props = event.properties ?? {};
  
  const isMatch = (text: string | undefined) => {
    if (!text) return false;
    // Apply bidirectional substring matching for 2 or more characters.
    // This handles streaming chunks (pingMessage contains text)
    // and full/extended messages containing reasons (text contains pingMessage),
    // while avoiding false positives from user text containing pingMessage.
    if (text.length >= 2) {
      return pingMessage.includes(text) || text.includes(pingMessage);
    }
    // For single character chunks, check if it is the start of the ping message.
    return pingMessage.startsWith(text);
  };

  if (event.type === "message.updated") {
    const info = (props as { info?: { parts?: Array<{ type: string; text?: string }> } }).info;
    if (info?.parts && info.parts.length > 0) {
      return isMatch(info.parts[0]?.text);
    }
  }
  if (event.type === "message.part.updated") {
    const part = (props as { part?: { text?: string } }).part;
    return isMatch(part?.text);
  }
  return false;
}

interface AgentNameSource {
  agent?: string;
  agentName?: string;
}

export function extractAgentName(event: OpenCodeEvent): string | undefined {
  const props = event.properties as
    | {
        info?: AgentNameSource;
        part?: AgentNameSource;
      }
    | undefined;
  return (
    props?.info?.agent ??
    props?.part?.agent ??
    props?.info?.agentName ??
    props?.part?.agentName
  );
}

interface PluginInputLike {
  client?: unknown;
  directory?: string;
  worktree?: string;
}

type PluginOptionsLike = Record<string, unknown>;

function readProjectConfig(
  options: PluginOptionsLike | undefined,
): ConfigSources {
  const sources: ConfigSources = {};
  if (!options) return sources;

  // Primary route: opencode.jsonc's `experimental.watchdog` namespace.
  const experimental = (options as { experimental?: { watchdog?: Partial<WatchdogConfig> } }).experimental;
  if (experimental?.watchdog && typeof experimental.watchdog === "object") {
    sources.experimental = { watchdog: experimental.watchdog };
  }

  // Compatibility alias: flat `watchdog` object.
  const fromKey = (options as { watchdog?: Partial<WatchdogConfig> }).watchdog;
  if (fromKey && typeof fromKey === "object") {
    sources.project = { ...sources.project, ...fromKey };
  }

  // Top-level fields fallback (less common but accepted).
  const candidate = options as Partial<WatchdogConfig>;
  if (
    typeof candidate.enabled === "boolean" ||
    typeof candidate.stage1Ms === "number" ||
    typeof candidate.stage2Ms === "number" ||
    typeof candidate.maxPings === "number" ||
    typeof candidate.pingMessage === "string" ||
    typeof candidate.notifierType === "string" ||
    typeof candidate.tmux === "object" ||
    typeof candidate.agents === "object" ||
    typeof candidate.suppressPingWhileToolRunning === "boolean" ||
    typeof candidate.maxToolGateCycles === "number" ||
    typeof candidate.subagentDisplay === "object" ||
    typeof candidate.subagentTermination === "object"
  ) {
    sources.project = { ...sources.project, ...candidate };
  }
  return sources;
}

export function extractMessageId(event: OpenCodeEvent): string | undefined {
  const props = event.properties ?? {};
  if (event.type === "message.updated") {
    const info = (props as { info?: { id?: string } }).info;
    return typeof info?.id === "string" ? info.id : undefined;
  }
  if (event.type === "message.part.updated") {
    const part = (props as { part?: { messageID?: string } }).part;
    return typeof part?.messageID === "string" ? part.messageID : undefined;
  }
  if (event.type === "message.part.delta") {
    const mid = (props as { messageID?: string }).messageID;
    return typeof mid === "string" ? mid : undefined;
  }
  return undefined;
}

function readAnySessionId(props: Record<string, unknown>): string | undefined {
  const direct = (props as { sessionID?: string }).sessionID;
  if (typeof direct === "string") return direct;
  const part = (props as { part?: { sessionID?: string } }).part;
  if (typeof part?.sessionID === "string") return part.sessionID;
  const info = (props as { info?: { sessionID?: string; id?: string } }).info;
  if (typeof info?.sessionID === "string") return info.sessionID;
  if (typeof info?.id === "string") return info.id;
  return undefined;
}

export function summarizeEvent(event: OpenCodeEvent): string {
  const props = (event.properties ?? {}) as Record<string, unknown>;
  const segs: string[] = [`type=${event.type}`];
  const sid = readAnySessionId(props);
  if (sid) segs.push(`sessionID=${sid}`);
  if (event.type === "message.part.updated") {
    const part = (props as { part?: { type?: string; state?: { status?: string } } }).part;
    if (part?.type) segs.push(`partType=${part.type}`);
    if (part?.state?.status) segs.push(`partStatus=${part.state.status}`);
  }
  return segs.join(" ");
}

export function logEvent(
  event: OpenCodeEvent,
  verbose: boolean,
  log: (level: "info" | "warn", message: string) => void,
): void {
  if (verbose) {
    log("info", `Event received (verbose): ${JSON.stringify(event)}`);
    return;
  }
  log("info", `Event: ${summarizeEvent(event)}`);
}

class BoundedSet<T> {
  private set = new Set<T>();
  constructor(private limit: number) {}

  has(value: T): boolean {
    return this.set.has(value);
  }

  /**
   * Adds a value to the set.
   * @returns true if the value was newly added, false if already present.
   */
  add(value: T): boolean {
    if (this.set.has(value)) return false;
    this.set.add(value);
    if (this.set.size > this.limit) {
      const oldest = this.set.keys().next().value;
      if (oldest !== undefined) {
        this.set.delete(oldest);
      }
    }
    return true;
  }
}

const IGNORED_PING_MESSAGE_IDS = new BoundedSet<string>(100);
const SEEN_USER_MESSAGE_IDS = new BoundedSet<string>(1000);

export function isNewUserMessage(messageId: string): boolean {
  return SEEN_USER_MESSAGE_IDS.add(messageId);
}

export type SessionErrorRoute =
  | { action: "note"; reason: "rate_limit" | "provider_timeout" }
  | { action: "stop" };

/**
 * Decides how a session.error should be handled: recoverable reasons
 * (rate_limit / provider_timeout) are "note" (keep watching, let the ping carry
 * the reason); everything else (unknown / unclassifiable) is "stop" (terminal),
 * preserving the legacy behavior.
 */
export function routeSessionError(properties: unknown): SessionErrorRoute {
  const reason = classifyError(properties);
  if (reason === "rate_limit" || reason === "provider_timeout") {
    return { action: "note", reason };
  }
  return { action: "stop" };
}

import * as fs from "node:fs";
import * as path from "node:path";

const LOG_FILE = (typeof process !== "undefined" ? process.env.HOME ?? "." : ".") + "/opencode-watchdog.log";

let fsWarningLogged = false;

function writeLog(level: "info" | "warn", message: string) {
  const ts = new Date().toISOString();
  const pid = typeof process !== "undefined" ? process.pid : "unknown";
  try {
    if (fs && typeof fs.appendFileSync === "function") {
      fs.appendFileSync(LOG_FILE, `[${ts}] [${level.toUpperCase()}] [PID:${pid}] ${message}\n`);
    } else if (!fsWarningLogged) {
      fsWarningLogged = true;
      console.warn("[watchdog] File system logging is unavailable in this environment (fs.appendFileSync is not a function). Falling back to console-only logging.");
    }
  } catch (err) {
    if (!fsWarningLogged) {
      fsWarningLogged = true;
      console.warn(`[watchdog] Failed to write to log file: ${String(err)}`);
    }
  }
}

const ACTIVE_INSTANCES = new Set<string>();

function parseReportMs(
  raw: string | undefined,
  log: (level: "info" | "warn", message: string) => void,
): number {
  const DEFAULT = 60_000;
  if (raw === undefined) return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    log("warn", `Invalid OPENCODE_WATCHDOG_REPORT_MS: "${raw}". Using default ${DEFAULT}ms.`);
    return DEFAULT;
  }
  return n;
}


function parseJsonc(content: string): any {
  return parse(content, [], { allowTrailingComma: true });
}

function getOpenCodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

function getBasePluginName(entry: string): string | null {
  if (entry === "@yohi/akane" || entry.startsWith("@yohi/akane@")) {
    return "@yohi/akane";
  }
  if (entry.startsWith("file:")) {
    const segments = entry.replace(/^file:\/\//, "").split(/[\\/]/);
    const basename = segments[segments.length - 1];
    if (basename === "akane" || basename.startsWith("akane-") || basename.startsWith("akane@")) {
      return "akane";
    }
  }
  return null;
}

function isAkanePlugin(entry: string): boolean {
  return getBasePluginName(entry) !== null;
}

function ensureTuiPluginEntry() {
  try {
    const configDir = getOpenCodeConfigDir();
    let serverConfig: any = null;
    const jsoncPath = join(configDir, "opencode.jsonc");
    const jsonPath = join(configDir, "opencode.json");
    
    if (existsSync(jsoncPath)) {
      serverConfig = parseJsonc(readFileSync(jsoncPath, "utf-8"));
    } else if (existsSync(jsonPath)) {
      serverConfig = JSON.parse(readFileSync(jsonPath, "utf-8"));
    }
    
    if (!serverConfig || !Array.isArray(serverConfig.plugin)) {
      return;
    }
    
    const ourServerEntry = serverConfig.plugin.find((entry: string) => {
      if (entry === "@yohi/akane" || entry.startsWith("@yohi/akane@")) return true;
      if (entry.startsWith("file:")) {
        const segments = entry.replace(/^file:\/\//, "").split(/[\\/]/);
        const basename = segments[segments.length - 1];
        return basename === "akane" || basename.startsWith("akane-") || basename.startsWith("akane@");
      }
      return false;
    });
    
    if (!ourServerEntry) {
      return;
    }
    
    const tuiJsonPath = join(configDir, "tui.json");
    let tuiConfig: any = { plugin: [] };
    if (existsSync(tuiJsonPath)) {
      try {
        tuiConfig = parseJsonc(readFileSync(tuiJsonPath, "utf-8"));
      } catch {
        tuiConfig = { plugin: [] };
      }
    }
    
    if (!tuiConfig || typeof tuiConfig !== "object") {
      tuiConfig = { plugin: [] };
    }
    if (!Array.isArray(tuiConfig.plugin)) {
      tuiConfig.plugin = [];
    }
    
    const hasAkane = tuiConfig.plugin.some((entry: string) => isAkanePlugin(entry));
    if (!hasAkane) {
      mkdirSync(configDir, { recursive: true });
      const originalText = existsSync(tuiJsonPath) ? readFileSync(tuiJsonPath, "utf-8") : "{}";
      const edits = modify(originalText, ["plugin"], [...tuiConfig.plugin, ourServerEntry], {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        }
      });
      const updatedText = applyEdits(originalText, edits);
      writeFileSync(tuiJsonPath, updatedText.trim() + "\n");
    }
  } catch (err) {
    console.warn("[watchdog] Failed to ensure TUI plugin entry in tui.json:", err);
  }
}

const plugin = async (input: PluginInputLike, options?: PluginOptionsLike & { _watchdog?: Watchdog }) => {
  ensureTuiPluginEntry();
  const instanceId = Math.random().toString(36).substring(2, 8);
  const instLog = (level: "info" | "warn", message: string) => {
    writeLog(level, `[Inst:${instanceId}] ${message}`);
  };

  const projectConfig = readProjectConfig(options);
  const env = (typeof process !== "undefined" ? process.env : {}) as Record<
    string,
    string | undefined
  >;

  const config = resolveConfig({ ...projectConfig, env });
  const metaUrl = import.meta.url;
  const inputDir = input.directory;
  const stateDir = input.worktree ?? input.directory;
  if (inputDir && ACTIVE_INSTANCES.has(inputDir)) {
    instLog("warn", `Duplicate plugin initialization blocked for directory: ${inputDir} (metaUrl: ${metaUrl})`);
    return {
      event: async () => {},
      dispose: async () => {},
    };
  }
  if (inputDir) {
    ACTIVE_INSTANCES.add(inputDir);
  }

  instLog("info", `Watchdog plugin initialized! Resolved Config: ${JSON.stringify(config)} (metaUrl: ${metaUrl}, inputDir: ${inputDir}, stateDir: ${stateDir})`);

  const debugEnabled = env.AKANE_DEBUG === "true";
  if (debugEnabled && stateDir) {
    try {
      fs.mkdirSync(path.join(stateDir, ".akane"), { recursive: true });
    } catch {
      // ignore init directory creation errors
    }
  }

  const debugLog = (message: string) => {
    if (!debugEnabled || !stateDir) return;
    try {
      fs.appendFileSync(path.join(stateDir, ".akane", "watchdog-debug.log"), `${new Date().toISOString()} ${message}\n`);
    } catch {
      // ignore debug logging errors
    }
  };
  debugLog(`INIT inputDir=${inputDir} stateDir=${stateDir} config=${JSON.stringify(config)}`);

  const clock = new RealClock();
  const pinger = new OpenCodeAdapter(input?.client, debugLog);
  const notifier = createNotifier(config.notifierType, {
    env,
    spawn: bunSpawn(),
    which: bunWhich(),
    // `process` is guaranteed under Bun/Node, but the guard keeps this safe in any
    // non-Node test/CI harness; "linux" is the default OS-notifier target there.
    platform: typeof process !== "undefined" ? process.platform : "linux",
    log: instLog,
  });
  const telemetry = new TelemetryCollector();
  const stateStore = stateDir ? getStateStore(stateDir) : undefined;
  const watchdog = options?._watchdog ?? new Watchdog({
    config,
    clock,
    pinger,
    notifier,
    telemetry,
    log: instLog,
    stateStore,
  });

  const reportMs = parseReportMs(env.OPENCODE_WATCHDOG_REPORT_MS, instLog);
  const stopReporter = config.enabled
    ? startTelemetryReporter({
        clock,
        telemetry,
        intervalMs: reportMs,
        log: instLog,
      })
    : undefined;

  return {
    event: async ({ event }: { event: OpenCodeEvent }) => {
      try {
        logEvent(event, config.verboseLog, instLog);
        if (!config.enabled) {
          instLog("info", `Event ignored (disabled)`);
          return;
        }
        const sessionId = extractSessionId(event);
        debugLog(`EVENT type=${event.type} sessionId=${sessionId ?? "-"}`);


        if (event.type === "session.created" || event.type === "session.updated") {
          instLog("info", `Event ignored (informational session event)`);
          return;
        }

        if (
          event.type === "session.deleted" ||
          event.type === "session.idle"
        ) {
          instLog("info", `Stop event received for session ${sessionId}`);
          if (sessionId) watchdog.stop(sessionId);
          return;
        }

        if (event.type === "session.error") {
          instLog("info", `Error event received for session ${sessionId}`);
          if (sessionId) {
            const route = routeSessionError(event.properties);
            if (route.action === "note") {
              watchdog.noteError(sessionId, route.reason);
            } else {
              watchdog.stop(sessionId);
            }
          }
          return;
        }

        if (!sessionId) {
          instLog("info", `Event ignored (no sessionId found)`);
          return;
        }

        if (event.type === "session.status") {
          const statusType = extractStatusType(event);
          if (statusType === "retry") {
            watchdog.onStatusRetry(sessionId);
          } else if (statusType === "busy") {
            watchdog.onStatusActive(sessionId);
          }
          // "idle" is auxiliary; session.idle event is the primary stop signal.
          return;
        }

        // --- Input-Wait Gating (Priority 1, user-message-equivalent) ---
        if (event.type === "permission.asked" || event.type === "question.asked") {
          const requestId = extractRequestId(event);
          if (requestId) {
            watchdog.onInputRequested(sessionId, requestId);
          } else {
            instLog("warn", `${event.type}: requestId not found, watchdog not paused (timer continues)`);
          }
          return;
        }
        if (event.type === "permission.replied" || event.type === "question.replied") {
          const requestId = extractRequestId(event);
          if (requestId) {
            watchdog.onInputResolved(sessionId, requestId);
          } else {
            instLog("warn", `${event.type}: requestId not found, watchdog not resumed`);
          }
          return;
        }
        const messageId = extractMessageId(event);

        if (messageId && IGNORED_PING_MESSAGE_IDS.has(messageId)) {
          instLog("info", `Event ignored (belongs to IGNORED_PING_MESSAGE_IDS: ${messageId})`);
          // Ignore any follow-up events (like step-start, error, or queuing status updates)
          // related to a self-injected ping message.
          return;
        }

        // --- Human Intervention Bypass (Priority 1) ---
        // We handle user-originated messages and typing first so they bypass BOTH the ping-filter
        // and the arm-lock. This ensures that if a user types something that happens to contain
        // ping keywords, or if they intervene during the arm-lock period, the watchdog still resets.
        const isManualUserMessage = isUserMessage(event);
        const agentName = extractAgentName(event);
        const partText =
          event.type === "message.part.updated"
            ? (event.properties as { part?: { text?: string } } | undefined)?.part?.text
            : undefined;
        const isUserTyping =
          event.type === "message.part.updated" &&
          agentName === undefined &&
          typeof partText === "string" &&
          partText.length > 0;

        if (isManualUserMessage || isUserTyping) {
          if (messageId && !SEEN_USER_MESSAGE_IDS.add(messageId)) {
            instLog("info", `Event ignored (already seen user message/typing: ${messageId})`);
            return;
          }
          instLog(
            "info",
            `Event triggered onUserMessage (bypassing arm lock) for session ${sessionId} (messageId: ${messageId})`,
          );
          debugLog(`ACTION onUserMessage sessionId=${sessionId} source=${isManualUserMessage ? "manual" : "typing"}`);
          watchdog.onUserMessage(sessionId, { agentName });
          return;
        }

        // --- Self-Injected Ping Filtering (Priority 2) ---
        if (isPingEvent(event, config.pingMessage)) {
          instLog("info", `Event ignored (identified as self-injected ping event)`);
          if (messageId) {
            IGNORED_PING_MESSAGE_IDS.add(messageId);
          }
          // Ignore self-injected ping messages completely to prevent infinite loops.
          return;
        }

        // --- Arm Lock (Priority 3) ---
        // Lock window: Block all arming/resets during the stage2 window * 2 (minimum 30 seconds) after a ping injection.
        // This completely prevents late API timeouts, queue updates, or error messages (which typically
        // take 10-30s) from re-arming the watchdog during the recovery assessment phase.
        // Note: Fresh user messages bypass this lock to allow manual recovery.
        const lastPingTime = watchdog.getLastPingTime(sessionId);
        const nowTime = clock.now();
        const lockDuration = Math.max(config.stage2Ms * 2, 30000);
        if (lastPingTime > 0 && nowTime - lastPingTime < lockDuration) {
          instLog(
            "info",
            `Event blocked by arm lock (lastPing: ${lastPingTime}, now: ${nowTime}, lockDuration: ${lockDuration})`,
          );
          if (messageId) {
            IGNORED_PING_MESSAGE_IDS.add(messageId);
          }
          return;
        }

        // --- Assistant Activity & Other Events (Priority 4) ---

        // Ignore empty user message updated events (shell creation or ping initialization)
        // to prevent them from falling through to the assistant activity fallback below.
        if (event.type === "message.updated") {
          const info = (event.properties as { info?: { role?: string } } | undefined)?.info;
          if (info?.role === "user") {
            instLog("info", `Event ignored (empty user message update shell)`);
            return;
          }
        }

        if (event.type === "message.part.delta") {
          // If this is an assistant event (has agent name), treat as activity to refresh stage1.
          if (agentName !== undefined) {
            instLog("info", `Event triggered onActivity (stream delta) for session ${sessionId}`);
            debugLog(`ACTION onActivity (delta) sessionId=${sessionId} agentName=${agentName}`);
            watchdog.onActivity(sessionId, { agentName });
            return;
          }
          instLog("info", `Event ignored (message.part.delta not matching activity criteria)`);
          return;
        }

        if (event.type === "message.part.updated") {
          const toolPart = (event.properties as {
            part?: { type?: string; callID?: string; state?: { status?: string } };
          } | undefined)?.part;
          if (toolPart?.type === "tool") {
            const status = toolPart.state?.status;
            const callId = toolPart.callID;
            if (status === "running" && callId) {
              instLog("info", `Tool running for session ${sessionId} (callID: ${callId})`);
              watchdog.onToolRunning(sessionId, callId);
              return;
            }
            if ((status === "completed" || status === "error") && callId) {
              instLog("info", `Tool settled (${status}) for session ${sessionId} (callID: ${callId})`);
              watchdog.onToolSettled(sessionId, callId);
              return;
            }
            if (status === "completed" || status === "error") {
              // callId が欠落した settled イベントは runningTools から削除できないため警告する。
              // 実際の OpenCode イベントでは callID は必ず存在するはずだが、防御的に記録する。
              instLog("warn", `Tool ${status} received without callID for session ${sessionId} — runningTools not cleared`);
            }
            // pending = active but not yet running → refresh stage1 without tracking.
            instLog("info", `Tool pending for session ${sessionId}`);
            watchdog.onActivity(sessionId, { agentName });
            return;
          }
          // If this is an assistant event (has agent name), treat as activity to refresh stage1.
          if (agentName !== undefined) {
            instLog(
              "info",
              `Event triggered onActivity (assistant part update) for session ${sessionId}`,
            );
            debugLog(`ACTION onActivity (part) sessionId=${sessionId} agentName=${agentName}`);
            watchdog.onActivity(sessionId, { agentName });
            return;
          }
          instLog("info", `Event ignored (message.part.updated not matching activity criteria)`);
          return;
        }

        // message.updated (assistant only): treat as activity to refresh stage1.
        // We explicitly ignore user (already handled or discarded above) and system/error updates.
        if (event.type === "message.updated") {
          const info = (event.properties as { info?: { role?: string } } | undefined)?.info;
          if (info?.role === "assistant") {
            instLog("info", `Event triggered onActivity (assistant message update) for session ${sessionId}`);
            watchdog.onActivity(sessionId, { agentName: extractAgentName(event) });
            return;
          }
        }
      } catch (err) {
        console.warn("[watchdog] event hook error (containment):", err);
      }
    },
    dispose: async () => {
      if (inputDir) {
        ACTIVE_INSTANCES.delete(inputDir);
      }
      try {
        if (typeof stopReporter === "function") {
          stopReporter();
        }
      } catch (err) {
        instLog("warn", `Error stopping telemetry reporter: ${String(err)}`);
      }
      try {
        watchdog.stopAll();
      } catch (err) {
        instLog("warn", `Error stopping watchdog: ${String(err)}`);
      }
      try {
        stateStore?.dispose();
      } catch (err) {
        instLog("warn", `Error disposing state store: ${String(err)}`);
      }
      if (config.enabled) {
        try {
          instLog("info", telemetry.report());
        } catch (err) {
          console.warn("[watchdog] telemetry report error in dispose:", err);
        }
      }
    },
  };
};

export default {
  id: "opencode-watchdog",
  server: plugin
};
