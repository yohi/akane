import { RealClock } from "../clock";
import { createNotifier, bunSpawn, bunWhich } from "../notifier";
import { acquireStateStore, releaseStateStore } from "../shared-state";
import { TelemetryCollector, startTelemetryReporter } from "../telemetry";
import { Watchdog } from "../watchdog";
import { createEventRouter } from "./events";
import { resolveReporterInterval, resolveV2Options } from "./options";
import { createV2Pinger } from "./pinger";
import { createRecoveryTracker } from "./recovery";
import { createSessionRegistry } from "./sessions";
import { consumeEvents } from "./stream";
import type { V2Context } from "./types";

const ACTIVE_INSTANCES = new Set<string>();

export interface RuntimeContext {
  readonly location: { readonly directory: string };
  readonly options: unknown;
  readonly event: V2Context["event"];
  readonly session: Pick<V2Context["session"], "get" | "prompt" | "interrupt">;
}

export async function setupWatchdog(context: RuntimeContext): Promise<() => Promise<void>> {
  const directory = context.location.directory;
  if (ACTIVE_INSTANCES.has(directory)) return async () => {};
  ACTIVE_INSTANCES.add(directory);
  const rollback: Array<() => void | Promise<void>> = [];
  let release: (() => Promise<void>) | undefined;
  try {
    const config = resolveV2Options(context.options, process.env);
    const clock = new RealClock();
    const store = acquireStateStore(directory);
    rollback.push(() => releaseStateStore(store));
    const telemetry = new TelemetryCollector(store.getSnapshot().global);
    const sessions = createSessionRegistry(context.session, directory);
    const recovery = createRecoveryTracker();
    const pinger = createV2Pinger({ session: context.session, sessions, recovery, delivery: config.delivery,
      log: (message) => console.warn(message) });
    const notifier = createNotifier(config.notifierType, { env: process.env, spawn: bunSpawn(),
      which: bunWhich(), platform: process.platform, log: () => {} });
    const watchdog = new Watchdog({ config, clock, notifier, pinger, telemetry, stateStore: store, log: () => {} });
    const router = createEventRouter({ watchdog, sessions, recovery, stage2Ms: config.stage2Ms,
      pauseOnInputRequest: config.pauseOnInputRequest, agents: config.agents });
    const controller = new AbortController();
    const stopReporter = startTelemetryReporter({ clock, telemetry, intervalMs: resolveReporterInterval(process.env), log: () => {} });
    rollback.push(stopReporter);
    const heartbeat = setInterval(() => store.setGlobal(telemetry.snapshot()), 30000);
    rollback.push(() => clearInterval(heartbeat));
    const stream = consumeEvents(context.event, router.handle, controller.signal, async () => {
      watchdog.stopAll();
    });
    let cleanup: Promise<void> | undefined;
    release = () => cleanup ??= (async () => {
      router.dispose();
      controller.abort();
      clearInterval(heartbeat);
      stopReporter();
      watchdog.stopAll();
      sessions.dispose();
      try {
        await Promise.all([stream, pinger.dispose()]);
      } finally {
        recovery.dispose();
        for (const dispose of rollback.reverse()) await dispose();
        ACTIVE_INSTANCES.delete(directory);
      }
    })();
    return release;
  } catch {
    if (release) await release();
    else {
      for (const dispose of rollback.reverse()) await dispose();
      ACTIVE_INSTANCES.delete(directory);
    }
    return async () => {};
  }
}
