import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  WatchdogStateStore,
  getStateStore,
  clearStateStoreCache,
} from "../src/shared-state";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akane-shared-state-"));
}

describe("WatchdogStateStore", () => {
  it("isolates two worktree state files and retains counters across store recreation", () => {
    const firstDir = tmpDir();
    const secondDir = tmpDir();
    try {
      const first = getStateStore(firstDir);
      const second = getStateStore(secondDir);
      first.setSession("session-first", {
        state: "WATCHING", runningToolsCount: 1, pendingRequestsCount: 0,
      });
      first.setGlobal({ hangupsDetected: 6, pingsSent: 3, recoveries: 2, silencedFailures: 1 });
      second.setSession("session-second", {
        state: "WATCHING", runningToolsCount: 0, pendingRequestsCount: 0,
      });
      first.dispose();
      second.dispose();
      const restartedFirst = getStateStore(firstDir);
      const restartedSecond = getStateStore(secondDir);
      expect(restartedFirst.getSnapshot().sessions["session-first"]?.state).toBe("IDLE");
      expect(restartedFirst.getSnapshot().sessions["session-second"]).toBeUndefined();
      expect(restartedFirst.getSnapshot().global.pingsSent).toBe(3);
      expect(restartedSecond.getSnapshot().sessions["session-second"]?.state).toBe("IDLE");
      expect(restartedSecond.getSnapshot().sessions["session-first"]).toBeUndefined();
      expect(restartedSecond.getSnapshot().global.pingsSent).toBe(0);
      restartedFirst.dispose();
      restartedSecond.dispose();
    } finally {
      fs.rmSync(firstDir, { recursive: true, force: true });
      fs.rmSync(secondDir, { recursive: true, force: true });
    }
  });


  it("marks previous-process active sessions IDLE when the store reopens", () => {
    const dir = tmpDir();
    const writer = getStateStore(dir);
    writer.setSession("prior-session", {
      state: "WATCHING", agentName: "coder", lastActivityAt: 100,
      runningToolsCount: 2, pendingRequestsCount: 1,
    });
    writer.dispose();
    const restarted = getStateStore(dir);
    expect(restarted.getSnapshot().sessions["prior-session"]).toMatchObject({
      state: "IDLE", runningToolsCount: 0, pendingRequestsCount: 0, agentName: "coder",
    });
    restarted.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });


  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    clearStateStoreCache();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  it("marks previous-process active sessions IDLE when the store reopens", () => {
    const writer = getStateStore(dir);
    writer.setSession("prior-session", {
      state: "WATCHING", agentName: "coder", lastActivityAt: 100,
      runningToolsCount: 2, pendingRequestsCount: 1,
    });
    writer.dispose();
    const restarted = getStateStore(dir);
    expect(restarted.getSnapshot().sessions["prior-session"]).toMatchObject({
      state: "IDLE", runningToolsCount: 0, pendingRequestsCount: 0, agentName: "coder",
    });
    restarted.dispose();
  });

  it("starts with default state when file is missing", () => {
    const store = new WatchdogStateStore(dir);
    const snapshot = store.getSnapshot();

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.timestamp).toBe(0);
    expect(snapshot.global.hangupsDetected).toBe(0);
    expect(snapshot.global.pingsSent).toBe(0);
    expect(snapshot.global.recoveries).toBe(0);
    expect(snapshot.global.silencedFailures).toBe(0);
    expect(Object.keys(snapshot.sessions)).toHaveLength(0);
  });

  it("persists session and global changes", () => {
    const store = new WatchdogStateStore(dir);
    store.setEnabled(false);
    store.setSession("sess-1", {
      state: "WATCHING",
      agentName: "test-agent",
      lastActivityAt: 12345,
      runningToolsCount: 2,
      pendingRequestsCount: 1,
    });
    store.setGlobal({
      hangupsDetected: 5,
      pingsSent: 3,
      recoveries: 2,
      silencedFailures: 1,
    });
    store.dispose();

    const filePath = path.join(dir, ".akane", "watchdog-state.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);

    expect(parsed.enabled).toBe(false);
    expect(parsed.sessions["sess-1"].state).toBe("WATCHING");
    expect(parsed.sessions["sess-1"].agentName).toBe("test-agent");
    expect(parsed.global.hangupsDetected).toBe(5);
    expect(parsed.global.pingsSent).toBe(3);
  });

  it("notifies subscribers when state changes", () => {
    const store = new WatchdogStateStore(dir);
    try {
      let calls = 0;
      const unsubscribe = store.subscribe(() => {
        calls++;
      });

      store.setEnabled(false);
      expect(calls).toBeGreaterThanOrEqual(1);

      unsubscribe();
      const before = calls;
      store.setEnabled(true);
      expect(calls).toBe(before);
    } finally {
      store.dispose();
    }
  });
  it("dispose flushes pending writes immediately", () => {
    const store = new WatchdogStateStore(dir);
    store.setSession("sess-2", {
      state: "PAUSED",
      runningToolsCount: 0,
      pendingRequestsCount: 0,
    });

    store.dispose();

    const filePath = path.join(dir, ".akane", "watchdog-state.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.sessions["sess-2"].state).toBe("PAUSED");
  });

  it("getStateStore returns the same instance for the same directory", () => {
    const a = getStateStore(dir);
    const b = getStateStore(dir);
    expect(a).toBe(b);
  });
});
