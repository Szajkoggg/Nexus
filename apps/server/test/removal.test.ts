// Removing a project (src/removal.ts): what keeps it (every item of "nothing runs", each with its reason), what goes
// with it and what stays, and the guard on what "Delete Nexus's data" may delete: only realpath(root)/.nexus, a folder
// of its own, never a link or junction, and nothing a link inside it points to. In temporary folders only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionError, ProjectStore, loadProjectState, newId, now, readRegistry, writeRegistry,
  type Event, type QueueFile, type RunFile,
} from "@nexus/protocol";
import { RemovalBlocked, checkRemoval, deleteNexusDir, nexusDirOf, removalBlockers, removalView, stopProject, unregister, type LiveParts } from "../src/removal.ts";
import { assertTempHome } from "./helpers.ts";

const IDLE: LiveParts = { engineIdle: true, orchestratorIdle: true, conversationsIdle: true, merging: [], updating: false };

function project(name = "p") {
  const base = mkdtempSync(join(tmpdir(), "nexus-removal-"));
  process.env.NEXUS_HOME = join(base, "home");
  assertTempHome(process.env.NEXUS_HOME);
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "the project's own file\n");
  const store = ProjectStore.init(root, { id: name, name: `Project ${name}`, root });
  writeRegistry({ protocol: 1, projects: [{ id: name, root }] });
  const queue = (id: string, extra: Partial<QueueFile> = {}) => store.writeQueue({
    protocol: 1, id, title: `Queue ${id}`, revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: `${id}1`, title: "One", goal: "", acceptance: [] }], ...extra,
  } as QueueFile);
  const run = (id: string, state: RunFile["state"], extra: Partial<RunFile> = {}) =>
    store.writeRun(id, { protocol: 1, session: "w", state, started_at: now(), updated_at: now(), ...extra });
  return { base, root, store, queue, run };
}

test("every run that started and did not finish keeps the project, each with its reason; a finished one does not", () => {
  const p = project();
  const states: RunFile["state"][] = ["running", "pausing", "paused", "halted", "usage_wait", "retry_wait", "approval_wait", "finished"];
  for (const s of states) { p.queue(s.toUpperCase().replace("_", "")); p.run(s.toUpperCase().replace("_", ""), s); }
  p.queue("HELD"); p.run("HELD", "paused", { resume_after_restart: true });
  // A stopped queue's halted run is a stop; a done or cancelled queue's leftover run keeps nothing.
  p.queue("STOP", { status: "stopped" }); p.run("STOP", "halted");
  p.queue("DONE", { status: "done" }); p.run("DONE", "halted");
  p.queue("GONE", { status: "cancelled" }); p.run("GONE", "paused");
  const blockers = removalBlockers(loadProjectState(p.store), IDLE);
  assert.deepEqual(blockers.sort(), [
    "queue APPROVALWAIT waits for an approval", "queue HALTED is halted", "queue HELD is held (it goes on by itself)",
    "queue PAUSED is paused", "queue PAUSING runs (it pauses after its step)", "queue RETRYWAIT waits to try a turn again",
    "queue RUNNING runs", "queue STOP is stopped", "queue USAGEWAIT waits for the usage window",
  ]);
});

