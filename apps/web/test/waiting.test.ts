import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWaitText, moveOn, placeOf, waitingPosition } from "../src/waiting.ts";

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

test("one by one: the next item opens once the open one no longer waits, not before; the end when nothing waits", () => {
  const at = { project: "nexus", queue: "UX", step: "UX2" };
  assert.equal(moveOn(list, at), undefined, "the review still waits: stay");
  const after = list.filter((x) => x.name !== "review");
  assert.equal(moveOn(after, at)?.name, "question", "decided: the first that waits opens");
  // A question answered on a step that then waits for review: the same place still waits.
  const answered = [w("review", "honey", "W", "W4c"), ...list.slice(1)];
  assert.equal(moveOn(answered, { project: "honey", queue: "W", step: "W4c" }), undefined);
  assert.equal(moveOn([], at), undefined, "nothing left: the round ends");
});


test("questions on the same step have separate positions, including after one answer", () => {
  const questions = ["q3", "q2", "q1"].map((qid) => ({ ...w(qid, "p", "Q", "Q1"), qid }));
  const at = placeOf(questions[1]!);
  assert.equal(at.qid, "q2");
  assert.deepEqual(waitingPosition(questions, at), { at: 2, total: 3, next: questions[2] });
  assert.equal(moveOn(questions, at), undefined);
  const remaining = [questions[0]!, questions[2]!];
  assert.deepEqual(waitingPosition(remaining, at), { at: 0, total: 2, next: questions[0] });
  assert.equal(moveOn(remaining, at), questions[0]);
  assert.equal(waitingPosition(questions, { ...at, project: "other" }).at, 0);
  assert.equal(waitingPosition([w("review", "p", "Q", "Q1")], at).at, 0, "a review is a different destination");
});

test("a Merging back card's text: no leading queue (its first line names it), the checkout's path for the tooltip", () => {
  const text = "queue W: the checkout of main has uncommitted changes: commit or stash them, then merge (C:/Users/me/Temp/demo)";
  assert.deepEqual(mergeWaitText(text, "W"), { text: "the checkout of main has uncommitted changes: commit or stash them, then merge", path: "C:/Users/me/Temp/demo" });
  const held = String.raw`queue W: the checkout of main has uncommitted changes: commit, then merge (D:\work\demo app); the run of queue X, held at its step's end for this merge back, goes on`;
  assert.deepEqual(mergeWaitText(held, "W"), { text: "the checkout of main has uncommitted changes: commit, then merge; the run of queue X, held at its step's end for this merge back, goes on", path: String.raw`D:\work\demo app` });
  const own = "queue W's branch nexus/W moved on after its integration step (it ended at 1234567, the branch is at 89abcde): its work is not merged back";
  assert.deepEqual(mergeWaitText(own, "W"), { text: own }, "a possessive stays, and a parenthesis that is not a path too");
  assert.deepEqual(mergeWaitText("queue W: a reason", "X"), { text: "queue W: a reason" }, "another queue's name stays");
});
