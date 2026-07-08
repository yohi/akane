import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock, TimerHandle } from "../clock";
import type { Notifier } from "../notifier";
import type { Pinger } from "../pinger";
import type { Watchdog } from "../watchdog";
import { dispatchEvent, type WatchdogTarget } from "./event-map";
import type { EventTailer } from "./event-log";
import { deleteSessionLog, sweepOrphans, type TombstoneStore } from "./event-store";
import type { MonitorLock } from "./lock";
import { eventsDir } from "./state-dir";
import { safeError } from "./safe-error";
import type { AkaneClaudeEvent } from "./event-types";

export interface ClaudeMonitorDeps {
  stateDir: string;
  watchdog: Watchdog;
  tailer: EventTailer;
  tombstones: TombstoneStore;
  lock: MonitorLock;
  clock: Clock;
  pollMs: number;
  maintenanceIntervalMs: number;
  orphanTtlMs: number;
  log: (level: "info" | "warn", message: string) => void;
  onLockLost: () => void;
}

export class ClaudeMonitor {
  private timer: TimerHandle = null;
  private stopped = false;
  private sinceMaintenanceMs = 0;

  constructor(private readonly deps: ClaudeMonitorDeps) {}

  start(): void {
    this.maintenance(); // startup orphan sweep (SPEC §4.3)
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = this.deps.clock.setTimeout(() => {
      this.tick();
      this.schedule();
    }, this.deps.pollMs);
  }

  /** One poll iteration. Exposed for deterministic testing. */
  tick(): void {
    if (!this.deps.lock.heartbeat()) {
      this.deps.log("warn", "[akane] monitor lock lost; shutting down");
      this.shutdown();
      this.deps.onLockLost();
      return;
    }
    let events: AkaneClaudeEvent[] = [];
    try {
      events = this.deps.tailer.poll();
    } catch (err) {
      this.deps.log("warn", `poll failed: ${safeError(err)}`);
    }
    for (const event of events) {
      try {
        dispatchEvent(this.deps.watchdog as WatchdogTarget, event);
        if (event.kind === "session_end") this.onSessionEnd(event.sessionId);
      } catch (err) {
        this.deps.log("warn", `dispatch failed: ${safeError(err)}`);
      }
    }
    this.sinceMaintenanceMs += this.deps.pollMs;
    if (this.sinceMaintenanceMs >= this.deps.maintenanceIntervalMs) {
      this.maintenance();
      this.sinceMaintenanceMs = 0;
    }
  }

  private onSessionEnd(sessionId: string): void {
    this.deps.tombstones.record(sessionId);
    deleteSessionLog(this.deps.stateDir, sessionId);
    this.deps.tailer.forget(sessionId);
  }

  private maintenance(): void {
    const dir = eventsDir(this.deps.stateDir);
    try {
      sweepOrphans(dir, {
        now: this.deps.clock.now(),
        ttlMs: this.deps.orphanTtlMs,
        isTombstoned: (stem) => this.deps.tombstones.has(stem),
      });
    } catch (err) {
      this.deps.log("warn", `sweep failed: ${safeError(err)}`);
    }
  }

  shutdown(): void {
    this.stopped = true;
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer);
    this.timer = null;
    try {
      this.deps.watchdog.stopAll();
    } catch {
      // Contained.
    }
    this.deps.lock.release();
  }
}

// SPEC §8.3 退場手順-2: gate every side effect on current lock ownership so a
// resumed old monitor cannot fire a duplicate notify/ping in the gap before its
// next heartbeat detects the loss.
export function lockGuardedNotifier(inner: Notifier, lock: MonitorLock, onLost: () => void): Notifier {
  return {
    async notify(sessionId, stage, message) {
      if (!lock.isOwned()) { onLost(); return; }
      await inner.notify(sessionId, stage, message);
    },
    async clear(sessionId) {
      if (!lock.isOwned()) { onLost(); return; }
      await inner.clear(sessionId);
    },
  };
}

export function lockGuardedPinger(inner: Pinger, lock: MonitorLock, onLost: () => void): Pinger {
  return {
    async inject(sessionId, message, context) {
      if (!lock.isOwned()) { onLost(); return; }
      await inner.inject(sessionId, message, context);
    },
  };
}
