import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendEvent, EventTailer } from "../../src/claude/event-log";
import type { AkaneClaudeEvent } from "../../src/claude/event-types";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-evlog-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function ev(kind: AkaneClaudeEvent["kind"], sessionId: string, ts = 1): AkaneClaudeEvent {
  return { kind, sessionId, ts };
}

describe("appendEvent + EventTailer", () => {
  test("append then poll returns the event once", () => {
    const file = path.join(dir, "s1.ndjson");
    appendEvent(file, ev("activity", "s1"));
    const tailer = new EventTailer(dir);
    const first = tailer.poll();
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe("activity");
    expect(first[0]!.sessionId).toBe("s1");
    // Second poll sees nothing new (offset advanced).
    expect(tailer.poll()).toHaveLength(0);
  });

  test("tails only newly appended complete lines", () => {
    const file = path.join(dir, "s1.ndjson");
    const tailer = new EventTailer(dir);
    appendEvent(file, ev("activity", "s1"));
    expect(tailer.poll()).toHaveLength(1);
    appendEvent(file, ev("turn_end", "s1"));
    const second = tailer.poll();
    expect(second).toHaveLength(1);
    expect(second[0]!.kind).toBe("turn_end");
  });

  test("skips corrupt lines but keeps valid ones", () => {
    const file = path.join(dir, "s1.ndjson");
    fs.writeFileSync(file, `{"kind":"activity","sessionId":"s1","ts":1}\nNOT-JSON\n{"kind":"idle","sessionId":"s1","ts":2}\n`);
    const tailer = new EventTailer(dir);
    const events = tailer.poll();
    expect(events.map((e) => e.kind)).toEqual(["activity", "idle"]);
  });

  test("does not emit a partial trailing line until completed", () => {
    const file = path.join(dir, "s1.ndjson");
    fs.writeFileSync(file, `{"kind":"activity","sessionId":"s1","ts":1}\n{"kind":"idle"`);
    const tailer = new EventTailer(dir);
    expect(tailer.poll().map((e) => e.kind)).toEqual(["activity"]);
    fs.appendFileSync(file, `,"sessionId":"s1","ts":2}\n`);
    expect(tailer.poll().map((e) => e.kind)).toEqual(["idle"]);
  });

  test("poll on missing dir returns empty", () => {
    const tailer = new EventTailer(path.join(dir, "does-not-exist"));
    expect(tailer.poll()).toEqual([]);
  });
});

describe("EventTailer cursor persistence (monitor restart idempotency)", () => {
  test("a rebuilt tailer does not re-dispatch already-read content", () => {
    const file = path.join(dir, "s1.ndjson");
    appendEvent(file, ev("activity", "s1"));
    appendEvent(file, ev("input_requested", "s1"));
    const first = new EventTailer(dir);
    expect(first.poll()).toHaveLength(2);
    // Rebuild the tailer to simulate a monitor process restart on the same dir.
    const restarted = new EventTailer(dir);
    expect(restarted.poll()).toHaveLength(0);
    // Content appended after the restart is still delivered exactly once.
    appendEvent(file, ev("idle", "s1"));
    expect(restarted.poll().map((e) => e.kind)).toEqual(["idle"]);
    // A further restart likewise sees nothing already consumed.
    const restartedAgain = new EventTailer(dir);
    expect(restartedAgain.poll()).toHaveLength(0);
  });

  test("writes cursors.json only after an offset advances", () => {
    const cursorFile = path.join(dir, "cursors.json");
    const file = path.join(dir, "s1.ndjson");
    // A partial (incomplete) line advances nothing => no persistence yet.
    fs.writeFileSync(file, `{"kind":"activity","sessionId":"s1"`);
    const tailer = new EventTailer(dir);
    expect(tailer.poll()).toHaveLength(0);
    expect(fs.existsSync(cursorFile)).toBe(false);
    // Completing the line advances the offset => cursors.json is written.
    fs.appendFileSync(file, `,"ts":1}\n`);
    expect(tailer.poll()).toHaveLength(1);
    expect(fs.existsSync(cursorFile)).toBe(true);
  });

  test("forget() removes the persisted cursor so a recreated log is re-read", () => {
    const cursorFile = path.join(dir, "cursors.json");
    const file = path.join(dir, "s1.ndjson");
    appendEvent(file, ev("activity", "s1"));
    const tailer = new EventTailer(dir);
    expect(tailer.poll()).toHaveLength(1);
    expect(Object.keys(JSON.parse(fs.readFileSync(cursorFile, "utf8")))).toContain("s1.ndjson");
    // session_end path: forget drops the cursor from memory AND disk.
    tailer.forget("s1");
    expect(Object.keys(JSON.parse(fs.readFileSync(cursorFile, "utf8")))).not.toContain("s1.ndjson");
    // A brand-new log under the same name (reused id) is read from the start.
    fs.rmSync(file);
    appendEvent(file, ev("idle", "s1"));
    const restarted = new EventTailer(dir);
    expect(restarted.poll().map((e) => e.kind)).toEqual(["idle"]);
  });

  test("corrupt cursors.json falls back to empty state without throwing", () => {
    const cursorFile = path.join(dir, "cursors.json");
    const file = path.join(dir, "s1.ndjson");
    appendEvent(file, ev("activity", "s1"));
    fs.writeFileSync(cursorFile, "{ this is not valid json");
    let tailer!: EventTailer;
    expect(() => { tailer = new EventTailer(dir); }).not.toThrow();
    // Falls back to empty offsets => reads the log from the start.
    expect(tailer.poll().map((e) => e.kind)).toEqual(["activity"]);
  });

  test("re-reads from start when a same-named file is recreated shorter (offset reset)", () => {
    const file = path.join(dir, "s1.ndjson");
    appendEvent(file, ev("activity", "s1"));
    appendEvent(file, ev("turn_end", "s1"));
    const tailer = new EventTailer(dir);
    expect(tailer.poll()).toHaveLength(2); // offset now past both lines
    // Recreate the file with fresh, shorter content (length < saved offset).
    fs.writeFileSync(file, `${JSON.stringify(ev("idle", "s1"))}\n`);
    expect(tailer.poll().map((e) => e.kind)).toEqual(["idle"]);
  });
});
