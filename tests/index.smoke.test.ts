import { describe, test, expect } from "bun:test";
import plugin, {
  extractSessionId,
  isUserMessage,
  isPingEvent,
  extractMessageId,
  isNewUserMessage,
  type OpenCodeEvent,
} from "../src/index";

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
