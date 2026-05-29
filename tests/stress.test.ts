import { describe, test, expect } from "bun:test";
import { Watchdog } from "../src/watchdog";
import { FakeClock } from "../src/clock";
import { MockPinger } from "../src/pinger";
import type { Notifier, NotifierStage } from "../src/notifier";
import type { WatchdogConfig } from "../src/config";

class NoopNotifier implements Notifier {
  async notify(_id: string, _s: NotifierStage, _m: string) {}
  async clear(_id: string) {}
}

const cfg: WatchdogConfig = {
  enabled: true,
  stage1Ms: 1000,
  stage2Ms: 1000,
  maxPings: 1,
  pingMessage: "p",
  tmux: { enabled: true, displayMessage: true, highlightWindow: true },
  agents: {},
};

describe("Watchdog - memory & timer leak (design §7.4)", () => {
  test("1000 sessions x 100 chunks: Map empty AND active timers 0 after all sessions idle", () => {
    const clock = new FakeClock();
    const watchdog = new Watchdog({
      config: cfg,
      clock,
      pinger: new MockPinger(),
      notifier: new NoopNotifier(),
    });

    for (let s = 0; s < 1000; s++) {
      const sid = `sess-${s}`;
      for (let c = 0; c < 100; c++) {
        watchdog.onActivity(sid);
      }
    }
    // Mid-state: Map populated, every session has exactly one armed stage1 timer.
    expect(watchdog.activeSessionCount()).toBe(1000);
    expect(watchdog.activeTimerCount()).toBe(1000);
    // FakeClock-side: Watchdog reset overwrites the prior timer reference, so
    // the cancelled tombstones accumulate inside FakeClock but the live count
    // (non-cancelled) must match Watchdog's view.
    expect(clock.pendingTimerCount()).toBe(1000);

    for (let s = 0; s < 1000; s++) {
      watchdog.stop(`sess-${s}`);
    }
    // After cleanup: zero on every leak surface.
    expect(watchdog.activeSessionCount()).toBe(0);
    expect(watchdog.activeTimerCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  test("session.idle then later activity does not leak old timers", () => {
    const clock = new FakeClock();
    const watchdog = new Watchdog({
      config: cfg,
      clock,
      pinger: new MockPinger(),
      notifier: new NoopNotifier(),
    });

    for (let i = 0; i < 100; i++) {
      watchdog.onActivity("s1");
      watchdog.stop("s1");
    }
    expect(watchdog.activeSessionCount()).toBe(0);
    expect(watchdog.activeTimerCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  test("repeated onActivity for the same session keeps exactly one live timer", () => {
    const clock = new FakeClock();
    const watchdog = new Watchdog({
      config: cfg,
      clock,
      pinger: new MockPinger(),
      notifier: new NoopNotifier(),
    });
    for (let i = 0; i < 500; i++) {
      watchdog.onActivity("s-single");
    }
    // Watchdog-side: one entry, one live timer. Setting design §7.3:
    // "Map 内のタイマーは常に 1 つだけ".
    expect(watchdog.activeSessionCount()).toBe(1);
    expect(watchdog.activeTimerCount()).toBe(1);
    expect(clock.pendingTimerCount()).toBe(1);
  });
});

describe("Acceptance §10 - initial hang detection", () => {
  test("onUserMessage only, no parts: stage1 notifies, stage2 pings", async () => {
    const clock = new FakeClock();
    const pinger = new MockPinger();
    const notifies: NotifierStage[] = [];
    const notifier: Notifier = {
      async notify(_id, stage) {
        notifies.push(stage);
      },
      async clear() {},
    };
    const watchdog = new Watchdog({ config: cfg, clock, pinger, notifier });
    watchdog.onUserMessage("s-init");
    clock.advance(cfg.stage1Ms);
    expect(notifies).toContain("warn");
    clock.advance(cfg.stage2Ms);
    await new Promise((r) => setTimeout(r, 10));
    expect(pinger.calls.length).toBe(1);
  });
});

describe("Acceptance §10 - empty session no false trigger", () => {
  test("onSessionCreated alone never arms a timer", () => {
    const clock = new FakeClock();
    const pinger = new MockPinger();
    const notifies: NotifierStage[] = [];
    const notifier: Notifier = {
      async notify(_id, stage) {
        notifies.push(stage);
      },
      async clear() {},
    };
    const watchdog = new Watchdog({ config: cfg, clock, pinger, notifier });
    watchdog.onSessionCreated("s-empty");
    clock.advance(60_000);
    expect(pinger.calls.length).toBe(0);
    expect(notifies.length).toBe(0);
    expect(watchdog.activeSessionCount()).toBe(0);
  });
});
