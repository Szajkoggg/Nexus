// The checks Nexus runs, as the derivation reads them (checks.ts, applyCheckSets): a step.done whose checks have not
// passed is no review yet; a failed set is a check-fix round, apart from the review rounds; a disputed failure runs on
// the base or waits for the orchestrator's decision; an accepted one goes to review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, loadProjectState, newId, type CheckSet, type Event } from "../src/index.ts";

process.env.NEXUS_HOME ??= mkdtempSync(join(tmpdir(), "nexus-checks-home-"));
const T0 = Date.parse("2026-11-18T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function setup(level?: 1 | 2) {
  const root = mkdtempSync(join(tmpdir(), "nexus-checks-state-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0), queue: "Q" });
  store.writeQueue({ protocol: 1, id: "Q", title: "Q", revision: 1, status: "proposed", ...(level ? { review_level: level } : {}), stop_conditions: [], checks: ["npm test"], steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }] });
  approveQueue(store, "Q");
  const emit = (s: number, body: Record<string, unknown>) => { const e = { v: 1, id: newId(), at: at(s), session: "w", ...body } as Event; store.appendEvent(e); return e; };
  const done = (s: number) => emit(s, { type: "step.done", queue: "Q", step: "Q1", summary: "done" }).id;
  const sets = (list: CheckSet[]) => store.writeChecks("Q", { protocol: 1, steps: { Q1: { by: "nexus", sets: list } } });
  const set = (d: string, o: Partial<CheckSet>): CheckSet => ({ done: d, round: 1, fix: 0, requested_at: at(1), state: "queued", checks: [], ...o });
  const step = () => loadProjectState(store).queues[0]!.steps[0]!;
  emit(0, { type: "step.started", queue: "Q", step: "Q1" });
  return { store, emit, done, sets, set, step };
}

const failedRun = { name: "npm test", command: "npm test", ok: false, runs: [{ started_at: at(2), ended_at: at(3), exit_code: 1, duration: 1, log: "checks/Q1/x.log", failed_tests: ["a"] }] };

test("a step.done with no set yet, or a set waiting or running, is checking", () => {
  const x = setup();
  const d = x.done(1);
  x.sets([]);
  assert.deepEqual([x.step().status, x.step().checking?.phase], ["checking", "queued"]);
  x.sets([x.set(d, { state: "running", granted_at: at(2), checks: [{ name: "npm test", command: "npm test", runs: [{ started_at: at(2), log: "l" }] }] })]);
  assert.deepEqual([x.step().status, x.step().checking], ["checking", { phase: "running", since: at(2), check: "npm test" }]);
  assert.equal(loadProjectState(x.store).queues[0]!.status, "running", "the queue waits for nothing but its checks");
  x.sets([x.set(d, { state: "interrupted" })]);
  assert.deepEqual([x.step().status, x.step().checking?.phase], ["checking", "queued"]);
});

test("passed: its review; failed: a check-fix round that is no review round; the next done's pass counts one round", () => {
  const x = setup();
  const d1 = x.done(1);
  x.sets([x.set(d1, { state: "failed", checks: [failedRun] })]);
  assert.deepEqual([x.step().status, x.step().check_fix, x.step().review_with], ["running", 1, undefined]);
  assert.deepEqual(x.step().checks.map((c) => [c.ok, c.by]), [[false, "nexus"]], "the result joins the step's checks");
  x.emit(10, { type: "step.started", queue: "Q", step: "Q1" });
  const d2 = x.done(11);
  x.sets([x.set(d1, { state: "failed", checks: [failedRun] }), x.set(d2, { state: "passed", fix: 1 })]);
  assert.equal(x.step().status, "review");
  // A send-back now opens round 2, not 3: the fix round's done does not count.
  const worker = x.store.readSession("w");
  x.store.writeSession({ ...worker, id: "o", role: "orchestrator", queue: undefined });
  x.store.appendEvent({ v: 1, id: newId(), at: at(20), session: "o", type: "review.sent_back", queue: "Q", step: "Q1", text: "again" } as Event);
  assert.equal(x.step().sent_back[0]!.round, 2);
});

