import type { HostSession, SessionPort } from "./types";

export interface SessionRegistry {
  readonly directory: string;
  resolve(sessionID: string): Promise<HostSession | undefined>;
  invalidate(sessionID: string): void;
  dispose(): void;
}

export function createSessionRegistry(session: Pick<SessionPort, "get">, directory: string): SessionRegistry {
  const generations = new Map<string, number>();
  let disposed = false;
  return {
    directory,
    async resolve(sessionID) {
      if (disposed) return undefined;
      const generation = generations.get(sessionID) ?? 0;
      try {
        const result = await session.get({ sessionID });
        if (disposed || (generations.get(sessionID) ?? 0) !== generation) return undefined;
        return result.location.directory === directory ? result : undefined;
      } catch {
        return undefined;
      }
    },
    invalidate(sessionID) {
      generations.set(sessionID, (generations.get(sessionID) ?? 0) + 1);
    },
    dispose() {
      disposed = true;
      generations.clear();
    },
  };
}
