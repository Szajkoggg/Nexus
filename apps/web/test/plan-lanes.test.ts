// Lanes by area (src/plan.ts areaOf, areaLanes; docs/ux/plan-view-modes.md, "Lanes by area"): a queue's lane is its own
// area, else its steps left's most common one, else "No area"; every shown queue in exactly one lane, in the plan's
// order; the lanes in the project's order, others by name, "No area" last; steps in other areas named, not drawn twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { areaLanes, areaOf, planLayout, planList, shownView, viewStoreKey, type LaneQueue, type PlanQueue } from "../src/plan.ts";

type Step = LaneQueue["steps"][number];
const step = (id: string, area?: string, over: Partial<Step> = {}): Step => ({ id, status: "pending", ...(area ? { tags: { area } } : {}), ...over });
const q = (id: string, area: string | undefined, steps: Step[], over: Partial<PlanQueue> = {}): PlanQueue & LaneQueue =>
  ({ id, title: `Queue ${id}`, status: "approved", questions: [], approved: true, revision: 1, ...(area ? { area } : {}), ...over, steps } as PlanQueue & LaneQueue);
const planned = (minutesAgo: number, ...after: string[]): NonNullable<PlanQueue["plan"]> =>
  ({ used: false, created_at: new Date(Date.UTC(2026, 10, 15, 12) - minutesAgo * 60_000).toISOString(), after: after.map((queue) => ({ queue, by: "user" as const, done: false })) });
const NO_TAGS = { areas: [], renames: [] };

test("a queue's area: its own; else most of its steps left; a tie the first such step's; else none", () => {
  assert.equal(areaOf(q("A", "engine", [step("A1", "dashboard")]), []), "engine", "its own, over its steps'");
  assert.equal(areaOf(q("B", undefined, [step("B1", "engine"), step("B2", "dashboard"), step("B3", "dashboard")]), []), "dashboard");
  assert.equal(areaOf(q("C", undefined, [step("C1", "engine"), step("C2", "dashboard")]), []), "engine", "a tie: the first step's");
  assert.equal(areaOf(q("D", undefined, [step("D1"), step("D2")]), []), undefined);
  // The steps left decide: done and skipped ones do not count, nor Nexus's closing and integration steps.
  const left = q("E", undefined, [step("E1", "engine", { status: "done" }), step("E2", "engine", { status: "skipped" }), step("E3", "dashboard"),
    step("E.refactor", "engine", { closing: true }), step("E.integrate", "engine", { integration: true })]);
  assert.equal(areaOf(left, []), "dashboard");
  // All done (a queue held at its end): its steps all count.
  assert.equal(areaOf(q("F", undefined, [step("F1", "engine", { status: "done" })]), []), "engine");
});

test("a renamed area reads as its new name, followed to the newest", () => {
  const renames = [{ from: "ui", to: "web", at: "2026-11-01T00:00:00Z" }, { from: "web", to: "dashboard", at: "2026-11-02T00:00:00Z" }] as never;
  assert.equal(areaOf(q("A", "ui", []), renames), "dashboard");
  assert.equal(areaOf(q("B", undefined, [step("B1", "web")]), renames), "dashboard");
});

/** A plan like Nexus's (scripts/capture/seed-plan-nexus.ts) with its area tags: NB has none, ST3 a step in engine. */
const NEXUS = [
  q("MX", "engine", [step("MX1")], { status: "running", run: { state: "running" } }),
  q("ST2", "dashboard", [step("ST21")], { status: "waiting" }),
  q("PL", "dashboard", [step("PL1")], { run: { state: "usage_wait" } }),
  q("RX", "engine", [step("RX1")], { plan: planned(300, "MX") }),
  q("IO", "dashboard", [step("IO1")], { plan: planned(280, "PL") }),
  q("CH", "orchestrator", [step("CH1")], { plan: planned(260) }),
  q("NB", undefined, [step("NB1")], { start: { at: "2026-11-15T22:00:00", created_at: "2026-11-15T08:00:00Z" } }),
  q("ST3", "dashboard", [step("ST31", "engine"), step("ST32")], { plan: planned(220, "RX", "ST2") }),
  q("TS", "engine", [step("TS1")], { plan: planned(200, "RX") }),
  q("LG", "dashboard", [step("LG1")], { plan: planned(180, "CH") }),
  q("DG", "dashboard", [step("DG1")], { plan: planned(160, "ST3", "IO") }),
  q("RA", "orchestrator", [step("RA1")], { plan: planned(140, "LG", "MX") }),
];
const TAGS = { areas: ["dashboard", "engine", "orchestrator"], renames: [] };

