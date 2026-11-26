// Review decisions (queue RVD; docs/protocol/review.md, "Review decisions"): the list a worker declares, the answers by
// version and round, and the rule that holds every acceptance until the list is complete: the user's Accept, the
// orchestrator's and a review helper's acceptance events, a provisional acceptance, Nexus's own; who may answer what at
// each level, in away mode and after a hand-over; a missing list; old data; Fix it and Reject without answers; Confirm all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionError, ProjectStore, acceptedByNexus, answerDecision, approveQueue, confirmProvisionals, currentAnswer, ensureUserSession, gate,
  loadProjectState, newId, questionBarrier, reviewRound, sendBack, setStepLevel, userAcceptRefusal, writeAway, writeRegistry,
  type Event, type ReviewLevel, type SessionFile, type StepView,
} from "../src/index.ts";

let last = 0;
/**
 * Event times in the order the test writes them, never behind the clock: the actions under test write theirs with the
 * clock's now, and the derivation orders the logs by time.
 */
const tick = () => new Date(last = Math.max(Date.now(), last + 1)).toISOString();
/** Moves the test's events `ms` ahead of the clock (away mode's end); only events written by the test follow. */
const ahead = (ms: number) => { last += ms; };

function setup(o: { level?: ReviewLevel; mark?: boolean; orchestrator?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-decisions-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, ...(o.orchestrator === false ? {} : { orchestrator: { session: null } }) });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  if (o.mark !== false) store.markReviewDecisions(new Date(Date.now() - 60_000).toISOString());
  const session = (role: SessionFile["role"], extra: Partial<SessionFile> = {}): SessionFile => {
    const s: SessionFile = { protocol: 1, id: newId(), project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: tick(), ...extra };
    store.writeSession(s);
    return s;
  };
  const worker = session("worker", { queue: "Q" });
  const orch = session("orchestrator");
  store.writeQueue({ protocol: 1, id: "Q", title: "Q", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [
      { id: "Q1", title: "Design", goal: "Design it.", acceptance: ["Drawn"], review: { level: o.level ?? 1 } },
      { id: "Q2", title: "Build", goal: "Build it.", acceptance: ["Built"] },
    ] });
  approveQueue(store, "Q");
  const emit = (s: SessionFile, body: Record<string, unknown>): string => {
    const id = newId();
    store.appendEvent({ v: 1, id, at: tick(), session: s.id, queue: "Q", step: "Q1", ...body } as Event);
    return id;
  };
  const user = () => ensureUserSession(store);
  const state = () => loadProjectState(store);
  const q = () => state().queues.find((x) => x.id === "Q")!;
  const st = () => q().steps.find((x) => x.id === "Q1")!;
  const d = (id: string) => st().decisions.items.find((x) => x.id === id)!;
  const warned = (re: RegExp) => state().warnings.some((w) => re.test(w));
  const decision = (s: SessionFile, id: string, extra: Record<string, unknown> = {}) => emit(s, {
    type: "review.decision", decision: id, text: `Question ${id}?`, options: [{ label: "A" }, { label: "B" }], recommended: "B", for: "user", ...extra,
  });
  /** The worker starts Q1, declares the decisions given, and ends the step. */
  const work = (decisions: [string, Record<string, unknown>?][] = [], none?: string) => {
    emit(worker, { type: "step.started" });
    for (const [id, extra] of decisions) decision(worker, id, extra);
    if (none) emit(worker, { type: "review.decisions_none", text: none });
    emit(worker, { type: "step.done", summary: "done" });
  };
  const answer = (s: SessionFile, id: string, choice?: string, extra: Record<string, unknown> = {}) =>
    emit(s, { type: "review.decided", decision: id, version: d(id).version, round: reviewRound(q(), st()), ...(choice ? { choice } : {}), ...extra });
  const accept = (s: SessionFile) => emit(s, { type: "review.accepted" });
  return { root, store, worker, orch, session, emit, user, state, q, st, d, warned, decision, work, answer, accept };
}

