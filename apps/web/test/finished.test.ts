import { test } from "node:test";
import assert from "node:assert/strict";
import { finishOf, splitFinished, type QueueLike } from "../src/finished.ts";

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 13, h, m)).toISOString();
const q = (id: string, status: string, steps: QueueLike["steps"] = [], extra: Partial<QueueLike> = {}): QueueLike => ({ id, status, steps, ...extra });

test("active and finished split; done and cancelled are finished; the active keep their order", () => {
  const { active, finished } = splitFinished([
    q("A", "running"), q("B", "done", [{ status: "done", finished_at: at(9) }]), q("C", "proposed"),
    q("D", "cancelled", [], { updated: at(8) }), q("E", "stopped"), q("F", "waiting"),
  ]);
  assert.deepEqual(active.map((x) => x.id), ["A", "C", "E", "F"]);
  assert.deepEqual(finished.map((x) => x.queue.id), ["B", "D"]);
});

test("a finished queue that still waits for the user stays active: a step in review, an open question, the attention list", () => {
  const { active, finished } = splitFinished([
    q("R", "done", [{ status: "done", finished_at: at(9) }, { status: "review", finished_at: at(10) }]),
    q("Q", "done", [{ status: "done", finished_at: at(9) }], { questions: [{ state: "escalated" }] }),
    q("W", "done", [{ status: "done", finished_at: at(9) }]),
    q("X", "done", [{ status: "done", finished_at: at(9) }], { questions: [{ state: "answered" }] }),
  ], new Set(["W"]));
  assert.deepEqual(active.map((x) => x.id), ["R", "Q", "W"]);
  assert.deepEqual(finished.map((x) => x.queue.id), ["X"]);
});

test("the most recently finished first; a queue without a finish time last", () => {
  const { finished } = splitFinished([
    q("old", "done", [{ status: "done", started_at: at(6), finished_at: at(7) }]),
    q("none", "cancelled"),
    q("new", "done", [{ status: "done", started_at: at(10), finished_at: at(11, 30) }, { status: "skipped" }]),
    q("mid", "done", [], { run: { started_at: at(8), ended_at: at(9) } }),
    q("none2", "done", [{ status: "skipped" }]),
  ]);
  assert.deepEqual(finished.map((x) => x.queue.id), ["new", "mid", "old", "none", "none2"]);
  assert.deepEqual([finished[0]!.finished_at, finished[0]!.ran_ms], [at(11, 30), 90 * 60_000]);
  assert.equal(finished[3]!.finished_at, undefined);
});

test("the finish time: the last step outcome, else the run's end, else the latest event; the run time from the first start", () => {
  assert.deepEqual(finishOf(q("a", "done", [{ status: "done", started_at: at(8), finished_at: at(9) }, { status: "done", started_at: at(9), finished_at: at(10) }])),
    { finished_at: at(10), ran_ms: 2 * 3_600_000 });
  assert.deepEqual(finishOf(q("b", "done", [], { run: { started_at: at(8), ended_at: at(8, 45) } })), { finished_at: at(8, 45), ran_ms: 45 * 60_000 });
  assert.deepEqual(finishOf(q("c", "cancelled", [], { updated: at(12) })), { finished_at: at(12), ran_ms: undefined });
});
