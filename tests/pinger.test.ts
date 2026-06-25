import { describe, test, expect } from "bun:test";
import { MockPinger, OpenCodeAdapter, buildPingPrompt, type Pinger } from "../src/pinger";

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

describe("OpenCodeAdapter", () => {
  test("delegates with legacy { path: { id }, body: { parts } } shape", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = { session: { prompt: async (a: Record<string, unknown>) => { calls.push(a); } } };
    const adapter = new OpenCodeAdapter(fakeClient);
    await adapter.inject("sess-abc", "ping?");
    expect(calls.length).toBe(1);
    const legacy = calls[0] as { path?: { id?: string }; body?: { parts?: unknown[] } };
    expect(legacy.path?.id).toBe("sess-abc");
    expect(Array.isArray(legacy.body?.parts)).toBe(true);
    const parts = legacy.body?.parts as Array<{ type: string; text: string }>;
    expect(parts[0]!.type).toBe("text");
    expect(parts[0]!.text).toBe("ping?");
  });

  test("legacy form carries the reason-enriched message (buildPingPrompt)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = { session: { prompt: async (a: Record<string, unknown>) => { calls.push(a); } } };
    const adapter = new OpenCodeAdapter(fakeClient);
    await adapter.inject("sess-abc", "ping?", { reason: "rate_limit" });
    const legacy = calls[0] as { body?: { parts?: Array<{ type: string; text: string }> } };
    const parts = legacy.body?.parts;
    expect(parts?.[0]!.text).toContain("[Watchdog]");
    expect(parts?.[0]!.text).toContain("APIレート制限に到達しました");
  });

  test("does not throw when client method is missing (logs only)", async () => {
    const adapter = new OpenCodeAdapter({} as unknown);
    await expect(adapter.inject("s", "msg")).resolves.toBeUndefined();
  });

  test("does not throw when client throws", async () => {
    const failingClient = {
      session: {
        prompt: async () => {
          throw new Error("boom");
        },
      },
    };
    const adapter = new OpenCodeAdapter(failingClient);
    await expect(adapter.inject("s", "msg")).resolves.toBeUndefined();
  });

  test("maintains 'this' binding when calling prompt", async () => {
    let thisContext: unknown = null;
    const fakeClient = {
      session: {
        name: "OpenCodeSession",
        async prompt() {
          thisContext = this;
        },
      },
    };
    const adapter = new OpenCodeAdapter(fakeClient);
    await adapter.inject("sess-abc", "ping?");

    expect(thisContext).toBeDefined();
    expect((thisContext as { name?: string }).name).toBe("OpenCodeSession");
  });
});

describe("buildPingPrompt", () => {
  test("returns base unchanged when no reason", () => {
    expect(buildPingPrompt("base message")).toBe("base message");
  });

  test("appends Japanese reason context when rate_limit given", () => {
    const out = buildPingPrompt("base message", "rate_limit");
    expect(out.startsWith("base message")).toBe(true);
    expect(out).toContain("[Watchdog]");
    expect(out).toContain("APIレート制限に到達しました");
  });

  test("appends Japanese reason context when provider_timeout given", () => {
    const out = buildPingPrompt("base message", "provider_timeout");
    expect(out.startsWith("base message")).toBe(true);
    expect(out).toContain("[Watchdog]");
    expect(out).toContain("プロバイダ応答がタイムアウトしました");
  });

  test("appends Japanese reason context when unknown given", () => {
    const out = buildPingPrompt("base message", "unknown");
    expect(out.startsWith("base message")).toBe(true);
    expect(out).toContain("[Watchdog]");
    expect(out).toContain("原因不明のエラーが発生しました");
  });
});
