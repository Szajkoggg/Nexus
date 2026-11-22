import { test } from "node:test";
import assert from "node:assert/strict";
import type { Event, QueueView, StepView } from "@nexus/protocol";
import {
  answerText, approvalHistory, approvalWord, canWithdrawApproval, describe, integrationState, isImage, mergeBackInto, mergeBackPath, queueOver, questionState, shownPicture,
  showsWorktreeActions,
  stepLayout, stepPictures,
} from "../src/details.ts";

const step = (over: Partial<StepView> = {}) => ({ id: "S1", status: "running", session: "w1", review_items: [], pictures: {}, ...over }) as StepView;
type Q = QueueView["questions"][number];
const question = (qid: string, state: Q["state"]) => ({ qid, state, step: "S1", text: "?", answers: [], can_continue: false, asked_at: "2026-11-15T10:00:00Z" }) as unknown as Q;

test("a step at work with a session can be messaged; notes are open before it starts, at a stop, and in the orchestrator's review", () => {
  assert.equal(stepLayout(step(), [], false).live, true);
  assert.equal(stepLayout(step({ session: undefined }), [], false).live, false);
  assert.equal(stepLayout(step({ status: "done" }), [], false).live, false);
  for (const [status, open] of [["pending", true], ["stopped", true], ["running", false], ["done", false]] as const) {
    assert.equal(stepLayout(step({ status }), [], false).notesOpen, open, status);
  }
  const held = stepLayout(step({ status: "review", review_with: "orchestrator" }), [], false);
  assert.deepEqual([held.forOrchestrator, held.notesOpen, held.reviewing], [true, true, false]);
});

test("the user's review takes the action bar; else the first open question does, as a sheet on the phone", () => {
  const qs = [question("q0", "answered"), question("q1", "open"), question("q2", "escalated")];
  const review = stepLayout(step({ status: "review", review_with: "user" }), qs, true);
  assert.deepEqual([review.reviewing, review.asking, review.questionFirst], [true, undefined, false]);
  const desk = stepLayout(step({ status: "waiting" }), qs, false);
  assert.deepEqual([desk.asking?.qid, desk.questionFirst], ["q1", false]);
  assert.equal(stepLayout(step({ status: "waiting" }), qs, true).questionFirst, true);
  assert.equal(stepLayout(step({ status: "waiting" }), [question("q0", "answered")], true).questionFirst, false, "nothing open: no sheet");
});

test("the orchestrator's reason for handing the review over shows; a level the user set has none", () => {
  const at = "2026-11-15T10:00:00Z";
  assert.equal(stepLayout(step({ status: "review", asked_user: { text: "Check the colours", at } }), [], false).orchestratorAsks, "Check the colours");
  assert.equal(stepLayout(step({ status: "review", asked_user: { text: "level 1", at, by: "user" } }), [], false).orchestratorAsks, undefined);
});

test("pictures: images only, each with its counterpart; the viewer's picture is kept within them", () => {
  assert.deepEqual(["a.png", "b.JPG", "c.svg", "d.pdf", undefined].map((path) => isImage({ path } as StepView["review_items"][number])), [true, true, true, false, false]);
  const { pairs, images } = stepPictures(step({
    review_items: [
      { path: "/r/tab.before.png", label: "Tab, before", key: "tab@492", role: "before" },
      { path: "/r/tab.png", label: "Tab", key: "tab@492", role: "after" },
      { path: "/r/notes.md", label: "Notes" },
      { path: "/r/lit.png", before: "/r/unlit.png" },
    ] as StepView["review_items"],
    pictures: { "/r/tab.png": { accepted: true, comments: [{ text: "ok", at: "x", to: "send_back" }] } } as unknown as StepView["pictures"],
  }), (p) => `url:${p}`);
  assert.equal(pairs.length, 3, "the Markdown file is no picture");
  assert.deepEqual(images.map((i) => [i.src, i.label, i.before?.src ?? null, i.before?.label ?? null, i.accepted, i.comments]), [
    ["url:/r/tab.before.png", "Tab, before", null, null, false, 0],
    ["url:/r/tab.png", "Tab", "url:/r/tab.before.png", "Tab, before", true, 1],
    ["url:/r/lit.png", "lit.png", "url:/r/unlit.png", "unlit.png", false, 0],
  ]);
  assert.deepEqual([shownPicture(undefined, 3), shownPicture("1", 3), shownPicture("9", 3), shownPicture("x", 3), shownPicture("-2", 3)], [undefined, 1, 2, 0, 0]);
});

