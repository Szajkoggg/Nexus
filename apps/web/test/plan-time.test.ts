// The plan's time axis (src/planTime.ts; docs/ux/plan-view-modes.md, "The time axis: the estimate contract"), with a
// fixed clock: starts after the latest predecessor, a schedule, the usage window, a run counted whole, the waits for the
// user (hatched from there, carried to every follower), what gives no bar (a stop, a pause, a predecessor gone, a loop),
// a missing estimate (never 0 h), no estimates at all, and the ruler across midnight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planLayout } from "../src/plan.ts";
import { rulerTicks, timeAxis, timeSpan, type TimeAxis, type TimeQueue, type TimeRow } from "../src/planTime.ts";
import { t } from "../src/i18n.ts";

const q = (id: string, over: Partial<TimeQueue> = {}): TimeQueue => ({ id, title: `Queue ${id}`, status: "approved", steps: [], questions: [], approved: true, revision: 1, ...over });
const after = (...ids: string[]): NonNullable<TimeQueue["plan"]> => ({ used: false, after: ids.map((queue) => ({ queue, by: "user" as const, done: false })) });
const running = (id: string, over: Partial<TimeQueue> = {}) => q(id, { status: "running", run: { state: "running", step: `${id}1` }, ...over });
const H = 3_600_000;
const h = (hours: number, steps = 2) => ({ steps, ms: hours * H });
const NOW = new Date(2026, 10, 23, 21, 10);
const WHO = { orchestrating: true, away: false };
const clock = (hh: number, mm: number, day = 23) => new Date(2026, 10, day, hh, mm).toISOString();

type Est = Record<string, { steps: number; ms?: number }> | undefined;
const axis = (queues: TimeQueue[], est: Est) => timeAxis(planLayout(queues, NOW), queues, est, WHO, NOW);
const row = (a: TimeAxis, id: string): TimeRow => a.rows.find((r) => r.id === id)!;
const note = (r: TimeRow) => r.note.map((x) => t(x.key, x.params)).join("; ");

/** Nothing unknown becomes a sure time: a row with an end has its own estimate and every predecessor's end. */
function noSureTimeFromUnknown(a: TimeAxis, queues: TimeQueue[], est: Est) {
  for (const r of a.rows) {
    if (r.end === undefined) continue;
    assert.ok(est?.[r.id]?.ms !== undefined || est?.[r.id]?.steps === 0, `${r.id} has an end without an estimate`);
    for (const b of queues.find((x) => x.id === r.id)!.plan?.after ?? []) {
      const p = a.rows.find((x) => x.id === b.queue);
      if (p && !b.done) assert.ok(p.end !== undefined && p.end <= r.start!, `${r.id} ends though ${b.queue}'s end is not known`);
    }
  }
}

test("parallel and joining branches: a queue starts when the latest of its predecessors is expected to end", () => {
  const queues = [running("A"), running("B"), q("C", { plan: after("A") }), q("D", { plan: after("C", "B") }), q("E", { plan: after("B") })];
  const est = { A: h(1), B: h(3), C: h(1), D: h(2), E: h(0.5) };
  const a = axis(queues, est);
  assert.deepEqual([row(a, "A").start, row(a, "A").end], [0, H]);
  assert.deepEqual([row(a, "C").start, row(a, "C").end], [H, 2 * H]);
  assert.deepEqual([row(a, "D").start, row(a, "D").end], [3 * H, 5 * H], "after B (3 h), the later of C and B");
  assert.deepEqual([row(a, "E").start, row(a, "E").end], [3 * H, 3.5 * H], "E and D run side by side after B");
  assert.ok(a.rows.every((r) => r.cond === undefined), "nothing waits for the user: no hatching");
  assert.equal(note(row(a, "A")), "running · A1, counted whole");
  assert.equal(note(row(a, "D")), "after C and B");
  noSureTimeFromUnknown(a, queues, est);
});

test("a schedule starts at its time, or after its predecessors if they end later; the usage window is a dotted lead", () => {
  const queues = [running("A"), q("N", { start: { at: clock(22, 0) } }), q("L", { start: { at: clock(21, 40) }, plan: after("A") }),
    q("P", { status: "running", run: { state: "usage_wait", step: "P1", resume_at: clock(22, 10) } }),
    q("U", { start: { at: clock(23, 0), usage: "claude" } })];
  const a = axis(queues, { A: h(1), N: h(1.5), L: h(1), P: h(2.5), U: h(1) });
  assert.deepEqual([row(a, "N").start, row(a, "N").end], [50 * 60_000, 50 * 60_000 + 1.5 * H]);
  assert.equal(note(row(a, "N")), "starts at 22:00");
  assert.equal(row(a, "L").start, H, "A ends at 22:10, after L's 21:40");
  assert.deepEqual(row(a, "P").wait, [0, H]);
  assert.deepEqual([row(a, "P").start, row(a, "P").end, row(a, "P").tone], [H, 3.5 * H, "usage"]);
  assert.equal(note(row(a, "P")), "after the usage window (22:10)");
  assert.deepEqual([row(a, "U").wait, row(a, "U").start], [[0, 110 * 60_000], 110 * 60_000]);
});

