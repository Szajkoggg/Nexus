// The plan's single-predecessor case against the fake runtimes: "when queue A is done, start B" (queues/B/plan.yaml;
// the start's options in queues/B/start.yaml). plan.test.ts has several predecessors, ownership and proposals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, newId, routeAnswers, type Event, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER, WORK_MS } from "./wait.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");

/** Queues by id, each a list of fake behaviours (fake-behaviour.ts); all approved. `orchestrator`: one is set up too. */
function setup(queues: Record<string, string[]>, opts: { orchestrator?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-chain-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { notify: !!opts.orchestrator } });
  for (const [id, behaviours] of Object.entries(queues)) {
    const steps: StepDef[] = behaviours.map((b, i) => ({ id: `${id}${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
    store.writeQueue({ protocol: 1, id, title: `Queue ${id}`, revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], withdrawals: [], history: [] });
    approveQueue(store, id);
  }
  const engines: Engine[] = [];
  let orchestrator: Orchestrator | undefined;
  // Stands in for the server's file watcher (and for the server's restart, with `restart`).
  const tick = () => { routeAnswers(store); acceptReviews(store); const s = loadProjectState(store); orchestrator?.onChange(s); engines.at(-1)!.onChange(s); };
  const newEngine = () => { const e = new Engine(store, tick, { retryBaseMs: 30, usageMarginMs: 100 }); engines.push(e); return e; };
  let engine = newEngine();
  if (opts.orchestrator) orchestrator = new Orchestrator(store, engine, tick);
  const timer = setInterval(tick, 150);
  const queue = (id: string) => loadProjectState(store).queues.find((q) => q.id === id)!;
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; ${Object.keys(queues).map((id) => `${id}: ${queue(id).status} run=${JSON.stringify(queue(id).run?.state)} start=${JSON.stringify(queue(id).start)}`).join("; ")}`);
  const restart = () => { engine.shutdown(); engine = newEngine(); return engine; };
  const stop = () => { clearInterval(timer); orchestrator?.shutdown(); for (const e of engines) e.shutdown(); delete process.env.FAKE_SLOW_MS; };
  return { store, get engine() { return engine; }, orchestrator, queue, until, restart, stop };
}

/** Marks a queue's steps done as an external worker would, with no engine involved, and accepted. */
function doneByHand(store: ProjectStore, queue: string, steps: string[]): void {
  const session = newId();
  store.writeSession({ protocol: 1, id: session, project: "p", role: "worker", runtime: "external", cwd: ".", launched_by: "external", created_at: new Date().toISOString() });
  for (const step of steps) for (const type of ["step.started", "step.done"] as const) {
    store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session, type, queue, step, ...(type === "step.done" ? { summary: "by hand" } : {}) } as Event);
  }
  acceptReviews(store);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a chain fires when A is done; it shows on both queues until then; the start uses it up and the plan stays", async () => {
  const x = setup({ A: ["done"], B: ["done"] });
  try {
    assert.equal(x.engine.plan("B", { after: ["A"], by: "user" }), "queue B starts when queue A is done");
    assert.deepEqual([x.queue("B").plan?.after.map((e) => e.queue), x.queue("B").start?.waiting, x.queue("B").start?.blocked], [["A"], "queue A has not started yet", false]);
    assert.deepEqual(x.queue("A").starts_next, ["B"]);
    x.engine.start("A");
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
    const b = x.queue("B");
    assert.deepEqual(b.run!.after, ["A"], "the run records the plan that started it");
    assert.notEqual(b.run!.session, x.queue("A").run!.session, "a new session, as a start without a session to continue");
    assert.equal(x.store.readStart("B"), undefined, "the planned start is used up");
    assert.ok(x.store.readPlan("B")?.started_at, "the plan stays, marked used");
    assert.deepEqual(b.plan?.after.map((e) => [e.queue, e.by]), [["A", "user"]]);
    assert.equal(x.queue("A").starts_next, undefined);
  } finally { x.stop(); }
});