const openIds = (x: ReturnType<typeof setup>) => (userAcceptRefusal(x.state(), x.q(), x.st()) ?? "").match(/D\d+/g) ?? [];

test("no list in a project without the mark, or before it: nothing holds an acceptance (old data keeps its meaning)", () => {
  const x = setup({ level: 2, mark: false });
  x.work();
  assert.equal(x.st().decision_list, "legacy");
  x.accept(x.orch);
  assert.equal(x.st().status, "done", "the orchestrator's acceptance counts");
  // A step.done from before the mark: legacy too.
  const y = setup({ level: 2 });
  y.store.updateProject((p) => ({ ...p, review_decisions_since: new Date(Date.now() + 10 ** 9).toISOString() }));
  y.work();
  assert.equal(y.st().decision_list, "legacy");
  y.accept(y.orch);
  assert.equal(y.st().status, "done");
});

test("a missing list holds the reviewers, not the user; the orchestrator declares none and may accept", () => {
  const x = setup({ level: 2 });
  x.work();
  assert.equal(x.st().decision_list, "missing");
  x.accept(x.orch);
  assert.equal(x.st().status, "review", "the orchestrator's acceptance is held");
  assert.ok(x.warned(/no decision list.*the acceptance is ignored/));
  assert.equal(userAcceptRefusal(x.state(), x.q(), x.st()), undefined, "the user may accept a step without a list");
  x.emit(x.orch, { type: "review.decisions_none", text: "nothing to choose" });
  assert.equal(x.st().decision_list, "none");
  x.accept(x.orch);
  assert.equal(x.st().status, "done");
});

test("an explicit none from the worker is not a missing list; QA4's question barrier does not wait for decisions", () => {
  const x = setup({ level: 2 });
  x.emit(x.worker, { type: "step.started" });
  x.decision(x.worker, "D1");
  assert.equal(questionBarrier(x.q().questions, "Q", "Q1").blocked, false, "a decision is no question");
  x.emit(x.worker, { type: "review.decisions_none", text: "none" });
  assert.ok(x.warned(/has 1 decision on its list \(D1\): withdraw them first/), "none beside a decision is refused");
  x.decision(x.worker, "D1", { withdrawn: "not a real choice" });
  x.emit(x.worker, { type: "review.decisions_none", text: "a refactor: nothing is the user's" });
  x.emit(x.worker, { type: "step.done", summary: "done" });
  assert.equal(x.st().status, "review", "step.done is not held by a list");
  assert.equal(x.st().decision_list, "declared", "a withdrawn decision stays in the list's history");
  assert.equal(x.st().decisions.none?.text, "a refactor: nothing is the user's");
  x.accept(x.orch);
  assert.equal(x.st().status, "done");
});

test("three decisions: a partial answer saves without accepting and wakes nobody; Accept needs all three", () => {
  const x = setup();
  x.work([["D1"], ["D2"], ["D3", { for: "reviewer" }]]);
  assert.deepEqual(x.st().decisions.items.map((d) => [d.id, d.version, d.round, d.by]), [["D1", 1, 1, "worker"], ["D2", 1, 1, "worker"], ["D3", 1, 1, "worker"]]);
  const inbox = () => x.state().sessions.find((s) => s.id === x.worker.id)!.inbox.length;
  const before = inbox();
  const r = answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D1", version: 1, round: 1, choice: "B", text: "denser" });
  assert.equal(x.st().status, "review", "saving is no acceptance");
  assert.equal(inbox(), before, "no message to the worker");
  assert.equal(currentAnswer(x.d("D1"), 1)?.event, r.answer);
  assert.deepEqual(openIds(x), ["D2", "D3"]);
  // A direct acceptance event (an older client, a hand-written event) is held as the server's action is.
  x.accept(x.user());
  assert.equal(x.st().status, "review");
  assert.ok(x.warned(/2 decisions are open: D2 \(not answered\), D3 \(not answered\); the acceptance is ignored/));
  answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D2", version: 1, round: 1, choice: "A" });
  answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D3", version: 1, round: 1, text: "neither: use C" });
  assert.equal(userAcceptRefusal(x.state(), x.q(), x.st()), undefined);
  x.accept(x.user());
  assert.equal(x.st().status, "done");
  assert.equal(x.st().accepted?.by, "user");
});

