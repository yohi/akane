import type { HostEvent } from "../../src/opencode/types";

export function cancelledForm(sessionID: string, id = "frm_fixture"): HostEvent {
  return { id: "evt_fixture", created: 0, type: "form.cancelled", data: { id, sessionID } };
}

export function eventStream(events: readonly HostEvent[]): AsyncIterable<HostEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}
