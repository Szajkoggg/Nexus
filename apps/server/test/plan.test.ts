// The plan against the fake runtimes (PROTOCOL.md, "The plan"): several predecessors, approval, only planned queues
// start, a stopped predecessor, the chains of before the plan moved into it, and the orchestrator's part: it builds
// around the user's dependencies, proposes changes to them, and is told the user's answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, acceptPlanProposal, applyDraft, approveQueue, declinePlanProposal, handBackPlan, loadProjectState, newId, routeAnswers,
  type Event, type StepDef,
} from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");

/** Queues by id, each a list of fake behaviours (fake-behaviour.ts); all approved. `orchestrator`: one is set up too. */
function setup(queues: Record<string, string[]>, opts: { orchestrator?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-plan-"));
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
  const tick = () => { routeAnswers(store); acceptReviews(store); const s = loadProjectState(store); orchestrator?.onChange(s); engines.at(-1)!.onChange(s); };
  const newEngine = () => { const e = new Engine(store, tick, { retryBaseMs: 30, usageMarginMs: 100 }); engines.push(e); return e; };
  let engine = newEngine();
  if (opts.orchestrator) orchestrator = new Orchestrator(store, engine, tick);
  const timer = setInterval(tick, 150);
  const queue = (id: string) => loadProjectState(store).queues.find((q) => q.id === id)!;
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; ${Object.keys(queues).map((id) => `${id}: ${queue(id).status} run=${JSON.stringify(queue(id).run?.state)} plan=${JSON.stringify(queue(id).plan?.after)} start=${JSON.stringify(queue(id).start)}`).join("; ")}${orchestrator ? `; chat: ${JSON.stringify(orchestrator.view().chat.slice(-3))}` : ""}`);
  const restart = () => { engine.shutdown(); engine = newEngine(); return engine; };
  const said = (re: RegExp) => !!orchestrator?.view().chat.some((c) => re.test(c.text));
  const say = (...args: string[]) => orchestrator!.say(`FAKE-NEXUS: ${JSON.stringify(args)}`);
  const hello = async () => { orchestrator!.say("Hello"); await until("the orchestrator's session", () => !!orchestrator!.session()); };
  const stop = () => { clearInterval(timer); orchestrator?.shutdown(); for (const e of engines) e.shutdown(); };
  return { store, get engine() { return engine; }, queue, until, restart, said, say, hello, stop };
}

/** An external worker session, for events written by hand. */
function external(store: ProjectStore): string {
  const session = newId();
  store.writeSession({ protocol: 1, id: session, project: "p", role: "worker", runtime: "external", cwd: ".", launched_by: "external", created_at: new Date().toISOString() });
  return session;
}

/** Marks a queue's steps done as an external worker would, with no engine involved, and accepted. */
function doneByHand(store: ProjectStore, queue: string, steps: string[]): void {
  const session = external(store);
  for (const step of steps) for (const type of ["step.started", "step.done"] as const) {
    store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session, type, queue, step, ...(type === "step.done" ? { summary: "by hand" } : {}) } as Event);
  }
  acceptReviews(store);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("two predecessors: C starts only once both are done; the plan stays after the start", async () => {
  const x = setup({ A: ["done"], B: ["done"], C: ["done"] });
  try {
    assert.equal(x.engine.plan("C", { after: ["A", "B"], by: "user" }), "queue C starts when queues A, B are done");
    assert.deepEqual([x.queue("A").starts_next, x.queue("B").starts_next], [["C"], ["C"]]);
    doneByHand(x.store, "A", ["A1"]);
    await sleep(800);
    assert.equal(x.queue("C").run, undefined, "one of two done: C waits");
    assert.equal(x.queue("C").start?.waiting, "queue B has not started yet");
    doneByHand(x.store, "B", ["B1"]);
    await x.until("C to finish", () => x.queue("C").run?.state === "finished", LONGER.run);
    const c = x.queue("C");
    assert.deepEqual(c.run!.after, ["A", "B"]);
    assert.equal(x.store.readStart("C"), undefined, "the planned start is used up");
    assert.deepEqual([c.plan?.used, c.plan?.after.map((e) => [e.queue, e.by])], [true, [["A", "user"], ["B", "user"]]], "the plan stays, used");
    assert.equal(x.queue("A").starts_next, undefined, "a used plan waits for nothing");
  } finally { x.stop(); }
});

test("a planned queue not approved waits for its approval, also when its predecessors are done already", async () => {
  const x = setup({ A: ["done"], C: ["done"] });
  try {
    doneByHand(x.store, "A", ["A1"]);
    const c = x.store.readQueue("C");
    applyDraft(x.store, { id: "C", title: c.title, steps: [...c.steps, { id: "C2", title: "Step 2", goal: "FAKE: done" }] });
    assert.equal(x.engine.plan("C", { after: ["A"], by: "orchestrator" }), "queue A is done; queue C starts once revision 2 is approved");
    await x.until("C held for its approval", () => x.queue("C").start?.held?.kind === "approval");
    assert.equal(x.queue("C").run, undefined);
    approveQueue(x.store, "C");
    await x.until("C to finish", () => x.queue("C").run?.state === "finished", LONGER.run);
  } finally { x.stop(); }
});

test("only a queue in the plan starts by itself: an approved one outside it waits; --next puts one in with none before it", async () => {
  const x = setup({ A: ["done"], B: ["done"], D: ["done"] });
  try {
    doneByHand(x.store, "A", ["A1"]);
    await sleep(800);
    assert.equal(x.queue("B").run, undefined, "approved, not in the plan: it waits");
    assert.match(x.engine.plan("D", { after: [], by: "user" }), /^queue D started now in session /);
    await x.until("D to finish", () => x.queue("D").run?.state === "finished", LONGER.run);
    assert.deepEqual([x.queue("D").plan?.used, x.queue("D").plan?.after], [true, []]);
    assert.equal(x.queue("B").run, undefined);
  } finally { x.stop(); }
});

test("the plan refuses a loop through several predecessors", () => {
  const x = setup({ A: ["done"], B: ["done"], C: ["done"] });
  try {
    x.engine.plan("C", { after: ["A", "B"], by: "user" });
    assert.throws(() => x.engine.plan("B", { after: ["C"], by: "orchestrator" }), /that would be a loop in the plan: B waits for C, C waits for B/);
    assert.throws(() => x.engine.plan("A", { after: ["B", "C"], by: "user" }), /would be a loop in the plan: A waits for C, C waits for A/);
    assert.equal(x.store.readPlan("A"), undefined, "nothing written");
  } finally { x.stop(); }
});

test("a stopped predecessor holds the plan: the user gets an item and the orchestrator a notice; nothing starts", async () => {
  const x = setup({ A: ["done"], B: ["done"] }, { orchestrator: true });
  try {
    await x.hello();
    x.engine.plan("B", { after: ["A"], by: "user" });
    x.store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: external(x.store), type: "queue.stop", queue: "A", step: "A1", condition: "a stop", reason: "by hand" } as Event);
    await x.until("the orchestrator told", () => x.said(/^Queue B waits in the plan, but queue A is stopped: a stop: by hand\.$/));
    const item = loadProjectState(x.store).attention.find((a) => a.kind === "plan");
    assert.deepEqual([item?.queue, item?.plan?.predecessor, item?.plan?.cause], ["B", "A", "stopped"]);
    assert.deepEqual([x.queue("B").start?.blocked, x.queue("B").run], [true, undefined]);
  } finally { x.stop(); }
});

test("the chains of before the plan move into it at the server's start, and fire as before", async () => {
  const x = setup({ A: ["done"], B: ["done"] });
  try {
    x.engine.shutdown();
    x.store.writeStart("B", { protocol: 1, after: "A", by: "orchestrator", reason: "after A", revision: 1, created_at: new Date().toISOString() });
    x.restart();
    assert.deepEqual(x.store.readPlan("B")?.after.map((e) => [e.queue, e.by]), [["A", "orchestrator"]]);
    assert.equal(x.store.readStart("B")?.after, undefined, "start.yaml keeps the start's options only");
    doneByHand(x.store, "A", ["A1"]);
    await x.until("B to finish", () => x.queue("B").run?.state === "finished", LONGER.run);
    assert.deepEqual(x.queue("B").run!.after, ["A"]);
  } finally { x.stop(); }
});

test("the orchestrator cannot change what the user set: it builds around it, proposes, and is told the user's answers", async () => {
  const x = setup({ A: ["noop"], B: ["noop"], C: ["noop"], D: ["noop"] }, { orchestrator: true });
  try {
    await x.hello();
    x.engine.plan("C", { after: ["A"], by: "user" });
    x.engine.plan("D", { after: ["A"], by: "user" });
    x.say("run", "C", "start", "--after", "B", "--reason", "B instead");
    await x.until("the refusal", () => x.said(/queue C waits for A by the user's decision: you may not change that/));
    x.say("run", "C", "cancel-start", "--reason", "not now");
    await x.until("the refusal to take it out", () => x.said(/queue C is in the plan by the user's decision \(it waits for A\): you may not take it out/));
    assert.deepEqual(x.store.readPlan("C")?.after.map((e) => [e.queue, e.by]), [["A", "user"]], "the user's dependency stays");
    // Around it: a predecessor of its own.
    x.say("run", "C", "start", "--after", "A", "--after", "B", "--reason", "B first too");
    await x.until("C after A and B", () => x.store.readPlan("C")?.after.length === 2);
    assert.deepEqual(x.store.readPlan("C")!.after.map((e) => [e.queue, e.by]), [["A", "user"], ["B", "orchestrator"]]);

    // A proposal, declined: the plan stays; the orchestrator is told.
    x.say("plan", "propose", "C", "--after", "B", "--reason", "A is not needed");
    await x.until("the proposal", () => !!x.store.readPlan("C")?.proposal);
    assert.ok(loadProjectState(x.store).attention.some((a) => a.kind === "plan" && a.plan?.proposal?.reason === "A is not needed"));
    declinePlanProposal(x.store, "C");
    await x.until("told of the decline", () => x.said(/^The user declined your proposal for queue C \(after B\)\.$/));
    assert.deepEqual(x.store.readPlan("C")!.after.map((e) => e.queue), ["A", "B"]);

    // Proposed again and accepted: the plan changes; told.
    x.say("plan", "propose", "C", "--after", "B", "--reason", "A is really not needed");
    await x.until("the second proposal", () => x.store.readPlan("C")?.proposal?.reason === "A is really not needed");
    acceptPlanProposal(x.store, "C");
    await x.until("told of the acceptance", () => x.said(/^The user accepted your proposal: queue C starts after B\.$/));
    assert.deepEqual(x.store.readPlan("C")!.after.map((e) => [e.queue, e.by]), [["B", "orchestrator"]]);

    // Handed back: D's dependency is the orchestrator's now, and it changes it freely.
    handBackPlan(x.store, "D", "A");
    await x.until("told of the hand-back", () => x.said(/^The user handed back to you whether queue D waits for A\.$/));
    x.say("run", "D", "start", "--after", "B", "--reason", "B is the one");
    await x.until("D after B", () => x.store.readPlan("D")?.after.map((e) => e.queue).join() === "B");
  } finally { x.stop(); }
});
