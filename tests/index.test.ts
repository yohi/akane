import { describe, test, expect } from "bun:test";
import { logEvent, summarizeEvent, type OpenCodeEvent } from "../src/index";

describe("logEvent verbosity (#3 log reduction)", () => {
  test("high-frequency delta is summarized (no full JSON) when verbose=false", () => {
    const logs: string[] = [];
    const ev: OpenCodeEvent = {
      type: "message.part.delta",
      properties: { sessionID: "s1", messageID: "m1", delta: "X".repeat(500) },
    };
    logEvent(ev, false, (_l, m) => logs.push(m));
    expect(logs.length).toBe(1);
    expect(logs[0]).not.toContain("XXXXX"); // delta body must NOT be logged
    expect(logs[0]).toContain("type=message.part.delta");
    expect(logs[0]).toContain("sessionID=s1");
  });

  test("verbose=true emits full JSON", () => {
    const logs: string[] = [];
    const ev: OpenCodeEvent = { type: "message.part.delta", properties: { sessionID: "s1", delta: "HELLO" } };
    logEvent(ev, true, (_l, m) => logs.push(m));
    expect(logs[0]).toContain("HELLO");
  });

  test("summarizeEvent includes part type + tool status for tool parts", () => {
    const ev: OpenCodeEvent = {
      type: "message.part.updated",
      properties: { part: { sessionID: "s1", type: "tool", state: { status: "running" } } },
    };
    const s = summarizeEvent(ev);
    expect(s).toContain("partType=tool");
    expect(s).toContain("toolStatus=running");
  });
});
