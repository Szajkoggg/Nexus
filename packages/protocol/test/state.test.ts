import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, loadProjectState, newId, now, revisionHash, type Event, type QueueFile, type SessionFile } from "../src/index.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-test-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root, });
  const q: QueueFile = { withdrawals: [], changes: [],
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [],
    steps: [
      { id: "Q1", title: "One", goal: "", acceptance: [] },
      { id: "Q2", title: "Two", goal: "", acceptance: [], review: { policy: "wait" } },
    ],
    approvals: [], history: [],
  };
  st.writeQueue(q);
  const session = (role: SessionFile["role"]): SessionFile => {
    const s: SessionFile = { protocol: 1, id: newId(), project: "p", role, runtime: "external", cwd: root, launched_by: "external", created_at: now() };
    st.writeSession(s);
    return s;
  };
  let t = Date.parse("2026-11-12T10:00:00Z");
  const emit = (s: SessionFile, body: Record<string, unknown>) =>
    st.appendEvent({ v: 1, id: newId(), at: new Date((t += 1000)).toISOString(), session: s.id, ...body } as Event);
  return { root, st, q, session, emit };
}

test("steps advance with events; a waiting review holds the queue", () => {
  const { st, session, emit } = setup();
  const w = session("worker");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  let q = loadProjectState(st).queues[0]!;
  assert.equal(q.status, "running");
  assert.equal(q.steps[0]!.status, "running");
  assert.equal(q.current_step, "Q1");

  emit(w, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  emit(w, { type: "step.started", queue: "Q", step: "Q2" });
  emit(w, { type: "step.done", queue: "Q", step: "Q2", summary: "ok" });
  q = loadProjectState(st).queues[0]!;
  assert.equal(q.steps[0]!.status, "done");
  assert.equal(q.steps[1]!.status, "review"); // the step's policy is wait
  assert.equal(q.status, "waiting");
});

test("a blocking question waits until the orchestrator answers; workers cannot answer", () => {
  const { st, session, emit } = setup();
  const w = session("worker"); const o = session("orchestrator");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, { type: "question.asked", queue: "Q", step: "Q1", qid: "q1", text: "?", can_continue: false });
  let s = loadProjectState(st);
  assert.equal(s.queues[0]!.status, "waiting");
  assert.equal(s.queues[0]!.steps[0]!.status, "waiting");

  emit(w, { type: "answer.given", qid: "q1", text: "self-answer" });
  s = loadProjectState(st);
  assert.equal(s.questions[0]!.state, "open");
  assert.match(s.warnings.join("\n"), /answer.given is for orchestrators/);

  emit(o, { type: "answer.given", qid: "q1", text: "yes" });
  s = loadProjectState(st);
  assert.equal(s.questions[0]!.state, "answered");
  assert.equal(s.queues[0]!.status, "running");
  assert.equal(s.queues[0]!.steps[0]!.status, "running");
});

test("a stop halts the queue; an approval pins one revision", () => {
  const { st, q, session, emit } = setup();
  const approval = { revision: 1, at: now(), hash: revisionHash(q) };
  st.writeQueue({ ...q, approvals: [approval] });
  assert.equal(loadProjectState(st).queues[0]!.approved, true);
  st.writeQueue({ ...q, steps: [...q.steps, { id: "Q3", title: "Three", goal: "", acceptance: [] }], approvals: [approval] });
  assert.equal(loadProjectState(st).queues[0]!.approved, false);

  const w = session("worker");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, { type: "queue.stop", queue: "Q", step: "Q1", condition: "user decision", reason: "the look" });
  const s = loadProjectState(st).queues[0]!;
  assert.equal(s.status, "stopped");
  assert.equal(s.steps[0]!.status, "stopped");
});

test("a half-written final line is skipped, a bad line is reported", () => {
  const { st, session } = setup();
  const w = session("worker");
  const file = join(st.sessionDir(w.id), "events.jsonl");
  const good = JSON.stringify({ v: 1, id: newId(), at: now(), session: w.id, type: "step.started", queue: "Q", step: "Q1" });
  writeFileSync(file, `${good}\n{"v":1,"type":"nope"}\n{"v":1,"id":"x"`);
  const s = loadProjectState(st);
  assert.equal(s.queues[0]!.steps[0]!.status, "running");
  assert.equal(s.warnings.length, 1);
});

test("a done queue waits for nothing: no item for a halted run, nor for a failed step", () => {
  const { st, q, session, emit } = setup();
  st.writeQueue({ ...q, steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }, { id: "Q2", title: "Two", goal: "", acceptance: [] }] });
  const w = session("worker");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  emit(w, { type: "step.started", queue: "Q", step: "Q2" });
  emit(w, { type: "step.done", queue: "Q", step: "Q2", summary: "ok" });
  // The agent's process ended after its last report, and the run was halted for it (as before this fix).
  st.writeRun("Q", { protocol: 1, session: w.id, state: "halted", reason: "the turn failed 6 times in a row", step: "Q2", started_at: now(), updated_at: now() });
  let s = loadProjectState(st);
  assert.equal(s.queues[0]!.status, "done");
  assert.deepEqual(s.attention, []);
  // The same queue running: the halt is news.
  st.writeQueue({ ...q, steps: [...q.steps, { id: "Q3", title: "Three", goal: "", acceptance: [] }], review_policy: "continue" });
  s = loadProjectState(st);
  assert.notEqual(s.queues[0]!.status, "done");
  assert.equal(s.attention.some((a) => a.kind === "stopped"), true);

  // A done queue with a failed step is treated alike: no item.
  const b = setup();
  b.st.writeQueue({ ...b.q, steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }, { id: "Q2", title: "Two", goal: "", acceptance: [] }] });
  const w2 = b.session("worker");
  b.emit(w2, { type: "step.started", queue: "Q", step: "Q1" });
  b.emit(w2, { type: "step.failed", queue: "Q", step: "Q1", reason: "no" });
  b.emit(w2, { type: "step.started", queue: "Q", step: "Q2" });
  b.emit(w2, { type: "step.done", queue: "Q", step: "Q2", summary: "ok" });
  s = loadProjectState(b.st);
  assert.equal(s.queues[0]!.status, "done");
  assert.deepEqual(s.attention, []);
});

