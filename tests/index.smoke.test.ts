import { describe, test, expect } from "bun:test";
import plugin, {
  extractSessionId,
  isUserMessage,
  isPingEvent,
  extractMessageId,
  isNewUserMessage,
  routeSessionError,
  extractRequestId,
  extractAgentName,
  type OpenCodeEvent,
} from "../src/index";
import { Watchdog } from "../src/watchdog";
import { MockPinger } from "../src/pinger";
import { FakeClock } from "../src/clock";
import { resolveConfig } from "../src/config";

class MockWatchdog extends Watchdog {
  onActivityCalls: Array<{ sessionId: string; meta: any }> = [];
  onToolRunningCalls: Array<{ sessionId: string; callId: string }> = [];
  onToolSettledCalls: Array<{ sessionId: string; callId: string }> = [];
  override onActivity(sessionId: string, meta: any = {}) {
    this.onActivityCalls.push({ sessionId, meta });
  }
  override onToolRunning(sessionId: string, callId: string) {
    this.onToolRunningCalls.push({ sessionId, callId });
    super.onToolRunning(sessionId, callId);
  }
  override onToolSettled(sessionId: string, callId: string) {
    this.onToolSettledCalls.push({ sessionId, callId });
    super.onToolSettled(sessionId, callId);
  }
}

function setupMockWatchdog() {
  const clock = new FakeClock();
  const config = resolveConfig({ project: { enabled: true }, env: {} });
  const watchdog = new MockWatchdog({
    config,
    clock,
    pinger: new MockPinger(),
    notifier: { notify: async () => {}, clear: async () => {} },
    log: () => {},
  });
  return watchdog;
}

describe("plugin entry smoke", () => {
  test("default export is a Plugin object containing id and server", () => {
    expect(plugin.id).toBe("opencode-watchdog");
    expect(typeof plugin.server).toBe("function");
  });

  test("instantiated plugin exposes event handler and dispose function", async () => {
    const fakeContext = {
      client: {
        app: { log: async () => undefined },
        session: { prompt: async () => undefined },
      },
      $: () => undefined,
      directory: process.cwd(),
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (ctx: unknown) => Promise<{ event: unknown; dispose: unknown }>)(
      fakeContext,
    );
    expect(typeof instance.event).toBe("function");
    expect(typeof instance.dispose).toBe("function");
    await (instance.dispose as () => Promise<void>)();
  });

  test("event handler does not throw on typical payloads", async () => {
    const fakeContext = {
      client: {
        app: { log: async () => undefined },
        session: { prompt: async () => undefined },
      },
      $: () => undefined,
      directory: process.cwd(),
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (ctx: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
    }>)(fakeContext);
    await instance.event({
      event: {
        type: "message.part.updated",
        properties: { part: { sessionID: "s1" } },
      },
    });
    await instance.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "s1" },
      },
    });
  });
});

