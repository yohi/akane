import { describe, test, expect } from "bun:test";
import { isAkaneClaudeEvent, type AkaneClaudeEvent } from "../../src/claude/event-types";

describe("isAkaneClaudeEvent", () => {
  test("accepts a minimal valid event", () => {
    const e: AkaneClaudeEvent = { kind: "activity", sessionId: "s1", ts: 100 };
    expect(isAkaneClaudeEvent(e)).toBe(true);
  });

  test("accepts an event with all optional fields", () => {
    const e = { kind: "error", sessionId: "s1", ts: 1, agentName: "a", callId: "c", requestId: "r", errorReason: "rate_limit" };
    expect(isAkaneClaudeEvent(e)).toBe(true);
  });

  test("rejects unknown kind", () => {
    expect(isAkaneClaudeEvent({ kind: "boom", sessionId: "s1", ts: 1 })).toBe(false);
  });

  test("rejects empty sessionId", () => {
    expect(isAkaneClaudeEvent({ kind: "activity", sessionId: "", ts: 1 })).toBe(false);
  });

  test("rejects non-number ts", () => {
    expect(isAkaneClaudeEvent({ kind: "activity", sessionId: "s1", ts: "1" })).toBe(false);
  });

  test("rejects invalid errorReason", () => {
    expect(isAkaneClaudeEvent({ kind: "error", sessionId: "s1", ts: 1, errorReason: "nope" })).toBe(false);
  });

  test("rejects non-object", () => {
    expect(isAkaneClaudeEvent(null)).toBe(false);
    expect(isAkaneClaudeEvent("x")).toBe(false);
  });
});
