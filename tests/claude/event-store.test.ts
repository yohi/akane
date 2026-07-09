import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteSessionLog, TombstoneStore, sweepOrphans } from "../../src/claude/event-store";
import { eventsDir, eventsPathFor } from "../../src/claude/state-dir";

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-store-"));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("deleteSessionLog", () => {
  test("removes the session ndjson and tolerates absence", () => {
    const file = eventsPathFor(stateDir, "s1");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x\n");
    deleteSessionLog(stateDir, "s1");
    expect(fs.existsSync(file)).toBe(false);
    expect(() => deleteSessionLog(stateDir, "s1")).not.toThrow(); // idempotent
  });
});

describe("TombstoneStore", () => {
  test("records and persists across instances", () => {
    const dir = eventsDir(stateDir);
    const a = new TombstoneStore(dir);
    a.record("s1");
    expect(a.has("s1")).toBe(true);
    const b = new TombstoneStore(dir);
    expect(b.has("s1")).toBe(true);
    expect(b.has("s2")).toBe(false);
  });

  // Regression guard: flush() must not depend on the pre-fix fixed tmp name
  // ("tombstones.json.tmp") because two monitor processes can call flush()
  // in the narrow hand-off window between MonitorLock release and re-acquire
  // (SPEC §8.2 single-writer invariant for .tmp->rename). Mirrors the fix
  // already applied to MonitorLock.write() (lock.ts) for the same race class.
  test("flush uses a PID-unique tmp filename, unaffected by another pid squatting on the old shared name", () => {
    const dir = eventsDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    // Simulate a foreign process having left/occupied the OLD fixed tmp path.
    // With the fix, flush() never touches this path, so persistence still succeeds.
    fs.mkdirSync(path.join(dir, "tombstones.json.tmp"));
    const store = new TombstoneStore(dir, 4242);
    store.record("s1");
    expect(store.has("s1")).toBe(true);
    // Prove it was actually persisted (not just held in memory after a swallowed failure).
    const reopened = new TombstoneStore(dir, 4242);
    expect(reopened.has("s1")).toBe(true);
  });

  test("two instances with different pids each flush to their own tmp file (no ENOENT clobber)", () => {
    const dir = eventsDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    const a = new TombstoneStore(dir, 100);
    const b = new TombstoneStore(dir, 200);
    expect(fs.existsSync(path.join(dir, "tombstones.json.100.tmp"))).toBe(false);
    a.record("s1");
    // a's tmp file must be gone (renamed away), never collide with b's tmp name.
    expect(fs.existsSync(path.join(dir, "tombstones.json.100.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "tombstones.json.200.tmp"))).toBe(false);
    b.record("s2");
    expect(fs.existsSync(path.join(dir, "tombstones.json.200.tmp"))).toBe(false);
  });
});

describe("sweepOrphans", () => {
  test("deletes tombstoned files and TTL-expired files, keeps fresh ones", () => {
    const dir = eventsDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "dead.ndjson"), "x\n");
    fs.writeFileSync(path.join(dir, "old.ndjson"), "x\n");
    fs.writeFileSync(path.join(dir, "fresh.ndjson"), "x\n");
    const now = 1_000_000_000_000;
    // Backdate "old" beyond the TTL.
    fs.utimesSync(path.join(dir, "old.ndjson"), new Date(now - 100_000_000), new Date(now - 100_000_000));
    fs.utimesSync(path.join(dir, "fresh.ndjson"), new Date(now), new Date(now));
    fs.utimesSync(path.join(dir, "dead.ndjson"), new Date(now), new Date(now));
    const swept = sweepOrphans(dir, {
      now,
      ttlMs: 86_400_000,
      isTombstoned: (stem) => stem === "dead",
    });
    expect(swept.sort()).toEqual(["dead", "old"]);
    expect(fs.existsSync(path.join(dir, "fresh.ndjson"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "dead.ndjson"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "old.ndjson"))).toBe(false);
  });

  test("returns empty for a missing dir", () => {
    expect(sweepOrphans(path.join(stateDir, "nope"), { now: 0, ttlMs: 1, isTombstoned: () => false })).toEqual([]);
  });
});
