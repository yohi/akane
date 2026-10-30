import { expect, test } from "bun:test";
import { consumeEvents } from "../../src/opencode/stream";

test("event stream errors fence monitoring before resubscribing", async () => {
  const controller = new AbortController();
  const order: string[] = [];
  const events = {
    subscribe: () => ({
      async *[Symbol.asyncIterator]() {
        order.push("subscribe");
        throw new Error("stream interrupted");
      },
    }),
  };
  await consumeEvents(events, async () => {}, controller.signal, async () => {
    order.push("gap");
    controller.abort();
  });
  expect(order).toEqual(["subscribe", "gap"]);
});
