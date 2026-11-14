// The plan's rules (plan.ts): several predecessors and how each stands, the loop check, who may change what, the
// orchestrator's proposals and the user's answers, and the move of the chains from before the plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionError, ProjectStore, acceptPlanProposal, approveQueue, declinePlanProposal, handBackPlan, inPlan, loadProjectState,
  newId, newPlan, now, planLoop, proposePlan, checkPredecessors, type Event, type PlanFile,
} from "../src/index.ts";

function setup(ids: string[]) {
  const root = mkdtempSync(join(tmpdir(), "nexus-plan-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  for (const id of ids) {
    st.writeQueue({
      protocol: 1, id, title: `Queue ${id}`, revision: 1, status: "proposed", stop_conditions: [], checks: [],
      steps: [{ id: `${id}1`, title: "One", goal: "", acceptance: [] }], approvals: [], withdrawals: [], history: [],
    });
    approveQueue(st, id);
  }
  const session = newId();
  const orchestrator = newId();
  st.writeSession({ protocol: 1, id: session, project: "p", role: "worker", runtime: "external", cwd: root, launched_by: "external", created_at: now() });
  st.writeSession({ protocol: 1, id: orchestrator, project: "p", role: "orchestrator", runtime: "external", cwd: root, launched_by: "external", created_at: now() });
  const emit = (body: Record<string, unknown>, by = session) => st.appendEvent({ v: 1, id: newId(), at: now(), session: by, ...body } as Event);
  /** Marks a queue's step done as a worker would, and accepted by the orchestrator (or `provisional`ly). */
  const done = (id: string, provisional = false) => {
    emit({ type: "step.started", queue: id, step: `${id}1` });
    emit({ type: "step.done", queue: id, step: `${id}1`, summary: "ok" });
    emit({ type: provisional ? "review.provisional" : "review.accepted", queue: id, step: `${id}1`, ...(provisional ? { text: "the look" } : {}) }, orchestrator);
  };
  const queue = (id: string) => loadProjectState(st).queues.find((q) => q.id === id)!;
  /** Writes a plan as the server would: `entries` by who set each. */
  const plan = (id: string, entries: [string, "user" | "orchestrator"][], by: "user" | "orchestrator" = "user"): PlanFile => {
    const p: PlanFile = { protocol: 1, by, created_at: now(), updated_at: now(), after: entries.map(([queue, b]) => ({ queue, by: b, at: now() })), decisions: [] };
    st.writePlan(id, p);
    return p;
  };
  return { st, emit, done, queue, plan };
}

const refused = (re: RegExp) => (e: unknown) => e instanceof ActionError && re.test(e.message);

test("two predecessors: the plan is ready only when both are done; each says how it stands", () => {
  const x = setup(["A", "B", "C"]);
  x.plan("C", [["A", "user"], ["B", "orchestrator"]]);
  let c = x.queue("C").plan!;
  assert.deepEqual([c.ready, c.used, c.blocked, c.waiting], [false, false, false, "queue A has not started yet; queue B has not started yet"]);
  assert.deepEqual(x.queue("A").starts_next, ["C"]);
  x.done("A");
  c = x.queue("C").plan!;
  assert.deepEqual(c.after.map((e) => [e.queue, e.done]), [["A", true], ["B", false]]);
  assert.equal(c.ready, false, "one of two done");
  assert.equal(c.waiting, "queue B has not started yet");
  x.done("B");
  c = x.queue("C").plan!;
  assert.deepEqual([c.ready, c.waiting], [true, ""]);
  assert.equal(x.queue("C").start, undefined, "a plan needs no start.yaml");
  assert.equal(inPlan(x.queue("C")), true);
});

test("a queue not approved is in the plan and says it needs approval; a queue not planned is not in it", () => {
  const x = setup(["A", "B", "D"]);
  x.plan("B", [["A", "user"]]);
  const b = x.st.readQueue("B");
  x.st.writeQueue({ ...b, revision: 2, steps: [...b.steps, { id: "B2", title: "Two", goal: "", acceptance: [] }] });
  x.done("A");
  const p = x.queue("B").plan!;
  assert.deepEqual([p.ready, p.approval, p.waiting], [true, true, "needs approval of revision 2"]);
  assert.equal(inPlan(x.queue("D")), false, "approved, but not in the plan");
});

test("a provisional step not confirmed holds the plan where provisional work does not count", () => {
  const x = setup(["A", "B"]);
  x.plan("B", [["A", "user"]]);
  x.st.writeQueue({ ...x.st.readQueue("A"), review_level: 3 }); // the review level asks for no new approval
  x.done("A", true);
  assert.equal(x.queue("A").status, "done");
  assert.ok(x.queue("A").steps[0]!.provisional, "accepted provisionally");
  assert.equal(x.queue("B").plan!.ready, true, "provisional work counts by default");
  x.st.writeProject({ ...x.st.readProject(), defaults: { ...x.st.readProject().defaults, provisional_counts: false } });
  const p = x.queue("B").plan!;
  assert.equal(p.ready, false);
  assert.match(p.waiting, /^queue A is done; its provisional work waits for the user's confirmation \(A1\)$/);
});

test("a stopped, cancelled or missing predecessor holds the plan: blocked, with an item for the user", () => {
  const x = setup(["A", "B", "C"]);
  x.plan("C", [["A", "user"], ["B", "orchestrator"], ["Z", "orchestrator"]]);
  x.emit({ type: "queue.stop", queue: "A", step: "A1", condition: "a stop", reason: "by hand" });
  const c = x.queue("C").plan!;
  assert.equal(c.blocked, true);
  assert.deepEqual(c.after.map((e) => e.cause), ["stopped", undefined, "missing"]);
  const items = loadProjectState(x.st).attention.filter((a) => a.kind === "plan");
  assert.deepEqual(items.map((a) => [a.queue, a.plan?.predecessor, a.plan?.cause]), [["C", "A", "stopped"], ["C", "Z", "missing"]]);
  assert.match(items[0]!.text, /^Queue C waits, but queue A is stopped: a stop: by hand$/);
});

test("the loop check follows every predecessor: a loop through several is refused", () => {
  const x = setup(["A", "B", "C", "D"]);
  x.plan("C", [["A", "user"], ["B", "user"]]);
  x.plan("D", [["C", "orchestrator"]]);
  const state = loadProjectState(x.st);
  assert.deepEqual(planLoop(new Map([["C", ["A", "B"]], ["D", ["C"]]]), "B", ["D"]), ["B", "D", "C", "B"]);
  assert.throws(() => checkPredecessors(state, "B", ["A", "D"]), refused(/that would be a loop in the plan: B waits for D, D waits for C, C waits for B/));
  assert.throws(() => checkPredecessors(state, "B", ["B"]), refused(/cannot start after itself/));
  assert.throws(() => checkPredecessors(state, "B", ["Z"]), refused(/unknown queue Z/));
  assert.deepEqual(checkPredecessors(state, "D", ["A", "A", "B"]), ["A", "B"], "repeats go");
});

test("the orchestrator may not drop or change a dependency the user set; it builds around it; the user's list is theirs", () => {
  const x = setup(["A", "B", "C"]);
  const old = x.plan("C", [["A", "user"]]);
  assert.throws(() => newPlan(old, "C", ["B"], { by: "orchestrator" }), refused(/queue C waits for A by the user's decision: you may not change that; keep it \(--after A\), or propose the change to the user: nexus plan propose C --after B --reason/));
  const around = newPlan(old, "C", ["A", "B"], { by: "orchestrator", reason: "B first" });
  assert.deepEqual(around.after.map((e) => [e.queue, e.by]), [["A", "user"], ["B", "orchestrator"]]);
  assert.equal(around.by, "user", "put into the plan by the user");
  const mine = newPlan(around, "C", ["B"], { by: "user" });
  assert.deepEqual(mine.after.map((e) => [e.queue, e.by]), [["B", "user"]], "the user's list replaces it all, and is theirs");
  // A used plan (the queue started since) is history: a new plan starts afresh.
  const used = newPlan({ ...old, started_at: now() }, "C", ["B"], { by: "orchestrator" });
  assert.deepEqual([used.after.map((e) => [e.queue, e.by]), used.by, used.started_at], [[["B", "orchestrator"]], "orchestrator", undefined]);
});

test("a proposal: refused when it changes nothing of the user's; accepted, it becomes the plan; the user's entries stay theirs", () => {
  const x = setup(["A", "B", "C"]);
  x.plan("C", [["A", "user"], ["B", "orchestrator"]]);
  assert.throws(() => proposePlan(x.st, "C", ["A"], "drop B"), refused(/changes no dependency the user set: set it yourself with nexus run C start --after A/));
  assert.match(proposePlan(x.st, "C", ["B"], "A is not needed"), /^proposed to the user: queue C after B/);
  const item = loadProjectState(x.st).attention.find((a) => a.kind === "plan")!;
  assert.deepEqual(item.plan?.proposal, { after: ["B"], reason: "A is not needed", current: ["A", "B"] });
  assert.equal(item.text, "The orchestrator proposes queue C after B instead of after A, B: A is not needed");
  assert.equal(acceptPlanProposal(x.st, "C"), "queue C now starts after B");
  const p = x.st.readPlan("C")!;
  assert.deepEqual(p.after.map((e) => [e.queue, e.by]), [["B", "orchestrator"]]);
  assert.equal(p.proposal, undefined);
  assert.deepEqual(p.decisions.map((d) => [d.kind, d.after]), [["accepted", ["B"]]]);
  assert.ok(!loadProjectState(x.st).attention.some((a) => a.kind === "plan"));
  assert.throws(() => acceptPlanProposal(x.st, "C"), refused(/no proposal to decide/));
});

test("a proposal declined leaves the plan as the user set it; a new entry the user accepts is the orchestrator's", () => {
  const x = setup(["A", "B", "C"]);
  x.plan("C", [["A", "user"]]);
  proposePlan(x.st, "C", ["B"], "B is better");
  assert.match(declinePlanProposal(x.st, "C"), /declined; it still starts after A$/);
  let p = x.st.readPlan("C")!;
  assert.deepEqual([p.after.map((e) => [e.queue, e.by]), p.proposal, p.decisions.map((d) => d.kind)], [[["A", "user"]], undefined, ["declined"]]);
  proposePlan(x.st, "C", ["A", "B"].filter((q) => q !== "A"), "B again");
  acceptPlanProposal(x.st, "C");
  p = x.st.readPlan("C")!;
  assert.deepEqual(p.after.map((e) => [e.queue, e.by, e.reason]), [["B", "orchestrator", "B again"]]);
});

test("handing back: the user's dependency becomes the orchestrator's; a proposal it settles goes", () => {
  const x = setup(["A", "B", "C"]);
  x.plan("C", [["A", "user"], ["B", "user"]]);
  proposePlan(x.st, "C", ["B"], "A is not needed");
  assert.equal(handBackPlan(x.st, "C", "A"), "the orchestrator decides now whether queue C waits for A");
  let p = x.st.readPlan("C")!;
  assert.deepEqual(p.after.map((e) => [e.queue, e.by]), [["A", "orchestrator"], ["B", "user"]]);
  assert.equal(p.proposal, undefined, "the orchestrator may drop A itself now");
  assert.equal(p.by, "user", "B is still the user's");
  assert.deepEqual(newPlan(p, "C", ["B"], { by: "orchestrator" }).after.map((e) => e.queue), ["B"], "the orchestrator changes it freely");
  assert.throws(() => handBackPlan(x.st, "C", "A"), refused(/does not wait for A by your decision/));
  handBackPlan(x.st, "C");
  p = x.st.readPlan("C")!;
  assert.deepEqual([p.after.map((e) => e.by), p.by, p.decisions.map((d) => [d.kind, d.queues])], [["orchestrator", "orchestrator"], "orchestrator", [["handed_back", ["A"]], ["handed_back", ["B"]]]]);
  // A queue the user put into the plan with none before it: its place is handed back.
  x.plan("B", [], "user");
  assert.equal(handBackPlan(x.st, "B"), "the orchestrator decides now when queue B starts");
  assert.equal(x.st.readPlan("B")!.by, "orchestrator");
});

test("the chains from before the plan: read as a plan at once, and moved into plan.yaml by the server", () => {
  const x = setup(["A", "B"]);
  x.st.writeStart("B", { protocol: 1, after: "A", model: "m", by: "orchestrator", reason: "after A", revision: 1, created_at: "2026-11-01T10:00:00.000Z" });
  const before = x.queue("B");
  assert.deepEqual([before.plan?.after.map((e) => [e.queue, e.by]), before.start?.after, before.start?.model], [[["A", "orchestrator"]], undefined, "m"]);
  assert.deepEqual(x.st.migrateChains(), ["B"]);
  const plan = x.st.readPlan("B")!;
  assert.deepEqual([plan.by, plan.reason, plan.created_at, plan.after], ["orchestrator", "after A", "2026-11-01T10:00:00.000Z", [{ queue: "A", by: "orchestrator", at: "2026-11-01T10:00:00.000Z", reason: "after A" }]]);
  const start = x.st.readStart("B")!;
  assert.deepEqual([start.after, start.model, start.by], [undefined, "m", "orchestrator"]);
  assert.deepEqual(x.st.migrateChains(), [], "once");
  assert.deepEqual(x.queue("B").plan?.after.map((e) => e.queue), ["A"]);
});
