import { expect, test } from "bun:test";
import { Plugin } from "@opencode/plugin";
import plugin from "../../src/index";
import { cancelledForm, eventStream } from "../fixtures/opencode-v2";

test("V2 plugin setup accepts the native context", () => {
  const plugin = Plugin.define({ id: "fixture", setup: () => undefined });
  expect(typeof plugin.setup).toBe("function");
});

test("published entrypoint is a V2 plugin with no legacy server hook", () => {
  expect(plugin.id).toBe("opencode-watchdog");
  expect(typeof plugin.setup).toBe("function");
  expect("server" in plugin).toBe(false);
});

test("V2 form cancellations use the native data envelope", async () => {
  const stream = eventStream([cancelledForm("ses_fixture")]);
  const event = (await stream[Symbol.asyncIterator]().next()).value;
  if (!event || event.type !== "form.cancelled") throw new Error("missing cancellation");
  expect(event.data.id).toBe("frm_fixture");
  expect("properties" in event).toBe(false);
});
