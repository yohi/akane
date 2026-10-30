import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWatchdog } from "../../src/opencode/runtime";
import type { V2Context } from "../../src/opencode/types";

test("duplicate setup owns no resources and cannot release the original subscription", async () => {
  const directory = mkdtempSync(join(tmpdir(), "akane-v2-runtime-"));
  let closed = 0;
  const event: V2Context["event"] = {
    subscribe: (options) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        closed++;
      },
    }),
  };
  const session: Pick<V2Context["session"], "get" | "prompt" | "interrupt"> = {
    get: async () => { throw new Error("not found"); },
    prompt: async () => { throw new Error("not used"); },
    interrupt: async () => ({ interrupted: false }),
  };
  const context = { location: { directory }, options: {}, event, session };
  try {
    const first = await setupWatchdog(context);
    const duplicate = await setupWatchdog(context);
    await duplicate();
    expect(closed).toBe(0);
    await first();
    expect(closed).toBe(1);
    await first();
    expect(closed).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