test("a merge back in progress or waiting, a planned deploy, the orchestrator, a thinking partner and an update keep it", () => {
  const p = project();
  p.queue("W", { status: "done" });
  p.store.writeGit("W", { protocol: 1, merge: { waiting: { reason: "the checkout has uncommitted changes", since: now() } } } as never);
  p.queue("R", { status: "done" });
  p.store.writeGit("R", { protocol: 1, merge: { reintegrating: now() } } as never);
  // A cancelled queue's waiting merge and a cleaned-up one's keep nothing.
  p.queue("C", { status: "cancelled" });
  p.store.writeGit("C", { protocol: 1, merge: { waiting: { reason: "old", since: now() } } } as never);
  const state = loadProjectState(p.store);
  assert.deepEqual(removalBlockers(state, IDLE).sort(), [
    "queue R is being integrated again before its merge back", "queue W waits to be merged back: the checkout has uncommitted changes",
  ]);
  const quiet = project("q");
  const s = loadProjectState(quiet.store);
  assert.deepEqual(removalBlockers(s, IDLE), [], "nothing runs: it may go");
  assert.deepEqual(removalBlockers(s, { ...IDLE, merging: ["M"] }), ["Nexus is merging queue M back"]);
  assert.deepEqual(removalBlockers(s, { ...IDLE, deploy: { queue: "A" } }), ["a deploy is planned after queue A of this project"]);
  assert.deepEqual(removalBlockers(s, { ...IDLE, deploy: { queue: "A", step: "A2" } }), ["a deploy is planned after step A/A2 of this project"]);
  assert.deepEqual(removalBlockers(s, { ...IDLE, orchestratorIdle: false }), ["the orchestrator is in a turn"]);
  assert.deepEqual(removalBlockers(s, { ...IDLE, conversationsIdle: false }), ["a thinking partner is in a turn"]);
  assert.deepEqual(removalBlockers(s, { ...IDLE, engineIdle: false }), ["a worker of the project is in a turn"]);
  assert.deepEqual(removalBlockers(s, { ...IDLE, updating: true }), ["Nexus is updating"]);
  assert.deepEqual(removalBlockers(undefined, IDLE), [], "an unreadable project's files keep nothing; its live parts would");
});

test("planned and scheduled starts and open questions go with the project; the worktrees Nexus made stay and are listed", () => {
  const p = project();
  p.queue("A");
  p.queue("B");
  p.store.writePlan("B", { protocol: 1, by: "user", after: [{ queue: "A", by: "user", at: now() }], created_at: now(), updated_at: now(), decisions: [] });
  p.queue("S");
  p.store.writeStart("S", { protocol: 1, at: new Date(Date.now() + 3_600_000).toISOString(), by: "user", revision: 1, created_at: now() });
  const tree = join(p.base, "p.worktrees", "T");
  mkdirSync(tree, { recursive: true });
  p.queue("T", { status: "done", worktree: tree.replaceAll("\\", "/"), branch: "nexus/T", integration: true });
  p.store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "external", cwd: p.root, launched_by: "external", created_at: now() } as never);
  p.store.appendEvent({ v: 1, id: newId(), at: now(), session: "w", type: "question.asked", queue: "A", step: "A1", qid: "q1", text: "Which?", can_continue: false } as Event);
  const v = removalView(p.root, "Project p", loadProjectState(p.store), IDLE);
  assert.deepEqual(v.blockers, []);
  assert.deepEqual(v.planned, [{ queue: "B", after: ["A"] }]);
  assert.deepEqual(v.scheduled.map((x) => x.queue), ["S"]);
  assert.deepEqual(v.questions.map((x) => [x.qid, x.queue, x.text]), [["q1", "A", "Which?"]]);
  assert.deepEqual(v.worktrees, [{ queue: "T", path: tree.replaceAll("\\", "/"), branch: "nexus/T", exists: true }]);
  assert.equal(v.delete_refused, undefined);
  assert.match(v.nexus_dir, /\/p\/\.nexus$/);
});

test("Delete deletes only the project's own .nexus: the project's files, a worktree, and what a link inside points to stay", () => {
  const p = project();
  const outside = join(p.base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "not Nexus's\n");
  // A junction inside .nexus (no rights needed on Windows): removed as a link, its target untouched.
  symlinkSync(outside, join(p.store.dir, "uploads-link"), "junction");
  const dir = deleteNexusDir(p.root);
  assert.match(dir, /\/p\/\.nexus$/);
  assert.equal(existsSync(p.store.dir), false, ".nexus is gone");
  assert.equal(readFileSync(join(p.root, "README.md"), "utf8"), "the project's own file\n", "the project's own file stays");
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "not Nexus's\n", "what the link pointed to stays");
});