test("an answer is the option, then the words; neither is no answer", () => {
  assert.equal(answerText("A list", ""), "A list");
  assert.equal(answerText(undefined, "my words"), "my words");
  assert.equal(answerText("A list", "with paging"), `A list${String.fromCharCode(10, 10)}with paging`);
  assert.equal(answerText(undefined, ""), undefined);
  assert.equal(questionState("answered"), "answered");
  assert.equal(questionState("something new"), "something new", "an unknown state as it is");
});

test("a timeline line says what the event carries", () => {
  const e = (x: Record<string, unknown>) => ({ id: "e", at: "x", session: "s", v: 1, ...x }) as unknown as Event;
  assert.equal(describe(e({ type: "step.progress", text: "Halfway", pct: 50 })), "Halfway (50%)");
  assert.equal(describe(e({ type: "check.result", name: "npm test", ok: false, duration: 21, summary: "2 failed" })), "✗ npm test (21 s) — 2 failed");
  assert.equal(describe(e({ type: "queue.stop", condition: "A check fails", reason: "lint" })), "A check fails: lint");
  assert.equal(describe(e({ type: "review.added", items: [{ label: "Tab" }, { path: "/a.png" }, { url: "http://x" }] })), "Tab, /a.png, http://x");
  assert.equal(describe(e({ type: "context.summary", text: "y".repeat(300) })).length, 200);
  assert.equal(describe(e({ type: "review.accepted" })), "");
  assert.equal(describe(e({ type: "step.started" })), "");
});

test("the approval history in time order, and the header's word for where the approval stands", () => {
  const a = (revision: number, at: string) => ({ revision, at });
  const q = { approved: false, approvals: [a(1, "2026-11-15T09:00:00Z"), a(2, "2026-11-15T11:00:00Z")], withdrawals: [{ ...a(1, "2026-11-15T10:00:00Z"), approvals: 1 }] } as unknown as QueueView;
  assert.deepEqual(approvalHistory(q).map((x) => [x.revision, x.withdrawn]), [[1, false], [1, true], [2, false]]);
  assert.equal(approvalWord({ ...q, approved: true }), "details.approval.approved");
  assert.equal(approvalWord(q), "details.approval.older", "a withdrawal before the last approval");
  assert.equal(approvalWord({ ...q, withdrawals: [{ ...a(2, "2026-11-15T12:00:00Z"), approvals: 2 }] } as unknown as QueueView), "details.approval.withdrawn");
  assert.equal(approvalWord({ approved: false, approvals: [], withdrawals: [] }), "details.approval.none");
});

test("an approval is taken back only from a queue that never ran", () => {
  const pending = { status: "pending", segments: [] };
  const q = (over: object) => ({ approved: true, run: undefined, steps: [pending, pending], ...over }) as unknown as QueueView;
  assert.equal(canWithdrawApproval(q({})), true);
  assert.equal(canWithdrawApproval(q({ approved: false })), false);
  assert.equal(canWithdrawApproval(q({ run: { state: "paused" } })), false);
  assert.equal(canWithdrawApproval(q({ steps: [{ status: "pending", segments: [{ start: "x" }] }] })), false, "a step started once");
  assert.equal(canWithdrawApproval(q({ steps: [{ status: "done", segments: [] }] })), false);
});

test("worktree actions only for a queue's own worktree once it is finished, merged or cleaned up", () => {
  const q = (over: object) => ({ worktree: "C:\\Code\\App.worktrees\\W", status: "done", git: undefined, ...over }) as unknown as QueueView;
  assert.equal(showsWorktreeActions(q({}), "C:/Code/App"), true);
  assert.equal(showsWorktreeActions(q({ worktree: "c:/code/APP" }), "C:\\Code\\App"), false, "the project's own checkout, however written");
  assert.equal(showsWorktreeActions(q({ worktree: "auto" }), "C:/Code/App"), false);
  assert.equal(showsWorktreeActions(q({ worktree: undefined }), "C:/Code/App"), false);
  assert.equal(showsWorktreeActions(q({ status: "running" }), "C:/Code/App"), false);
  assert.equal(showsWorktreeActions(q({ status: "running", git: { merged: { at: "x" } } }), "C:/Code/App"), true);
});

