// The plan view's actions on a line and by dragging (src/plan.ts): a line's details with the dependency named on its
// Remove, the two halves of a drop target, and what the undo bar says a change did. On Nexus's own plan
// (scripts/capture/seed-plan-nexus.ts): DG waits for ST3 (the orchestrator's) and IO (the user's).
import { test } from "node:test";
import assert from "node:assert/strict";
import { changeWords, dropChoices, lineDetails, planLayout, type PlanQueue } from "../src/plan.ts";
import { t } from "../src/i18n.ts";

const q = (id: string, over: Partial<PlanQueue> = {}): PlanQueue => ({ id, title: `Queue ${id}`, status: "approved", steps: [], questions: [], approved: true, revision: 1, ...over });
const at = "2026-11-15T13:20:00";
const planned = (...entries: [string, "user" | "orchestrator", boolean?][]): NonNullable<PlanQueue["plan"]> =>
  ({ used: false, after: entries.map(([queue, by, done]) => ({ queue, by, done: !!done, at })) });

const PLAN = planLayout([
  q("MX", { status: "running", run: { state: "running" } }),
  q("ST2", { status: "waiting" }),
  q("PL", { run: { state: "usage_wait" } }),
  q("PW", { status: "done" }),
  q("RX", { plan: planned(["MX", "orchestrator"]) }),
  q("IO", { plan: planned(["PL", "user"]) }),
  q("CH", { plan: planned(["PW", "orchestrator", true]) }),
  q("NB", { start: { at: "2026-11-15T22:00:00" } }),
  q("ST3", { plan: planned(["RX", "orchestrator"], ["ST2", "user"]) }),
  q("TS", { plan: planned(["RX", "orchestrator"]) }),
  q("DG", { plan: planned(["ST3", "orchestrator"], ["IO", "user"]) }),
]);
const say = (w: { key: Parameters<typeof t>[0]; params?: Parameters<typeof t>[1] } | undefined) => w && t(w.key, w.params);
const NOW = new Date("2026-11-15T21:00:00");

test("a line's details: the dependency, who set it and when; Remove names it; a hand-back only for the user's", () => {
  const d = lineDetails(PLAN, "ST2", "ST3", NOW)!;
  assert.equal(say(d.title), "ST3 after ST2");
  assert.equal(say(d.setBy), "Set by you · 13:20");
  assert.equal(say(d.remove), "Remove 'after ST2'", "the dependency named, not the queue");
  assert.equal(say(d.effect), "ST3 starts when ST2 is done, and RX (set by the orchestrator).");
  assert.deepEqual([d.handBack, d.last], [true, false]);
  const rx = lineDetails(PLAN, "RX", "ST3", NOW)!;
  assert.equal(say(rx.setBy), "Set by the orchestrator · 13:20");
  assert.equal(rx.handBack, false, "the orchestrator's: nothing to hand back");
  assert.equal(lineDetails(PLAN, "IO", "ST3"), undefined, "no such line");
});

test("a line's details for the last predecessor say the queue then starts as soon as it may; a done one does not count", () => {
  const d = lineDetails(PLAN, "MX", "RX", NOW)!;
  assert.equal(d.last, true);
  assert.equal(say(d.effect), "RX waits for nothing else: without MX, it starts as soon as it may (once approved, with its checkout free).");
  assert.equal(say(d.remove), "Remove 'after MX'");
  // CH waits for PW, done: removing it starts nothing new, and it has no other open predecessor.
  assert.equal(lineDetails(PLAN, "PW", "CH", NOW)?.last, true);
});

test("dropping on another queue: 'instead' names every predecessor it replaces; 'also' adds one", () => {
  const dg = dropChoices(PLAN, "DG", "TS")!;
  assert.equal(say(dg.instead), "After TS instead of ST3, IO", "both of DG's predecessors named");
  assert.equal(say(dg.also), "Also after TS (and ST3, IO)");
  const ts = dropChoices(PLAN, "TS", "ST2")!;
  assert.deepEqual([say(ts.instead), say(ts.also)], ["After ST2 instead of RX", "Also after ST2 (and RX)"], "as the mockup has it");
  assert.equal(say(dropChoices(PLAN, "CH", "RX")!.instead), "After RX instead of PW", "a done one is replaced too");
  assert.equal(say(dropChoices(PLAN, "CH", "RX")!.also), "Also after RX");
  assert.equal(dropChoices(PLAN, "DG", "IO")!.also, undefined, "it waits for IO already");
  assert.equal(say(dropChoices(PLAN, "DG", "IO")!.instead), "After IO instead of ST3");
  assert.equal(dropChoices(PLAN, "NB", "RX")!.also, undefined, "a schedule has no place of its own to add to");
  assert.equal(dropChoices(PLAN, "MX", "RX"), undefined, "what runs now is not moved");
  assert.equal(dropChoices(PLAN, "DG", "DG"), undefined);
});

test("the undo bar says what the change did", () => {
  assert.equal(say(changeWords({ kind: "add", queue: "TS", target: "ST2" })), "TS now also waits for ST2 (set by you).");
  assert.equal(say(changeWords({ kind: "remove", queue: "ST3", target: "ST2" })), "ST3 no longer waits for ST2.");
  assert.equal(say(changeWords({ kind: "move", queue: "DG", target: "TS", replaced: ["ST3", "IO"] })), "DG now waits for TS instead of ST3, IO.");
  assert.equal(say(changeWords({ kind: "move", queue: "DG", target: "IO", replaced: ["IO"] })), "DG now waits for IO.");
  assert.equal(say(changeWords({ kind: "move", queue: "DG", target: null })), "DG is now first, with no queue before it.");
});
