// The morning digest on the dashboard: whether there is something new since a time, the four numbers, the outcome words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { digestTiles, hasNews, outcome } from "../src/digest.ts";
import type { DigestEvent } from "@nexus/protocol/digest";

const T = (hhmm: string) => `2026-11-13T${hhmm}:00.000Z`;
const ev = (at: string, kind: DigestEvent["kind"], over: Partial<DigestEvent> = {}): DigestEvent =>
  ({ at, kind, project: "honey", project_name: "Honeycomb", queue: "W", text: "", ...over });

test("something new: a line after the time, or an item that came to wait after it", () => {
  assert.equal(hasNews([], [], T("08:00")), false);
  assert.equal(hasNews([ev(T("07:00"), "done")], [{ at: T("06:00") }], T("08:00")), false, "all of it before the time");
  assert.equal(hasNews([ev(T("08:30"), "done")], [], T("08:00")), true);
  assert.equal(hasNews([], [{ at: T("09:00") }, { at: undefined }], T("08:00")), true);
  assert.equal(hasNews([], [{ at: T("08:00") }], T("08:00")), false, "exactly at the time is seen");
});

test("the four numbers: finished and stopped since the time, waiting and running now", () => {
  const events = [
    ev(T("10:43"), "stopped", { step: "W4c" }), ev(T("10:00"), "stopped", { queue: "R" }),
    ev(T("08:20"), "done", { step: "W4b" }), ev(T("08:10"), "done"), ev(T("08:10"), "queue_done"), ev(T("02:00"), "refused", { count: 3 }),
  ];
  const waiting = [{ kind: "question" as const }, { kind: "question" as const }, { kind: "review" as const }, { kind: "approval" as const }];
  const t = digestTiles(events, waiting, [{ project: "nexus", project_name: "Nexus", queue: "SF", step: "SF3", since: T("10:20") }], new Date(T("11:00")));
  assert.deepEqual(t.finished, { n: 2, text: "steps finished · 1 queue done" });
  assert.deepEqual(t.stopped, { n: 2, text: "queues stopped · Honeycomb W at W4c" });
  assert.deepEqual(t.waiting, { n: 4, text: "waiting for you · 2 questions, 1 review, 1 approval" });
  assert.equal(t.running.n, 1);
  assert.match(t.running.text, /^running now · SF3, 40 ?min in$/);
  const none = digestTiles([], [], []);
  assert.deepEqual([none.finished, none.stopped, none.waiting, none.running], [
    { n: 0, text: "steps finished" }, { n: 0, text: "queues stopped" }, { n: 0, text: "waiting for you" }, { n: 0, text: "running now" },
  ]);
});

test("outcome words", () => {
  assert.deepEqual(outcome({ kind: "stopped", step: "W4c" }), { word: "stopped at W4c", tone: "stop" });
  assert.equal(outcome({ kind: "refused", count: 1 }).word, "1 refused action");
  assert.equal(outcome({ kind: "refused", count: 3 }).word, "3 refused actions");
  assert.equal(outcome({ kind: "retried", count: 2 }).word, "retried twice");
  assert.equal(outcome({ kind: "retried", count: 5 }).word, "retried 5 times");
  assert.equal(outcome({ kind: "queue_done" }).word, "queue done");
});
