// Stalls of the server's event loop, bound to an event (queue LCF): a busy machine, or a long synchronous derivation,
// at the moment a test needs it, instead of a stall written by hand into the test's listener.
import type { EventEmitter } from "node:events";
import { WAIT_MS } from "./wait.ts";

interface StallOptions {
  /** Which emission of the event stalls (1 = the first; default 1). */
  nth?: number;
  /**
   * After `ms`, the loop stays blocked until this holds (looked at every millisecond or so, synchronously: a file
   * another process writes, never something this process's loop would have to do), at most WAIT_MS.
   */
  until?: () => boolean;
}

/** Blocks the event loop for `ms`, then until `until` holds (at most WAIT_MS more); false if it never did. */
function stall(ms: number, until?: () => boolean): boolean {
  const start = Date.now();
  while (Date.now() - start < ms) { /* busy */ }
  if (!until) return true;
  const end = Date.now() + WAIT_MS;
  for (let next = 0; ;) {
    const now = Date.now();
    if (now >= next) { if (until()) return true; next = now + 1; }
    if (now > end) return false;
  }
}

/**
 * Blocks the event loop when `emitter` emits `event` for the `nth` time, right after the code that emitted it returns
 * (a microtask, before the loop goes on): what that code set up after its emit in the same call (a timer, as
 * ClaudeSession.settleStop's after a stopped turn's `turnEnd`) is in place, so the timer expires during the stall, and
 * the I/O that came meanwhile is read only after it. The listeners of the event run before the stall, whatever their
 * order. Resolves once the stall has ended; rejects if `until` never held.
 */
export function stallAt<E extends Record<keyof E, any[]>>(emitter: EventEmitter<E>, event: keyof E & string, ms: number, options: StallOptions = {}): Promise<void> {
  const nth = options.nth ?? 1;
  let seen = 0;
  return new Promise((resolve, reject) => {
    const on = () => {
      if (++seen < nth) return;
      (emitter as unknown as EventEmitter).off(event, on);
      queueMicrotask(() => {
        if (stall(ms, options.until)) resolve();
        else reject(new Error(`stallAt(${event}): the stall's condition did not hold within ${WAIT_MS} ms`));
      });
    };
    (emitter as unknown as EventEmitter).on(event, on);
  });
}
