import type { Clock, TimerHandle } from "./clock";
import type { Notifier } from "./notifier";
import type { Pinger } from "./pinger";
import type { WatchdogConfig } from "./config";
import { NoopTelemetry, type Telemetry } from "./telemetry";
import type { HangReason } from "./errors";
import type { WatchdogStateStore } from "./shared-state";

type State = "WATCHING" | "STAGE1_NOTIFIED" | "PINGED" | "SILENCED" | "PAUSED" | "IDLE";

interface SessionEntry {
  state: State;
  timer: TimerHandle | null;
  pingCount: number;
  agentName?: string;
  lastPingTime?: number;
  lastActivityAt?: number;
  lastErrorReason?: HangReason;
  pendingRequests: Set<string>;
  runningTools: Set<string>;
  retrySuppressed?: boolean;
  toolGateNotified: boolean;
  toolGateCycles: number;
}

export interface WatchdogDeps {
  config: WatchdogConfig;
  clock: Clock;
  notifier: Notifier;
  pinger: Pinger;
  telemetry?: Telemetry;
  log?: (level: "info" | "warn", message: string) => void;
  stateStore?: WatchdogStateStore;
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
  private readonly stateStore?: WatchdogStateStore;

  constructor(deps: WatchdogDeps) {
    this.config = deps.config;
    this.clock = deps.clock;
    this.notifier = deps.notifier;
    this.pinger = deps.pinger;
    this.telemetry = deps.telemetry ?? new NoopTelemetry();
    this.log = deps.log ?? ((level, m) => console[level](`[watchdog] ${m}`));
    this.stateStore = deps.stateStore;
    this.stateStore?.setEnabled(this.config.enabled);
  }

  getLastPingTime(sessionId: string): number {
    return this.sessions.get(sessionId)?.lastPingTime ?? 0;
  }

