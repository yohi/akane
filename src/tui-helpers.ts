import { RGBA } from "@opentui/core";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Agent } from "@opencode-ai/sdk/v2";

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
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) return undefined;
  return RGBA.fromHex(color);
}

export function normalizeAgentsResponse(response: Awaited<ReturnType<TuiPluginApi["client"]["app"]["agents"]>>): Agent[] {
  if (Array.isArray(response)) return response;
  if (response && "data" in response && Array.isArray(response.data)) return response.data;
  return [];
}
