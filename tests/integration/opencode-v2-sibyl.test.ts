import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireStateStore, releaseStateStore } from "../../src/shared-state";

interface ConsumerStateApi {
  readonly readAkaneState: (filePath: string) => unknown;
  readonly akaneStateReady: (state: unknown, now: number) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConsumerStateApi(value: unknown): value is ConsumerStateApi {
  return isRecord(value) && typeof value.readAkaneState === "function" && typeof value.akaneStateReady === "function";
}

const sibylRoot = process.env.AKANE_SIBYL_ROOT;
const sibylRevision = process.env.AKANE_SIBYL_REVISION;

test.skipIf(!sibylRoot || !sibylRevision)("Akane writer contract is accepted by the tagged Sibyl V2 state reader", async () => {
  const root = resolve(sibylRoot ?? "");
  const expectedRevision = sibylRevision ?? "";
  const revision = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
    env: { ...process.env, GIT_MASTER: "1" },
  });
  expect(revision.exitCode).toBe(0);
  expect(new TextDecoder().decode(revision.stdout).trim()).toBe(expectedRevision);

  const moduleUrl = pathToFileURL(join(root, "src", "akane-state.ts")).href;
  const loaded: unknown = await import(moduleUrl);
  if (!isConsumerStateApi(loaded)) throw new Error("Tagged Sibyl source does not export its Akane state reader");

  const directory = mkdtempSync(join(tmpdir(), "akane-sibyl-contract-"));
  const statePath = join(directory, ".akane", "watchdog-state.json");
  const statuses = ["WATCHING", "STAGE1_NOTIFIED", "PINGED", "SILENCED", "PAUSED", "IDLE"] as const;
  let store: ReturnType<typeof acquireStateStore> | undefined;
  let restarted: ReturnType<typeof acquireStateStore> | undefined;
  try {
    const activeStore = acquireStateStore(directory);
    store = activeStore;
    activeStore.setEnabled(true);
    statuses.forEach((state, index) => activeStore.setSession(`session-${index}`, {
      state,
      runningToolsCount: index,
      pendingRequestsCount: index + 1,
      agentName: "fixture",
      lastActivityAt: Date.now(),
      errorReason: state === "SILENCED" ? "provider_timeout" : undefined,
    }));
    activeStore.setGlobal({ hangupsDetected: 6, pingsSent: 5, recoveries: 3, silencedFailures: 2 });
    await Bun.sleep(130);

    const active = loaded.readAkaneState(statePath);
    if (!isRecord(active) || !isRecord(active.global) || !isRecord(active.sessions)) {
      throw new Error("Sibyl rejected the producer's active state file");
    }
    const activeSessions = active.sessions;
    expect(loaded.akaneStateReady(active, Date.now())).toBe(true);
    expect(statuses.every((state, index) => {
      const session = activeSessions[`session-${index}`];
      return isRecord(session) && session.state === state;
    })).toBe(true);
    expect(active.global).toEqual({ hangupsDetected: 6, pingsSent: 5, recoveries: 3, silencedFailures: 2 });
    expect(typeof active.timestamp).toBe("number");

    releaseStateStore(activeStore);
    store = undefined;
    const shutdown = loaded.readAkaneState(statePath);
    if (!isRecord(shutdown) || !isRecord(shutdown.global)) throw new Error("Sibyl rejected shutdown state");
    expect(shutdown.enabled).toBe(false);
    expect(loaded.akaneStateReady(shutdown, Date.now())).toBe(false);
    expect(shutdown.global.pingsSent).toBe(5);

    const restartStore = acquireStateStore(directory);
    restarted = restartStore;
    restartStore.setEnabled(true);
    await Bun.sleep(130);
    const nextRun = loaded.readAkaneState(statePath);
    if (!isRecord(nextRun) || !isRecord(nextRun.sessions) || !isRecord(nextRun.global)) {
      throw new Error("Sibyl rejected restarted state");
    }
    expect(loaded.akaneStateReady(nextRun, Date.now())).toBe(true);
    expect(Object.values(nextRun.sessions).every((session) => isRecord(session) && session.state === "IDLE"))
      .toBe(true);
    expect(nextRun.global.pingsSent).toBe(5);
    releaseStateStore(restartStore);
    restarted = undefined;
  } finally {
    if (store) releaseStateStore(store);
    if (restarted) releaseStateStore(restarted);
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
