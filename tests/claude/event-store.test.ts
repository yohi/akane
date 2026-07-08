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
