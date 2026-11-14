// The plan view's layout (src/plan.ts): columns from what runs now, lines with who set them, the reasons a planned
// queue waits, the queues shown because a planned one waits for them, and the approved ones outside the plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNow, isPlanned, planLayout, planList, whyOf, type PlanQueue } from "../src/plan.ts";
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

test("what is now: at work, waiting, paused, stopped, or a run holding its checkout; ended queues are not", () => {
  assert.equal(isNow(q("A", { status: "waiting" })), true);
  assert.equal(isNow(q("A", { status: "stopped" })), true);
  assert.equal(isNow(q("A", { status: "approved", run: { state: "usage_wait" } })), true);
  assert.equal(isNow(q("A", { status: "done", run: { state: "running" } })), false);
  assert.equal(isPlanned(q("A", { plan: { used: true, after: [] } })), false, "a used plan plans nothing");
  assert.equal(isPlanned(q("A", { start: { at: "2026-11-14T22:00:00Z" } })), true, "a schedule is in the plan");
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
