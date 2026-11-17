import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionError, ProjectStore, addNote, answerAsUser, approveQueue, deleteNote, loadProjectState, newId, now,
  routeAnswers, sendMessage, setQueueSettings, withdrawApproval, type Event, type SessionFile,
} from "../src/index.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-actions-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root, });
  st.writeQueue({
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }, { id: "Q2", title: "Two", goal: "", acceptance: [] }],
    approvals: [], history: [],
  });
  const session = (role: SessionFile["role"]): SessionFile => {
    const s: SessionFile = { protocol: 1, id: newId(), project: "p", role, runtime: "external", cwd: root, launched_by: "external", created_at: now(), queue: "Q" };
    st.writeSession(s);
    return s;
  };
  const emit = (s: SessionFile, body: Record<string, unknown>) =>
    st.appendEvent({ v: 1, id: newId(), at: now(), session: s.id, ...body } as Event);
  return { st, session, emit };
}

test("approving a proposed queue records the words and pins the revision once", () => {
  const { st } = setup();
  assert.equal(loadProjectState(st).attention[0]?.kind, "approval");
  approveQueue(st, "Q", "  Rendben, mehet.  ");
  const q = loadProjectState(st).queues[0]!;
  assert.equal(q.approved, true);
  assert.equal(q.status, "approved");
  assert.equal(q.approvals[0]!.words, "Rendben, mehet.");
  assert.throws(() => approveQueue(st, "Q"), (e: ActionError) => e.status === 409);
  assert.equal(loadProjectState(st).attention.length, 0);
});

test("a note can be withdrawn only before it is delivered", () => {
  const { st, session, emit } = setup();
  const keep = addNote(st, "Q", "Q2", "keep the debris");
  const drop = addNote(st, "Q", "Q2", "never mind");
  assert.throws(() => addNote(st, "Q", "Q9", "x"), (e: ActionError) => e.status === 404);
  assert.throws(() => addNote(st, "Q", "Q2", "   "), /empty/);
  deleteNote(st, "Q", "Q2", drop);
  assert.deepEqual(loadProjectState(st).queues[0]!.steps[1]!.notes.map((n) => n.id), [keep]);

  emit(session("worker"), { type: "note.read", note: keep });
  assert.throws(() => deleteNote(st, "Q", "Q2", keep), (e: ActionError) => e.status === 409);
});

test("answers reach the asker's inbox exactly once; escalations go to the user", () => {
  const { st, session, emit } = setup();
  const w = session("worker"); const o = session("orchestrator");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, { type: "question.asked", queue: "Q", step: "Q1", qid: "q1", text: "Vertical joints only?", can_continue: false });
  emit(o, { type: "answer.given", qid: "q1", text: "This is the user's call.", escalate: true });

  let s = loadProjectState(st);
  assert.equal(s.questions[0]!.state, "escalated");
  assert.equal(s.attention.find((a) => a.kind === "question")?.qid, "q1");
  assert.equal(routeAnswers(st), 0); // an escalation is not an answer

  answerAsUser(st, "q1", "Vertical only.", true);
  assert.equal(routeAnswers(st), 0); // answerAsUser already routed it
  s = loadProjectState(st);
  assert.equal(s.questions[0]!.state, "answered");
  assert.equal(s.questions[0]!.answers.at(-1)!.by, "user");
  assert.equal(s.queues[0]!.steps[0]!.status, "running");
  const inbox = s.sessions.find((x) => x.id === w.id)!.inbox;
  assert.equal(inbox.length, 1);
  assert.deepEqual([inbox[0]!.type, inbox[0]!.from], ["answer", "user"]);
});

