// Git on the dashboard (src/gitinfo.ts) against temporary repositories: the records of a step's HEAD, the commit lists,
// foreign commits in the main checkout, and a branch's ahead/behind. Nothing here reaches a remote: the remote-tracking
// ref is set with update-ref, and the remote's URL points nowhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { ProjectStore, approveQueue, loadProjectState, newId, routeAnswers, type Event } from "@nexus/protocol";
import type { AgentEvents, AgentProcess } from "../src/agent.ts";
import { Engine } from "../src/engine.ts";
import { branchState, recordBase, recordStepEnd, recordStepStart, stepCommits } from "../src/gitinfo.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { until, LONGER } from "./wait.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");
const G = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"];
const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", [...G, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();

function repo(withGit = true) {
  const base = mkdtempSync(join(tmpdir(), "nexus-git-"));
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  const root = join(base, "project");
  mkdirSync(root);
  const commit = (cwd: string, name: string, lines = 1, date?: Date) => {
    writeFileSync(join(cwd, `${name}.txt`), Array.from({ length: lines }, (_, i) => `${name} ${i}`).join("\n") + "\n");
    const env: Record<string, string> = date ? { GIT_COMMITTER_DATE: date.toISOString(), GIT_AUTHOR_DATE: date.toISOString() } : {};
    git(cwd, ["add", "-A"], env); git(cwd, ["commit", "-q", "-m", `${name} subject`], env);
    return git(cwd, ["rev-parse", "HEAD"]);
  };
  if (withGit) {
    git(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, ".gitignore"), ".nexus/\n");
    commit(root, "start");
  }
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  return { base, root, store, commit };
}

test("the engine records HEAD when a step opens and when its outcome's turn ends; the step lists its commits", async () => {
  const { root, store } = repo();
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [1, 2].map((i) => ({ id: `Q${i}`, title: `Step ${i}`, goal: "FAKE: commit", acceptance: [] })) });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); });
  const queue = () => loadProjectState(store).queues[0]!;
  try {
    const start = git(root, ["rev-parse", "HEAD"]);
    engine.start("Q");
    // Two steps that each commit (git, the fake worker, the nexus CLI): a named longer wait.
    await until("the run to finish with both steps' commits", () => queue().run?.state === "finished" && !!store.readGit("Q")?.steps.Q2?.[0]?.end,
      LONGER.processes, () => `; git: ${JSON.stringify(store.readGit("Q"))}`);
    const g = store.readGit("Q")!;
    const [r1, r2] = [g.steps.Q1![0]!, g.steps.Q2![0]!];
    assert.equal(r1.start, start, "HEAD when Q1 opened");
    assert.equal(r1.end, r2.start, "Q1 ended where Q2 began");
    assert.equal(r2.end, git(root, ["rev-parse", "HEAD"]));
    assert.equal(r1.session, queue().run!.session);
    const c1 = stepCommits(store, queue(), "Q1")!;
    assert.deepEqual(c1.rounds[0]!.commits.map((c) => [c.subject, c.files, c.insertions, c.deletions, c.foreign]), [["Q1 work", 1, 1, 0, false]]);
    assert.equal(c1.rounds[0]!.open, false);
    assert.deepEqual(stepCommits(store, queue(), "Q2")!.rounds[0]!.commits.map((c) => c.subject), ["Q2 work"]);
  } finally { engine.shutdown(); }
});

test("a step's round of commits begins before its worker hears of the step, and the step before has ended its round", async () => {
  const { root, store, commit } = repo();
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [1, 2].map((i) => ({ id: `Q${i}`, title: `Step ${i}`, goal: "", acceptance: [] })) });
  approveQueue(store, "Q");
  /** A stand-in worker: for each text it is sent, what git.yaml held at that moment. */
  const told: { text: string; steps: Record<string, { start?: string | null; end?: string | null }[]> }[] = [];
  class Stand extends EventEmitter<AgentEvents> implements AgentProcess {
    state: AgentProcess["state"] = "idle";
    readonly pid = 4242;
    send(text: string): void { told.push({ text, steps: structuredClone(store.readGit("Q")?.steps ?? {}) }); this.state = "working"; }
    stop(): boolean { return false; }
    close(): void { this.state = "exited"; }
    kill(): void { this.state = "exited"; }
  }
  let stand: Stand | undefined;
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); },
    { spawn: () => (stand = new Stand()) });
  const event = (body: Record<string, unknown>) => store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: store.readRun("Q")!.session, queue: "Q", ...body } as Event);
  try {
    const start = git(root, ["rev-parse", "HEAD"]);
    engine.start("Q");
    // When Q1's opening reaches the worker, its round has begun at the HEAD of then (before: it was read afterwards,
    // and a quick worker's commit could land first, queue TS1).
    assert.match(told[0]!.text, /step Q1 \(1 of 2\)/);
    assert.equal(told[0]!.steps.Q1?.[0]?.start, start);
    // The worker commits and reports Q1 done; its turn ends.
    event({ type: "step.started", step: "Q1" });
    commit(root, "q1");
    event({ type: "step.done", step: "Q1", summary: "done" });
    stand!.state = "idle";
    stand!.emit("turnEnd", { ok: true, text: "done" });
    engine.onChange(loadProjectState(store));
    await until("Q2's opening", () => told.some((t) => /step Q2 \(2 of 2\)/.test(t.text)), LONGER.step);
    const q1End = git(root, ["rev-parse", "HEAD"]);
    const atQ2 = told.find((t) => /step Q2 \(2 of 2\)/.test(t.text))!.steps;
    assert.equal(atQ2.Q1?.[0]?.end, q1End, "Q1's round ended when Q2's worker heard of Q2");
    assert.equal(atQ2.Q2?.[0]?.start, q1End, "Q2's round began there, before its worker could commit");
  } finally { engine.shutdown(); }
});

