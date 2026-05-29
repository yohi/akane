export interface Pinger {
  inject(sessionId: string, message: string): Promise<void>;
}

export class MockPinger implements Pinger {
  public readonly calls: Array<{ sessionId: string; message: string }> = [];
  async inject(sessionId: string, message: string): Promise<void> {
    this.calls.push({ sessionId, message });
  }
}

// Shape derived from docs/SDK_NOTES.md (実測 @opencode-ai/plugin@1.15.12).
// `client.session.prompt({ path: { id }, body: { parts: [{ type: "text", text }] } })`
// SDK shape may diverge in future minor versions; if so, update SDK_NOTES first
// then adjust here. The Pinger interface above is fixed regardless.
interface OpenCodeClientLike {
  session?: {
    prompt?: (args: { path: { id: string }; body: { parts: unknown[] } }) => Promise<unknown>;
  };
}

export class OpenCodeAdapter implements Pinger {
  constructor(private readonly client: unknown) {}

  async inject(sessionId: string, message: string): Promise<void> {
    const client = this.client as OpenCodeClientLike;
    const session = client?.session;
    if (typeof session?.prompt !== "function") {
      console.warn(
        `[watchdog] OpenCode client.session.prompt is unavailable; cannot inject ping to ${sessionId}.`,
      );
      return;
    }
    try {
      await session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: message }] },
      });
    } catch (err) {
      console.warn(`[watchdog] Failed to inject ping to ${sessionId}:`, err);
    }
  }
}
