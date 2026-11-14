// Review levels (PROTOCOL.md, "Review"): the old review policies read as levels in every file that had them, an
// approval of the old form that stays, the levels the user sets on steps (kept across revisions, no new approval), and
// steps done before the change, which keep the meaning they had.
// Where a level comes from and whom a step's review goes to are in state.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  ActionError, GlobalSettings, ProjectFile, ProjectStore, QueueFile, StoredProject, applyDraft, approveQueue, isApproved, legacyLevel,
  loadProjectState, newId, readGlobalSettings, setStepLevel, type Event, type StepDef,
} from "../src/index.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-levels-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  return { root, store };
}
const step = (id: string, review?: StepDef["review"]): StepDef => ({ id, title: `Step ${id}`, goal: `Do ${id}.`, acceptance: [`${id} works`], ...(review ? { review } : {}) });

test("every old review policy becomes its level: continue and orchestrator 2, wait 1", () => {
  assert.deepEqual((["continue", "orchestrator", "wait"] as const).map(legacyLevel), [2, 2, 1]);
  for (const [policy, level] of [["continue", 2], ["orchestrator", 2], ["wait", 1]] as const) {
    const q = QueueFile.parse({ protocol: 1, id: "Q", title: "Q", review_policy: policy, steps: [{ id: "Q1", title: "One", review: { prepare: "x", policy } }] });
    assert.equal(q.review_level, level, `the queue's ${policy}`);
    assert.deepEqual(q.steps[0]!.review, { prepare: "x", level }, `a step's ${policy}`);
    assert.ok(!("review_policy" in q) && !("policy" in q.steps[0]!.review!), "the old keys are gone");
    const defaults = { review_policy: policy };
    assert.equal(GlobalSettings.parse({ protocol: 1, defaults }).defaults.review_level, level, `global ${policy}`);
    assert.equal(ProjectFile.parse({ protocol: 1, id: "p", name: "P", root: "C:/p", defaults }).defaults.review_level, level, `a project from before global settings, ${policy}`);
    assert.equal(StoredProject.parse({ protocol: 1, id: "p", name: "P", root: "C:/p", follows_global: true, defaults }).defaults.review_level, level, `a project's own ${policy}`);
  }
  // A level already there wins over an old policy beside it; the built-in default is 2; anything else is refused.
  assert.equal(QueueFile.parse({ protocol: 1, id: "Q", title: "Q", review_policy: "wait", review_level: 3 }).review_level, 3);
  assert.equal(GlobalSettings.parse({ protocol: 1 }).defaults.review_level, 2);
  assert.equal(StoredProject.parse({ protocol: 1, id: "p", name: "P", root: "C:/p", follows_global: true }).defaults.review_level, undefined, "a project without one follows the global value");
  assert.throws(() => QueueFile.parse({ protocol: 1, id: "Q", title: "Q", review_policy: "sometimes" }));
  assert.throws(() => QueueFile.parse({ protocol: 1, id: "Q", title: "Q", steps: [{ id: "Q1", title: "One", review: { level: 4 } }] }));
});