test("a chain does not fire when A halts: it waits and says why", async () => {
  const x = setup({ A: ["noop"], B: ["done"] });
  try {
    x.engine.plan("B", { after: ["A"], by: "user" });
    x.engine.start("A");
    await x.until("A to halt", () => x.queue("A").run?.state === "halted", LONGER.run);
    await sleep(800);
    const b = x.queue("B");
    assert.equal(b.run, undefined, "B did not start");
    assert.equal(b.start?.blocked, true);
    assert.match(b.start!.waiting, /^the run of A halted: step A1 ended twice without an outcome/);
    assert.ok(!loadProjectState(x.store).attention.some((a) => a.kind === "start"), "a waiting chain is not an item of its own");
  } finally { x.stop(); }
});

test("a chain set after A is done starts B now", async () => {
  const x = setup({ A: ["done"], B: ["done"] });
  try {
    x.engine.start("A");
    await x.until("A to finish", () => x.queue("A").run?.state === "finished", LONGER.run);
    assert.match(x.engine.plan("B", { after: ["A"], by: "user" }), /^queue A is done: queue B started now in session /);
    assert.equal(x.store.readStart("B"), undefined, "nothing left planned");
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
  } finally { x.stop(); }
});

test("the orchestrator chains B with --use-session of A's session: B starts in that session when A finishes", async () => {
  process.env.FAKE_SLOW_MS = WORK_MS;
  const x = setup({ A: ["slow"], B: ["done"] }, { orchestrator: true });
  try {
    x.engine.start("A");
    const session = x.queue("A").run!.session;
    x.orchestrator!.say(`FAKE-NEXUS: ["run","B","start","--after","A","--use-session","${session}","--reason","B builds on A's context"]`);
    await x.until("the plan", () => !!x.queue("B").start);
    const plan = x.queue("B").start!;
    assert.deepEqual([x.queue("B").plan?.after.map((e) => [e.queue, e.by]), plan.session, plan.by, plan.reason], [[["A", "orchestrator"]], session, "orchestrator", "B builds on A's context"]);
    assert.equal(x.queue("A").run?.state, "running", "set while A runs");
    // The orchestrator reviews each step (level 2, the project's default).
    for (const [q, st] of [["A", "A1"], ["B", "B1"]] as const) {
      await x.until(`${st} in the orchestrator's review`, () => x.queue(q).steps[0]!.review_with === "orchestrator", LONGER.step);
      x.orchestrator!.say(`FAKE-NEXUS: ["review","accept","${q}","${st}"]`);
    }
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
    assert.equal(x.queue("B").run!.session, session, "B ran in A's session");
    assert.equal(x.queue("B").steps[0]!.session, session);
  } finally { x.stop(); }
});

test("a chain whose session is busy waits for it to free: one session never runs two queues", async () => {
  process.env.FAKE_SLOW_MS = WORK_MS;
  const x = setup({ A: ["done"], B: ["done"], C: ["slow"] });
  try {
    doneByHand(x.store, "A", ["A1"]);
    x.engine.start("C");
    const session = x.queue("C").run!.session;
    await x.until("C to work", () => x.queue("C").steps[0]!.status === "running", LONGER.step);
    assert.match(x.engine.plan("B", { after: ["A"], session, by: "user" }), /^queue B starts when session \S+ is free \(it runs queue C; queue A is done\)$/);
    assert.equal(x.queue("B").start!.waiting, `queue A is done; the session to continue is running queue C`);
    await sleep(500);
    assert.equal(x.queue("B").run, undefined, "not while C runs in the session");
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
    assert.equal(x.queue("B").run!.session, session);
    assert.ok(x.queue("C").run!.ended_at! <= x.queue("B").run!.started_at, "B started after C ended");
  } finally { x.stop(); }
});

test("a planned queue no longer approved waits for its approval when A is done, and starts once approved", async () => {
  const x = setup({ A: ["done"], B: ["done"] });
  try {
    x.engine.plan("B", { after: ["A"], by: "user" });
    // A new revision of B, not approved.
    const b = x.store.readQueue("B");
    applyDraft(x.store, { id: "B", title: b.title, steps: [...b.steps, { id: "B2", title: "Step 2", goal: "FAKE: done" }] });
    assert.equal(x.queue("B").approved, false);
    assert.equal(x.queue("B").start?.waiting, "needs approval of revision 2; queue A has not started yet");
    x.engine.start("A");
    await x.until("B held for its approval", () => x.queue("B").start?.held?.kind === "approval", LONGER.run);
    assert.deepEqual([x.queue("B").run, x.queue("B").start?.failed, x.queue("B").start?.waiting], [undefined, undefined, "queue A is done; waits for approval of revision 2"]);
    assert.ok(!loadProjectState(x.store).attention.some((a) => a.kind === "start"), "waiting for an approval is no failed start");
    await sleep(500);
    assert.equal(x.queue("B").run, undefined, "not before the approval");
    approveQueue(x.store, "B");
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
  } finally { x.stop(); }
});

