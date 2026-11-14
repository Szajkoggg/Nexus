// The closing refactoring step (PROTOCOL.md, "The closing refactoring step"): `coding: true` adds a step Nexus keeps
// after the queue's own steps; the field is part of what an approval pins and stays once the queue has started; the
// step cannot be skipped, `nexus queue set finished` waits for it, and a step of the queue's own at work after it ran
// makes it run again at the end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionError, CLOSING_ACCEPTANCE, CLOSING_GOAL, CLOSING_TITLE, ProjectStore, applyDraft, approveQueue, closingStepId, isApproved,
  loadProjectState, newId, now, orchestratorStatusChange, revisionHash, setStepLevel, type Event, type QueueFile, type SessionFile,
} from "../src/index.ts";

function setup(coding: boolean | undefined) {
  const root = mkdtempSync(join(tmpdir(), "nexus-closing-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.writeQueue({
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }, { id: "Q2", title: "Two", goal: "", acceptance: [] }],
    approvals: [], history: [], ...(coding === undefined ? {} : { coding }),
  });
  const session = (role: SessionFile["role"]): SessionFile => {
    const s: SessionFile = { protocol: 1, id: newId(), project: "p", role, runtime: "external", cwd: root, launched_by: "external", created_at: now(), queue: "Q" };
    st.writeSession(s);
    return s;
  };
  // Events a millisecond apart, so their order is the order they were written in.
  let t = Date.now();
  const emit = (s: SessionFile, body: Record<string, unknown>) =>
    st.appendEvent({ v: 1, id: newId(), at: new Date(++t).toISOString(), session: s.id, ...body } as Event);
  const queue = () => loadProjectState(st).queues.find((q) => q.id === "Q")!;
  /** A step done and accepted (by the user's session, as the dashboard would). */
  const finish = (w: SessionFile, u: SessionFile, step: string) => {
    emit(w, { type: "step.started", queue: "Q", step });
    emit(w, { type: "step.done", queue: "Q", step, summary: `did ${step}` });
    emit(u, { type: "review.accepted", queue: "Q", step });
  };
  const draft = (def: Omit<Partial<QueueFile>, "steps"> & { steps: { id: string; title: string }[] }) =>
    applyDraft(st, { id: "Q", title: "Queue", stop_conditions: [], checks: [], ...def });
  return { st, session, emit, queue, finish, draft };
}

test("coding: true adds the closing step after the queue's steps, with the standard text and review level 2", () => {
  const x = setup(true);
  const q = x.queue();
  assert.deepEqual(q.steps.map((s) => s.id), ["Q1", "Q2", "Q.refactor"]);
  const c = q.steps.at(-1)!;
  assert.equal(c.id, closingStepId("Q"));
  assert.equal(c.closing, true);
  assert.equal(c.title, CLOSING_TITLE);
  assert.equal(c.goal, CLOSING_GOAL);
  assert.deepEqual(c.acceptance, [...CLOSING_ACCEPTANCE]);
  assert.match(c.goal, /AGENTS\.md has a "Refactoring" section/);
  assert.match(c.goal, /too small to be worth refactoring is a valid outcome/);
  assert.equal(c.status, "pending");
  assert.equal(c.level, 2);
  assert.equal(q.steps.filter((s) => s.closing).length, 1);
  // Not in the file: Nexus keeps it.
  assert.deepEqual(x.st.readQueue("Q").steps.map((s) => s.id), ["Q1", "Q2"]);
});

test("without coding (absent or false) there is no closing step", () => {
  for (const coding of [undefined, false]) {
    const x = setup(coding);
    assert.deepEqual(x.queue().steps.map((s) => s.id), ["Q1", "Q2"], `coding ${coding}`);
    assert.ok(!x.queue().steps.some((s) => s.closing));
  }
});

