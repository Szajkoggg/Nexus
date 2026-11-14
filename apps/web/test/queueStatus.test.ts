import { test } from "node:test";
import assert from "node:assert/strict";
import { queueStatus, type QueueLike } from "../src/queueStatus.ts";
import { shortStatus } from "../src/rail.ts";

const q = (over: Partial<QueueLike> & { steps?: QueueLike["steps"] }): QueueLike => ({ status: "approved", steps: [], questions: [], ...over });
const st = (spec: string) => spec.split(" ").map((x) => { const [id, status, by] = x.split(":"); return { id: id!, status: status!, ...(by ? { review_with: by as "user" | "orchestrator" } : {}) }; });
const pick = (s: ReturnType<typeof queueStatus>) => [s.tone, s.label];

test("running only while a run really runs; steps that say running without a run read as paused", () => {
  assert.deepEqual(pick(queueStatus(q({ status: "running", steps: st("A1:done A2:running"), run: { state: "running", step: "A2" } }))), ["running", "running · A2"]);
  // After a server restart: the events still say A2 runs, the run is paused (survey a0).
  assert.deepEqual(pick(queueStatus(q({ status: "running", steps: st("A1:done A2:running"), run: { state: "paused", step: "A2" }, current_step: "A2" }))), ["paused", "paused · A2"]);
  assert.deepEqual(pick(queueStatus(q({ status: "running", steps: st("A1:running"), current_step: "A1" }))), ["paused", "paused · A1"], "no run at all");
  assert.deepEqual(pick(queueStatus(q({ status: "running", steps: st("A1:running"), run: { state: "pausing", step: "A1" } }))), ["running", "pausing after A1"]);
});

test("waiting apart from running: a blocking question, a retry, the usage window", () => {
  const asking = q({ status: "waiting", steps: st("Q1:done Q2:waiting"), questions: [{ state: "open", can_continue: false, step: "Q2" }], run: { state: "running", step: "Q2" } });
  assert.deepEqual(pick(queueStatus(asking)), ["waiting", "waiting for an answer · Q2"]);
  assert.equal(queueStatus(asking).questions, 1);
  // A question the worker goes on past does not make the queue wait.
  const goingOn = q({ status: "running", steps: st("Q1:running"), questions: [{ state: "open", can_continue: true, step: "Q1" }], run: { state: "running", step: "Q1" } });
  assert.deepEqual(pick(queueStatus(goingOn)), ["running", "running · Q1"]);
  assert.equal(queueStatus(goingOn).questions, 1, "still counted");
  assert.deepEqual(pick(queueStatus(q({ status: "running", steps: st("R1:running"), run: { state: "retry_wait", step: "R1" } }))), ["waiting", "waiting to retry · R1"]);
  assert.deepEqual(pick(queueStatus(q({ status: "running", steps: st("R1:running"), run: { state: "usage_wait", step: "R1" } }))), ["waiting", "waiting for the usage window · R1"]);
});

test("steps in review: the user's, the orchestrator's; counted apart from the closed ones", () => {
  // Survey a1: "waiting" and "0/2 steps" with both steps done and in review.
  const both = queueStatus(q({ status: "waiting", steps: st("U1:review:user U2:review:user") }));
  assert.deepEqual(pick(both), ["review", "2 steps wait for your review"]);
  assert.deepEqual([both.closed, both.inReview, both.total], [0, 2, 2]);
  assert.deepEqual(pick(queueStatus(q({ status: "waiting", steps: st("U1:done U2:review:user") }))), ["review", "waiting for your review · U2"]);
  assert.deepEqual(pick(queueStatus(q({ status: "waiting", steps: st("U1:review:orchestrator") }))), ["review", "the orchestrator reviews · U1"]);
});

test("a stop: at the step that holds it, or the queue's once that step is skipped", () => {
  assert.deepEqual(pick(queueStatus(q({ status: "stopped", stop_step: "W4c", steps: st("W4b:done W4c:stopped") }))), ["stopped", "stopped at W4c"]);
  assert.deepEqual(pick(queueStatus(q({ status: "stopped", stop_step: "W4b", steps: st("W4b:skipped W4c:pending") }))), ["stopped", "stopped"]);
});

test("a failed step, unless a run has taken it up again", () => {
  assert.deepEqual(pick(queueStatus(q({ status: "paused", steps: st("F1:failed F2:pending") }))), ["failed", "failed at F1"]);
  assert.deepEqual(pick(queueStatus(q({ status: "running", steps: st("F1:failed F2:running"), run: { state: "running", step: "F2" } }))), ["running", "running · F2"]);
});

