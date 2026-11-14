// Review levels (PROTOCOL.md, "Review levels"): the old review policies read as levels in every file that had them, an
// approval of the old form that stays, and the levels the user sets on steps (kept across revisions, no new approval).
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
  loadProjectState, readGlobalSettings, setStepLevel, type StepDef,
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
