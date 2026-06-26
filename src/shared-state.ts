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
  enabled: boolean;
  timestamp: number;
  global: SharedTelemetry;
  sessions: Record<string, SharedSessionState>;
}

function defaultState(): SharedWatchdogState {
  return {
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
  private readonly filePath: string;
  private state: SharedWatchdogState;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite = false;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(directory: string) {
    this.filePath = path.join(directory, STATE_DIR_NAME, STATE_FILE_NAME);
    this.state = this.load();
  }

  private load(): SharedWatchdogState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isSharedWatchdogState(parsed)) {
        return parsed;
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
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
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

  dispose(): void {
    if (this.disposed) return;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.flush();
    this.disposed = true;
    this.listeners.clear();
  }
}

const stores = new Map<string, WatchdogStateStore>();

export function getStateStore(directory: string): WatchdogStateStore {
  if (!stores.has(directory)) {
    stores.set(directory, new WatchdogStateStore(directory));
  }
  return stores.get(directory)!;
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

function isSharedSessionState(value: unknown): value is SharedSessionState {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<SharedSessionState>;
  return (
    typeof c.state === "string" &&
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
    typeof c.enabled === "boolean" &&
    typeof c.timestamp === "number" &&
    isSharedTelemetry(c.global) &&
    c.sessions !== null &&
    typeof c.sessions === "object" &&
    Object.values(c.sessions).every(isSharedSessionState)
  );
}