test("before it runs: approval, approved, a planned start; after: done, cancelled", () => {
  assert.deepEqual(pick(queueStatus(q({ status: "proposed" }))), ["approval", "needs your approval"]);
  assert.deepEqual(pick(queueStatus(q({ status: "approved" }))), ["planned", "approved"]);
  assert.deepEqual(pick(queueStatus(q({ status: "approved", start: { after: "SF" } }))), ["planned", "starts after SF"]);
  // The plan: several predecessors; a used plan says nothing; one waiting for its approval says it needs approval.
  assert.deepEqual(pick(queueStatus(q({ status: "approved", plan: { used: false, after: [{ queue: "SF" }, { queue: "HS" }] } }))), ["planned", "starts after SF, HS"]);
  assert.deepEqual(pick(queueStatus(q({ status: "approved", plan: { used: true, after: [{ queue: "SF" }] } }))), ["planned", "approved"]);
  assert.deepEqual(pick(queueStatus(q({ status: "approved", approved: false, revision: 2, plan: { used: false, after: [{ queue: "SF" }] }, start: { held: { kind: "approval" } } }))), ["approval", "needs approval (revision 2) · then starts after SF"]);
  assert.equal(queueStatus(q({ status: "approved", start: { at: "2026-11-14T08:30:00Z" } }), new Date("2026-11-14T06:00:00Z")).tone, "planned");
  assert.deepEqual(pick(queueStatus(q({ status: "approved", start: { at: "2026-11-14T08:30:00Z", failed: { reason: "x" } } }))), ["failed", "did not start"]);
  assert.deepEqual(pick(queueStatus(q({ status: "done", steps: st("D1:done D2:skipped") }))), ["done", "done"]);
  // Came due, but waits for its checkout or for a place under the limit (it starts by itself).
  assert.deepEqual(pick(queueStatus(q({ status: "approved", start: { after: "SF", held: { kind: "checkout" } } }))), ["planned", "waits for the checkout"]);
  assert.deepEqual(pick(queueStatus(q({ status: "approved", start: { at: "2026-11-14T08:30:00Z", held: { kind: "limit" } } }))), ["planned", "waits: limit reached"]);
  assert.equal(shortStatus(queueStatus(q({ status: "approved", start: { after: "SF", held: { kind: "checkout" } } }))), "waits: checkout");
  assert.equal(shortStatus(queueStatus(q({ status: "approved", start: { after: "SF", held: { kind: "limit" } } }))), "waits: limit");
  assert.deepEqual(pick(queueStatus(q({ status: "cancelled" }))), ["cancelled", "cancelled"]);
});

test("a revision waiting for approval comes first, in the approval tone, with the planned start after it", () => {
  const planned = { status: "proposed", revision: 3, steps: st("S1:pending S2:pending"), start: { after: "HS" } };
  assert.deepEqual(pick(queueStatus(q({ ...planned, approved: false }))), ["approval", "needs approval (revision 3) · then starts after HS"]);
  // Approved: the planned start alone, as before.
  assert.deepEqual(pick(queueStatus(q({ ...planned, status: "approved", approved: true }))), ["planned", "starts after HS"]);
  // A time, and no plan at all.
  const at = new Date(2026, 10, 14, 14, 0).toISOString();
  assert.match(queueStatus(q({ ...planned, start: { at }, approved: false }), new Date(2026, 10, 14, 9, 0)).label, /^needs approval \(revision 3\) · then starts at 14:00$/);
  assert.deepEqual(pick(queueStatus(q({ status: "proposed", revision: 2, steps: st("S1:pending"), approved: false }))), ["approval", "needs approval (revision 2)"]);
  // Before a step runs, after some did (a revised queue that ran), and a stopped one: approval first all the same.
  assert.deepEqual(pick(queueStatus(q({ status: "paused", revision: 2, steps: st("S1:done S2:pending"), approved: false, start: { after: "HS" } }))), ["approval", "needs approval (revision 2) · then starts after HS"]);
  // A first revision with no plan keeps its plain words; a failed plan is not promised.
  assert.deepEqual(pick(queueStatus(q({ status: "proposed", revision: 1, approved: false }))), ["approval", "needs your approval"]);
  assert.deepEqual(pick(queueStatus(q({ status: "proposed", revision: 2, approved: false, start: { after: "HS", failed: { reason: "x" } } }))), ["approval", "needs approval (revision 2)"]);
  // Done and cancelled stay so.
  assert.deepEqual(pick(queueStatus(q({ status: "done", revision: 2, approved: false }))), ["done", "done"]);
});

test("a run waiting for the approval at a step's end says so, after which step; approved, it is running again", () => {
  const waiting = { status: "running", revision: 3, steps: st("S1:done S2:pending"), run: { state: "approval_wait", step: "S1" } };
  assert.deepEqual(pick(queueStatus(q({ ...waiting, approved: false }))), ["approval", "waits for approval of revision 3 · after S1"]);
  // Every remaining step removed: the queue is waiting, not done, until the approval.
  assert.deepEqual(pick(queueStatus(q({ ...waiting, status: "waiting", steps: st("S1:done"), approved: false }))), ["approval", "waits for approval of revision 3 · after S1"]);
  // Mid-step a newer revision waits: the queue needs approval, the step goes on.
  assert.deepEqual(pick(queueStatus(q({ ...waiting, steps: st("S1:running S2:pending"), run: { state: "running", step: "S1" }, approved: false }))), ["approval", "needs approval (revision 3)"]);
});
