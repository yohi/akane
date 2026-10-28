import * as fs from "node:fs";
import * as path from "node:path";

export type WatchdogSessionState =
  | "WATCHING"
  | "STAGE1_NOTIFIED"
  | "PINGED"
  | "SILENCED"
  | "PAUSED"
  | "IDLE";

export interface SharedSessionState {
  state: WatchdogSessionState;
  agentName?: string;
  lastActivityAt?: number;
  errorReason?: string;
  runningToolsCount: number;
  pendingRequestsCount: number;
}

export interface SharedTelemetry {
  hangupsDetected: number;
  pingsSent: number;
  recoveries: number;
  silencedFailures: number;
}

export interface SharedWatchdogState {
  version?: 1;
  enabled: boolean;
  timestamp: number;
  global: SharedTelemetry;
  sessions: Record<string, SharedSessionState>;
}

function defaultState(): SharedWatchdogState {
  return {
    version: 1,
    enabled: true,
    timestamp: 0,
    global: {
      hangupsDetected: 0,
      pingsSent: 0,
      recoveries: 0,
      silencedFailures: 0,
    },
    sessions: {},
  };
}

const WRITE_THROTTLE_MS = 100;
const STATE_FILE_NAME = "watchdog-state.json";
const STATE_DIR_NAME = ".akane";

export class WatchdogStateStore {
  private readonly directory: string;
  private readonly filePath: string;
  private state: SharedWatchdogState;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite = false;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(directory: string) {
    this.directory = directory;
    this.filePath = path.join(directory, STATE_DIR_NAME, STATE_FILE_NAME);
    const loaded = this.load();
    // Old session timers do not survive a server restart. Retain history but
    // never present an unobserved prior-process session as active.
    this.state = {
      ...loaded,
      sessions: Object.fromEntries(Object.entries(loaded.sessions).map(([id, session]) => [
        id, { ...session, state: "IDLE" as const, runningToolsCount: 0, pendingRequestsCount: 0 },
      ])),
    };
  }

  private load(): SharedWatchdogState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isSharedWatchdogState(parsed)) {
        return { ...parsed, version: 1 };
      }
    } catch {
      // File missing or corrupt — start fresh.
    }
    return defaultState();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors.
      }
    }
  }

  private scheduleWrite(): void {
    if (this.disposed) return;
    if (this.pendingWrite) return;
    this.pendingWrite = true;
    this.writeTimer = setTimeout(() => {
      this.flush();
    }, WRITE_THROTTLE_MS);
  }

  private flush(): void {
    if (this.disposed) return;
    this.pendingWrite = false;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.warn(`[watchdog] Failed to write shared state: ${String(err)}`);
    }
  }

  getSnapshot(): SharedWatchdogState {
    return {
      ...this.state,
      global: { ...this.state.global },
      sessions: Object.fromEntries(
        Object.entries(this.state.sessions).map(([id, s]) => [id, { ...s }]),
      ),
    };
  }

  setEnabled(enabled: boolean): void {
    this.state.enabled = enabled;
    this.state.timestamp = Date.now();
    this.emit();
    this.scheduleWrite();
  }

  setSession(sessionId: string, session: SharedSessionState): void {
    this.state.sessions[sessionId] = { ...session };
    this.state.timestamp = Date.now();
    this.emit();
    this.scheduleWrite();
  }

  removeSession(sessionId: string): void {
    delete this.state.sessions[sessionId];
    this.state.timestamp = Date.now();
    this.emit();
    this.scheduleWrite();
  }

  setGlobal(global: SharedTelemetry): void {
    this.state.global = { ...global };
    this.state.timestamp = Date.now();
    this.emit();
    this.scheduleWrite();
  }

  refresh(): void {
    this.state = this.load();
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.flush();
    this.disposed = true;
    this.listeners.clear();

    if (stores.get(this.directory) === this) {
      stores.delete(this.directory);
    }
  }
}

const stores = new Map<string, WatchdogStateStore>();
const storeUsers = new WeakMap<WatchdogStateStore, number>();

export function getStateStore(directory: string): WatchdogStateStore {
  const existing = stores.get(directory);
  if (existing && !existing.isDisposed) {
    return existing;
  }
  const store = new WatchdogStateStore(directory);
  stores.set(directory, store);
  return store;
}

/**
 * Registers a new user of the shared store. Instances that share one directory
 * must keep the store alive for each other — the store is disposed only after
 * the last active instance releases it.
 */
export function acquireStateStore(directory: string): WatchdogStateStore {
  const store = getStateStore(directory);
  storeUsers.set(store, (storeUsers.get(store) ?? 0) + 1);
  return store;
}

/**
 * Drops one user reference taken by acquireStateStore. Only when the last
 * user has left is the shared store invalidated and disposed (flushing any
 * pending writes so the TUI still sees the final state).
 */
export function releaseStateStore(store: WatchdogStateStore): void {
  if (store.isDisposed) return;
  const users = storeUsers.get(store) ?? 0;
  if (users > 1) {
    storeUsers.set(store, users - 1);
    return;
  }
  storeUsers.delete(store);
  try {
    store.setEnabled(false);
  } finally {
    store.dispose();
  }
}

export function clearStateStoreCache(): void {
  for (const store of stores.values()) {
    store.dispose();
  }
  stores.clear();
}

function isSharedTelemetry(value: unknown): value is SharedTelemetry {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<SharedTelemetry>;
  return (
    typeof c.hangupsDetected === "number" &&
    typeof c.pingsSent === "number" &&
    typeof c.recoveries === "number" &&
    typeof c.silencedFailures === "number"
  );
}

const WATCHDOG_SESSION_STATES = new Set<WatchdogSessionState>([
  "WATCHING",
  "STAGE1_NOTIFIED",
  "PINGED",
  "SILENCED",
  "PAUSED",
  "IDLE",
]);

function isSharedSessionState(value: unknown): value is SharedSessionState {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<SharedSessionState>;
  return (
    typeof c.state === "string" &&
    WATCHDOG_SESSION_STATES.has(c.state as WatchdogSessionState) &&
    typeof c.runningToolsCount === "number" &&
    typeof c.pendingRequestsCount === "number" &&
    (c.agentName === undefined || typeof c.agentName === "string") &&
    (c.lastActivityAt === undefined || typeof c.lastActivityAt === "number") &&
    (c.errorReason === undefined || typeof c.errorReason === "string")
  );
}

export function isSharedWatchdogState(value: unknown): value is SharedWatchdogState {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<SharedWatchdogState>;
  return (
    (c.version === undefined || c.version === 1) &&
    typeof c.enabled === "boolean" &&
    typeof c.timestamp === "number" &&
    isSharedTelemetry(c.global) &&
    c.sessions !== null &&
    typeof c.sessions === "object" &&
    Object.values(c.sessions).every(isSharedSessionState)
  );
}