describe("extractSessionId (event routing)", () => {
  test("message.updated reads sessionID from properties.info", () => {
    const e: OpenCodeEvent = {
      type: "message.updated",
      properties: { info: { sessionID: "s-msg-upd", role: "user" } },
    };
    expect(extractSessionId(e)).toBe("s-msg-upd");
  });

  test("message.part.updated reads sessionID from properties.part", () => {
    const e: OpenCodeEvent = {
      type: "message.part.updated",
      properties: { part: { sessionID: "s-msg-part" } },
    };
    expect(extractSessionId(e)).toBe("s-msg-part");
  });

  test("session.created / session.deleted read id from properties.info", () => {
    const types = ["session.created", "session.deleted"] as const;
    for (const t of types) {
      const e: OpenCodeEvent = {
        type: t,
        properties: { info: { id: `s-${t}` } },
      };
      expect(extractSessionId(e)).toBe(`s-${t}`);
    }
  });

  test("session.idle / session.error read sessionID directly from properties (SDK実測形)", () => {
    // docs/SDK_NOTES.md per @opencode-ai/sdk@1.15.12: session.idle/error の sessionID は
    // properties.info.id ではなく properties.sessionID 直接。
    const types = ["session.idle", "session.error"] as const;
    for (const t of types) {
      const e: OpenCodeEvent = {
        type: t,
        properties: { sessionID: `s-${t}` },
      };
      expect(extractSessionId(e)).toBe(`s-${t}`);
    }
  });

  test("returns undefined for unknown event types", () => {
    const e: OpenCodeEvent = {
      type: "tool.completed",
      properties: { info: { sessionID: "ignored" } },
    };
    expect(extractSessionId(e)).toBeUndefined();
  });

  test("returns undefined when the expected nested field is missing", () => {
    expect(
      extractSessionId({ type: "message.updated", properties: {} }),
    ).toBeUndefined();
    expect(
      extractSessionId({
        type: "message.part.updated",
        properties: { info: { sessionID: "ignored" } } as never,
      }),
    ).toBeUndefined();
    expect(
      extractSessionId({ type: "session.idle", properties: {} }),
    ).toBeUndefined();
  });

  test("message.updated and message.part.updated read DIFFERENT paths (silent-failure regression guard)", () => {
    // If a future change accidentally unifies both paths to `properties.sessionID`,
    // this test catches it.
    const partEvent: OpenCodeEvent = {
      type: "message.part.updated",
      properties: { info: { sessionID: "wrong-path" } } as never,
    };
    expect(extractSessionId(partEvent)).toBeUndefined();

    const updEvent: OpenCodeEvent = {
      type: "message.updated",
      properties: { part: { sessionID: "wrong-path" } } as never,
    };
    expect(extractSessionId(updEvent)).toBeUndefined();
  });
});

describe("isUserMessage (initial-trigger role determination)", () => {
  test("true only for message.updated with role=user and non-empty parts", () => {
    expect(
      isUserMessage({
        type: "message.updated",
        properties: { info: { role: "user", sessionID: "s", parts: [{ type: "text", text: "hello" }] } },
      }),
    ).toBe(true);
  });

  test("false for message.updated with role=user but empty parts", () => {
    expect(
      isUserMessage({
        type: "message.updated",
        properties: { info: { role: "user", sessionID: "s", parts: [] } },
      }),
    ).toBe(false);
  });

  test("false for message.updated with role=assistant", () => {
    expect(
      isUserMessage({
        type: "message.updated",
        properties: { info: { role: "assistant", sessionID: "s" } },
      }),
    ).toBe(false);
  });

  test("false for message.updated with role missing", () => {
    expect(
      isUserMessage({
        type: "message.updated",
        properties: { info: { sessionID: "s" } },
      }),
    ).toBe(false);
  });

  test("false for message.part.updated even if role=user is present (different event type)", () => {
    expect(
      isUserMessage({
        type: "message.part.updated",
        properties: { info: { role: "user" } } as never,
      }),
    ).toBe(false);
  });

  test("false for session.* events", () => {
    for (const t of ["session.created", "session.idle", "session.error", "session.deleted"]) {
      expect(
        isUserMessage({
          type: t,
          properties: { info: { role: "user", id: "s" } },
        }),
      ).toBe(false);
    }
  });
});

