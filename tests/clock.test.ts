import { describe, test, expect } from "bun:test";
import { RealClock, FakeClock, type Clock } from "../src/clock";

describe("RealClock", () => {
  test("setTimeout invokes callback after delay (smoke)", async () => {
    const clock: Clock = new RealClock();
    let called = false;
    const handle = clock.setTimeout(() => {
      called = true;
    }, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(called).toBe(true);
    clock.clearTimeout(handle);
  });

  test("clearTimeout prevents callback firing", async () => {
    const clock: Clock = new RealClock();
    let called = false;
    const handle = clock.setTimeout(() => {
      called = true;
    }, 20);
    clock.clearTimeout(handle);
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(false);
  });
});

describe("FakeClock", () => {
  test("does not fire until advance()", () => {
    const clock = new FakeClock();
    let called = false;
    clock.setTimeout(() => {
      called = true;
    }, 100);
    expect(called).toBe(false);
    clock.advance(99);
    expect(called).toBe(false);
    clock.advance(1);
    expect(called).toBe(true);
  });

  test("clearTimeout removes pending callback", () => {
    const clock = new FakeClock();
    let called = false;
    const handle = clock.setTimeout(() => {
      called = true;
    }, 50);
    clock.clearTimeout(handle);
    clock.advance(100);
    expect(called).toBe(false);
  });

  test("multiple timers fire in order", () => {
    const clock = new FakeClock();
    const order: number[] = [];
    clock.setTimeout(() => order.push(2), 200);
    clock.setTimeout(() => order.push(1), 100);
    clock.advance(300);
    expect(order).toEqual([1, 2]);
  });

  test("pendingTimerCount tracks scheduled, fired, and cancelled timers", () => {
    const clock = new FakeClock();
    expect(clock.pendingTimerCount()).toBe(0);

    const h1 = clock.setTimeout(() => {}, 100);
    clock.setTimeout(() => {}, 200);
    expect(clock.pendingTimerCount()).toBe(2);

    clock.clearTimeout(h1);
    expect(clock.pendingTimerCount()).toBe(1);

    clock.advance(300); // fires the remaining timer
    expect(clock.pendingTimerCount()).toBe(0);
  });
});
