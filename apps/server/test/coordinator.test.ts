// Never two queues in one checkout, and a limit on queues running at once (src/coordinator.ts), against the fake
// runtimes: projects whose engines share one coordinator, as the server's do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, newId, routeAnswers, type Event, type StepDef } from "@nexus/protocol";
import { Engine, type Clock } from "../src/engine.ts";
import { Coordinator, DEFAULT_MAX_RUNNING, readLimits, writeLimits } from "../src/coordinator.ts";
import { acceptReviews } from "./fake-reviewer.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");

const MIN = 60_000;

/** A clock that moves only when told; its timers fire in order as it passes them (as in schedules.test.ts). */
class TestClock implements Clock {
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

/** A queue: its steps' fake behaviours; `own`: in a worktree of its own (a folder), else the project's checkout. */
type Spec = string[] | { steps: string[]; own?: boolean; level?: 1 | 2 | 3 };

/** Projects sharing one coordinator (limit `limit`), each with its engine, under one NEXUS_HOME. */
function world(opts: { limit?: number; clock?: Clock } = {}) {
  const base = mkdtempSync(join(tmpdir(), "nexus-coord-"));
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  const coordinator = new Coordinator({ limit: () => opts.limit ?? 2 });
  const ticks: (() => void)[] = [];
  const engines: Engine[] = [];

  const add = (id: string, queues: Record<string, Spec>) => {
    const root = join(base, id);
    mkdirSync(root, { recursive: true });
    const store = ProjectStore.init(root, { id, name: `Project ${id}`, root, orchestrator: { notify: false } });
    for (const [qid, spec] of Object.entries(queues)) {
      const s = Array.isArray(spec) ? { steps: spec } : spec;
      const steps: StepDef[] = s.steps.map((b, i) => ({ id: `${qid}${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
      const worktree = s.own ? join(base, `${id}-${qid}`) : undefined;
      if (worktree) mkdirSync(worktree, { recursive: true });
      store.writeQueue({
        protocol: 1, id: qid, title: `Queue ${qid}`, revision: 1, status: "proposed", stop_conditions: [], checks: [], steps,
        approvals: [], withdrawals: [], history: [], ...(worktree ? { worktree } : {}), ...(s.level ? { review_level: s.level } : {}),
      });
      approveQueue(store, qid);
    }
    let engine: Engine | undefined;
    // Stands in for the server's file watcher.
    const tick = () => { routeAnswers(store); acceptReviews(store); engine?.onChange(loadProjectState(store)); };
    engine = new Engine(store, tick, { retryBaseMs: 30, usageMarginMs: 100, coordinator, clock: opts.clock });
    ticks.push(tick);
    engines.push(engine);
    const queue = (q: string) => loadProjectState(store).queues.find((x) => x.id === q)!;
    return { store, engine, queue };
  };

  const timer = setInterval(() => { for (const t of ticks) t(); }, 150);
  const until = async (what: string, pred: () => boolean, ms = 30_000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const stop = () => { clearInterval(timer); for (const e of engines) e.shutdown(); delete process.env.FAKE_SLOW_MS; };
  return { coordinator, add, until, stop };
}

/** Marks a queue's steps done as an external worker would, with no engine involved, and accepted. */
function doneByHand(store: ProjectStore, queue: string, steps: string[]): void {
  const session = newId();
  store.writeSession({ protocol: 1, id: session, project: store.readProject().id, role: "worker", runtime: "external", cwd: ".", launched_by: "external", created_at: new Date().toISOString() });
  for (const step of steps) for (const type of ["step.started", "step.done"] as const) {
    store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session, type, queue, step, ...(type === "step.done" ? { summary: "by hand" } : {}) } as Event);
  }
  acceptReviews(store);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const going = (state: string | undefined) => state === "running" || state === "pausing";

test("two queues chained after the same queue in the project's checkout run one after the other, in plan order", async () => {
  process.env.FAKE_SLOW_MS = "1200";
  const w = world();
  const p = w.add("p", { A: ["done"], B: ["slow"], C: ["slow"] });
  try {
    // C's plan is made first: it goes first, though B comes first by name.
    p.engine.chain("C", { after: "A", by: "user" });
    await sleep(10);
    p.engine.chain("B", { after: "A", by: "user" });
    p.engine.start("A");
    await w.until("C to start", () => !!p.queue("C").run);
    assert.equal(p.queue("B").run, undefined, "B waits while C works in the checkout");
    await w.until("B to say why it waits", () => !!p.queue("B").start?.held);
    assert.equal(p.queue("B").start!.waiting, "queue A is done; waits for the checkout: queue C runs there");
    assert.equal(p.queue("B").start!.held!.kind, "checkout");
    assert.equal(p.queue("B").start!.blocked, false);
    await w.until("B to finish", () => p.queue("B").run?.state === "finished", 40_000);
    const b = p.queue("B").run!, c = p.queue("C").run!;
    assert.ok(c.ended_at! <= b.started_at, `B started (${b.started_at}) only after C ended (${c.ended_at})`);
    assert.equal(p.store.readStart("B"), undefined, "the plan is used up");
  } finally { w.stop(); }
});

test("two queues in worktrees of their own run side by side", async () => {
  process.env.FAKE_SLOW_MS = "1500";
  const w = world();
  const p = w.add("p", { A: { steps: ["slow"], own: true }, B: { steps: ["slow"], own: true } });
  try {
    p.engine.start("A");
    p.engine.start("B");
    await w.until("both at work", () => p.queue("A").steps[0]!.status === "running" && p.queue("B").steps[0]!.status === "running");
    await w.until("both to finish", () => p.queue("A").run?.state === "finished" && p.queue("B").run?.state === "finished");
  } finally { w.stop(); }
});

test("a direct start, a resume and a continue in a checkout another queue holds are refused with the reason", async () => {
  process.env.FAKE_SLOW_MS = "2500";
  const w = world();
  const p = w.add("p", { A: ["slow", "done"], B: ["done"], S: ["stop"], H: ["noop"] });
  try {
    // S meets a stop condition, H ends its step twice without an outcome: their runs halt and hold the checkout no more.
    p.engine.start("S");
    await w.until("S to halt", () => p.queue("S").run?.state === "halted");
    p.engine.start("H");
    await w.until("H to halt", () => p.queue("H").run?.state === "halted");
    p.engine.start("A");
    await w.until("A at work", () => p.queue("A").steps[0]!.status === "running");
    assert.throws(() => p.engine.start("B"), /^Error: queue B cannot start: its checkout is in use, queue A runs there$/);
    assert.equal(p.queue("B").run, undefined);
    assert.throws(() => p.engine.continueQueue("S"), /queue S cannot continue: its checkout is in use, queue A runs there/);
    assert.equal(p.queue("S").status, "stopped", "a refused continue leaves the stop as it was");
    assert.throws(() => p.engine.resume("H"), /queue H cannot go on: its checkout is in use, queue A runs there/);
    assert.equal(p.queue("H").run?.state, "halted");
    // A paused run holds its checkout too.
    p.engine.pause("A");
    await w.until("A paused", () => p.queue("A").run?.state === "paused");
    assert.throws(() => p.engine.start("B"), /queue B cannot start: its checkout is in use, queue A is paused there/);
    p.engine.resume("A");
    await w.until("A to finish", () => p.queue("A").run?.state === "finished");
    p.engine.start("B");
    await w.until("B to finish", () => p.queue("B").run?.state === "finished");
  } finally { w.stop(); }
});

test("a third queue over the limit waits and starts when one ends, also across two projects; a direct one is refused", async () => {
  const w = world({ limit: 2 });
  const p = w.add("p", { A: { steps: ["slow"], own: true }, B: { steps: ["slow", "slow"], own: true }, D: { steps: ["done"], own: true } });
  const r = w.add("r", { Z0: ["done"], Z: ["done"] });
  try {
    process.env.FAKE_SLOW_MS = "2000";
    p.engine.start("A");
    p.engine.start("B");
    await w.until("A and B at work", () => going(p.queue("A").run?.state) && going(p.queue("B").run?.state));
    assert.throws(() => p.engine.start("D"), /^Error: queue D cannot start: 2 queues run, the limit is 2$/);
    assert.throws(() => r.engine.start("Z"), /queue Z cannot start: 2 queues run, the limit is 2/, "the limit counts every project's queues");
    // A planned start in the other project waits for a place.
    doneByHand(r.store, "Z0", ["Z01"]);
    assert.equal(r.engine.chain("Z", { after: "Z0", by: "user" }), "queue Z0 is done; queue Z waits: 2 queues run, the limit is 2; it starts by itself then");
    assert.equal(r.queue("Z").start!.waiting, "queue Z0 is done; waits: 2 queues run, the limit is 2");
    assert.equal(r.queue("Z").start!.held!.kind, "limit");
    await w.until("A to finish", () => p.queue("A").run?.state === "finished");
    await w.until("Z to start once A ended", () => !!r.queue("Z").run);
    assert.ok(going(p.queue("B").run?.state), "B was still at work: Z took A's place");
    await w.until("Z to finish", () => r.queue("Z").run?.state === "finished");
  } finally { w.stop(); }
});

test("a queue in review holds its checkout but does not count toward the limit", async () => {
  const w = world({ limit: 1 });
  const p = w.add("p", { R: { steps: ["done", "done"], level: 1 }, B: ["done"], W: { steps: ["done"], own: true } });
  try {
    p.engine.start("R");
    await w.until("R1 in review", () => p.queue("R").steps[0]!.status === "review");
    assert.equal(p.queue("R").run?.state, "running");
    assert.throws(() => p.engine.start("B"), /queue B cannot start: its checkout is in use, queue R runs there/);
    // R counts no more: with a limit of 1, a queue in its own worktree may start.
    p.engine.start("W");
    await w.until("W to finish", () => p.queue("W").run?.state === "finished");
    p.engine.acceptReview("R", "R1");
    await w.until("R2 in review", () => p.queue("R").steps[1]!.status === "review");
  } finally { w.stop(); }
});

test("a schedule waiting for its checkout is not marked missed, and starts once the checkout is free", async () => {
  process.env.FAKE_SLOW_MS = "2500";
  const clock = new TestClock();
  const w = world({ clock });
  const p = w.add("p", { A: ["slow"], B: ["done"] });
  try {
    p.engine.start("A");
    await w.until("A at work", () => p.queue("A").steps[0]!.status === "running");
    p.engine.scheduleStart("B", { at: new Date(clock.now() + MIN).toISOString(), by: "user" });
    clock.advance(MIN);
    await w.until("B to wait for the checkout", () => !!p.queue("B").start?.held);
    assert.equal(p.queue("B").start!.waiting, "waits for the checkout: queue A runs there");
    // Long past its time while it waits: not missed.
    clock.advance(30 * MIN);
    await sleep(400);
    assert.equal(p.queue("B").start!.failed, undefined, "a waiting schedule is never missed");
    await w.until("B to finish once A is done", () => p.queue("B").run?.state === "finished");
    assert.equal(p.store.readStart("B"), undefined);
  } finally { w.stop(); }
});

test("the limit is read from limits.json in NEXUS_HOME, 2 by default", () => {
  process.env.NEXUS_HOME = mkdtempSync(join(tmpdir(), "nexus-limits-"));
  assert.equal(DEFAULT_MAX_RUNNING, 2);
  assert.equal(new Coordinator().limit(), 2);
  writeLimits({ max_running: 3 });
  assert.deepEqual(readLimits(), { max_running: 3 });
  assert.equal(new Coordinator().limit(), 3);
});
