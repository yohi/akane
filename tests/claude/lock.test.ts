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

  test("heartbeat reports not_owner after the lock is stolen", () => {
    let t = 1000;
    const a = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => t, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(a.tryAcquire()).toBe(true);
    t = 1000 + 40000;
    const b = new MonitorLock({ dir, pid: 200, startedAt: 2, now: () => t, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(b.tryAcquire()).toBe(true); // b steals
    // a now detects it lost ownership on its next heartbeat.
    expect(a.heartbeat()).toBe("not_owner");
    expect(a.isOwned()).toBe(false);
    expect(b.heartbeat()).toBe("ok");
  });

  // Regression guard: a transient write failure (disk full / EACCES / etc.)
  // must be distinguishable from genuine ownership loss, so callers can
  // tolerate a bounded number of retries instead of shutting down instantly.
  test("heartbeat reports io_error (not not_owner) when the write fails transiently", () => {
    const pid = 100;
    const lock = new MonitorLock({ dir, pid, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(lock.tryAcquire()).toBe(true);
    // Pre-create the PID-unique tmp path as a directory so the next write()'s
    // writeFileSync throws EISDIR regardless of process privileges (root-safe,
    // unlike chmod-based permission denial).
    const tmpPath = path.join(dir, `monitor.lock.${pid}.tmp`);
    fs.mkdirSync(tmpPath);
    expect(lock.heartbeat()).toBe("io_error");
    // Still owns the lock; only the heartbeat write failed, not the ownership.
    expect(lock.isOwned()).toBe(true);
    fs.rmdirSync(tmpPath);
    expect(lock.heartbeat()).toBe("ok");
  });

  test("release removes the lock only when owned", () => {
    const a = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
    expect(a.tryAcquire()).toBe(true);
    a.release();
    expect(fs.existsSync(path.join(dir, "monitor.lock"))).toBe(false);
  });

  // Regression guard for the TOCTOU race a plain read-then-write would leave
  // open across processes: tryAcquire/heartbeat/release now serialize their
  // read-decide-write critical section behind an atomic mkdirSync gate.
  describe("cross-process gate", () => {
    test("tryAcquire fails closed (not a guessed acquire) while the gate is held by another process", () => {
      const lock = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
      fs.mkdirSync(path.join(dir, "monitor.lock.gate")); // simulate a live holder mid-critical-section
      expect(lock.tryAcquire()).toBe(false);
      expect(fs.existsSync(path.join(dir, "monitor.lock"))).toBe(false); // no unsafe write happened
    });

    test("heartbeat reports io_error (retryable) rather than not_owner while the gate is contended", () => {
      const lock = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
      expect(lock.tryAcquire()).toBe(true);
      fs.mkdirSync(path.join(dir, "monitor.lock.gate")); // simulate a live holder mid-critical-section
      expect(lock.heartbeat()).toBe("io_error");
      expect(fs.existsSync(path.join(dir, "monitor.lock.gate"))).toBe(true); // untouched by the failed attempt
    });

    test("release is a no-op (does not force-delete) while the gate is contended", () => {
      const lock = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
      expect(lock.tryAcquire()).toBe(true);
      fs.mkdirSync(path.join(dir, "monitor.lock.gate")); // simulate a live holder mid-critical-section
      lock.release();
      expect(fs.existsSync(path.join(dir, "monitor.lock"))).toBe(true); // release skipped, not a corrupted delete
    });

    test("a gate orphaned by a crashed holder is force-cleared so acquisition can proceed", () => {
      const lock = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
      const gatePath = path.join(dir, "monitor.lock.gate");
      fs.mkdirSync(gatePath);
      // Backdate the gate's mtime well past the staleness bound to simulate a
      // holder that crashed mid-critical-section instead of releasing normally.
      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(gatePath, old, old);
      expect(lock.tryAcquire()).toBe(true);
      expect(lock.isOwned()).toBe(true);
    });

    // Regression guard: acquireGate() must create deps.dir on cold start
    // (ENOENT for the parent, not EEXIST for the gate itself) instead of
    // failing closed forever because eventsDir hasn't been created yet.
    test("acquires on a cold start where deps.dir does not exist yet", () => {
      const coldDir = path.join(dir, "not-yet-created", "eventsDir");
      expect(fs.existsSync(coldDir)).toBe(false);
      const lock = new MonitorLock({ dir: coldDir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
      expect(lock.tryAcquire()).toBe(true);
      expect(lock.isOwned()).toBe(true);
    });

    // Regression guard for the owner-token hardening: a gate reclaimed by a
    // staleness timeout must not later be torn down by the original (slow,
    // not actually dead) holder's release() call once it finally finishes,
    // since that would reopen the exact TOCTOU window the gate exists to close.
    test("release does not delete a gate that was already reclaimed and re-tagged by another holder", () => {
      const lock = new MonitorLock({ dir, pid: 100, startedAt: 1, now: () => 1000, ttlMs: 30000, isAlive: alwaysAlive, procStartTime: noProcTime });
      expect(lock.tryAcquire()).toBe(true); // owns the record; also exercises + clears the gate token normally
      const gatePath = path.join(dir, "monitor.lock.gate");
      // Simulate: this process's own critical section stalled for so long that
      // a reclaimer force-cleared its gate and re-created it under a new token
      // — all before this process's own withGate() finally-block runs release.
      // White-box: inject the token acquireGate() would have set, since the real
      // race can't be reproduced in-process (fs calls here are fully synchronous).
      (lock as unknown as { gateToken: string | null }).gateToken = "this-process-original-token";
      fs.mkdirSync(gatePath);
      fs.writeFileSync(path.join(gatePath, "owner"), "reclaimers-new-token");
      lock.release();
      expect(fs.existsSync(gatePath)).toBe(true);
      expect(fs.readFileSync(path.join(gatePath, "owner"), "utf8")).toBe("reclaimers-new-token");
    });
  });
});
