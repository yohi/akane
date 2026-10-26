import type { SharedWatchdogState, WatchdogSessionState } from "./shared-state";
import { isSharedWatchdogState } from "./shared-state";
import * as fs from "node:fs";
import * as path from "node:path";

const STATE_DIR_NAME = ".akane";
const STATE_FILE_NAME = "watchdog-state.json";

export function stateFilePath(directory: string): string {
  return path.join(directory, STATE_DIR_NAME, STATE_FILE_NAME);
}

export function readSharedState(filePath: string): SharedWatchdogState | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isSharedWatchdogState(parsed)) {
      return parsed;
    }
  } catch {
    // Missing or corrupt state is normal before the server plugin has written it.
  }
  return undefined;
}

/** Show only the worktree directory name; keep the full path for internal operations. */
export function formatWorktreePath(worktree: string | undefined): string {
  if (!worktree?.trim()) return "-";
  return path.basename(worktree) || "-";
}

export type SharedStateHealth = "ready" | "unavailable" | "stale";

export function sharedStateHealth(state: SharedWatchdogState | undefined, now: number): SharedStateHealth {
  if (state === undefined) return "unavailable";
  if (state.timestamp > now + 30_000 || now - state.timestamp > 90_000) return "stale";
  return "ready";
}

export function formatLiveMetric(value: number | undefined, health: SharedStateHealth): string {
  return health === "ready" ? String(value ?? 0) : "-";
}

/** Prefer the freshest valid local state when server/TUI worktree roots differ. */
export function newestSharedState(
  primary: SharedWatchdogState | undefined,
  alternate: SharedWatchdogState | undefined,
): SharedWatchdogState | undefined {
  if (!primary) return alternate;
  if (!alternate) return primary;
  return alternate.timestamp > primary.timestamp ? alternate : primary;
}

export function formatCurrentSessionState(
  state: WatchdogSessionState | undefined,
  health: SharedStateHealth,
): string {
  if (health === "unavailable") return "Unavailable";
  if (health === "stale") return "Stale";
  return state === undefined ? "Not tracked" : formatSessionState(state);
}

export function formatSessionState(state: WatchdogSessionState | undefined): string {
  switch (state) {
    case "WATCHING":
      return "Watching";
    case "STAGE1_NOTIFIED":
      return "Stage 1";
    case "PINGED":
      return "Pinged";
    case "SILENCED":
      return "Silenced";
    case "PAUSED":
      return "Paused";
    case "IDLE":
      return "Idle";
    default:
      return "Unknown";
  }
}

export function formatTimestamp(ts: number | undefined, now: number): string {
  if (!ts) return "-";
  const diffSec = Math.floor((now - ts) / 1000);
  if (diffSec < 0) return "future";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

export function resolveAgentDisplayColor<TColor>(
  agentName: string | undefined,
  options: {
    fallback: TColor;
    profileColors: Record<string, TColor | undefined>;
  },
): TColor {
  if (!agentName) return options.fallback;
  return options.profileColors[agentName] ?? options.fallback;
}

export function colorStyleProps<TColor>(fg: TColor): { style: { fg: TColor } } {
  return { style: { fg } };
}
