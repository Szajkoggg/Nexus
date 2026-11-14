// The orchestrator's housekeeping (orchestratorStatusChange, `nexus queue set`): what it may change and what stays the
// user's, how the changes survive a rebuild, the draft rules, and that a worker can use neither the command nor the
// event.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionError, ProjectStore, applyDraft, approveQueue, loadProjectState, newId, orchestratorStatusChange, stopPlace, type Event, type StepDef,
} from "../src/index.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../../cli/bin/nexus.js");
/** A day ago: the events come before the changes, which are stamped with the time they are made. */
const T0 = Date.now() - 86_400_000;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const step = (id: string): StepDef => ({ id, title: `Step ${id}`, goal: "", acceptance: [] });

function setup(ids = ["Q1", "Q2", "Q3"]) {
  const root = mkdtempSync(join(tmpdir(), "nexus-status-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  for (const [id, role] of [["w", "worker"], ["o", "orchestrator"]] as const) {
    store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0) });
  }
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: ids.map(step) });
  approveQueue(store, "Q");
  const emit = (min: number, body: Record<string, unknown>, session = "w") =>
    store.appendEvent({ v: 1, id: newId(), at: at(min), session, ...body } as Event);
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const set = (to: string, stepId?: string, reason = "housekeeping") => orchestratorStatusChange(store, { queue: "Q", step: stepId, to, reason });
  return { root, store, emit, queue, set };
}

test("allowed: skip a pending, stopped or failed step; each is an entry with who, when, from, to and why", () => {
  const { emit, queue, set } = setup(["Q1", "Q2", "Q3", "Q4"]);
  emit(1, { type: "step.started", queue: "Q", step: "Q1" });
  emit(2, { type: "step.failed", queue: "Q", step: "Q1", reason: "the table does not exist" });
  emit(3, { type: "step.started", queue: "Q", step: "Q2" });
  emit(4, { type: "queue.stop", queue: "Q", step: "Q2", condition: "art", reason: "missing" });
  assert.match(set("skipped", "Q1", "done elsewhere: in queue M, step M3"), /Q\/Q1 skipped \(was failed\)/);
  assert.match(set("skipped", "Q2", "replaced by Q2b"), /was stopped/);
  assert.match(set("skipped", "Q3", "no longer needed"), /was pending/);
  const q = queue();
  assert.deepEqual(q.steps.map((s) => s.status), ["skipped", "skipped", "skipped", "pending"]);
  assert.equal(q.steps[1]!.reason, "replaced by Q2b");
  assert.deepEqual(q.changes.map((c) => [c.kind, c.by, c.step, c.from, c.to]), [
    ["status", "orchestrator", "Q1", "failed", "skipped"], ["status", "orchestrator", "Q2", "stopped", "skipped"], ["status", "orchestrator", "Q3", "pending", "skipped"],
  ]);
  assert.equal(q.status, "stopped", "skipping the stopped step does not lift the stop: that is the user's");
});

