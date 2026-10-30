import { expect, test } from "bun:test";
import { createRecoveryTracker } from "../../src/opencode/recovery";

test("superseding a recovery fences the old generation while retaining its identity", () => {
  const tracker = createRecoveryTracker();
  const generation = tracker.register("session", "msg_ping");
  tracker.supersede("session");
  expect(tracker.isCurrent("session", generation)).toBe(false);
  expect(tracker.isOwnMessage("session", "msg_ping")).toBe(true);
});

test("disposed trackers cannot start recovery", () => {
  const tracker = createRecoveryTracker();
  const generation = tracker.register("session", "msg_ping");
  tracker.dispose();
  expect(tracker.isCurrent("session", generation)).toBe(false);
  expect(tracker.transition("session", generation, "interrupting")).toBe(false);
});

test("message history remains bounded without discarding a newer registration", () => {
  const tracker = createRecoveryTracker(2);
  tracker.register("first", "msg_first");
  tracker.register("second", "msg_second");
  tracker.register("third", "msg_third");
  expect(tracker.isOwnMessage("first", "msg_first")).toBe(false);
  expect(tracker.isOwnMessage("third", "msg_third")).toBe(true);
});