test("an answer to an orchestrator session that went on in a fresh one goes to the newest of its line, once", () => {
  const { st, session, emit } = setup();
  const o1 = session("orchestrator"); const o2 = session("orchestrator"); const o3 = session("orchestrator");
  st.writeSession({ ...o1, continued_by: o2.id }); st.writeSession({ ...o2, continues: o1.id, continued_by: o3.id }); st.writeSession({ ...o3, continues: o2.id });
  emit(o1, { type: "question.asked", qid: "qa", text: "Which plan?", can_continue: true });
  emit(o1, { type: "question.asked", qid: "qb", text: "Which name?", can_continue: true });
  // One answer already reached the old session (and went into the fresh one's first turn): it is not routed again.
  st.appendInbox(o2.id, { v: 1, id: "answer-early", at: now(), from: "user", type: "answer", qid: "qb", text: "Early." });
  emit(session("user"), { type: "answer.given", qid: "qa", text: "Plan A." });
  st.appendEvent({ v: 1, id: "early", at: now(), session: o1.id, type: "answer.given", qid: "qb", text: "Early." } as Event);
  assert.equal(routeAnswers(st), 1);
  assert.equal(routeAnswers(st), 0);
  const inbox = (id: string) => st.readInbox(id).entries.map((m) => m.id);
  assert.deepEqual(inbox(o1.id), []);
  assert.deepEqual(inbox(o2.id), ["answer-early"]);
  assert.equal(inbox(o3.id).length, 1);
  assert.equal(st.readInbox(o3.id).entries[0]!.type === "answer" && st.readInbox(o3.id).entries[0]!.text, "Plan A.");
});

test("a message to a running session shows on its step until it is read", () => {
  const { st, session, emit } = setup();
  const w = session("worker");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  const id = sendMessage(st, w.id, "Use the grassland settings too.", { queue: "Q", step: "Q1" });
  let m = loadProjectState(st).queues[0]!.steps[0]!.messages;
  assert.equal(m.length, 1);
  assert.equal(m[0]!.read_at, undefined);
  emit(w, { type: "message.read", message: id });
  m = loadProjectState(st).queues[0]!.steps[0]!.messages;
  assert.ok(m[0]!.read_at);
  assert.throws(() => sendMessage(st, "nobody", "x"), (e: ActionError) => e.status === 404);
});

test("a queue's review level can be set and cleared", () => {
  const { st } = setup();
  setQueueSettings(st, "Q", { review_level: 1 });
  assert.equal(st.readQueue("Q").review_level, 1);
  setQueueSettings(st, "Q", { review_level: 3 });
  assert.equal(st.readQueue("Q").review_level, 3);
  setQueueSettings(st, "Q", { review_level: null });
  assert.equal(st.readQueue("Q").review_level, undefined);
  for (const bad of [0, 4, "2", "wait", 1.5]) assert.throws(() => setQueueSettings(st, "Q", { review_level: bad }), ActionError);
});

test("project settings: set, clear with an empty value, and refuse what the schema does not allow", async () => {
  const { st } = setup();
  const { updateSettings } = await import("../src/actions.ts");
  updateSettings(st, { runtimes: { default: "codex", claude: { effort: "high", permission_mode: "auto", model: "opus" }, codex: { effort: "xhigh", approval_policy: "on-request", approvals_reviewer: "auto_review" } }, defaults: { usage_pause_threshold: 0.8 } });
  let p = st.readProject();
  assert.equal(p.runtimes.default, "codex");
  assert.deepEqual([p.runtimes.claude.effort, p.runtimes.claude.permission_mode, p.runtimes.claude.model], ["high", "auto", "opus"]);
  assert.deepEqual([p.runtimes.codex.effort, p.runtimes.codex.approvals_reviewer], ["xhigh", "auto_review"]);
  assert.equal(p.defaults.usage_pause_threshold, 0.8);
  updateSettings(st, { runtimes: { claude: { model: "", effort: null } } });
  p = st.readProject();
  assert.deepEqual([p.runtimes.claude.model, p.runtimes.claude.effort, p.runtimes.claude.permission_mode], [undefined, undefined, "auto"]);
  assert.throws(() => updateSettings(st, { runtimes: { claude: { effort: "ultra" } } }), /effort/);
  updateSettings(st, { runtimes: { codex: { effort: "max" } } });
  assert.equal(st.readProject().runtimes.codex.effort, "max", "Codex models take max (and ultra)");
  updateSettings(st, { runtimes: { codex: { effort: "xhigh" } } });
  assert.throws(() => updateSettings(st, { runtimes: { claude: { permission_mode: "yolo" } } }), /permission_mode/);
  assert.equal(st.readProject().runtimes.codex.effort, "xhigh", "a refused change leaves the settings as they were");
});

