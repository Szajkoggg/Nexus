import { test } from "node:test";
import assert from "node:assert/strict";
import { placeOf, waitingPosition } from "../src/waiting.ts";

type W = { project: string; queue?: string; step?: string; lift?: { place: string; continue: boolean; revision: number }; name: string };
const lift = { place: " at step W4c", continue: true, revision: 1 };
const w = (name: string, project: string, queue?: string, step?: string, stopped = false): W => ({ name, project, queue, step, ...(stopped ? { lift } : {}) });
// Newest first, as mergeAttention orders them.
const list: W[] = [
  w("question", "honey", "W", "W4c"),
  w("review", "nexus", "UX", "UX2"),
  w("stopped", "honey", "W", "W4c", true),
  w("approval", "nexus", "SC"),
];

test("an item's place: its step, or its queue for a stopped queue's item (whose stop box has Continue)", () => {
  assert.deepEqual(placeOf(list[0]!), { project: "honey", queue: "W", step: "W4c" });
  assert.deepEqual(placeOf(list[2]!), { project: "honey", queue: "W", step: undefined });
});

test("where a place stands, 1 of N, and the next item after it", () => {
  assert.deepEqual(waitingPosition(list, { project: "honey", queue: "W", step: "W4c" }), { at: 1, total: 4, next: list[1] });
  assert.deepEqual(waitingPosition(list, { project: "nexus", queue: "UX", step: "UX2" }), { at: 2, total: 4, next: list[2] });
  assert.deepEqual(waitingPosition(list, { project: "honey", queue: "W" }), { at: 3, total: 4, next: list[3] }, "the stopped queue's place");
});

test("after the last, next wraps round to the first", () => {
  assert.deepEqual(waitingPosition(list, { project: "nexus", queue: "SC" }), { at: 4, total: 4, next: list[0] });
});

test("several items at one place count as the first; next skips the others there", () => {
  const two = [w("question", "p", "Q", "Q1"), w("review", "p", "Q", "Q1"), w("approval", "p", "R")];
  assert.deepEqual(waitingPosition(two, { project: "p", queue: "Q", step: "Q1" }), { at: 1, total: 3, next: two[2] });
});

test("a place no longer waiting (just answered) has no position; next is the first that waits", () => {
  assert.deepEqual(waitingPosition(list, { project: "nexus", queue: "UX", step: "UX1" }), { at: 0, total: 4, next: list[0] });
  assert.deepEqual(waitingPosition([], { project: "p" }), { at: 0, total: 0, next: undefined });
});

test("the only place that waits has no next", () => {
  const one = [w("question", "p", "Q", "Q1"), w("review", "p", "Q", "Q1")];
  assert.deepEqual(waitingPosition(one, { project: "p", queue: "Q", step: "Q1" }), { at: 1, total: 2 });
});

test("a place in another project with the same queue and step is another place", () => {
  assert.equal(waitingPosition(list, { project: "nexus", queue: "W", step: "W4c" }).at, 0);
});
