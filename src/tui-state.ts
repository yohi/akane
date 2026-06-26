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
