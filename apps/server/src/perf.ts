// The server's measurements of itself (queue SV): how late its event loop runs, how long each request takes (by
// route), and every stretch of more than BLOCK_MS in which the loop was blocked, with what was measured running in
// it: the request, the state rebuild, the decision on a change, the git call. A blocked loop answers nobody: every
// dashboard and every CLI call that asks the server waits it out.
//
// Measured spans are synchronous: `perf.measure(what, fn)` times fn and remembers it until the loop's next tick. A
// ticker every TICK_MS sees how late it fires; when it is BLOCK_MS late, the loop was blocked that long and the spans
// that ended since its last tick say by what (the longest first; nested spans carry their parents: "GET /api/... >
// state nexus"). A block with no span in it ran in code nothing measures, said as such.
//
// Nothing is written to a file of its own: the blocks and slow requests go to the server's log as they happen, and a
// summary every SUMMARY_MS; the numbers since the start are served read-only at GET /api/server/perf (docs/protocol/api.md).
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Context, Next } from "hono";
import { matchedRoutes, routePath } from "hono/route";

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

/** A loop blocked this long (ms) is logged as a block; a request that took this long is logged as slow. */
const BLOCK_MS = 200;
const TICK_MS = 50;
const SUMMARY_MS = 10 * 60_000;
/** The blocks kept for the endpoint, newest last. */
const KEEP_BLOCKS = 50;
/** Spans kept between two ticks: the longest win when more end in one tick. */
const KEEP_SPANS = 64;

export interface Span { what: string; ms: number }
export interface Block { at: string; ms: number; during: Span[] }
interface LoopDelay { mean_ms: number; p50_ms: number; p99_ms: number; max_ms: number }
export interface RouteStats { route: string; count: number; total_ms: number; mean_ms: number; max_ms: number; sync_max_ms: number; slow: number; statuses: Record<string, number> }
export interface SpanStats { what: string; count: number; total_ms: number; mean_ms: number; max_ms: number }
export interface PerfView {
  since: string;
  block_ms: number;
  /** Event loop delay since the start, and since the last summary in the log. */
  loop: LoopDelay;
  loop_window: LoopDelay & { since: string };
  /** By total time, the most first. */
  routes: RouteStats[];
  spans: SpanStats[];
  /** The latest blocks, newest first. */
  blocks: Block[];
}

const round = (ms: number) => Math.round(ms * 10) / 10;
const ns = (h: IntervalHistogram, f: (h: IntervalHistogram) => number) => (h.count ? round(f(h) / 1e6) : 0);
const delay = (h: IntervalHistogram): LoopDelay => ({ mean_ms: ns(h, (x) => x.mean), p50_ms: ns(h, (x) => x.percentile(50)), p99_ms: ns(h, (x) => x.percentile(99)), max_ms: ns(h, (x) => x.max) });

/** The label of a git call: `git <its subcommand>` (the first argument that is not an option). */
export const gitLabel = (args: readonly string[]) => `git ${args.find((a) => !a.startsWith("-")) ?? args[0] ?? ""}`;

export class Perf {
  private readonly blockMs: number;
  private readonly tickMs: number;
  private readonly log: (line: string) => void;
  private stack: string[] = [];
  /** Spans that ended since the last tick. */
  private ended: Span[] = [];
  private last = 0;
  private timers: NodeJS.Timeout[] = [];
  private total?: IntervalHistogram;
  private window?: IntervalHistogram;
  private since = new Date().toISOString();
  private windowSince = this.since;
  private readonly blocks: Block[] = [];
  private readonly routes = new Map<string, Omit<RouteStats, "route" | "mean_ms">>();
  private readonly spans = new Map<string, Omit<SpanStats, "what" | "mean_ms">>();

  constructor(o: { blockMs?: number; tickMs?: number; log?: (line: string) => void } = {}) {
    this.blockMs = o.blockMs ?? BLOCK_MS;
    this.tickMs = o.tickMs ?? TICK_MS;
    this.log = o.log ?? ((line) => console.log(line));
  }

  get running(): boolean { return this.timers.length > 0; }

  /** Starts measuring: the loop's delay, the ticker for blocks, the summary in the log. The timers keep no process alive. */
  start(o: { summaryMs?: number } = {}): void {
    if (this.running) return;
    this.since = this.windowSince = new Date().toISOString();
    this.total = monitorEventLoopDelay({ resolution: 10 });
    this.window = monitorEventLoopDelay({ resolution: 10 });
    this.total.enable();
    this.window.enable();
    this.last = performance.now();
    this.timers = [setInterval(() => this.tick(), this.tickMs), setInterval(() => this.summary(), o.summaryMs ?? SUMMARY_MS)];
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.total?.disable();
    this.window?.disable();
  }

  /**
   * Times asynchronous work (a git process the loop does not wait for): counted under "async <what>" in the spans, by
   * its whole time, but never part of a block (the loop runs on meanwhile).
   */
  async timed<T>(what: string, work: Promise<T>): Promise<T> {
    const t0 = performance.now();
    try { return await work; }
    finally { this.count(`async ${what}`, performance.now() - t0); }
  }

  /** Runs fn (synchronous) as a measured span. Its time counts for `what` whether or not the measuring is started. */
  measure<T>(what: string, fn: () => T): T {
    this.stack.push(what);
    const t0 = performance.now();
    try { return fn(); }
    finally { this.end(performance.now() - t0); }
  }

