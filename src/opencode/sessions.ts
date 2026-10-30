import type { HostSession, SessionPort } from "./types";

export interface SessionRegistry {
  readonly directory: string;
  resolve(sessionID: string): Promise<SessionResolution>;
  invalidate(sessionID: string): void;
  dispose(): void;
}

export type SessionResolution =
  | { readonly kind: "owned"; readonly session: HostSession }
  | { readonly kind: "foreign" }
  | { readonly kind: "error" };

export function createSessionRegistry(
  session: Pick<SessionPort, "get">,
  directory: string,
  log: (message: string) => void = (message) => console.warn(`[watchdog] ${message}`),
): SessionRegistry {
  const generations = new Map<string, number>();
  let disposed = false;
  return {
    directory,
    async resolve(sessionID) {
      if (disposed) return { kind: "foreign" };
      const generation = generations.get(sessionID) ?? 0;
      try {
        const result = await session.get({ sessionID });
        if (disposed || (generations.get(sessionID) ?? 0) !== generation) return { kind: "foreign" };
        return result.location.directory === directory
          ? { kind: "owned", session: result }
          : { kind: "foreign" };
      } catch (error) {
        const errorType = error instanceof Error ? error.name : typeof error;
        log(`Session lookup failed type=${errorType}`);
        return { kind: "error" };
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
