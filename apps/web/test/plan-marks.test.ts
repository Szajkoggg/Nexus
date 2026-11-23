// The plan view's marks (src/plan.ts; docs/ux/plan-view-modes.md, queue PVA): the critical path by the dependencies and
// the estimates, and what blocks (what waits for the user now, what it holds up, what waits by itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { criticalPath, markLook, markStoreKey, planLayout, shownMark, whatBlocks, type BlockQueue, type PlanLayout } from "../src/plan.ts";

const q = (id: string, over: Partial<BlockQueue> = {}): BlockQueue => ({ id, title: `Queue ${id}`, status: "approved", steps: [], questions: [], approved: true, revision: 1, ...over });
const after = (...ids: string[]): NonNullable<BlockQueue["plan"]> => ({ used: false, after: ids.map((queue) => ({ queue, by: "user" as const, done: false })) });
const running = (id: string, over: Partial<BlockQueue> = {}) => q(id, { status: "running", run: { state: "running", step: `${id}1` }, ...over });
const h = (hours: number) => ({ steps: 2, ms: hours * 3_600_000 });
const NOW = new Date("2026-11-23T21:10:00");

/** Nexus's own plan (scripts/capture/seed-plan-nexus.ts), its work by the estimates in hours. */
const nexus = () => {
  const queues = [
    running("MX"), q("PL", { status: "running", run: { state: "usage_wait", step: "PL1" } }),
    q("ST2", { status: "waiting", steps: [{ id: "ST21", status: "review", review_with: "user" }, { id: "ST22", status: "pending" }] }),
    q("RX", { plan: after("MX") }), q("IO", { plan: after("PL") }),
    q("CH", { approved: false, revision: 2, plan: after() }), q("NB", { start: { at: "2026-11-23T22:00:00" } }),
    q("TS", { plan: after("RX") }), q("ST3", { plan: after("RX", "ST2") }), q("LG", { plan: after("CH") }),
    q("DG", { plan: after("ST3", "IO") }), q("RA", { plan: after("LG", "MX") }),
  ];
  const est = { MX: h(3.5), PL: h(2.5), ST2: h(2.5), RX: h(1.5), IO: h(3.5), CH: h(2.5), NB: h(1.5), TS: h(1.5), ST3: h(1.5), LG: h(1.5), DG: h(1.5), RA: h(1.5) };
  return { queues, est, layout: planLayout(queues, NOW) };
};

test("the critical path: the longest chain of work along the plan's lines (Nexus's plan: MX → RX → ST3 → DG, 8 h)", () => {
  const { layout, est } = nexus();
  const cp = criticalPath(layout, est)!;
  assert.deepEqual(cp.path, ["MX", "RX", "ST3", "DG"]);
  assert.equal(cp.ms, 8 * 3_600_000);
  assert.equal(cp.ties, 0);
  assert.deepEqual(cp.unknown, []);
});

test("several predecessors: the longer one counts, whichever was set first", () => {
  const l = planLayout([running("A"), running("B"), q("C", { plan: after("A", "B") })], NOW);
  assert.deepEqual(criticalPath(l, { A: h(1), B: h(3), C: h(1) })!.path, ["B", "C"]);
  assert.deepEqual(criticalPath(l, { A: h(4), B: h(3), C: h(1) })!.path, ["A", "C"]);
});

test("a tie: the chain first in the plan's order, and the count of the others as long (to the minute)", () => {
  const l = planLayout([running("A"), running("B"), q("C", { plan: after("A") }), q("D", { plan: after("B") })], NOW);
  const cp = criticalPath(l, { A: h(2), B: { steps: 1, ms: 2 * 3_600_000 + 30_000 }, C: h(1), D: h(1) })!;
  assert.deepEqual(cp.path, ["A", "C"], "A's chain ends first in the plan's order");
  assert.equal(cp.ties, 1);
  const joint = planLayout([running("A"), running("B"), q("C", { plan: after("B", "A") })], NOW);
  const j = criticalPath(joint, { A: h(2), B: h(2), C: h(1) })!;
  assert.deepEqual(j.path, ["A", "C"], "two predecessors as long: the first in the plan's order");
  assert.equal(j.ties, 1);
});