  /** A span counts under its path ("GET /api/projects/:id/state > state nexus"): what it ran for, not only what it was. */
  private end(ms: number): void {
    const path = this.stack.join(" > ");
    this.stack.pop();
    this.count(path, ms);
    if (!this.running || ms < 1) return;
    this.ended.push({ what: path, ms: round(ms) });
    if (this.ended.length > KEEP_SPANS * 2) this.ended = this.longest(this.ended, KEEP_SPANS);
  }

  /** Adds one run of `what` to the span statistics. */
  private count(what: string, ms: number): void {
    const s = this.spans.get(what) ?? { count: 0, total_ms: 0, max_ms: 0 };
    s.count++; s.total_ms += ms; s.max_ms = Math.max(s.max_ms, ms);
    this.spans.set(what, s);
  }

  private longest(spans: Span[], n: number): Span[] { return [...spans].sort((a, b) => b.ms - a.ms).slice(0, n); }

  /** The ticker: fired this late, the loop was blocked; the spans ended since the last tick are what ran. */
  tick(now = performance.now()): Block | undefined {
    const late = now - this.last - this.tickMs;
    this.last = now;
    const ended = this.ended;
    this.ended = [];
    if (late < this.blockMs) return undefined;
    const block: Block = { at: new Date().toISOString(), ms: Math.round(late), during: this.longest(ended, 5) };
    this.blocks.push(block);
    if (this.blocks.length > KEEP_BLOCKS) this.blocks.shift();
    const during = block.during.length ? block.during.map((s) => `${s.what} ${Math.round(s.ms)} ms`).join("; ") : "nothing measured";
    this.log(`perf: event loop blocked ${block.ms} ms (${during})`);
    return block;
  }

  /**
   * The middleware that times every request by its route: the whole of it, and the synchronous part (until the handler
   * first waits), which is measured as a span named by the request's method and route ("GET /api/projects/:id/state").
   */
  middleware = async (c: Context, next: Next): Promise<void> => {
    const t0 = performance.now();
    let sync: number | undefined;
    try {
      const pending = this.measure(`${c.req.method} ${this.handlerRoute(c)}`, () => next());
      sync = performance.now() - t0;
      await pending;
    } finally {
      const ms = performance.now() - t0;
      this.request(`${c.req.method} ${this.route(c)}`, c.error ? 500 : c.res.status, ms, sync ?? ms);
    }
  };

  /** The route of the first handler the request matched (middleware match every method), before it runs. */
  private handlerRoute(c: Context): string {
    try { return matchedRoutes(c).find((r) => r.method !== "ALL")?.path ?? c.req.path; } catch { return c.req.path; }
  }

  private route(c: Context): string {
    try { return routePath(c) || c.req.path; } catch { return c.req.path; }
  }

  private request(route: string, status: number, ms: number, sync: number): void {
    const r = this.routes.get(route) ?? { count: 0, total_ms: 0, max_ms: 0, sync_max_ms: 0, slow: 0, statuses: {} };
    r.count++; r.total_ms += ms; r.max_ms = Math.max(r.max_ms, ms); r.sync_max_ms = Math.max(r.sync_max_ms, sync);
    r.statuses[status] = (r.statuses[status] ?? 0) + 1;
    if (ms >= this.blockMs) {
      r.slow++;
      if (this.running) this.log(`perf: slow request ${route} ${status} ${Math.round(ms)} ms (synchronous ${Math.round(sync)} ms)`);
    }
    this.routes.set(route, r);
  }

  /** The summary line in the log, and a new window for the loop's delay. */
  summary(): string {
    const w = this.window ? delay(this.window) : delay0;
    const top = this.routeStats().slice(0, 3).map((r) => `${r.route} ${r.count}x mean ${r.mean_ms} max ${r.max_ms}`).join("; ");
    const blocks = this.blocks.filter((b) => b.at >= this.windowSince).length;
    const line = `perf: since ${this.windowSince}: event loop delay p50 ${w.p50_ms} p99 ${w.p99_ms} max ${w.max_ms} ms; ${blocks} block(s) over ${this.blockMs} ms; most request time: ${top || "none"}`;
    this.log(line);
    this.window?.reset();
    this.windowSince = new Date().toISOString();
    return line;
  }

  private routeStats(): RouteStats[] {
    return [...this.routes].map(([route, r]) => ({ route, ...r, total_ms: Math.round(r.total_ms), mean_ms: round(r.total_ms / r.count), max_ms: round(r.max_ms), sync_max_ms: round(r.sync_max_ms) }))
      .sort((a, b) => b.total_ms - a.total_ms);
  }

  view(): PerfView {
    return {
      since: this.since,
      block_ms: this.blockMs,
      loop: this.total ? delay(this.total) : delay0,
      loop_window: { ...(this.window ? delay(this.window) : delay0), since: this.windowSince },
      routes: this.routeStats(),
      spans: [...this.spans].map(([what, s]) => ({ what, ...s, total_ms: Math.round(s.total_ms), mean_ms: round(s.total_ms / s.count), max_ms: round(s.max_ms) }))
        .sort((a, b) => b.total_ms - a.total_ms).slice(0, 40),
      blocks: [...this.blocks].reverse(),
    };
  }
}

const delay0: LoopDelay = { mean_ms: 0, p50_ms: 0, p99_ms: 0, max_ms: 0 };

/** The server's own measurements: modules measure their spans here; main.ts starts it. */
export const perf = new Perf();
