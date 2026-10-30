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

test("owned assistant text activity reaches the watchdog", async () => {
  let activities = 0;
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity: () => { activities++; }, onToolRunning() {}, onToolSettled() {},
    onInputRequested() {}, onInputResolved() {}, onStatusRetry() {}, onStatusActive() {}, noteError() {},
    stop() {}, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions() });
  const event = { id: "evt_5", created: 0, type: "session.text.delta",
    data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "x" } } satisfies HostEvent;
  await router.handle(event);
  expect(activities).toBe(1);
});

test("a called tool is tracked using message and tool identity", async () => {
  const calls: string[] = [];
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning: (id, tool) => { calls.push(`${id}/${tool}`); },
    onToolSettled() {}, onInputRequested() {}, onInputResolved() {}, onStatusRetry() {}, onStatusActive() {},
    noteError() {}, stop() {}, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions() });
  const event = { id: "evt_8", created: 0, type: "session.tool.called",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "tool_1", input: {}, executed: false } } satisfies HostEvent;
  await router.handle(event);
  expect(calls).toEqual(["ses_1/msg_1:tool_1"]);
});

test("tool completion settles the original tool identity", async () => {
  const calls: string[] = [];
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning() {},
    onToolSettled: (id, tool) => { calls.push(`${id}/${tool}`); },
    onInputRequested() {}, onInputResolved() {}, onStatusRetry() {}, onStatusActive() {},
    noteError() {}, stop() {}, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions() });
  const event = { id: "evt_9", created: 0, type: "session.tool.success",
    durable: { aggregateID: "ses_1", seq: 2, version: 2 },
    data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "tool_1",
      content: [{ type: "text", text: "ok" }], executed: false } } satisfies HostEvent;
  await router.handle(event);
  expect(calls).toEqual(["ses_1/msg_1:tool_1"]);
});

test("a duplicate event identifier is applied only once", async () => {
  let activities = 0;
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity: () => { activities++; }, onToolRunning() {}, onToolSettled() {},
    onInputRequested() {}, onInputResolved() {}, onStatusRetry() {}, onStatusActive() {}, noteError() {},
    stop() {}, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions() });
  const event = { id: "evt_duplicate", created: 0, type: "session.text.delta",
    data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "chunk" } } satisfies HostEvent;
  await router.handle(event);
  await router.handle(event);
  expect(activities).toBe(1);
});

test("late tool settlement is ignored during the post-ping arm lock", async () => {
  let settlements = 0;
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity() {}, onToolRunning() {}, onToolSettled: () => { settlements++; },
    onInputRequested() {}, onInputResolved() {}, onStatusRetry() {}, onStatusActive() {}, noteError() {},
    stop() {}, getLastPingTime: () => 900,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions(),
    now: () => 1000, stage2Ms: 1000 });
  const event = { id: "evt_arm_lock", created: 0, type: "session.tool.success",
    durable: { aggregateID: "ses_1", seq: 10, version: 2 },
    data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "tool_1",
      content: [{ type: "text", text: "late" }], executed: false } } satisfies HostEvent;
  await router.handle(event);
  expect(settlements).toBe(0);
});

test("agent include filter excludes activity for non-selected agents", async () => {
  let activities = 0;
  const watchdog: WatchdogPort = {
    onUserMessage() {}, onActivity: () => { activities++; }, onToolRunning() {}, onToolSettled() {},
    onInputRequested() {}, onInputResolved() {}, onStatusRetry() {}, onStatusActive() {}, noteError() {},
    stop() {}, getLastPingTime: () => 0,
  };
  const router = createEventRouter({ watchdog, recovery: createRecoveryTracker(), sessions: sessions(),
    agents: { include: ["reviewer"] } });
  const event = { id: "evt_filtered", created: 0, type: "session.text.delta",
    data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "chunk" } } satisfies HostEvent;
  await router.handle(event);
  expect(activities).toBe(0);
});