test("Nexus's plan: a lane per area in the project's order, No area last, each queue once in the plan's order", () => {
  const l = planLayout(NEXUS);
  const { lanes, also } = areaLanes(l, NEXUS, TAGS);
  assert.deepEqual(lanes, [
    { area: "dashboard", ids: ["PL", "ST2", "IO", "ST3", "LG", "DG"] },
    { area: "engine", ids: ["MX", "RX", "TS"] },
    { area: "orchestrator", ids: ["CH", "RA"] },
    { ids: ["NB"] },
  ]);
  const all = lanes.flatMap((x) => x.ids);
  assert.deepEqual([...all].sort(), planList(l).map((n) => n.id).sort(), "every queue in exactly one lane");
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual([...also], [["ST3", [{ area: "engine", steps: ["ST31"] }]]], "ST3's step in engine is named, ST3 not drawn twice");
  // Every dependency is still the layout's: the lanes do not change the lines.
  assert.ok(l.edges.some((e) => e.from === "MX" && e.to === "RA"));
});

test("the lanes' order: the project's list, then areas not in it by name, No area last; empty lanes are not drawn", () => {
  const l = planLayout(NEXUS);
  const order = (areas: string[]) => areaLanes(l, NEXUS, { areas, renames: [] }).lanes.map((x) => x.area ?? "-");
  assert.deepEqual(order(["orchestrator", "engine", "dashboard", "docs"]), ["orchestrator", "engine", "dashboard", "-"], "docs has no queue: no lane");
  assert.deepEqual(order(["engine"]), ["engine", "dashboard", "orchestrator", "-"]);
  assert.deepEqual(order([]), ["dashboard", "engine", "orchestrator", "-"]);
  // Starting a queue moves it between columns, not between lanes: the order stays.
  const started = NEXUS.map((x) => (x.id === "RX" ? { ...x, status: "running", run: { state: "running" } } as typeof x : x));
  assert.deepEqual(areaLanes(planLayout(started), started, TAGS).lanes.map((x) => x.area ?? "-"), ["dashboard", "engine", "orchestrator", "-"]);
});

test("a tag change: a queue given another area moves to that lane; a renamed area shows under its new name", () => {
  const moved = NEXUS.map((x) => (x.id === "NB" ? { ...x, area: "engine" } : x));
  const lanes = areaLanes(planLayout(moved), moved, TAGS).lanes;
  assert.deepEqual(lanes.map((x) => x.area ?? "-"), ["dashboard", "engine", "orchestrator"], "No area is gone with its only queue");
  assert.deepEqual(lanes[1]!.ids, ["MX", "RX", "NB", "TS"], "NB in engine, in the plan's order");
  const renamed = areaLanes(planLayout(NEXUS), NEXUS, { areas: ["dashboard", "engine", "orchestrator"], renames: [{ from: "engine", to: "core", at: "2026-11-20T00:00:00Z" }] as never });
  assert.deepEqual(renamed.lanes.map((x) => x.area ?? "-"), ["dashboard", "core", "orchestrator", "-"], "the renamed area keeps its place in the list");
  assert.deepEqual(renamed.also.get("ST3"), [{ area: "core", steps: ["ST31"] }]);
});

test("an empty plan has no lanes; a plan without areas is one lane, No area", () => {
  assert.deepEqual(areaLanes(planLayout([]), [], NO_TAGS), { lanes: [], also: new Map() });
  const bare = NEXUS.map((x) => { const { area: _, ...rest } = x; return { ...rest, steps: x.steps.map((s) => ({ id: s.id, status: s.status })) } as typeof x; });
  const lanes = areaLanes(planLayout(bare), bare, NO_TAGS).lanes;
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0]!.area, undefined);
  assert.deepEqual(lanes[0]!.ids, planList(planLayout(bare)).map((n) => n.id));
});

test("the view: Lanes by area when chosen, else the base view (Columns); kept per project in the browser", () => {
  assert.equal(shownView("lanes"), "lanes");
  for (const v of [null, undefined, "", "columns", "time", "critical"]) assert.equal(shownView(v), "columns", String(v));
  assert.equal(viewStoreKey("nexus"), "nexus.plan.view.nexus");
});
