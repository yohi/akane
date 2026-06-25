import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  formatSessionState,
  formatTimestamp,
  readSharedState,
  stateFilePath,
} from "../src/tui-state";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akane-tui-state-"));
}

describe("TUI helpers", () => {
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
