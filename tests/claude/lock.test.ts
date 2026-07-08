import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MonitorLock } from "../../src/claude/lock";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-lock-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const alwaysAlive = () => true;
const neverAlive = () => false;
const noProcTime = () => null;

describe("MonitorLock", () => {
  test("acquires when no lock file exists", () => {
    const lock = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isOwned()).toBe(true);
  });

  test("refuses when a healthy foreign owner holds a fresh lock", () => {
    const owner = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(owner.tryAcquire()).toBe(true);
    const other = new MonitorLock({ dir, pid: 200, startedAt: 2, now: () => 1001, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(other.tryAcquire()).toBe(false);
    expect(other.isOwned()).toBe(false);
  });

  test("steals a lock whose PID is dead", () => {
    const dead = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(dead.tryAcquire()).toBe(true);
    const fresh = new MonitorLock({ dir, pid: 200, startedAt: 2, now: () => 1001, ttlMs: 30000, isAlive: neverAlive, procStartTime: noProcTime });
    expect(fresh.tryAcquire()).toBe(true);
    expect(fresh.isOwned()).toBe(true);
  });

  test("steals a lock whose PID was reused (start time mismatch)", () => {
    const original = new MonitorLock({ dir, pid: 100, startedAt: 555, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: () => 555 });
    expect(original.tryAcquire()).toBe(true);
    // Same pid 100 is alive but /proc reports a different start time -> reused.
    const reuser = new MonitorLock({ dir, pid: 200, startedAt: 2, now: () => 1001, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: () => 999 });
    expect(reuser.tryAcquire()).toBe(true);
  });

  test("steals a lock whose heartbeat exceeded the TTL", () => {
    const stale = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(stale.tryAcquire()).toBe(true); // heartbeatAt = 1000
    const later = new MonitorLock({ dir, pid: 200, startedAt: 2, now: () => 1000 + 40000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(later.tryAcquire()).toBe(true);
  });

  test("heartbeat returns false after the lock is stolen", () => {
    let t = 1000;
    const a = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => t, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(a.tryAcquire()).toBe(true);
    t = 1000 + 40000;
    const b = new MonitorLock({ dir, pid: 200, startedAt: 2, now: () => t, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(b.tryAcquire()).toBe(true); // b steals
    // a now detects it lost ownership on its next heartbeat.
    expect(a.heartbeat()).toBe(false);
    expect(a.isOwned()).toBe(false);
    expect(b.heartbeat()).toBe(true);
  });

  test("release removes the lock only when owned", () => {
    const a = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(a.tryAcquire()).toBe(true);
    a.release();
    expect(fs.existsSync(path.join(dir, "monitor.lock"))).toBe(false);
  });
});
