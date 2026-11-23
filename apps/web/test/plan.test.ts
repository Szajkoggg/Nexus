// The plan view's layout (src/plan.ts): columns from what runs now, lines with who set them, the reasons a planned
// queue waits, the queues shown because a planned one waits for them, and the approved ones outside the plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateWords, isActive, isNow, isPlanned, moveTargets, planLayout, planList, whyOf, type PlanQueue } from "../src/plan.ts";
import { t } from "../src/i18n.ts";

const q = (id: string, over: Partial<PlanQueue> = {}): PlanQueue => ({ id, title: `Queue ${id}`, status: "approved", steps: [], questions: [], approved: true, revision: 1, ...over });
const after = (...entries: [string, "user" | "orchestrator", boolean?][]): NonNullable<PlanQueue["plan"]> =>
  ({ used: false, after: entries.map(([queue, by, done]) => ({ queue, by, done: !!done })) });
const ids = (cols: { id: string }[][]) => cols.map((c) => c.map((n) => n.id));
const words = (x: PlanQueue) => whyOf(x, new Date("2026-11-14T12:00:00")).map((w) => t(w.key, w.params));

test("columns: now, then each queue one right of the latest it waits for; done ones are not shown", () => {
  const l = planLayout([
    q("RN", { status: "running", run: { state: "running", step: "RN1" } }),
    q("CL", { plan: after(["RN", "user"]) }),
    q("DP", { plan: after(["CL", "orchestrator"]) }),
    q("MP", { plan: after(["RN", "user"], ["DN", "orchestrator", true]) }),
    q("DN", { status: "done" }),
    q("NX", { plan: after() }),
  ]);
  assert.deepEqual(ids(l.columns), [["RN"], ["CL", "MP", "NX"], ["DP"]]);
  assert.deepEqual(l.edges, [{ from: "RN", to: "CL", by: "user" }, { from: "CL", to: "DP", by: "orchestrator" }, { from: "RN", to: "MP", by: "user" }]);
  assert.deepEqual(planList(l).map((n) => n.id), ["RN", "CL", "MP", "NX", "DP"], "the phone's order");
  const mp = l.columns[1]!.find((n) => n.id === "MP")!;
  assert.deepEqual(mp.before, [{ queue: "RN", by: "user", done: false }, { queue: "DN", by: "orchestrator", done: true }], "the card names both, the done one too");
});

test("what is in progress: at work, waiting, paused, stopped, or a run holding its checkout; ended queues are not", () => {
  assert.equal(isNow(q("A", { status: "waiting" })), true);
  assert.equal(isNow(q("A", { status: "stopped" })), true);
  assert.equal(isNow(q("A", { status: "approved", run: { state: "usage_wait" } })), true);
  assert.equal(isNow(q("A", { status: "done", run: { state: "running" } })), false);
  assert.equal(isPlanned(q("A", { plan: { used: true, after: [] } })), false, "a used plan plans nothing");
  assert.equal(isPlanned(q("A", { start: { at: "2026-11-14T22:00:00Z" } })), true, "a schedule is in the plan");
});

test("what works now: a run going, a review, a question or a waiting step; paused, stopped or held at the limit do not", () => {
  assert.equal(isActive(q("A", { status: "running", run: { state: "running", step: "A1" } })), true);
  assert.equal(isActive(q("A", { status: "waiting", steps: [{ id: "A1", status: "review" }] })), true, "waits for the user's review");
  assert.equal(isActive(q("A", { status: "waiting", steps: [{ id: "A1", status: "waiting" }], questions: [{ state: "open", can_continue: false, step: "A1" }] })), true, "waits for an answer");
  assert.equal(isActive(q("A", { status: "approved", run: { state: "running", step: "A1", held: { reason: "limit" } } })), false, "held at the limit");
  assert.equal(isActive(q("A", { status: "paused", run: { state: "paused" } })), false);
  assert.equal(isActive(q("A", { status: "running" })), false, "its steps say running but no run goes (the server restarted)");
  assert.equal(isActive(q("A", { status: "stopped", stop_step: "A2", steps: [{ id: "A2", status: "failed" }] })), false);
});

// The user's report (2026-11-18): queues that had run were all in the first column, paused or stopped, though they
// wait for others in the plan.
test("a paused or stopped queue that waits for others stands after them; one that waits for none stays first", () => {
  const l = planLayout([
    q("RN", { status: "running", run: { state: "running", step: "RN2" }, current_step: "RN2" }),
    q("PA", { status: "paused", run: { state: "paused", step: "PA2" }, current_step: "PA2", plan: after(["RN", "user"]) }),
    q("ST", { status: "stopped", stop_step: "ST1", steps: [{ id: "ST1", status: "failed" }], plan: after(["PA", "orchestrator"]) }),
    q("FR", { status: "paused", run: { state: "paused", step: "FR1" }, current_step: "FR1" }),
  ]);
  assert.deepEqual(ids(l.columns), [["RN", "FR"], ["PA"], ["ST"]]);
  assert.deepEqual(l.edges, [{ from: "RN", to: "PA", by: "user" }, { from: "PA", to: "ST", by: "orchestrator" }]);
  const node = (id: string) => planList(l).find((n) => n.id === id)!;
  assert.deepEqual([node("RN").now, node("FR").now, node("PA").now, node("ST").now], [true, true, false, false]);
  assert.deepEqual(node("PA").resting, { tone: "paused", label: "paused · PA2" }, "its state shows on the card");
  assert.deepEqual(node("ST").resting, { tone: "stopped", label: "stopped at ST1" });
  assert.equal(node("FR").resting, undefined, "first, its honest status says it");
  assert.equal(node("PA").movable, true, "it can be moved in the plan like a planned one");
  assert.deepEqual(node("PA").before, [{ queue: "RN", by: "user", done: false }]);
});

