// The morning digest on the dashboard: whether there is something new since a time, the four numbers, the outcome words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { digestTiles, hasNews, outcome, usageLine } from "../src/digest.ts";
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

test("the usage line: the 5-hour peak, the 7-day window now, the waits; what is unknown is left out", () => {
  assert.equal(usageLine({ turns: 12, peak_5h: 0.824, now_7d: 0.41, waits: 0, wait_ms: 0 }), "Usage: 5-hour window peak 82%, 7-day window now 41%, no waits");
  assert.match(usageLine({ turns: 3, peak_5h: 1, now_7d: 0.5, waits: 2, wait_ms: 65 * 60_000 }), /^Usage: 5-hour window peak 100%, 7-day window now 50%, 2 waits \(1 ?h 5 ?min in all\)$/);
  assert.match(usageLine({ turns: 3, now_7d: 0.07, waits: 1, wait_ms: 20 * 60_000 }), /^Usage: 7-day window now 7%, 1 wait \(20 ?min\)$/);
  assert.equal(usageLine({ turns: 0, waits: 0, wait_ms: 0 }), "Usage: no agent turns");
});
