import { expect, test } from "bun:test";
import { createEventRouter } from "../../src/opencode/events";
import { createRecoveryTracker } from "../../src/opencode/recovery";
import type { WatchdogPort, HostEvent } from "../../src/opencode/types";

const session = {
  id: "ses_1", projectID: "prj_1", location: { directory: "/fixture" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
};

function sessions() {
  return { directory: "/fixture", resolve: async () => session, invalidate() {}, dispose() {} };
}

test("global form cancellation does not affect a session", async () => {
  const resolved: string[] = [];
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning() {}, onToolSettled() {},
    onInputRequested() {}, onInputResolved: (id) => { resolved.push(id); },
    onStatusRetry() {}, onStatusActive() {}, noteError() {}, stop() {}, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(),
    sessions: { ...sessions(), resolve: async () => undefined } });
  const event = { id: "evt_form", created: 0, type: "form.cancelled",
    data: { id: "frm_1", sessionID: "global" } } satisfies HostEvent;
  await router.handle(event);
  expect(resolved).toEqual([]);
});

test("a session-owned form cancellation resolves its namespaced request", async () => {
  const resolved: string[] = [];
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning() {}, onToolSettled() {},
    onInputRequested() {}, onInputResolved: (id, request) => { resolved.push(`${id}/${request}`); },
    onStatusRetry() {}, onStatusActive() {}, noteError() {}, stop() {}, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions() });
  const event = { id: "evt_1", created: 0, type: "form.cancelled",
    data: { id: "frm_1", sessionID: "ses_1" } } satisfies HostEvent;
  await router.handle(event);
  expect(resolved).toEqual(["ses_1/form:frm_1"]);
});

test("an owned form request pauses its session", async () => {
  const requested: string[] = [];
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning() {}, onToolSettled() {},
    onInputRequested: (id, request) => { requested.push(`${id}/${request}`); },
    onInputResolved() {}, onStatusRetry() {}, onStatusActive() {}, noteError() {}, stop() {}, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions() });
  const event = { id: "evt_2", created: 0, type: "form.created",
    data: { form: { id: "frm_2", sessionID: "ses_1", title: "Question", fields: [{ key: "answer", type: "string" }] } },
  } satisfies HostEvent;
  await router.handle(event);
  expect(requested).toEqual(["ses_1/form:frm_2"]);
});

test("input pause can be disabled via V2 options", async () => {
  let requests = 0;
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning() {}, onToolSettled() {},
    onInputRequested: () => { requests++; }, onInputResolved() {}, onStatusRetry() {}, onStatusActive() {},
    noteError() {}, stop() {}, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions(),
    pauseOnInputRequest: false });
  const event = { id: "evt_pause_off", created: 0, type: "permission.asked",
    data: { id: "per_1", sessionID: "ses_1", action: "read", resources: [] } } satisfies HostEvent;
  await router.handle(event);
  expect(requests).toBe(0);
});

test("permission events use an independent request namespace", async () => {
  const calls: string[] = [];
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning() {}, onToolSettled() {},
    onInputRequested: (id, request) => { calls.push(`ask:${id}/${request}`); },
    onInputResolved: (id, request) => { calls.push(`reply:${id}/${request}`); },
    onStatusRetry() {}, onStatusActive() {}, noteError() {}, stop() {}, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions() });
  const asked = { id: "evt_3", created: 0, type: "permission.asked",
    data: { id: "per_1", sessionID: "ses_1", action: "read", resources: [] } } satisfies HostEvent;
  const replied = { id: "evt_4", created: 0, type: "permission.replied",
    data: { requestID: "per_1", sessionID: "ses_1", reply: "reject" } } satisfies HostEvent;
  await router.handle(asked);
  await router.handle(replied);
  expect(calls).toEqual(["ask:ses_1/permission:per_1", "reply:ses_1/permission:per_1"]);
});

test("manual input is recognized by identity, not prompt text", async () => {
  const users: string[] = [];
  const watchdog: WatchdogPort = {
    onUserMessage: (id) => { users.push(id); }, onActivity() {}, onToolRunning() {}, onToolSettled() {},
    onInputRequested() {}, onInputResolved() {}, onStatusRetry() {}, onStatusActive() {}, noteError() {},
    stop() {}, getLastPingTime: () => 0,
  };
  const recovery = createRecoveryTracker();
  recovery.register("ses_1", "msg_own");
  const router = createEventRouter({ watchdog, recovery, sessions: sessions() });
  const event = { id: "evt_6", created: 0, type: "session.inbox.enqueued",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: { sessionID: "ses_1", inboxID: "msg_user",
      item: { type: "user", delivery: "steer", payload: { text: "same as ping" } } } } satisfies HostEvent;
  await router.handle(event);
  await router.handle({ ...event, id: "evt_7", data: { ...event.data, inboxID: "msg_own" } });
  expect(users).toEqual(["ses_1"]);
});
