import { describe, test, expect } from "bun:test";
import { Watchdog } from "../src/watchdog";
import { FakeClock } from "../src/clock";
import { MockPinger } from "../src/pinger";
import type { Notifier, NotifierStage } from "../src/notifier";
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

const baseConfig: WatchdogConfig = {
  enabled: true,
  stage1Ms: 1000,
  stage2Ms: 1000,
  maxPings: 1,
  pingMessage: "ping?",
  notifierType: "tmux",
  tmux: { enabled: true, displayMessage: true, highlightWindow: true },
  agents: {},
};

function setup(configOverrides: Partial<WatchdogConfig> = {}) {
  const clock = new FakeClock();
  const pinger = new MockPinger();
  const notifier = new MockNotifier();
  const watchdog = new Watchdog({
    config: { ...baseConfig, ...configOverrides },
    clock,
    pinger,
    notifier,
    log: () => {},
  });
  return { clock, pinger, notifier, watchdog };
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