test("a missing estimate is no time, not zero: chains through it are not compared, and it is named", () => {
  const l = planLayout([running("A"), running("B"), q("C", { plan: after("A") }), q("D", { plan: after("C") })], NOW);
  const cp = criticalPath(l, { A: h(5), B: h(2), C: { steps: 2 }, D: h(1) })!;
  assert.deepEqual(cp.path, ["A"], "A → C → D (6 h if C took 0 h) is not counted: its chain starts again after C");
  assert.equal(cp.ms, 5 * 3_600_000);
  assert.deepEqual(cp.unknown, ["C"]);
  assert.equal(criticalPath(l, {}), undefined, "no estimates at all: no path");
  assert.deepEqual(criticalPath(l, { A: { steps: 0 }, B: h(1), C: h(1), D: h(1) })!.path, ["A", "C", "D"], "nothing left counts 0, as it is known");
});

test("an empty plan, a done or a missing predecessor, and a loop give no endless or wrong path", () => {
  assert.equal(criticalPath({ columns: [], edges: [], outside: [] }, {}), undefined);
  const done = planLayout([q("A", { status: "done" }), q("B", { plan: { used: false, after: [{ queue: "A", by: "user", done: true }] } })], NOW);
  assert.deepEqual(criticalPath(done, { B: h(1) })!.path, ["B"], "a done predecessor is not drawn and not counted");
  const gone = planLayout([q("B", { plan: { used: false, after: [{ queue: "X", by: "user", done: false, cause: "missing" }] } })], NOW);
  assert.deepEqual(criticalPath(gone, { B: h(1) })!.path, ["B"]);
  // A loop in damaged files: A after B, B after A.
  const loop: PlanLayout = { columns: [[], [
    { id: "A", title: "A", column: 1, now: false, planned: true, status: { tone: "planned", label: "", questions: 0, closed: 0, inReview: 0, total: 0 }, why: [], before: [], movable: true, placed: true },
    { id: "B", title: "B", column: 1, now: false, planned: true, status: { tone: "planned", label: "", questions: 0, closed: 0, inReview: 0, total: 0 }, why: [], before: [], movable: true, placed: true },
  ]], edges: [{ from: "A", to: "B", by: "user" }, { from: "B", to: "A", by: "user" }], outside: [] };
  const cp = criticalPath(loop, { A: h(1), B: h(2) })!;
  assert.ok(cp.path.length >= 1 && cp.path.length <= 2 && new Set(cp.path).size === cp.path.length, "each queue once");
});

test("what blocks in Nexus's plan: ST2's review and CH's approval, holding up ST3, DG, LG and RA; PL waits by itself", () => {
  const { layout, queues } = nexus();
  const b = whatBlocks(layout, queues, NOW);
  assert.deepEqual(b.roots, [{ queue: "ST2", kind: "review", step: "ST21" }, { queue: "CH", kind: "approval" }]);
  assert.deepEqual([...b.held].sort(), [["DG", ["ST2"]], ["LG", ["CH"]], ["RA", ["CH"]], ["ST3", ["ST2"]]]);
  assert.deepEqual(b.byItself, ["PL", "NB"].filter((id) => id === "PL"), "PL (usage window) holds IO up; NB holds nothing");
});

