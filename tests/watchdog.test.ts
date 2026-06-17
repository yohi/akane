import { describe, test, expect } from "bun:test";
import { Watchdog } from "../src/watchdog";
import { FakeClock } from "../src/clock";
import { MockPinger } from "../src/pinger";
import type { Notifier, NotifierStage } from "../src/notifier";
import type { Telemetry, TelemetrySnapshot } from "../src/telemetry";
import type { WatchdogConfig } from "../src/config";

interface NotifyCall {
  sessionId: string;
  stage: NotifierStage;
  message: string;
}

class MockNotifier implements Notifier {
  notifies: NotifyCall[] = [];
  cleared: string[] = [];
  async notify(sessionId: string, stage: NotifierStage, message: string) {
    this.notifies.push({ sessionId, stage, message });
  }
  async clear(sessionId: string) {
    this.cleared.push(sessionId);
  }
}

class MockTelemetry implements Telemetry {
  hangups = 0;
  pings = 0;
  recoveries = 0;
  failures = 0;
  recordHangup() {
    this.hangups += 1;
  }
  recordPing() {
    this.pings += 1;
  }
  recordRecovery() {
    this.recoveries += 1;
  }
  recordFailure() {
    this.failures += 1;
  }
  snapshot(): TelemetrySnapshot {
    return {
      hangupsDetected: this.hangups,
      pingsSent: this.pings,
      recoveries: this.recoveries,
      silencedFailures: this.failures,
      recoveryRate: null,
    };
  }
  report() {
    return "";
  }
}

const baseConfig: WatchdogConfig = {
  enabled: true,
  stage1Ms: 1000,
  stage2Ms: 1000,
  maxPings: 1,
  pingMessage: "ping?",
  notifierType: "tmux",
  delivery: "steer",
  suppressPingWhileToolRunning: true,
  pauseOnInputRequest: true,
  notifyWaiting: true,
  verboseLog: false,
  tmux: { enabled: true, displayMessage: true, highlightWindow: true },
  agents: {},
};

function setup(configOverrides: Partial<WatchdogConfig> = {}) {
  const clock = new FakeClock();
  const pinger = new MockPinger();
  const notifier = new MockNotifier();
  const telemetry = new MockTelemetry();
  const watchdog = new Watchdog({
    config: { ...baseConfig, ...configOverrides },
    clock,
    pinger,
    notifier,
    telemetry,
    log: () => {},
  });
  return { clock, pinger, notifier, telemetry, watchdog };
}