  private reportSession(sessionId: string): void {
    if (!this.stateStore) return;
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.stateStore.removeSession(sessionId);
      return;
    }
    this.stateStore.setSession(sessionId, {
      state: entry.state,
      agentName: entry.agentName,
      lastActivityAt: entry.lastActivityAt,
      errorReason: entry.lastErrorReason,
      runningToolsCount: entry.runningTools.size,
      pendingRequestsCount: entry.pendingRequests.size,
    });
  }

  private reportGlobal(): void {
    this.stateStore?.setGlobal(this.telemetry.snapshot());
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
      this.reportSession(sessionId);
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
    // TODO: this.config.delivery ("steer" | "queue") is parsed and stored but not yet consumed here.
    if (this.stoppedSessions.has(sessionId)) {
      this.log("info", `[Watchdog] onInputRequested ignored: session ${sessionId} tombstoned`);
      return;
    }
    let entry = this.sessions.get(sessionId);
    if (entry && entry.state === "SILENCED") {
      this.log("info", `[Watchdog] onInputRequested ignored: session ${sessionId} is SILENCED`);
      return;
    }
    if (!entry) {
      // エントリ未作成のセッションは agentName が未確定。isAgentMonitored(undefined) で
      // 監視対象外と判定される場合（include リスト使用時等）にゾンビエントリを生成しないよう
      // ここで早期リターンする (design §3.2)。
      if (!this.isAgentMonitored(undefined)) return;
      entry = { state: "PAUSED", timer: null, pingCount: 0, pendingRequests: new Set(), runningTools: new Set(), toolGateNotified: false, toolGateCycles: 0 };
      this.sessions.set(sessionId, entry);
    }
    const wasEmpty = entry.pendingRequests.size === 0;
    entry.pendingRequests.add(requestId);
    if (entry.timer !== null) {
      this.clock.clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.state = "PAUSED";
    this.reportSession(sessionId);
    this.log("info", `[Watchdog] onInputRequested: session ${sessionId} PAUSED (pending=${entry.pendingRequests.size})`);
    if (wasEmpty && this.config.notifyWaiting) {
      this.notifier
        .notify(sessionId, "waiting", "[Watchdog] Agent is waiting for your input")
        .catch((err) => this.log("warn", `notifier.notify(waiting) failed: ${String(err)}`));
    }
  }

  /** permission/question replied → resume when all pending cleared. */
  onInputResolved(sessionId: string, requestId: string): void {
    if (!this.config.pauseOnInputRequest) return;
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.pendingRequests.delete(requestId);
    if (entry.state === "PAUSED" && entry.pendingRequests.size === 0) {
      this.log("info", `[Watchdog] onInputResolved: all input resolved for ${sessionId}, resuming WATCHING`);
      this.armOrReset(sessionId, { agentName: entry.agentName });
    }
    this.reportSession(sessionId);
  }
  /** tool part reached `running` — active + tracked for steer suppression. */
  onToolRunning(sessionId: string, callId: string): void {
    if (this.stoppedSessions.has(sessionId)) return;
    // PAUSED awaiting input: track the tool but do NOT re-arm — a tool part is
    // assistant activity and must not un-pause the session (design §7; mirrors
    // the onActivity PAUSED guard). The tracked callId survives into WATCHING
    // because armOrReset preserves runningTools when the input later resolves.
    const existing = this.sessions.get(sessionId);
    if (existing && existing.state === "PAUSED" && existing.pendingRequests.size > 0) {
      existing.runningTools.add(callId);
      this.reportSession(sessionId);
      return;
    }
    if (existing && existing.state === "SILENCED") {
      this.log("info", `[Watchdog] onToolRunning ignored: session ${sessionId} is SILENCED`);
      return;
    }
    if (existing?.runningTools.has(callId)) {
      this.log("info", `[Watchdog] onToolRunning ignored: call ${callId} is already running for ${sessionId}`);
      return;
    }
    this.armOrReset(sessionId, {});
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.runningTools.add(callId);
      this.reportSession(sessionId);
    }
  }

  /** tool part reached `completed`/`error` — untrack + active. */
  onToolSettled(sessionId: string, callId: string): void {
    if (this.stoppedSessions.has(sessionId)) return;
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    existing.runningTools.delete(callId);
    // PAUSED awaiting input: untrack but do NOT re-arm (design §7).
    if (existing && existing.state === "PAUSED" && existing.pendingRequests.size > 0) {
      this.reportSession(sessionId);
      return;
    }
    if (existing.state === "SILENCED") {
      this.log("info", `[Watchdog] onToolSettled ignored: session ${sessionId} is SILENCED`);
      return;
    }
    // armOrReset carries over the (now reduced) runningTools set by reference,
    // so no manual re-copy of the remaining ids is needed.
    this.armOrReset(sessionId, {});
  }


  /** session.status:retry → suppress escalation, stop the running timer. */
  onStatusRetry(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.state === "SILENCED") {
      this.log("info", `[Watchdog] onStatusRetry ignored: session ${sessionId} is SILENCED (user input required per design §3.4)`);
      return;
    }
    entry.retrySuppressed = true;
    if (entry.timer !== null) {
      this.clock.clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.log("info", `[Watchdog] retry suppression ON for ${sessionId}`);
  }

  /** session.status:busy or activity → clear retry suppression and resume,
   *  unless still PAUSED with pending input (design §7). */
  onStatusActive(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.retrySuppressed) return;
    if (entry.state === "SILENCED") {
      this.log("info", `[Watchdog] onStatusActive ignored: session ${sessionId} is SILENCED (user input required per design §3.4)`);
      return;
    }
    entry.retrySuppressed = false;
    if (entry.state === "PAUSED" && entry.pendingRequests.size > 0) {
      this.log("info", `[Watchdog] retry cleared but ${sessionId} stays PAUSED (pending input)`);
      return;
    }
    this.armOrReset(sessionId, { agentName: entry.agentName });
  }
  /** Session terminated normally or with error. Tombstones the sessionId. */
  stop(sessionId: string): void {
    this.log("info", `[Watchdog] stop called for session ${sessionId}`);
    const entry = this.sessions.get(sessionId);
    if (entry && entry.timer !== null) {
      this.log("info", `[Watchdog] Clearing timer for session ${sessionId}`);
      this.clock.clearTimeout(entry.timer);
    }
    // Keep a final IDLE snapshot in shared state so the TUI can still show
    // the session as idle (with last known metadata) instead of vanishing.
    if (entry) {
      entry.state = "IDLE";
      this.reportSession(sessionId);
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
    this.reportGlobal();
  }

  private armOrReset(sessionId: string, meta: ActivityMeta): void {
    if (!this.config.enabled) return;
    const existing = this.sessions.get(sessionId);
    if (existing?.retrySuppressed) {
      this.log("info", `[Watchdog] armOrReset suppressed: session ${sessionId} is in retry suppression`);
      return;
    }

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
      this.reportGlobal();
    }
    const entry: SessionEntry = {
      state: "WATCHING",
      timer: null,
      pingCount: 0,
      agentName: effectiveName,
      lastActivityAt: this.clock.now(),
      pendingRequests: existing?.pendingRequests ?? new Set(),
      runningTools: existing?.runningTools ?? new Set(),
      toolGateNotified: false,
      toolGateCycles: 0,
    };

    this.log("info", `[Watchdog] Scheduling stage1 timer for session ${sessionId} in ${this.config.stage1Ms}ms`);
    entry.timer = this.clock.setTimeout(() => {
      this.onStage1Expire(sessionId).catch((err) =>
        this.log("warn", `stage1 handler failed: ${String(err)}`),
      );
    }, this.config.stage1Ms);

    this.sessions.set(sessionId, entry);
    this.reportSession(sessionId);
  }

  private recordTombstone(sessionId: string): void {
    if (this.stoppedSessions.has(sessionId)) return;
    // If we're at capacity, the oldest tombstone will be evicted and should be
    // removed from shared state to prevent unbounded growth.
    let evicted: string | undefined;
    if (this.stoppedSessions.size >= STOPPED_TOMBSTONE_CAPACITY) {
      evicted = this.stoppedSessions.keys().next().value as string | undefined;
    }
    this.stoppedSessions.add(sessionId);
    if (evicted !== undefined && evicted !== sessionId) {
      this.stateStore?.removeSession(evicted);
    }
    this.log("info", `[Watchdog] Tombstoned session ${sessionId} (current tombstones size: ${this.stoppedSessions.size})`);
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
    this.reportSession(sessionId);
    this.telemetry.recordHangup();
    this.reportGlobal();
    
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

    if (this.config.suppressPingWhileToolRunning && entry.runningTools.size > 0 && entry.toolGateCycles < this.config.maxToolGateCycles) {
      this.log("info", `[Watchdog] STAGE2 gated: ${entry.runningTools.size} tool(s) running for ${sessionId}; not injecting`);
      entry.toolGateCycles += 1;
      // Set the timer before any await so that a concurrent armOrReset (e.g. from
      // onToolSettled arriving while the notification is in-flight) can properly
      // clear it — mirrors the pattern used in onStage1Expire and the ping path.
      entry.timer = this.clock.setTimeout(() => {
        this.onStage2Expire(sessionId).catch((err) =>
          this.log("warn", `stage2 handler failed: ${String(err)}`),
        );
      }, this.config.stage2Ms);
      // Notify critical only on first gate to avoid OS-notification spam while still gated.
      if (!entry.toolGateNotified) {
        entry.toolGateNotified = true;
        await this.notifier.notify(
          sessionId,
          "critical",
          `[Watchdog] Agent ${sessionId} stalled but a tool is running; holding.`,
        );
        if (this.sessions.get(sessionId) !== entry) {
          this.log("info", `[Watchdog] Session entry changed during gate notify. Cleaning up notifier.`);
          this.notifier.clear(sessionId).catch((err) =>
            this.log("warn", `notifier.clear cleanup failed: ${String(err)}`),
          );
        }
      }
      this.reportSession(sessionId);
      return;
    }

    if (entry.pingCount < this.config.maxPings) {
      this.log("info", `[Watchdog] Session ${sessionId} STAGE2 expired. Injecting Ping (count: ${entry.pingCount + 1}/${this.config.maxPings})`);
      entry.state = "PINGED";
      entry.pingCount += 1;
      this.telemetry.recordPing();
      this.reportGlobal();
      entry.lastPingTime = this.clock.now();
      this.reportSession(sessionId);
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
      this.reportSession(sessionId);
      this.telemetry.recordFailure();
      this.reportGlobal();
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