test("a dispute: the base run to come or running is checking; not runnable there, it waits for the decision; accepted: review", () => {
  const x = setup();
  const d = x.done(1);
  x.sets([x.set(d, { state: "failed", checks: [failedRun] })]);
  x.emit(5, { type: "check.disputed", queue: "Q", step: "Q1", name: "npm test", evidence: "fails on main" });
  assert.deepEqual([x.step().status, x.step().checking?.phase], ["checking", "base"], "taken up by the engine next");
  const dispute = { event: "e", name: "npm test", evidence: "fails on main", at: at(5) };
  x.sets([x.set(d, { state: "failed", checks: [failedRun], dispute: { ...dispute, base: { state: "running" } } })]);
  assert.deepEqual([x.step().status, x.step().checking?.phase, x.step().checking?.check], ["checking", "base", "npm test"]);
  x.sets([x.set(d, { state: "failed", checks: [failedRun], dispute: { ...dispute, base: { state: "unrunnable", reason: "Missing script" } } })]);
  assert.deepEqual([x.step().status, x.step().checking?.phase], ["waiting", "decision"]);
  assert.equal(loadProjectState(x.store).queues[0]!.status, "waiting");
  x.sets([x.set(d, { state: "failed", checks: [failedRun], dispute: { ...dispute, base: { state: "passed" }, outcome: "fix" } })]);
  assert.deepEqual([x.step().status, x.step().check_fix], ["running", 1], "passing on the base: the queue's to fix");
  x.sets([x.set(d, { state: "accepted", checks: [failedRun], dispute: { ...dispute, base: { state: "failed" }, outcome: "accepted" } })]);
  assert.equal(x.step().status, "review");
});

test("a step whose checks the worker reports (by: worker, or no entry) goes to review at its done as before", () => {
  const x = setup();
  x.done(1);
  assert.equal(x.step().status, "review");
  x.store.writeChecks("Q", { protocol: 1, steps: { Q1: { by: "worker", sets: [] } } });
  assert.equal(x.step().status, "review");
});

test("a check-fix round the worker took up with nexus step start stays that round; its dispute is read; accepted, it goes to review", () => {
  const x = setup();
  const d = x.done(1);
  x.sets([x.set(d, { state: "failed", checks: [failedRun] })]);
  x.emit(5, { type: "step.started", queue: "Q", step: "Q1" });
  assert.deepEqual([x.step().status, x.step().check_fix, x.step().check_fix_limit], ["running", 1, 3], "the round, with the project's limit");
  x.emit(6, { type: "check.disputed", queue: "Q", step: "Q1", name: "npm test", evidence: "fails on main" });
  assert.deepEqual([x.step().status, x.step().checking?.phase], ["checking", "base"], "the engine runs it on the base next");
  const dispute = { event: "e", name: "npm test", evidence: "fails on main", at: at(6) };
  x.sets([x.set(d, { state: "failed", checks: [failedRun], dispute: { ...dispute, base: { state: "unrunnable", reason: "Missing script" } } })]);
  assert.deepEqual([x.step().status, x.step().checking?.phase], ["waiting", "decision"]);
  x.sets([x.set(d, { state: "accepted", checks: [failedRun], dispute: { ...dispute, base: { state: "failed" }, outcome: "accepted" } })]);
  const st = x.step();
  assert.deepEqual([st.status, st.finished_at], ["review", at(1)], "its review, as of the done");
  assert.equal(st.review_with, "user", "whose review the done made it (level 1 here), kept");
  assert.equal(loadProjectState(x.store).queues[0]!.status, "waiting");
});

test("a step started again after a passed set (a send-back) is no check-fix round", () => {
  const x = setup();
  const d = x.done(1);
  x.sets([x.set(d, { state: "passed" })]);
  x.emit(5, { type: "step.started", queue: "Q", step: "Q1" });
  assert.deepEqual([x.step().status, x.step().check_fix], ["running", undefined]);
});

