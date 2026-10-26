import { describe, it, expect } from "bun:test";
import { isActiveChildSession, isSessionPartUpdate, normalizeSessionChildren } from "../src/tui-helpers";
import type { Session } from "@opencode-ai/sdk/v2";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  colorStyleProps,
  formatSessionState,
  formatWorktreePath,
  formatTimestamp,
  resolveAgentDisplayColor,
  readSharedState,
  stateFilePath,
} from "../src/tui-state";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akane-tui-state-"));
}

describe("TUI helpers", () => {
  it("normalizes the v1 SDK session.children response and rejects malformed entries", () => {
    const child = { id: "child", parentID: "parent", agent: "coder", time: { created: 100, updated: 110 } };
    expect(normalizeSessionChildren({ data: [child, {}, null] })).toEqual([child]);
    expect(normalizeSessionChildren([child])).toEqual([child]);
    expect(normalizeSessionChildren({ error: "offline" })).toEqual([]);
  });

  it("distinguishes active, idle and stale child sessions", () => {
    const now = 100_000;
    const child = { id: "child", parentID: "parent", agent: "coder", time: { created: 100, updated: now - 10_000 } } as unknown as Session;
    expect(isActiveChildSession(child, "parent", "busy", now, false)).toBe(true);
    expect(isActiveChildSession(child, "parent", "retry", now, false)).toBe(true);
    expect(isActiveChildSession(child, "parent", "idle", now, false)).toBe(false);
    expect(isActiveChildSession(child, "parent", undefined, now, false)).toBe(true);
    expect(isActiveChildSession(child, "parent", undefined, now, true)).toBe(false);
    expect(isActiveChildSession(child, "other", "busy", now, false)).toBe(false);
    const stale = { ...child, time: { ...child.time, updated: now - 120_000 } };
    expect(isActiveChildSession(stale, "parent", undefined, now, false)).toBe(false);
  });


  it("correlates part updates via properties.part.sessionID, not the top-level properties", () => {
    const event = { properties: { part: { sessionID: "parent-1" } } };
    expect(isSessionPartUpdate(event, "parent-1")).toBe(true);
    expect(isSessionPartUpdate(event, "other-parent")).toBe(false);
  });


  it("shows only the worktree directory name, including spaces", () => {
    expect(formatWorktreePath("/home/user/my project/.worktrees/feature-1")).toBe("feature-1");
    expect(formatWorktreePath("/home/user/my project/.worktrees/feature one/")).toBe("feature one");
    expect(formatWorktreePath("/home/user/projects/akane")).toBe("akane");
  });

  it("uses a placeholder if the worktree root is unavailable", () => {
    expect(formatWorktreePath(undefined)).toBe("-");
    expect(formatWorktreePath("")).toBe("-");
    expect(formatWorktreePath("   ")).toBe("-");
    expect(formatWorktreePath("/")).toBe("-");
  });

  it("formats session states", () => {
    expect(formatSessionState("WATCHING")).toBe("Watching");
    expect(formatSessionState("STAGE1_NOTIFIED")).toBe("Stage 1");
    expect(formatSessionState("PINGED")).toBe("Pinged");
    expect(formatSessionState("SILENCED")).toBe("Silenced");
    expect(formatSessionState("PAUSED")).toBe("Paused");
    expect(formatSessionState("IDLE")).toBe("Idle");
    expect(formatSessionState(undefined)).toBe("Unknown");
  });

  it("formats timestamps relative to now", () => {
    const now = Date.now();
    expect(formatTimestamp(undefined, now)).toBe("-");
    expect(formatTimestamp(now - 5000, now)).toBe("5s ago");
    expect(formatTimestamp(now - 120000, now)).toBe("2m ago");
    expect(formatTimestamp(now - 7200000, now)).toBe("2h ago");
  });

  it("uses configured agent profile color before freshness color", () => {
    const fallback = { r: 0, g: 255, b: 0, a: 255 };
    const profileColor = { r: 0, g: 206, b: 209, a: 255 };

    expect(
      resolveAgentDisplayColor("Sisyphus - Ultraworker", {
        fallback,
        profileColors: { "Sisyphus - Ultraworker": profileColor },
      }),
    ).toEqual(profileColor);
  });

  it("falls back when the agent has no configured profile color", () => {
    const fallback = { r: 255, g: 203, b: 71, a: 255 };

    expect(
      resolveAgentDisplayColor("worker", {
        fallback,
        profileColors: {},
      }),
    ).toEqual(fallback);
  });

  it("passes colors through OpenTUI Solid style.fg", () => {
    const fg = { r: 0, g: 206, b: 209, a: 255 };

    expect(colorStyleProps(fg)).toEqual({ style: { fg } });
  });
});

describe("TUI shared-state reader", () => {
  it("computes the state file path under .akane", () => {
    const dir = "/tmp/project";
    expect(stateFilePath(dir)).toBe("/tmp/project/.akane/watchdog-state.json");
  });

  it("returns undefined when state file is missing", () => {
    const dir = tmpDir();
    try {
      expect(readSharedState(stateFilePath(dir))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses a valid shared state file", () => {
    const dir = tmpDir();
    try {
      const filePath = stateFilePath(dir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          enabled: true,
          timestamp: 12345,
          global: {
            hangupsDetected: 1,
            pingsSent: 2,
            recoveries: 3,
            silencedFailures: 4,
          },
          sessions: {
            "sess-1": {
              state: "WATCHING",
              runningToolsCount: 0,
              pendingRequestsCount: 0,
            },
          },
        }),
      );
      const parsed = readSharedState(filePath);
      expect(parsed).toBeDefined();
      expect(parsed?.enabled).toBe(true);
      expect(parsed?.global.pingsSent).toBe(2);
      expect(parsed?.sessions["sess-1"]?.state).toBe("WATCHING");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for malformed state files", () => {
    const dir = tmpDir();
    try {
      const filePath = stateFilePath(dir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "not json");
      expect(readSharedState(filePath)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