test("the old settings files read as levels: the global file and a project's own value", () => {
  const { root, store } = setup();
  mkdirSync(join(root, "home"), { recursive: true });
  writeFileSync(join(root, "home", "settings.yaml"), "protocol: 1\ndefaults:\n  review_policy: wait\n");
  assert.equal(readGlobalSettings().defaults.review_level, 1);
  assert.equal(store.readProject().defaults.review_level, 1, "the project follows it");
  const file = join(root, ".nexus", "project.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace(/defaults:.*\n/, "").concat("defaults:\n  review_policy: orchestrator\n"));
  assert.equal(store.readStoredProject().defaults.review_level, 2, "its own value, read as a level");
  assert.equal(store.readProject().defaults.review_level, 2);
  store.updateProject((p) => p);
  assert.match(readFileSync(file, "utf8"), /review_level: 2/);
  assert.doesNotMatch(readFileSync(file, "utf8"), /review_policy/, "written in the new form");
});

/** queue.yaml as the code before review levels wrote it, approved with that code's hash. */
function legacyQueue(store: ProjectStore) {
  const steps = [
    { id: "Q1", title: "One", goal: "Do one.", acceptance: ["one works"] },
    { id: "Q2", title: "Two", goal: "Do two.", acceptance: ["two works"], review: { prepare: "views@1440 result", policy: "wait" } },
    { id: "Q3", title: "Three", goal: "Do three.", acceptance: ["three works"], review: { policy: "continue" } },
  ];
  const content = { steps, stop_conditions: ["stop"], checks: ["npm test"] };
  const hash = "sha256:" + createHash("sha256").update(JSON.stringify(content)).digest("hex");
  mkdirSync(store.queueDir("L"), { recursive: true });
  const raw = {
    protocol: 1, id: "L", title: "Legacy", revision: 1, status: "approved", review_policy: "orchestrator", ...content,
    approvals: [{ revision: 1, at: "2026-11-13T10:00:00.000Z", hash }], withdrawals: [], history: [], changes: [],
  };
  writeFileSync(join(store.queueDir("L"), "queue.yaml"), YAML.stringify(raw));
  return { raw, hash };
}

test("an approved queue with the old review fields stays approved, also once it is written in the new form", () => {
  const { store } = setup();
  const { hash } = legacyQueue(store);
  const q = store.readQueue("L");
  assert.deepEqual([q.review_level, q.steps.map((s) => s.review?.level)], [2, [undefined, 1, 2]]);
  assert.ok(isApproved(q), "approved after the change to levels");
  assert.notEqual(q.approvals[0]!.hash, hash, "the approval pins the new form of the same content");
  assert.equal(loadProjectState(store).queues[0]!.approved, true);
  assert.deepEqual(loadProjectState(store).queues[0]!.steps.map((s) => s.level), [2, 1, 2]);

  store.writeQueue(q); // its next write, by the server
  const text = readFileSync(join(store.queueDir("L"), "queue.yaml"), "utf8");
  assert.doesNotMatch(text, /policy/);
  assert.ok(isApproved(store.readQueue("L")), "still approved, read from the new form");
  assert.deepEqual(store.readQueue("L"), q, "and reads as it did");
});

test("an old approval is carried over only when it pinned that very content", () => {
  const { store } = setup();
  legacyQueue(store);
  const file = join(store.queueDir("L"), "queue.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace("Do three.", "Do three, differently."));
  assert.equal(isApproved(store.readQueue("L")), false, "the content changed after the approval");
});

test("the user's level of a step: recorded apart, asks for no new approval, and stays across a revision", () => {
  const { store } = setup();
  applyDraft(store, { id: "Q", title: "Queue", steps: [step("Q1"), step("Q2", { level: 1 }), step("Q3")] });
  approveQueue(store, "Q");
  const view = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const levels = () => view().steps.map((s) => `${s.id}=${s.level}${s.level_from === "user" ? " (user)" : ""}`);

  setStepLevel(store, "Q", "Q2", 3);
  setStepLevel(store, "Q", "Q3", 1);
  assert.deepEqual(store.readQueue("Q").user_levels, { Q2: 3, Q3: 1 });
  assert.deepEqual(levels(), ["Q1=2", "Q2=3 (user)", "Q3=1 (user)"]);
  assert.equal(store.readQueue("Q").revision, 1);
  assert.ok(view().approved, "a level the user sets asks for no new approval");

  // The orchestrator's next revision: changes Q3's level and adds Q4; it cannot bring levels of the user's.
  const msg = applyDraft(store, { id: "Q", title: "Queue", user_levels: { Q1: 3 }, steps: [step("Q1"), step("Q2", { level: 2 }), step("Q3", { level: 2 }), step("Q4")] });
  assert.match(msg, /revision 2/);
  assert.deepEqual(store.readQueue("Q").user_levels, { Q2: 3, Q3: 1 }, "the user's levels stay, and a draft adds none");
  assert.deepEqual(levels(), ["Q1=2", "Q2=3 (user)", "Q3=1 (user)", "Q4=2"]);
  approveQueue(store, "Q");

  // Cleared: back to what the step was drafted with. A step a revision removes takes its level along.
  setStepLevel(store, "Q", "Q2", null);
  assert.deepEqual(levels(), ["Q1=2", "Q2=2", "Q3=1 (user)", "Q4=2"]);
  applyDraft(store, { id: "Q", title: "Queue", steps: [step("Q1"), step("Q2", { level: 2 }), step("Q4")] });
  assert.equal(store.readQueue("Q").user_levels, undefined);

  assert.throws(() => setStepLevel(store, "Q", "Q9", 1), (e: ActionError) => e.status === 404);
  for (const bad of [0, 4, "1", "wait"]) assert.throws(() => setStepLevel(store, "Q", "Q1", bad), ActionError);
});

test("a draft with the old review fields is read as levels, so the orchestrator's older drafts keep working", () => {
  const { store } = setup();
  applyDraft(store, { id: "Q", title: "Queue", review_policy: "wait", steps: [{ ...step("Q1"), review: { policy: "orchestrator" } }, step("Q2")] });
  const q = store.readQueue("Q");
  assert.deepEqual([q.review_level, q.steps[0]!.review], [1, { level: 2 }]);
  approveQueue(store, "Q");
  // The same draft again (as an older orchestrator would send it): no change, the approval stands.
  assert.match(applyDraft(store, { id: "Q", title: "Queue", review_policy: "wait", steps: [{ ...step("Q1"), review: { policy: "orchestrator" } }, step("Q2")] }), /no change/);
  assert.ok(isApproved(store.readQueue("Q")));
});

// ---------------------------------------------------------------- steps done before review levels

/** Sessions and an event writer for the tests below (times in minutes after 10:00 on 2026-11-13). */
function sessions(store: ProjectStore) {
  for (const [id, role] of [["w", "worker"], ["o", "orchestrator"], ["u", "user"]] as const) {
    store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: ".", launched_by: "nexus", created_at: "2026-11-13T09:00:00.000Z" });
  }
  const at = (min: number) => new Date(Date.parse("2026-11-13T10:00:00Z") + min * 60_000).toISOString();
  const emit = (min: number, session: string, body: Record<string, unknown>) =>
    store.appendEvent({ v: 1, id: newId(), at: at(min), session, ...body } as Event);
  const done = (min: number, queue: string, step: string) => {
    emit(min, "w", { type: "step.started", queue, step });
    emit(min, "w", { type: "step.done", queue, step, summary: "ok" });
  };
  return { at, emit, done };
}

