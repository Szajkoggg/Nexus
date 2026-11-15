// Nexus merging worktree queues back by itself (src/merger.ts, src/mergeback.ts), against temporary repositories:
// local git only, no remote. Most cases are a finished queue written as files (its steps' events and its integration
// step's round in git.yaml) and the Merger looking at it; the cases that need a run (a step at work in the main
// checkout held at its end; the integration step run again for real) use the engine with the fake runtimes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, approveQueue, loadProjectState, newId, now, routeAnswers, updateSettings, type Event, type QueueFile, type SessionFile, type StepDef,
} from "@nexus/protocol";
import { recordBase } from "../src/gitinfo.ts";
import { Merger } from "../src/merger.ts";
import { judgeMerge, mergeBack, removeWorktree, withMergeLock } from "../src/mergeback.ts";
import { judgePlan } from "../src/deploy-plan.ts";
import { Engine } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { LONGER, holdWork, until as waitUntil } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

/** The system's temporary folder, read once: each project sets TEMP to a folder of its own (the report's folder). */
const TMP = tmpdir();
const G = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...G, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ok = (f: () => unknown) => { try { f(); return true; } catch { return false; } };

/** A project in a temporary git repository, with merge_back as given. */
function project(o: { mergeBack?: boolean; provisionalCounts?: boolean } = {}) {
  const base = mkdtempSync(join(TMP, "nexus-merger-"));
  const temp = join(base, "temp");
  mkdirSync(temp);
  process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp;
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  const root = join(base, "project");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "test"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".nexus/\nnode_modules/\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "init");
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
  const integrate = () => {
    const start = git(wt, "rev-parse", "HEAD");
    const started_at = x.at();
    x.emit(x.worker, { type: "step.started", queue: "Q", step: "Q.integrate" });
    try { git(wt, "merge", "--no-edit", "-q", "main"); } catch { /* up to date */ }
    const end = git(wt, "rev-parse", "HEAD");
    x.emit(x.worker, { type: "check.result", queue: "Q", step: "Q.integrate", name: "npm test", ok: !o.failedCheck });
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
  const moves: string[] = [];
  for (let round = 1; round <= 3; round++) {
    moves.push(x.commit(x.root, `main${round}.txt`, `main moved ${round}\n`));
    q.look();
    if (round <= 2) {
      assert.equal(x.queue().steps.at(-1)!.status, "pending", `round ${round}: back to pending`);
      assert.equal(x.store.readGit("Q")!.merge!.reintegrations, round);
      assert.deepEqual(q.starts, Array(round).fill("Q"), "its run is started");
      assert.equal(x.main(), moves.at(-1), "main is not moved over it");
      // The integration step runs again (as its worker does: main merged into the branch), and is accepted.
      x.store.writeRun("Q", { protocol: 1, session: x.worker.id, state: "running", started_at: now(), updated_at: now() });
      q.look(); // the run holds it: nothing happens meanwhile
      q.integrate();
      x.store.writeRun("Q", { protocol: 1, session: x.worker.id, state: "finished", started_at: now(), updated_at: now(), ended_at: now() });
      q.look(); // its round opened: the request is used up
      if (round < 3) continue;
    }
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
  assert.match(x.store.readGit("Q")!.merge!.waiting!.reason, /has uncommitted changes/);
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
  removeWorktree(x.root, q.wt);
  assert.ok(!existsSync(q.wt));
  assert.ok(!git(x.root, "worktree", "list", "--porcelain").replaceAll("\\", "/").toLowerCase().includes(q.wt.replaceAll("\\", "/").toLowerCase()));
});

// ---------------------------------------------------------------- with the engine and the fake runtimes

/** A project with a worktree queue W and the engine and Merger wired as the server wires them. */
function wired(steps: { W: StepDef[]; M?: StepDef[] }) {
  const x = project();
  x.store.writeQueue({ protocol: 1, id: "W", title: "Worktree", revision: 1, status: "proposed", worktree: "auto", stop_conditions: [], checks: [], steps: steps.W });
  approveQueue(x.store, "W");
  if (steps.M) { x.store.writeQueue({ protocol: 1, id: "M", title: "Main", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: steps.M }); approveQueue(x.store, "M"); }
  let merger: Merger | undefined;
  const tick = () => {
    routeAnswers(x.store); acceptReviews(x.store);
    const s = loadProjectState(x.store);
    merger!.onChange(s);
    engine.onChange(loadProjectState(x.store));
  };
  const engine: Engine = new Engine(x.store, tick, { retryBaseMs: 30, usageMarginMs: 100, boundary: (q, step, state) => merger!.atBoundary(q, step, state) });
  merger = new Merger(x.store, { start: (q) => void engine.start(q, { runtime: "claude" }), release: (q, why) => engine.releaseHold(q, why), busy: () => engine.draining, serverRoot: join(x.base, "elsewhere"), poke: tick, pollMs: 200 });
  const until = (what: string, pred: () => boolean, ms: number = LONGER.processes) =>
    waitUntil(what, pred, ms, () => `; W ${JSON.stringify(x.queue("W").run)} ${x.queue("W").steps.map((s) => `${s.id}=${s.status}`).join(" ")}; git ${JSON.stringify(x.store.readGit("W")?.merge)}`);
  return { ...x, engine, merger, until };
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