test("the roots: a question, a permission, a failed start, a stop, a pause, a predecessor gone; not the orchestrator's review, a time, a checkout", () => {
  const roots = (queues: BlockQueue[]) => whatBlocks(planLayout(queues, NOW), queues, NOW).roots;
  assert.deepEqual(roots([q("A", { status: "waiting", steps: [{ id: "A1", status: "waiting" }], questions: [{ qid: "q1", state: "open", can_continue: false, step: "A1" }] })]),
    [{ queue: "A", kind: "question", step: "A1", qid: "q1" }], "the question opens itself");
  assert.deepEqual(roots([q("A", { status: "waiting", steps: [{ id: "A1", status: "waiting" }] })]), [{ queue: "A", kind: "question", step: "A1" }], "a permission or check decision opens its step");
  assert.deepEqual(roots([q("A", { start: { failed: { reason: "busy" } } })]), [{ queue: "A", kind: "failed" }]);
  assert.deepEqual(roots([q("A", { status: "stopped", stop_step: "A1", steps: [{ id: "A1", status: "failed" }] })]), [{ queue: "A", kind: "stopped" }]);
  assert.deepEqual(roots([q("A", { status: "paused", run: { state: "paused", step: "A2" }, current_step: "A2" })]), [{ queue: "A", kind: "paused" }]);
  assert.deepEqual(roots([q("B", { plan: { used: false, after: [{ queue: "X", by: "user", done: false, cause: "cancelled" }] } })]), [{ queue: "B", kind: "blocked" }]);
  assert.deepEqual(roots([
    q("A", { status: "waiting", steps: [{ id: "A1", status: "review", review_with: "orchestrator" }] }),
    q("B", { start: { at: "2026-11-23T23:00:00" } }),
    q("C", { start: { held: { kind: "checkout", reason: "A works in it" } }, plan: after() }),
  ]), [], "the orchestrator's review, a time and a checkout end without the user");
});

test("a stopped predecessor is the root, its followers held; a root held by another root is both; the held set follows every line", () => {
  const queues = [
    q("S", { status: "stopped" }),
    q("A", { plan: after("S"), approved: false, revision: 2 }),
    q("B", { plan: after("A") }), q("C", { plan: after("B", "S") }),
    q("F", { plan: after() }),
  ];
  const b = whatBlocks(planLayout(queues, NOW), queues, NOW);
  assert.deepEqual(b.roots.map((r) => `${r.queue}:${r.kind}`), ["S:stopped", "A:approval"]);
  assert.deepEqual(b.held.get("A"), ["S"], "A waits for the user and for S");
  assert.deepEqual(b.held.get("C"), ["S", "A"]);
  assert.equal(b.held.has("F"), false);
  assert.deepEqual(whatBlocks({ columns: [], edges: [], outside: [] }, [], NOW), { roots: [], held: new Map(), byItself: [] }, "an empty plan");
});

test("the mark shown: the one chosen while it can work; kept per project in the browser, not in the plan", () => {
  assert.equal(shownMark("critical", { critical: true, blocked: true }), "critical");
  assert.equal(shownMark("critical", { critical: false, blocked: true }), undefined, "no estimates: the plan as it is");
  assert.equal(shownMark("blocked", { critical: true, blocked: false }), undefined, "nothing waits for the user");
  assert.equal(shownMark("lanes", { critical: true, blocked: true }), undefined, "an unknown value from an older dashboard");
  assert.equal(shownMark(null, { critical: true, blocked: true }), undefined);
  assert.equal(markStoreKey("nexus"), "nexus.plan.mark.nexus");
});

test("how a mark draws: the path's queues and lines; the roots, what they hold up and the lines between; the rest dimmed", () => {
  const { layout, est, queues } = nexus();
  const c = markLook("critical", criticalPath(layout, est), whatBlocks(layout, queues, NOW));
  assert.deepEqual(["MX", "RX", "PL", "DG"].map(c.card), ["path", "path", "dim", "path"]);
  assert.deepEqual([c.edge("MX", "RX"), c.edge("RX", "TS"), c.edge("MX", "RA")], ["path", "dim", "dim"]);
  const b = markLook("blocked", undefined, whatBlocks(layout, queues, NOW));
  assert.deepEqual(["ST2", "CH", "ST3", "DG", "MX", "IO"].map(b.card), ["root", "root", "held", "held", "dim", "dim"]);
  assert.deepEqual([b.edge("ST2", "ST3"), b.edge("ST3", "DG"), b.edge("IO", "DG"), b.edge("RX", "ST3")], ["lit", "lit", "dim", "dim"]);
});
