import { describe, test, expect } from "bun:test";
import { dispatchEvent, CC_PERMISSION_REQUEST_ID, type WatchdogTarget } from "../../src/claude/event-map";
import type { AkaneClaudeEvent } from "../../src/claude/event-types";

type Call = [method: string, ...args: unknown[]];

function recorder(): { w: WatchdogTarget; calls: Call[] } {
  const calls: Call[] = [];
  const w: WatchdogTarget = {
    onUserMessage: (s, m) => calls.push(["onUserMessage", s, m]),
    onActivity: (s, m) => calls.push(["onActivity", s, m]),
    onToolRunning: (s, c) => calls.push(["onToolRunning", s, c]),
    onToolSettled: (s, c) => calls.push(["onToolSettled", s, c]),
    onInputRequested: (s, r) => calls.push(["onInputRequested", s, r]),
    onInputResolved: (s, r) => calls.push(["onInputResolved", s, r]),
    onSessionCreated: (s) => calls.push(["onSessionCreated", s]),
    noteError: (s, r) => calls.push(["noteError", s, r]),
    stop: (s) => calls.push(["stop", s]),
  };
  return { w, calls };
}

function ev(partial: Partial<AkaneClaudeEvent> & Pick<AkaneClaudeEvent, "kind">): AkaneClaudeEvent {
  return { sessionId: "s1", ts: 1, ...partial };
}

describe("dispatchEvent", () => {
  test("user_message -> onUserMessage with agentName", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "user_message", agentName: "a" }));
    expect(calls).toEqual([["onUserMessage", "s1", { agentName: "a" }]]);
  });

  test("activity releases pending permission then re-arms", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "activity", agentName: "a" }));
    expect(calls).toEqual([
      ["onInputResolved", "s1", CC_PERMISSION_REQUEST_ID],
      ["onActivity", "s1", { agentName: "a" }],
    ]);
  });

  test("tool_running with callId releases then tracks the tool", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "tool_running", callId: "c1" }));
    expect(calls).toEqual([
      ["onInputResolved", "s1", CC_PERMISSION_REQUEST_ID],
      ["onToolRunning", "s1", "c1"],
    ]);
  });

  test("tool_running without callId falls back to activity", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "tool_running" }));
    expect(calls).toEqual([
      ["onInputResolved", "s1", CC_PERMISSION_REQUEST_ID],
      ["onActivity", "s1", { agentName: undefined }],
    ]);
  });

  test("tool_settled with callId releases then settles", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "tool_settled", callId: "c1" }));
    expect(calls).toEqual([
      ["onInputResolved", "s1", CC_PERMISSION_REQUEST_ID],
      ["onToolSettled", "s1", "c1"],
      ["onActivity", "s1", { agentName: undefined }],
    ]);
  });

  test("input_requested always uses the synthetic request id", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "input_requested", requestId: "ignored" }));
    expect(calls).toEqual([["onInputRequested", "s1", CC_PERMISSION_REQUEST_ID]]);
  });

  test("idle / turn_end / session_end all stop", () => {
    for (const kind of ["idle", "turn_end", "session_end"] as const) {
      const { w, calls } = recorder();
      dispatchEvent(w, ev({ kind }));
      expect(calls).toEqual([["stop", "s1"]]);
    }
  });

  test("error routes recoverable to noteError, else stop", () => {
    const rec = recorder();
    dispatchEvent(rec.w, ev({ kind: "error", errorReason: "rate_limit" }));
    expect(rec.calls).toEqual([["noteError", "s1", "rate_limit"]]);

    const term = recorder();
    dispatchEvent(term.w, ev({ kind: "error", errorReason: "unknown" }));
    expect(term.calls).toEqual([["stop", "s1"]]);

    const none = recorder();
    dispatchEvent(none.w, ev({ kind: "error" }));
    expect(none.calls).toEqual([["stop", "s1"]]);
  });

  test("session_start -> onSessionCreated", () => {
    const { w, calls } = recorder();
    dispatchEvent(w, ev({ kind: "session_start" }));
    expect(calls).toEqual([["onSessionCreated", "s1"]]);
  });
});
