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
  test("delegates with V2 { sessionID, parts, delivery } shape", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = { session: { prompt: async (a: Record<string, unknown>) => { calls.push(a); } } };
    const adapter = new OpenCodeAdapter(fakeClient, "steer");
    await adapter.inject("sess-abc", "ping?");
    expect(calls.length).toBe(1);
    expect(calls[0]!.sessionID).toBe("sess-abc");
    expect(calls[0]!.delivery).toBe("steer");
    const parts = calls[0]!.parts as Array<{ type: string; text: string }>;
    expect(parts[0]!.type).toBe("text");
    expect(parts[0]!.text).toBe("ping?");
  });

  test("V2 form carries the reason-enriched message (buildPingPrompt)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = { session: { prompt: async (a: Record<string, unknown>) => { calls.push(a); } } };
    const adapter = new OpenCodeAdapter(fakeClient, "steer");
    await adapter.inject("sess-abc", "ping?", { reason: "rate_limit" });
    const parts = calls[0]!.parts as Array<{ type: string; text: string }>;
    expect(parts[0]!.text).toContain("[Watchdog]");
    expect(parts[0]!.text).toContain("APIレート制限に到達しました");
  });

  test("passes delivery=queue when configured so", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = { session: { prompt: async (a: Record<string, unknown>) => { calls.push(a); } } };
    const adapter = new OpenCodeAdapter(fakeClient, "queue");
    await adapter.inject("s", "ping?");
    expect(calls[0]!.delivery).toBe("queue");
  });

  test("falls back to legacy { path, body } when the V2 form throws", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = {
      session: {
        prompt: async (a: Record<string, unknown>) => {
          calls.push(a);
          if ("delivery" in a) throw new Error("unknown field: delivery");
          return undefined;
        },
      },
    };
    const adapter = new OpenCodeAdapter(fakeClient, "steer");
    await adapter.inject("sess-xyz", "ping?");
    expect(calls.length).toBe(2);
    expect("delivery" in calls[0]!).toBe(true);
    const legacy = calls[1] as { path?: { id?: string }; body?: { parts?: unknown[] } };
    expect(legacy.path?.id).toBe("sess-xyz");
    expect(Array.isArray(legacy.body?.parts)).toBe(true);
  });

  test("falls back to legacy when V2 throws 'unrecognized field' (space variant)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = {
      session: {
        prompt: async (a: Record<string, unknown>) => {
          calls.push(a);
          if ("delivery" in a) throw new Error("unrecognized field: delivery");
          return undefined;
        },
      },
    };
    const adapter = new OpenCodeAdapter(fakeClient, "steer");
    await adapter.inject("sess-xyz", "ping?");
    expect(calls.length).toBe(2);
    const legacy = calls[1] as { path?: { id?: string }; body?: { parts?: unknown[] } };
    expect(legacy.path?.id).toBe("sess-xyz");
    expect(Array.isArray(legacy.body?.parts)).toBe(true);
  });

  test("falls back to legacy when V2 throws 'unrecognized_field' (underscore variant)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = {
      session: {
        prompt: async (a: Record<string, unknown>) => {
          calls.push(a);
          if ("delivery" in a) throw new Error("unrecognized_field: delivery");
          return undefined;
        },
      },
    };
    const adapter = new OpenCodeAdapter(fakeClient, "steer");
    await adapter.inject("sess-xyz", "ping?");
    expect(calls.length).toBe(2);
    const legacy = calls[1] as { path?: { id?: string }; body?: { parts?: unknown[] } };
    expect(legacy.path?.id).toBe("sess-xyz");
    expect(Array.isArray(legacy.body?.parts)).toBe(true);
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
    let thisContext: any = null;
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
    expect(thisContext.name).toBe("OpenCodeSession");
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
