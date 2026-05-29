export type TimerHandle = unknown;

export interface Clock {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export class RealClock implements Clock {
  setTimeout(callback: () => void, ms: number): TimerHandle {
    return globalThis.setTimeout(callback, ms);
  }
  clearTimeout(handle: TimerHandle): void {
    if (handle !== undefined && handle !== null) {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    }
  }
}

interface FakeTimer {
  fireAt: number;
  callback: () => void;
  cancelled: boolean;
}

export class FakeClock implements Clock {
  private now = 0;
  private timers: FakeTimer[] = [];

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const timer: FakeTimer = { fireAt: this.now + ms, callback, cancelled: false };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: TimerHandle): void {
    const timer = handle as FakeTimer | undefined;
    if (timer) timer.cancelled = true;
  }

  advance(ms: number): void {
    const targetTime = this.now + ms;
    // Process timers in deadline order until target reached
    // Loop until no more eligible timers (handles callbacks scheduling new timers)
    while (true) {
      const eligible = this.timers
        .filter((t) => !t.cancelled && t.fireAt <= targetTime)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!eligible) break;
      this.now = eligible.fireAt;
      eligible.cancelled = true;
      eligible.callback();
    }
    this.now = targetTime;
  }

  /** Number of timers scheduled but not yet fired or cancelled. Used by stress
   * tests to detect timer leaks (design §7.4). */
  pendingTimerCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}
