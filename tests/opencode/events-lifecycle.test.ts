import { expect, test } from "bun:test";
import { createEventRouter } from "../../src/opencode/events";
import { createRecoveryTracker } from "../../src/opencode/recovery";
import type { WatchdogPort, HostEvent } from "../../src/opencode/types";

const session = {
  id: "ses_1", projectID: "prj_1", location: { directory: "/fixture" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
};

function sessions(resolve: () => Promise<typeof session | undefined> = async () => session) {
  return { directory: "/fixture", resolve, invalidate() {}, dispose() {} };
}

test("successful execution stops monitoring its owned session", async () => {
  const stopped: string[] = [];
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning() {}, onToolSettled() {}, onInputRequested() {},
    onInputResolved() {}, onStatusRetry() {}, onStatusActive() {}, noteError() {},
    stop: (id) => { stopped.push(id); }, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions() });
  const event = { id: "evt_10", created: 0, type: "session.execution.succeeded",
    durable: { aggregateID: "ses_1", seq: 3, version: 1 }, data: { sessionID: "ses_1" } } satisfies HostEvent;
  await router.handle(event);
  expect(stopped).toEqual(["ses_1"]);
});

test("retry and busy status update the watchdog retry gate", async () => {
  const calls: string[] = [];
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning() {}, onToolSettled() {}, onInputRequested() {},
    onInputResolved() {}, onStatusRetry: (id) => { calls.push(`retry:${id}`); },
    onStatusActive: (id) => { calls.push(`busy:${id}`); }, noteError() {}, stop() {}, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions() });
  const retry = { id: "evt_11", created: 0, type: "session.status", data: { sessionID: "ses_1",
    status: { type: "retry", attempt: 1, message: "redacted", next: 0 } } } satisfies HostEvent;
  const busy = { id: "evt_12", created: 0, type: "session.status",
    data: { sessionID: "ses_1", status: { type: "busy" } } } satisfies HostEvent;
  await router.handle(retry);
  await router.handle(busy);
  expect(calls).toEqual(["retry:ses_1", "busy:ses_1"]);
});

test("deletion stops a previously owned session after it disappears from the API", async () => {
  const stopped: string[] = [];
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning() {}, onToolSettled() {}, onInputRequested() {},
    onInputResolved() {}, onStatusRetry() {}, onStatusActive() {}, noteError() {},
    stop: (id) => { stopped.push(id); }, getLastPingTime: () => 0,
  };
  let exists = true;
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(),
    sessions: sessions(async () => exists ? session : undefined) });
  const activity = { id: "evt_13", created: 0, type: "session.text.delta",
    data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "x" } } satisfies HostEvent;
  const deletion = { id: "evt_14", created: 0, type: "session.deleted",
    durable: { aggregateID: "ses_1", seq: 4, version: 2 }, data: { sessionID: "ses_1" } } satisfies HostEvent;
  await router.handle(activity);
  exists = false;
  await router.handle(deletion);
  expect(stopped).toEqual(["ses_1"]);
});

test("one owned recovery interruption is consumed but a later user interruption stops", async () => {
  let stops = 0;
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning() {}, onToolSettled() {}, onInputRequested() {},
    onInputResolved() {}, onStatusRetry() {}, onStatusActive() {}, noteError() {},
    stop: () => { stops++; }, getLastPingTime: () => 0,
  };
  const recovery = createRecoveryTracker();
  const generation = recovery.register("ses_1", "msg_ping");
  recovery.transition("ses_1", generation, "resumed");
  const router = createEventRouter({ watchdog, recovery, sessions: sessions() });
  const event = { id: "evt_15", created: 0, type: "session.execution.interrupted",
    durable: { aggregateID: "ses_1", seq: 5, version: 1 },
    data: { sessionID: "ses_1", reason: "inactivity" } } satisfies HostEvent;
  await router.handle(event);
  expect(recovery.phase("ses_1")).toBe("settled");
  await router.handle({ ...event, id: "evt_16", durable: { ...event.durable, seq: 6 }, data: { ...event.data, reason: "user" } });
  expect(stops).toBe(1);
});
