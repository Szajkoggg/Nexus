// The time Nexus stamps on what it writes (docs/DESIGN.md, "Clock steps"): never earlier than a time this process has
// already read in another writer's records or stamped itself, so an effect is stamped after its cause even when this
// process's clock lags (V8 on Windows re-reads the system time only once a minute: after an NTP step a long-lived
// server writes on the old base while every `nexus` call already uses the new one) or the clock stepped back.
// A hybrid logical clock with millisecond precision; the `at` format stays ISO 8601.

/**
 * A time read more than this far ahead of the wall clock is not taken up: it is no clock step of the kind Nexus meets
 * (the steps seen were minutes: 4 min after an NTP sync, V8's lag at most a minute), more likely a time set by hand or
 * a test's fixture, and taking it up would hold every later stamp at it until the wall clock caught up.
 */
export const CLOCK_AHEAD_MS = 15 * 60_000;

/** The latest time this process has read from another writer (plus 1 ms) or stamped itself, in ms. */
let mark = 0;

/** A time read in another writer's record: what this process stamps from now on comes after it. */
export function observe(at: string | undefined): void {
  if (!at) return;
  const t = Date.parse(at);
  if (Number.isFinite(t) && t + 1 > mark && t <= Date.now() + CLOCK_AHEAD_MS) mark = t + 1;
}

/** The stamp for a record written now: the wall clock, raised to the latest time seen. */
export function now(): string {
  const t = Math.max(Date.now(), mark);
  mark = t;
  return new Date(t).toISOString();
}

/** The mark itself (for the server's hand-over to the CLI, `.nexus/clock.json`); undefined before any. */
export const clockMark = (): string | undefined => (mark ? new Date(mark).toISOString() : undefined);

/**
 * Merges logs that each have one writer into one order (docs/DESIGN.md, "Clock steps"): a log's own lines keep the order
 * they were written in, whatever their times say. A line's effective time is its `at` raised to the previous line's
 * effective time in the same log; the logs are merged by effective time, then by `key` (compareIds order). For logs
 * written without a clock step this is the plain sort by (at, key); a log written across a backward step keeps its
 * order. Returns each item with its effective time.
 */
export function inFileOrder<T>(files: readonly (readonly T[])[], at: (x: T) => string, key: (x: T) => string): { item: T; at: string }[] {
  type Head = { f: number; i: number; at: string; key: string };
  const head = (f: number, i: number, prev: string): Head | undefined => {
    const x = files[f]![i];
    if (x === undefined) return undefined;
    const t = at(x);
    return { f, i, at: t > prev ? t : prev, key: key(x) };
  };
  const less = (a: Head, b: Head) => (a.at !== b.at ? a.at < b.at : a.key !== b.key ? a.key < b.key : a.f < b.f);
  const heap: Head[] = [];
  const up = (n: number) => {
    while (n > 0) { const p = (n - 1) >> 1; if (!less(heap[n]!, heap[p]!)) break; [heap[n], heap[p]] = [heap[p]!, heap[n]!]; n = p; }
  };
  const down = (n: number) => {
    for (;;) {
      const l = 2 * n + 1, r = l + 1;
      let m = n;
      if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
      if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
      if (m === n) return;
      [heap[n], heap[m]] = [heap[m]!, heap[n]!]; n = m;
    }
  };
  files.forEach((_, f) => { const h = head(f, 0, ""); if (h) { heap.push(h); up(heap.length - 1); } });
  const out: { item: T; at: string }[] = [];
  while (heap.length) {
    const h = heap[0]!;
    out.push({ item: files[h.f]![h.i]!, at: h.at });
    const next = head(h.f, h.i + 1, h.at);
    if (next) heap[0] = next; else { heap[0] = heap.at(-1)!; heap.pop(); }
    if (heap.length) down(0);
  }
  return out;
}

/**
 * Forgets the times seen: for a process that sets its own clock back on purpose and means it (a test that starts each
 * case at the same mocked time). Nexus itself never calls it.
 */
export function resetClock(): void { mark = 0; }
