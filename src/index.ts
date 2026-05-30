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
import { OpenCodeAdapter } from "./pinger";
import { TmuxNotifier, bunSpawn, bunWhich } from "./notifier";
import { resolveConfig, type WatchdogConfig } from "./config";

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
    case "session.error": {
      // SDK 実測: properties.sessionID 直接。session.error は optional。
      const sid = (props as { sessionID?: string }).sessionID;
      return typeof sid === "string" ? sid : undefined;
    }
    default:
      return undefined;
  }
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
    // Apply substring matching for 2 or more characters.
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

function extractAgentName(event: OpenCodeEvent): string | undefined {
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
}

type PluginOptionsLike = Record<string, unknown>;

function readProjectConfig(
  options: PluginOptionsLike | undefined,
): Partial<WatchdogConfig> | undefined {
  if (!options) return undefined;
  const fromKey = (options as { watchdog?: Partial<WatchdogConfig> }).watchdog;
  if (fromKey && typeof fromKey === "object") return fromKey;
  // Top-level fields fallback (less common but accepted).
  const candidate = options as Partial<WatchdogConfig>;
  if (
    typeof candidate.enabled === "boolean" ||
    typeof candidate.stage1Ms === "number" ||
    typeof candidate.stage2Ms === "number" ||
    typeof candidate.maxPings === "number" ||
    typeof candidate.pingMessage === "string" ||
    typeof candidate.tmux === "object" ||
    typeof candidate.agents === "object"
  ) {
    return candidate;
  }
  return undefined;
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
  return undefined;
}

const IGNORED_PING_MESSAGE_IDS = new Set<string>();
const IGNORED_PING_MESSAGE_IDS_LIMIT = 100;

function recordIgnoredPingMessageId(messageId: string) {
  if (IGNORED_PING_MESSAGE_IDS.has(messageId)) return;
  IGNORED_PING_MESSAGE_IDS.add(messageId);
  if (IGNORED_PING_MESSAGE_IDS.size > IGNORED_PING_MESSAGE_IDS_LIMIT) {
    const oldest = IGNORED_PING_MESSAGE_IDS.keys().next().value;
    if (oldest !== undefined) {
      IGNORED_PING_MESSAGE_IDS.delete(oldest);
    }
  }
}

const SEEN_USER_MESSAGE_IDS = new Set<string>();
const SEEN_USER_MESSAGE_IDS_LIMIT = 1000;

export function isNewUserMessage(messageId: string): boolean {
  if (SEEN_USER_MESSAGE_IDS.has(messageId)) return false;
  SEEN_USER_MESSAGE_IDS.add(messageId);
  if (SEEN_USER_MESSAGE_IDS.size > SEEN_USER_MESSAGE_IDS_LIMIT) {
    const oldest = SEEN_USER_MESSAGE_IDS.keys().next().value;
    if (oldest !== undefined) {
      SEEN_USER_MESSAGE_IDS.delete(oldest);
    }
  }
  return true;
}

import * as fs from "node:fs";

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