// Queue NL: the verdicts on a step whose accepted check failure came out of a check-fix round the worker took up
// (ND/ND1 on 2026-11-19). The derivation replays the events with the step "running" since that round's step.started;
// before NL2 only applyCheckSets, after the replay, sent it to its review, and every verdict in between was weighed
// against "running" and dropped: the helper's pass-on (with a warning), the orchestrator's and the user's acceptances
// (silently). Now a verdict finds the step in its review (checks.ts, enterAcceptedReview).
function acceptedAfterTakenUpRound(level: 1 | 2) {
  const x = setup(level);
  // An orchestrator to review it (else a level-2 review goes to the user).
  if (level === 2) x.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: null } }));
  const d = x.done(1);
  x.sets([x.set(d, { state: "failed", checks: [failedRun] })]);
  x.emit(5, { type: "step.started", queue: "Q", step: "Q1" });
  x.emit(6, { type: "check.disputed", queue: "Q", step: "Q1", name: "npm test", evidence: "fails on main" });
  const dispute = { event: "e", name: "npm test", evidence: "fails on main", at: at(6) };
  x.sets([x.set(d, { state: "accepted", checks: [failedRun], dispute: { ...dispute, base: { state: "failed" }, outcome: "accepted" } })]);
  return x;
}

test("an accepted check failure of a taken-up round: the helper's pass-on and the orchestrator's acceptance count", () => {
  const x = acceptedAfterTakenUpRound(2);
  const worker = x.store.readSession("w");
  assert.deepEqual([x.step().status, x.step().review_with], ["review", "orchestrator"], "its review, the orchestrator's");
  x.store.writeSession({ ...worker, id: "h", role: "helper", queue: undefined, created_at: at(7), about: { queue: "Q", step: "Q1", round: 1, level: 2 } });
  assert.deepEqual(x.step().helper, { session: "h", round: 1, state: "running" }, "the helper has the review");
  x.store.appendEvent({ v: 1, id: newId(), at: at(8), session: "h", type: "review.passed_on", queue: "Q", step: "Q1", round: 1, reasons: ["deviation"], text: "a deviation" } as Event);
  const passed = loadProjectState(x.store);
  assert.deepEqual(passed.warnings, [], "no event is dropped");
  assert.equal(passed.queues[0]!.steps[0]!.helper?.state, "passed_on", "the pass-on counts: the orchestrator gets its notice");
  x.store.writeSession({ ...worker, id: "o", role: "orchestrator", queue: undefined });
  x.store.appendEvent({ v: 1, id: newId(), at: at(9), session: "o", type: "review.accepted", queue: "Q", step: "Q1", text: "fine" } as Event);
  assert.deepEqual([x.step().status, x.step().accepted?.by], ["done", "orchestrator"], "the orchestrator's acceptance counts");
});

test("an accepted check failure of a taken-up round: the user's acceptance at level 1 counts", () => {
  const x = acceptedAfterTakenUpRound(1);
  assert.deepEqual([x.step().status, x.step().review_with], ["review", "user"]);
  const worker = x.store.readSession("w");
  x.store.writeSession({ ...worker, id: "user", role: "user", queue: undefined });
  x.store.appendEvent({ v: 1, id: newId(), at: at(9), session: "user", type: "review.accepted", queue: "Q", step: "Q1" } as Event);
  assert.deepEqual([x.step().status, x.step().accepted?.by], ["done", "user"], "the user's acceptance counts");
});

/** The sessions that give verdicts, beside the worker "w": the orchestrator "o", the user, a round-1 helper "h". */
function verdictSessions(x: ReturnType<typeof setup>, level: 1 | 2 | 3 = 2) {
  const worker = x.store.readSession("w");
  x.store.writeSession({ ...worker, id: "o", role: "orchestrator", queue: undefined });
  x.store.writeSession({ ...worker, id: "user", role: "user", queue: undefined });
  x.store.writeSession({ ...worker, id: "h", role: "helper", queue: undefined, created_at: at(7), about: { queue: "Q", step: "Q1", round: 1, level } });
  const verdict = (session: string, s: number, body: Record<string, unknown>) => {
    const e = { v: 1, id: newId(), at: at(s), session, queue: "Q", step: "Q1", ...body } as Event;
    x.store.appendEvent(e);
    return e;
  };
  return verdict;
}

