import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, loadProjectState, newId, now, revisionHash, type Event, type QueueFile, type SessionFile } from "../src/index.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-test-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root, });
  const q: QueueFile = { withdrawals: [],
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