test("a planned start that fails (the queue stopped) is an item for the user; cancelling clears it", async () => {
  const x = setup({ A: ["done"], B: ["done"] });
  try {
    x.engine.plan("B", { after: ["A"], by: "user" });
    // B is stopped (as an imported stopped queue): it cannot start when A is done.
    const session = newId();
    x.store.writeSession({ protocol: 1, id: session, project: "p", role: "worker", runtime: "external", cwd: ".", launched_by: "external", created_at: new Date().toISOString() });
    x.store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session, type: "queue.stop", queue: "B", step: "B1", condition: "a stop", reason: "by hand" } as Event);
    assert.equal(x.queue("B").status, "stopped");
    doneByHand(x.store, "A", ["A1"]);
    await x.until("the failed plan", () => !!x.queue("B").start?.failed);
    const item = loadProjectState(x.store).attention.find((a) => a.kind === "start");
    assert.ok(item);
    assert.match(item.text, /^Did not start after A: /);
    await sleep(500);
    assert.equal(x.queue("B").run, undefined, "a failed plan is not tried again by itself");
    x.engine.cancelStart("B");
    assert.equal(x.store.readStart("B"), undefined);
    assert.equal(x.store.readPlan("B"), undefined, "out of the plan");
    assert.ok(!loadProjectState(x.store).attention.some((a) => a.kind === "start"));
  } finally { x.stop(); }
});

test("a cancelled chain does not fire", async () => {
  const x = setup({ A: ["done"], B: ["done"] });
  try {
    x.engine.plan("B", { after: ["A"], by: "user" });
    assert.match(x.engine.cancelStart("B"), /cancelled/);
    assert.throws(() => x.engine.cancelStart("B"), /no planned start/);
    x.engine.start("A");
    await x.until("A to finish", () => x.queue("A").run?.state === "finished", LONGER.run);
    await sleep(800);
    assert.equal(x.queue("B").run, undefined);
  } finally { x.stop(); }
});

test("a chain survives a restart, and fires when the server comes up with A done", async () => {
  const x = setup({ A: ["done"], B: ["done"] });
  try {
    x.engine.plan("B", { after: ["A"], by: "orchestrator", reason: "after A" });
    x.engine.shutdown();
    doneByHand(x.store, "A", ["A1"]); // done while no server ran
    x.restart();
    assert.deepEqual(x.store.readPlan("B")?.after.map((e) => e.queue), ["A"]);
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
    assert.deepEqual(x.queue("B").run!.after, ["A"]);
  } finally { x.stop(); }
});

test("no chain starts while an update drains; it starts when the drain is over", async () => {
  const x = setup({ A: ["done"], B: ["done"] });
  try {
    x.engine.drainForUpdate(false);
    doneByHand(x.store, "A", ["A1"]);
    assert.match(x.engine.plan("B", { after: ["A"], by: "user" }), /starts after the Nexus update/);
    await sleep(800);
    assert.equal(x.queue("B").run, undefined, "not while draining");
    x.engine.cancelDrain();
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
  } finally { x.stop(); }
});

test("a chain is refused for itself, a loop, a done queue and an effort the runtime does not take", () => {
  const x = setup({ A: ["done"], B: ["done"], C: ["done"] });
  try {
    assert.throws(() => x.engine.plan("A", { after: ["A"], by: "user" }), /cannot start after itself/);
    x.engine.plan("B", { after: ["A"], by: "user" });
    x.engine.plan("C", { after: ["B"], by: "user" });
    assert.throws(() => x.engine.plan("A", { after: ["C"], by: "user" }), /would be a loop/);
    assert.throws(() => x.engine.plan("B", { after: ["Z"], by: "user" }), /unknown queue Z/);
    assert.throws(() => x.engine.plan("B", { after: ["A"], runtime: "claude", effort: "ultra", by: "user" }), /Claude Code takes effort/);
    doneByHand(x.store, "C", ["C1"]);
    assert.throws(() => x.engine.plan("C", { after: ["A"], by: "user" }), /queue C is done/);
  } finally { x.stop(); }
});
