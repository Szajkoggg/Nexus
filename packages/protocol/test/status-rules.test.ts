// The shared status rules (status-rules.ts), for every run state and every step status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunFile, StepStatus } from "../src/schemas.ts";
import { ActionError, ProjectStore, applyDraft, approveQueue, loadProjectState, queueView, stepView } from "../src/index.ts";
import {
  REPORTED_STEP, isOpenQuestion, queueWorkedOn, reviewedByOrchestrator, runActive, runCounted, runEnded, runGoing, runHoldsCheckout, stepAtWork, stepReported, stepWaits, stepWorkedOn, stepsWorkedOn, waitsForUserReview,
} from "../src/status-rules.ts";

type RunState = RunFile["state"];
const RUN_STATES = RunFile.shape.state.options;

/** Each rule's answer for every run state, in the schema's order. */
const runTable = (rule: (r: { state: RunState }) => boolean) => Object.fromEntries(RUN_STATES.map((s) => [s, rule({ state: s })]));

test("the table covers every run state of the schema", () => {
  assert.deepEqual([...RUN_STATES].sort(), ["approval_wait", "finished", "halted", "paused", "pausing", "retry_wait", "running", "usage_wait"]);
});

test("the run is going: running, pausing, a usage or retry wait, an approval wait", () => {
  assert.deepEqual(runTable(runGoing), {
    running: true, pausing: true, paused: false, halted: false, finished: false, usage_wait: true, retry_wait: true, approval_wait: true,
  });
});

test("the run holds its checkout: going, or paused", () => {
  assert.deepEqual(runTable(runHoldsCheckout), {
    running: true, pausing: true, paused: true, halted: false, finished: false, usage_wait: true, retry_wait: true, approval_wait: true,
  });
});

test("the run counts toward the limit on queues running at once: running and pausing only", () => {
  assert.deepEqual(runTable(runCounted), {
    running: true, pausing: true, paused: false, halted: false, finished: false, usage_wait: false, retry_wait: false, approval_wait: false,
  });
});

test("the run has ended: finished, halted or paused; going and ended never overlap", () => {
  assert.deepEqual(runTable(runEnded), {
    running: false, pausing: false, paused: true, halted: true, finished: true, usage_wait: false, retry_wait: false, approval_wait: false,
  });
  for (const s of RUN_STATES) assert.ok(!(runGoing({ state: s }) && runEnded({ state: s })), s);
});

test("no run: nothing goes, holds, counts or has ended", () => {
  for (const rule of [runGoing, runHoldsCheckout, runCounted, runEnded]) {
    assert.equal(rule(undefined), false);
    assert.equal(rule(null), false);
  }
});

const STEP_STATUSES = StepStatus.options;

test("the step rules for every step status (review with no reviewer named counts as the user's)", () => {
  const table = Object.fromEntries(STEP_STATUSES.map((status) => [status, [
    waitsForUserReview({ status }), reviewedByOrchestrator({ status }), stepAtWork({ status }), stepWaits({ status }),
  ]]));
  assert.deepEqual(table, {
    //        user   orch   atWork waits
    pending: [false, false, false, false],
    running: [false, false, true, false],
    checking: [false, false, true, false],
    waiting: [false, false, true, true],
    review: [true, false, false, true],
    done: [false, false, false, false],
    failed: [false, false, false, false],
    skipped: [false, false, false, false],
    stopped: [false, false, false, false],
    rejected: [false, false, false, false],
  });
});

test("a review is the user's or the orchestrator's, never both", () => {
  assert.deepEqual([waitsForUserReview({ status: "review", review_with: "user" }), reviewedByOrchestrator({ status: "review", review_with: "user" })], [true, false]);
  assert.deepEqual([waitsForUserReview({ status: "review", review_with: "orchestrator" }), reviewedByOrchestrator({ status: "review", review_with: "orchestrator" })], [false, true]);
  // A leftover reviewer on a step no longer in review means nothing.
  for (const status of STEP_STATUSES.filter((s) => s !== "review")) {
    assert.equal(waitsForUserReview({ status, review_with: "user" }), false);
    assert.equal(reviewedByOrchestrator({ status, review_with: "orchestrator" }), false);
  }
});

test("a question is open when asked or passed on to the user; answered and withdrawn are closed", () => {
  assert.deepEqual((["open", "escalated", "answered", "withdrawn"] as const).map((state) => isOpenQuestion({ state })), [true, true, false, false]);
});

test("a run held at the limit does not count, and still goes on and holds its checkout", () => {
  const held = { state: "running", held: { since: "2026-01-01T09:00:00.000Z", kind: "limit", reason: "waits: 2 queues run, the limit is 2" } };
  assert.equal(runCounted(held), false);
  assert.equal(runGoing(held), true);
  assert.equal(runHoldsCheckout(held), true);
  assert.equal(runEnded(held), false);
});

