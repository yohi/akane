import { describe, test, expect } from "bun:test";
import plugin, {
  extractSessionId,
  isUserMessage,
  type OpenCodeEvent,
} from "../src/index";

describe("plugin entry smoke", () => {
  test("default export is a Plugin function", () => {
    expect(typeof plugin).toBe("function");
  });

  test("instantiated plugin exposes event handler", async () => {
    const fakeContext = {
      client: {
        app: { log: async () => undefined },
        session: { prompt: async () => undefined },
      },
      $: () => undefined,
      directory: process.cwd(),
      worktree: process.cwd(),
    };
    const instance = await (plugin as (ctx: unknown) => Promise<{ event: unknown }>)(
      fakeContext,
    );
    expect(typeof instance.event).toBe("function");
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
    const instance = await (plugin as (ctx: unknown) => Promise<{
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
  test("true only for message.updated with role=user", () => {
    expect(
      isUserMessage({
        type: "message.updated",
        properties: { info: { role: "user", sessionID: "s" } },
      }),
    ).toBe(true);
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
