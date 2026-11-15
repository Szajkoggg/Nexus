// Recurring queues against the fake runtimes, with a clock the test moves (PROTOCOL.md, "Recurring queues"): a
// recurring approved by the user runs at its times by itself; without the standing approval, after a change (the
// orchestrator's set, a changed shipped or project template) or while its previous run is open it does not; a time
// missed while no server ran passes. The engine's long timers run on the test's clock; the fakes on the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, routeAnswers } from "@nexus/protocol";
import { Engine, type Clock } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { until as waitUntil, LONGER } from "./wait.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A clock that moves only when told; its timers fire in order as it passes them. */
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

/** A template whose one step does what `what` says to the fake ("done", "stop"). */
const template = (id: string, extra = "") => `template:
  id: ${id}
  title: Template ${id}
params:
  - name: what
    description: what the fake does
    default: done
title: "${id}: {{what}}"
steps:
  - id: "{{id}}1"
    title: Step${extra}
    goal: "FAKE: {{what}}"
    size: S
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-recurring-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const shipped = join(root, "shipped");
  mkdirSync(shipped);
  process.env.NEXUS_SHIPPED_TEMPLATES = shipped;
  writeFileSync(join(shipped, "tiny.yaml"), template("tiny"));
  mkdirSync(join(root, "nexus-templates"));
  writeFileSync(join(root, "nexus-templates", "mine.yaml"), template("mine"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const clock = new TestClock();
  const engines: Engine[] = [];
  const tick = () => { routeAnswers(store); acceptReviews(store); engines.at(-1)!.onChange(loadProjectState(store)); };
  const newEngine = () => { const e = new Engine(store, tick, { retryBaseMs: 30, usageMarginMs: 100, startupMs: 20, clock }); engines.push(e); return e; };
  let engine = newEngine();
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const recurring = (id: string) => state().recurring.find((r) => r.id === id)!;
  const runs = (id: string) => state().queues.filter((q) => q.id.startsWith(`${id}-`));
  const until = (what: string, pred: () => boolean, ms = LONGER.run) => waitUntil(what, pred, ms, () => `; recurring: ${JSON.stringify(state().recurring)}; queues: ${state().queues.map((q) => `${q.id} ${q.status}`).join(", ")}`);
  const restart = async () => { engine.shutdown(); engine = newEngine(); await sleep(150); return engine; };
  const stop = () => { clearInterval(timer); for (const e of engines) e.shutdown(); delete process.env.NEXUS_SHIPPED_TEMPLATES; };
  return { root, shipped, store, clock, get engine() { return engine; }, state, recurring, runs, until, restart, stop };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (n: number) => String(n).padStart(2, "0");
/** A time `ms` from the clock's now, on a whole minute, and its local hour and minute as a schedule writes them. */
function ahead(clock: TestClock, ms: number) {
  const at = Math.ceil((clock.now() + ms) / MIN) * MIN;
  const d = new Date(at);
  return { at, d, hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
const idOf = (id: string, d: Date) => `${id}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

