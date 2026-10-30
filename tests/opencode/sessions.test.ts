import { expect, test } from "bun:test";
import type { HostSession } from "../../src/opencode/types";
import { createSessionRegistry } from "../../src/opencode/sessions";

const session: HostSession = {
  id: "ses_1", projectID: "prj_1", location: { directory: "/fixture" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
};

test("invalidation fences an in-flight ownership lookup", async () => {
  let complete: (value: HostSession) => void = () => {};
  const registry = createSessionRegistry({ get: () => new Promise((resolve) => { complete = resolve; }) }, "/fixture");
  const pending = registry.resolve("ses_1");
  registry.invalidate("ses_1");
  complete(session);
  expect(await pending).toEqual({ kind: "foreign" });
});

test("a session belonging to another directory is ignored", async () => {
  const registry = createSessionRegistry({ get: async () => session }, "/other");
  expect(await registry.resolve("ses_1")).toEqual({ kind: "foreign" });
});

test("session lookup errors are distinguishable from sessions in another directory", async () => {
  const failures: string[] = [];
  const rejected = createSessionRegistry({ get: async () => { throw new Error("temporary"); } }, "/fixture",
    (message) => failures.push(message));
  const foreign = createSessionRegistry({ get: async () => ({ ...session, location: { directory: "/other" } }) }, "/fixture");
  expect((await rejected.resolve("ses_1")).kind).toBe("error");
  expect((await foreign.resolve("ses_1")).kind).toBe("foreign");
  expect(failures).toHaveLength(1);
  expect(failures[0]).not.toContain("temporary");
});