test("refused, with the reason: done, approving, lifting, reopening, a step at work, and anything not listed", () => {
  const { store, emit, set } = setup();
  emit(1, { type: "step.started", queue: "Q", step: "Q1" });
  emit(2, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  emit(3, { type: "step.started", queue: "Q", step: "Q2" });
  // A live run holds Q2: it is at work.
  store.writeRun("Q", { protocol: 1, session: "w", state: "running", step: "Q2", started_at: at(3), updated_at: at(3), revision: 1 });
  const refused = (to: string, s: string | undefined, why: RegExp) => assert.throws(() => set(to, s), (e: ActionError) => why.test(e.message), `${to} ${s ?? ""}`);
  refused("done", "Q3", /never marks a step done: work done elsewhere is skipped/);
  refused("approved", undefined, /approving is the user's/);
  refused("lift", undefined, /only the user lifts a stop/);
  refused("pending", "Q1", /reopening step Q\/Q1 \(done\) is the user's: a send-back/);
  refused("skipped", "Q1", /is done already/);
  refused("skipped", "Q2", /is running: a step at work is not skipped/);
  refused("skipped", undefined, /skipping is for a step/);
  refused("finished", undefined, /no halted run/);
  refused("propose-lift", undefined, /is not stopped/);
  refused("paused", "Q3", /not a status the orchestrator sets/);
  assert.throws(() => set("skipped", "Q9"), /has no step Q9 \(has Q1, Q2, Q3\)/);
  assert.throws(() => orchestratorStatusChange(new ProjectStore(setup().store.dir), { queue: "Q", step: "Q3", to: "skipped", reason: " " }), /reason/);

  // The run moves on to another step (Q2 left running, the W4e shape): no live run holds Q2, so it may be skipped.
  store.writeRun("Q", { protocol: 1, session: "w", state: "running", step: "Q3", started_at: at(3), updated_at: at(4), revision: 1 });
  assert.match(set("skipped", "Q2", "replaced"), /Q\/Q2 skipped \(was running\)/);
  // And with no run at all.
  const y = setup();
  y.emit(1, { type: "step.started", queue: "Q", step: "Q1" });
  assert.match(y.set("skipped", "Q1", "done elsewhere"), /was running/);
});

test("skipping the last open step makes the queue done, and a halted run on it can be closed as finished", () => {
  const { store, emit, queue, set } = setup(["Q1", "Q2"]);
  emit(1, { type: "step.started", queue: "Q", step: "Q1" });
  emit(2, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  emit(3, { type: "step.started", queue: "Q", step: "Q2" });
  emit(4, { type: "step.failed", queue: "Q", step: "Q2", reason: "broken" });
  store.writeRun("Q", { protocol: 1, session: "w", state: "halted", reason: "step Q2 failed: broken", step: "Q2", started_at: at(1), updated_at: at(4), ended_at: at(4) });
  assert.throws(() => set("finished"), /not done or skipped: Q2 \(failed\)/);
  set("skipped", "Q2", "done by hand in the editor");
  assert.equal(queue().status, "done");
  assert.match(set("finished", undefined, "the queue is done"), /closed as finished/);
  assert.equal(store.readRun("Q")!.state, "finished");
  assert.deepEqual(queue().changes.at(-1)!.kind, "run");
  assert.ok(!loadProjectState(store).attention.some((a) => a.queue === "Q"), "nothing waits for the user");
});

test("a skipped failed step stays skipped after a later rebuild; a cancelled stopped queue stays cancelled", () => {
  const { store, emit, queue, set } = setup();
  emit(1, { type: "step.started", queue: "Q", step: "Q1" });
  emit(2, { type: "step.failed", queue: "Q", step: "Q1", reason: "x" });
  set("skipped", "Q1", "not needed");
  emit(30, { type: "step.progress", queue: "Q", step: "Q2", text: "unrelated, later" });
  assert.equal(queue().steps[0]!.status, "skipped", "derived again from the files, with a later event among them");

  const b = setup();
  b.emit(1, { type: "step.started", queue: "Q", step: "Q1" });
  b.emit(2, { type: "queue.stop", queue: "Q", step: "Q1", condition: "c", reason: "r" });
  b.store.writeRun("Q", { protocol: 1, session: "w", state: "running", step: "Q1", started_at: at(1), updated_at: at(2) });
  assert.throws(() => b.set("cancelled"), /stop its run first/);
  b.store.writeRun("Q", { protocol: 1, session: "w", state: "halted", step: "Q1", started_at: at(1), updated_at: at(2) });
  b.set("cancelled", undefined, "superseded by queue R");
  b.emit(40, { type: "queue.stop", queue: "Q", step: "Q1", condition: "c", reason: "a late stop" });
  const q = b.queue();
  assert.equal(q.status, "cancelled");
  assert.equal(q.status_reason, "superseded by queue R");
  assert.ok(!loadProjectState(b.store).attention.some((a) => a.queue === "Q"), "a cancelled queue does not wait for the user");
  assert.throws(() => b.set("cancelled"), /cancelled already/);
});

test("a proposal to lift is recorded on a stopped queue, and cleared by a lift, a later stop or an approval", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const { store, emit, queue, set } = setup();
  emit(1, { type: "step.started", queue: "Q", step: "Q2" });
  emit(2, { type: "queue.stop", queue: "Q", step: "Q2", condition: "art", reason: "missing" });
  set("propose-lift", undefined, "the art arrived in the shared folder");
  assert.deepEqual(queue().lift_proposal?.reason, "the art arrived in the shared folder");
  await tick();
  store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: "w", type: "queue.stop", queue: "Q", step: "Q2", condition: "art", reason: "missing again" });
  await tick();
  assert.equal(queue().lift_proposal, undefined, "a later stop clears it");

  set("propose-lift", undefined, "now it is there");
  assert.ok(queue().lift_proposal);
  applyDraft(store, { id: "Q", title: "Queue", steps: [step("Q1"), step("Q2"), step("Q2b"), step("Q3")] });
  approveQueue(store, "Q"); // lifts the stop
  assert.equal(queue().lift_proposal, undefined, "a lift clears it");
  assert.equal(queue().status, "approved");
});

test("drafts: an existing step's status only as in the file; a new step without status or skipped; no dropping a started or stopped step", () => {
  const { store, emit } = setup();
  emit(1, { type: "step.started", queue: "Q", step: "Q2" });
  emit(2, { type: "queue.stop", queue: "Q", step: "Q2", condition: "c", reason: "r" });
  const draft = (steps: StepDef[]) => applyDraft(store, { id: "Q", title: "Queue", steps });
  assert.throws(() => draft([step("Q1"), { ...step("Q2"), status: "skipped" }, { ...step("Q3"), status: "done" }]),
    /does not change the status of an existing step: Q2 \(pending in the file, skipped in the draft\), Q3 \(pending in the file, done in the draft\)/);
  assert.throws(() => draft([step("Q1"), step("Q2"), step("Q3"), { ...step("Q4"), status: "done" }]), /new step has no status or skipped: Q4 \(done\)/);
  assert.throws(() => draft([step("Q1"), step("Q3")]), /does not drop a step that has started or stopped: Q2 \(stopped\)/);
  assert.match(draft([step("Q1"), { ...step("Q2"), status: undefined }, step("Q3"), { ...step("Q2b"), status: "skipped" }]), /revision 2/);
  assert.match(draft([step("Q2"), step("Q3"), { ...step("Q2b"), status: "skipped" }]), /revision 3/, "a pending step that never started may go");
  assert.equal(store.readQueue("Q").steps.length, 3);
});

test("drafts: pending steps may be added, changed, removed and reordered while a step runs", () => {
  const { store, emit, queue } = setup(["Q1", "Q2", "Q3", "Q4", "Q5"]);
  emit(1, { type: "step.started", queue: "Q", step: "Q1" });
  emit(2, { type: "step.done", queue: "Q", step: "Q1", summary: "ok" });
  emit(3, { type: "step.started", queue: "Q", step: "Q2" });
  store.writeRun("Q", { protocol: 1, session: "w", state: "running", step: "Q2", started_at: at(1), updated_at: at(3), revision: 1 });
  const draft = (steps: StepDef[]) => applyDraft(store, { id: "Q", title: "Queue", steps });
  assert.match(draft([step("Q1"), step("Q2"), step("Q3"), step("Q4"), step("Q5"), step("Q6")]), /revision 2/, "added");
  assert.match(draft([step("Q1"), step("Q2"), { ...step("Q3"), title: "Other", goal: "Else", acceptance: ["A"], review: { policy: "wait" }, runtime: "codex", model: "m", effort: "low" }, step("Q4"), step("Q5"), step("Q6")]), /revision 3/, "changed");
  assert.match(draft([step("Q1"), step("Q2"), step("Q3"), step("Q5"), step("Q6")]), /revision 4/, "removed");
  assert.match(draft([step("Q1"), step("Q2"), step("Q6"), step("Q5"), step("Q3")]), /revision 5/, "reordered");
  assert.match(draft([step("Q1"), step("Q6"), step("Q2"), step("Q5"), step("Q3")]), /revision 6/, "a pending step may move before the running one");
  assert.match(draft([step("Q1"), step("Q6"), step("Q2"), step("Q5"), step("Q3")]), /no change/, "the started steps as they were: no change");
  assert.deepEqual(queue().steps.map((s) => `${s.id}=${s.status}`), ["Q1=done", "Q6=pending", "Q2=running", "Q5=pending", "Q3=pending"]);
});

test("drafts: every kind of change to a started step is refused, with the reason and where the change goes instead", () => {
  const { store, emit } = setup(["Q1", "Q2", "Q3", "Q4"]);
  const f = store.readQueue("Q");
  // Q1 done by an import (status in the file, no segments): started too. Q2 runs. Q4 was skipped before it ran: not started.
  store.writeQueue({ ...f, steps: f.steps.map((s) => (s.id === "Q1" ? { ...s, status: "done" as const } : s.id === "Q4" ? { ...s, status: "skipped" as const } : s)) });
  emit(3, { type: "step.started", queue: "Q", step: "Q2" });
  const base = () => [step("Q1"), step("Q2"), step("Q3"), step("Q4")];
  const draft = (steps: StepDef[]) => applyDraft(store, { id: "Q", title: "Queue", steps });
  const change = (id: string, patch: Partial<StepDef>) => draft(base().map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const pointer = /Leave started steps as they are: a change to one goes to its worker as a message, or with nexus review send-back when it waits for your review/;
  const cases: [Partial<StepDef>, string][] = [
    [{ title: "Renamed" }, "title"], [{ goal: "Another goal" }, "goal"], [{ acceptance: ["More"] }, "acceptance"],
    [{ review: { prepare: "Shots" } }, "review"], [{ runtime: "codex" }, "runtime"], [{ model: "haiku" }, "model"], [{ effort: "low" }, "effort"],
  ];
  for (const [patch, field] of cases) {
    assert.throws(() => change("Q2", patch), (e: Error) => {
      assert.ok(e instanceof ActionError);
      assert.match(e.message, new RegExp(`a revision changes only steps that have not started; this draft changes Q2 \\(running\\): its ${field}\\.`));
      assert.match(e.message, pointer);
      return true;
    }, field);
  }
  assert.throws(() => change("Q1", { title: "Renamed", goal: "Redone" }), /changes Q1 \(done\): its title, goal\./, "a step done by an import");
  assert.throws(() => draft([step("Q2"), step("Q1"), step("Q3"), step("Q4")]), /the order of the started steps \(Q1, Q2 in the queue, Q2, Q1 in the draft\)/);
  assert.throws(() => draft([step("Q1"), step("Q3"), step("Q4")]), /does not drop a step that has started or stopped: Q2 \(running\)/);
  assert.equal(store.readQueue("Q").revision, 1, "nothing refused was written");
  assert.match(change("Q4", { goal: "A skipped step that never ran" }), /revision 2/, "a skipped step that never started is not started");
});

test("drafts: once a run exists, the worktree, branch and base stay", () => {
  const { store } = setup();
  const draft = (extra: Record<string, unknown>) => applyDraft(store, { id: "Q", title: "Queue", steps: [step("Q1"), step("Q2"), step("Q3")], ...extra });
  assert.match(draft({ worktree: "auto", branch: "v2/cliffs", base: "main" }), /no change/, "before a run they may change");
  assert.equal(store.readQueue("Q").branch, "v2/cliffs");
  store.writeRun("Q", { protocol: 1, session: "w", state: "paused", step: "Q1", started_at: at(1), updated_at: at(2), revision: 1 });
  assert.throws(() => draft({ worktree: "../elsewhere" }), /queue Q has run: a draft does not change its worktree \(auto in the queue, \.\.\/elsewhere in the draft\), since its work is in that checkout/);
  assert.throws(() => draft({ branch: "v3/cliffs" }), /does not change its branch \(v2\/cliffs in the queue, v3\/cliffs in the draft\)/);
  assert.throws(() => draft({ base: "dev" }), /does not change its base \(main in the queue, dev in the draft\)/);
  assert.match(draft({}), /no change/, "left out, they stay");
  assert.match(draft({ worktree: "auto", branch: "v2/cliffs", base: "main" }), /no change/, "as they are");
  assert.equal(store.readQueue("Q").worktree, "auto");
});

test("a worker can use neither the command nor the event", () => {
  const { store, root, emit, queue } = setup();
  // The CLI refuses a worker.
  const run = (session: string) => {
    try { execFileSync(process.execPath, [CLI, "queue", "set", "Q", "--step", "Q3", "skipped", "--reason", "x"], { env: { ...process.env, NEXUS_SESSION: session, NEXUS_DIR: store.dir }, cwd: root, encoding: "utf8", stdio: "pipe" }); return ""; }
    catch (e) { return String((e as { stderr?: string }).stderr); }
  };
  assert.match(run("w"), /only an orchestrator session may do this/);
  // An event written into a worker's own log by hand is ignored when the state is derived (and the server applies
  // only the orchestrator's own requests).
  emit(5, { type: "status.set", queue: "Q", step: "Q3", to: "skipped", reason: "by hand" }, "w");
  const s = loadProjectState(store);
  assert.ok(s.warnings.some((w) => /status.set is for orchestrators; ignored/.test(w)));
  assert.equal(queue().steps[2]!.status, "pending");
  assert.equal(queue().changes.length, 0);
});

test("a stopped queue's attention item carries its ways out; once its step is skipped the stop reads as the queue's", () => {
  const { store, emit, queue, set } = setup();
  emit(1, { type: "step.started", queue: "Q", step: "Q1" });
  emit(2, { type: "queue.stop", queue: "Q", step: "Q1", condition: "art", reason: "missing" });
  const item = () => loadProjectState(store).attention.find((a) => a.kind === "stopped" && a.queue === "Q")!;
  assert.equal(stopPlace(queue()), " at step Q1");
  assert.deepEqual(item().lift, { place: " at step Q1", continue: true, revision: 1 });
  assert.equal(item().step, "Q1");

  set("skipped", "Q1", "replaced by Q2");
  set("propose-lift", undefined, "Q2 can run");
  const q = queue();
  assert.equal(q.status, "stopped");
  assert.equal(q.stop_step, "Q1");
  assert.equal(stopPlace(q), " (the stop came from Q1, now skipped)");
  const a = item();
  assert.equal(a.step, undefined, "the item is the queue's, not the skipped step's");
  assert.equal(a.lift?.place, " (the stop came from Q1, now skipped)");
  assert.equal(a.lift?.proposal?.reason, "Q2 can run");
  assert.equal(a.lift?.proposal?.at, q.lift_proposal?.at);
  assert.equal(a.at, q.lift_proposal?.at, "the proposal makes the item new");

  // A queue whose current revision is not approved: approving lifts it, not Continue.
  applyDraft(store, { id: "Q", title: "Queue", stop_conditions: [], checks: [], steps: [...store.readQueue("Q").steps.map(({ id, title, goal, acceptance }) => ({ id, title, goal, acceptance })), step("Q4")] });
  assert.deepEqual([item().lift?.continue, item().lift?.revision], [false, 2]);
  approveQueue(store, "Q");
  assert.equal(queue().stop_step, undefined, "a lift clears it");
  assert.ok(!loadProjectState(store).attention.some((x) => x.kind === "stopped"));
});

test("a queue imported as stopped takes its stop place from its stopped step", () => {
  const { store, queue } = setup();
  const f = store.readQueue("Q");
  store.writeQueue({ ...f, status: "stopped", status_note: "waiting for the art", steps: f.steps.map((s) => (s.id === "Q2" ? { ...s, status: "stopped" as const } : s)) });
  assert.equal(stopPlace(queue()), " at step Q2");
});
