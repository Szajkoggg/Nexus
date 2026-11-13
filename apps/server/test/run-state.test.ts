// The run's state transitions and the start and resume guards (src/run-state.ts), and runIsOlder (protocol): which
// fields each transition sets, clears and keeps, and which message each guard refuses with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionError, runIsOlder, type QueueView, type RunFile } from "@nexus/protocol";
import {
  assertCanResume, assertCanStart, startedRun, toFinished, toHalted, toHeldForUpdate, toPaused, toPausedByUser, toResumed,
  toRetryWait, toUnheld, toUsageWait,
} from "../src/run-state.ts";

/** A run with every field a transition may touch set, so what each one clears shows. */
const FULL: RunFile = {
  protocol: 1, session: "S1", state: "running", after: "P", reason: "an old reason", step: "Q2", nudged: true,
  started_at: "2026-01-01T09:00:00.000Z", updated_at: "2026-01-01T09:30:00.000Z", ended_at: "2026-01-01T09:20:00.000Z",
  resume_at: "2026-01-01T10:00:00.000Z", retries: 2, failure: "overloaded", rejected: "Q1", resume_after_restart: true,
  revision: 2, runtime: "claude", model: "sonnet", effort: "high", summary_asked: "Q1",
  switches: [{ at: "2026-01-01T09:10:00.000Z", from: "S0", to: "S1", step: "Q2", why: "context", fill: 0.7, summary: "written" }],
};

/** What a transition did to `before` (FULL by default): the fields set or changed, and the fields cleared. */
function delta(after: RunFile, before: RunFile = FULL): { set: Record<string, unknown>; cleared: string[] } {
  const set: Record<string, unknown> = {}, cleared: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = (after as Record<string, unknown>)[k], b = (before as Record<string, unknown>)[k];
    if (a === undefined && b !== undefined) cleared.push(k);
    else if (JSON.stringify(a) !== JSON.stringify(b)) set[k] = a;
  }
  return { set, cleared: cleared.sort() };
}

test("startedRun: a new running record of the revision, with the run's own values", () => {
  assert.deepEqual(startedRun({ session: "S", revision: 3, runtime: "codex", model: "m", effort: "low", after: "P", at: "2026-01-01T09:00:00.000Z" }), {
    protocol: 1, session: "S", state: "running", started_at: "2026-01-01T09:00:00.000Z", updated_at: "2026-01-01T09:00:00.000Z",
    revision: 3, runtime: "codex", model: "m", effort: "low", after: "P",
  });
});

test("toResumed: running, not nudged; reason, wait and hold cleared; a rejected run takes the approved revision", () => {
  const paused: RunFile = { ...FULL, state: "paused" };
  assert.deepEqual(delta(toResumed(paused, 5), paused), {
    set: { state: "running", nudged: false, revision: 5 },
    cleared: ["reason", "rejected", "resume_after_restart", "resume_at"],
  });
  const plain: RunFile = { ...paused, rejected: undefined };
  assert.deepEqual(delta(toResumed(plain, 5), plain), {
    set: { state: "running", nudged: false },
    cleared: ["reason", "resume_after_restart", "resume_at"],
  }, "without a rejection the revision stays");
});

test("toUnheld: back to running from an update's pausing; nudged and resume_at kept", () => {
  const pausing: RunFile = { ...FULL, state: "pausing" };
  assert.deepEqual(delta(toUnheld(pausing), pausing), { set: { state: "running" }, cleared: ["reason", "resume_after_restart"] });
});

test("toPausedByUser: pausing or paused with the reason; wait and hold dropped; a rejection recorded", () => {
  assert.deepEqual(delta(toPausedByUser(FULL, "paused by the user", { pausing: true })), {
    set: { state: "pausing", reason: "paused by the user" }, cleared: ["resume_after_restart", "resume_at"],
  });
  assert.deepEqual(delta(toPausedByUser(FULL, "stopped by the user")), {
    set: { state: "paused", reason: "stopped by the user" }, cleared: ["resume_after_restart", "resume_at"],
  });
  const unrejected: RunFile = { ...FULL, rejected: undefined };
  assert.deepEqual(delta(toPausedByUser(unrejected, "step Q2 was rejected by the user", { rejected: "Q2" }), unrejected), {
    set: { state: "paused", reason: "step Q2 was rejected by the user", rejected: "Q2" }, cleared: ["resume_after_restart", "resume_at"],
  });
});