describe("isPingEvent", () => {
  test("identifies matching ping messages", () => {
    const matchingMsgEvent: OpenCodeEvent = {
      type: "message.updated",
      properties: {
        info: {
          role: "user",
          sessionID: "s",
          parts: [{ type: "text", text: "ping-msg" }],
        },
      },
    };
    const nonMatchingMsgEvent: OpenCodeEvent = {
      type: "message.updated",
      properties: {
        info: {
          role: "user",
          sessionID: "s",
          parts: [{ type: "text", text: "different-msg" }],
        },
      },
    };
    const matchingPartEvent: OpenCodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          text: "ping-msg",
        },
      },
    };

    expect(isPingEvent(matchingMsgEvent, "ping-msg")).toBe(true);
    expect(isPingEvent(nonMatchingMsgEvent, "ping-msg")).toBe(false);
    expect(isPingEvent(matchingPartEvent, "ping-msg")).toBe(true);
    expect(isPingEvent(matchingPartEvent, "different-msg")).toBe(false);

    // Partial match test cases (streaming simulation)
    const partialMsgEvent1: OpenCodeEvent = {
      type: "message.updated",
      properties: { info: { parts: [{ type: "text", text: "pin" }] } } as never,
    };
    const partialMsgEvent2: OpenCodeEvent = {
      type: "message.updated",
      properties: { info: { parts: [{ type: "text", text: "pi" }] } } as never,
    };
    const partialPartEvent1: OpenCodeEvent = {
      type: "message.part.updated",
      properties: { part: { text: "pin" } } as never,
    };
    const partialPartEvent2: OpenCodeEvent = {
      type: "message.part.updated",
      properties: { part: { text: "pi" } } as never,
    };

    expect(isPingEvent(partialMsgEvent1, "ping-msg")).toBe(true);
    expect(isPingEvent(partialMsgEvent2, "ping-msg")).toBe(true);
    expect(isPingEvent(partialPartEvent1, "ping-msg")).toBe(true);
    expect(isPingEvent(partialPartEvent2, "ping-msg")).toBe(true);

    // Extended message matching (e.g. contains why it hung reason information)
    const extendedMsgEvent: OpenCodeEvent = {
      type: "message.updated",
      properties: {
        info: {
          role: "user",
          sessionID: "s",
          parts: [{ type: "text", text: "ping-msg\n\n[Watchdog] 直前に次のエラーを検出しました..." }],
        },
      },
    };
    expect(isPingEvent(extendedMsgEvent, "ping-msg")).toBe(true);
  });
});

describe("extractMessageId (messageID extraction)", () => {
  test("extracts id from message.updated properties.info.id", () => {
    expect(
      extractMessageId({
        type: "message.updated",
        properties: { info: { id: "msg_123" } },
      }),
    ).toBe("msg_123");
  });

  test("extracts messageID from message.part.updated properties.part.messageID", () => {
    expect(
      extractMessageId({
        type: "message.part.updated",
        properties: { part: { messageID: "msg_456" } },
      }),
    ).toBe("msg_456");
  });

  test("returns undefined for other events", () => {
    expect(
      extractMessageId({
        type: "session.idle",
        properties: { sessionID: "s" },
      }),
    ).toBeUndefined();
  });
});

describe("isNewUserMessage (deduplication utility)", () => {
  test("returns true for a new message ID and false for subsequent checks of the same ID", () => {
    const msgId = `unique_msg_id_${Math.random()}`;
    expect(isNewUserMessage(msgId)).toBe(true);
    expect(isNewUserMessage(msgId)).toBe(false);
    expect(isNewUserMessage(msgId)).toBe(false);
  });

  test("returns true for different message IDs", () => {
    const msgId1 = `msg_id_a_${Math.random()}`;
    const msgId2 = `msg_id_b_${Math.random()}`;
    expect(isNewUserMessage(msgId1)).toBe(true);
    expect(isNewUserMessage(msgId2)).toBe(true);
  });
});

