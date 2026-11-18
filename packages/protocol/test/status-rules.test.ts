// The shared status rules (status-rules.ts), for every run state and every step status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunFile, StepStatus } from "../src/schemas.ts";
import {
  isOpenQuestion, reviewedByOrchestrator, runCounted, runEnded, runGoing, runHoldsCheckout, stepAtWork, stepWaits, waitsForUserReview,
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