test("waits for the user: hatched from the wait on, and every follower hatched from its start, naming the condition", () => {
  const queues = [
    q("ST2", { status: "waiting", steps: [{ id: "ST21", status: "review", review_with: "user" }, { id: "ST22", status: "pending" }] }),
    q("CH", { approved: false, revision: 2, plan: after() }),
    running("RX"),
    q("IO", { plan: after("RX"), steps: [{ id: "IO1", status: "pending" }, { id: "IO2", status: "pending" }, { id: "IO3", status: "pending", level: 1 }, { id: "IO4", status: "pending" }] }),
    q("ST3", { plan: after("RX", "ST2") }), q("LG", { plan: after("CH") }), q("DG", { plan: after("ST3", "IO") }), q("TS", { plan: after("RX") }),
  ];
  const est = { ST2: h(2.5), CH: h(2.5), RX: h(1), IO: h(4, 4), ST3: h(1.5), LG: h(1.5), DG: h(1), TS: h(1) };
  const a = axis(queues, est);
  assert.deepEqual([row(a, "ST2").start, row(a, "ST2").cond, row(a, "ST2").marks], [0, 0, [0]], "a review now: hatched from now");
  assert.equal(note(row(a, "ST2")), "if you review ST21 now");
  assert.deepEqual([row(a, "CH").start, row(a, "CH").cond], [0, 0]);
  assert.equal(note(row(a, "CH")), "if you approve revision 2 now");
  // IO3 is level 1: its mark where IO's estimate puts the end of its third step of four, hatched after it.
  assert.deepEqual([row(a, "IO").start, row(a, "IO").marks, row(a, "IO").cond], [H, [H + 3 * H], H + 3 * H]);
  assert.equal(note(row(a, "IO")), "after RX; IO3 waits for your review");
  assert.equal(row(a, "TS").cond, undefined, "after RX only: sure");
  assert.deepEqual([row(a, "ST3").start, row(a, "ST3").cond], [2.5 * H, 2.5 * H], "after ST2's hatched end: hatched from its start");
  assert.equal(note(row(a, "ST3")), "after RX and ST2; if ST2 is reviewed by then");
  assert.equal(note(row(a, "LG")), "after CH; if CH is approved by then");
  assert.equal(note(row(a, "DG")), "after ST3 and IO; if ST2 is reviewed and IO is reviewed by then", "the conditions carry on, in the order of the predecessors");
  assert.equal(row(a, "DG").cond, row(a, "DG").start);
});

test("no bar for what only the user can change: a stop, a pause, a failed start, a predecessor gone; nor for their followers", () => {
  const queues = [
    q("S", { status: "stopped", steps: [{ id: "S1", status: "stopped" }], plan: after("A") }), running("A"),
    q("F", { plan: after("S") }), q("G", { plan: after("F") }),
    q("P", { status: "paused", current_step: "P2" }), q("PF", { plan: after("P") }),
    q("X", { start: { failed: { reason: "no checkout" } } }),
    q("M", { plan: { used: false, after: [{ queue: "Z", by: "user", done: false, cause: "missing" }] } }),
  ];
  const a = axis(queues, { S: h(1), A: h(1), F: h(1), G: h(1), P: h(1), PF: h(1), X: h(1), M: h(1) });
  for (const id of ["S", "F", "G", "P", "PF", "X", "M"]) assert.equal(row(a, id).start, undefined, `${id} has no bar`);
  assert.match(note(row(a, "S")), /^stopped.* · no time until you lift it$/);
  assert.equal(note(row(a, "G")), "after F; no time while S has none");
  assert.match(note(row(a, "P")), /no time until it resumes/);
  assert.equal(note(row(a, "X")), "did not start: no checkout · no time");
  assert.equal(note(row(a, "M")), "Z does not exist · no time");
});

test("held for its checkout: hatched from its earliest start, the wait named", () => {
  const queues = [running("A"), q("C", { plan: after("A"), start: { held: { kind: "checkout", reason: "the checkout is busy with QA" } } })];
  const a = axis(queues, { A: h(1), C: h(2) });
  assert.deepEqual([row(a, "C").start, row(a, "C").cond, row(a, "C").end], [H, H, 3 * H]);
  assert.equal(note(row(a, "C")), "after A; the checkout is busy with QA, for as long as it takes");
});

