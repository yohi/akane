import { describe, test, expect } from "bun:test";
import { startTelemetryReporter, TelemetryCollector } from "../src/telemetry";
import { FakeClock } from "../src/clock";

describe("startTelemetryReporter", () => {
  test("emits a report every interval via self-rescheduling", () => {
    const clock = new FakeClock();
    const telemetry = new TelemetryCollector();
    const logs: string[] = [];
    const stop = startTelemetryReporter({
      clock,
      telemetry,
      intervalMs: 1000,
      log: (_l, m) => logs.push(m),
    });
    clock.advance(3000);
    expect(logs.length).toBe(3);
    expect(logs[0]).toContain("[Telemetry]");
    stop();
  });

  test("stop() cancels the timer and prevents leaks", () => {
    const clock = new FakeClock();
    const telemetry = new TelemetryCollector();
    const logs: string[] = [];
    const stop = startTelemetryReporter({
      clock,
      telemetry,
      intervalMs: 1000,
      log: (_l, m) => logs.push(m),
    });
    clock.advance(1000);
    expect(logs.length).toBe(1);
    stop();
    clock.advance(5000);
    expect(logs.length).toBe(1); // no further reports
    expect(clock.pendingTimerCount()).toBe(0);
  });
});
