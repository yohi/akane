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

// V2: prompt({ sessionID, parts, delivery }); legacy: prompt({ path:{id}, body:{parts} }).
// Exact runtime shape is isolated here (SPEC §8.2). Loosely typed because two
// shapes share the method.
interface OpenCodeClientLike {
  session?: {
    prompt?: (args: Record<string, unknown>) => Promise<unknown>;
  };
}

export class OpenCodeAdapter implements Pinger {
  constructor(
    private readonly client: unknown,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async inject(sessionId: string, message: string, context?: PingContext): Promise<void> {
    this.log(`PINGER inject called sessionId=${sessionId}`);
    const client = this.client as OpenCodeClientLike;
    const session = client?.session;
    if (typeof session?.prompt !== "function") {
      const msg = `[watchdog] OpenCode client.session.prompt is unavailable; cannot inject ping to ${sessionId}.`;
      console.warn(msg);
      this.log(msg);
      return;
    }
    const finalMessage = buildPingPrompt(message, context?.reason);
    const parts = [{ type: "text", text: finalMessage }];
    try {
      this.log(`PINGER legacy attempt sessionId=${sessionId}`);
      // The installed @opencode-ai/sdk@1.15.12 `session.prompt` expects the
      // legacy { path: { id }, body: { parts } } shape. The V2 interrupt shape
      // is not supported by this SDK version and resolves without injecting.
      await session.prompt({ path: { id: sessionId }, body: { parts } });
      this.log(`PINGER legacy success sessionId=${sessionId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`PINGER legacy failed sessionId=${sessionId} err=${msg}`);
      console.warn(`[watchdog] Failed to inject ping to ${sessionId}. err=${msg}`);
    }
  }
}
