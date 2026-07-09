import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeMonitor, lockGuardedNotifier, lockGuardedPinger } from "../../src/claude/monitor";
import { Watchdog } from "../../src/watchdog";
import { FakeClock } from "../../src/clock";
import { MockPinger } from "../../src/pinger";
import { EventTailer } from "../../src/claude/event-log";
import { TombstoneStore } from "../../src/claude/event-store";
import { MonitorLock } from "../../src/claude/lock";
import { eventsDir, eventsPathFor } from "../../src/claude/state-dir";
import { resolveClaudeConfig } from "../../src/claude/config";
import type { Notifier, NotifierStage } from "../../src/notifier";

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-stress-"));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const noopNotifier: Notifier = { async notify(_i: string, _s: NotifierStage) {}, async clear() {} };

describe("ClaudeMonitor stress & disk hygiene (design 4.3 / AC #9 #13)", () => {
  test("1000 sessions x 100 events then session_end: zero leaks and zero files", () => {
    const dir = eventsDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    const SESSIONS = 1000;
    const EVENTS = 100;
    for (let s = 0; s < SESSIONS; s++) {
      const sid = `sess-${s}`;
      const lines: string[] = [];
      for (let c = 0; c < EVENTS; c++) {
        lines.push(JSON.stringify({ kind: "activity", sessionId: sid, ts: c }));
      }
      lines.push(JSON.stringify({ kind: "session_end", sessionId: sid, ts: EVENTS }));
      fs.writeFileSync(eventsPathFor(stateDir, sid), lines.join("\n") + "\n");
    }

    const clock = new FakeClock();
    const lock = new MonitorLock({
      dir, pid: 1, startedAt: 1, now: () => clock.now(), ttlMs: 60_000,
      isAlive: () => true, procStartTime: () => null,
    });
    expect(lock.tryAcquire()).toBe(true);
    const onLost = () => {};
    const config = resolveClaudeConfig({ AKANE_STAGE1_MS: "1000", AKANE_STAGE2_MS: "1000" });
    const watchdog = new Watchdog({
      config, clock,
      notifier: lockGuardedNotifier(noopNotifier, lock, onLost),
      pinger: lockGuardedPinger(new MockPinger(), lock, onLost),
      log: () => {},
    });
    const monitor = new ClaudeMonitor({
      stateDir, watchdog, tailer: new EventTailer(dir), tombstones: new TombstoneStore(dir), lock, clock,
      pollMs: 100, maintenanceIntervalMs: 3_600_000, orphanTtlMs: 86_400_000,
      log: () => {}, onLockLost: onLost,
    });

    expect(fs.readdirSync(dir).length).toBeGreaterThan(0); // witness: session files exist before processing
    monitor.tick(); // single poll ingests all files (activity* then session_end each)

    expect(watchdog.activeSessionCount()).toBe(0);
    expect(watchdog.activeTimerCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
    const remaining = fs.readdirSync(dir).filter((n) => n.endsWith(".ndjson"));
    expect(remaining).toEqual([]);
  });

  test("interleaved appends during polling are consumed once and the log is never rewritten (§4.3 read-offset)", () => {
    const dir = eventsDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = eventsPathFor(stateDir, "concurrent");
    const tailer = new EventTailer(dir);
    const seen: number[] = [];
    let prevSize = 0;
    const TOTAL = 500;
    for (let i = 0; i < TOTAL; i++) {
      fs.appendFileSync(file, JSON.stringify({ kind: "activity", sessionId: "concurrent", ts: i }) + "\n");
      const size = fs.statSync(file).size;
      expect(size).toBeGreaterThanOrEqual(prevSize); // monitor は active log を rewrite/縮小しない
      prevSize = size;
      if (i % 7 === 0) for (const e of tailer.poll()) seen.push(e.ts);
    }
    for (const e of tailer.poll()) seen.push(e.ts);
    expect(seen).toHaveLength(TOTAL); // no dup: exactly TOTAL emissions (a re-emitted event would push length past TOTAL)
    expect(new Set(seen).size).toBe(TOTAL); // no loss: all distinct ts observed
  });
});
