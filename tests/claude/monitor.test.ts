import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeMonitor, lockGuardedNotifier, lockGuardedPinger } from "../../src/claude/monitor";
import { Watchdog } from "../../src/watchdog";
import { TelemetryCollector } from "../../src/telemetry";
import { FakeClock } from "../../src/clock";
import { EventTailer, appendEvent } from "../../src/claude/event-log";
import { TombstoneStore } from "../../src/claude/event-store";
import { MonitorLock } from "../../src/claude/lock";
import { ClaudeCodeAdapter } from "../../src/claude/pinger";
import { eventsDir, eventsPathFor } from "../../src/claude/state-dir";
import { resolveClaudeConfig } from "../../src/claude/config";
import type { Notifier, NotifierStage } from "../../src/notifier";
import type { AkaneClaudeEvent } from "../../src/claude/event-types";

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-mon-"));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

interface Harness {
  monitor: ClaudeMonitor;
  clock: FakeClock;
  watchdog: Watchdog;
  telemetry: TelemetryCollector;
  notifies: NotifierStage[];
  stdout: string[];
  lock: MonitorLock;
}

function makeHarness(): Harness {
  const clock = new FakeClock();
  const dir = eventsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const notifies: NotifierStage[] = [];
  const stdout: string[] = [];
  const lock = new MonitorLock({
    dir, pid: 111, startedAt: 1, now: () => clock.now(), ttlMs: 60_000,
    isAlive: () => true, procStartTime: () => null,
  });
  expect(lock.tryAcquire()).toBe(true);
  const onLockLost = () => {};
  const baseNotifier: Notifier = {
    async notify(_id, stage) { notifies.push(stage); },
    async clear() {},
  };
  const notifier = lockGuardedNotifier(baseNotifier, lock, onLockLost);
  const pinger = lockGuardedPinger(new ClaudeCodeAdapter((line) => stdout.push(line)), lock, onLockLost);
  const config = resolveClaudeConfig({ AKANE_STAGE1_MS: "1000", AKANE_STAGE2_MS: "1000", AKANE_MAX_PINGS: "1" });
  const telemetry = new TelemetryCollector();
  const watchdog = new Watchdog({ config, clock, notifier, pinger, telemetry, log: () => {} });
  const monitor = new ClaudeMonitor({
    stateDir, watchdog, tailer: new EventTailer(dir), tombstones: new TombstoneStore(dir), lock, clock,
    pollMs: 100, maintenanceIntervalMs: 3_600_000, orphanTtlMs: 86_400_000,
    log: () => {}, onLockLost,
  });
  return { monitor, clock, watchdog, notifies, stdout, lock, telemetry };
}

describe("ClaudeMonitor", () => {
  test("ingests a hang and escalates: stage1 warn, stage2 ping to stdout", async () => {
    const h = makeHarness();
    appendEvent(eventsPathFor(stateDir, "s1"), { kind: "user_message", sessionId: "s1", ts: 0 });
    h.monitor.tick(); // ingest -> watchdog arms stage1
    h.clock.advance(1000); // stage1 fires
    expect(h.notifies).toContain("warn");
    h.clock.advance(1000); // stage2 fires -> ping
    await new Promise((r) => setTimeout(r, 10)); // flush fire-and-forget inject
    expect(h.stdout.length).toBe(1);
    expect(h.stdout[0]!.endsWith("\n")).toBe(true);
  });

  test("max_pings=1 suppresses a second stage2 ping", async () => {
    const h = makeHarness();
    appendEvent(eventsPathFor(stateDir, "s1"), { kind: "user_message", sessionId: "s1", ts: 0 });
    h.monitor.tick();
    h.clock.advance(1000); // stage1
    h.clock.advance(1000); // first stage2 -> ping
    await new Promise((r) => setTimeout(r, 10));
    expect(h.stdout).toHaveLength(1);
    h.clock.advance(1000); // next stage2 after max_pings reached
    await new Promise((r) => setTimeout(r, 10));
    expect(h.stdout).toHaveLength(1);
  });

  test("stdout discipline: no non-ping bytes reach stdout across a full cycle", async () => {
    const h = makeHarness();
    appendEvent(eventsPathFor(stateDir, "s1"), { kind: "user_message", sessionId: "s1", ts: 0 });
    h.monitor.tick();
    h.clock.advance(1000);
    h.clock.advance(1000);
    await new Promise((r) => setTimeout(r, 10));
    // Exactly one line, and it is the ping (no debug/telemetry leaked to stdout).
    expect(h.stdout).toHaveLength(1);
  });

  test("turn_end clears monitoring before stage1", () => {
    const h = makeHarness();
    const file = eventsPathFor(stateDir, "s1");
    appendEvent(file, { kind: "user_message", sessionId: "s1", ts: 0 });
    appendEvent(file, { kind: "turn_end", sessionId: "s1", ts: 1 });
    h.monitor.tick();
    h.clock.advance(5000);
    expect(h.notifies).toHaveLength(0);
    expect(h.watchdog.activeSessionCount()).toBe(0);
  });

  test("telemetry records hang and ping without writing telemetry to stdout", async () => {
    const h = makeHarness();
    appendEvent(eventsPathFor(stateDir, "s1"), { kind: "user_message", sessionId: "s1", ts: 0 });
    h.monitor.tick();
    h.clock.advance(1000);
    h.clock.advance(1000);
    await new Promise((r) => setTimeout(r, 10));
    const snap = h.telemetry.snapshot();
    expect(snap.hangupsDetected).toBe(1);
    expect(snap.pingsSent).toBe(1);
    // stdout must still contain only the ping line (no telemetry/debug leaked).
    expect(h.stdout).toHaveLength(1);
  });

  test("session_end deletes the session ndjson and tombstones it", () => {
    const h = makeHarness();
    const file = eventsPathFor(stateDir, "s1");
    appendEvent(file, { kind: "user_message", sessionId: "s1", ts: 0 });
    appendEvent(file, { kind: "session_end", sessionId: "s1", ts: 1 });
    h.monitor.tick();
    expect(fs.existsSync(file)).toBe(false);
    expect(h.watchdog.activeSessionCount()).toBe(0);
  });

  test("tick reports lock loss and stops when lock is stolen", () => {
    const h = makeHarness();
    let lost = false;
    // Steal the lock out from under the monitor.
    const thief = new MonitorLock({
      dir: eventsDir(stateDir), pid: 999, startedAt: 9, now: () => h.clock.now() + 999_999, ttlMs: 60_000,
      isAlive: () => true, procStartTime: () => null,
    });
    expect(thief.tryAcquire()).toBe(true);
    // Re-wire onLockLost via a fresh monitor sharing the same (now-stolen) lock.
    const m = new ClaudeMonitor({
      stateDir, watchdog: h.watchdog, tailer: new EventTailer(eventsDir(stateDir)),
      tombstones: new TombstoneStore(eventsDir(stateDir)), lock: h.lock, clock: h.clock,
      pollMs: 100, maintenanceIntervalMs: 3_600_000, orphanTtlMs: 86_400_000,
      log: () => {}, onLockLost: () => { lost = true; },
    });
    m.tick();
    expect(lost).toBe(true);
  });
});