/** queue.yaml as written before review levels: `policy` on the queue, and on a step if given. */
function oldQueue(store: ProjectStore, id: string, policy: string, stepPolicies: (string | undefined)[]) {
  mkdirSync(store.queueDir(id), { recursive: true });
  const steps = stepPolicies.map((p, i) => ({ id: `${id}${i + 1}`, title: `Step ${i + 1}`, goal: "", acceptance: [], ...(p ? { review: { policy: p } } : {}) }));
  writeFileSync(join(store.queueDir(id), "queue.yaml"), YAML.stringify({ protocol: 1, id, title: id, revision: 1, status: "approved", review_policy: policy, steps }));
}

test("a queue finished under the old `continue` stays done after the change to levels: nothing waits, nothing is told", () => {
  const { store } = setup();
  const { at, done } = sessions(store);
  store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: null } }));
  oldQueue(store, "C", "continue", [undefined, undefined]);
  done(1, "C", "C1"); done(2, "C", "C2");
  assert.equal(store.markReviewLevels(at(10)), true, "the server's first start with review levels");
  assert.equal(store.markReviewLevels(at(20)), false, "once");
  assert.equal(store.readProject().review_levels_since, at(10));
  const view = () => loadProjectState(store);
  const q = () => view().queues.find((x) => x.id === "C")!;
  assert.deepEqual([q().status, ...q().steps.map((s) => `${s.status}:${s.review_with ?? ""}`)], ["done", "done:", "done:"]);
  assert.deepEqual(view().attention, [], "nothing waits for the user");
  // The orchestrator's review notices come from steps waiting for it: there are none.
  assert.ok(!view().queues.some((x) => x.steps.some((s) => s.review_with === "orchestrator")));

  // Written in the new form (the server's next write), the old meaning stays with the file.
  store.writeQueue(store.readQueue("C"));
  assert.doesNotMatch(readFileSync(join(store.queueDir("C"), "queue.yaml"), "utf8"), /review_policy/);
  assert.deepEqual(store.readQueue("C").legacy_policies, { C1: "continue", C2: "continue" });
  assert.equal(q().status, "done");
});

test("before review levels an orchestrator's acceptance stands, a review still open stays open, and later steps go by level", () => {
  const { store } = setup();
  const { at, emit, done } = sessions(store);
  store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: null } }));
  oldQueue(store, "O", "orchestrator", [undefined, undefined, "continue", undefined]);
  done(1, "O", "O1");
  emit(2, "o", { type: "review.accepted", queue: "O", step: "O1" }); // accepted by the old orchestrator review
  done(3, "O", "O2"); // waiting for the orchestrator at the change
  store.markReviewLevels(at(10));
  emit(11, "o", { type: "review.accepted", queue: "O", step: "O2" });
  done(12, "O", "O3"); // its old policy was continue, but it is done after the change: reviewed by its level
  const steps = () => loadProjectState(store).queues.find((x) => x.id === "O")!.steps.map((s) => `${s.id}=${s.status}:${s.review_with ?? ""}`);
  assert.deepEqual(steps(), ["O1=done:", "O2=done:", "O3=review:orchestrator", "O4=pending:"]);

  // A revision keeps what the steps done before meant; the user's own steps (old `wait`) waited for the user.
  applyDraft(store, { id: "O", title: "O", steps: [1, 2, 3, 4].map((n) => ({ id: `O${n}`, title: `Step ${n}`, goal: "", acceptance: [], ...(n === 3 ? { review: { level: 2 } } : {}) })) });
  assert.deepEqual(store.readQueue("O").legacy_policies, { O1: "orchestrator", O2: "orchestrator", O3: "continue", O4: "orchestrator" });
  oldQueue(store, "W", "wait", [undefined, "continue"]);
  done(4, "W", "W1"); done(5, "W", "W2");
  const w = loadProjectState(store).queues.find((x) => x.id === "W")!;
  assert.deepEqual(w.steps.map((s) => `${s.status}:${s.review_with ?? ""}`), ["review:user", "done:"]);
});

