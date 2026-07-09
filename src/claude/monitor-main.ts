import { RealClock } from "../clock";
import { Watchdog } from "../watchdog";
import { createNotifier, bunSpawn, bunWhich } from "../notifier";
import { TelemetryCollector } from "../telemetry";
import { getStateStore } from "../shared-state";
import { resolveClaudeConfig } from "./config";
import { resolveStateDir, eventsDir } from "./state-dir";
import { EventTailer } from "./event-log";
import { TombstoneStore } from "./event-store";
import { MonitorLock, computeStartedAt } from "./lock";
import { ClaudeCodeAdapter } from "./pinger";
import { ClaudeMonitor, lockGuardedNotifier, lockGuardedPinger } from "./monitor";

const POLL_MS = 1000;
const MAINTENANCE_INTERVAL_MS = 3_600_000; // hourly orphan sweep
const ORPHAN_TTL_MS = 86_400_000; // 24h (SPEC §4.3)

function main(): void {
  const env = process.env as Record<string, string | undefined>;
  const config = resolveClaudeConfig(env);
  if (!config.enabled) process.exit(0);

  const stateDir = resolveStateDir(env);
  const dir = eventsDir(stateDir);
  const clock = new RealClock();
  const lock = new MonitorLock({
    dir,
    pid: process.pid,
    startedAt: computeStartedAt(process.pid),
    now: () => clock.now(),
    ttlMs: Math.max(config.stage2Ms * 2, 30_000), // (SPEC §8.3)
  });
  if (!lock.tryAcquire()) process.exit(0); // healthy monitor already running

  const stateStore = getStateStore(stateDir);
  // Shared teardown for both the graceful signal path (SIGTERM/SIGINT) and the
  // lock-loss exit path. Wrapping dispose() keeps a failing flush from blocking
  // process exit (Zero-Crash, AGENTS.md §3.4).
  const disposeStateStore = () => {
    try { stateStore.dispose(); } catch { /* ignore */ }
  };
  // Lock loss: ClaudeMonitor.shutdown() already ran on the tick() not_owner
  // path, so do NOT call it again here (avoids double shutdown). The guarded
  // notifier/pinger paths never call shutdown(); either way we still must
  // release shared state before exiting.
  const onLockLost = () => { disposeStateStore(); process.exit(0); };
  const stdoutAdapter = new ClaudeCodeAdapter((line) => process.stdout.write(line), (m) => logStderr(env, m));
  const notifier = lockGuardedNotifier(
    createNotifier(config.notifierType, {
      env,
      spawn: bunSpawn(),
      which: bunWhich(),
      platform: process.platform,
      log: (level, message) => logStderr(env, `[${level}] ${message}`),
    }),
    lock,
    onLockLost,
  );
  const pinger = lockGuardedPinger(stdoutAdapter, lock, onLockLost);
  const watchdog = new Watchdog({
    config, clock, notifier, pinger, telemetry: new TelemetryCollector(),
    log: (level, message) => logStderr(env, `[${level}] ${message}`),
    stateStore,
  });
  const monitor = new ClaudeMonitor({
    stateDir, watchdog, tailer: new EventTailer(dir), tombstones: new TombstoneStore(dir, process.pid), lock, clock,
    pollMs: POLL_MS, maintenanceIntervalMs: MAINTENANCE_INTERVAL_MS,
    orphanTtlMs: ORPHAN_TTL_MS,
    log: (level, message) => logStderr(env, `[${level}] ${message}`),
    onLockLost,
  });

  const shutdown = () => {
    try { monitor.shutdown(); } finally { disposeStateStore(); process.exit(0); }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  monitor.start();
}

// NEVER write logs to stdout — that channel is reserved for ping/notification
// lines delivered to Claude (SPEC §6.4). Debug logs gate on AKANE_DEBUG.
function logStderr(env: Record<string, string | undefined>, message: string): void {
  if (env.AKANE_DEBUG === "true") process.stderr.write(`[akane-monitor] ${message}\n`);
}

main();