describe("Watchdog - basic timer behavior", () => {
  test("onActivity creates a timer when none exists", () => {
    const { watchdog } = setup();
    watchdog.onActivity("s1");
    expect(watchdog.activeSessionCount()).toBe(1);
  });

  test("multiple onActivity calls keep only one timer per session", () => {
    const { watchdog } = setup();
    for (let i = 0; i < 100; i++) {
      watchdog.onActivity("s1");
    }
    expect(watchdog.activeSessionCount()).toBe(1);
  });

  test("stage1 expires triggers notifier.notify(warn)", async () => {
    const { watchdog, notifier, clock } = setup();
    watchdog.onActivity("s1");
    clock.advance(1000);
    expect(notifier.notifies.length).toBe(1);
    expect(notifier.notifies[0]!.stage).toBe("warn");
  });

  test("stage1+stage2 expires triggers pinger.inject and notifier.notify(critical)", async () => {
    const { watchdog, notifier, pinger, clock } = setup();
    watchdog.onActivity("s1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2
    // Wait for async ping
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
    expect(pinger.calls[0]!.sessionId).toBe("s1");
    expect(pinger.calls[0]!.message).toBe("ping?");
    expect(notifier.notifies.some((n) => n.stage === "critical")).toBe(true);
  });

  test("activity after STAGE1_NOTIFIED resets to WATCHING", async () => {
    const { watchdog, notifier, clock } = setup();
    watchdog.onActivity("s1");
    clock.advance(1000); // stage1 fires
    expect(notifier.notifies.length).toBe(1);
    notifier.notifies.length = 0;
    watchdog.onActivity("s1"); // back to WATCHING
    clock.advance(999); // not yet stage1
    expect(notifier.notifies.length).toBe(0);
    clock.advance(1); // stage1 again
    expect(notifier.notifies.length).toBe(1);
  });
});

describe("Watchdog - maxPings ceiling", () => {
  test("maxPings=1: second stage2 does not inject again, transitions to silenced", async () => {
    const { watchdog, pinger, notifier, clock } = setup({ maxPings: 1 });
    watchdog.onActivity("s1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 → ping #1
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
    clock.advance(1000); // stage2 fires again with no activity
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1); // still 1, no new ping
    expect(notifier.notifies.some((n) => n.stage === "silenced")).toBe(true);
  });

  test("activity in SILENCED state resets pingCount and returns to WATCHING", async () => {
    const { watchdog, pinger, clock } = setup({ maxPings: 1 });
    watchdog.onActivity("s1");
    clock.advance(1000);
    clock.advance(1000); // ping
    await new Promise((r) => setTimeout(r, 10));
    clock.advance(1000); // silenced
    await new Promise((r) => setTimeout(r, 10));

    watchdog.onUserMessage("s1"); // recovery via user input per §3.4
    clock.advance(1000); // stage1 again
    clock.advance(1000); // stage2 → ping again because pingCount reset
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(2);
  });
});

describe("Watchdog - lifecycle cleanup", () => {
  test("stop() removes session from map and prevents further timers", () => {
    const { watchdog, notifier, clock } = setup();
    watchdog.onActivity("s1");
    expect(watchdog.activeSessionCount()).toBe(1);
    watchdog.stop("s1");
    expect(watchdog.activeSessionCount()).toBe(0);
    clock.advance(10_000);
    expect(notifier.notifies.length).toBe(0);
  });

  test("late message.part.updated after stop() is ignored (no timer rearm)", () => {
    // Per design §7.3: "session.idle 後に message.part.updated を受信しても
    // 新規タイマーが作られない (stop 時に sessionId を FIFO 上限 10,000 件の
    // tombstone セットへ登録し、それ以内に到着した message.part.updated 側で
    // 抑止するため)".
    // Stale events from a stopped session must not produce false positives.
    const { watchdog, clock, notifier } = setup();
    watchdog.onActivity("s1");
    watchdog.stop("s1");
    watchdog.onActivity("s1"); // simulated late part event
    clock.advance(10_000);
    expect(notifier.notifies.length).toBe(0);
    expect(watchdog.activeSessionCount()).toBe(0);
  });

  test("onUserMessage after stop() re-arms (new burst is allowed via user input only)", () => {
    // A fresh user prompt on a previously stopped session is legitimately a new burst.
    // This is the documented re-entry point in design §3.4 (IDLE → message.updated role=user).
    const { watchdog, clock, notifier } = setup();
    watchdog.onActivity("s1");
    watchdog.stop("s1");
    watchdog.onUserMessage("s1"); // explicit user-driven re-entry
    clock.advance(1000);
    expect(notifier.notifies.length).toBe(1);
    expect(notifier.notifies[0]!.stage).toBe("warn");
  });

  test("stopAll() removes all sessions and clears all active timers", () => {
    const { watchdog, clock, notifier } = setup();
    watchdog.onActivity("s1");
    watchdog.onActivity("s2");
    expect(watchdog.activeSessionCount()).toBe(2);
    expect(watchdog.activeTimerCount()).toBe(2);

    watchdog.stopAll();
    expect(watchdog.activeSessionCount()).toBe(0);
    expect(watchdog.activeTimerCount()).toBe(0);

    clock.advance(10_000);
    expect(notifier.notifies.length).toBe(0);
  });
});

describe("Watchdog - initial hang detection (design §3.4)", () => {
  test("onUserMessage triggers timer even with no parts", async () => {
    const { watchdog, notifier, pinger, clock } = setup();
    watchdog.onUserMessage("s1");
    expect(watchdog.activeSessionCount()).toBe(1);
    clock.advance(1000); // stage1
    expect(notifier.notifies.length).toBe(1);
    clock.advance(1000); // stage2 ping
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
  });
});

describe("Watchdog - empty session no false trigger", () => {
  test("onSessionCreated alone does not arm any timer", () => {
    const { watchdog, clock, notifier } = setup();
    watchdog.onSessionCreated("s1");
    clock.advance(60_000);
    expect(watchdog.activeSessionCount()).toBe(0);
    expect(notifier.notifies.length).toBe(0);
  });
});

describe("Watchdog - agent filtering", () => {
  test("excluded agents do not trigger timers", () => {
    const { watchdog, clock, notifier } = setup({
      agents: { exclude: ["debug"] },
    });
    watchdog.onActivity("s1", { agentName: "debug" });
    expect(watchdog.activeSessionCount()).toBe(0);
    clock.advance(10_000);
    expect(notifier.notifies.length).toBe(0);
  });

  test("include list restricts monitoring to listed agents only", () => {
    const { watchdog, clock, notifier } = setup({
      agents: { include: ["main"] },
    });
    watchdog.onActivity("s1", { agentName: "secondary" });
    expect(watchdog.activeSessionCount()).toBe(0);
    clock.advance(10_000);
    expect(notifier.notifies.length).toBe(0);

    watchdog.onActivity("s2", { agentName: "main" });
    expect(watchdog.activeSessionCount()).toBe(1);
  });
});

describe("Watchdog - noteError and reason-aware ping", () => {
  test("noteError stores reason and pinger is called with raw message and context", async () => {
    const { watchdog, pinger, clock } = setup();
    watchdog.onActivity("s1");
    watchdog.noteError("s1", "rate_limit");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 → ping
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
    expect(pinger.calls[0]!.message).toBe("ping?");
    expect(pinger.calls[0]!.context).toEqual({ reason: "rate_limit" });
  });

  test("noteError on an unmonitored/unknown session is ignored (no entry created, no throw)", () => {
    const { watchdog } = setup();
    watchdog.noteError("ghost", "unknown");
    expect(watchdog.activeSessionCount()).toBe(0);
  });

  test("noteError on a stopped (tombstoned) session is ignored", () => {
    const { watchdog, pinger } = setup();
    watchdog.onActivity("s1");
    watchdog.stop("s1");
    watchdog.noteError("s1", "rate_limit");
    expect(pinger.calls.length).toBe(0);
  });

  test("ping without a noted reason uses base message unchanged", async () => {
    const { watchdog, pinger, clock } = setup();
    watchdog.onActivity("s1");
    clock.advance(1000);
    clock.advance(1000);
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls[0]!.message).toBe("ping?");
    expect(pinger.calls[0]!.context).toEqual({ reason: undefined });
  });
});