test("answers: a wrong or empty option is refused, the same answer twice writes once, a stale page is refused", () => {
  const x = setup();
  x.work([["D1"]]);
  const ans = (body: Record<string, unknown>) => () => answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D1", version: 1, round: 1, ...body });
  assert.throws(ans({ choice: "C" }), /"C" is not an option of decision D1/);
  assert.throws(ans({}), /needs a choice or a text/);
  assert.throws(ans({ text: "   " }), /needs a choice or a text/);
  assert.throws(() => answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D9", version: 1, round: 1, choice: "A" }), (e: ActionError) => e.status === 404);
  const first = ans({ choice: "A" })();
  const again = ans({ choice: "A" })();
  assert.equal(again.answer, first.answer, "the same answer again is the one saved");
  assert.equal(x.d("D1").answers.length, 1);
  // Material re-added under the key the decision names: a new version; the earlier answer no longer counts.
  x.decision(x.worker, "D2", { material: ["layout@1440"] }); // refused: the step is in review, not at work
  assert.ok(x.warned(/not at work: its worker declares its decisions before step.done/));
  x.emit(x.worker, { type: "review.added", items: [{ path: "C:/x/a.png" }] });
  assert.equal(x.d("D1").version, 1, "material it does not name changes nothing");
  const y = setup();
  y.work([["D1", { material: ["layout@1440"] }]]);
  const first2 = answerDecision(y.store, { queue: "Q", step: "Q1", decision: "D1", version: 1, round: 1, choice: "A" });
  y.emit(y.worker, { type: "review.added", items: [{ path: "C:/x/b.png", key: "layout@1440", role: "variant-b" }] });
  assert.equal(y.d("D1").version, 2);
  assert.ok(y.d("D1").answers.some((a) => a.event === first2.answer), "the earlier answer is history");
  assert.match(userAcceptRefusal(y.state(), y.q(), y.st()) ?? "", /D1 \(the question changed since its answer\)/);
  assert.throws(() => answerDecision(y.store, { queue: "Q", step: "Q1", decision: "D1", version: 1, round: 1, choice: "A" }), (e: ActionError) => e.status === 409 && /changed since you read it/.test(e.message));
  answerDecision(y.store, { queue: "Q", step: "Q1", decision: "D1", version: 2, round: 1, choice: "A" });
  assert.equal(userAcceptRefusal(y.state(), y.q(), y.st()), undefined);
});

test("an acceptance names the answers it saw: one saved meanwhile in another tab refuses it", () => {
  const x = setup();
  x.work([["D1"], ["D2"]]);
  const a1 = answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D1", version: 1, round: 1, choice: "A" }).answer;
  const a2 = answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D2", version: 1, round: 1, choice: "A" }).answer;
  assert.equal(userAcceptRefusal(x.state(), x.q(), x.st(), { D1: a1, D2: a2 }), undefined);
  answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D2", version: 1, round: 1, choice: "B" });
  assert.match(userAcceptRefusal(x.state(), x.q(), x.st(), { D1: a1, D2: a2 }) ?? "", /answers changed since you read them \(D2\)/);
  assert.match(userAcceptRefusal(x.state(), x.q(), x.st(), "D1") ?? "", /the answers you saw/);
});

test("an answer choosing an option that asks for a change holds every acceptance", () => {
  const x = setup({ level: 3 });
  x.work([["D1", { options: [{ label: "Fine" }, { label: "Needs a fix", effect: "fix" }], recommended: "Fine", for: "reviewer" }]]);
  x.answer(x.orch, "D1", "Needs a fix");
  assert.match(gate(x.q(), x.st(), "orchestrator", x.state().project) ?? "", /asks for a change/);
  x.accept(x.orch);
  x.emit(x.orch, { type: "review.provisional" });
  assert.equal(x.st().status, "review");
  assert.match(userAcceptRefusal(x.state(), x.q(), x.st()) ?? "", /D1 \(the answer "Needs a fix" asks for a change\)/);
});

test("Fix it opens a new round: the earlier answers are history and every decision is open again", () => {
  const x = setup();
  x.work([["D1"], ["D2"]]);
  answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D1", version: 1, round: 1, choice: "B" });
  // Fix it without answering D2.
  assert.match(sendBack(x.store, { queue: "Q", step: "Q1", from: "user", text: "make B denser" }), /round 2/);
  assert.equal(x.st().status, "running");
  x.emit(x.worker, { type: "step.done", summary: "denser" });
  assert.equal(reviewRound(x.q(), x.st()), 2);
  assert.equal(x.d("D1").answers.length, 1, "kept as history");
  assert.equal(currentAnswer(x.d("D1"), 2), undefined, "no answer of round 2");
  assert.deepEqual(openIds(x), ["D1", "D2"]);
  assert.throws(() => answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D1", version: 1, round: 1, choice: "B" }), /review round 2/);
  answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D1", version: 1, round: 2, choice: "B" });
  answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D2", version: 1, round: 2, choice: "A" });
  x.accept(x.user());
  assert.equal(x.st().status, "done");
});

test("Reject needs no answer either", () => {
  const x = setup();
  x.work([["D1"]]);
  x.emit(x.user(), { type: "review.rejected", text: "wrong direction" });
  assert.equal(x.st().status, "rejected");
});

test("rights: the worker never answers; level 2 keeps the user's decisions the user's; level 3 answers them provisionally", () => {
  const x = setup({ level: 2 });
  x.work([["D1"], ["D2", { for: "reviewer" }]]);
  x.answer(x.worker, "D2", "A");
  assert.ok(x.warned(/review.decided is for orchestrators; ignored/), "a worker's answer is refused by its role");
  x.answer(x.orch, "D1", "B");
  assert.ok(x.warned(/D1 is the user's and step Q1 is at review level 2 with away mode off: hand it to the user/));
  x.answer(x.orch, "D2", "A");
  assert.equal(currentAnswer(x.d("D2"), 1)?.by, "orchestrator");
  x.accept(x.orch);
  assert.equal(x.st().status, "review", "D1 is the user's to answer");
  assert.ok(x.warned(/D1 \(not answered\); the acceptance is ignored/));
  // The orchestrator hands the step over; its answers after that do not count, the earlier ones do.
  x.emit(x.orch, { type: "review.asked_user", text: "D1 is yours" });
  x.answer(x.orch, "D2", "B");
  assert.ok(x.warned(/not waiting for the orchestrator's review; ignored/));
  assert.equal(currentAnswer(x.d("D2"), 1)?.choice, "A");
  assert.deepEqual(openIds(x), ["D1"]);
  answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D1", version: 1, round: 1, choice: "B" });
  x.accept(x.user());
  assert.equal(x.st().status, "done");

  const y = setup({ level: 3 });
  y.work([["D1"]]);
  y.answer(y.orch, "D1", "B", { text: "reads better" });
  assert.equal(currentAnswer(y.d("D1"), 1)?.provisional, true);
  y.accept(y.orch);
  assert.equal(y.st().status, "review", "a plain acceptance needs the user's own answer");
  assert.match(userAcceptRefusal(y.state(), y.q(), y.st()) ?? "", /the orchestrator's answer is a proposal/);
  y.emit(y.orch, { type: "review.provisional", text: "the layout is yours" });
  assert.equal(y.st().status, "done");
  assert.ok(y.st().provisional);
});

test("away mode: the orchestrator's answers while away count for a provisional acceptance; after its end they do not", () => {
  const x = setup({ level: 2 });
  x.work([["D1"]]);
  const since = new Date(last - 60_000).toISOString();
  const until = new Date(last + 3000).toISOString();
  writeAway({ protocol: 1, past: [{ since, until, ended: until, why: "expired" }] });
  x.answer(x.orch, "D1", "B");
  assert.equal(currentAnswer(x.d("D1"), 1)?.provisional, true, "given while away");
  ahead(5000); // away has ended
  x.emit(x.orch, { type: "review.provisional" });
  assert.equal(x.st().status, "review", "a provisional acceptance after the end is ignored (today's rule)");
  x.answer(x.orch, "D1", "A");
  assert.ok(x.warned(/review level 2 with away mode off: hand it to the user/), "an answer after the end is refused");
  assert.equal(currentAnswer(x.d("D1"), 1)?.choice, "B", "the answer given while away stays, as a proposal");
  assert.match(userAcceptRefusal(x.state(), x.q(), x.st()) ?? "", /proposal/);
});

test("the return batch lists the orchestrator's answers with why, time and the away mark, and the acceptance to confirm", () => {
  const x = setup({ level: 3 });
  x.work([["D1"], ["D2", { for: "reviewer" }]]);
  const since = new Date(last - 60_000).toISOString();
  const until = new Date(last + 3000).toISOString();
  writeAway({ protocol: 1, past: [{ since, until, ended: until, why: "expired" }] });
  x.answer(x.orch, "D1", "B", { text: "reads better" });
  ahead(5000); // away has ended: level 3 still lets the orchestrator answer, not marked "while you were away"
  x.answer(x.orch, "D2", "A");
  const event = x.emit(x.orch, { type: "review.provisional", text: "the layout is yours" });
  const batch = x.state().attention.find((a) => a.kind === "provisional")!.provisional!;
  assert.deepEqual(batch.map((b) => [b.step, b.event]), [["Q1", event]]);
  assert.deepEqual(batch[0]!.decisions!.map((d) => [d.id, d.by, d.choice, d.words, d.provisional, d.away, d.for, d.options]), [
    ["D1", "orchestrator", "B", "reads better", true, true, "user", ["A", "B"]],
    ["D2", "orchestrator", "A", undefined, undefined, undefined, "reviewer", ["A", "B"]],
  ]);
  // A step that declared none: its why instead of answers.
  const y = setup({ level: 3 });
  y.work([], "a refactor");
  y.emit(y.orch, { type: "review.provisional" });
  const row = y.state().attention.find((a) => a.kind === "provisional")!.provisional![0]!;
  assert.equal(row.none, "a refactor");
  assert.equal(row.decisions, undefined);
});

test("the user's level 1 takes the review: the orchestrator's later answers do not count", () => {
  const x = setup({ level: 2 });
  x.work([["D1", { for: "reviewer" }]]);
  setStepLevel(x.store, "Q", "Q1", 1);
  assert.equal(x.st().review_with, "user");
  x.answer(x.orch, "D1", "A");
  assert.equal(currentAnswer(x.d("D1"), 1), undefined);
  assert.deepEqual(openIds(x), ["D1"]);
});

test("the review helper answers the reviewer's decisions, hands the user's to the user, and accepts only without them", () => {
  const x = setup({ level: 2 });
  x.work([["D1", { for: "reviewer" }], ["D2"]]);
  const helper = x.session("helper", { about: { queue: "Q", step: "Q1", round: 1, level: 2 } });
  x.emit(helper, { type: "review.asked_user", text: "D2 is the user's" });
  assert.ok(x.warned(/the reviewer's decisions D1 are not answered yet; the review helper's hand-over is ignored/));
  x.answer(helper, "D2", "A");
  assert.ok(x.warned(/D2 is the user's: a review helper answers only a reviewer's decision/));
  x.answer(helper, "D1", "A");
  assert.equal(currentAnswer(x.d("D1"), 1)?.by, "helper");
  x.accept(helper);
  assert.equal(x.st().status, "review", "D2 holds the helper's acceptance");
  x.emit(helper, { type: "review.asked_user", text: "D2 is the user's" });
  assert.equal(x.st().review_with, "user");

  const y = setup({ level: 2 });
  y.work([["D1", { for: "reviewer" }]]);
  const h2 = y.session("helper", { about: { queue: "Q", step: "Q1", round: 1, level: 2 } });
  y.answer(h2, "D1", "B");
  y.accept(h2);
  assert.equal(y.st().status, "done");
  assert.equal(y.st().accepted?.by, "helper");
});

test("the orchestrator completes the list while it holds the review: adds, raises to the user, never lowers, withdraws", () => {
  const x = setup({ level: 2 });
  x.work([["D1", { for: "reviewer" }], ["D2"]]);
  x.decision(x.orch, "D3", { for: "reviewer" });
  assert.equal(x.d("D3").by, "orchestrator");
  x.decision(x.orch, "D1", { for: "user", text: "Question D1, the user's?" });
  assert.deepEqual([x.d("D1").version, x.d("D1").for], [2, "user"]);
  x.decision(x.orch, "D2", { for: "reviewer" });
  assert.ok(x.warned(/D2 of step Q1 is the user's; the orchestrator does not make it a reviewer's/));
  x.decision(x.orch, "D3", { withdrawn: "not a decision" });
  assert.ok(x.d("D3").withdrawn);
  x.decision(x.orch, "D3");
  assert.ok(x.warned(/D3 of step Q1 was withdrawn; its id is not used again/));
  x.emit(x.user(), { type: "review.decision", decision: "D4", text: "?", options: [{ label: "A" }, { label: "B" }], for: "user" });
  assert.ok(x.warned(/review.decision is a worker's or the orchestrator's; ignored/));
  x.decision(x.worker, "D5");
  assert.ok(x.warned(/not at work/), "the worker declares only while at work");
  x.decision(x.orch, "D6", { recommended: "Z" });
  assert.ok(x.warned(/recommendation "Z" is not one of its options; dropped/));
  assert.equal(x.d("D6").recommended, undefined);
});

test("Nexus's own acceptance waits for open decisions", () => {
  const x = setup({ level: 2 });
  x.work([["D1", { for: "reviewer" }]]);
  const st: StepView = { ...x.st(), model_free: true };
  assert.equal(acceptedByNexus(x.q(), st), false);
  x.answer(x.orch, "D1", "A");
  assert.equal(gate(x.q(), x.st(), "nexus", x.state().project), undefined);
});

test("Confirm all: every provisional acceptance as seen, or nothing", () => {
  const x = setup({ level: 3 });
  x.store.writeQueue({ ...x.store.readQueue("Q") });
  x.work([["D1"]]);
  x.answer(x.orch, "D1", "B");
  x.emit(x.orch, { type: "review.provisional" });
  const event = x.st().provisional!.event;
  assert.throws(() => confirmProvisionals(x.store, [{ queue: "Q", step: "Q1", event: "other" }]), /accepted provisionally again since you looked/);
  assert.throws(() => confirmProvisionals(x.store, [{ queue: "Q", step: "Q1", event }, { queue: "Q", step: "Q2", event }]), /no provisional acceptance waiting/);
  assert.equal(x.st().provisional?.confirmed, undefined, "nothing was written");
  assert.throws(() => confirmProvisionals(x.store, []), /the provisional acceptances to confirm/);
  assert.match(confirmProvisionals(x.store, [{ queue: "Q", step: "Q1", event }]), /1 step confirmed/);
  assert.ok(x.st().provisional?.confirmed);
});

test("a restart derives the same list, answers and history from the files", () => {
  const x = setup();
  x.work([["D1"], ["D2"]]);
  answerDecision(x.store, { queue: "Q", step: "Q1", decision: "D1", version: 1, round: 1, choice: "B" });
  sendBack(x.store, { queue: "Q", step: "Q1", from: "user", text: "again" });
  x.emit(x.worker, { type: "step.done", summary: "again" });
  const before = x.st();
  const again = loadProjectState(ProjectStore.forRoot(x.root)).queues.find((q) => q.id === "Q")!.steps.find((s) => s.id === "Q1")!;
  assert.deepEqual(again.decisions, before.decisions);
  assert.equal(again.decision_list, before.decision_list);
});
