// The desktop's right rail: which queues are at work, in which order, their status in a few words, and what finished today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { atWork, finishedToday, shortStatus } from "../src/rail.ts";
import { queueStatus } from "../src/queueStatus.ts";

type Step = { id: string; status: string; started_at?: string; finished_at?: string; review_with?: "orchestrator" | "user" };
const q = (id: string, status: string, over: Record<string, unknown> = {}) =>
  ({ id, status, steps: [] as Step[], questions: [] as { state: string; can_continue: boolean; step?: string }[], ...over });
const st = (spec: string) => spec.split(" ").map((x) => { const [id, status] = x.split(":"); return { id: id!, status: status! }; });

test("at work: running first, then waiting, review, paused and planned starts; what waits for the user is not here", () => {
  const queues = [
    q("CH", "approved", { start: { after: "SF" } }),
    q("PA", "running", { steps: st("PA1:running"), current_step: "PA1" }),
    q("RV", "waiting", { steps: st("RV1:review") }),
    q("SF", "running", { steps: st("SF1:done SF2:running SF3:pending"), run: { state: "running", step: "SF2" } }),
    q("QU", "waiting", { steps: st("QU1:waiting"), questions: [{ state: "open", can_continue: false, step: "QU1" }], run: { state: "running", step: "QU1" } }),
    q("ST", "stopped", { steps: st("ST1:stopped"), stop_step: "ST1" }),
    q("AP", "proposed"),
    q("OK", "approved"),
    q("DN", "done", { steps: st("DN1:done") }),
    q("BAD", "approved", { start: { after: "X", failed: { at: "2026-11-13T10:00:00Z" } } }),
  ];
  assert.deepEqual(atWork(queues).map((x) => x.queue.id), ["SF", "QU", "RV", "PA", "CH"]);
});

test("the status in a few words", () => {
  const s = (x: ReturnType<typeof q>) => shortStatus(queueStatus(x));
  assert.equal(s(q("SF", "running", { steps: st("SF1:done SF2:running SF3:pending"), run: { state: "running", step: "SF2" } })), "1/3");
  assert.equal(s(q("SF", "running", { steps: st("SF1:running"), run: { state: "pausing", step: "SF1" } })), "pausing");
  assert.equal(s(q("RV", "waiting", { steps: [{ id: "RV1", status: "review" }] })), "review");
  assert.equal(s(q("RV", "waiting", { steps: [{ id: "RV1", status: "review", review_with: "orchestrator" }] })), "orchestrator reviews");
  assert.equal(s(q("CH", "approved", { start: { after: "SF" } })), "after SF");
  assert.equal(s(q("QU", "waiting", { steps: st("QU1:waiting"), questions: [{ state: "open", can_continue: false, step: "QU1" }] })), "question");
  assert.equal(s(q("UW", "running", { steps: st("U1:running"), run: { state: "usage_wait", step: "U1" } })), "usage window");
  assert.equal(s(q("PA", "running", { steps: st("PA1:running"), current_step: "PA1" })), "paused · PA1");
});

test("finished today: done or cancelled today, most recent first; yesterday's and one still waiting are not", () => {
  const now = new Date(2026, 10, 13, 15, 0);
  const at = (h: number, day = 13) => new Date(2026, 10, day, h, 0).toISOString();
  const queues = [
    q("A", "done", { steps: [{ id: "A1", status: "done", finished_at: at(9) }] }),
    q("B", "done", { steps: [{ id: "B1", status: "done", finished_at: at(12) }] }),
    q("C", "done", { steps: [{ id: "C1", status: "done", finished_at: at(20, 12) }] }),
    q("D", "cancelled", { steps: [{ id: "D1", status: "done", finished_at: at(11) }] }),
    q("E", "done", { steps: [{ id: "E1", status: "review", finished_at: at(13) }] }),
    q("F", "done", { steps: [{ id: "F1", status: "done", finished_at: at(14) }] }),
    q("G", "running", { steps: [{ id: "G1", status: "done", finished_at: at(14) }] }),
  ];
  assert.deepEqual(finishedToday(queues, new Set(["F"]), now).map((r) => r.queue.id), ["B", "D", "A"]);
});

test("a planned queue whose new revision waits for approval stays in the rail and says so first", () => {
  const queues = [
    q("HS", "running", { steps: st("HS1:running"), run: { state: "running", step: "HS1" } }),
    q("ST", "proposed", { approved: false, revision: 2, start: { after: "HS" } }),
    q("RV", "approved", { approved: true, revision: 1, start: { after: "HS" } }),
    q("NW", "proposed", { approved: false, revision: 2 }), // no plan: it waits for the user, not here
  ];
  const work = atWork(queues);
  assert.deepEqual(work.map((w) => [w.queue.id, shortStatus(w.status)]), [["HS", "0/1"], ["ST", "needs approval · then after HS"], ["RV", "after HS"]]);
  assert.equal(work[1]!.status.tone, "approval");
});

test("a run waiting for approval is not at work: it waits for the user (the rail's first section), in short words there", () => {
  const queues = [q("AW", "running", { approved: false, revision: 2, steps: st("AW1:done AW2:pending"), run: { state: "approval_wait", step: "AW1" } })];
  assert.deepEqual(atWork(queues), []);
  const s = queueStatus(queues[0]!);
  assert.deepEqual([s.tone, shortStatus(s)], ["approval", "waits for approval"]);
});
