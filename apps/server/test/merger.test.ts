// Nexus merging worktree queues back by itself (src/merger.ts, src/mergeback.ts), against temporary repositories:
// local git only, no remote. Most cases are a finished queue written as files (its steps' events and its integration
// step's round in git.yaml) and the Merger looking at it; the cases that need a run (a step at work in the main
// checkout held at its end; the integration step run again for real) use the engine with the fake runtimes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, approveQueue, loadProjectState, newId, now, planLines, routeAnswers, updateSettings, type Event, type GitFile, type QueueFile, type SessionFile, type StepDef,
} from "@nexus/protocol";
import { recordBase } from "../src/gitinfo.ts";
import { Merger } from "../src/merger.ts";
import { cleanUp, judgeMerge, mergeBack, withMergeLock } from "../src/mergeback.ts";
import { judgePlan } from "../src/deploy-plan.ts";
import { Engine } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { LONGER, QUICK_ENGINE, holdWork, sleep, until as waitUntil } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

/** The system's temporary folder, read once: each project sets TEMP to a folder of its own (the report's folder). */
const TMP = tmpdir();
const G = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...G, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ok = (f: () => unknown) => { try { f(); return true; } catch { return false; } };

// Build the common history once. Copy the whole repository (no shared objects or worktree metadata), so every
// project's branches, index, config and reflog remain its own. ProjectStore is initialized only in the copies.
const template = mkdtempSync(join(TMP, "nexus-merger-template-"));
git(template, "init", "-q", "-b", "main");
git(template, "config", "user.name", "test"); git(template, "config", "user.email", "test@example.invalid"); git(template, "config", "commit.gpgsign", "false");
writeFileSync(join(template, ".gitignore"), ".nexus/\nnode_modules/\n");
git(template, "add", ".gitignore"); git(template, "commit", "-qm", "init");

/** A project in a temporary git repository, with merge_back as given. */
function project(o: { mergeBack?: boolean; provisionalCounts?: boolean } = {}) {
  const base = mkdtempSync(join(TMP, "nexus-merger-"));
  const temp = join(base, "temp");
  mkdirSync(temp);
  process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp;
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  const root = join(base, "project");
  cpSync(template, root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const defaults: Record<string, unknown> = {};
  if (o.mergeBack !== false) defaults.merge_back = true;
  if (o.provisionalCounts === false) defaults.provisional_counts = false;
  if (Object.keys(defaults).length) updateSettings(store, { defaults });
  const commit = (cwd: string, file: string, text: string) => { writeFileSync(join(cwd, file), text); git(cwd, "add", file); git(cwd, "commit", "-qm", `${file}: ${text.trim()}`); return git(cwd, "rev-parse", "HEAD"); };
  let t = Date.now();
  const at = () => new Date(t = Math.max(t + 1, Date.now())).toISOString(); // never behind the clock: Nexus writes real times too
  const session = (role: SessionFile["role"]): SessionFile => {
    const s: SessionFile = { protocol: 1, id: newId(), project: "p", role, runtime: "external", cwd: root, launched_by: "external", created_at: now() };
    store.writeSession(s);
    return s;
  };
  const worker = session("worker"), user = session("user"), orch = session("orchestrator");
  const emit = (s: SessionFile, body: Record<string, unknown>) => store.appendEvent({ v: 1, id: newId(), at: at(), session: s.id, ...body } as Event);
  const queue = (id = "Q") => loadProjectState(store).queues.find((x) => x.id === id)!;
  return { base, root, store, commit, at, worker, user, orch, emit, queue, main: () => git(root, "rev-parse", "main") };
}
type Project = ReturnType<typeof project>;

/** main's reflog has no merge but fast-forwards: it moved only by commits and fast-forwards. */
const onlyForward = (x: Project) => git(x.root, "reflog", "--format=%gs", "main").split("\n").filter((l) => /^merge/.test(l) && !/Fast-forward/.test(l)).length === 0;

/**
 * A worktree queue Q whose work is finished: its step committed in the worktree, its integration step done (and
 * accepted unless `review`) with its round ending at the worktree's HEAD. `provisional`: Q1 accepted provisionally.
 */
function finished(x: Project, o: { review?: boolean; provisional?: boolean; failedCheck?: boolean } = {}) {
  const wt = join(x.base, "project.worktrees", "Q");
  const q: QueueFile = {
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], withdrawals: [], history: [], changes: [],
    worktree: "auto", branch: "nexus/Q", ...(o.provisional ? { review_level: 3 } : {}), steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }],
  } as QueueFile;
  x.store.writeQueue(q);
  recordBase(x.store, x.store.readQueue("Q"), x.root);
  git(x.root, "worktree", "add", "-q", "-b", "nexus/Q", wt, "main");
  x.store.writeQueue({ ...x.store.readQueue("Q"), worktree: wt.replaceAll("\\", "/"), integration: true });
  approveQueue(x.store, "Q");
  const work = x.commit(wt, "q.txt", "the queue's work\n");
  x.emit(x.worker, { type: "step.started", queue: "Q", step: "Q1" });
  x.emit(x.worker, { type: "step.done", queue: "Q", step: "Q1", summary: "did Q1" });
  if (o.provisional) x.emit(x.orch, { type: "review.provisional", queue: "Q", step: "Q1" });
  else x.emit(x.user, { type: "review.accepted", queue: "Q", step: "Q1" });
  const integrate = (failedCheck = !!o.failedCheck) => {
    const start = git(wt, "rev-parse", "HEAD");
    const started_at = x.at();
    x.emit(x.worker, { type: "step.started", queue: "Q", step: "Q.integrate" });
    try { git(wt, "merge", "--no-edit", "-q", "main"); } catch { /* up to date */ }
    const end = git(wt, "rev-parse", "HEAD");
    x.emit(x.worker, { type: "check.result", queue: "Q", step: "Q.integrate", name: "npm test", ok: !failedCheck });
    x.emit(x.worker, { type: "step.done", queue: "Q", step: "Q.integrate", summary: "merged main", commit: end });
    if (!o.review) x.emit(x.user, { type: "review.accepted", queue: "Q", step: "Q.integrate" });
    const g = x.store.readGit("Q")!;
    const rounds = [...(g.steps["Q.integrate"] ?? []), { session: x.worker.id, start, started_at, end, ended_at: x.at() }];
    x.store.writeGit("Q", { ...g, steps: { ...g.steps, "Q.integrate": rounds } });
    return end;
  };
  const sha = integrate();
  x.store.writeRun("Q", { protocol: 1, session: x.worker.id, state: "finished", started_at: now(), updated_at: now(), ended_at: now() });
  const starts: string[] = [], releases: string[] = [];
  const merger = new Merger(x.store, { start: (id) => { starts.push(id); }, release: (id) => { releases.push(id); }, busy: () => false, serverRoot: join(x.base, "elsewhere") });
  const look = () => merger.onChange(loadProjectState(x.store));
  return { wt, work, sha, integrate, merger, look, starts, releases };
}