test("withdrawing the approval of an unstarted queue: proposed again, recorded, and approving again works", () => {
  const { st } = setup();
  approveQueue(st, "Q", "go");
  withdrawApproval(st, "Q", "  not yet: the art is missing  ");
  let q = loadProjectState(st).queues[0]!;
  assert.equal(q.approved, false);
  assert.equal(q.status, "proposed");
  assert.equal(q.approvals.length, 1, "the earlier approval stays on record");
  assert.equal(q.approvals[0]!.words, "go");
  assert.deepEqual(q.withdrawals.map((w) => [w.revision, w.reason, w.approvals]), [[1, "not yet: the art is missing", 1]]);
  assert.equal(loadProjectState(st).attention[0]?.kind, "approval", "it waits for an approval again");
  assert.throws(() => withdrawApproval(st, "Q"), (e: ActionError) => e.status === 409, "nothing left to withdraw");
  approveQueue(st, "Q");
  q = loadProjectState(st).queues[0]!;
  assert.equal(q.approved, true);
  assert.equal(q.status, "approved");
  assert.equal(q.approvals.length, 2);
  withdrawApproval(st, "Q");
  assert.equal(loadProjectState(st).queues[0]!.withdrawals.at(-1)!.reason, undefined, "the reason is optional");
});

test("a queue that has started cannot be withdrawn: a step started, or a run recorded", () => {
  const { st, session, emit } = setup();
  approveQueue(st, "Q");
  emit(session("worker"), { type: "step.started", queue: "Q", step: "Q1" });
  assert.throws(() => withdrawApproval(st, "Q"), (e: ActionError) => e.status === 409 && /pause or stop/.test(e.message));
  assert.equal(loadProjectState(st).queues[0]!.approved, true);

  const b = setup();
  approveQueue(b.st, "Q");
  b.st.writeRun("Q", { protocol: 1, session: "s", state: "paused", started_at: now(), updated_at: now() });
  assert.throws(() => withdrawApproval(b.st, "Q"), (e: ActionError) => e.status === 409);
});


test("additional answers keep their exact qid; withdrawn and missing targets are rejected", () => {
  const { st, session, emit } = setup();
  const w = session("worker");
  for (const qid of ["q1", "q2", "q3"]) emit(w, { type: "question.asked", queue: "Q", step: "Q1", qid, text: qid, can_continue: false });
  answerAsUser(st, "q2", "List", false);
  answerAsUser(st, "q2", "List with details", false);
  assert.deepEqual(loadProjectState(st).questions.map((q) => [q.qid, q.state, q.answers.length]), [
    ["q1", "open", 0], ["q2", "answered", 2], ["q3", "open", 0],
  ]);
  assert.deepEqual(st.readInbox(w.id).entries.filter((e) => e.type === "answer").map((e) => [e.qid, e.text]), [["q2", "List"], ["q2", "List with details"]]);
  emit(w, { type: "question.withdrawn", qid: "q3", reason: "No longer needed" });
  assert.throws(() => answerAsUser(st, "q3", "Bell", false), (e: ActionError) => e.status === 409);
  assert.throws(() => answerAsUser(st, "missing", "Other", false), (e: ActionError) => e.status === 404);
  assert.equal(st.readInbox(w.id).entries.length, 2);
});
