// A clock for the engine's long timers (EngineOptions.clock) that moves only when a test moves it: a window, a schedule
// or a wait ends when the test says so, not after real time that a busy machine stretches (queue CI8).
import type { Clock } from "../src/scheduler.ts";

/** A clock that moves only when told; its timers fire in order as it passes them. */
export class TestClock implements Clock {
  t = Date.now();
  private timers: { at: number; fn: () => void }[] = [];
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const h = { at: this.t + ms, fn }; this.timers.push(h); return h; }
  clearTimeout(h: unknown) { this.timers = this.timers.filter((x) => x !== h); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}
