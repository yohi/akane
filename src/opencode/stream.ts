import type { HostEvent, V2Context } from "./types";

const BACKOFF = [250, 500, 1000, 5000] as const;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function consumeEvents(
  events: V2Context["event"],
  handle: (event: HostEvent) => Promise<void>,
  signal: AbortSignal,
  onGap: () => Promise<void>,
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      for await (const event of events.subscribe({ signal })) {
        if (signal.aborted) return;
        await handle(event);
        failures = 0;
      }
      if (signal.aborted) return;
    } catch {
      if (signal.aborted) return;
    }
    await onGap();
    if (signal.aborted) return;
    await delay(BACKOFF[Math.min(failures++, BACKOFF.length - 1)] ?? 5000, signal);
  }
}
