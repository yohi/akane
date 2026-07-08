import * as fs from "node:fs";
import * as path from "node:path";

export interface LockRecord {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

export interface MonitorLockDeps {
  dir: string; // eventsDir
  pid: number;
  startedAt: number;
  now: () => number;
  ttlMs: number;
  isAlive?: (pid: number) => boolean;
  procStartTime?: (pid: number) => number | null;
}

const LOCK_FILE = "monitor.lock";

export class MonitorLock {
  private readonly filePath: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly procStartTime: (pid: number) => number | null;

  constructor(private readonly deps: MonitorLockDeps) {
    this.filePath = path.join(deps.dir, LOCK_FILE);
    this.isAlive = deps.isAlive ?? defaultIsAlive;
    this.procStartTime = deps.procStartTime ?? defaultProcStartTime;
  }

  private read(): LockRecord | null {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LockRecord>;
      if (
        typeof parsed.pid === "number" &&
        typeof parsed.startedAt === "number" &&
        typeof parsed.heartbeatAt === "number"
      ) {
        return parsed as LockRecord;
      }
    } catch {
      // Missing / corrupt — treat as no lock.
    }
    return null;
  }

  private write(record: LockRecord): void {
    fs.mkdirSync(this.deps.dir, { recursive: true });
    // Use PID-unique tmp name to avoid cross-process renameSync ENOENT race at cold start.
    const tmp = `${this.filePath}.${this.deps.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, this.filePath);
  }

  private isMine(record: LockRecord): boolean {
    return record.pid === this.deps.pid && record.startedAt === this.deps.startedAt;
  }

  private isStale(record: LockRecord): boolean {
    if (!this.isAlive(record.pid)) return true; // dead PID (SPEC §8.3-2)
    const started = this.procStartTime(record.pid);
    if (started !== null && started !== record.startedAt) return true; // PID reused
    return this.deps.now() - record.heartbeatAt > this.deps.ttlMs; // heartbeat expired (§8.3-3)
  }

  tryAcquire(): boolean {
    const existing = this.read();
    if (existing && !this.isMine(existing) && !this.isStale(existing)) {
      return false; // healthy foreign owner (SPEC §8.3-4)
    }
    this.write({ pid: this.deps.pid, startedAt: this.deps.startedAt, heartbeatAt: this.deps.now() });
    return true;
  }

  // SPEC §8.3 退場手順-1: re-read before writing; if we no longer own the lock,
  // report loss so the caller tears down instead of clobbering the new owner.
  heartbeat(): boolean {
    const current = this.read();
    if (!current || !this.isMine(current)) return false;
    this.write({ pid: this.deps.pid, startedAt: this.deps.startedAt, heartbeatAt: this.deps.now() });
    return true;
  }

  // SPEC §8.3 退場手順-2: synchronous ownership gate before side effects.
  isOwned(): boolean {
    const current = this.read();
    return current !== null && this.isMine(current);
  }

  release(): void {
    if (this.isOwned()) {
      try {
        fs.rmSync(this.filePath);
      } catch {
        // Already removed — tolerated.
      }
    }
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Linux /proc start time (clock ticks since boot, stable per process). Returns
// null on any other platform, degrading staleness detection to heartbeat TTL.
function defaultProcStartTime(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const starttime = Number(afterComm[19]); // field 22 (1-based) after (pid,comm)
    return Number.isFinite(starttime) ? starttime : null;
  } catch {
    return null;
  }
}

// The monitor's startedAt MUST come from the same source used in isStale so a
// healthy owner never looks reused: OS proc start time, else a boot timestamp.
export function computeStartedAt(
  pid: number,
  procStartTime: (pid: number) => number | null = defaultProcStartTime,
  fallbackNow: number = Date.now(),
): number {
  return procStartTime(pid) ?? fallbackNow;
}