test("coding is part of what an approval pins; a queue without it keeps the hash it had before the field", () => {
  const off = setup(undefined).st.readQueue("Q");
  const on = { ...off, coding: true };
  assert.notEqual(revisionHash(on), revisionHash(off));
  assert.equal(revisionHash({ ...off, coding: false }), revisionHash(off));
  // The hash of the same content written before the field existed.
  const old = "sha256:" + createHash("sha256").update(JSON.stringify({ steps: off.steps.map(({ status: _s, status_note: _n, ...d }) => d), stop_conditions: off.stop_conditions, checks: off.checks })).digest("hex");
  assert.equal(revisionHash(off), old);

  // Setting it on an approved queue makes a new revision that needs the user's approval again.
  const x = setup(undefined);
  approveQueue(x.st, "Q");
  assert.match(x.draft({ coding: true, steps: [{ id: "Q1", title: "One" }, { id: "Q2", title: "Two" }] }), /revision 2; it needs the user's approval again/);
  assert.equal(isApproved(x.st.readQueue("Q")), false);
  assert.equal(x.queue().steps.at(-1)!.id, "Q.refactor");
});

test("a revision that adds steps keeps the closing step last", () => {
  const x = setup(true);
  approveQueue(x.st, "Q");
  x.emit(x.session("worker"), { type: "step.started", queue: "Q", step: "Q1" });
  x.draft({ steps: [{ id: "Q1", title: "One" }, { id: "Q2", title: "Two" }, { id: "Q3", title: "Three" }] });
  assert.equal(x.st.readQueue("Q").coding, true, "left out of the draft, it stays");
  assert.deepEqual(x.queue().steps.map((s) => s.id), ["Q1", "Q2", "Q3", "Q.refactor"]);
});

test("once the queue has started, a draft does not take coding back; before, it may", () => {
  const before = setup(true);
  approveQueue(before.st, "Q");
  before.draft({ coding: false, steps: [{ id: "Q1", title: "One" }, { id: "Q2", title: "Two" }] });
  assert.equal(before.st.readQueue("Q").coding, false);
  assert.deepEqual(before.queue().steps.map((s) => s.id), ["Q1", "Q2"]);

  const x = setup(true);
  approveQueue(x.st, "Q");
  x.emit(x.session("worker"), { type: "step.started", queue: "Q", step: "Q1" });
  assert.throws(() => x.draft({ coding: false, steps: [{ id: "Q1", title: "One" }, { id: "Q2", title: "Two" }] }),
    (e: ActionError) => /has started: a draft does not take back coding: true/.test(e.message));
  assert.equal(x.st.readQueue("Q").coding, true);

  // A run record alone (started, no step yet) counts as started too.
  const y = setup(true);
  approveQueue(y.st, "Q");
  y.st.writeRun("Q", { protocol: 1, session: "s", state: "paused", started_at: now(), updated_at: now() });
  assert.throws(() => y.draft({ coding: false, steps: [{ id: "Q1", title: "One" }, { id: "Q2", title: "Two" }] }), /does not take back coding/);
});

test("the closing step's id is reserved", () => {
  const x = setup(undefined);
  assert.throws(() => x.draft({ steps: [{ id: "Q1", title: "One" }, { id: "Q.refactor", title: "Mine" }] }), /reserved for the queue's closing refactoring step/);
});

test("the closing step cannot be skipped, and queue set finished waits for it", () => {
  const x = setup(true);
  approveQueue(x.st, "Q");
  const w = x.session("worker"), u = x.session("user");
  x.finish(w, u, "Q1"); x.finish(w, u, "Q2");
  x.st.writeRun("Q", { protocol: 1, session: w.id, state: "halted", reason: "x", step: "Q2", started_at: now(), updated_at: now() });
  assert.throws(() => orchestratorStatusChange(x.st, { queue: "Q", step: "Q.refactor", to: "skipped", reason: "small" }),
    (e: ActionError) => e.status === 409 && /closing refactoring step: it is not skipped/.test(e.message));
  assert.throws(() => orchestratorStatusChange(x.st, { queue: "Q", to: "finished", reason: "all done" }),
    (e: ActionError) => e.status === 409 && /Q\.refactor \(pending, the closing refactoring step/.test(e.message));
  assert.notEqual(x.queue().status, "done");

  // Once it has run, the halted run may be closed.
  x.finish(w, u, "Q.refactor");
  assert.equal(x.queue().status, "done");
  assert.match(orchestratorStatusChange(x.st, { queue: "Q", to: "finished", reason: "all done" }), /closed as finished/);
});

test("a step of the queue's own at work after the closing step ran makes it run again at the end", () => {
  const x = setup(true);
  approveQueue(x.st, "Q");
  const w = x.session("worker"), u = x.session("user");
  x.finish(w, u, "Q1"); x.finish(w, u, "Q2"); x.finish(w, u, "Q.refactor");
  assert.equal(x.queue().status, "done");
  // A revision adds Q3: the queue is not done any more, and the closing step stays done until Q3 is at work.
  x.draft({ steps: [{ id: "Q1", title: "One" }, { id: "Q2", title: "Two" }, { id: "Q3", title: "Three" }] });
  approveQueue(x.st, "Q");
  assert.notEqual(x.queue().status, "done");
  x.emit(w, { type: "step.started", queue: "Q", step: "Q3" });
  const c = x.queue().steps.at(-1)!;
  assert.equal(c.id, "Q.refactor");
  assert.equal(c.status, "pending");
  assert.equal(c.summary, undefined);
  x.emit(w, { type: "step.done", queue: "Q", step: "Q3", summary: "did Q3" });
  x.emit(u, { type: "review.accepted", queue: "Q", step: "Q3" });
  assert.equal(x.queue().status, "running", "not done while the closing step has to run again");
  x.finish(w, u, "Q.refactor");
  assert.equal(x.queue().status, "done");
  assert.equal(x.queue().steps.at(-1)!.segments.length, 2, "it ran twice");
});

test("the user may set the closing step's level, and a revision keeps it", () => {
  const x = setup(true);
  setStepLevel(x.st, "Q", "Q.refactor", 1);
  assert.equal(x.queue().steps.at(-1)!.level, 1);
  x.draft({ steps: [{ id: "Q1", title: "One" }, { id: "Q2", title: "Two" }, { id: "Q3", title: "Three" }] });
  assert.deepEqual(x.st.readQueue("Q").user_levels, { "Q.refactor": 1 });
});
