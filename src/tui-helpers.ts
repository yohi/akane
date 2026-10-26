import { RGBA } from "@opentui/core";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Agent, Session } from "@opencode-ai/sdk/v2";

/** OpenCode v1 message.part.updated stores the session ID in properties.part. */
export function isSessionPartUpdate(
  event: { properties: { part: { sessionID: string } } },
  sessionId: string,
): boolean {
  return event.properties.part.sessionID === sessionId;
}

/** Normalize OpenCode SDK field-style and data-style response formats. */
export function normalizeSessionChildren(response: unknown): Session[] {
  let value: unknown;
  if (Array.isArray(response)) {
    value = response;
  } else if (response && typeof response === "object" && "data" in response) {
    value = (response as { data: unknown }).data;
  }
  if (!Array.isArray(value)) return [];
  return value.filter((session): session is Session =>
    !!session && typeof session === "object" &&
    typeof session.id === "string" &&
    typeof session.parentID === "string" &&
    typeof session.time?.created === "number",
  );
}

/** An absent host status is not proof of activity: use a bounded recent-update fallback. */
export function isActiveChildSession(
  session: Session,
  parentId: string,
  status: string | undefined,
  nowMs: number,
  stopped: boolean,
): boolean {
  if (session.parentID !== parentId || !session.agent || session.agent === "user" || session.agent === "system") {
    return false;
  }
  if (stopped || status === "idle") return false;
  if (status === "busy" || status === "retry") return true;
  const lastSeen = session.time.updated ?? session.time.created;
  return lastSeen <= nowMs && nowMs - lastSeen < SUBAGENT_IDLE_MS;
}

export function applySessionUpdate(
  sessions: Record<string, Session>,
  info: Session,
  deletedSessionIds: Set<string>,
  eventType: "created" | "updated",
): Record<string, Session> {
  if (eventType === "created") deletedSessionIds.delete(info.id);
  else if (deletedSessionIds.has(info.id)) return sessions;

  return { ...sessions, [info.id]: info };
}

export const SUBAGENT_IDLE_MS = 60_000;
export const SUBAGENT_FRESH_MS = 30_000;

export interface AgentEntry {
  name: string;
  firstSeen: number;
  lastSeen: number;
}

export interface SubagentEntry {
  key: string;
  name: string;
  source: "session" | "event";
  firstSeen: number;
  lastSeen: number;
  category?: string;
}

export function recordAgent(
  record: Record<string, AgentEntry>,
  name: string,
): Record<string, AgentEntry> {
  const now = Date.now();
  const existing = record[name];
  return {
    ...record,
    [name]: {
      name,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    },
  };
}

export function formatElapsedSeconds(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${seconds}s`;
}

export function subagentColor(
  elapsedMs: number,
  theme: { success: RGBA; warning: RGBA; error: RGBA },
): RGBA {
  if (elapsedMs < SUBAGENT_FRESH_MS) return theme.success;
  if (elapsedMs < SUBAGENT_IDLE_MS) return theme.warning;
  return theme.error;
}

function themeColor(name: string, theme: TuiPluginApi["theme"]["current"]): RGBA | undefined {
  switch (name) {
    case "primary":
      return theme.primary;
    case "secondary":
      return theme.secondary;
    case "accent":
      return theme.accent;
    case "success":
      return theme.success;
    case "warning":
      return theme.warning;
    case "error":
      return theme.error;
    case "info":
      return theme.info;
    default:
      return undefined;
  }
}

export function agentColorToRgba(color: string, theme: TuiPluginApi["theme"]["current"]): RGBA | undefined {
  const themed = themeColor(color, theme);
  if (themed) return themed;
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) return undefined;
  return RGBA.fromHex(color);
}

export function normalizeAgentsResponse(response: Awaited<ReturnType<TuiPluginApi["client"]["app"]["agents"]>>): Agent[] {
  if (Array.isArray(response)) return response;
  if (response && "data" in response && Array.isArray(response.data)) return response.data;
  return [];
}