test("without the old fields (a file the first level code rewrote), a step done before the change reads by its level", () => {
  const { store } = setup();
  const { at, done } = sessions(store);
  for (const [id, level] of [["A", 2], ["B", 1]] as const) {
    store.writeQueue({ protocol: 1, id, title: id, revision: 1, status: "approved", review_level: level, stop_conditions: [], checks: [], steps: [{ id: `${id}1`, title: "One", goal: "", acceptance: [] }] });
    done(1, id, `${id}1`);
  }
  store.markReviewLevels(at(10));
  const s = loadProjectState(store);
  assert.deepEqual(s.queues.map((q) => `${q.id}:${q.status}:${q.steps[0]!.status}:${q.steps[0]!.review_with ?? ""}`), ["A:done:done:", "B:waiting:review:user"]);
});

test("a project without the mark (a new one) reviews every step by level", () => {
  const { store } = setup();
  const { done } = sessions(store);
  oldQueue(store, "C", "continue", [undefined]);
  done(1, "C", "C1");
  assert.equal(loadProjectState(store).queues[0]!.steps[0]!.status, "review");
});

// ---------------------------------------------------------------- provisional acceptances (review level 3)

test("a provisional acceptance is the orchestrator's, at level 3 only; confirming and Fix it are the user's, once", () => {
  const { store } = setup();
  const { emit, done } = sessions(store);
  store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: null } }));
  applyDraft(store, { id: "Q", title: "Q", steps: [step("Q1", { level: 3 }), step("Q2", { level: 2 }), step("Q3", { level: 3 })] });
  approveQueue(store, "Q");
  const st = (id: string) => loadProjectState(store).queues[0]!.steps.find((s) => s.id === id)!;
  done(1, "Q", "Q1"); done(1, "Q", "Q2"); done(1, "Q", "Q3");
  emit(2, "u", { type: "review.provisional", queue: "Q", step: "Q1" }); // the user's: ignored
  emit(2, "o", { type: "review.provisional", queue: "Q", step: "Q2" }); // level 2: ignored
  assert.deepEqual([st("Q1").status, st("Q2").status], ["review", "review"]);
  emit(3, "o", { type: "review.provisional", queue: "Q", step: "Q1", text: "Check the look." });
  emit(3, "o", { type: "review.provisional", queue: "Q", step: "Q3" });
  assert.deepEqual([st("Q1").status, st("Q1").provisional?.text], ["done", "Check the look."]);
  emit(4, "o", { type: "review.confirmed", queue: "Q", step: "Q1" }); // USER_ONLY: ignored
  assert.equal(st("Q1").provisional?.confirmed, undefined);
  emit(5, "u", { type: "review.confirmed", queue: "Q", step: "Q1" });
  emit(6, "u", { type: "review.fix_asked", queue: "Q", step: "Q1", text: "too late" }); // confirmed already: ignored
  emit(6, "u", { type: "review.fix_asked", queue: "Q", step: "Q3", text: "Bigger." });
  const s = loadProjectState(store);
  assert.deepEqual([st("Q1").provisional?.confirmed !== undefined, st("Q1").provisional?.fix], [true, undefined]);
  assert.deepEqual(st("Q3").provisional?.fix?.text, "Bigger.");
  assert.equal(s.attention.filter((a) => a.kind === "provisional").length, 0, "both resolved: no batch");
  assert.ok(s.warnings.some((w) => /review.confirmed is the user's; ignored/.test(w)));
  assert.ok(s.warnings.some((w) => /a provisional acceptance is the orchestrator's; ignored/.test(w)));
  assert.ok(s.warnings.some((w) => /at review level 2 and away mode was off; a provisional acceptance is for level 3/.test(w)));
});
