// The away mode's pure rules (away.ts): when it is on, "8:00" as the next such local time, turning on and off, and
// the end at its time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AwayFile, awayAt, awayNow, awayUntil, expireAway, levelNow, turnAway } from "../src/index.ts";

const empty = (): AwayFile => AwayFile.parse({ protocol: 1 });

test("8:00 is the next such local time; an ISO time must be ahead; anything else is refused", () => {
  const now = new Date(2026, 10, 14, 23, 30); // 23:30 local
  assert.equal(awayUntil("8:00", now), new Date(2026, 10, 15, 8, 0).toISOString(), "tomorrow");
  assert.equal(awayUntil("23:45", now), new Date(2026, 10, 14, 23, 45).toISOString(), "later today");
  assert.equal(awayUntil("23:30", now), new Date(2026, 10, 15, 23, 30).toISOString(), "now is not ahead: tomorrow");
  assert.equal(awayUntil("2026-11-16T07:00:00.000Z", now), "2026-11-16T07:00:00.000Z");
  for (const bad of ["25:00", "8", "", "soon", "2020-01-01T00:00:00Z", 8]) assert.throws(() => awayUntil(bad, now), /until/);
});

test("on until a time, off by the user or at its time; each period stays on record", () => {
  const t0 = new Date("2026-11-14T20:00:00Z");
  let a = turnAway(empty(), "2026-11-15T07:00:00.000Z", t0);
  assert.deepEqual(a.current, { since: t0.toISOString(), until: "2026-11-15T07:00:00.000Z" });
  assert.deepEqual(awayNow(a, new Date("2026-11-14T23:00:00Z")), { on: true, since: t0.toISOString(), until: "2026-11-15T07:00:00.000Z" });
  a = turnAway(a, "2026-11-15T08:00:00.000Z", new Date("2026-11-14T21:00:00Z"));
  assert.equal(a.current!.since, t0.toISOString(), "a new end keeps the start");
  assert.deepEqual(awayNow(a, new Date("2026-11-15T09:00:00Z")), { on: false }, "past its end it is off, recorded or not");
  const expired = expireAway(a, new Date("2026-11-15T09:00:00Z"));
  assert.deepEqual([expired.current, expired.past.at(-1)!.why, expired.past.at(-1)!.ended], [undefined, "expired", "2026-11-15T08:00:00.000Z"]);
  assert.equal(expireAway(expired, new Date("2026-11-15T09:00:00Z")), expired, "nothing to expire: the same file");

  const off = turnAway(turnAway(expired, "2026-11-16T07:00:00.000Z", new Date("2026-11-15T20:00:00Z")), null, new Date("2026-11-15T22:00:00Z"));
  assert.deepEqual(off.past.map((p) => p.why), ["expired", "off"]);
  assert.equal(awayAt(off, "2026-11-14T22:00:00.000Z"), true, "during the first period");
  assert.equal(awayAt(off, "2026-11-15T21:00:00.000Z"), true, "during the second, before it was turned off");
  assert.equal(awayAt(off, "2026-11-15T23:00:00.000Z"), false);
  assert.deepEqual([levelNow(2, { on: true }), levelNow(1, { on: true }), levelNow(3, { on: false }), levelNow(2, { on: false })], [3, 1, 3, 2]);
});
