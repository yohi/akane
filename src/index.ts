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
  const info = (event.properties as { info?: { role?: string } } | undefined)?.info;
  return info?.role === "user";
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
    typeof candidate.stage2Ms === "number"
  ) {
    return candidate;
  }
  return undefined;
}

const plugin = async (input: PluginInputLike, options?: PluginOptionsLike) => {
  const projectConfig = readProjectConfig(options);
  const env = (typeof process !== "undefined" ? process.env : {}) as Record<
    string,
    string | undefined
  >;

  const config = resolveConfig({ project: projectConfig, env });

  const clock = new RealClock();
  const pinger = new OpenCodeAdapter(input?.client);
  const notifier = new TmuxNotifier({
    env,
    spawn: bunSpawn(),
    which: bunWhich(),
  });
  const watchdog = new Watchdog({ config, clock, pinger, notifier });

  return {
    event: async ({ event }: { event: OpenCodeEvent }) => {
      try {
        if (!config.enabled) return;
        const sessionId = extractSessionId(event);

        if (event.type === "session.created" || event.type === "session.updated") {
          // Informational only per design §2.3.
          return;
        }

        if (
          event.type === "session.deleted" ||
          event.type === "session.idle" ||
          event.type === "session.error"
        ) {
          if (sessionId) watchdog.stop(sessionId);
          return;
        }

        if (!sessionId) return;

        if (isUserMessage(event)) {
          watchdog.onUserMessage(sessionId, { agentName: extractAgentName(event) });
          return;
        }

        if (event.type === "message.part.updated") {
          watchdog.onActivity(sessionId, { agentName: extractAgentName(event) });
          return;
        }

        // message.updated (assistant or other): treat as activity to refresh stage1.
        if (event.type === "message.updated") {
          watchdog.onActivity(sessionId, { agentName: extractAgentName(event) });
          return;
        }
      } catch (err) {
        console.warn("[watchdog] event hook error (containment):", err);
      }
    },
    dispose: async () => {
      watchdog.stopAll();
    },
  };
};

export default plugin;