test("the clean case: main moves forward to the integrated commit, recorded as Nexus's, and the worktree and branch are cleaned up", () => {
  const x = project();
  const q = finished(x);
  const before = x.main();
  q.look();
  assert.equal(x.main(), q.sha, "a fast-forward to the integrated commit");
  assert.ok(ok(() => git(x.root, "merge-base", "--is-ancestor", before, q.sha)));
  assert.equal(git(x.root, "rev-list", "--parents", "-n", "1", "main").split(" ").length, 2, "no merge commit on main");
  const g = x.store.readGit("Q")!;
  assert.deepEqual([g.merged?.by, g.merged?.fast_forward, g.merged?.sha, g.merged?.into], ["nexus", true, q.sha, "main"]);
  assert.equal(git(x.root, "status", "--porcelain", "--untracked-files=no"), "", "the main checkout's files moved with it");
  q.look(); // the next change: nothing provisional waits, so it is cleaned up
  assert.ok(x.store.readGit("Q")!.cleaned);
  assert.ok(!existsSync(q.wt));
  assert.equal(git(x.root, "branch", "--list", "nexus/Q"), "");
  // A planned deploy after the queue counts it in only now.
  assert.deepEqual(judgePlan({ project: "p", queue: "Q" }, loadProjectState(x.store)), { verdict: "in" });
});

test("with merge_back off nothing is merged; a planned deploy after the queue waits for the user's merge back", () => {
  const x = project({ mergeBack: false });
  const q = finished(x);
  const before = x.main();
  q.look(); q.look();
  assert.equal(x.main(), before);
  assert.equal(x.store.readGit("Q")!.merged, undefined);
  assert.ok(existsSync(q.wt));
  assert.match(JSON.stringify(judgePlan({ project: "p", queue: "Q" }, loadProjectState(x.store))), /is done; its work is in the deploy once it is merged back into main/);
  // The user's Merge back goes the same way: a fast-forward, recorded as the user's.
  assert.match(mergeBack(x.store, "Q", join(x.base, "elsewhere")), /main moved forward to nexus\/Q/);
  assert.equal(x.main(), q.sha);
  assert.equal(x.store.readGit("Q")!.merged!.by, "user");
  q.look();
  assert.ok(existsSync(q.wt), "with merge_back off, the cleanup stays the user's");
});