test("a missing estimate is not 0 h: an open bar from a known start, its followers placed 'not before', never a sure time", () => {
  const queues = [running("A"), q("B", { plan: after("A") }), q("C", { plan: after("B") }), q("D", { plan: after("C") })];
  const est = { A: h(2), B: { steps: 2 }, C: h(1), D: h(1) };
  const a = axis(queues, est);
  assert.deepEqual([row(a, "B").start, row(a, "B").end], [2 * H, undefined]);
  assert.equal(note(row(a, "B")), "after A; no estimate");
  assert.deepEqual([row(a, "C").start, row(a, "C").end, row(a, "C").notBefore], [undefined, undefined, 2 * H]);
  assert.deepEqual([row(a, "D").start, row(a, "D").notBefore], [undefined, 2 * H]);
  noSureTimeFromUnknown(a, queues, est);
  // A queue with no step left is known to take nothing.
  assert.equal(row(axis(queues, { ...est, B: { steps: 0 } }), "C").start, 2 * H);
});

test("no estimates at all (or they failed to load): only the set times are placed, the rest named in its order", () => {
  const queues = [running("MX"), q("PL", { status: "running", run: { state: "usage_wait", step: "PL1", resume_at: clock(22, 10) } }),
    q("ST2", { status: "waiting", steps: [{ id: "ST21", status: "review", review_with: "user" }] }), q("CH", { approved: false, revision: 2, plan: after() }),
    q("NB", { start: { at: clock(22, 0) } }), q("RX", { plan: after("MX") }), q("ST3", { plan: after("RX", "ST2") })];
  const a = axis(queues, undefined);
  assert.equal(a.known, false);
  assert.ok(a.rows.every((r) => r.end === undefined), "no end anywhere");
  assert.deepEqual(["MX", "PL", "ST2", "CH", "NB"].map((id) => t(row(a, id).open!.key, row(a, id).open!.params)), ["running", "from 22:10", "if reviewed", "if approved", "at 22:00"]);
  assert.deepEqual([row(a, "PL").start, row(a, "NB").start], [H, 50 * 60_000]);
  assert.deepEqual([row(a, "RX").start, row(a, "ST3").start], [undefined, undefined]);
  assert.equal(note(row(a, "RX")), "after MX; no estimate");
  assert.equal(note(row(a, "MX")), "running · MX1", "a set start says only that");
  noSureTimeFromUnknown(a, queues, undefined);
});

test("a loop has no bar; done predecessors are not counted; the merge train is one more predecessor", () => {
  const loop = [running("A"), q("B", { plan: after("C") }), q("C", { plan: after("B") })];
  const l = axis(loop, { A: h(1), B: h(1), C: h(1) });
  assert.deepEqual([row(l, "B").start, row(l, "C").start], [undefined, undefined]);
  const done = [q("D", { status: "done" }), q("E", { plan: { used: false, after: [{ queue: "D", by: "user", done: true }] } })];
  assert.equal(row(axis(done, { E: h(1) }), "E").start, 0, "after a done queue: from now");
  const train = [running("W"), running("V", { train: { after: "W" } })];
  const tr = axis(train, { W: h(2), V: h(0.5) });
  assert.deepEqual([row(tr, "V").start, row(tr, "V").end], [2 * H, 2.5 * H]);
});

test("the span and the ruler: whole hours from now, every few where they would crowd; midnight names the new day", () => {
  const queues = [running("A"), q("B", { plan: after("A") })];
  const a = axis(queues, { A: h(3), B: h(6) });
  assert.equal(timeSpan(a), 9.5 * H);
  const ticks = rulerTicks(NOW, timeSpan(a), 60);
  assert.deepEqual(ticks.map((x) => x.hour), [22, 23, 0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ticks.filter((x) => x.day).map((x) => x.date.getDate()), [24], "the day after, at its midnight");
  assert.equal(ticks[0]!.ms, 50 * 60_000);
  assert.deepEqual(rulerTicks(NOW, timeSpan(a), 20).map((x) => x.hour), [0, 3, 6], "every three hours at 20 px an hour, midnight kept");
  assert.equal(timeSpan(axis([running("A")], undefined)), 3 * H, "at least three hours");
  // A note's clock on the next day names the day.
  const late = axis([running("A"), q("N", { start: { at: clock(0, 30, 24) } })], { A: h(1), N: h(1) });
  assert.match(note(row(late, "N")), /starts at 24 Nov 00:30/);
});
