import { describe, test, expect } from "bun:test";
import { TelemetryCollector, NoopTelemetry } from "../src/telemetry";

describe("TelemetryCollector", () => {
  test("counts each event type", () => {
    const t = new TelemetryCollector();
    t.recordHangup();
    t.recordHangup();
    t.recordPing();
    t.recordRecovery();
    t.recordFailure();
    const s = t.snapshot();
    expect(s.hangupsDetected).toBe(2);
    expect(s.pingsSent).toBe(1);
    expect(s.recoveries).toBe(1);
    expect(s.silencedFailures).toBe(1);
  });

  test("recoveryRate is null when no recoveries and no failures", () => {
    const t = new TelemetryCollector();
    expect(t.snapshot().recoveryRate).toBeNull();
  });

  test("recoveryRate = recoveries / (recoveries + failures)", () => {
    const t = new TelemetryCollector();
    t.recordRecovery();
    t.recordRecovery();
    t.recordFailure();
    expect(t.snapshot().recoveryRate).toBeCloseTo(2 / 3, 5);
  });

  test("report() renders a single-line human-readable summary", () => {
    const t = new TelemetryCollector();
    t.recordHangup();
    t.recordHangup();
    t.recordHangup();
    t.recordPing();
    t.recordPing();
    t.recordPing();
    t.recordPing();
    t.recordRecovery();
    t.recordRecovery();
    t.recordFailure();
    expect(t.report()).toBe(
      "[Telemetry] hangups=3 pings=4 recoveries=2 failures=1 recoveryRate=66.7%",
    );
  });
});

describe("NoopTelemetry", () => {
  test("snapshot is all zeros with null recoveryRate", () => {
    const t = new NoopTelemetry();
    t.recordHangup();
    t.recordPing();
    t.recordRecovery();
    t.recordFailure();
    expect(t.snapshot()).toEqual({
      hangupsDetected: 0,
      pingsSent: 0,
      recoveries: 0,
      silencedFailures: 0,
      recoveryRate: null,
    });
  });

  test("report renders zero summary", () => {
    expect(new NoopTelemetry().report()).toBe(
      "[Telemetry] hangups=0 pings=0 recoveries=0 failures=0 recoveryRate=n/a",
    );
  });
});
