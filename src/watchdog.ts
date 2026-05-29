import type { Clock, TimerHandle } from "./clock";
import type { Notifier } from "./notifier";
import type { Pinger } from "./pinger";
import type { WatchdogConfig } from "./config";

type State = "WATCHING" | "STAGE1_NOTIFIED" | "PINGED" | "SILENCED";

interface SessionEntry {
  state: State;
  timer: TimerHandle | null;
  pingCount: number;
  agentName?: string;
}

export interface WatchdogDeps {
  config: WatchdogConfig;
  clock: Clock;
  notifier: Notifier;
  pinger: Pinger;
  log?: (level: "info" | "warn", message: string) => void;
}

export interface ActivityMeta {
  agentName?: string;
}

// FIFO-bounded tombstone set. Used to suppress late `message.part.updated`
// events arriving after `session.idle/error/deleted` per design §7.3.
// `onUserMessage` (fresh user input) explicitly clears the tombstone — that is
// the documented re-entry point from IDLE → WATCHING in §3.4.
const STOPPED_TOMBSTONE_CAPACITY = 10_000;

export class Watchdog {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly stoppedSessions = new Set<string>();
  private readonly config: WatchdogConfig;
  private readonly clock: Clock;
  private readonly notifier: Notifier;
  private readonly pinger: Pinger;
  private readonly log: (level: "info" | "warn", message: string) => void;

  constructor(deps: WatchdogDeps) {
    this.config = deps.config;
    this.clock = deps.clock;
    this.notifier = deps.notifier;
    this.pinger = deps.pinger;
    this.log = deps.log ?? ((level, m) => console[level](`[watchdog] ${m}`));
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }

  /** Number of sessions currently holding a non-null timer reference. Distinct
   * from activeSessionCount — a session in SILENCED state has an entry but no
   * scheduled timer. Used by stress tests to detect timer leaks (design §7.4).
   */
  activeTimerCount(): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.timer !== null) count += 1;
    }
    return count;
  }

  /** Session created event — informational only. Do not arm timers. */
  onSessionCreated(_sessionId: string): void {
    // intentionally noop per design §2.3
  }

  /**
   * User message confirmed — initial trigger (design §3.4 IDLE → WATCHING).
   * Clears any tombstone so a previously stopped session can be re-armed on
   * fresh user input, then delegates to the same WATCHING entry creation as
   * onActivity.
   */
  onUserMessage(sessionId: string, meta: ActivityMeta = {}): void {
    this.clearTombstone(sessionId);
    this.armOrReset(sessionId, meta);
  }

  /**
   * Activity from `message.part.updated`. If the session is in the stopped
   * tombstone set, the event is treated as stale and ignored (design §7.3).
   */
  onActivity(sessionId: string, meta: ActivityMeta = {}): void {
    if (this.stoppedSessions.has(sessionId)) return;
    this.armOrReset(sessionId, meta);
  }

  /** Session terminated normally or with error. Tombstones the sessionId. */
  stop(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.timer !== null) this.clock.clearTimeout(entry.timer);
    this.sessions.delete(sessionId);
    this.recordTombstone(sessionId);
    this.notifier.clear(sessionId).catch((err) =>
      this.log("warn", `notifier.clear failed: ${String(err)}`),
    );
  }

  private armOrReset(sessionId: string, meta: ActivityMeta): void {
    if (!this.config.enabled) return;

    const existing = this.sessions.get(sessionId);
    const effectiveName = meta.agentName ?? existing?.agentName;
    if (!this.isAgentMonitored(effectiveName)) return;

    if (existing && existing.timer !== null) {
      this.clock.clearTimeout(existing.timer);
    }
    if (existing && existing.state !== "WATCHING") {
      this.notifier.clear(sessionId).catch((err) =>
        this.log("warn", `notifier.clear on reset failed: ${String(err)}`),
      );
    }
    // pingCount は activity 復帰時に常に 0 へリセット (design §3.4)。
    // SILENCED から WATCHING へ戻った場合に Ping 注入の余地を再度確保するため。
    const entry: SessionEntry = {
      state: "WATCHING",
      timer: null,
      pingCount: 0,
      agentName: effectiveName,
    };

    entry.timer = this.clock.setTimeout(() => {
      this.onStage1Expire(sessionId).catch((err) =>
        this.log("warn", `stage1 handler failed: ${String(err)}`),
      );
    }, this.config.stage1Ms);

    this.sessions.set(sessionId, entry);
  }

  private recordTombstone(sessionId: string): void {
    if (this.stoppedSessions.has(sessionId)) return;
    this.stoppedSessions.add(sessionId);
    if (this.stoppedSessions.size > STOPPED_TOMBSTONE_CAPACITY) {
      const oldest = this.stoppedSessions.keys().next().value;
      if (oldest !== undefined) this.stoppedSessions.delete(oldest);
    }
  }

  private clearTombstone(sessionId: string): void {
    this.stoppedSessions.delete(sessionId);
  }

  private async onStage1Expire(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.state = "STAGE1_NOTIFIED";
    entry.timer = this.clock.setTimeout(() => {
      this.onStage2Expire(sessionId).catch((err) =>
        this.log("warn", `stage2 handler failed: ${String(err)}`),
      );
    }, this.config.stage2Ms);
    // Message text per design §5.2 (stage1 row).
    await this.notifier.notify(
      sessionId,
      "warn",
      `[Watchdog] Agent ${sessionId} idle for ${this.config.stage1Ms}ms`,
    );
  }

  private async onStage2Expire(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (entry.pingCount < this.config.maxPings) {
      entry.state = "PINGED";
      entry.pingCount += 1;
      // Reset the stage2 timer to await response after ping.
      entry.timer = this.clock.setTimeout(() => {
        this.onStage2Expire(sessionId).catch((err) =>
          this.log("warn", `stage2 handler failed: ${String(err)}`),
        );
      }, this.config.stage2Ms);
      await this.pinger.inject(sessionId, this.config.pingMessage);
      if (!this.sessions.has(sessionId)) return;
      // Message text per design §5.2 (stage2 row).
      await this.notifier.notify(
        sessionId,
        "critical",
        `[Watchdog] Ping injected to ${sessionId}`,
      );
    } else {
      entry.state = "SILENCED";
      entry.timer = null;
      // Message text per design §5.2 (SILENCED row).
      await this.notifier.notify(
        sessionId,
        "silenced",
        "[Watchdog] Max pings reached. Manual intervention required.",
      );
    }
  }

  private isAgentMonitored(name: string | undefined): boolean {
    const { include, exclude } = this.config.agents;
    if (exclude && name && exclude.includes(name)) return false;
    if (include && include.length > 0) {
      if (!name) return false;
      return include.includes(name);
    }
    return true;
  }
}