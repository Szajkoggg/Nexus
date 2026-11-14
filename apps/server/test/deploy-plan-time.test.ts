// Planned deploys at a time, and provisional work (src/deploy-plan.ts, queue PD2): at the time the update starts, so no
// new step starts and the running ones finish; with a deadline a drain still waiting interrupts them, and they continue
// after the restart. With a project's provisional_counts off, a provisional step counts only once the user confirmed
// it, and the deploy waits while what it would deploy holds unconfirmed provisional work (also under a step accepted
// for good that builds on it), holding only the plan's own queue; on, it goes ahead. Same setup as deploy-plan.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmProvisional } from "@nexus/protocol";
import { planTime, readPlanFile } from "../src/deploy-plan.ts";
import { until, LONGER, holdWork, sleep } from "./wait.ts";
import { handedOver, setup, successor } from "./deploy-plan-setup.ts";

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

// ---------------------------------------------------------------- at a time

test("at a time without a deadline: the update starts then, no new step starts, and it waits for the running step", async () => {
  const work = holdWork();
  const t = setup(["slow", "done"]);
  let next: ReturnType<typeof successor> | undefined;
  try {
    t.engine().start("Q");
    await until("Q1 to run", () => t.queue().steps[0]!.status === "running", LONGER.step, t.show);
    const r = t.planner.set({ at: inMs(1200) });
    assert.match(r.text, /^a deploy is planned at \d{4}-\d\d-\d\d \d\d:\d\d \(until .*\); it waits for the running steps without a deadline$/);
    assert.equal(t.lifecycle.status.phase, "idle", "not before its time");
    await until("the drain at the time", () => t.lifecycle.status.phase === "draining", LONGER.step, t.show);
    await sleep(800);
    assert.equal(t.lifecycle.status.phase, "draining", "it waits for the running step");
    assert.deepEqual(t.statuses(), ["running", "pending"]);
    work.release();
    await until("the hand-over", handedOver(t), LONGER.processes, t.show);
    assert.deepEqual(t.statuses(), ["done", "pending"], "Q1 finished; Q2 did not start");
    assert.equal(readPlanFile().ended?.why, "carried-out");
    t.engine().shutdown();
    next = successor(t);
    await until("the queue to go on and finish", () => t.queue().run?.state === "finished", LONGER.run, t.show);
  } finally { t.stop(); next?.stop(); work.done(); }
});

test("at a time with a deadline: the running step is interrupted at the deadline and continues after the restart", async () => {
  const work = holdWork();
  const t = setup(["slow", "done"]);
  let next: ReturnType<typeof successor> | undefined;
  try {
    t.engine().start("Q");
    await until("Q1 to run", () => t.queue().steps[0]!.status === "running", LONGER.step, t.show);
    const r = t.planner.set({ at: inMs(800), deadline: inMs(2000) });
    assert.match(r.text, /the running steps are interrupted if it is still waiting for them/);
    await until("the drain at the time", () => t.lifecycle.status.phase === "draining", LONGER.step, t.show);
    assert.equal(t.lifecycle.status.now, false, "until the deadline it waits");
    await until("the hand-over after the deadline", handedOver(t), LONGER.processes, t.show);
    assert.equal(t.lifecycle.status.now, true);
    assert.ok(t.lifecycle.status.log.some((l) => /the deadline came: the running steps are interrupted/.test(l)));
    assert.deepEqual(t.statuses(), ["running", "pending"], "Q1 was interrupted, not finished");
    assert.equal(t.queue().run?.resume_after_restart, true);
    t.engine().shutdown();
    work.release();
    next = successor(t);
    await until("Q1 to continue and the queue to finish", () => t.queue().run?.state === "finished", LONGER.run, t.show);
    assert.deepEqual(t.statuses(), ["done", "done"]);
  } finally { t.stop(); next?.stop(); work.done(); }
});

test("times: HH:MM is its next occurrence, a local date and time, ISO; a passed time or a deadline before the time is refused", () => {
  const from = new Date(2026, 10, 14, 22, 0);
  assert.equal(planTime("6:30", from), new Date(2026, 10, 15, 6, 30).toISOString(), "tomorrow");
  assert.equal(planTime("23:15", from), new Date(2026, 10, 14, 23, 15).toISOString(), "today");
  assert.equal(planTime("2026-11-16 05:00", from), new Date(2026, 10, 16, 5, 0).toISOString());
  assert.equal(planTime("2026-11-16T05:00:00Z"), "2026-11-16T05:00:00.000Z");
  assert.throws(() => planTime("tomorrow"), /give the time as HH:MM/);
  assert.throws(() => planTime("25:00"), /not a time of day/);
  const t = setup(["done"]);
  try {
    assert.throws(() => t.planner.set({ at: inMs(-60_000) }), /has passed/);
    assert.throws(() => t.planner.set({ at: inMs(60_000), deadline: inMs(30_000) }), /is not after/);
    assert.throws(() => t.planner.set({ after: { project: "p", queue: "Q" }, deadline: inMs(60_000) }), /a deadline goes with a time/);
    assert.match(t.planner.set({ at: inMs(3_600_000) }).text, /a deploy is planned at/);
    assert.match(t.planner.cancel(), /the deploy planned at .* is cancelled/);
  } finally { t.stop(); }
});

