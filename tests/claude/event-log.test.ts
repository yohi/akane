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