test("Merge back is offered wherever the queue panel offers it, always into the base branch, by the same action", () => {
  const base = { ref: "main", sha: "abc", at: "x" };
  const q = (over: object) => ({ worktree: "C:/Code/App.worktrees/W", status: "done", git: { base }, ...over }) as unknown as QueueView;
  assert.equal(mergeBackInto(q({}), "C:/Code/App"), "main");
  assert.equal(mergeBackInto(q({ git: { base, merge: { waiting: { reason: "the checkout of main has uncommitted changes", since: "x" } } } }), "C:/Code/App"), "main",
    "a merge back the server would refuse now is offered all the same: the server says why");
  assert.equal(mergeBackInto(q({ git: { base, merged: { at: "x", into: "main" } } }), "C:/Code/App"), undefined, "merged");
  assert.equal(mergeBackInto(q({ git: { base, cleaned: { at: "x" } } }), "C:/Code/App"), undefined, "cleaned up");
  assert.equal(mergeBackInto(q({ maintenance: "survey" }), "C:/Code/App"), undefined, "a survey run leaves no commit");
  assert.equal(mergeBackInto(q({ git: { base: { ...base, branch: false } } }), "C:/Code/App"), undefined, "a base that is no branch");
  assert.equal(mergeBackInto(q({ status: "running" }), "C:/Code/App"), undefined, "not finished");
  assert.equal(mergeBackInto(q({ worktree: "C:/Code/App" }), "C:/Code/App"), undefined, "the project's own checkout");
  assert.equal(mergeBackPath("W"), "/queues/W/merge", "the queue panel's action (POST /api/projects/:id/queues/:queue/merge)");
  assert.equal(mergeBackPath("a b"), "/queues/a%20b/merge");
});

test("an integration step's merge back: merged only since the step finished, else waiting and how often run again", () => {
  const git = { base: { ref: "develop" }, merged: { at: "2026-11-15T10:00:00Z" }, merge: { waiting: { reason: "dirty", since: "x" }, reintegrations: 2 } };
  const q = { git } as unknown as QueueView;
  assert.equal(integrationState(q, { finished_at: "2026-11-15T09:00:00Z" }).merged?.at, "2026-11-15T10:00:00Z");
  const before = integrationState(q, { finished_at: "2026-11-15T11:00:00Z" });
  assert.deepEqual([before.merged, before.base, before.waiting?.reason, before.again], [undefined, "develop", "dirty", 2]);
  assert.deepEqual(integrationState({ git: undefined } as unknown as QueueView, {}), { base: "main", merged: undefined, waiting: undefined, again: 0 });
});

test("a finished or cancelled queue is over; its steps open read-only: no level, note, message, review or answer", () => {
  assert.equal(queueOver({ status: "done" }), true);
  assert.equal(queueOver({ status: "cancelled" }), true);
  for (const status of ["proposed", "approved", "running", "paused", "waiting", "stopped"] as const) assert.equal(queueOver({ status }), false, status);
  const open = [question("q1", "open")];
  // A pending step of a cancelled queue would take notes; one waiting for the user's review would show Accept.
  const pending = stepLayout(step({ status: "pending", session: undefined }), [], false, { status: "cancelled" });
  assert.deepEqual([pending.readOnly, pending.notesOpen], [true, false]);
  const review = stepLayout(step({ status: "review", level: 1 } as Partial<StepView>), open, true, { status: "cancelled" });
  assert.deepEqual([review.reviewing, review.asking, review.questionFirst, review.live], [false, undefined, false, false]);
  // The same steps in a queue that goes on are not read-only.
  assert.equal(stepLayout(step({ status: "pending", session: undefined }), [], false, { status: "approved" }).notesOpen, true);
  assert.equal(stepLayout(step(), [], false, { status: "running" }).readOnly, false);
});


test("QA1: clicking BRAVO selects q2 on both layouts, regardless of insertion order", () => {
  const alpha = { ...question("q1", "open"), text: "ALPHA: choose a color" };
  const bravo = { ...question("q2", "open"), text: "BRAVO: choose a layout" };
  const charlie = { ...question("q3", "open"), text: "CHARLIE: choose a sound" };
  for (const phone of [true, false]) {
    for (const qs of [[alpha, bravo, charlie], [charlie, bravo, alpha], [question("q4", "open"), alpha, bravo, charlie]]) {
      const layout = stepLayout(step(), qs, phone, undefined, "q2");
      assert.equal(layout.asking, bravo);
      assert.equal(layout.questionFirst, phone);
    }
  }
});

test("an explicit answered, withdrawn or absent target never falls back to another question or review", () => {
  for (const state of ["answered", "withdrawn"] as const) {
    for (const phone of [true, false]) {
      const qs = [question("q1", "open"), question("q2", state), question("q3", "open")];
      for (const qid of ["q2", "missing"]) {
        const layout = stepLayout(step({ status: "review", review_with: "user" }), qs, phone, undefined, qid);
        assert.equal(layout.asking, undefined);
        assert.equal(layout.questionFirst, false);
        assert.equal(layout.reviewing, false, "answering a question is not accepting the step review");
      }
    }
  }
  assert.equal(stepLayout(step(), [question("q1", "open")], true, { status: "cancelled" }, "q1").asking, undefined);
});