test("failed checks of the integration step hold it, and the user is told", () => {
  const x = project();
  const q = finished(x, { failedCheck: true });
  const before = x.main();
  q.look();
  assert.equal(x.main(), before);
  const w = x.store.readGit("Q")!.merge?.waiting;
  assert.match(w!.reason, /checks of queue Q's integration step failed \(npm test\)/);
  const item = loadProjectState(x.store).attention.find((a) => a.kind === "merge");
  assert.equal(item?.queue, "Q");
  assert.equal(item?.text, w!.reason);
  q.look();
  assert.equal(x.store.readGit("Q")!.merge!.waiting!.since, w!.since, "told once per reason");
});

test("steps waiting for review, or unconfirmed provisional work with provisional_counts off, keep it from merging", () => {
  const x = project();
  const q = finished(x, { review: true });
  const before = x.main();
  q.look();
  assert.equal(x.main(), before, "the integration step waits for its review");
  assert.equal(x.store.readGit("Q")!.merge, undefined, "nothing to tell: the review is in the user's list already");

  const y = project({ provisionalCounts: false });
  const p = finished(y, { provisional: true });
  const b2 = y.main();
  p.look();
  assert.equal(y.main(), b2, "provisional work counts only once confirmed");
  y.emit(y.user, { type: "review.confirmed", queue: "Q", step: "Q1" });
  p.look();
  assert.equal(y.main(), p.sha);
});

test("unconfirmed provisional work (counting as accepted) is merged, but the cleanup waits until it is confirmed", () => {
  const x = project();
  const q = finished(x, { provisional: true });
  q.look();
  assert.equal(x.main(), q.sha);
  q.look(); q.look();
  assert.ok(existsSync(q.wt), "a Fix it may still come, and runs in the worktree");
  assert.equal(x.store.readGit("Q")!.cleaned, undefined);
  x.emit(x.user, { type: "review.confirmed", queue: "Q", step: "Q1" });
  q.look();
  assert.ok(x.store.readGit("Q")!.cleaned);
  assert.ok(!existsSync(q.wt));
});

test("when main moves on, the integration step runs again, at most twice; then it waits; main never moves but forward", () => {
  const x = project();
  const q = finished(x);
  const moves: string[] = [x.commit(x.root, "main1.txt", "main moved 1\n")];
  q.look();
  for (let round = 1; round <= 2; round++) {
    assert.equal(x.queue().steps.at(-1)!.status, "pending", `round ${round}: back to pending`);
    assert.equal(x.store.readGit("Q")!.merge!.reintegrations, round);
    assert.deepEqual(q.starts, Array(round).fill("Q"), "its run is started");
    assert.equal(x.main(), moves.at(-1), "main is not moved over it");
    // The integration step runs again (as its worker does: main merged into the branch), and is accepted; main moves
    // on again meanwhile (the user commits there).
    x.store.writeRun("Q", { protocol: 1, session: x.worker.id, state: "running", started_at: now(), updated_at: now() });
    q.look(); // the run holds it: nothing happens meanwhile
    q.integrate();
    moves.push(x.commit(x.root, `main${round + 1}.txt`, `main moved ${round + 1}\n`));
    x.store.writeRun("Q", { protocol: 1, session: x.worker.id, state: "finished", started_at: now(), updated_at: now(), ended_at: now() });
    q.look(); // its round opened (the request is used up) and ended: judged at once
  }
  // The third move: no third run again; it waits for the user.
  assert.equal(q.starts.length, 2);
  assert.match(x.store.readGit("Q")!.merge!.waiting!.reason, /main moved on again after queue Q's integration step ran 2 more times/);
  assert.equal(x.main(), moves[2], "main stays where it moved to");
  for (const m of moves) assert.equal(git(x.root, "rev-list", "--parents", "-n", "1", m).split(" ").length, 2, "no merge commit on main");

  // The user's Merge back runs it once more (and starts the count anew).
  let started = "";
  assert.match(mergeBack(x.store, "Q", join(x.base, "elsewhere"), (id) => { started = id; }), /integration step runs again: main moved on .* as the user's Merge back asked/);
  assert.equal(started, "Q");
  assert.equal(x.store.readGit("Q")!.merge!.reintegrations, 0);
  x.store.writeRun("Q", { protocol: 1, session: x.worker.id, state: "running", started_at: now(), updated_at: now() });
  const sha = q.integrate();
  x.store.writeRun("Q", { protocol: 1, session: x.worker.id, state: "finished", started_at: now(), updated_at: now(), ended_at: now() });
  q.look(); q.look();
  assert.equal(x.main(), sha, "then the fast-forward");
});

test("a dirty main checkout: it waits and tells, never moves over the changes; once clean it goes", () => {
  const x = project();
  const q = finished(x);
  const before = x.main();
  writeFileSync(join(x.root, ".gitignore"), ".nexus/\nnode_modules/\nedited\n");
  q.look();
  assert.equal(x.main(), before);
  // The queue and the reason first, the checkout's (long) path last: the waiting item shows the start of the text.
  const reason = x.store.readGit("Q")!.merge!.waiting!.reason;
  assert.match(reason, /^queue Q: the checkout of main has uncommitted changes: commit or stash them, then merge \(.+\)$/);
  assert.ok(loadProjectState(x.store).attention.some((a) => a.kind === "merge" && a.queue === "Q"));
  git(x.root, "checkout", "--", ".gitignore");
  q.look();
  assert.equal(x.main(), q.sha);
  assert.equal(x.store.readGit("Q")!.merge, undefined, "the wait is cleared");
  assert.ok(!loadProjectState(x.store).attention.some((a) => a.kind === "merge"));
});

test("a step at work in the main checkout, or one waiting for an answer, makes it wait for the step's end", () => {
  const x = project();
  const q = finished(x);
  x.store.writeQueue({ protocol: 1, id: "M", title: "Main", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [], steps: [{ id: "M1", title: "One", goal: "", acceptance: [] }] });
  approveQueue(x.store, "M");
  x.emit(x.worker, { type: "step.started", queue: "M", step: "M1" });
  x.store.writeRun("M", { protocol: 1, session: x.worker.id, state: "running", step: "M1", started_at: now(), updated_at: now() });
  const d = judgeMerge(x.store, loadProjectState(x.store), x.queue(), "nexus", join(x.base, "elsewhere"));
  assert.equal(d.kind, "hold");
  q.look();
  assert.notEqual(x.main(), q.sha);
  // The engine asks at M's step's end: held for the fast-forward.
  const held = q.merger.atBoundary("M", "M1", loadProjectState(x.store));
  assert.ok(held && /while Nexus merges queue Q back into this checkout/.test(held.hold));
  // Waiting for an answer is at work too.
  x.emit(x.worker, { type: "question.asked", queue: "M", step: "M1", qid: newId(), text: "Which?", can_continue: false });
  assert.equal(judgeMerge(x.store, loadProjectState(x.store), x.queue(), "nexus", join(x.base, "elsewhere")).kind, "hold");
  // Held at its end (paused): the fast-forward goes, and the run is let go.
  x.store.writeRun("M", { ...x.store.readRun("M")!, state: "paused", resume_after_restart: true });
  q.look();
  assert.equal(x.main(), q.sha);
  assert.deepEqual(q.releases, ["M"]);
});

/** A queue M working in the main checkout, its step M1 at work; `held()` holds it at M1's end as the engine does. */
function atWorkInMain(x: Project, q: ReturnType<typeof finished>) {
  x.store.writeQueue({ protocol: 1, id: "M", title: "Main", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [], steps: [{ id: "M1", title: "One", goal: "", acceptance: [] }, { id: "M2", title: "Two", goal: "", acceptance: [] }] });
  approveQueue(x.store, "M");
  x.emit(x.worker, { type: "step.started", queue: "M", step: "M1" });
  x.store.writeRun("M", { protocol: 1, session: x.worker.id, state: "running", step: "M1", started_at: now(), updated_at: now() });
  return {
    held: () => {
      x.emit(x.worker, { type: "step.done", queue: "M", step: "M1", summary: "did M1" });
      x.emit(x.user, { type: "review.accepted", queue: "M", step: "M1" });
      const hold = q.merger.atBoundary("M", "M1", loadProjectState(x.store));
      assert.ok(hold, "held at M1's end");
      x.store.writeRun("M", { ...x.store.readRun("M")!, state: "paused", resume_after_restart: true, reason: hold.hold });
    },
  };
}

test("a step at work with uncommitted changes in the main checkout: held first, not a dirty checkout; once held and clean it goes", () => {
  const x = project();
  const q = finished(x);
  const m = atWorkInMain(x, q);
  writeFileSync(join(x.root, ".gitignore"), ".nexus/\nnode_modules/\nM1's work\n"); // M1's work, not committed yet
  assert.equal(judgeMerge(x.store, loadProjectState(x.store), x.queue(), "nexus", join(x.base, "elsewhere")).kind, "hold");
  q.look();
  assert.equal(x.store.readGit("Q")!.merge, undefined, "nothing waits: the step's work is not a dirty checkout");
  git(x.root, "commit", "-qam", "M1: its work"); // the step commits its work at its end: main moves on
  m.held();
  q.look(); // held, clean, main moved on: the integration step runs again while M stays held
  assert.deepEqual(q.starts, ["Q"]);
  assert.equal(x.store.readGit("Q")!.merge!.reintegrations, 1);
  assert.deepEqual(q.releases, [], "M stays held during the run again");
  x.store.writeRun("Q", { protocol: 1, session: x.worker.id, state: "running", started_at: now(), updated_at: now() });
  q.look();
  const sha = q.integrate();
  q.look(); // its run still ending: held on
  assert.deepEqual(q.releases, []);
  x.store.writeRun("Q", { protocol: 1, session: x.worker.id, state: "finished", started_at: now(), updated_at: now(), ended_at: now() });
  q.look();
  assert.equal(x.main(), sha, "one run again, then the fast-forward");
  assert.deepEqual(q.releases, ["M"], "then M goes on");
  assert.equal(x.store.readGit("Q")!.merge, undefined);
  assert.ok(onlyForward(x), "main only moved by commits and fast-forwards");
});

test("held, then the merge back cannot go: a dirty checkout or failed checks let the run go at once, and the user and the orchestrator are told", () => {
  // A dirty checkout once held: M1 ended without committing its work.
  const x = project();
  const q = finished(x);
  const m = atWorkInMain(x, q);
  q.look();
  m.held();
  writeFileSync(join(x.root, ".gitignore"), ".nexus/\nnode_modules/\nleft uncommitted\n");
  q.look();
  assert.notEqual(x.main(), q.sha);
  assert.deepEqual(q.releases, ["M"]);
  const w = x.store.readGit("Q")!.merge!.waiting!;
  assert.match(w.reason, /has uncommitted changes/);
  assert.deepEqual(w.released, ["M"]);
  const item = loadProjectState(x.store).attention.find((a) => a.kind === "merge")!;
  assert.match(item.text, /has uncommitted changes.*; the run of queue M, held at its step's end for this merge back, goes on$/);
  q.look();
  assert.equal(x.store.readGit("Q")!.merge!.waiting!.since, w.since, "told once");
  assert.deepEqual(q.releases, ["M"], "let go once");

  // Failed checks in the run again during the hold.
  const y = project();
  const r = finished(y);
  const n = atWorkInMain(y, r);
  r.look();
  const m1 = y.commit(y.root, "m1.txt", "M1's work\n");
  n.held();
  r.look();
  assert.deepEqual(r.starts, ["Q"]);
  y.store.writeRun("Q", { protocol: 1, session: y.worker.id, state: "running", started_at: now(), updated_at: now() });
  r.integrate(true);
  y.store.writeRun("Q", { protocol: 1, session: y.worker.id, state: "finished", started_at: now(), updated_at: now(), ended_at: now() });
  r.look();
  assert.deepEqual(r.releases, ["M"]);
  const v = y.store.readGit("Q")!.merge!.waiting!;
  assert.match(v.reason, /checks of queue Q's integration step failed/);
  assert.deepEqual(v.released, ["M"]);
  assert.equal(y.main(), m1, "main stays where M left it");

  // A run again that does not get through (it halted) lets it go too.
  const z = project();
  const s = finished(z);
  const o = atWorkInMain(z, s);
  s.look();
  z.commit(z.root, "m1.txt", "M1's work\n");
  o.held();
  s.look();
  z.store.writeRun("Q", { protocol: 1, session: z.worker.id, state: "running", started_at: now(), updated_at: now() });
  z.emit(z.worker, { type: "step.started", queue: "Q", step: "Q.integrate" });
  s.look();
  assert.deepEqual(s.releases, []);
  z.store.writeRun("Q", { protocol: 1, session: z.worker.id, state: "halted", started_at: now(), updated_at: now(), reason: "a failed turn" });
  s.look();
  assert.deepEqual(s.releases, ["M"]);
  assert.match(z.store.readGit("Q")!.merge!.waiting!.reason, /did not get through its run again \(it is \w+, its run halted\)/);
  assert.deepEqual(z.store.readGit("Q")!.merge!.waiting!.released, ["M"]);
});

test("untracked files in the main checkout never keep the fast-forward", () => {
  const x = project();
  const q = finished(x);
  writeFileSync(join(x.root, "scratch.txt"), "not in git\n");
  q.look();
  assert.equal(x.main(), q.sha);
  assert.equal(x.store.readGit("Q")!.merge, undefined);
});

test("the button and the server do not race: one lock per queue; whoever comes second finds it merged; merged.by stays", () => {
  const x = project();
  const q = finished(x);
  assert.throws(() => withMergeLock(x.store, "Q", () => mergeBack(x.store, "Q", join(x.base, "elsewhere"))), /being merged back right now/);
  withMergeLock(x.store, "Q", () => q.look()); // the server's look while the user's merge holds the lock: it fails, records nothing merged
  assert.equal(x.store.readGit("Q")!.merged, undefined);
  assert.notEqual(x.main(), q.sha);
  assert.equal(mergeBack(x.store, "Q", join(x.base, "elsewhere")).includes("moved forward"), true);
  assert.equal(x.store.readGit("Q")!.merged!.by, "user");
  q.look();
  assert.equal(x.store.readGit("Q")!.merged!.by, "user", "the server finds it merged, and only cleans up");
  assert.ok(x.store.readGit("Q")!.cleaned);

  const y = project();
  const r = finished(y);
  r.look();
  assert.equal(y.store.readGit("Q")!.merged!.by, "nexus");
  assert.match(mergeBack(y.store, "Q", join(y.base, "elsewhere")), /already merged/);
  assert.equal(y.store.readGit("Q")!.merged!.by, "nexus");
});

test("a worktree with paths beyond 260 characters is removed completely", () => {
  const x = project();
  const q = finished(x);
  // Ignored files, as node_modules is: deep enough that the full path passes 260 characters.
  let dir = join(q.wt, "node_modules");
  while (dir.length < 300) dir = join(dir, "a-rather-long-package-folder-name");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), "module.exports = 1;\n");
  assert.ok(join(dir, "index.js").length > 260);
  mergeBack(x.store, "Q");
  cleanUp(x.store, "Q");
  assert.ok(!existsSync(q.wt));
  assert.ok(!git(x.root, "worktree", "list", "--porcelain").replaceAll("\\", "/").toLowerCase().includes(q.wt.replaceAll("\\", "/").toLowerCase()));
});

for (const phase of ["partial tree", "removed tree", "deleted branch"] as const) {
  test(`a new Merger resumes persisted cleanup after ${phase}`, (t) => {
    const x = project();
    const q = finished(x);
    q.look(); // merged, cleanup has not begun
    if (phase === "partial tree") {
      assert.throws(() => cleanUp(x.store, "Q", { unlink: () => {
        unlinkSync(join(q.wt, ".git"));
        git(x.root, "worktree", "prune", "--expire=now");
        throw new Error("EPERM: injected");
      } }), /EPERM/);
    } else if (phase === "removed tree") {
      const lock = join(x.root, ".git", "refs", "heads", "nexus", "Q.lock");
      writeFileSync(lock, "injected");
      assert.throws(() => cleanUp(x.store, "Q"), /cannot lock ref|could not remove/);
      unlinkSync(lock);
    } else {
      const write = x.store.writeGit.bind(x.store);
      t.mock.method(x.store, "writeGit", (id: string, record: GitFile) => {
        if (record.cleaned) throw new Error("interrupted before cleaned record");
        write(id, record);
      });
      assert.throws(() => cleanUp(x.store, "Q"), /interrupted before cleaned/);
      assert.equal(git(x.root, "branch", "--list", "nexus/Q"), "");
    }
    q.merger.shutdown();
    const store = new ProjectStore(x.store.dir);
    const restarted = new Merger(store, { start: () => assert.fail("no worker should start"), release: () => {}, busy: () => false });
    try {
      restarted.onChange(loadProjectState(store));
      assert.ok(store.readGit("Q")!.cleaned);
      assert.equal(store.readGit("Q")!.cleanup_proof, undefined);
      assert.equal(existsSync(q.wt), false);
      assert.equal(git(x.root, "branch", "--list", "nexus/Q"), "");
      assert.equal(x.main(), q.sha);
      restarted.onChange(loadProjectState(store));
      assert.equal(store.readGit("Q")!.merge, undefined);
    } finally { restarted.shutdown(); }
  });
}

test("a survey wait preserves cleanup proof and a restarted merger leaves its retry to the user", () => {
  const x = project();
  const q = finished(x);
  q.look();
  x.store.writeQueue({ ...x.store.readQueue("Q"), maintenance: "survey" });
  assert.throws(() => cleanUp(x.store, "Q", { unlink: () => {
    unlinkSync(join(q.wt, ".git"));
    throw new Error("injected partial removal");
  } }), /injected/);
  const proof = x.store.readGit("Q")!.cleanup_proof;
  writeFileSync(join(q.wt, "foreign.txt"), "keep");
  q.look();
  assert.deepEqual(x.store.readGit("Q")!.cleanup_proof, proof);
  assert.match(x.store.readGit("Q")!.cleanup!.waiting.reason, /new, modified or replaced/);
  const waiting = x.store.readGit("Q")!.cleanup;
  q.merger.shutdown();
  const store = new ProjectStore(x.store.dir);
  const restarted = new Merger(store, { start: () => assert.fail("no worker"), release: () => {}, busy: () => false });
  try {
    restarted.onChange(loadProjectState(store));
    assert.deepEqual(store.readGit("Q")!.cleanup, waiting);
    unlinkSync(join(q.wt, "foreign.txt"));
    cleanUp(store, "Q");
    assert.ok(store.readGit("Q")!.cleaned);
    assert.equal(store.readGit("Q")!.cleanup, undefined);
  } finally { restarted.shutdown(); }
});

// ---------------------------------------------------------------- with the engine and the fake runtimes

/**
 * A project with a worktree queue W and the engine and Merger wired as the server wires them. `M`: a queue in the main
 * checkout; `B`: another queue, in a worktree of its own when `bWorktree`.
 */
function wired(steps: { W: StepDef[]; M?: StepDef[]; B?: StepDef[] }, o: { mergeBack?: boolean; bWorktree?: boolean } = {}) {
  const x = project({ mergeBack: o.mergeBack });
  x.store.writeQueue({ protocol: 1, id: "W", title: "Worktree", revision: 1, status: "proposed", worktree: "auto", stop_conditions: [], checks: [], steps: steps.W });
  approveQueue(x.store, "W");
  if (steps.M) { x.store.writeQueue({ protocol: 1, id: "M", title: "Main", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: steps.M }); approveQueue(x.store, "M"); }
  if (steps.B) {
    x.store.writeQueue({ protocol: 1, id: "B", title: "After", revision: 1, status: "proposed", ...(o.bWorktree ? { worktree: "auto" as const } : {}), stop_conditions: [], checks: [], steps: steps.B });
    approveQueue(x.store, "B");
  }
  let merger: Merger | undefined;
  /** Steps (`queue/step`) the test holds in review. */
  const inReview = new Set<string>();
  const tick = () => {
    routeAnswers(x.store); acceptReviews(x.store, inReview);
    const s = loadProjectState(x.store);
    merger!.onChange(s);
    engine.onChange(loadProjectState(x.store));
  };
  const engine: Engine = new Engine(x.store, tick, { retryBaseMs: 30, usageMarginMs: 100, ...QUICK_ENGINE, boundary: (q, step, state) => merger!.atBoundary(q, step, state) });
  merger = new Merger(x.store, { start: (q) => void engine.start(q, { runtime: "claude" }), release: (q, why) => engine.releaseHold(q, why), busy: () => engine.draining, serverRoot: join(x.base, "elsewhere"), poke: tick, pollMs: 200 });
  const until = (what: string, pred: () => boolean, ms: number = LONGER.processes) =>
    waitUntil(what, pred, ms, () => ["W", ...(steps.B ? ["B"] : [])].map((id) => `; ${id} ${JSON.stringify(x.queue(id).run)} ${x.queue(id).steps.map((s) => `${s.id}=${s.status}`).join(" ")}; git ${JSON.stringify(x.store.readGit(id)?.merge)}`).join(""));
  return { ...x, engine, merger, until, inReview };
}
const step = (id: string, behaviour: string): StepDef => ({ id, title: `Step ${id}`, goal: `FAKE: ${behaviour}`, acceptance: [] });

test("engine: a step at work in the main checkout is held at its end for the fast-forward, then goes on", async () => {
  const hold = holdWork();
  const x = wired({ W: [step("W1", "commit")], M: [step("M1", "slow"), step("M2", "done")] });
  try {
    x.engine.start("M", { runtime: "claude" });
    await x.until("M1 at work", () => x.queue("M").steps[0]!.status === "running");
    x.engine.start("W", { runtime: "claude" });
    await x.until("W done", () => x.queue("W").status === "done");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(x.store.readGit("W")!.merged, undefined, "not while M1 is at work in the main checkout");
    hold.release();
    await x.until("W merged back", () => !!x.store.readGit("W")?.merged);
    await x.until("M finished", () => x.queue("M").run?.state === "finished");
    const merged = x.store.readGit("W")!.merged!;
    assert.equal(merged.by, "nexus");
    assert.ok(merged.at <= x.queue("M").steps[1]!.started_at!, `the fast-forward (${merged.at}) before M2 opened (${x.queue("M").steps[1]!.started_at})`);
    assert.equal(x.main(), merged.sha);
  } finally { hold.done(); x.merger.shutdown(); x.engine.shutdown(); }
});

test("engine: main moved while the merge waited: the integration step runs again for real, then main moves forward", async () => {
  const x = wired({ W: [step("W1", "commit")] });
  try {
    writeFileSync(join(x.root, ".gitignore"), ".nexus/\nnode_modules/\nlater\n"); // dirty: the merge waits
    x.engine.start("W", { runtime: "claude" });
    await x.until("the wait", () => /uncommitted changes/.test(x.store.readGit("W")?.merge?.waiting?.reason ?? ""));
    const first = x.store.readGit("W")!.steps["W.integrate"]!.at(-1)!.end!;
    git(x.root, "commit", "-qam", "main: later"); // clean again, and main moved on
    await x.until("merged back", () => !!x.store.readGit("W")?.merged);
    const g = x.store.readGit("W")!;
    assert.equal(g.steps["W.integrate"]!.length, 2, "the integration step ran again");
    assert.notEqual(g.merged!.sha, first);
    assert.equal(x.main(), g.merged!.sha);
    assert.equal(git(x.root, "rev-list", "--parents", "-n", "1", "main~0").split(" ").length, 3, "the integrated commit is the worker's merge on the queue's branch");
    assert.ok(ok(() => git(x.root, "merge-base", "--is-ancestor", "HEAD~1", "main")));
  } finally { x.merger.shutdown(); x.engine.shutdown(); }
});

test("engine: a step at work in the main checkout with uncommitted work is held at its end; one run again of the integration step, the fast-forward, then the run goes on", async () => {
  const hold = holdWork();
  const x = wired({ W: [step("W1", "commit")], M: [step("M1", "slow"), step("M2", "done")] });
  let dirtyWait = false;
  const watch = (pred: () => boolean) => () => {
    if (/uncommitted changes/.test(x.store.readGit("W")?.merge?.waiting?.reason ?? "")) dirtyWait = true;
    return pred();
  };
  try {
    x.engine.start("M", { runtime: "claude" });
    await x.until("M1 at work", () => x.queue("M").steps[0]!.status === "running");
    writeFileSync(join(x.root, ".gitignore"), ".nexus/\nnode_modules/\nM1's work\n"); // M1's work, not committed yet
    x.engine.start("W", { runtime: "claude" });
    await x.until("W done", watch(() => x.queue("W").status === "done"));
    const first = x.store.readGit("W")!.steps["W.integrate"]!.at(-1)!.end!;
    await sleep(500); // a few looks of the merger's (pollMs 200)
    watch(() => true)();
    assert.equal(dirtyWait, false, "M1's uncommitted work is not a dirty checkout: M1 is held first");
    assert.equal(x.store.readGit("W")!.merged, undefined, "not while M1 is at work in the main checkout");
    git(x.root, "commit", "-qam", "M1: its work"); // M1 commits at its end: main moves on
    const m1 = x.main();
    hold.release();
    await x.until("W merged back", watch(() => !!x.store.readGit("W")?.merged));
    await x.until("M finished", () => x.queue("M").run?.state === "finished");
    assert.equal(dirtyWait, false);
    const g = x.store.readGit("W")!;
    assert.equal(g.steps["W.integrate"]!.length, 2, "one run again of the integration step");
    assert.notEqual(g.merged!.sha, first);
    assert.equal(x.main(), g.merged!.sha);
    assert.ok(ok(() => git(x.root, "merge-base", "--is-ancestor", m1, "main")), "M1's work is in main");
    assert.ok(g.merged!.at <= x.queue("M").steps[1]!.started_at!, `the fast-forward (${g.merged!.at}) before M2 opened (${x.queue("M").steps[1]!.started_at})`);
    assert.ok(onlyForward(x), "main only moved by commits and fast-forwards");
  } finally { hold.done(); x.merger.shutdown(); x.engine.shutdown(); }
});

// ---------------------------------------------------------------- the plan after a worktree queue

test("engine, merge_back on: a queue planned after a worktree queue starts once its work is merged back, from main with that work in it", async () => {
  const x = wired({ W: [step("W1", "commit")], B: [step("B1", "done")] }, { bWorktree: true });
  try {
    writeFileSync(join(x.root, ".gitignore"), ".nexus/\nnode_modules/\nlater\n"); // dirty: the merge back waits
    assert.match(x.engine.plan("B", { after: ["W"], by: "user", runtime: "claude" }), /starts when queue W is done/);
    x.engine.start("W", { runtime: "claude" });
    await x.until("W done, its merge back waiting", () => x.queue("W").status === "done" && /uncommitted changes/.test(x.store.readGit("W")?.merge?.waiting?.reason ?? ""));
    await sleep(500); // a few looks of the merger's and the plan's
    const b = x.queue("B");
    assert.equal(b.run, undefined, "B does not start while W's work is not in main");
    assert.equal(b.plan!.ready, false);
    assert.equal(b.plan!.after[0]!.done, false);
    assert.equal(b.plan!.after[0]!.blocked, true, "a dirty checkout needs the user");
    assert.match(b.plan!.waiting, /queue W is done; it waits to be merged back into main: queue W: the checkout of main has uncommitted changes/);
    assert.ok(planLines(b).some((l) => /now: queue W is done; it waits to be merged back into main/.test(l)), "nexus status says why");
    git(x.root, "checkout", "--", ".gitignore"); // clean again, main where it was
    await x.until("B started", () => !!x.queue("B").run);
    const merged = x.store.readGit("W")!.merged!;
    assert.equal(merged.by, "nexus");
    assert.ok(merged.at <= x.queue("B").run!.started_at, `the merge back (${merged.at}) before B started (${x.queue("B").run!.started_at})`);
    const base = x.store.readGit("B")!.base!;
    assert.equal(base.ref, "main");
    assert.ok(ok(() => git(x.root, "merge-base", "--is-ancestor", merged.sha, base.sha)), "B's worktree starts from main with W's work in it");
    await x.until("B done", () => x.queue("B").status === "done");
    assert.ok(existsSync(join(x.base, "project.worktrees", "B", "W1.txt")) || ok(() => git(x.root, "cat-file", "-e", `${x.queue("B").branch}:W1.txt`)), "W's file is in B's work");
  } finally { x.merger.shutdown(); x.engine.shutdown(); }
});

test("engine, merge_back off: a queue planned after a worktree queue starts when it is done, as before, with nothing merged", async () => {
  const x = wired({ W: [step("W1", "commit")], B: [step("B1", "done")] }, { mergeBack: false });
  try {
    x.engine.plan("B", { after: ["W"], by: "user", runtime: "claude" });
    x.engine.start("W", { runtime: "claude" });
    await x.until("B started", () => !!x.queue("B").run);
    assert.equal(x.queue("W").status, "done");
    assert.equal(x.store.readGit("W")?.merged, undefined, "the user merges back with Merge back");
    await x.until("B done", () => x.queue("B").status === "done");
  } finally { x.merger.shutdown(); x.engine.shutdown(); }
});

test("engine, merge_back on: a queue planned after one in the main checkout starts when it is done, as before", async () => {
  const x = wired({ W: [step("W1", "done")], M: [step("M1", "commit")], B: [step("B1", "done")] });
  try {
    x.engine.plan("B", { after: ["M"], by: "user", runtime: "claude" });
    x.engine.start("M", { runtime: "claude" });
    await x.until("B started", () => !!x.queue("B").run);
    assert.equal(x.queue("M").status, "done");
    await x.until("B done", () => x.queue("B").status === "done");
  } finally { x.merger.shutdown(); x.engine.shutdown(); }
});

// ---------------------------------------------------------------- the merge train

test("engine, merge train: the second worktree queue integrates only after the first's fast-forward, once; its own steps never wait", async () => {
  const x = wired({ W: [step("W1", "commit")], B: [step("B1", "commit"), step("B2", "commit")] }, { bWorktree: true });
  x.inReview.add("W/W.integrate"); // W holds main: its integration step waits for its review
  try {
    x.engine.start("W", { runtime: "claude" });
    await x.until("W's integration step in review", () => x.queue("W").steps.find((s) => s.integration)!.status === "review");
    x.engine.start("B", { runtime: "claude" });
    await x.until("B held before its integration step", () => x.queue("B").run?.state === "paused" && !!x.queue("B").train);
    const b = x.queue("B");
    assert.deepEqual(b.steps.map((s) => s.status), ["done", "done", "pending"], "B1 and B2 ran while W integrated");
    assert.match(b.run!.reason ?? "", /held at the end of step B2: it waits to integrate after W \(one queue at a time merges back into main\)/);
    assert.deepEqual(b.train, { base: "main", position: 1, after: "W" });
    assert.ok(planLines(b).some((l) => /integration: waits to integrate after W/.test(l)), "nexus status says why");
    assert.equal(x.store.readGit("W")?.merged, undefined);
    x.inReview.clear();
    await x.until("B merged back", () => !!x.store.readGit("B")?.merged);
    const w = x.store.readGit("W")!, g = x.store.readGit("B")!;
    const bInteg = x.queue("B").steps.find((s) => s.integration)!;
    assert.ok(w.merged!.at <= bInteg.started_at!, `W's fast-forward (${w.merged!.at}) before B's integration step (${bInteg.started_at})`);
    assert.equal(g.steps["B.integrate"]!.length, 1, "B's integration step ran once: main did not move meanwhile");
    assert.equal(g.merge?.reintegrations, undefined);
    assert.equal(x.main(), g.merged!.sha);
    assert.ok(ok(() => git(x.root, "merge-base", "--is-ancestor", w.merged!.sha, "main")), "W's work is in main");
    assert.ok(onlyForward(x), "main only moved forward");
  } finally { x.merger.shutdown(); x.engine.shutdown(); }
});

test("engine, merge train: a fast-forward that cannot go lets the next queue go; back from its wait it queues up behind it", async () => {
  const x = wired({ W: [step("W1", "commit")], B: [step("B1", "commit")] }, { bWorktree: true });
  try {
    writeFileSync(join(x.root, ".gitignore"), ".nexus/\nnode_modules/\nlater\n"); // dirty: W's fast-forward waits
    x.engine.start("W", { runtime: "claude" });
    await x.until("W's fast-forward waiting", () => /uncommitted changes/.test(x.store.readGit("W")?.merge?.waiting?.reason ?? ""));
    x.inReview.add("B/B.integrate"); // B holds main: its integration step waits for its review
    x.engine.start("B", { runtime: "claude" });
    await x.until("B's integration step in review", () => x.queue("B").steps.find((s) => s.integration)!.status === "review");
    git(x.root, "checkout", "--", ".gitignore"); // clean again: W could go, but B holds main now
    await x.until("W queued behind B", () => !!x.store.readGit("W")?.merge?.queued);
    await sleep(500); // a few looks of the merger's (pollMs 200)
    const w = x.queue("W");
    assert.equal(w.git!.merged, undefined, "W does not move main while B holds it");
    assert.equal(w.git!.merge!.waiting, undefined);
    assert.deepEqual(w.train, { base: "main", position: 1, after: "B" });
    assert.ok(planLines(w).some((l) => /integration: waits to integrate after B/.test(l)));
    x.inReview.clear();
    await x.until("W merged back", () => !!x.store.readGit("W")?.merged);
    const g = x.store.readGit("W")!, b = x.store.readGit("B")!;
    assert.ok(b.merged!.at < g.merged!.at, "B first, then W");
    assert.equal(g.steps["W.integrate"]!.length, 2, "W's integration step ran again on main with B's work");
    assert.equal(x.main(), g.merged!.sha);
    assert.ok(ok(() => git(x.root, "merge-base", "--is-ancestor", b.merged!.sha, "main")));
    assert.ok(onlyForward(x), "main only moved forward");
  } finally { x.merger.shutdown(); x.engine.shutdown(); }
});