const plugin = async (input: PluginInputLike, options?: PluginOptionsLike) => {
  const instanceId = Math.random().toString(36).substring(2, 8);
  const instLog = (level: "info" | "warn", message: string) => {
    writeLog(level, `[Inst:${instanceId}] ${message}`);
  };

  const projectConfig = readProjectConfig(options);
  const env = (typeof process !== "undefined" ? process.env : {}) as Record<
    string,
    string | undefined
  >;

  const config = resolveConfig({ project: projectConfig, env });
  const metaUrl = import.meta.url;
  const inputDir = (input as { directory?: string })?.directory;

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

  instLog("info", `Watchdog plugin initialized! Resolved Config: ${JSON.stringify(config)} (metaUrl: ${metaUrl}, inputDir: ${inputDir})`);

  const clock = new RealClock();
  const pinger = new OpenCodeAdapter(input?.client);
  const notifier = new TmuxNotifier({
    env,
    spawn: bunSpawn(),
    which: bunWhich(),
    log: instLog,
  });
  const watchdog = new Watchdog({
    config,
    clock,
    pinger,
    notifier,
    log: instLog,
  });

  return {
    event: async ({ event }: { event: OpenCodeEvent }) => {
      try {
        instLog("info", `Event received: ${JSON.stringify(event)}`);
        if (!config.enabled) {
          instLog("info", `Event ignored (disabled)`);
          return;
        }
        const sessionId = extractSessionId(event);

        if (event.type === "session.created" || event.type === "session.updated") {
          instLog("info", `Event ignored (informational session event)`);
          return;
        }

        if (
          event.type === "session.deleted" ||
          event.type === "session.idle" ||
          event.type === "session.error"
        ) {
          instLog("info", `Stop event received for session ${sessionId}`);
          if (sessionId) watchdog.stop(sessionId);
          return;
        }

        if (!sessionId) {
          instLog("info", `Event ignored (no sessionId found)`);
          return;
        }

        const messageId = extractMessageId(event);

        if (messageId && IGNORED_PING_MESSAGE_IDS.has(messageId)) {
          instLog("info", `Event ignored (belongs to IGNORED_PING_MESSAGE_IDS: ${messageId})`);
          // Ignore any follow-up events (like step-start, error, or queuing status updates)
          // related to a self-injected ping message.
          return;
        }

        if (isPingEvent(event, config.pingMessage)) {
          instLog("info", `Event ignored (identified as self-injected ping event)`);
          if (messageId) {
            recordIgnoredPingMessageId(messageId);
          }
          // Ignore self-injected ping messages completely to prevent infinite loops.
          return;
        }

        if (isUserMessage(event)) {
          if (messageId && !isNewUserMessage(messageId)) {
            instLog("info", `Event ignored (already seen user message: ${messageId})`);
            return;
          }
          instLog("info", `Event triggered onUserMessage (bypassing arm lock) for session ${sessionId} (messageId: ${messageId})`);
          watchdog.onUserMessage(sessionId, { agentName: extractAgentName(event) });
          return;
        }

        // Lock window: Block all arming/resets during the stage2 window * 2 (minimum 30 seconds) after a ping injection.
        // This completely prevents late API timeouts, queue updates, or error messages (which typically
        // take 10-30s) from re-arming the watchdog during the recovery assessment phase.
        // Note: Fresh user messages bypass this lock to allow manual recovery.
        const lastPingTime = watchdog.getLastPingTime(sessionId);
        const nowTime = clock.now();
        const lockDuration = Math.max(config.stage2Ms * 2, 30000);
        if (lastPingTime > 0 && nowTime - lastPingTime < lockDuration) {
          instLog("info", `Event blocked by arm lock (lastPing: ${lastPingTime}, now: ${nowTime}, lockDuration: ${lockDuration})`);
          if (messageId) {
            recordIgnoredPingMessageId(messageId);
          }
          return;
        }

        // Ignore empty user message updated events (shell creation or ping initialization)
        // to prevent them from falling through to the assistant activity fallback below.
        if (event.type === "message.updated") {
          const info = (event.properties as { info?: { role?: string } } | undefined)?.info;
          if (info?.role === "user") {
            instLog("info", `Event ignored (empty user message update shell)`);
            return;
          }
        }

        if (event.type === "message.part.updated") {
          const part = (event.properties as { part?: { text?: string } } | undefined)?.part;
          const agentName = extractAgentName(event);

          // If this is an assistant event (has agent name), treat as activity to refresh stage1.
          if (agentName !== undefined) {
            instLog("info", `Event triggered onActivity (assistant part update) for session ${sessionId}`);
            watchdog.onActivity(sessionId, { agentName });
            return;
          }

          // For user-originated part updates, only treat as activity if it has non-empty text
          // (which means a real user is typing, as ping messages are already ignored).
          // Empty updates (like queue status changes or empty shells) are ignored.
          // Note: We use onUserMessage here instead of onActivity so that user typing or sending
          // a message can successfully restore the session from SILENCED state.
          if (part && typeof part.text === "string" && part.text.length > 0) {
            instLog("info", `Event triggered onUserMessage (user typing part update) for session ${sessionId}`);
            watchdog.onUserMessage(sessionId, { agentName });
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
      watchdog.stopAll();
    },
  };
};

export default {
  id: "opencode-watchdog",
  server: plugin
};
