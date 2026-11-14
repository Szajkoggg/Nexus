// Schedules against the fake runtimes, with a clock the test moves: "start queue B at a time", or "when the usage
// window resets" (queues/B/start.yaml with `at`). The engine's long timers run on that clock; everything else (the
// fakes, the files' own times) on the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, formatClock, loadProjectState, routeAnswers, writeUsage, type StepDef } from "@nexus/protocol";
import { Engine, MAX_TIMER_MS, type Clock } from "../src/engine.ts";
import { MISSED_MS } from "../src/scheduler.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** A clock that moves only when told; its timers fire in order as it passes them. */
class TestClock implements Clock {
  t = Date.now();
  private timers: { at: number; ms: number; fn: () => void }[] = [];
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const h = { at: this.t + ms, ms, fn }; this.timers.push(h); return h; }
  clearTimeout(h: unknown) { this.timers = this.timers.filter((x) => x !== h); }
  /** The delays of the timers armed now. */
  pending() { return this.timers.map((x) => x.ms); }
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

function setup(queues: Record<string, string[]>, opts: { orchestrator?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-schedule-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { notify: !!opts.orchestrator } });
  for (const [id, behaviours] of Object.entries(queues)) {
    const steps: StepDef[] = behaviours.map((b, i) => ({ id: `${id}${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
    store.writeQueue({ protocol: 1, id, title: `Queue ${id}`, revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], withdrawals: [], history: [] });
    approveQueue(store, id);
  }
  const clock = new TestClock();
  const engines: Engine[] = [];
  let orchestrator: Orchestrator | undefined;
  const tick = () => { routeAnswers(store); acceptReviews(store); const s = loadProjectState(store); orchestrator?.onChange(s); engines.at(-1)!.onChange(s); };
  const newEngine = () => { const e = new Engine(store, tick, { retryBaseMs: 30, usageMarginMs: 100, clock }); engines.push(e); return e; };
  let engine = newEngine();
  if (opts.orchestrator) orchestrator = new Orchestrator(store, engine, tick);
  const timer = setInterval(tick, 150);
  const queue = (id: string) => loadProjectState(store).queues.find((q) => q.id === id)!;
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; ${Object.keys(queues).map((id) => `${id}: ${queue(id).status} run=${JSON.stringify(queue(id).run?.state)} start=${JSON.stringify(queue(id).start)}`).join("; ")}`);
  const restart = () => { engine.shutdown(); engine = newEngine(); return engine; };
  const stop = () => { clearInterval(timer); orchestrator?.shutdown(); for (const e of engines) e.shutdown(); delete process.env.FAKE_SLOW_MS; };
  return { store, clock, get engine() { return engine; }, orchestrator, queue, until, restart, stop };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();

test("a schedule fires at its time, not before; the plan shows its time until then", async () => {
  const x = setup({ B: ["done"] });
  try {
    const at = x.clock.now() + 2 * HOUR;
    assert.equal(x.engine.scheduleStart("B", { at: iso(at), by: "user" }), `queue B starts at ${formatClock(iso(at), new Date(x.clock.now()))}`);
    assert.deepEqual([x.queue("B").start?.at, x.queue("B").start?.waiting], [iso(at), "its time"]);
    x.clock.advance(2 * HOUR - MIN);
    await sleep(300);
    assert.equal(x.queue("B").run, undefined, "a minute early: nothing");
    x.clock.advance(MIN);
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
    assert.equal(x.store.readStart("B"), undefined, "the plan is used up");
  } finally { x.stop(); }
});

test("usage-reset is refused without usage data, and fires after the window resets", async () => {
  const x = setup({ B: ["done"] });
  try {
    assert.throws(() => x.engine.scheduleStart("B", { at: "usage-reset", by: "user" }), /no usage window of Claude Code is known yet/);
    const reset = x.clock.now() + 3 * HOUR;
    writeUsage({ updated_at: iso(x.clock.now()), windows: { five_hour: { utilization: 0.97, resets_at: iso(reset) }, codex_7d: { utilization: 0.2, resets_at: iso(reset + DAY) } } });
    // Codex's window here is below the pause threshold: its first reset is the one.
    x.engine.scheduleStart("B", { at: "usage-reset", runtime: "codex", by: "user" });
    assert.deepEqual([x.queue("B").start!.usage, x.queue("B").start!.at], ["codex", iso(reset + DAY + 100)]);
    x.engine.cancelStart("B");
    assert.match(x.engine.scheduleStart("B", { at: "usage-reset", by: "user" }), /when the Claude Code usage window resets/);
    const plan = x.queue("B").start!;
    assert.deepEqual([plan.usage, plan.at], ["claude", iso(reset + 100)], "the reset plus the usage margin");
    x.clock.advance(3 * HOUR);
    await sleep(300);
    assert.equal(x.queue("B").run, undefined, "not before the margin has passed");
    x.clock.advance(1000);
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
  } finally { x.stop(); }
});

test("a schedule 30 days ahead is armed in pieces of at most a day and does not fire early", async () => {
  const x = setup({ B: ["done"] });
  try {
    x.engine.scheduleStart("B", { at: iso(x.clock.now() + 30 * DAY), by: "user" });
    for (let d = 0; d < 29; d++) {
      assert.ok(x.clock.pending().every((ms) => ms <= MAX_TIMER_MS), `day ${d}: ${x.clock.pending()}`);
      x.clock.advance(DAY);
    }
    await sleep(300);
    assert.equal(x.queue("B").run, undefined, "after 29 days: nothing");
    x.clock.advance(DAY);
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
  } finally { x.stop(); }
});

test("a usage wait weeks ahead is armed in pieces too, and does not resume early", async () => {
  const x = setup({ B: ["done"] });
  try {
    x.engine.shutdown();
    // A run waiting for a window that resets in 30 days (a weekly window can reset weeks later than 2^31 ms allows).
    const session = "01SESSIONWAITINGFORUSAGE0";
    x.store.writeSession({ protocol: 1, id: session, project: "p", role: "worker", runtime: "claude", native_id: "00000000-0000-4000-8000-000000000009", cwd: ".", launched_by: "nexus", created_at: iso(Date.now()) });
    x.store.writeRun("B", { protocol: 1, session, state: "usage_wait", reason: "the 5-hour window is full", resume_at: iso(x.clock.now() + 30 * DAY), started_at: iso(Date.now()), updated_at: iso(Date.now()) });
    x.restart();
    assert.ok(x.clock.pending().length > 0 && x.clock.pending().every((ms) => ms <= MAX_TIMER_MS), String(x.clock.pending()));
    x.clock.advance(29 * DAY);
    await sleep(300);
    assert.equal(x.queue("B").run?.state, "usage_wait", "still waiting after 29 days");
  } finally { x.stop(); }
});

test("a schedule missed while the server was down gives an item and the orchestrator is told; a few minutes late still starts", async () => {
  const x = setup({ B: ["done"], C: ["done"] }, { orchestrator: true });
  try {
    // The project's orchestrator session exists (it is told only what happens after its session began).
    x.orchestrator!.say("hello");
    await x.until("the orchestrator's reply", () => x.orchestrator!.view().chat.some((c) => c.from === "orchestrator"));
    x.engine.shutdown();
    const missed = x.clock.now() - HOUR, late = x.clock.now() - 5 * MIN;
    for (const [q, at] of [["B", missed], ["C", late]] as const) {
      x.store.writeStart(q, { protocol: 1, at: iso(at), by: "user", revision: 1, created_at: iso(at - DAY) });
    }
    x.restart();
    await x.until("the missed plan", () => !!x.queue("B").start?.failed);
    assert.equal(x.queue("B").start!.failed!.missed, true);
    assert.equal(x.queue("B").run, undefined, "a missed schedule does not start");
    const item = loadProjectState(x.store).attention.find((a) => a.kind === "start" && a.queue === "B");
    assert.equal(item?.text, `Did not start at ${formatClock(iso(missed), new Date())}: missed: Nexus was not running at ${formatClock(iso(missed), new Date(x.clock.now()))}`);
    await x.until("C1 in the orchestrator's review", () => x.queue("C").steps[0]!.review_with === "orchestrator", LONGER.step);
    x.orchestrator!.say(`FAKE-NEXUS: ["review","accept","C","C1"]`);
    await x.until("C, 5 minutes late, to finish", () => x.queue("C").run?.state === "finished", LONGER.run);
    await x.until("the orchestrator to be told", () => x.orchestrator!.view().chat.some((c) => c.from === "nexus" && /scheduled start of queue B .* was missed/.test(c.text)));
  } finally { x.stop(); }
});

test("a schedule whose session is busy does not start: the user gets an item; one no longer approved waits for its approval", async () => {
  process.env.FAKE_SLOW_MS = "4000";
  const x = setup({ B: ["done"], C: ["done"], D: ["slow"] });
  try {
    x.engine.start("D");
    const busy = x.queue("D").run!.session;
    await x.until("D to work", () => x.queue("D").steps[0]!.status === "running", LONGER.step);
    const at = x.clock.now() + HOUR;
    x.engine.scheduleStart("B", { at: iso(at), by: "user" });
    x.engine.scheduleStart("C", { at: iso(at), session: busy, by: "user" });
    const b = x.store.readQueue("B");
    applyDraft(x.store, { id: "B", title: b.title, steps: [...b.steps, { id: "B2", title: "Step 2", goal: "FAKE: done" }] });
    x.clock.advance(HOUR);
    // C fails at once (its session is busy); B waits for its approval (never missed, however long it waits).
    await x.until("C to fail and B to wait", () => !!x.queue("C").start?.failed && x.queue("B").start?.held?.kind === "approval");
    assert.equal(x.queue("C").start!.failed!.reason, `session ${busy} was running queue D`);
    assert.deepEqual([x.queue("B").start!.failed, x.queue("B").start!.waiting], [undefined, "waits for approval of revision 2"]);
    assert.equal(x.queue("C").run, undefined);
    const items = loadProjectState(x.store).attention.filter((a) => a.kind === "start").map((a) => a.queue).sort();
    assert.deepEqual(items, ["C"]);
    x.clock.advance(MISSED_MS + 60_000);
    approveQueue(x.store, "B");
    // Approved, B waits for the checkout D holds for FAKE_SLOW_MS (4 s), then starts by itself.
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", Number(process.env.FAKE_SLOW_MS) + LONGER.run);
  } finally { x.stop(); }
});

test("a restart arms the schedules again; a cancelled one stays cancelled", async () => {
  const x = setup({ B: ["done"], C: ["done"] });
  try {
    const at = x.clock.now() + 3 * HOUR;
    x.engine.scheduleStart("B", { at: iso(at), by: "user" });
    x.engine.scheduleStart("C", { at: iso(at), by: "user" });
    x.engine.cancelStart("C");
    x.restart();
    assert.equal(x.clock.pending().filter((ms) => ms === 3 * HOUR).length, 1, "one schedule armed again");
    x.clock.advance(3 * HOUR);
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
    await sleep(500);
    assert.equal(x.queue("C").run, undefined);
  } finally { x.stop(); }
});

test("the orchestrator schedules with nexus run --at in local time, or usage-reset; bad values are refused", async () => {
  const x = setup({ B: ["done"], C: ["done"] }, { orchestrator: true });
  try {
    const when = new Date(x.clock.now() + 2 * DAY);
    when.setSeconds(0, 0);
    const local = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    x.orchestrator!.say(`FAKE-NEXUS: ["run","B","start","--at","${local}","--reason","overnight"]`);
    await x.until("the plan", () => !!x.queue("B").start);
    assert.deepEqual([x.queue("B").start!.at, x.queue("B").start!.by], [when.toISOString(), "orchestrator"]);
    x.orchestrator!.say(`FAKE-NEXUS: ["run","C","start","--at","usage-reset","--reason","when the window resets"]`);
    await x.until("the refusal", () => x.orchestrator!.view().chat.some((c) => /no usage window of Claude Code is known yet/.test(c.text)));
    x.orchestrator!.say(`FAKE-NEXUS: ["run","C","start","--at","tomorrow","--reason","x"]`);
    await x.until("the usage error", () => x.orchestrator!.view().chat.some((c) => /--at takes "YYYY-MM-DD HH:MM"/.test(c.text)));
  } finally { x.stop(); }
});