test("in the main checkout, a commit outside the worker's turns on the step is foreign; in a worktree none is", () => {
  const { root, store, commit } = repo();
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "Q1", title: "Step 1", goal: "", acceptance: [] }] });
  const session = "S1";
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms);
  recordStepStart(store, "Q", "Q1", session);
  store.appendActivity(session, { at: at(-60_000).toISOString(), kind: "turn_start", text: "turn started", queue: "Q", step: "Q1" });
  const mine = commit(root, "mine", 3, at(-30_000));
  store.appendActivity(session, { at: at(-20_000).toISOString(), kind: "turn_end", text: "turn ended", queue: "Q", step: "Q1" });
  const theirs = commit(root, "theirs", 2, at(-10_000)); // the user's, between turns
  recordStepEnd(store, "Q", "Q1");
  const view = () => loadProjectState(store).queues[0]!;
  const commits = stepCommits(store, view(), "Q1")!.rounds[0]!.commits;
  assert.deepEqual(commits.map((c) => [c.sha, c.subject, c.insertions, c.foreign]), [[theirs, "theirs subject", 2, true], [mine, "mine subject", 3, false]]);

  // The same queue in a worktree of its own: nobody else commits there, so nothing is marked.
  const wt = join(root, "..", "wt");
  git(root, ["worktree", "add", "-q", "-b", "nexus/Q", wt]);
  store.writeQueue({ ...store.readQueue("Q"), worktree: wt.replaceAll("\\", "/"), branch: "nexus/Q" });
  assert.ok(stepCommits(store, view(), "Q1")!.rounds[0]!.commits.every((c) => !c.foreign));
});

test("a queue's branch: ahead and behind of its base and of the local remote-tracking ref, with that ref's age", () => {
  const { root, store, commit } = repo();
  const wt = join(root, "..", "wt");
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [],
    worktree: "auto", branch: "nexus/Q", steps: [{ id: "Q1", title: "Step 1", goal: "", acceptance: [] }] });
  assert.equal(branchState(store, loadProjectState(store).queues[0]!), undefined, "no worktree yet: nothing");
  recordBase(store, store.readQueue("Q"), root); // as the engine does when it makes the worktree
  assert.equal(store.readGit("Q")!.base!.ref, "main");
  git(root, ["worktree", "add", "-q", "-b", "nexus/Q", wt, "main"]);
  store.writeQueue({ ...store.readQueue("Q"), worktree: wt.replaceAll("\\", "/") });
  const a = commit(wt, "a");
  commit(wt, "b");
  commit(root, "on main");
  // An "origin" that is never contacted; its tracking ref set by hand, as a fetch would have left it.
  git(root, ["remote", "add", "origin", join(root, "..", "nowhere.git")]);
  git(root, ["update-ref", "-m", "fetch: as a test", "refs/remotes/origin/nexus/Q", a]);
  git(root, ["config", "branch.nexus/Q.remote", "origin"]);
  git(root, ["config", "branch.nexus/Q.merge", "refs/heads/nexus/Q"]);
  const v = branchState(store, loadProjectState(store).queues[0]!)!;
  assert.equal(v.branch, "nexus/Q");
  assert.deepEqual(v.base, { ref: "main", ahead: 2, behind: 1 });
  assert.deepEqual([v.upstream?.ref, v.upstream?.ahead, v.upstream?.behind], ["origin/nexus/Q", 1, 0]);
  assert.ok(v.upstream?.at && Math.abs(Date.parse(v.upstream.at) - Date.now()) < 120_000, `the ref's age is when it was set: ${v.upstream?.at}`);
});

test("a project that is not a git repository shows nothing", () => {
  const { store } = repo(false);
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "Q1", title: "Step 1", goal: "", acceptance: [] }] });
  recordStepStart(store, "Q", "Q1", "S1");
  recordStepEnd(store, "Q", "Q1");
  const q = loadProjectState(store).queues[0]!;
  assert.equal(stepCommits(store, q, "Q1"), undefined);
  assert.equal(branchState(store, q), undefined);
});