test("toHeldForUpdate: pausing or paused with the reason, held for the restart; nothing cleared", () => {
  const free = { ...FULL, resume_after_restart: undefined };
  assert.deepEqual(delta(toHeldForUpdate(free, "updating", { pausing: true }), free), { set: { state: "pausing", reason: "updating", resume_after_restart: true }, cleared: [] });
  assert.deepEqual(delta(toHeldForUpdate(free, "updating"), free), { set: { state: "paused", reason: "updating", resume_after_restart: true }, cleared: [] });
});

test("toPaused: paused, everything else kept; the reason only when given", () => {
  const pausing: RunFile = { ...FULL, state: "pausing" };
  assert.deepEqual(delta(toPaused(pausing), pausing), { set: { state: "paused" }, cleared: [] });
  assert.deepEqual(delta(toPaused(FULL, "the Nexus server restarted")), { set: { state: "paused", reason: "the Nexus server restarted" }, cleared: [] });
});

test("toHalted: halted with the reason; wait and hold cleared; the failure set only when given", () => {
  assert.deepEqual(delta(toHalted(FULL, "stuck")), { set: { state: "halted", reason: "stuck" }, cleared: ["resume_after_restart", "resume_at"] });
  assert.deepEqual(delta(toHalted(FULL, "stuck", "authentication_failed")), {
    set: { state: "halted", reason: "stuck", failure: "authentication_failed" }, cleared: ["resume_after_restart", "resume_at"],
  });
});

test("toFinished: finished; reason, retries, failure, resume_at and the hold cleared", () => {
  assert.deepEqual(delta(toFinished(FULL)), {
    set: { state: "finished" }, cleared: ["failure", "reason", "resume_after_restart", "resume_at", "retries"],
  });
});

test("toUsageWait: usage_wait until the reset, with the reason; the hold cleared, retries kept", () => {
  assert.deepEqual(delta(toUsageWait(FULL, "the 5-hour window is full", "2026-01-01T14:00:00.000Z")), {
    set: { state: "usage_wait", reason: "the 5-hour window is full", resume_at: "2026-01-01T14:00:00.000Z" }, cleared: ["resume_after_restart"],
  });
});

test("toRetryWait: retry_wait at the time, counting the tries and naming the failure; the hold kept", () => {
  assert.deepEqual(delta(toRetryWait(FULL, { tries: 3, failure: "network", reason: "retry 3 of 5", at: "2026-01-01T10:04:00.000Z" })), {
    set: { state: "retry_wait", retries: 3, failure: "network", reason: "retry 3 of 5", resume_at: "2026-01-01T10:04:00.000Z" }, cleared: [],
  });
});

test("the transitions do not change the run they are given", () => {
  const copy = structuredClone(FULL);
  for (const f of [() => toResumed(FULL, 9), () => toUnheld(FULL), () => toPausedByUser(FULL, "x", { rejected: "Q9" }), () => toHeldForUpdate(FULL, "x"),
    () => toPaused(FULL, "x"), () => toHalted(FULL, "x", "y"), () => toFinished(FULL), () => toUsageWait(FULL, "x", "2026-01-02T00:00:00.000Z"),
    () => toRetryWait(FULL, { tries: 1, failure: "x", reason: "x", at: "2026-01-02T00:00:00.000Z" })]) f();
  assert.deepEqual(FULL, copy);
});

// ---------------------------------------------------------------- guards