describe("routeSessionError (recoverable vs terminal)", () => {
  test("rate_limit → note (do not stop)", () => {
    expect(routeSessionError({ message: "rate limit 429" })).toEqual({
      action: "note",
      reason: "rate_limit",
    });
  });

  test("provider_timeout → note (do not stop)", () => {
    expect(routeSessionError({ message: "request timed out" })).toEqual({
      action: "note",
      reason: "provider_timeout",
    });
  });

  test("unknown error → stop", () => {
    expect(routeSessionError({ message: "weird explosion" })).toEqual({ action: "stop" });
  });

  test("unclassifiable (null) → stop", () => {
    expect(routeSessionError({})).toEqual({ action: "stop" });
    expect(routeSessionError(undefined)).toEqual({ action: "stop" });
  });

  test("session.error event routing in event hook", async () => {
    const fakeContext = {
      client: {
        app: { log: async () => undefined },
        session: { prompt: async () => undefined },
      },
      $: () => undefined,
      directory: `${process.cwd()}/test-session-error-${Math.random()}`,
      worktree: process.cwd(),
    };

    const instance = await (plugin.server as (ctx: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(fakeContext);

    try {
      // 1. Recoverable error (rate limit) should noteError (does not throw)
      await instance.event({
        event: {
          type: "session.error",
          properties: {
            sessionID: "s-err-recoverable",
            message: "rate limit 429",
          },
        },
      });

      // 2. Terminal error should stop (does not throw)
      await instance.event({
        event: {
          type: "session.error",
          properties: {
            sessionID: "s-err-terminal",
            message: "weird explosion",
          },
        },
      });
    } finally {
      await instance.dispose();
    }
  });
});

describe("tool-part routing (design §5)", () => {
  test("pending status does not throw", async () => {
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/tool-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx);
    try {
      await instance.event({
        event: {
          type: "message.part.updated",
          properties: { part: { sessionID: "s1", type: "tool", callID: "call_1", state: { status: "pending" } } },
        },
      });
    } finally {
      await instance.dispose();
    }
  });

  test("running → completed transition does not throw", async () => {
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/tool-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx);
    try {
      for (const status of ["running", "completed"]) {
        await instance.event({
          event: {
            type: "message.part.updated",
            properties: { part: { sessionID: "s1", type: "tool", callID: "call_1", state: { status } } },
          },
        });
      }
    } finally {
      await instance.dispose();
    }
  });

  test("running → error transition does not throw", async () => {
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/tool-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx);
    try {
      for (const status of ["running", "error"]) {
        await instance.event({
          event: {
            type: "message.part.updated",
            properties: { part: { sessionID: "s1", type: "tool", callID: "call_2", state: { status } } },
          },
        });
      }
    } finally {
      await instance.dispose();
    }
  });

  test("running event routes to onToolRunning with correct sessionId and callId", async () => {
    const watchdog = setupMockWatchdog();
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/tool-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown, o?: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx, { _watchdog: watchdog });
    try {
      await instance.event({
        event: {
          type: "message.part.updated",
          properties: { part: { sessionID: "s1", type: "tool", callID: "call_1", state: { status: "running" } } },
        },
      });
      expect(watchdog.onToolRunningCalls).toEqual([{ sessionId: "s1", callId: "call_1" }]);
      expect(watchdog.onToolSettledCalls).toEqual([]);
    } finally {
      await instance.dispose();
    }
  });

  test("completed event routes to onToolSettled with correct sessionId and callId", async () => {
    const watchdog = setupMockWatchdog();
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/tool-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown, o?: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx, { _watchdog: watchdog });
    try {
      await instance.event({
        event: {
          type: "message.part.updated",
          properties: { part: { sessionID: "s1", type: "tool", callID: "call_1", state: { status: "completed" } } },
        },
      });
      expect(watchdog.onToolSettledCalls).toEqual([{ sessionId: "s1", callId: "call_1" }]);
      expect(watchdog.onToolRunningCalls).toEqual([]);
    } finally {
      await instance.dispose();
    }
  });

  test("error event routes to onToolSettled with correct sessionId and callId", async () => {
    const watchdog = setupMockWatchdog();
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/tool-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown, o?: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx, { _watchdog: watchdog });
    try {
      await instance.event({
        event: {
          type: "message.part.updated",
          properties: { part: { sessionID: "s1", type: "tool", callID: "call_2", state: { status: "error" } } },
        },
      });
      expect(watchdog.onToolSettledCalls).toEqual([{ sessionId: "s1", callId: "call_2" }]);
      expect(watchdog.onToolRunningCalls).toEqual([]);
    } finally {
      await instance.dispose();
    }
  });

  test("pending event routes to onActivity, not onToolRunning/onToolSettled", async () => {
    const watchdog = setupMockWatchdog();
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/tool-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown, o?: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx, { _watchdog: watchdog });
    try {
      await instance.event({
        event: {
          type: "message.part.updated",
          properties: { part: { sessionID: "s1", type: "tool", callID: "call_1", state: { status: "pending" } } },
        },
      });
      expect(watchdog.onToolRunningCalls).toEqual([]);
      expect(watchdog.onToolSettledCalls).toEqual([]);
      expect(watchdog.onActivityCalls.some((c) => c.sessionId === "s1")).toBe(true);
    } finally {
      await instance.dispose();
    }
  });
});