describe("Watchdog - telemetry hooks", () => {
  test("records a hangup when stage1 expires", () => {
    const { watchdog, telemetry, clock } = setup();
    watchdog.onActivity("s1");
    clock.advance(1000); // stage1
    expect(telemetry.hangups).toBe(1);
  });

  test("records a ping when stage2 injects", async () => {
    const { watchdog, telemetry, clock } = setup();
    watchdog.onActivity("s1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 → ping
    await new Promise((r) => setTimeout(r, 10));
    expect(telemetry.pings).toBe(1);
  });

  test("records a failure when transitioning to SILENCED", async () => {
    const { watchdog, telemetry, clock } = setup({ maxPings: 1 });
    watchdog.onActivity("s1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 → ping
    await new Promise((r) => setTimeout(r, 10));
    clock.advance(1000); // stage2 again → silenced
    await new Promise((r) => setTimeout(r, 10));
    expect(telemetry.failures).toBe(1);
  });

  test("records a recovery when activity returns after a ping", async () => {
    const { watchdog, telemetry, clock } = setup({ maxPings: 1 });
    watchdog.onActivity("s1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 → ping (pingCount=1, state PINGED)
    await new Promise((r) => setTimeout(r, 10));
    watchdog.onActivity("s1"); // activity returns before SILENCED
    expect(telemetry.recoveries).toBe(1);
  });
});

describe("Watchdog - PAUSED input-wait gating (design §4/§6.1)", () => {
  test("onInputRequested stops timer, transitions to PAUSED, notifies waiting once", () => {
    const { watchdog, notifier } = setup();
    watchdog.onActivity("s1");
    expect(watchdog.activeTimerCount()).toBe(1);
    watchdog.onInputRequested("s1", "per_1");
    expect(watchdog.activeTimerCount()).toBe(0);
    expect(notifier.notifies.filter((n) => n.stage === "waiting").length).toBe(1);
    watchdog.onInputRequested("s1", "que_2"); // second pending → no second notify
    expect(notifier.notifies.filter((n) => n.stage === "waiting").length).toBe(1);
  });

  test("PAUSED suppresses stage1/stage2 (no notify, no ping)", async () => {
    const { watchdog, notifier, pinger, clock } = setup();
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1");
    clock.advance(10_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(notifier.notifies.some((n) => n.stage === "warn" || n.stage === "critical")).toBe(false);
    expect(pinger.calls.length).toBe(0);
  });

  test("partial resolve keeps PAUSED; full resolve returns to WATCHING and clears notifier", () => {
    const { watchdog, notifier, clock } = setup();
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1");
    watchdog.onInputRequested("s1", "que_2");
    watchdog.onInputResolved("s1", "per_1");
    expect(watchdog.activeTimerCount()).toBe(0); // still PAUSED
    watchdog.onInputResolved("s1", "que_2");
    expect(watchdog.activeTimerCount()).toBe(1); // re-armed WATCHING
    expect(notifier.cleared).toContain("s1");
    clock.advance(1000);
    expect(notifier.notifies.some((n) => n.stage === "warn")).toBe(true);
  });

  test("assistant activity does NOT un-pause while pending (design §7)", () => {
    const { watchdog } = setup();
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1");
    watchdog.onActivity("s1"); // must be ignored
    expect(watchdog.activeTimerCount()).toBe(0);
  });

  test("onInputRequested respects tombstone (stopped session ignored)", () => {
    const { watchdog, notifier } = setup();
    watchdog.onActivity("s1");
    watchdog.stop("s1");
    watchdog.onInputRequested("s1", "per_1");
    expect(notifier.notifies.some((n) => n.stage === "waiting")).toBe(false);
    expect(watchdog.activeSessionCount()).toBe(0);
  });

  test("pauseOnInputRequest=false makes onInputRequested a no-op", () => {
    const { watchdog, notifier } = setup({ pauseOnInputRequest: false });
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1");
    expect(watchdog.activeTimerCount()).toBe(1); // unchanged
    expect(notifier.notifies.some((n) => n.stage === "waiting")).toBe(false);
  });

  test("notifyWaiting=false pauses without a waiting notification", () => {
    const { watchdog, notifier } = setup({ notifyWaiting: false });
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1");
    expect(watchdog.activeTimerCount()).toBe(0);
    expect(notifier.notifies.some((n) => n.stage === "waiting")).toBe(false);
  });
});

describe("Watchdog - tool-aware steer suppression (design §4/§6.1)", () => {
  test("stage2 with a running tool suppresses ping, holds pingCount, notifies critical, reschedules", async () => {
    const { watchdog, pinger, notifier, clock } = setup();
    watchdog.onToolRunning("s1", "call_1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 → gate
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(0); // steer suppressed
    expect(notifier.notifies.some((n) => n.stage === "critical")).toBe(true);
    expect(watchdog.activeTimerCount()).toBe(1); // rescheduled
  });

  test("repeated stage2 while tool runs does not spam critical notifications", async () => {
    const { watchdog, notifier, clock } = setup();
    watchdog.onToolRunning("s1", "call_1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 (1st gate → critical)
    await new Promise((r) => setTimeout(r, 10));
    const after1 = notifier.notifies.filter((n) => n.stage === "critical").length;
    clock.advance(1000); // stage2 again (still gated)
    await new Promise((r) => setTimeout(r, 10));
    const after2 = notifier.notifies.filter((n) => n.stage === "critical").length;
    expect(after2).toBe(after1); // no re-notify while still gated
  });

  test("after tool settles, normal stage2 ping resumes", async () => {
    const { watchdog, pinger, clock } = setup();
    watchdog.onToolRunning("s1", "call_1");
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 gated
    await new Promise((r) => setTimeout(r, 10));
    watchdog.onToolSettled("s1", "call_1"); // re-arms WATCHING
    clock.advance(1000); // stage1
    clock.advance(1000); // stage2 → ping now allowed
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
  });

  test("suppressPingWhileToolRunning=false lets the ping fire even with a running tool", async () => {
    const { watchdog, pinger, clock } = setup({ suppressPingWhileToolRunning: false });
    watchdog.onToolRunning("s1", "call_1");
    clock.advance(1000);
    clock.advance(1000);
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
  });

  test("two running tools: settling one keeps suppression until both settle", async () => {
    const { watchdog, pinger, clock } = setup();
    watchdog.onToolRunning("s1", "call_1");
    watchdog.onToolRunning("s1", "call_2");
    watchdog.onToolSettled("s1", "call_1");
    clock.advance(1000);
    clock.advance(1000);
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(0); // call_2 still running
  });

  test("tool parts do NOT un-pause a session awaiting input (design §7)", () => {
    const { watchdog } = setup();
    watchdog.onActivity("s1");
    watchdog.onInputRequested("s1", "per_1"); // PAUSED, timer stopped
    watchdog.onToolRunning("s1", "call_1");
    expect(watchdog.activeTimerCount()).toBe(0); // still PAUSED — not re-armed
    watchdog.onToolSettled("s1", "call_1");
    expect(watchdog.activeTimerCount()).toBe(0); // still PAUSED
  });
});
