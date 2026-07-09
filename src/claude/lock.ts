import * as fs from "node:fs";
import * as path from "node:path";

export interface LockRecord {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

export type HeartbeatResult = "ok" | "not_owner" | "io_error";

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
const GATE_STALE_MS = 5000;
const GATE_MAX_ATTEMPTS = 500;

export class MonitorLock {
  private readonly filePath: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly procStartTime: (pid: number) => number | null;
  private gateToken: string | null = null;

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

  private write(record: LockRecord): boolean {
    try {
      fs.mkdirSync(this.deps.dir, { recursive: true });
      // Use PID-unique tmp name to avoid cross-process renameSync ENOENT race at cold start.
      const tmp = `${this.filePath}.${this.deps.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch {
      // Failed lock writes must not throw (zero-crash §8.1); callers treat false as not acquired / ownership not refreshed.
      return false;
    }
  }

  private gatePath(): string {
    return `${this.filePath}.gate`;
  }

  private gateTokenPath(gate: string): string {
    return path.join(gate, "owner");
  }

  // Cross-process mutex guarding the read-decide-write critical section in
  // tryAcquire/heartbeat/release. mkdirSync is atomic (EEXIST on contention),
  // closing the TOCTOU window a plain read+write pair leaves open: without
  // this, two processes can both read a stale/absent lock and then both
  // write, with the second silently clobbering the first's ownership.
  // Staleness uses real wall-clock time (not deps.now(), which tests fake)
  // so a crashed holder's orphaned gate is force-cleared after a short,
  // generous bound instead of deadlocking every future acquisition attempt.
  // Each holder writes a random owner token into the gate on creation; a
  // slow-but-not-dead holder that only *looked* stale to a reclaimer will
  // therefore see its token missing in releaseGate() and skip the delete,
  // instead of tearing down whatever new holder has since taken the gate.
  private acquireGate(): boolean {
    const gate = this.gatePath();
    for (let attempt = 0; attempt < GATE_MAX_ATTEMPTS; attempt++) {
      try {
        fs.mkdirSync(gate);
        const token = `${this.deps.pid}.${this.deps.startedAt}.${Math.random().toString(36).slice(2)}`;
        try {
          fs.writeFileSync(this.gateTokenPath(gate), token);
        } catch {
          fs.rmSync(gate, { recursive: true, force: true });
          return false; // couldn't tag ownership; don't hold an unverifiable gate
        }
        this.gateToken = token;
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // Cold start: this.deps.dir itself doesn't exist yet. Create it and
          // retry — write() also mkdirSync's it, but the gate must exist first.
          try {
            fs.mkdirSync(this.deps.dir, { recursive: true });
          } catch {
            return false; // genuinely unwritable (permissions/disk) — fail closed
          }
          continue;
        }
        if (code !== "EEXIST") return false;
        try {
          if (Date.now() - fs.statSync(gate).mtimeMs > GATE_STALE_MS) {
            fs.rmSync(gate, { recursive: true, force: true });
          }
        } catch {
          // Gate vanished or stat/rm raced with another holder — retry.
        }
      }
    }
    return false;
  }

  private releaseGate(): void {
    const token = this.gateToken;
    this.gateToken = null;
    if (token === null) return;
    const gate = this.gatePath();
    try {
      if (fs.readFileSync(this.gateTokenPath(gate), "utf8") !== token) {
        return; // a reclaimer already deemed us stale and took the gate — not ours to remove
      }
    } catch {
      return; // gate/token already gone — tolerated
    }
    try {
      fs.rmSync(gate, { recursive: true, force: true });
    } catch {
      // Already removed — tolerated.
    }
  }

  private withGate<T>(fn: () => T, onGateUnavailable: () => T): T {
    if (!this.acquireGate()) return onGateUnavailable();
    try {
      return fn();
    } finally {
      this.releaseGate();
    }
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
    return this.withGate(
      () => {
        const existing = this.read();
        if (existing && !this.isMine(existing) && !this.isStale(existing)) {
          return false; // healthy foreign owner (SPEC §8.3-4)
        }
        return this.write({ pid: this.deps.pid, startedAt: this.deps.startedAt, heartbeatAt: this.deps.now() });
      },
      () => false, // gate contended/unavailable: fail closed, do not guess ownership
    );
  }

  // SPEC §8.3 退場手順-1: re-read before writing; if we no longer own the lock,
  // report loss so the caller tears down instead of clobbering the new owner.
  // Distinguishes ownership loss from a transient write I/O error: the former
  // means another process now owns the lock and we must stop immediately;
  // the latter is a local hiccup (disk full / EACCES / etc.) that the caller
  // may choose to retry a bounded number of times before giving up.
  heartbeat(): HeartbeatResult {
    return this.withGate(
      () => {
        const current = this.read();
        if (!current || !this.isMine(current)) return "not_owner";
        return this.write({ pid: this.deps.pid, startedAt: this.deps.startedAt, heartbeatAt: this.deps.now() })
          ? "ok"
          : "io_error";
      },
      () => "io_error" as HeartbeatResult, // gate contended: transient, caller may retry
    );
  }

  // SPEC §8.3 退場手順-2: synchronous ownership gate before side effects.
  isOwned(): boolean {
    const current = this.read();
    return current !== null && this.isMine(current);
  }

  release(): void {
    this.withGate(
      () => {
        if (this.isOwned()) {
          try {
            fs.rmSync(this.filePath);
          } catch {
            // Already removed — tolerated.
          }
        }
      },
      () => {}, // gate contended/unavailable: skip rather than risk an unsafe delete
    );
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
