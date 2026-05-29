import { describe, test, expect } from "bun:test";
import { MockPinger, OpenCodeAdapter, type Pinger } from "../src/pinger";

describe("MockPinger", () => {
  test("records each inject call", async () => {
    const m = new MockPinger();
    await m.inject("session-1", "hello?");
    await m.inject("session-2", "still alive?");
    expect(m.calls).toEqual([
      { sessionId: "session-1", message: "hello?" },
      { sessionId: "session-2", message: "still alive?" },
    ]);
  });

  test("returns a resolved promise", async () => {
    const m: Pinger = new MockPinger();
    await expect(m.inject("s", "msg")).resolves.toBeUndefined();
  });
});

describe("OpenCodeAdapter", () => {
  test("delegates to client.session.prompt with { path: { id }, body: { parts } } shape", async () => {
    const calls: Array<{ path: { id: string }; body: { parts: unknown[] } }> = [];
    const fakeClient = {
      session: {
        prompt: async (args: { path: { id: string }; body: { parts: unknown[] } }) => {
          calls.push(args);
        },
      },
    };
    const adapter = new OpenCodeAdapter(fakeClient);
    await adapter.inject("sess-abc", "ping?");
    expect(calls.length).toBe(1);
    expect(calls[0]!.path.id).toBe("sess-abc");
    expect(Array.isArray(calls[0]!.body.parts)).toBe(true);
    // Each part should be a text part carrying the message
    const firstPart = calls[0]!.body.parts[0] as { type: string; text: string };
    expect(firstPart.type).toBe("text");
    expect(firstPart.text).toBe("ping?");
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
