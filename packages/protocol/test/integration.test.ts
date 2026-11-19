// The integration step (docs/protocol/git.md, "The integration step"): a queue with a worktree of its own (`worktree: auto`, or
// the server's mark `integration`) ends with a step Nexus keeps, after the closing step, whatever `coding` says. Its
// id is reserved, a draft cannot set the mark, agents cannot skip it, and any other step at work after it ran (the
// closing step's run again included) makes it run again at the end. A queue that worked in a worktree before the step
// existed (a path, no mark) gets none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTEGRATION_ACCEPTANCE, INTEGRATION_GOAL, INTEGRATION_TITLE, ProjectStore, applyDraft, approveQueue, integrationStepId, loadProjectState, newId, now,
  isApproved, type Event, type QueueFile, type SessionFile,
} from "../src/index.ts";

function setup(q: Partial<QueueFile> = { worktree: "auto" }) {
  const root = mkdtempSync(join(tmpdir(), "nexus-integration-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.writeQueue({
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }], approvals: [], history: [], ...q,
  });
  const session = (role: SessionFile["role"]): SessionFile => {
    const s: SessionFile = { protocol: 1, id: newId(), project: "p", role, runtime: "external", cwd: root, launched_by: "external", created_at: now(), queue: "Q" };
    st.writeSession(s);
    return s;
  };
  let t = Date.now();
  const emit = (s: SessionFile, body: Record<string, unknown>) =>
    st.appendEvent({ v: 1, id: newId(), at: new Date(++t).toISOString(), session: s.id, ...body } as Event);
  const queue = () => loadProjectState(st).queues.find((x) => x.id === "Q")!;
  const finish = (w: SessionFile, u: SessionFile, step: string) => {
    emit(w, { type: "step.started", queue: "Q", step });
    emit(w, { type: "step.done", queue: "Q", step, summary: `did ${step}` });
    emit(u, { type: "review.accepted", queue: "Q", step });
  };
  const draft = (def: Omit<Partial<QueueFile>, "steps"> & { steps: { id: string; title: string }[] }) =>
    applyDraft(st, { id: "Q", title: "Queue", stop_conditions: [], checks: [], ...def });
  return { st, session, emit, queue, finish, draft };
}

test("a queue with a worktree of its own ends with the integration step, after the closing step, with the standard text and level 2", () => {
  const x = setup({ worktree: "auto", coding: true });
  const q = x.queue();
  assert.deepEqual(q.steps.map((s) => s.id), ["Q1", "Q.refactor", "Q.integrate"]);
  const i = q.steps.at(-1)!;
  assert.equal(i.id, integrationStepId("Q"));
  assert.equal(i.integration, true);
  assert.equal(i.closing, undefined);
  assert.deepEqual([i.title, i.goal, i.acceptance], [INTEGRATION_TITLE, INTEGRATION_GOAL, [...INTEGRATION_ACCEPTANCE]]);
  assert.equal(i.level, 2);
  assert.deepEqual(x.st.readQueue("Q").steps.map((s) => s.id), ["Q1"], "not in the file");

  // Without coding too; with the server's mark once `worktree` names the path.
  assert.deepEqual(setup({ worktree: "auto" }).queue().steps.map((s) => s.id), ["Q1", "Q.integrate"]);
  assert.deepEqual(setup({ worktree: "C:/w/Q", integration: true }).queue().steps.map((s) => s.id), ["Q1", "Q.integrate"]);
});

test("no integration step in the project's checkout, nor for a queue that worked in a worktree before the step existed", () => {
  assert.deepEqual(setup({}).queue().steps.map((s) => s.id), ["Q1"]);
  // Like queue UX of Nexus: a path, finished and merged back by the user, from before the mark.
  assert.deepEqual(setup({ worktree: "C:/w/UX", branch: "nexus/UX" }).queue().steps.map((s) => s.id), ["Q1"]);
});

