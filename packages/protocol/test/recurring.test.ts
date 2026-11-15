// Recurring queues, the pure part (recurring.ts): the schedule's forms and its next time, the standing approval's hash,
// a run's queue id and a recurring's state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Event } from "../src/schemas.ts";
import { everyText, nextOccurrence, parseEvery, recurringHash, recurringStatus, runQueueId } from "../src/recurring.ts";
import type { RecurringFile } from "../src/schemas.ts";

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test("the schedule's three forms, read in one written form; anything else is refused with the forms", () => {
  assert.deepEqual(parseEvery("daily 03:00"), { kind: "daily", hour: 3, minute: 0 });
  assert.deepEqual(parseEvery(" Mon  3:05 "), { kind: "weekly", day: 1, hour: 3, minute: 5 });
  assert.deepEqual(parseEvery("monthly 31 23:59"), { kind: "monthly", date: 31, hour: 23, minute: 59 });
  assert.equal(everyText(parseEvery("SUN 7:30")), "sun 07:30");
  assert.equal(everyText(parseEvery("monthly 1 0:00")), "monthly 1 00:00");
  for (const bad of ["weekly 03:00", "daily 24:00", "daily 3", "monday 03:00", "monthly 0 03:00", "monthly 32 03:00", "daily 03:00 extra", ""]) {
    assert.throws(() => parseEvery(bad), /"daily HH:MM", "<mon\.\.sun> HH:MM" .* or "monthly <day> HH:MM"/, bad);
  }
});

test("the next time: strictly after the given one, in local time; a monthly day past the month's end is its last day", () => {
  const daily = parseEvery("daily 03:00");
  assert.equal(nextOccurrence(daily, local(2026, 11, 16, 2, 59)), local(2026, 11, 16, 3, 0));
  assert.equal(nextOccurrence(daily, local(2026, 11, 16, 3, 0)), local(2026, 11, 17, 3, 0), "not the same time again");
  // 2026-11-16 is a Monday.
  const mon = parseEvery("mon 03:00");
  assert.equal(nextOccurrence(mon, local(2026, 11, 15, 12)), local(2026, 11, 16, 3));
  assert.equal(nextOccurrence(mon, local(2026, 11, 16, 3)), local(2026, 11, 23, 3));
  const m31 = parseEvery("monthly 31 03:00");
  assert.equal(nextOccurrence(m31, local(2026, 11, 1)), local(2026, 11, 30, 3), "November has 30 days");
  assert.equal(nextOccurrence(m31, local(2026, 11, 30, 4)), local(2026, 12, 31, 3));
  assert.equal(nextOccurrence(parseEvery("monthly 29 03:00"), local(2027, 2, 1)), local(2027, 2, 28, 3));
});

test("the standing approval's hash changes with the filled template, the values and the schedule, and not with key order", () => {
  const queue = { id: "R", title: "T", coding: true, steps: [{ id: "R1", title: "S", goal: "G" }] };
  const r = { params: { a: "1" }, every: "daily 03:00" };
  const h = recurringHash(queue, r);
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(recurringHash({ steps: queue.steps, coding: true, title: "T", id: "R" }, r), h, "key order does not count");
  assert.equal(recurringHash(queue, { ...r, every: "Daily 3:00" }), h, "the same schedule written otherwise");
  assert.notEqual(recurringHash({ ...queue, steps: [{ ...queue.steps[0]!, goal: "G2" }] }, r), h);
  assert.notEqual(recurringHash(queue, { ...r, params: { a: "2" } }), h);
  assert.notEqual(recurringHash(queue, { ...r, every: "daily 04:00" }), h);
  assert.notEqual(recurringHash({ ...queue, coding: false }, r), h);
});

test("a run's queue id: the recurring's id with the local date and time, numbered when taken", () => {
  const at = local(2026, 11, 16, 3, 5);
  assert.equal(runQueueId("weekly", at, () => false), "weekly-20261116-0305");
  const taken = new Set(["weekly-20261116-0305", "weekly-20261116-0305-2"]);
  assert.equal(runQueueId("weekly", at, (x) => taken.has(x)), "weekly-20261116-0305-3");
  assert.notEqual(runQueueId("weekly", local(2026, 11, 16, 15, 5), () => false), runQueueId("weekly", at, () => false), "two runs on one day");
});

test("a recurring's state: broken, paused, waiting for approval (none, or another hash), its previous run open, approved", () => {
  const r: RecurringFile = { protocol: 1, id: "R", template: "t", params: {}, every: "daily 03:00", set_by: "orchestrator", created_at: "x", updated_at: "x" };
  const ok = { template: {} as never, queue: {}, hash: "sha256:a" };
  assert.equal(recurringStatus(r, { problem: "no template t" }, false), "broken");
  assert.equal(recurringStatus({ ...r, paused: true }, ok, false), "paused");
  assert.equal(recurringStatus(r, ok, false), "needs_approval");
  assert.equal(recurringStatus({ ...r, approval: { hash: "sha256:b", at: "x" } }, ok, false), "needs_approval");
  assert.equal(recurringStatus({ ...r, approval: { hash: "sha256:a", at: "x" } }, ok, true), "waiting_previous");
  assert.equal(recurringStatus({ ...r, approval: { hash: "sha256:a", at: "x" } }, ok, false), "approved");
});

test("the orchestrator's recurring.set event carries no approval", () => {
  const e = Event.parse({ v: 1, id: "e", at: "2026-11-15T10:00:00Z", session: "o", type: "recurring.set", recurring: "R", template: "t", every: "daily 03:00", approval: { hash: "sha256:a", at: "x" } });
  assert.equal("approval" in e, false);
});