test("an approved recurring runs at its time by itself, for each form of the schedule, as a queue approved by the standing approval", async () => {
  for (const form of ["daily", "weekly", "monthly"] as const) {
    const x = setup();
    try {
      const t = ahead(x.clock, 2 * HOUR);
      const every = form === "daily" ? `daily ${t.hhmm}` : form === "weekly" ? `${DAYS[t.d.getDay()]} ${t.hhmm}` : `monthly ${t.d.getDate()} ${t.hhmm}`;
      assert.match(x.engine.setRecurring({ id: "R", template: "tiny", params: {}, every, by: "orchestrator", reason: "test" }), /^recurring R set: template tiny \(nexus\), .*; it waits for the user's approval/);
      assert.equal(x.recurring("R").status, "needs_approval");
      assert.match(x.engine.approveRecurring("R"), /^recurring R approved/);
      assert.equal(x.recurring("R").status, "approved");
      assert.equal(x.recurring("R").next_at, new Date(t.at).toISOString(), form);
      x.clock.advance(t.at - x.clock.now() - MIN);
      await sleep(300);
      assert.deepEqual(x.runs("R"), [], `${form}: a minute early, nothing`);
      x.clock.advance(MIN);
      const id = idOf("R", t.d);
      await x.until(`${form}: ${id} to be done`, () => x.state().queues.find((q) => q.id === id)?.status === "done");
      const q = x.store.readQueue(id);
      assert.equal(q.approvals.length, 1);
      assert.deepEqual(q.approvals[0]!.standing, { id: "R", approved_at: x.store.readRecurring("R")!.approval!.at, hash: x.recurring("R").hash });
      assert.equal(q.title, "tiny: done");
      assert.deepEqual(x.store.readRecurring("R")!.last?.queue, id);
      assert.equal(x.recurring("R").status, "approved");
    } finally { x.stop(); }
  }
});

test("without the standing approval the time passes without a run, and the user is asked for it", async () => {
  const x = setup();
  try {
    const t = ahead(x.clock, HOUR);
    x.engine.setRecurring({ id: "R", template: "tiny", params: {}, every: `daily ${t.hhmm}`, by: "orchestrator" });
    x.clock.advance(t.at - x.clock.now() + MIN);
    await sleep(500);
    assert.deepEqual(x.runs("R"), []);
    assert.equal(x.store.readRecurring("R")!.skipped?.kind, "approval");
    const item = x.state().attention.find((a) => a.kind === "recurring");
    assert.match(item?.text ?? "", /^Recurring R \(Template tiny, daily \d\d:\d\d\) waits for your approval; its run at .* did not start$/);
  } finally { x.stop(); }
});

test("the orchestrator's set after the approval stops the runs until the user approves again; then they go on", async () => {
  const x = setup();
  try {
    const t = ahead(x.clock, HOUR);
    const set = () => x.engine.setRecurring({ id: "R", template: "tiny", params: {}, every: `daily ${t.hhmm}`, by: "orchestrator" });
    set();
    x.engine.approveRecurring("R");
    // The same content again: a set by the orchestrator takes the standing approval away all the same.
    assert.match(set(), /the user's standing approval is taken away: it waits for their approval again/);
    assert.equal(x.recurring("R").status, "needs_approval");
    x.clock.advance(t.at - x.clock.now() + MIN);
    await sleep(500);
    assert.deepEqual(x.runs("R"), [], "no run without the approval");
    x.engine.approveRecurring("R");
    x.clock.advance(DAY);
    const id = idOf("R", new Date(t.at + DAY));
    await x.until(`${id} to be done`, () => x.state().queues.find((q) => q.id === id)?.status === "done");
  } finally { x.stop(); }
});

test("a changed project template, or a changed shipped one, needs the approval again", async () => {
  for (const which of ["project", "shipped"] as const) {
    const x = setup();
    try {
      const t = ahead(x.clock, HOUR);
      const tpl = which === "project" ? "mine" : "tiny";
      x.engine.setRecurring({ id: "R", template: tpl, params: {}, every: `daily ${t.hhmm}`, by: "orchestrator" });
      x.engine.approveRecurring("R");
      const before = x.recurring("R").hash;
      const file = which === "project" ? join(x.root, "nexus-templates", "mine.yaml") : join(x.shipped, "tiny.yaml");
      writeFileSync(file, template(tpl, " (changed)"));
      assert.notEqual(x.recurring("R").hash, before, which);
      assert.equal(x.recurring("R").status, "needs_approval", which);
      x.clock.advance(t.at - x.clock.now() + MIN);
      await sleep(500);
      assert.deepEqual(x.runs("R"), [], `${which}: no run with the changed template`);
      assert.match(x.store.readRecurring("R")!.skipped?.reason ?? "", /changed since your approval/);
    } finally { x.stop(); }
  }
  // A project template of the same id replaces the shipped one: with other content, that changes the hash too.
  const x = setup();
  try {
    x.engine.setRecurring({ id: "R", template: "tiny", params: {}, every: "daily 03:00", by: "orchestrator" });
    x.engine.approveRecurring("R");
    writeFileSync(join(x.root, "nexus-templates", "tiny.yaml"), template("tiny", " (the project's)"));
    assert.equal(x.recurring("R").template_layer, "project");
    assert.equal(x.recurring("R").status, "needs_approval");
  } finally { x.stop(); }
});

test("while the previous run has not closed no new one starts, and the user is told; two runs in a day get their own ids", async () => {
  const x = setup();
  try {
    const t = ahead(x.clock, HOUR);
    x.engine.setRecurring({ id: "R", template: "tiny", params: { what: "stop" }, every: `daily ${t.hhmm}`, by: "orchestrator" });
    x.engine.approveRecurring("R");
    x.clock.advance(t.at - x.clock.now());
    const first = idOf("R", t.d);
    await x.until(`${first} to stop`, () => x.state().queues.find((q) => q.id === first)?.status === "stopped");
    assert.equal(x.recurring("R").status, "waiting_previous");
    x.clock.advance(DAY);
    await sleep(500);
    assert.deepEqual(x.runs("R").map((q) => q.id), [first], "no second run");
    assert.equal(x.store.readRecurring("R")!.skipped?.kind, "previous");
    const item = x.state().attention.find((a) => a.kind === "recurring");
    assert.equal(item?.queue, first);
    assert.match(item?.text ?? "", new RegExp(`^Recurring R did not start at .*: its previous run ${first} is still stopped$`));
    // The stopped run is cancelled (closed): the item goes, and the next time runs. Its schedule moves to later that
    // day: a second run on one day, with an id of its own.
    x.store.writeQueue({ ...x.store.readQueue(first), status: "cancelled" });
    assert.equal(x.state().attention.some((a) => a.kind === "recurring"), false);
    const t2 = ahead(x.clock, 10 * MIN);
    x.engine.setRecurring({ id: "R", template: "tiny", params: {}, every: `daily ${t2.hhmm}`, by: "orchestrator" });
    x.engine.approveRecurring("R");
    x.clock.advance(t2.at - x.clock.now());
    const second = idOf("R", t2.d);
    await x.until(`${second} to be done`, () => x.state().queues.find((q) => q.id === second)?.status === "done");
    assert.notEqual(second, first);
  } finally { x.stop(); }
});

test("a time missed while no server ran passes without a run; one less late than 15 minutes runs", async () => {
  const x = setup();
  try {
    const t = ahead(x.clock, HOUR);
    x.engine.setRecurring({ id: "R", template: "tiny", params: {}, every: `daily ${t.hhmm}`, by: "orchestrator" });
    x.engine.approveRecurring("R");
    x.engine.shutdown();
    x.clock.advance(t.at - x.clock.now() + 20 * MIN);
    await x.restart();
    await sleep(500);
    assert.deepEqual(x.runs("R"), [], "missed");
    assert.equal(x.store.readRecurring("R")!.skipped?.kind, "missed");
    assert.equal(x.recurring("R").next_at, new Date(t.at + DAY).toISOString(), "the next time comes");
    // The next day the server is down at the time, and back 5 minutes later: that one runs.
    x.engine.shutdown();
    x.clock.advance(t.at + DAY - x.clock.now() + 5 * MIN);
    await x.restart();
    const id = idOf("R", new Date(t.at + DAY));
    await x.until(`${id} to be done`, () => x.state().queues.find((q) => q.id === id)?.status === "done");
  } finally { x.stop(); }
});

test("only the user's actions approve, pause and remove; a bad set is refused", () => {
  const x = setup();
  try {
    assert.throws(() => x.engine.setRecurring({ id: "R", template: "nope", params: {}, every: "daily 03:00", by: "orchestrator" }), /no template nope/);
    assert.throws(() => x.engine.setRecurring({ id: "R", template: "tiny", params: {}, every: "weekly 03:00", by: "orchestrator" }), /the schedule is "daily HH:MM"/);
    assert.throws(() => x.engine.setRecurring({ id: "R", template: "tiny", params: { colour: "red" }, every: "daily 03:00", by: "orchestrator" }), /has no parameter colour/);
    assert.throws(() => x.engine.setRecurring({ id: "much-too-long-recurring", template: "tiny", params: {}, every: "daily 03:00", by: "orchestrator" }), /1-16 letters/);
    x.engine.setRecurring({ id: "R", template: "tiny", params: {}, every: "Mon 3:00", by: "orchestrator" });
    assert.equal(x.store.readRecurring("R")!.every, "mon 03:00", "the schedule in its one written form");
    x.engine.approveRecurring("R");
    assert.throws(() => x.engine.approveRecurring("R"), /already approved/);
    assert.match(x.engine.pauseRecurring("R", true), /paused/);
    assert.equal(x.recurring("R").status, "paused");
    assert.match(x.engine.pauseRecurring("R", false), /goes on/);
    assert.match(x.engine.removeRecurring("R"), /removed/);
    assert.deepEqual(x.state().recurring, []);
  } finally { x.stop(); }
});