describe("input-wait routing (design §5/§6.2)", () => {
  test("extractSessionId reads permission/question sessionID from properties.sessionID", () => {
    for (const t of ["permission.asked", "permission.replied", "question.asked", "question.replied"]) {
      expect(extractSessionId({ type: t, properties: { sessionID: "s-in" } })).toBe("s-in");
    }
  });

  test("extractRequestId: asked→properties.id, replied→properties.requestID", () => {
    expect(extractRequestId({ type: "permission.asked", properties: { id: "per_1" } })).toBe("per_1");
    expect(extractRequestId({ type: "question.asked", properties: { id: "que_1" } })).toBe("que_1");
    expect(extractRequestId({ type: "permission.replied", properties: { requestID: "per_1" } })).toBe("per_1");
    expect(extractRequestId({ type: "question.replied", properties: { requestID: "que_1" } })).toBe("que_1");
    expect(extractRequestId({ type: "message.updated", properties: {} })).toBeUndefined();
  });

  test("event hook does not throw on asked/replied payloads", async () => {
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/input-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx);
    try {
      await instance.event({ event: { type: "permission.asked", properties: { sessionID: "s1", id: "per_1" } } });
      await instance.event({ event: { type: "permission.replied", properties: { sessionID: "s1", requestID: "per_1" } } });
      await instance.event({ event: { type: "question.asked", properties: { sessionID: "s1", id: "que_1" } } });
      await instance.event({ event: { type: "question.replied", properties: { sessionID: "s1", requestID: "que_1" } } });
    } finally {
      await instance.dispose();
    }
  });
});

describe("message.part.delta signal (design §5)", () => {
  test("extractSessionId reads delta sessionID from properties.sessionID", () => {
    expect(
      extractSessionId({ type: "message.part.delta", properties: { sessionID: "s-delta" } }),
    ).toBe("s-delta");
  });

  test("extractMessageId reads delta messageID from properties.messageID", () => {
    expect(
      extractMessageId({ type: "message.part.delta", properties: { messageID: "m-delta" } }),
    ).toBe("m-delta");
  });

  test("extractAgentName reads agent from properties.part.agent for delta", () => {
    expect(
      extractAgentName({ type: "message.part.delta", properties: { part: { agent: "coder" } } }),
    ).toBe("coder");
  });

  test("event hook triggers onActivity for delta with agentName", async () => {
    const watchdog = setupMockWatchdog();
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/delta-act-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as any)(ctx, { _watchdog: watchdog });
    try {
      await instance.event({
        event: {
          type: "message.part.delta",
          properties: { sessionID: "s-delta", messageID: "m-delta", part: { agent: "coder" } },
        },
      });
      expect(watchdog.onActivityCalls.length).toBe(1);
      expect(watchdog.onActivityCalls[0]!.sessionId).toBe("s-delta");
      expect(watchdog.onActivityCalls[0]!.meta.agentName).toBe("coder");
    } finally {
      await instance.dispose();
    }
  });

  test("event hook ignores delta WITHOUT agentName (Issue 1 fix verification)", async () => {
    const watchdog = setupMockWatchdog();
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/delta-ign-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as any)(ctx, { _watchdog: watchdog });
    try {
      await instance.event({
        event: {
          type: "message.part.delta",
          properties: { sessionID: "s-delta", messageID: "m-delta" }, // agentName missing
        },
      });
      expect(watchdog.onActivityCalls.length).toBe(0);
    } finally {
      await instance.dispose();
    }
  });

  test("event hook does not throw on a delta payload", async () => {
    const ctx = {
      client: { app: { log: async () => undefined }, session: { prompt: async () => undefined } },
      $: () => undefined,
      directory: `${process.cwd()}/delta-${Math.random()}`,
      worktree: process.cwd(),
    };
    const instance = await (plugin.server as (c: unknown) => Promise<{
      event: (e: { event: unknown }) => Promise<void>;
      dispose: () => Promise<void>;
    }>)(ctx);
    try {
      await instance.event({
        event: { type: "message.part.delta", properties: { sessionID: "s1", messageID: "m1", delta: "hi" } },
      });
    } finally {
      await instance.dispose();
    }
  });
});
