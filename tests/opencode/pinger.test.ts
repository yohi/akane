import { expect, test } from "bun:test";
import { createV2Pinger } from "../../src/opencode/pinger";
import { createRecoveryTracker } from "../../src/opencode/recovery";
import type { HostSession, SessionPort } from "../../src/opencode/types";

const owned: HostSession = { id: "ses_1", projectID: "prj_1", location: { directory: "/fixture" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 } };

test("steer admits a single identified prompt before interrupting", async () => {
  const calls: string[] = [];
  const session: Pick<SessionPort, "prompt" | "interrupt"> = {
    prompt: async (input) => {
      calls.push(`prompt:${input.delivery}:${input.resume}`);
      return { id: input.id ?? "msg_fallback", sessionID: input.sessionID,
        type: "user", payload: { text: input.text }, delivery: input.delivery ?? "steer", time: { created: 0 } };
    },
    interrupt: async (input) => { calls.push(`interrupt:${input.resume}`); return { interrupted: true }; },
  };
  const pinger = createV2Pinger({ session, sessions: { directory: "/fixture", resolve: async () => ({ kind: "owned", session: owned }), invalidate() {}, dispose() {} },
    recovery: createRecoveryTracker(), delivery: "steer", log: () => {} });
  await pinger.inject("ses_1", "test");
  expect(calls).toEqual(["prompt:steer:false", "interrupt:true"]);
});

test("queue delivery does not interrupt an active session", async () => {
  const calls: string[] = [];
  const session: Pick<SessionPort, "prompt" | "interrupt"> = {
    prompt: async (input) => {
      calls.push(`prompt:${input.delivery}:${input.resume}`);
      return { id: input.id ?? "msg_fallback", sessionID: input.sessionID, type: "user",
        payload: { text: input.text }, delivery: input.delivery ?? "steer", time: { created: 0 } };
    },
    interrupt: async () => { calls.push("interrupt"); return { interrupted: true }; },
  };
  const pinger = createV2Pinger({ session, sessions: { directory: "/fixture", resolve: async () => ({ kind: "owned", session: owned }), invalidate() {}, dispose() {} },
    recovery: createRecoveryTracker(), delivery: "queue", log: () => {} });
  await pinger.inject("ses_1", "test");
  expect(calls).toEqual(["prompt:queue:true"]);
});

test("a rejected interrupt does not leave recovery marked resumed", async () => {
  const recovery = createRecoveryTracker();
  const session: Pick<SessionPort, "prompt" | "interrupt"> = {
    prompt: async (input) => ({ id: input.id ?? "msg_fallback", sessionID: input.sessionID,
      type: "user", payload: { text: input.text }, delivery: "steer", time: { created: 0 } }),
    interrupt: async () => ({ interrupted: false }),
  };
  const pinger = createV2Pinger({ session,
    sessions: { directory: "/fixture", resolve: async () => ({ kind: "owned", session: owned }), invalidate() {}, dispose() {} },
    recovery, delivery: "steer", log: () => {} });
  await pinger.inject("ses_1", "test");
  expect(recovery.phase("ses_1")).toBe("settled");
});

test("an interrupted response does not overwrite an event-settled recovery", async () => {
  const recovery = createRecoveryTracker();
  const session: Pick<SessionPort, "prompt" | "interrupt"> = {
    prompt: async (input) => ({ id: input.id ?? "msg_fallback", sessionID: input.sessionID,
      type: "user", payload: { text: input.text }, delivery: "steer", time: { created: 0 } }),
    interrupt: async () => {
      const generation = recovery.generation("ses_1");
      if (generation !== undefined) recovery.transition("ses_1", generation, "settled");
      return { interrupted: true };
    },
  };
  const pinger = createV2Pinger({ session,
    sessions: { directory: "/fixture", resolve: async () => ({ kind: "owned", session: owned }), invalidate() {}, dispose() {} },
    recovery, delivery: "steer", log: () => {} });
  await pinger.inject("ses_1", "test");
  expect(recovery.phase("ses_1")).toBe("settled");
});

test("a failed recovery operation settles its current generation", async () => {
  const recovery = createRecoveryTracker();
  const session: Pick<SessionPort, "prompt" | "interrupt"> = {
    prompt: async () => { throw new Error("private details"); },
    interrupt: async () => ({ interrupted: true }),
  };
  const logs: string[] = [];
  const pinger = createV2Pinger({ session,
    sessions: { directory: "/fixture", resolve: async () => ({ kind: "owned", session: owned }), invalidate() {}, dispose() {} },
    recovery, delivery: "steer", log: (message) => logs.push(message) });
  await pinger.inject("ses_1", "test");
  expect(recovery.phase("ses_1")).toBe("settled");
  expect(logs.join(" ")).not.toContain("private details");
});

test("disposal during admission prevents a subsequent interrupt", async () => {
  let release: () => void = () => {};
  let notifyStart: () => void = () => {};
  const started = new Promise<void>((resolve) => { notifyStart = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let interrupts = 0;
  const session: Pick<SessionPort, "prompt" | "interrupt"> = {
    prompt: async (input) => {
      notifyStart();
      await gate;
      return { id: input.id ?? "msg_fallback", sessionID: input.sessionID, type: "user",
        payload: { text: input.text }, delivery: "steer", time: { created: 0 } };
    },
    interrupt: async () => { interrupts++; return { interrupted: true }; },
  };
  const pinger = createV2Pinger({ session, sessions: { directory: "/fixture", resolve: async () => ({ kind: "owned", session: owned }), invalidate() {}, dispose() {} },
    recovery: createRecoveryTracker(), delivery: "steer", log: () => {} });
  const inject = pinger.inject("ses_1", "test");
  await started;
  const dispose = pinger.dispose();
  release();
  await Promise.all([inject, dispose]);
  expect(interrupts).toBe(0);
});
