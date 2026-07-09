import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeEvent, errorReasonFromStop, runHook } from "../../src/claude/hook";
import { eventsPathFor } from "../../src/claude/state-dir";

describe("normalizeEvent", () => {
  const now = 12345;
  test("UserPromptSubmit -> user_message", () => {
    const e = normalizeEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", agent_type: "a" }, now);
    expect(e).toEqual({ kind: "user_message", sessionId: "s1", ts: now, agentName: "a" });
  });

  test("MessageDisplay -> activity", () => {
    expect(normalizeEvent({ hook_event_name: "MessageDisplay", session_id: "s1" }, now)?.kind).toBe("activity");
  });

  test("PreToolUse -> tool_running with callId", () => {
    const e = normalizeEvent({ hook_event_name: "PreToolUse", session_id: "s1", tool_use_id: "c1" }, now);
    expect(e?.kind).toBe("tool_running");
    expect(e?.callId).toBe("c1");
  });

  test("PostToolUse and PostToolUseFailure -> tool_settled", () => {
    expect(normalizeEvent({ hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: "c1" }, now)?.kind).toBe("tool_settled");
    expect(normalizeEvent({ hook_event_name: "PostToolUseFailure", session_id: "s1", tool_use_id: "c1" }, now)?.kind).toBe("tool_settled");
  });

  test("PermissionRequest -> input_requested", () => {
    expect(normalizeEvent({ hook_event_name: "PermissionRequest", session_id: "s1" }, now)?.kind).toBe("input_requested");
  });

  test("Notification subtype routing", () => {
    expect(normalizeEvent({ hook_event_name: "Notification", session_id: "s1", notification_type: "permission_prompt" }, now)?.kind).toBe("input_requested");
    expect(normalizeEvent({ hook_event_name: "Notification", session_id: "s1", notification_type: "idle_prompt" }, now)?.kind).toBe("idle");
    expect(normalizeEvent({ hook_event_name: "Notification", session_id: "s1", notification_type: "other" }, now)).toBeNull();
  });

  test("Stop without error -> turn_end", () => {
    expect(normalizeEvent({ hook_event_name: "Stop", session_id: "s1" }, now)?.kind).toBe("turn_end");
  });

  test("Stop WITH error fields -> error with classified reason (SPEC 5.4-1 fallback)", () => {
    const e = normalizeEvent({ hook_event_name: "Stop", session_id: "s1", error_type: "rate_limit_error" }, now);
    expect(e?.kind).toBe("error");
    expect(e?.errorReason).toBe("rate_limit");
  });

  test("StopFailure -> error (unknown when unclassifiable)", () => {
    expect(normalizeEvent({ hook_event_name: "StopFailure", session_id: "s1" }, now)?.errorReason).toBe("unknown");
    expect(normalizeEvent({ hook_event_name: "StopFailure", session_id: "s1", stop_reason: "overloaded 529" }, now)?.kind).toBe("error");
  });

  test("SessionStart/SessionEnd", () => {
    expect(normalizeEvent({ hook_event_name: "SessionStart", session_id: "s1" }, now)?.kind).toBe("session_start");
    expect(normalizeEvent({ hook_event_name: "SessionEnd", session_id: "s1" }, now)?.kind).toBe("session_end");
  });

  test("SubagentStart -> activity, SubagentStop -> tool_settled", () => {
    expect(normalizeEvent({ hook_event_name: "SubagentStart", session_id: "s1" }, now)?.kind).toBe("activity");
    const stopped = normalizeEvent({ hook_event_name: "SubagentStop", session_id: "s1", tool_use_id: "c1" }, now);
    expect(stopped?.kind).toBe("tool_settled");
    expect(stopped?.callId).toBe("c1");
  });

  test("returns null for missing sessionId or unknown hook", () => {
    expect(normalizeEvent({ hook_event_name: "MessageDisplay" }, now)).toBeNull();
    expect(normalizeEvent({ hook_event_name: "Nope", session_id: "s1" }, now)).toBeNull();
    expect(normalizeEvent({ session_id: "s1" }, now)).toBeNull();
  });
});

describe("errorReasonFromStop", () => {
  test("null when no error signals present", () => {
    expect(errorReasonFromStop({})).toBeNull();
  });
  test("classifies rate limit / timeout", () => {
    expect(errorReasonFromStop({ error_type: "429 too many requests" })).toBe("rate_limit");
    expect(errorReasonFromStop({ stop_reason: "deadline exceeded timeout" })).toBe("provider_timeout");
  });
});

describe("runHook", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akane-hook-"));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("appends a normalized event line to the session ndjson", () => {
    runHook({
      stdinText: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1" }),
      env: { AKANE_STATE_DIR: stateDir },
      now: 7,
      logError: () => {},
    });
    const file = eventsPathFor(stateDir, "s1");
    const line = fs.readFileSync(file, "utf8").trim();
    expect(JSON.parse(line)).toEqual({ kind: "user_message", sessionId: "s1", ts: 7 });
  });

  test("malformed stdin does not throw and writes nothing", () => {
    const errs: string[] = [];
    expect(() =>
      runHook({ stdinText: "NOT JSON", env: { AKANE_STATE_DIR: stateDir }, now: 1, logError: (m) => errs.push(m) }),
    ).not.toThrow();
    expect(errs.length).toBeGreaterThan(0);
  });

  test("unknown hook writes nothing and does not throw", () => {
    runHook({
      stdinText: JSON.stringify({ hook_event_name: "Nope", session_id: "s1" }),
      env: { AKANE_STATE_DIR: stateDir },
      now: 1,
      logError: () => {},
    });
    expect(fs.existsSync(eventsPathFor(stateDir, "s1"))).toBe(false);
  });
});
