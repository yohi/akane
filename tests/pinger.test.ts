import { describe, test, expect } from "bun:test";
import { buildPingPrompt, MockPinger, type Pinger } from "../src/pinger";

test("buildPingPrompt includes a contextual recovery reason", () => {
  expect(buildPingPrompt("Continue", "rate_limit")).toContain("APIレート制限に到達しました");
});

describe("MockPinger", () => {
  test("records each inject call", async () => {
    const m = new MockPinger();
    await m.inject("session-1", "hello?");
    await m.inject("session-2", "still alive?");
    expect(m.calls).toEqual([
      { sessionId: "session-1", message: "hello?", context: undefined },
      { sessionId: "session-2", message: "still alive?", context: undefined },
    ]);
  });

  test("returns a resolved promise", async () => {
    const m: Pinger = new MockPinger();
    await expect(m.inject("s", "msg")).resolves.toBeUndefined();
  });

  test("records context when provided", async () => {
    const m = new MockPinger();
    await m.inject("s", "msg", { reason: "rate_limit" });
    expect(m.calls[0]!.context).toEqual({ reason: "rate_limit" });
  });
});