test("a survey run in a worktree of its own has no integration step (nothing to merge back); fix_small has one", () => {
  assert.deepEqual(setup({ worktree: "auto", maintenance: "survey" }).queue().steps.map((s) => s.id), ["Q1"]);
  assert.deepEqual(setup({ worktree: "C:/w/S", integration: true, maintenance: "survey" }).queue().steps.map((s) => s.id), ["Q1"]);
  assert.deepEqual(setup({ worktree: "auto", maintenance: "fix_small", coding: true }).queue().steps.map((s) => s.id), ["Q1", "Q.refactor", "Q.integrate"]);
});

test("a survey's worktree Nexus could not clean up waits for the user as a cleanup item, until it is cleaned up", () => {
  const x = setup({ worktree: "C:/w/S", integration: true, maintenance: "survey" });
  const reason = "survey run Q is done, but its worktree stays: 1 file: ?? left.txt left in it; look at them, then clean up (C:/w/S)";
  x.st.writeGit("Q", { protocol: 1, steps: {}, cleanup: { waiting: { reason, since: "2026-11-16T10:00:00.000Z", files: ["?? left.txt"] } } });
  const items = () => loadProjectState(x.st).attention.filter((a) => a.queue === "Q" && a.kind !== "approval");
  assert.deepEqual(items().map((a) => [a.kind, a.text, a.at]), [["cleanup", reason, "2026-11-16T10:00:00.000Z"]]);
  x.st.writeGit("Q", { ...x.st.readGit("Q")!, cleaned: { at: "2026-11-16T11:00:00.000Z", path: "C:/w/S", branch: "nexus/S" } });
  assert.deepEqual(items(), []);
});

test("the mark is the server's: a draft does not set it, a revision keeps it, and it is not part of what an approval pins", () => {
  // The server marks an approved queue when it gives it its worktree: the approval still holds.
  const x = setup({ worktree: "auto" });
  approveQueue(x.st, "Q");
  x.st.writeQueue({ ...x.st.readQueue("Q"), worktree: "C:/w/Q", integration: true });
  assert.equal(isApproved(x.st.readQueue("Q")), true);
  x.draft({ steps: [{ id: "Q1", title: "One" }, { id: "Q2", title: "Two" }] });
  assert.equal(x.st.readQueue("Q").integration, true);
  assert.deepEqual(x.queue().steps.map((s) => s.id), ["Q1", "Q2", "Q.integrate"]);

  const root = mkdtempSync(join(tmpdir(), "nexus-integration-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  applyDraft(st, { id: "N", title: "New", stop_conditions: [], checks: [], integration: true, steps: [{ id: "N1", title: "One", goal: "", acceptance: [] }] });
  assert.equal(st.readQueue("N").integration, undefined, "an orchestrator's draft cannot set it");
});

// Reserved id, skip refusal and queue set finished are covered with the closing step in closing.test.ts.

test("any other step at work after the integration step ran makes it run again at the end; its own run does not reset the closing step", () => {
  const x = setup({ worktree: "auto", coding: true });
  approveQueue(x.st, "Q");
  const w = x.session("worker"), u = x.session("user");
  x.finish(w, u, "Q1"); x.finish(w, u, "Q.refactor"); x.finish(w, u, "Q.integrate");
  assert.equal(x.queue().status, "done");
  assert.equal(x.queue().steps.find((s) => s.closing)!.status, "done", "the integration step at work left the closing step done");

  x.draft({ steps: [{ id: "Q1", title: "One" }, { id: "Q2", title: "Two" }] });
  approveQueue(x.st, "Q");
  x.emit(w, { type: "step.started", queue: "Q", step: "Q2" });
  assert.deepEqual(x.queue().steps.slice(-2).map((s) => s.status), ["pending", "pending"], "both run again");
  x.finish(w, u, "Q2"); x.finish(w, u, "Q.refactor");
  assert.equal(x.queue().status, "running", "not done while the integration step has to run again");
  x.finish(w, u, "Q.integrate");
  assert.equal(x.queue().status, "done");
  assert.equal(x.queue().steps.at(-1)!.segments.length, 2);
});
