import { reasonToJa, type HangReason } from "./errors";
import type { DeliveryMode } from "./config";

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
    private readonly delivery: DeliveryMode = "steer",
    private readonly log: (message: string) => void = () => {},
  ) {}
  async inject(sessionId: string, message: string, context?: PingContext): Promise<void> {
    this.log(`PINGER inject called sessionId=${sessionId} delivery=${this.delivery}`);
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
      this.log(`PINGER V2 attempt sessionId=${sessionId}`);
      // Preferred V2 interrupt delivery. Per-call attempt (no permanent switch).
      await session.prompt({ sessionID: sessionId, parts, delivery: this.delivery });
      this.log(`PINGER V2 success sessionId=${sessionId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`PINGER V2 failed sessionId=${sessionId} err=${msg}`);
      console.warn(
        `[watchdog] V2 prompt failed for ${sessionId}; falling back to legacy. err=${msg}`,
      );
      try {
        this.log(`PINGER legacy attempt sessionId=${sessionId}`);
        await session.prompt({ path: { id: sessionId }, body: { parts } });
        this.log(`PINGER legacy success sessionId=${sessionId}`);
      } catch (legacyErr) {
        const legacyMsg = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
        this.log(`PINGER legacy failed sessionId=${sessionId} err=${legacyMsg}`);
        console.warn(
          `[watchdog] Failed to inject ping to ${sessionId} (V2 steer and legacy both failed). err=${legacyMsg}`,
        );
      }
    }
  }
}