/** A queue view with what the guards read. */
function view(o: Partial<QueueView> = {}): QueueView {
  return { id: "Q", revision: 2, approved: true, status: "approved", history: [], steps: [{ id: "Q1", status: "stopped" }], ...o } as unknown as QueueView;
}
const refuses = (f: () => void, message: string | RegExp) => assert.throws(f, (e: unknown) => {
  assert.ok(e instanceof ActionError);
  if (typeof message === "string") assert.equal(e.message, message); else assert.match(e.message, message);
  assert.equal(e.status, 409);
  return true;
});
const rejection = { step: "Q1" } as QueueView["rejection"];

test("assertCanStart: the refusals in their order, and a queue that may start", () => {
  assert.doesNotThrow(() => assertCanStart(view()));
  assert.doesNotThrow(() => assertCanStart(view({ run: { ...FULL, state: "halted" } as QueueView["run"] })), "an ended run is replaced");
  refuses(() => assertCanStart(view({ rejection, approved: false })), /^step Q1 of queue Q was rejected: the run goes on once you approve a new revision/);
  refuses(() => assertCanStart(view({ approved: false })), "approve the queue's current revision first");
  for (const state of ["running", "pausing", "usage_wait", "retry_wait"] as const) {
    refuses(() => assertCanStart(view({ run: { ...FULL, state } as QueueView["run"], status: "stopped" })), "the queue is already running");
  }
  refuses(() => assertCanStart(view({ status: "stopped", stop_step: "Q1", status_reason: "a fake stop" } as Partial<QueueView>)),
    "queue Q is stopped at step Q1: a fake stop. Only the user lifts a stop: with Continue in the dashboard, or by approving a new revision of the queue");
  refuses(() => assertCanStart(view({ status: "done" })), "the queue is done");
  refuses(() => assertCanStart(view({ status: "cancelled" })), "the queue is cancelled");
});

test("assertCanResume: the refusals in their order; an older revision's run only when it was rejected", () => {
  const run = { ...FULL, state: "paused", rejected: undefined, revision: 2 } as RunFile;
  assert.doesNotThrow(() => assertCanResume(view(), run));
  refuses(() => assertCanResume(view({ rejection, approved: false }), run), /^step Q1 of queue Q was rejected/);
  refuses(() => assertCanResume(view({ approved: false, status: "stopped" }), run), "approve the queue's current revision first");
  refuses(() => assertCanResume(view({ status: "stopped" }), run), /^queue Q is stopped: a stop condition was met\. Only the user lifts a stop/);
  refuses(() => assertCanResume(view({ status: "cancelled" }), run), "queue Q is cancelled");
  refuses(() => assertCanResume(view({ revision: 3 }), run),
    "the run belongs to revision 2 and the queue is at revision 3: start the queue instead of resuming");
  refuses(() => assertCanResume(view({ history: [{ revision: 1, replaced_at: "2026-01-01T09:05:00.000Z" }] } as Partial<QueueView>), { ...run, revision: undefined }),
    /^the run belongs to revision an earlier one and the queue is at revision 2/);
  assert.doesNotThrow(() => assertCanResume(view({ revision: 3 }), { ...run, rejected: "Q1" }), "a rejected run goes on after a newer approval");
});

test("runIsOlder: by the run's revision against the one given, else by a revision replaced after the run started", () => {
  const run = { revision: 2, started_at: "2026-01-01T09:00:00.000Z" };
  assert.equal(runIsOlder(run, 2, []), false);
  assert.equal(runIsOlder(run, 3, []), true);
  assert.equal(runIsOlder(run, 1, []), false);
  const old = { started_at: "2026-01-01T09:00:00.000Z" };
  assert.equal(runIsOlder(old, 5, []), false, "no revision and no history: not older");
  assert.equal(runIsOlder(old, 5, [{ revision: 4, replaced_at: "2026-01-01T08:00:00.000Z" } as never]), false, "replaced before the run started");
  assert.equal(runIsOlder(old, 5, [{ revision: 4, replaced_at: "2026-01-01T10:00:00.000Z" } as never]), true, "replaced after it started");
});