// ---------------------------------------------------------------- provisional work

test("provisional work counts (the default): a step accepted provisionally is in, and the deploy goes ahead", async () => {
  const t = setup(["done", "done"], { reviewer: true, levels: { Q1: 3 } });
  try {
    t.planner.set({ after: { project: "p", queue: "Q", step: "Q1" } });
    t.engine().start("Q");
    await until("the hand-over", handedOver(t), LONGER.processes, t.show);
    assert.ok(t.queue().steps[0]!.provisional, "Q1 was accepted provisionally");
    assert.deepEqual(t.statuses(), ["done", "pending"]);
  } finally { t.stop(); }
});

test("provisional work does not count: the plan's step accepted provisionally holds only its queue until the user confirms it; a cancel lets the queue go on", async () => {
  const t = setup(["done", "done"], { reviewer: true, levels: { Q1: 3 }, provisionalCounts: false });
  try {
    t.planner.set({ after: { project: "p", queue: "Q", step: "Q1" } });
    t.engine().start("Q");
    await until("the hold", () => t.queue().run?.state === "paused" && !!readPlanFile().plan?.waiting_for, LONGER.step, t.show);
    assert.deepEqual(readPlanFile().plan?.waiting_for, ["Q/Q1"]);
    assert.match(t.queue().run!.reason!, /held for the deploy planned after step Q\/Q1, which waits for the user's confirmation of provisional work \(Q\/Q1\)/);
    assert.deepEqual(t.statuses(), ["done", "pending"], "nothing of Q2 started");
    assert.deepEqual(t.drains, [], "no update: everything else goes on");
    assert.match(t.planner.view()!.waiting!, /waits for the user's confirmation of provisional work: Q\/Q1/);
    assert.ok(t.pushed.some((n) => /waits for your confirmation of provisional work: Q\/Q1/.test(n.body)), "the user is told");
    assert.ok(t.planner.notices().some((n) => /waits: it would include provisional work the user has not confirmed \(Q\/Q1\).*queue Q is held/.test(n.fact)), "and the orchestrator");

    assert.match(t.planner.cancel(), /is cancelled/);
    await until("the queue to go on and finish", () => t.queue().run?.state === "finished", LONGER.run, t.show);
    assert.deepEqual(t.drains, []);
  } finally { t.stop(); }
});

for (const counts of [false, true]) {
  test(`provisional work ${counts ? "counts" : "does not count"}: a plan after a step accepted for good that builds on unconfirmed provisional work ${counts ? "deploys at once" : "waits for the user's confirmation, then deploys"}`, async () => {
    process.env.FAKE_SLOW_MS = "2500";
    const t = setup(["slow", "slow", "done"], { inRepo: true, reviewer: true, levels: { Q1: 3, Q2: 2 }, provisionalCounts: counts });
    let next: ReturnType<typeof successor> | undefined;
    try {
      t.planner.set({ after: { project: "p", queue: "Q", step: "Q2" }, ref: "dev" });
      t.engine().start("Q");
      await until("Q1 to run", () => t.queue().steps[0]!.status === "running", LONGER.step, t.show);
      t.commit("Q1's work");
      await until("Q2 to run", () => t.queue().steps[1]!.status === "running", LONGER.step, t.show);
      t.commit("Q2's work, on top of Q1's");
      if (counts) {
        await until("the hand-over", handedOver(t), LONGER.processes, t.show);
        assert.deepEqual(t.statuses(), ["done", "done", "pending"]);
        assert.ok(t.queue().steps[0]!.provisional);
        return;
      }
      await until("the hold", () => t.queue().run?.state === "paused" && !!readPlanFile().plan?.waiting_for, LONGER.step, t.show);
      assert.deepEqual(readPlanFile().plan?.waiting_for, ["Q/Q1"], "Q2 was accepted for good, but it builds on Q1");
      assert.deepEqual(t.statuses(), ["done", "done", "pending"]);
      assert.deepEqual(t.drains, []);
      confirmProvisional(t.store, "Q", "Q1");
      t.tick();
      await until("the hand-over", handedOver(t), LONGER.processes, t.show);
      assert.deepEqual(t.statuses(), ["done", "done", "pending"], "Q3 did not start");
      t.engine().shutdown();
      next = successor(t);
      await until("the held queue to go on after the restart", () => t.queue().run?.state === "finished", LONGER.run, t.show);
    } finally { t.stop(); next?.stop(); delete process.env.FAKE_SLOW_MS; }
  });
}