test("a step whose run the user stopped is not worked on, as the files LCT and WHT were left (queue EF)", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-stopped-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "LCT", title: "Tests", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "LCT1", title: "One", goal: "", acceptance: [] }, { id: "LCT2", title: "Two", goal: "", acceptance: [] }] });
  approveQueue(store, "LCT");
  const session = "01M7NNB8V2HPS64Q49AQ71DP2H";
  store.writeSession({ protocol: 1, id: session, project: "p", role: "worker", runtime: "codex", cwd: root, launched_by: "nexus", created_at: "2026-11-17T21:07:00.636Z", queue: "LCT" });
  // What a Stop left: the step started and reported progress, then the run paused with no outcome of the step.
  store.appendEvent({ v: 1, id: "01M7NNCQ9V3TEXZP52TMB8VV1E", at: "2026-11-17T21:07:48.159Z", session, type: "step.started", queue: "LCT", step: "LCT1" });
  store.appendEvent({ v: 1, id: "01M7NNEJWN4F9YQBESDRFF94EK", at: "2026-11-17T21:08:49.179Z", session, type: "step.progress", queue: "LCT", step: "LCT1", text: "working" });
  const run = { protocol: 1 as const, session, step: "LCT1", started_at: "2026-11-17T21:07:00.636Z", revision: 1 };
  store.writeRun("LCT", { ...run, state: "paused", reason: "stopped by the user", updated_at: "2026-11-17T21:15:23.815Z", ended_at: "2026-11-17T21:15:23.815Z" });
  const q = () => loadProjectState(store).queues.find((x) => x.id === "LCT")!;
  // The derivation keeps the step it goes on with at Continue, as before; it is not at work.
  assert.deepEqual([q().status, q().steps[0]!.status], ["running", "running"]);
  assert.equal(stepWorkedOn(q().run, q().steps[0]!), false);
  assert.equal(queueWorkedOn(q()), false);
  assert.deepEqual(stepsWorkedOn([q()]), []);
  // The same step with its run going is at work.
  store.writeRun("LCT", { ...run, state: "running", updated_at: "2026-11-17T21:16:00.000Z" });
  assert.deepEqual(stepsWorkedOn([q()]).map((x) => [x.queue.id, x.step.id]), [["LCT", "LCT1"]]);
  assert.equal(queueWorkedOn(q()), true);
});

test("a step is worked on only while running with its run going, in every run state (queue EF)", () => {
  const going = RUN_STATES.filter((s) => stepWorkedOn({ state: s }, { status: "running" }));
  assert.deepEqual(going, RUN_STATES.filter((s) => runGoing({ state: s })));
  assert.ok(!going.includes("paused") && !going.includes("halted") && !going.includes("finished"));
  for (const status of ["waiting", "review", "checking", "done", "pending"] as StepStatus[]) assert.equal(stepWorkedOn({ state: "running" }, { status }), false, status);
  assert.equal(stepWorkedOn(undefined, { status: "running" }), true, "no run of Nexus's: a session it did not start works on it");
});

test("runActive: running or pausing, held at the limit or not; no other state, and no run", () => {
  for (const state of RUN_STATES) {
    assert.equal(runActive({ state }), state === "running" || state === "pausing", state);
  }
  assert.equal(runActive({ state: "running", held: { at: "x" } }), true, "a run held at the limit is still active");
  assert.equal(runActive(undefined), false);
  assert.equal(runActive(null), false);
});

test("stepReported: the step is in its review or checks, done, skipped or rejected", () => {
  for (const status of StepStatus.options) {
    assert.equal(stepReported({ status }), ["review", "checking", "done", "skipped", "rejected"].includes(status), status);
    assert.equal(REPORTED_STEP.has(status), stepReported({ status }));
  }
});

test("queueView and stepView: the views, or an ActionError naming what is missing (404) or unreadable (409), never a TypeError", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-views-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  applyDraft(store, { protocol: 1, id: "Q", title: "Q", steps: [{ id: "Q1", title: "One", goal: "Do one.", acceptance: ["one works"] }] });
  const state = loadProjectState(store);
  assert.equal(queueView(state, "Q").id, "Q");
  assert.equal(stepView(state, "Q", "Q1").id, "Q1");
  const refused = (fn: () => unknown, text: RegExp) => assert.throws(fn, (e: unknown) =>
    e instanceof ActionError && e.status === 404 && text.test(e.message));
  refused(() => queueView(state, "X"), /^unknown queue X$/);
  refused(() => stepView(state, "X", "Q1"), /^unknown queue X$/);
  refused(() => stepView(state, "Q", "Q9"), /^queue Q has no step Q9$/);
  // A queue the derivation left out because its files cannot be read: not unknown, a refusal (409) with the state's
  // warning about it, which names the file (queue LCK, F12).
  assert.throws(() => queueView({ ...state, queues: [], warnings: ["queue Q: /p/.nexus/queues/Q/queue.yaml cannot be read: broken"] }, "Q"), (e: unknown) =>
    e instanceof ActionError && e.status === 409 && /^queue Q: \/p\/\.nexus\/queues\/Q\/queue\.yaml cannot be read: broken/.test(e.message));
});