test("a .nexus that is a junction or a link, or holds no project.yaml, is never deleted; a project root through a link is", () => {
  const p = project();
  const elsewhere = join(p.base, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "project.yaml"), "protocol: 1\n");
  const other = join(p.base, "other");
  mkdirSync(other);
  symlinkSync(elsewhere, join(other, ".nexus"), "junction");
  assert.match(nexusDirOf(other).refused ?? "", /link or junction/);
  assert.throws(() => deleteNexusDir(other), /link or junction/);
  assert.ok(existsSync(join(elsewhere, "project.yaml")), "the junction's target stays");
  // A directory symbolic link needs a right Windows gives only to some users: tried when it can be made.
  const third = join(p.base, "third");
  mkdirSync(third);
  let linked = true;
  try { symlinkSync(elsewhere, join(third, ".nexus"), "dir"); } catch { linked = false; }
  if (linked) {
    assert.match(nexusDirOf(third).refused ?? "", /link or junction/);
    assert.throws(() => deleteNexusDir(third), /link or junction/);
  }
  assert.ok(existsSync(join(elsewhere, "project.yaml")));
  // Not Nexus's data, and none at all.
  const plain = join(p.base, "plain");
  mkdirSync(join(plain, ".nexus"), { recursive: true });
  assert.match(nexusDirOf(plain).refused ?? "", /no project\.yaml/);
  assert.match(nexusDirOf(join(p.base, "missing")).refused ?? "", /cannot be read/);
  // The project's root reached through a junction: its real folder's .nexus.
  const alias = join(p.base, "alias");
  symlinkSync(p.root, alias, "junction");
  const via = nexusDirOf(alias);
  assert.equal(via.refused, undefined);
  assert.match(via.dir, /\/p\/\.nexus$/, "realpath(root)/.nexus");
  rmSync(alias);
});

test("a worktree inside .nexus refuses Delete", () => {
  const p = project();
  const tree = join(p.store.dir, "trees", "T");
  mkdirSync(tree, { recursive: true });
  p.queue("T", { status: "done", worktree: tree.replaceAll("\\", "/"), branch: "nexus/T", integration: true });
  const v = removalView(p.root, "Project p", loadProjectState(p.store), IDLE);
  assert.match(v.delete_refused ?? "", /worktree of queue T lies inside \.nexus/);
  assert.throws(() => checkRemoval("p", p.root, v, { delete_data: true, name: "Project p" }), (e: ActionError) => e.status === 409);
  assert.deepEqual(checkRemoval("p", p.root, v, {}), { deleteData: false }, "Remove from Nexus may go");
});

test("a removal is checked first: nothing runs, the name typed for a Delete, registered in this NEXUS_HOME", () => {
  const p = project();
  const view = removalView(p.root, "Project p", loadProjectState(p.store), IDLE);
  assert.throws(() => checkRemoval("p", p.root, { ...view, blockers: ["queue A runs"] }, {}), (e: unknown) => e instanceof RemovalBlocked && e.status === 409 && e.blockers[0] === "queue A runs");
  assert.throws(() => checkRemoval("p", p.root, view, { delete_data: true }), /type its name/);
  assert.throws(() => checkRemoval("p", p.root, view, { delete_data: true, name: "p" }), /type its name/);
  assert.throws(() => checkRemoval("p", p.root, view, { delete_data: "yes" }), /true or false/);
  assert.deepEqual(checkRemoval("p", p.root, view, { delete_data: true, name: " Project p " }), { deleteData: true });
  // Registered under another root, or not at all, in this server's NEXUS_HOME: refused.
  assert.throws(() => checkRemoval("p", join(p.base, "elsewhere"), view, {}), /not registered/);
  writeRegistry({ protocol: 1, projects: [{ id: "x", root: p.root }] });
  assert.throws(() => checkRemoval("p", p.root, view, {}), /not registered/);
  assert.throws(() => unregister("p", p.root), /not registered/);
  writeRegistry({ protocol: 1, projects: [{ id: "x", root: "C:/x" }, { id: "p", root: p.root }] });
  unregister("p", p.root);
  assert.deepEqual(readRegistry().projects.map((x) => x.id), ["x"], "the other entries stay");
});

test("stopProject shuts every part down and waits until their processes have exited", async () => {
  let exited = false;
  const calls: string[] = [];
  const part = (name: string, alive?: () => boolean) => ({ shutdown: () => { calls.push(name); setTimeout(() => { exited = true; }, 250); }, alive });
  const ok = await stopProject([part("engine", () => !exited), part("orchestrator", () => false), part("merger")]);
  assert.deepEqual(calls, ["engine", "orchestrator", "merger"]);
  assert.equal(ok, true);
  assert.equal(exited, true, "it waited for the exit");
  assert.equal(await stopProject([{ shutdown: () => {}, alive: () => true }], 300), false, "one that does not exit in time is reported");
});
