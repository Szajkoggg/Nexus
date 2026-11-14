import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, readGlobalSettings, writeGlobalSettings, newId, stepClosed, now, revisionHash, type Event, type QueueFile, type SessionFile } from "../src/index.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-test-"));
  process.env.NEXUS_HOME = join(root, "home"); // global settings of its own, never the machine's
  const st = ProjectStore.init(root, { id: "p", name: "P", root, });
  const q: QueueFile = { withdrawals: [], changes: [],
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [],
    steps: [
      { id: "Q1", title: "One", goal: "", acceptance: [] },
      { id: "Q2", title: "Two", goal: "", acceptance: [], review: { level: 1 } },
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
  q = loadProjectState(st).queues[0]!;
  assert.equal(q.steps[0]!.status, "review", "every step is reviewed");
  assert.equal(q.status, "waiting");
  emit(session("user"), { type: "review.accepted", queue: "Q", step: "Q1" });
  emit(w, { type: "step.started", queue: "Q", step: "Q2" });
  emit(w, { type: "step.done", queue: "Q", step: "Q2", summary: "ok" });
  q = loadProjectState(st).queues[0]!;
  assert.equal(q.steps[0]!.status, "done");
  assert.equal(q.steps[1]!.status, "review"); // the step's level is 1
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

test("a question with options carries them to the user's waiting list", () => {
  const { st, session, emit } = setup();
  const w = session("worker");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, { type: "question.asked", queue: "Q", step: "Q1", qid: "q1", text: "Smooth it now?", options: ["Now", "Later"], can_continue: false });
  emit(w, { type: "question.asked", queue: "Q", step: "Q1", qid: "q2", text: "Anything else?", can_continue: true });
  const a = loadProjectState(st).attention.filter((x) => x.kind === "question");
  assert.deepEqual(a.map((x) => [x.qid, x.options]).sort(), [["q1", ["Now", "Later"]], ["q2", undefined]]);
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
  const u = session("user");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  emit(u, { type: "review.accepted", queue: "Q", step: "Q1" });
  emit(w, { type: "step.started", queue: "Q", step: "Q2" });
  emit(w, { type: "step.done", queue: "Q", step: "Q2", summary: "ok" });
  emit(u, { type: "review.accepted", queue: "Q", step: "Q2" });
  // The agent's process ended after its last report, and the run was halted for it (as before this fix).
  st.writeRun("Q", { protocol: 1, session: w.id, state: "halted", reason: "the turn failed 6 times in a row", step: "Q2", started_at: now(), updated_at: now() });
  let s = loadProjectState(st);
  assert.equal(s.queues[0]!.status, "done");
  assert.deepEqual(s.attention, []);
  // The same queue running: the halt is news.
  st.writeQueue({ ...q, steps: [...q.steps, { id: "Q3", title: "Three", goal: "", acceptance: [] }] });
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
  b.emit(b.session("user"), { type: "review.accepted", queue: "Q", step: "Q2" });
  s = loadProjectState(b.st);
  assert.equal(s.queues[0]!.status, "done");
  assert.deepEqual(s.attention, []);
});

// ---------------------------------------------------------------- review by the orchestrator

test("the review level falls back from the user's to the step's, the queue's, the project's and the global one", () => {
  const { st, q, session, emit } = setup();
  const four = [
    { id: "Q1", title: "One", goal: "", acceptance: [] },
    { id: "Q2", title: "Two", goal: "", acceptance: [], review: { level: 3 as const } },
    { id: "Q3", title: "Three", goal: "", acceptance: [] },
    { id: "Q4", title: "Four", goal: "", acceptance: [], review: { level: 2 as const } },
  ];
  const w = session("worker");
  const levels = () => loadProjectState(st).queues[0]!.steps.map((x) => `${x.level}:${x.level_from}`);
  const statuses = () => loadProjectState(st).queues[0]!.steps.map((x) => `${x.status}${x.review_with ? `:${x.review_with}` : ""}`);
  st.writeProject({ ...st.readProject(), orchestrator: { runtime: "claude", notify: true, session: null } });

  st.writeQueue({ ...q, steps: four }); // nothing on the queue, nothing on the project: the global value, 2
  assert.deepEqual(levels(), ["2:project", "3:step", "2:project", "2:step"]);
  writeGlobalSettings({ ...readGlobalSettings(), defaults: { ...readGlobalSettings().defaults, review_level: 1 } });
  assert.deepEqual(levels(), ["1:project", "3:step", "1:project", "2:step"], "the project follows the global value");
  st.updateProject((p) => ({ ...p, defaults: { ...p.defaults, review_level: 3 } }));
  assert.deepEqual(levels(), ["3:project", "3:step", "3:project", "2:step"], "the project's own value");
  st.writeQueue({ ...q, steps: four, review_level: 1 }); // the queue's
  assert.deepEqual(levels(), ["1:queue", "3:step", "1:queue", "2:step"]);
  st.writeQueue({ ...q, steps: four, review_level: 1, user_levels: { Q2: 1, Q3: 2 } }); // the user's, over everything
  assert.deepEqual(levels(), ["1:queue", "1:user", "2:user", "2:step"]);

  // Every level is reviewed (there is none without review): 1 by the user, 2 and 3 by the orchestrator.
  for (const s of ["Q1", "Q2", "Q3", "Q4"]) { emit(w, { type: "step.started", queue: "Q", step: s }); emit(w, { type: "step.done", queue: "Q", step: s, summary: "ok" }); }
  st.writeQueue({ ...q, steps: four, user_levels: { Q1: 3 } });
  assert.deepEqual(statuses(), ["review:orchestrator", "review:orchestrator", "review:orchestrator", "review:orchestrator"]);
  assert.equal(loadProjectState(st).queues[0]!.status, "waiting");
  st.writeQueue({ ...q, steps: four, review_level: 1 });
  assert.deepEqual(statuses(), ["review:user", "review:orchestrator", "review:user", "review:orchestrator"]);
});

test("without an orchestrator, or with its notices off, levels 2 and 3 go to the user as level 1", () => {
  const { st, q, session, emit } = setup();
  const three = [1, 2, 3].map((level) => ({ id: `Q${level}`, title: `L${level}`, goal: "", acceptance: [], review: { level: level as 1 | 2 | 3 } }));
  st.writeQueue({ ...q, steps: three });
  const w = session("worker");
  for (const s of ["Q1", "Q2", "Q3"]) { emit(w, { type: "step.started", queue: "Q", step: s }); emit(w, { type: "step.done", queue: "Q", step: s, summary: "ok" }); }
  const withs = () => loadProjectState(st).queues[0]!.steps.map((x) => x.review_with);
  assert.deepEqual(withs(), ["user", "user", "user"], "no orchestrator");
  assert.equal(loadProjectState(st).attention.filter((a) => a.kind === "review").length, 3);
  st.writeProject({ ...st.readProject(), orchestrator: { runtime: "claude", notify: false, session: null } });
  assert.deepEqual(withs(), ["user", "user", "user"], "its notices off");
  st.writeProject({ ...st.readProject(), orchestrator: { runtime: "claude", notify: true, session: null } });
  assert.deepEqual(withs(), ["user", "orchestrator", "orchestrator"]);
});

test("an orchestrator review is not the user's item until it asks the user; the queue waits in both", () => {
  const { st, q, session, emit } = setup();
  st.writeQueue({ ...q, review_level: 2 });
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
  st.writeQueue({ ...q, review_level: 2 });
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

test("only the user rejects a step waiting for their review; the rejection holds until a newer revision is approved", () => {
  const { st, q, session, emit } = setup();
  const w = session("worker"); const o = session("orchestrator"); const u = session("user");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  emit(u, { type: "review.accepted", queue: "Q", step: "Q1" });
  emit(w, { type: "step.started", queue: "Q", step: "Q2" });
  emit(w, { type: "step.done", queue: "Q", step: "Q2", summary: "ok" }); // Q2's level is 1
  emit(w, { type: "review.rejected", queue: "Q", step: "Q2", text: "self" });
  emit(o, { type: "review.rejected", queue: "Q", step: "Q2", text: "for the user" });
  let s = loadProjectState(st);
  assert.equal(s.queues[0]!.steps[1]!.status, "review");
  assert.equal(s.warnings.filter((x) => /review.rejected is the user's; ignored/.test(x)).length, 2);
  assert.equal(s.queues[0]!.rejection, undefined);

  emit(u, { type: "review.rejected", queue: "Q", step: "Q2", text: "Wrong approach." });
  s = loadProjectState(st);
  assert.equal(s.queues[0]!.steps[1]!.status, "rejected");
  assert.equal(s.queues[0]!.steps[1]!.reason, "Wrong approach.");
  const rej = loadProjectState(st).queues[0]!.rejection; assert.deepEqual([rej?.step, rej?.text], ["Q2", "Wrong approach."]);
  assert.equal(s.queues[0]!.status, "paused");
  assert.match(s.queues[0]!.status_reason!, /step Q2 was rejected: Wrong approach\./);
  assert.deepEqual(s.attention, [], "the user's own act waits for no one");

  // A newer revision's approval lifts it.
  const cur = st.readQueue("Q");
  st.writeQueue({ ...cur, revision: 2, history: [{ revision: 1, hash: "y", replaced_at: "2026-11-12T10:30:00.000Z" }], steps: [...cur.steps, { id: "Q3", title: "Redo", goal: "", acceptance: [] }], approvals: [...cur.approvals, { revision: 2, at: new Date(Date.parse("2026-11-12T11:00:00Z")).toISOString(), hash: "x" }] });
  s = loadProjectState(st);
  assert.equal(s.queues[0]!.rejection, undefined);
  assert.equal(s.queues[0]!.steps[1]!.status, "rejected", "the step stays rejected");
  assert.notEqual(s.queues[0]!.status, "paused");
});

test("a rejected step counts as closed once a newer revision is approved: the queue whose other steps are finished is done", () => {
  const { st, session, emit } = setup();
  const w = session("worker"); const u = session("user");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  emit(u, { type: "review.accepted", queue: "Q", step: "Q1" });
  emit(w, { type: "step.started", queue: "Q", step: "Q2" });
  emit(w, { type: "step.done", queue: "Q", step: "Q2", summary: "ok" });
  emit(u, { type: "review.rejected", queue: "Q", step: "Q2", text: "Not this." });
  const view = () => loadProjectState(st).queues[0]!;
  assert.equal(view().status, "paused", "before the approval the rejection holds: not done");
  assert.ok(!stepClosed(view(), view().steps[1]!));

  // Revision 2 keeps the steps (the rejected one is not run again); its approval lets the queue end.
  const cur = st.readQueue("Q");
  st.writeQueue({ ...cur, revision: 2, history: [{ revision: 1, hash: "y", replaced_at: "2026-11-12T10:30:00.000Z" }], approvals: [...cur.approvals, { revision: 2, at: "2026-11-12T11:00:00.000Z", hash: "x" }] });
  let q = view();
  assert.equal(q.rejection, undefined);
  assert.equal(q.status, "done");
  assert.equal(q.status_reason, undefined);
  assert.deepEqual([q.steps[1]!.status, q.steps[1]!.reason], ["rejected", "Not this."], "it keeps its mark and reason");
  assert.ok(stepClosed(q, q.steps[1]!));

  // With a new step after it, the queue is done once that step is.
  const two = st.readQueue("Q");
  st.writeQueue({ ...two, steps: [...two.steps, { id: "Q3", title: "Redo", goal: "", acceptance: [] }] });
  q = view();
  assert.notEqual(q.status, "done", "Q3 is still pending");
  emit(w, { type: "step.started", queue: "Q", step: "Q3" });
  emit(w, { type: "step.done", queue: "Q", step: "Q3", summary: "redone" });
  emit(u, { type: "review.accepted", queue: "Q", step: "Q3" });
  q = view();
  assert.equal(q.status, "done");
  assert.equal(q.steps[1]!.status, "rejected");
});

test("a comment on a review picture goes back with a send-back while the step waits for the user, else to the next pending step", async () => {
  const { commentTarget, commentOnPicture, markPicture } = await import("../src/index.ts");
  const { writeFileSync: wf } = await import("node:fs");
  const { st, q, session, emit, root } = setup();
  st.writeQueue({ ...q, steps: [...q.steps, { id: "Q3", title: "Three", goal: "", acceptance: [] }] });
  const w = session("worker");
  const pic = join(root, "cliff.png"); wf(pic, "png");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, { type: "review.added", queue: "Q", step: "Q1", items: [{ path: pic, label: "Cliff" }] });
  emit(w, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  emit(session("user"), { type: "review.accepted", queue: "Q", step: "Q1" }); // Q1: accepted, done
  emit(w, { type: "step.started", queue: "Q", step: "Q2" });
  emit(w, { type: "review.added", queue: "Q", step: "Q2", items: [{ path: pic, label: "Cliff" }] });
  emit(w, { type: "step.done", queue: "Q", step: "Q2", summary: "ok" }); // Q2: level 1, in review for the user
  let s = loadProjectState(st);
  assert.deepEqual(commentTarget(s.queues[0]!, "Q2"), { to: "send_back" });
  assert.deepEqual(commentTarget(s.queues[0]!, "Q1"), { to: "note", step: "Q3" }, "done: the next pending step");
  assert.deepEqual(commentTarget({ steps: [{ ...s.queues[0]!.steps[1]!, review_with: "orchestrator" as const }, s.queues[0]!.steps[2]!] }, "Q2"), { to: "orchestrator" }, "held by the orchestrator: to its review, not a Fix it");
  assert.deepEqual(commentTarget({ steps: s.queues[0]!.steps.slice(0, 1) }, "Q1"), { to: "none" });

  assert.match(commentOnPicture(st, { queue: "Q", step: "Q1", path: pic, text: "Warmer light." }), /a note on step Q3/);
  assert.match(commentOnPicture(st, { queue: "Q", step: "Q2", path: pic, text: "Less moss." }), /sent back to its worker as round 2/);
  assert.throws(() => commentOnPicture(st, { queue: "Q", step: "Q2", path: join(root, "other.png"), text: "x" }), /no review picture/);
  assert.throws(() => commentOnPicture(st, { queue: "Q", step: "Q1", path: pic, text: "  " }), /the comment is empty/);
  markPicture(st, { queue: "Q", step: "Q1", path: pic, accepted: true });
  s = loadProjectState(st);
  const [s1, s2, s3] = s.queues[0]!.steps;
  assert.ok(s1!.pictures[pic]!.accepted, "marked");
  assert.equal(s1!.status, "done");
  assert.deepEqual(s1!.pictures[pic]!.comments.map((c) => [c.text, c.to, c.note_step]), [["Warmer light.", "note", "Q3"]]);
  assert.match(s3!.notes[0]!.body, /About the picture "Cliff" .*\nWarmer light\./);
  assert.equal(s2!.sent_back[0]!.by, "user");
  assert.match(s2!.sent_back[0]!.text, /About the picture "Cliff"/);
  markPicture(st, { queue: "Q", step: "Q1", path: pic, accepted: false });
  assert.equal(loadProjectState(st).queues[0]!.steps[0]!.pictures[pic]!.accepted, undefined, "the mark taken back");
  // A worker cannot write either.
  emit(w, { type: "review.marked", queue: "Q", step: "Q2", path: pic, accepted: true });
  assert.equal(loadProjectState(st).queues[0]!.steps[1]!.pictures[pic]?.accepted, undefined);
});

test("a run waiting for approval: an approval item (and so a push), a planned start after it waits on the user, the queue not done", () => {
  const { st, q, session, emit } = setup();
  st.writeQueue({ ...q, status: "proposed" });
  approveQueue(st, "Q");
  st.writeQueue({ withdrawals: [], changes: [], protocol: 1, id: "R", title: "After", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [{ id: "R1", title: "R", goal: "", acceptance: [] }], approvals: [], history: [] });
  approveQueue(st, "R");
  st.writeStart("R", { protocol: 1, after: "Q", by: "user", revision: 1, created_at: now() });
  const w = session("worker");
  emit(w, { type: "step.started", queue: "Q", step: "Q1" });
  st.writeRun("Q", { protocol: 1, session: w.id, state: "running", step: "Q1", started_at: now(), updated_at: now(), revision: 1 });
  // A revision that removes the remaining step Q2, while Q1 runs.
  applyDraft(st, { id: "Q", title: "Queue", steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }] });
  let s = loadProjectState(st);
  assert.ok(!s.attention.some((a) => a.kind === "approval" && a.queue === "Q"), "mid-step: no item yet, the step goes on");
  assert.match(s.queues.find((x) => x.id === "R")!.start!.waiting, /^queue Q is running \(at Q1\)$/);

  emit(w, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  st.writeRun("Q", { protocol: 1, session: w.id, state: "approval_wait", reason: "waits for approval of revision 2", step: "Q1", started_at: now(), updated_at: now(), revision: 1 });
  s = loadProjectState(st);
  const item = s.attention.find((a) => a.kind === "approval" && a.queue === "Q");
  assert.equal(item?.text, "The run waits for approval of revision 2 after step Q1; it goes on by itself once you approve");
  const r = s.queues.find((x) => x.id === "R")!.start!;
  assert.deepEqual([r.waiting, r.blocked], ["queue Q waits for approval of revision 2 (after Q1)", true]);
  const qv = s.queues.find((x) => x.id === "Q")!;
  assert.deepEqual([qv.status, qv.status_reason], ["waiting", "waits for approval of revision 2"], "not done before the approval");

  approveQueue(st, "Q");
  s = loadProjectState(st);
  assert.ok(!s.attention.some((a) => a.kind === "approval"), "approved: nothing waits for the user");
});
