import type { Clock, TimerHandle } from "./clock";
import type { Notifier } from "./notifier";
import type { Pinger } from "./pinger";
import type { WatchdogConfig } from "./config";
import { NoopTelemetry, type Telemetry } from "./telemetry";
import type { HangReason } from "./errors";

type State = "WATCHING" | "STAGE1_NOTIFIED" | "PINGED" | "SILENCED" | "PAUSED";

interface SessionEntry {
  state: State;
  timer: TimerHandle | null;
  pingCount: number;
  agentName?: string;
  lastPingTime?: number;
  lastErrorReason?: HangReason;
  pendingRequests: Set<string>;
}

export interface WatchdogDeps {
  config: WatchdogConfig;
  clock: Clock;
  notifier: Notifier;
  pinger: Pinger;
  telemetry?: Telemetry;
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
  private readonly telemetry: Telemetry;
  private readonly log: (level: "info" | "warn", message: string) => void;

  constructor(deps: WatchdogDeps) {
    this.config = deps.config;
    this.clock = deps.clock;
    this.notifier = deps.notifier;
    this.pinger = deps.pinger;
    this.telemetry = deps.telemetry ?? new NoopTelemetry();
    this.log = deps.log ?? ((level, m) => console[level](`[watchdog] ${m}`));
  }

  getLastPingTime(sessionId: string): number {
    return this.sessions.get(sessionId)?.lastPingTime ?? 0;
  }

