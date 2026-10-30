export type RecoveryPhase = "admitting" | "interrupting" | "resumed" | "settled";

export interface RecoveryTracker {
  register(sessionID: string, messageID: string): number;
  isOwnMessage(sessionID: string, messageID: string): boolean;
  isCurrent(sessionID: string, generation: number): boolean;
  generation(sessionID: string): number | undefined;
  supersede(sessionID: string): void;
  phase(sessionID: string): RecoveryPhase | undefined;
  transition(sessionID: string, generation: number, phase: RecoveryPhase): boolean;
  dispose(): void;
}

export function createRecoveryTracker(limit = 1000): RecoveryTracker {
  const messages = new Map<string, string>();
  const generations = new Map<string, number>();
  const phases = new Map<string, RecoveryPhase>();
  let next = 0;
  let disposed = false;
  const current = (sessionID: string, generation: number): boolean =>
    !disposed && generations.get(sessionID) === generation;
  return {
    register(sessionID, messageID) {
      if (disposed) return -1;
      const generation = ++next;
      generations.set(sessionID, generation);
      phases.set(sessionID, "admitting");
      messages.set(messageID, sessionID);
      while (messages.size > limit) {
        const oldest = messages.keys().next().value;
        if (oldest === undefined) break;
        messages.delete(oldest);
      }
      return generation;
    },
    isOwnMessage: (sessionID, messageID) => messages.get(messageID) === sessionID,
    isCurrent: current,
    generation: (sessionID) => generations.get(sessionID),
    supersede(sessionID) {
      generations.delete(sessionID);
      phases.delete(sessionID);
    },
    phase: (sessionID) => phases.get(sessionID),
    transition(sessionID, generation, phase) {
      if (!current(sessionID, generation)) return false;
      phases.set(sessionID, phase);
      return true;
    },
    dispose() {
      disposed = true;
      generations.clear();
      phases.clear();
      messages.clear();
    },
  };
}
