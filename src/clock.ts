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
    ms = Number(ms);
    if (!isFinite(ms)) {
      throw new RangeError(`FakeClock.setTimeout: ms must be finite, got ${ms}`);
    }
    ms = Math.max(0, ms);
    const timer: FakeTimer = { fireAt: this.now + ms, callback, cancelled: false };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: TimerHandle): void {
    const timer = handle as FakeTimer | undefined;
    if (timer) {
      timer.cancelled = true;
      const idx = this.timers.indexOf(timer);
      if (idx !== -1) this.timers.splice(idx, 1);
    }
  }

  advance(ms: number): void {
    ms = Number(ms);
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`FakeClock.advance requires a finite non-negative ms, got: ${ms}`);
    }
    const targetTime = this.now + ms;
    // Process timers in deadline order until target reached
    // Loop until no more eligible timers (handles callbacks scheduling new timers)
    const MAX_ITERATIONS = 100_000;
    let iterations = 0;
    while (true) {
      if (++iterations > MAX_ITERATIONS) {
        throw new Error(
          `FakeClock.advance: exceeded ${MAX_ITERATIONS} timer iterations — possible infinite self-rescheduling loop`
        );
      }
      const eligible = this.timers
        .filter((t) => !t.cancelled && t.fireAt <= targetTime)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!eligible) break;

      this.now = eligible.fireAt;
      eligible.cancelled = true;
      const idx = this.timers.indexOf(eligible);
      if (idx !== -1) this.timers.splice(idx, 1);

      eligible.callback();
    }
    this.now = targetTime;
  }

  /** Number of timers scheduled but not yet fired or cancelled. Used by stress
   * tests to detect timer leaks (design §7.4). */
  pendingTimerCount(): number {
    return this.timers.length;
  }
}