  /**
   * Records the last classified error reason for a monitored session so the next
   * ping can explain why it hung. Side effects are limited to the `sessions` Map:
   * a non-monitored / unknown session (no entry) is ignored, and the tombstone set
   * is never modified (design §4.3).
   */
  noteError(sessionId: string, reason: HangReason): void {
    if (this.stoppedSessions.has(sessionId)) return;
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastErrorReason = reason;
      this.log("info", `[Watchdog] noteError: session ${sessionId} reason=${reason}`);
    } else {
      this.log("info", `[Watchdog] noteError ignored: session ${sessionId} not monitored`);
    }
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
    this.log("info", `[Watchdog] onUserMessage for session ${sessionId}`);
    this.clearTombstone(sessionId);
    this.armOrReset(sessionId, meta);
  }

  /**
   * Activity from `message.part.updated`. If the session is in the stopped
   * tombstone set, the event is treated as stale and ignored (design §7.3).
   */
  onActivity(sessionId: string, meta: ActivityMeta = {}): void {
    if (this.stoppedSessions.has(sessionId)) {
      this.log("info", `[Watchdog] onActivity ignored: session ${sessionId} is in tombstone`);
      return;
    }
    const existing = this.sessions.get(sessionId);
    if (existing && existing.state === "SILENCED") {
      this.log("info", `[Watchdog] onActivity ignored: session ${sessionId} is SILENCED`);
      // SILENCED state can ONLY be reset by onUserMessage (fresh user input) per design §3.4.
      return;
    }
    if (existing && existing.state === "PAUSED" && existing.pendingRequests.size > 0) {
      this.log("info", `[Watchdog] onActivity ignored: session ${sessionId} is PAUSED (awaiting input)`);
      return;
    }
    this.armOrReset(sessionId, meta);
  }

  /** permission/question asked → pause (design §4/§6.1). */
  onInputRequested(sessionId: string, requestId: string): void {
    if (!this.config.pauseOnInputRequest) return;
    if (this.stoppedSessions.has(sessionId)) {
      this.log("info", `[Watchdog] onInputRequested ignored: session ${sessionId} tombstoned`);
      return;
    }
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      // エントリ未作成のセッションは agentName が未確定。isAgentMonitored(undefined) で
      // 監視対象外と判定される場合（include リスト使用時等）にゾンビエントリを生成しないよう
      // ここで早期リターンする (design §3.2)。
      if (!this.isAgentMonitored(undefined)) return;
      entry = { state: "PAUSED", timer: null, pingCount: 0, pendingRequests: new Set() };
      this.sessions.set(sessionId, entry);
    }
    const wasEmpty = entry.pendingRequests.size === 0;
    entry.pendingRequests.add(requestId);
    if (entry.timer !== null) {
      this.clock.clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.state = "PAUSED";
    this.log("info", `[Watchdog] onInputRequested: session ${sessionId} PAUSED (pending=${entry.pendingRequests.size})`);
    if (wasEmpty && this.config.notifyWaiting) {
      this.notifier
        .notify(sessionId, "waiting", "[Watchdog] Agent is waiting for your input")
        .catch((err) => this.log("warn", `notifier.notify(waiting) failed: ${String(err)}`));
    }
  }

  /** permission/question replied → resume when all pending cleared. */
  onInputResolved(sessionId: string, requestId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.pendingRequests.delete(requestId);
    if (entry.state === "PAUSED" && entry.pendingRequests.size === 0) {
      this.log("info", `[Watchdog] onInputResolved: all input resolved for ${sessionId}, resuming WATCHING`);
      this.armOrReset(sessionId, { agentName: entry.agentName });
    }
  }

  /** Session terminated normally or with error. Tombstones the sessionId. */
  stop(sessionId: string): void {
    this.log("info", `[Watchdog] stop called for session ${sessionId}`);
    const entry = this.sessions.get(sessionId);
    if (entry && entry.timer !== null) {
      this.log("info", `[Watchdog] Clearing timer for session ${sessionId}`);
      this.clock.clearTimeout(entry.timer);
    }
    this.sessions.delete(sessionId);
    this.recordTombstone(sessionId);
    this.notifier.clear(sessionId).catch((err) =>
      this.log("warn", `notifier.clear failed: ${String(err)}`),
    );
  }

  /** Stop all active sessions and clear all timers. */
  stopAll(): void {
    this.log("info", "[Watchdog] stopAll called");
    for (const [sessionId, entry] of this.sessions.entries()) {
      if (entry.timer) {
        this.clock.clearTimeout(entry.timer);
      }
      this.recordTombstone(sessionId);
      this.notifier.clear(sessionId).catch((err) =>
        this.log("warn", `notifier.clear failed on stopAll: ${String(err)}`),
      );
    }
    this.sessions.clear();
  }

  private armOrReset(sessionId: string, meta: ActivityMeta): void {
    if (!this.config.enabled) return;

    const existing = this.sessions.get(sessionId);
    const effectiveName = meta.agentName ?? existing?.agentName;
    if (!this.isAgentMonitored(effectiveName)) {
      this.log("info", `[Watchdog] Session ${sessionId} not monitored (agentName: ${effectiveName})`);
      return;
    }

    this.log("info", `[Watchdog] armOrReset for session ${sessionId} (existing state: ${existing?.state ?? "NONE"})`);

    if (existing && existing.timer !== null) {
      this.log("info", `[Watchdog] Clearing existing timer for session ${sessionId}`);
      this.clock.clearTimeout(existing.timer);
    }
    if (existing && existing.state !== "WATCHING") {
      this.log("info", `[Watchdog] Clearing notifier for session ${sessionId} (resetting to WATCHING)`);
      this.notifier.clear(sessionId).catch((err) =>
        this.log("warn", `notifier.clear on reset failed: ${String(err)}`),
      );
    }
    // pingCount は activity 復帰時に常に 0 へリセット (design §3.4)。
    // SILENCED から WATCHING へ戻った場合に Ping 注入の余地を再度確保するため。
    if (existing && existing.pingCount > 0 && existing.state !== "SILENCED") {
      // Activity returned after a ping was injected — the session recovered.
      this.telemetry.recordRecovery();
    }
    const entry: SessionEntry = {
      state: "WATCHING",
      timer: null,
      pingCount: 0,
      agentName: effectiveName,
      pendingRequests: existing?.pendingRequests ?? new Set(),
    };

    this.log("info", `[Watchdog] Scheduling stage1 timer for session ${sessionId} in ${this.config.stage1Ms}ms`);
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
    this.log("info", `[Watchdog] Tombstoned session ${sessionId} (current tombstones size: ${this.stoppedSessions.size})`);
    if (this.stoppedSessions.size > STOPPED_TOMBSTONE_CAPACITY) {
      const oldest = this.stoppedSessions.keys().next().value;
      if (oldest !== undefined) this.stoppedSessions.delete(oldest);
    }
  }

  private clearTombstone(sessionId: string): void {
    if (this.stoppedSessions.delete(sessionId)) {
      this.log("info", `[Watchdog] Clearing tombstone for session ${sessionId}`);
    }
  }

  private async onStage1Expire(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.log("info", `[Watchdog] onStage1Expire ignored: session ${sessionId} no longer exists`);
      return;
    }
    this.log("info", `[Watchdog] Session ${sessionId} STAGE1 expired. Transitioning to STAGE1_NOTIFIED`);
    entry.state = "STAGE1_NOTIFIED";
    this.telemetry.recordHangup();
    
    this.log("info", `[Watchdog] Scheduling stage2 timer for session ${sessionId} in ${this.config.stage2Ms}ms`);
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
    if (this.sessions.get(sessionId) !== entry) {
      this.log("info", `[Watchdog] Session entry changed during notify. Cleaning up notifier.`);
      this.notifier.clear(sessionId).catch((err) =>
        this.log("warn", `notifier.clear cleanup failed: ${String(err)}`),
      );
    }
  }

  private async onStage2Expire(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.log("info", `[Watchdog] onStage2Expire ignored: session ${sessionId} no longer exists`);
      return;
    }

    if (entry.pingCount < this.config.maxPings) {
      this.log("info", `[Watchdog] Session ${sessionId} STAGE2 expired. Injecting Ping (count: ${entry.pingCount + 1}/${this.config.maxPings})`);
      entry.state = "PINGED";
      entry.pingCount += 1;
      this.telemetry.recordPing();
      entry.lastPingTime = this.clock.now();
      const reason = entry.lastErrorReason;
      const prompt = this.config.pingMessage;
      // Fire-and-forget: Do not await pinger.inject to avoid blocking Tmux notifications
      // and state transitions due to network/API timeouts.
      this.pinger.inject(sessionId, prompt, { reason }).catch((err) =>
        this.log("warn", `Failed to inject ping to ${sessionId}: ${String(err)}`),
      );

      // Reset the stage2 timer immediately to maintain correct state progression.
      this.log("info", `[Watchdog] Scheduling next stage2 timer for session ${sessionId} in ${this.config.stage2Ms}ms`);
      entry.timer = this.clock.setTimeout(() => {
        this.onStage2Expire(sessionId).catch((err) =>
          this.log("warn", `stage2 handler failed: ${String(err)}`),
        );
      }, this.config.stage2Ms);

      // Message text per design §5.2 (stage2 row).
      await this.notifier.notify(
        sessionId,
        "critical",
        `[Watchdog] Ping injected to ${sessionId}`,
      );
      if (this.sessions.get(sessionId) !== entry) {
        this.log("info", `[Watchdog] Session entry changed during notify. Cleaning up notifier.`);
        this.notifier.clear(sessionId).catch((err) =>
          this.log("warn", `notifier.clear cleanup failed: ${String(err)}`),
        );
      }
    } else {
      this.log("info", `[Watchdog] Session ${sessionId} reached max pings. Transitioning to SILENCED`);
      entry.state = "SILENCED";
      this.telemetry.recordFailure();
      entry.timer = null;
      // Message text per design §5.2 (SILENCED row).
      await this.notifier.notify(
        sessionId,
        "silenced",
        "[Watchdog] Max pings reached. Manual intervention required.",
      );
      if (this.sessions.get(sessionId) !== entry) {
        this.log("info", `[Watchdog] Session entry changed during notify. Cleaning up notifier.`);
        this.notifier.clear(sessionId).catch((err) =>
          this.log("warn", `notifier.clear cleanup failed: ${String(err)}`),
        );
      }
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

