import { reasonToJa, type HangReason } from "./errors";

export interface PingContext {
  reason?: HangReason;
}

export interface Pinger {
  inject(sessionId: string, message: string, context?: PingContext): Promise<void>;
}

/**
 * Pure prompt builder (unit-tested). When `reason` is present, appends a
 * Japanese "why it hung" hint so the agent can recover with context.
 */
export function buildPingPrompt(base: string, reason?: HangReason): string {
  if (!reason) return base;
  return `${base}\n\n[Watchdog] 直前に次のエラーを検出しました（Why it hung）: ${reasonToJa(reason)}。これを踏まえて状況を立て直してください。`;
}

export class MockPinger implements Pinger {
  public readonly calls: Array<{ sessionId: string; message: string; context?: PingContext }> = [];
  async inject(sessionId: string, message: string, context?: PingContext): Promise<void> {
    this.calls.push({ sessionId, message, context });
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

  async inject(sessionId: string, message: string, _context?: PingContext): Promise<void> {
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
