import type { DeliveryMode } from "../config";
import { buildPingPrompt, type Pinger } from "../pinger";
import type { RecoveryTracker } from "./recovery";
import type { SessionRegistry } from "./sessions";
import type { SessionPort } from "./types";

interface Dependencies {
  readonly session: Pick<SessionPort, "prompt" | "interrupt">;
  readonly sessions: SessionRegistry;
  readonly recovery: RecoveryTracker;
  readonly delivery: DeliveryMode;
  readonly log: (message: string) => void;
}

export function createV2Pinger(deps: Dependencies): Pinger & { dispose(): Promise<void> } {
  const pending = new Set<Promise<void>>();
  let disposed = false;
  async function inject(sessionID: string, message: string, context?: Parameters<Pinger["inject"]>[2]): Promise<void> {
    if (disposed || (await deps.sessions.resolve(sessionID)).kind !== "owned" || disposed) return;
    const id = `msg_${crypto.randomUUID()}`;
    const maskedSessionID = `${sessionID.slice(0, 4)}***`;
    const generation = deps.recovery.register(sessionID, id);
    const work = (async () => {
      try {
        await deps.session.prompt({ sessionID, id, text: buildPingPrompt(message, context?.reason),
          delivery: deps.delivery, resume: deps.delivery === "queue" });
        deps.log(`[watchdog] Recovery prompt admitted sessionId=${maskedSessionID}`);
        if (disposed || !deps.recovery.isCurrent(sessionID, generation) || deps.delivery === "queue") return;
        if ((await deps.sessions.resolve(sessionID)).kind !== "owned" || disposed || !deps.recovery.isCurrent(sessionID, generation)) return;
        deps.recovery.transition(sessionID, generation, "interrupting");
        const result = await deps.session.interrupt({ sessionID, resume: true });
        if (deps.recovery.phase(sessionID) !== "settled") {
          deps.recovery.transition(sessionID, generation, result.interrupted ? "resumed" : "settled");
        }
        deps.log(`[watchdog] Recovery interrupt ${result.interrupted ? "accepted" : "rejected"} sessionId=${maskedSessionID}`);
      } catch (error) {
        deps.recovery.transition(sessionID, generation, "settled");
        const errorType = error instanceof Error ? error.name : typeof error;
        deps.log(`[watchdog] Recovery operation failed type=${errorType} sessionId=${maskedSessionID}`);
      }
    })();
    pending.add(work);
    try { await work; } finally { pending.delete(work); }
  }
  return { inject, async dispose() { disposed = true; await Promise.allSettled(pending); } };
}