test("an accepted check failure of a taken-up round: the helper's acceptance counts", () => {
  const x = acceptedAfterTakenUpRound(2);
  const verdict = verdictSessions(x);
  verdict("h", 8, { type: "review.accepted", text: "fine" });
  const st = x.step();
  assert.deepEqual([st.status, st.accepted?.by], ["done", "helper"], JSON.stringify(loadProjectState(x.store).warnings));
});

test("an accepted check failure of a taken-up round: the orchestrator's send-back opens round 2, and its done goes to checks, not back to review", () => {
  const x = acceptedAfterTakenUpRound(2);
  const verdict = verdictSessions(x);
  const back = verdict("o", 8, { type: "review.sent_back", text: "again" });
  assert.deepEqual([x.step().status, x.step().sent_back.map((b) => [b.round, b.delivered])], ["review", [[2, false]]], "waits for the server to deliver it");
  x.store.appendInbox("w", { v: 1, id: "sb", at: at(9), from: "orchestrator", type: "send_back", ref: back.id, queue: "Q", step: "Q1", text: "again", round: 2 });
  assert.equal(x.step().status, "running", "delivered: the worker's round 2, not the review of the accepted set again");
  x.emit(10, { type: "step.started", queue: "Q", step: "Q1" });
  assert.equal(x.step().status, "running", "started for round 2: no check-fix round of the accepted set");
});

test("an accepted check failure of a taken-up round: the user's level 1 hands it over, and the user's rejection counts", () => {
  const x = acceptedAfterTakenUpRound(2);
  const verdict = verdictSessions(x);
  verdict("user", 8, { type: "review.asked_user", text: "The user set the step's review level to 1: they review it themselves." });
  assert.deepEqual([x.step().status, x.step().review_with, x.step().asked_user?.by], ["review", "user", "user"], JSON.stringify(loadProjectState(x.store).warnings));
  verdict("user", 9, { type: "review.rejected", text: "not this way" });
  assert.equal(x.step().status, "rejected");
});

test("an accepted check failure of a taken-up round: the orchestrator's provisional acceptance at level 3 counts", () => {
  const x = setup(3 as 2);
  x.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: null } }));
  const d = x.done(1);
  x.sets([x.set(d, { state: "failed", checks: [failedRun] })]);
  x.emit(5, { type: "step.started", queue: "Q", step: "Q1" });
  x.emit(6, { type: "check.disputed", queue: "Q", step: "Q1", name: "npm test", evidence: "fails on main" });
  x.sets([x.set(d, { state: "accepted", checks: [failedRun], dispute: { event: "e", name: "npm test", evidence: "fails on main", at: at(6), base: { state: "failed" }, outcome: "accepted" } })]);
  const verdict = verdictSessions(x, 3);
  verdict("h", 8, { type: "review.passed_on", round: 1, reasons: ["level"], text: "level 3" });
  assert.equal(x.step().helper?.state, "passed_on");
  verdict("o", 9, { type: "review.provisional", text: "looks right" });
  assert.deepEqual([x.step().status, x.step().provisional?.text], ["done", "looks right"], JSON.stringify(loadProjectState(x.store).warnings));
});

test("a verdict written before Nexus accepted the failure still does not count", () => {
  const x = acceptedAfterTakenUpRound(1);
  const d = x.step().timeline.find((e) => e.type === "step.done")!.id;
  x.sets([x.set(d, { state: "accepted", ended_at: at(20), checks: [failedRun], dispute: { event: "e", name: "npm test", evidence: "fails on main", at: at(6), base: { state: "failed" }, outcome: "accepted" } })]);
  const verdict = verdictSessions(x, 1);
  verdict("user", 8, { type: "review.accepted" });
  assert.equal(x.step().status, "review", "the acceptance at 8 came before the failure was accepted at 20");
  verdict("user", 21, { type: "review.accepted" });
  assert.equal(x.step().status, "done");
});
