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
  ) {}

  async inject(sessionId: string, message: string, context?: PingContext): Promise<void> {
    const client = this.client as OpenCodeClientLike;
    const session = client?.session;
    if (typeof session?.prompt !== "function") {
      console.warn(
        `[watchdog] OpenCode client.session.prompt is unavailable; cannot inject ping to ${sessionId}.`,
      );
      return;
    }
    const finalMessage = buildPingPrompt(message, context?.reason);
    const parts = [{ type: "text", text: finalMessage }];
    try {
      // Preferred V2 interrupt delivery. Per-call attempt (no permanent switch).
      await session.prompt({ sessionID: sessionId, parts, delivery: this.delivery });
    } catch (err) {
      // Only fall back to legacy when V2 rejected the shape/field.
      // Other errors (network, parse failures after delivery, etc.) must NOT
      // proceed to legacy – doing so risks double-delivery.
      const msg = err instanceof Error ? err.message : String(err);
      const isShapeRejection = /unknown[_\s]field|unrecognized[_\s]field/i.test(msg);
      if (!isShapeRejection) {
        console.warn(
          `[watchdog] V2 prompt threw a non-shape error for ${sessionId}; skipping legacy fallback. err=${msg}`,
        );
        return;
      }
      console.warn(
        `[watchdog] V2 prompt rejected the request shape for ${sessionId}; falling back to legacy. err=${msg}`,
      );
      try {
        await session.prompt({ path: { id: sessionId }, body: { parts } });
      } catch (legacyErr) {
        console.warn(
          `[watchdog] Failed to inject ping to ${sessionId} (V2 steer and legacy both failed). err=${legacyErr instanceof Error ? legacyErr.message : String(legacyErr)}`,
        );
      }
    }
  }
}