// ---------------------------------------------------------------- review by the orchestrator

test("the review policy falls back from step to queue to the project's default", () => {
  const { st, q, session, emit } = setup();
  const three = [
    { id: "Q1", title: "One", goal: "", acceptance: [] },
    { id: "Q2", title: "Two", goal: "", acceptance: [], review: { policy: "orchestrator" as const } },
    { id: "Q3", title: "Three", goal: "", acceptance: [] },
  ];
  const w = session("worker");
  const statuses = () => loadProjectState(st).queues[0]!.steps.map((x) => `${x.status}${x.review_with ? `:${x.review_with}` : ""}`);
  for (const s of ["Q1", "Q2", "Q3"]) { emit(w, { type: "step.started", queue: "Q", step: s }); emit(w, { type: "step.done", queue: "Q", step: s, summary: "ok" }); }
  st.writeProject({ ...st.readProject(), orchestrator: { runtime: "claude", notify: true, session: null } });

  st.writeQueue({ ...q, steps: three }); // nothing on the queue, the project's default: continue
  assert.deepEqual(statuses(), ["done", "review:orchestrator", "done"]);
  st.writeQueue({ ...q, steps: three, review_policy: "wait" }); // the queue's
  assert.deepEqual(statuses(), ["review:user", "review:orchestrator", "review:user"]);
  st.writeQueue({ ...q, steps: three }); // the project's default
  st.writeProject({ ...st.readProject(), defaults: { ...st.readProject().defaults, review_policy: "orchestrator" } });
  assert.deepEqual(statuses(), ["review:orchestrator", "review:orchestrator", "review:orchestrator"]);
});

test("an orchestrator review is not the user's item until it asks the user; the queue waits in both", () => {
  const { st, q, session, emit } = setup();
  st.writeQueue({ ...q, review_policy: "orchestrator" });
  st.writeProject({ ...st.readProject(), orchestrator: { runtime: "claude", notify: true, session: null } });
  const w = session("worker"); const o = session("orchestrator");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  let s = loadProjectState(st);
  assert.equal(s.queues[0]!.status, "waiting");
  assert.equal(s.queues[0]!.steps[0]!.review_with, "orchestrator");
  assert.deepEqual(s.attention, []);

  // A worker can neither hand it on nor accept it.
  emit(w, { type: "review.asked_user", queue: "Q", step: "Q1", text: "self" });
  emit(w, { type: "review.accepted", queue: "Q", step: "Q1" });
  emit(w, { type: "review.sent_back", queue: "Q", step: "Q1", text: "self" });
  s = loadProjectState(st);
  assert.equal(s.queues[0]!.steps[0]!.review_with, "orchestrator");
  assert.deepEqual(s.queues[0]!.steps[0]!.sent_back, []);
  assert.equal(s.warnings.filter((x) => /is for orchestrators/.test(x)).length, 3);

  emit(o, { type: "review.asked_user", queue: "Q", step: "Q1", text: "The look is the user's." });
  s = loadProjectState(st);
  assert.equal(s.queues[0]!.status, "waiting");
  assert.equal(s.queues[0]!.steps[0]!.review_with, "user");
  assert.deepEqual(s.attention.map((a) => [a.kind, a.step, a.text]), [["review", "Q1", "The look is the user's."]]);
  // Now it is the user's: the orchestrator's acceptance does not count.
  emit(o, { type: "review.accepted", queue: "Q", step: "Q1" });
  assert.equal(loadProjectState(st).queues[0]!.steps[0]!.status, "review");
  emit(session("user"), { type: "review.accepted", queue: "Q", step: "Q1" });
  s = loadProjectState(st);
  assert.equal(s.queues[0]!.steps[0]!.status, "done");
  assert.equal(s.queues[0]!.status, "running");
});

test("the orchestrator accepts a step waiting for it; without an orchestrator or with notices off it is the user's", () => {
  const { st, q, session, emit } = setup();
  st.writeQueue({ ...q, review_policy: "orchestrator" });
  const w = session("worker"); const o = session("orchestrator");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  let s = loadProjectState(st);
  assert.equal(s.queues[0]!.steps[0]!.review_with, "user", "the project has no orchestrator");
  assert.equal(s.attention.length, 1);
  st.writeProject({ ...st.readProject(), orchestrator: { runtime: "claude", notify: false, session: null } });
  assert.equal(loadProjectState(st).queues[0]!.steps[0]!.review_with, "user", "notices off");
  st.writeProject({ ...st.readProject(), orchestrator: { runtime: "claude", notify: true, session: null } });
  s = loadProjectState(st);
  assert.equal(s.queues[0]!.steps[0]!.review_with, "orchestrator");
  assert.deepEqual(s.attention, []);
  emit(o, { type: "review.accepted", queue: "Q", step: "Q1", text: "fine" });
  s = loadProjectState(st);
  assert.equal(s.queues[0]!.steps[0]!.status, "done");
  assert.equal(s.queues[0]!.steps[0]!.review_with, undefined);
});