test("a queue a planned one waits for shows too, even outside the plan; approved queues outside it are listed apart", () => {
  const l = planLayout([q("A"), q("B", { plan: after(["A", "user"]) }), q("C"), q("D", { status: "proposed", approved: false })]);
  assert.deepEqual(ids(l.columns), [[], ["A"], ["B"]]);
  assert.equal(l.columns[1]![0]!.planned, false);
  assert.deepEqual(l.outside, [{ id: "C", title: "Queue C" }], "not D: it is not approved");
});

test("within a column a queue follows those it waits for", () => {
  const l = planLayout([
    q("R1", { status: "running", run: { state: "running" } }),
    q("R2", { status: "running", run: { state: "running" } }),
    q("X", { plan: { ...after(["R2", "user"]), created_at: "2026-11-14T08:00:00Z" } }),
    q("Y", { plan: { ...after(["R1", "user"]), created_at: "2026-11-14T09:00:00Z" } }),
  ]);
  assert.deepEqual(ids(l.columns), [["R1", "R2"], ["Y", "X"]]);
});

test("why a planned queue waits: approval first; a predecessor stopped or gone; a time; the usage window; checkout, limit; a failed start; or it starts now", () => {
  assert.deepEqual(words(q("A", { approved: false, revision: 2, plan: after(["B", "user"]) })), ["needs approval (revision 2)"]);
  assert.deepEqual(words(q("A", { plan: { used: false, after: [{ queue: "S", by: "user", done: false, cause: "stopped" }, { queue: "Z", by: "orchestrator", done: false, cause: "missing" }] } })), ["S is stopped", "Z does not exist"]);
  assert.deepEqual(words(q("A", { plan: after(["B", "user"]) })), [], "the predecessors are on the card");
  assert.deepEqual(words(q("A", { start: { at: "2026-11-14T22:00:00" } })), ["starts at 22:00"]);
  assert.deepEqual(words(q("A", { start: { at: "2026-11-14T15:30:00", usage: "claude" } })), ["when the usage window resets (15:30)"]);
  assert.deepEqual(words(q("A", { plan: after(["B", "user", true]), start: { held: { kind: "checkout", reason: "waits for the checkout: queue RN runs there" } } })), ["waits for the checkout: queue RN runs there"]);
  assert.deepEqual(words(q("A", { start: { at: "2026-11-14T10:00:00", held: { kind: "limit", reason: "waits: 2 queues run, the limit is 2" } } })), ["waits: 2 queues run, the limit is 2"], "a held schedule: its time is past");
  assert.deepEqual(words(q("A", { start: { failed: { reason: "the queue is stopped" } } })), ["did not start: the queue is stopped"]);
  assert.deepEqual(words(q("A", { plan: after(["B", "user", true]) })), ["starts now"]);
});

test("moving: the targets are the other queues not ended, the plan's order first; the proposal and who may move", () => {
  const all = [
    q("RN", { status: "running", run: { state: "running" } }),
    q("CL", { plan: { ...after(["RN", "user"]), proposal: { after: ["UW"], reason: "why" } } }),
    q("AA"),
    q("DN", { status: "done" }),
    q("XX", { status: "cancelled" }),
  ];
  const l = planLayout(all);
  assert.deepEqual(moveTargets(l, all, "CL").map((x) => x.id), ["RN", "AA"]);
  const cl = l.columns[1]!.find((n) => n.id === "CL")!;
  assert.deepEqual([cl.movable, cl.proposal], [true, { after: ["UW"], reason: "why" }]);
  assert.equal(l.columns[0]![0]!.movable, false, "what runs now is not moved");
});

test("the estimate on a card: minutes to five, hours to a half under ten, whole hours above; none, or nothing left", () => {
  const w = (ms?: number, steps = 2) => { const x = estimateWords({ steps, ms }); return x && t(x.key, x.params); };
  assert.equal(w(undefined), "no estimate");
  assert.equal(w(1 * 60_000), "about 5 min (estimate)");
  assert.equal(w(38 * 60_000), "about 40 min (estimate)");
  assert.equal(w(150 * 60_000), "about 2.5 h (estimate)");
  assert.equal(w(13.4 * 3_600_000), "about 13 h (estimate)");
  assert.equal(w(10 * 60_000, 0), undefined, "no step left");
});

test("a queue in progress waiting for its turn to integrate (the merge train) says after which queue", () => {
  const l = planLayout([
    q("A", { status: "running", run: { state: "running" } }),
    q("B", { status: "paused", run: { state: "paused" }, train: { after: "A" } }),
    q("C", { status: "paused", run: { state: "paused" }, train: {} }),
    q("N", { plan: after(["B", "user"]) }),
  ]);
  const now = l.columns[0]!;
  assert.deepEqual(now.find((n) => n.id === "B")!.why.map((w) => t(w.key, w.params)), ["waits to integrate after A"]);
  assert.deepEqual(now.find((n) => n.id === "C")!.why, [], "the next to integrate waits for nobody");
  assert.deepEqual(now.find((n) => n.id === "A")!.why, []);
});
