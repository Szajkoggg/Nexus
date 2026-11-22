// The integration step without a model (queue MI; docs/protocol/git.md, "The integration step", "Without a model"), against the
// fake runtimes, temporary git repositories and stand-in checks that Nexus runs itself (the engine has a capacity
// coordinator). A clean merge with green checks is done and accepted by Nexus without the worker's opening it; a
// conflict the project lets a worker resolve opens the step for the worker, one it does not stops the queue without a
// worker; a failing check gives the worker the step as a check-fix round; a merge that changes a lockfile runs the
// worktree setup before the checks; at a step boundary a base that merges cleanly is merged into the queue's branch, one
// that conflicts is not, and `nexus status` says so. A server that stopped between the step's start and its done runs it
// again from its start (a half-done merge aborted, a merge already made found as nothing to merge); an update's drain
// waits for a running setup. A check running when the server stops (Job Objects) is interrupted and runs again at
// Resume after a plain restart, at once after an update, and leaves the machine's slot free (queue EF, EF4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { orchestratorOverview } from "@nexus/protocol";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTEGRATION_CONDITION, NEXUS_SESSION, ProjectStore, approveQueue, wrote, loadProjectState, readCapacity, routeAnswers, setStepLevel, updateSettings, type StepDef } from "@nexus/protocol";
import { Capacity } from "../src/capacity.ts";
import { Engine, type EngineOptions } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { gatedCleanup } from "./gated-cleanup.ts";
import { LONGER, QUICK_ENGINE, holdWork, until as waitUntil } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

const step = (id: string, behaviour: string): StepDef => ({ id, title: `Step ${id}`, goal: `FAKE: ${behaviour}`, acceptance: [] });
/** The system's temporary folder as it was: each test points TEMP at a folder of its own, which must not nest. */
const TMP = tmpdir();
const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

/**
 * Stand-in checks (and setup): `node check.cjs <name>` logs its name and exits with the next planned code of <name>
 * (`plan`; the last one stays; none planned: 0), after an optional wait ("<ms>ms:<code>").
 */
function standIns() {
  const dir = mkdtempSync(join(TMP, "nexus-free-checks-"));
  const script = join(dir, "check.cjs");
  writeFileSync(script, `const fs = require("fs"), path = require("path");
const name = process.argv[2];
fs.appendFileSync(path.join(__dirname, "runs.log"), name + "\\n");
const plan = path.join(__dirname, name);
if (!fs.existsSync(plan)) process.exit(0);
const lines = fs.readFileSync(plan, "utf8").split("\\n").filter(Boolean);
const next = lines.length > 1 ? lines.shift() : lines[0];
fs.writeFileSync(plan, lines.join("\\n") + "\\n");
const [wait, code] = next.includes("ms:") ? next.split("ms:").map(Number) : [0, Number(next)];
setTimeout(() => {
  if (code) { console.log("✖ " + name + " breaks (2ms)"); process.exit(code); }
  console.log("✔ " + name + " works (1ms)");
}, wait);
`);
  return {
    cmd: (name: string) => `"${process.execPath}" "${script}" ${name}`,
    plan: (name: string, outcomes: (number | string)[]) => writeFileSync(join(dir, name), outcomes.join("\n") + "\n"),
    runs: () => (existsSync(join(dir, "runs.log")) ? readFileSync(join(dir, "runs.log"), "utf8").trim().split("\n") : []),
  };
}

/**
 * The workers' processes as on a busy machine, where a new process's Windows job host takes longer to start than the
 * cleanup limit (15 s, worker-process.ts): a cleanup asked of a process before its first turn fails as it would there,
 * "worker cleanup timed out" (queue CI8). Later cleanups work as usual.
 */
const slowHosts = () => gatedCleanup({ failBeforeTurn: "worker cleanup timed out" }).spawn;

function setup(steps: StepDef[], o: { resolve?: boolean; checks?: boolean; jobs?: boolean; slowHosts?: boolean } = {}) {
  const base = mkdtempSync(join(TMP, "nexus-free-"));
  const temp = join(base, "temp");
  mkdirSync(temp);
  process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp;
  const root = join(base, "project");
  mkdirSync(root);
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  const git = (cwd: string, ...a: string[]) => execFileSync("git", [...G, ...a], { cwd, encoding: "utf8" }).trim();
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "init");
  const s = standIns();
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  updateSettings(store, { defaults: { worktree_setup: s.cmd("setup"), ...(o.resolve ? { resolve_conflicts: true } : {}) } });
  store.writeQueue({
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", worktree: "auto", stop_conditions: [],
    checks: o.checks === false ? [] : [s.cmd("unit")], steps,
  });
  approveQueue(store, "Q");
  // The fake reviewer stands in for the user, but leaves the integration step Nexus ran without a model to Nexus.
  const free = () => new Set(loadProjectState(store).queues.flatMap((q) => q.steps.filter((x) => x.model_free).map((x) => `${q.id}/${x.id}`)));
  // The server (an engine and its capacity coordinator); `restart` is the next server on the same files. With Job
  // Objects where a test ends a check mid-run (else its child keeps running).
  const server = () => {
    const cap = new Capacity({ testLock: join(mkdtempSync(join(TMP, "nexus-free-lock-")), "full-test.lock"), pollMs: 20, jobs: !!o.jobs });
    const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store, free()); engine.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100, ...QUICK_ENGINE, checkDrainWaitMs: 300, capacity: cap, ...(o.slowHosts ? { spawn: slowHosts() } : {}) });
    return { engine, cap };
  };
  let now = server();
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n") : [])
    .map((l) => JSON.parse(l) as { text: string; session: string | null });
  const openings = () => received().filter((r) => /(^|\n)\[Nexus\] Queue Q /.test(r.text)).map((r) => ({ ...r, step: /step (\S+) \(\d+ of \d+\)/.exec(r.text)![1]! }));
  const until = (what: string, pred: () => boolean, ms: number = LONGER.run) =>
    waitUntil(what, pred, ms, () => `; run ${JSON.stringify(queue().run)}; ${queue().steps.map((x) => `${x.id}=${x.status}`).join(" ")}; ${queue().status_reason ?? ""}`);
  const wt = () => store.readQueue("Q").worktree!;
  const onMain = (file: string, text: string) => { writeFileSync(join(root, file), text); git(root, "add", file); git(root, "commit", "-qm", `main: ${file}`); return git(root, "rev-parse", "HEAD"); };
  const integ = () => queue().steps.find((x) => x.id === "Q.integrate")!;
  const stop = () => { now.engine.shutdown(); now.cap.shutdown(); };
  const restart = () => { stop(); now = server(); };
  /**
   * What a server stopping between the integration step's start and its done leaves: the `nexus` session's step.done
   * (and what came after it) not written, the round not ended.
   */
  const crashBeforeDone = () => {
    const file = join(store.sessionDir(NEXUS_SESSION), "events.jsonl");
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const at = lines.findIndex((l) => l.includes('"type":"step.done"') && l.includes('"step":"Q.integrate"'));
    assert.ok(at >= 0, "the step.done is there to take away");
    writeFileSync(file, lines.slice(0, at).map((l) => `${l}\n`).join(""));
    wrote(file); // a write outside the store, told to whoever keeps the files in memory (a model: model-reads.ts)
    const g = store.readGit("Q")!;
    const round = g.steps["Q.integrate"]!.at(-1)!;
    round.end = undefined; round.ended_at = undefined;
    store.writeGit("Q", g);
    return round.start!;
  };
  return {
    root, store, git, get engine() { return now.engine; }, queue, received, openings, until, wt, onMain, integ, stop, restart, crashBeforeDone, ...s,
  };
}

test("a clean merge with green checks: the integration step is done and accepted by Nexus without a model, and the queue has its report", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "commit"), step("Q2", "slow")]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    const main = x.onMain("main.txt", "from main\n");
    hold.release();
    await x.until("the run finished", () => x.queue().run?.state === "finished");
    const q = x.queue();
    assert.deepEqual(q.steps.map((s) => `${s.id}=${s.status}`), ["Q1=done", "Q2=done", "Q.integrate=done"]);
    assert.deepEqual(x.openings().map((o) => o.step), ["Q1", "Q2"], "no worker opened the integration step");
    const st = x.integ();
    assert.equal(st.model_free, true);
    assert.equal(st.session, NEXUS_SESSION);
    assert.match(st.summary!, /^Nexus merged main \(\w{12}\) into nexus\/Q without a model: 1 commit, 1 file changed/);
    const head = x.git(x.wt(), "rev-parse", "HEAD");
    assert.equal(st.commit, head);
    x.git(x.wt(), "merge-base", "--is-ancestor", main, head); // throws when main is not in the branch
    const accepted = st.timeline.find((e) => e.type === "review.accepted");
    assert.equal(accepted?.session, NEXUS_SESSION, "Nexus accepted it");
    assert.equal(x.store.readChecks("Q")?.steps["Q.integrate"]?.sets[0]?.state, "passed");
    assert.ok(q.report, "the last step before the integration step wrote the report");
    assert.equal(x.store.readGit("Q")?.steps["Q.integrate"]?.[0]?.session, NEXUS_SESSION, "the round is the nexus session's");
    assert.equal(x.git(x.root, "rev-parse", "main"), main, "main stays where it was");
  } finally { hold.done(); x.stop(); }
});

test("a conflict the project lets a worker resolve: the worker opens the integration step, told what Nexus found", async () => {
  const hold = holdWork();
  // The integration step runs on another model: its process is new, and its job host may still be starting (CI8).
  const x = setup([step("Q1", "commit"), step("Q2", "slow")], { resolve: true, slowHosts: true });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 done", () => x.queue().steps[0]!.status === "done");
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    x.onMain("Q1.txt", "main's own Q1\n"); // the file the queue's Q1 committed: a conflict
    hold.release();
    // One wait for each stretch of the run, not one for all of it: each takes a few processes, and a busy machine
    // stretches them all (queue CI8).
    await x.until("Q2 done", () => x.queue().steps[1]!.status === "done");
    await x.until("a worker at the integration step", () => x.openings().some((o) => o.step === "Q.integrate"));
    await x.until("the run finished", () => x.queue().run?.state === "finished");
    const opening = x.openings().find((o) => o.step === "Q.integrate");
    assert.ok(opening, "a worker opened the integration step");
    assert.match(opening.text, /Nexus tried the merge first: Q1\.txt conflicts\./);
    assert.equal(x.integ().status, "done");
    assert.ok(!x.integ().model_free);
  } finally { hold.done(); x.stop(); }
});

test("a conflict the project does not let a worker resolve: Nexus stops the queue itself, without a worker", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "commit"), step("Q2", "slow")]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    x.onMain("Q1.txt", "main's own Q1\n");
    hold.release();
    await x.until("the queue stopped", () => x.queue().status === "stopped");
    assert.equal(x.queue().stop?.condition, INTEGRATION_CONDITION);
    assert.match(x.queue().stop!.reason, /^Q1\.txt: Nexus does not resolve conflicts/);
    assert.ok(!x.openings().some((o) => o.step === "Q.integrate"), "no worker opened it");
    assert.equal(x.git(x.wt(), "status", "--porcelain", "--untracked-files=no"), "", "the branch is as it was");
  } finally { hold.done(); x.stop(); }
});

test("a check failing after the merge: the worker takes up the integration step as a check-fix round", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow")]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
    x.onMain("main.txt", "from main\n");
    x.plan("unit", [0, 1, 1, 0]); // Q1's set passes; the integration's fails twice; the fix round's passes
    hold.release();
    // One wait for each stretch of the run, not one for all of it: each takes a few processes, and a busy machine
    // stretches them all (queue CI8).
    const sets = () => x.store.readChecks("Q")?.steps["Q.integrate"]?.sets ?? [];
    await x.until("Q1 done", () => x.queue().steps[0]!.status === "done");
    await x.until("the integration's checks failed", () => sets()[0]?.state === "failed");
    await x.until("the fix round's checks", () => sets().length === 2);
    await x.until("the run finished", () => x.queue().run?.state === "finished");
    const fix = x.received().find((m) => m.text.startsWith("[Nexus] The checks Nexus ran for step Q.integrate"));
    assert.ok(fix, "the worker got the check-fix round");
    assert.match(fix.text, /This is queue Q's integration step \(Q\.integrate\), kept by Nexus\. Nexus merged main \(\w{12}\) into the queue's branch nexus\/Q in this worktree without a model/);
    const st = x.integ();
    assert.equal(st.status, "done");
    assert.ok(!st.model_free, "a worker took it up");
    assert.notEqual(st.session, NEXUS_SESSION);
  } finally { hold.done(); x.stop(); }
});

test("a merge that changes the lockfile runs the worktree setup before the checks", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow")]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
    x.onMain("package-lock.json", "{ \"lockfileVersion\": 3 }\n");
    hold.release();
    await x.until("the run finished", () => x.queue().run?.state === "finished");
    const set = x.store.readChecks("Q")?.steps["Q.integrate"]?.sets[0];
    assert.equal(set?.setup?.ok, true);
    assert.match(set!.setup!.reason, /package-lock\.json changed/);
    // The first setup, Q1's checks, then the integration's: the setup before its check.
    assert.deepEqual(x.runs(), ["setup", "unit", "setup", "unit"]);
    assert.equal(x.store.readGit("Q")?.setup?.sha, x.git(x.wt(), "rev-parse", "HEAD"), "the setup's commit is the merge's");
  } finally { hold.done(); x.stop(); }
});

test("at a step boundary a base that merges cleanly is merged into the branch, one that conflicts is not", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow"), step("Q2", "slow"), step("Q3", "slow")]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
    const clean = x.onMain("main.txt", "from main\n");
    hold.release("Q1");
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    // Q2 opened on a branch that has main's commit.
    const q2 = x.openings().find((o) => o.step === "Q2")!.text;
    assert.match(q2, /Before this step Nexus merged main \(\w{12}\) into this branch: 1 commit, changing main\.txt\./);
    x.git(x.wt(), "merge-base", "--is-ancestor", clean, "HEAD");
    // A conflicting base: Q2 changes main.txt in the worktree, main changes it too.
    writeFileSync(join(x.wt(), "main.txt"), "the queue's\n"); x.git(x.wt(), "commit", "-qam", "Q2: main.txt");
    const conflicting = x.onMain("main.txt", "main's again\n");
    hold.release("Q2");
    await x.until("Q3 at work", () => x.queue().steps[2]!.status === "running");
    const q3 = x.openings().find((o) => o.step === "Q3")!.text;
    assert.match(q3, /main \(\w{12}\) conflicts with this branch in main\.txt; Nexus did not merge it/);
    assert.throws(() => x.git(x.wt(), "merge-base", "--is-ancestor", conflicting, "HEAD"), "the conflicting commit is not in the branch");
    const pulls = x.store.readGit("Q")!.pulls!;
    assert.deepEqual(pulls.map((p) => [p.before, p.sha, !!p.to, p.conflicts ?? []]), [["Q2", clean, true, []], ["Q3", conflicting, false, ["main.txt"]]]);
    assert.equal(x.git(x.wt(), "status", "--porcelain", "--untracked-files=no"), "", "nothing left half merged");
  } finally { hold.release(); hold.done(); x.stop(); }
});

test("nexus status names a base Nexus did not merge at a step boundary because it conflicts", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow"), step("Q2", "slow")]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
    // Q1's work and main's change the same file: the merge before Q2 conflicts.
    writeFileSync(join(x.wt(), "Q1.txt"), "the queue's Q1\n"); x.git(x.wt(), "add", "Q1.txt"); x.git(x.wt(), "commit", "-qm", "Q1");
    const main = x.onMain("Q1.txt", "main's own Q1\n");
    hold.release("Q1");
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    const line = `  base: main (${main.slice(0, 12)}) conflicts with the queue's branch in Q1.txt (found before step Q2, `;
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: x.store.dir };
    delete env.NEXUS_SESSION;
    const cli = join(here, "../../../packages/cli/bin/nexus.js");
    const out = execFileSync(process.execPath, [cli, "status"], { env, encoding: "utf8" });
    assert.ok(out.includes(line), out);
    assert.ok(out.includes("Nexus did not merge it, the integration step will"), out);
    assert.ok(orchestratorOverview(loadProjectState(x.store)).includes(line), "the orchestrator's overview too");
  } finally { hold.release(); hold.done(); x.stop(); }
});

test("a server that stopped in the middle of the merge: the half-done merge is aborted and the step runs again from its start", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow")]);
  // At level 1 the step waits for the user after its checks: a still point at which the server is stopped.
  setStepLevel(x.store, "Q", "Q.integrate", 1);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
    const main = x.onMain("main.txt", "from main\n");
    hold.release();
    await x.until("the integration step's review", () => x.integ().status === "review");
    x.stop();
    // The server stopped right after the step's start, in the middle of its merge.
    const start = x.crashBeforeDone();
    x.git(x.wt(), "reset", "-q", "--hard", start);
    x.git(x.wt(), "merge", "--no-commit", "--no-ff", "main");
    const mergeHead = () => existsSync(join(x.git(x.wt(), "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"));
    assert.ok(mergeHead(), "a merge under way");
    x.restart();
    assert.equal(x.queue().run?.state, "paused", "a restart brings the run back paused");
    assert.equal(x.integ().status, "running");
    x.engine.resume("Q");
    const started = () => x.integ().timeline.filter((e) => e.type === "step.started" && e.session === NEXUS_SESSION).length;
    await x.until("the step run again to its review", () => started() === 2 && x.integ().status === "review");
    assert.ok(!mergeHead(), "the half-done merge was aborted");
    const st = x.integ();
    assert.equal(st.model_free, true);
    assert.match(st.summary!, /^Nexus merged main \(\w{12}\) into nexus\/Q without a model: 1 commit/);
    assert.ok(!x.openings().some((o) => o.step === "Q.integrate"), "no worker opened it");
    assert.equal(st.commit, x.git(x.wt(), "rev-parse", "HEAD"));
    x.git(x.wt(), "merge-base", "--is-ancestor", main, "HEAD");
  } finally { hold.done(); x.stop(); }
});

test("a server that stopped in the middle of the merge at a step boundary: the next server aborts it, keeps the user's own files, and opens the next step on a clean merge (queue LF, F4)", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow"), step("Q2", "slow")]);
  // At level 1 Q1 waits for the user's review: a still point before the boundary at which the server is stopped.
  setStepLevel(x.store, "Q", "Q1", 1);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
    const main = x.onMain("main.txt", "from main\n");
    hold.release("Q1");
    await x.until("Q1 in review", () => x.queue().steps[0]!.status === "review");
    x.stop();
    // What a server ending in the middle of the boundary's merge leaves: its intent recorded, the merge under way.
    const from = x.git(x.wt(), "rev-parse", "HEAD");
    x.store.writeGit("Q", { ...x.store.readGit("Q")!, pulling: { at: new Date().toISOString(), before: "Q2", base: "main", sha: main, from } });
    x.git(x.wt(), "merge", "--no-commit", "--no-ff", main);
    const mergeHead = () => existsSync(join(x.git(x.wt(), "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"));
    assert.ok(mergeHead(), "a merge under way");
    writeFileSync(join(x.wt(), "notes.txt"), "the user's own notes\n"); // the user's, untracked
    x.restart();
    x.engine.resume("Q");
    setStepLevel(x.store, "Q", "Q1", 2); // the review is the fake reviewer's now
    acceptReviews(x.store);
    x.engine.onChange(loadProjectState(x.store));
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    const opened = x.openings().find((o) => o.step === "Q2")!.text;
    assert.ok(!mergeHead(), "the half-done merge was aborted before Q2 opened");
    assert.equal(x.git(x.wt(), "status", "--porcelain", "--untracked-files=no"), "", "Q2 opened on a clean worktree");
    assert.equal(readFileSync(join(x.wt(), "notes.txt"), "utf8"), "the user's own notes\n", "the user's file kept");
    x.git(x.wt(), "merge-base", "--is-ancestor", main, "HEAD"); // merged again, cleanly
    assert.match(opened, /Before this step Nexus merged main \(\w{12}\) into this branch: 1 commit/);
    const g = x.store.readGit("Q")!;
    assert.equal(g.pulling, undefined, "the intent is gone");
    assert.deepEqual(g.pulls!.map((p) => [p.before, p.sha, !!p.to]), [["Q2", main, true]]);
  } finally { hold.release(); hold.done(); x.stop(); }
});

test("a merge at a step boundary Nexus did not start (no intent recorded) is left alone: the next step does not open on it", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow"), step("Q2", "slow")]);
  setStepLevel(x.store, "Q", "Q1", 1);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
    const main = x.onMain("main.txt", "from main\n");
    hold.release("Q1");
    await x.until("Q1 in review", () => x.queue().steps[0]!.status === "review");
    x.git(x.wt(), "merge", "--no-commit", "--no-ff", main); // the user's own merge, under way
    setStepLevel(x.store, "Q", "Q1", 2);
    acceptReviews(x.store);
    x.engine.onChange(loadProjectState(x.store));
    await x.until("the run to halt", () => x.queue().run?.state === "halted");
    assert.match(x.queue().run!.reason!, /a merge is under way in .+ that Nexus did not start/);
    assert.ok(existsSync(join(x.git(x.wt(), "rev-parse", "--absolute-git-dir"), "MERGE_HEAD")), "left as it was");
    assert.equal(x.queue().steps[1]!.status, "pending");
  } finally { hold.release(); hold.done(); x.stop(); }
});

test("a server that stopped after the merge commit, before the step's done: the step runs again and finds nothing to merge", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow")]);
  setStepLevel(x.store, "Q", "Q.integrate", 1);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
    x.onMain("main.txt", "from main\n");
    hold.release();
    await x.until("the integration step's review", () => x.integ().status === "review");
    x.stop();
    x.crashBeforeDone();
    const merged = x.git(x.wt(), "rev-parse", "HEAD");
    x.restart();
    x.engine.resume("Q");
    const started = () => x.integ().timeline.filter((e) => e.type === "step.started" && e.session === NEXUS_SESSION).length;
    await x.until("the step run again to its review", () => started() === 2 && x.integ().status === "review");
    const st = x.integ();
    assert.equal(st.model_free, true);
    assert.match(st.summary!, /^nexus\/Q already contains main \(\w{12}\): nothing to merge\.$/);
    assert.equal(st.commit, merged, "the merge commit made before the stop");
    assert.equal(x.git(x.wt(), "rev-parse", "HEAD"), merged, "no second merge");
  } finally { hold.done(); x.stop(); }
});

test("an update's drain waits for the setup that runs before the checks, and for the setup after a merge at a step boundary", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow"), step("Q2", "slow")], { jobs: true });
  // The first setup; the one after the merge before Q2 (slow); the one before the integration's checks (very slow:
  // the drain ends it); the same again after the restart.
  x.plan("setup", [0, "1500ms:0", "60000ms:0", 0]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
    x.onMain("package-lock.json", "{ \"lockfileVersion\": 3 }\n");
    hold.release("Q1");
    // The merge before Q2 changed the lockfile: the setup runs before Q2 opens.
    await x.until("the setup after the merge", () => x.runs().filter((r) => r === "setup").length === 2);
    x.engine.drainForUpdate(false);
    assert.equal(x.engine.idle(), false, "the drain waits for the running setup");
    await x.until("the setup to end", () => x.engine.idle(), LONGER.step);
    assert.ok(x.store.readGit("Q")?.setup?.done_at, "it ended as a success, not cut off");
    assert.equal(x.queue().steps[1]!.status, "pending", "the held run opened nothing");
    x.restart(); // the successor resumes the held run
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    x.onMain("package-lock.json", "{ \"lockfileVersion\": 4 }\n");
    hold.release("Q2");
    // The integration's merge changes the lockfile again: the setup runs first in the check set.
    await x.until("the setup before the integration's checks", () => x.store.readChecks("Q")?.steps["Q.integrate"]?.sets[0]?.setup?.runs[0]?.started_at !== undefined && x.runs().filter((r) => r === "setup").length === 3);
    x.engine.drainForUpdate(false);
    assert.equal(x.engine.idle(), false, "the drain waits for the setup in the check set");
    await x.until("the drain to end it", () => x.engine.idle() && x.store.readChecks("Q")?.steps["Q.integrate"]?.sets[0]?.state === "interrupted", LONGER.step);
    x.restart();
    await x.until("the run finished", () => x.queue().run?.state === "finished");
    assert.equal(x.integ().status, "done");
    assert.equal(x.runs().filter((r) => r === "setup").length, 4, "the setup ran again after the restart");
  } finally { hold.release(); hold.done(); x.stop(); }
});

// ---------------------------------------------------------------- a check running when the server stops (queue EF, EF4)

/**
 * Q1 done and its check passed, the integration step merged without a model and its check's first run still running
 * (60 s): `unit` has run twice. The capacity coordinator's file is where the machine's slot is held.
 */
async function integrationCheckRunning(x: ReturnType<typeof setup>, hold: ReturnType<typeof holdWork>) {
  x.engine.start("Q", { runtime: "claude" });
  await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
  x.onMain("main.txt", "from main\n");
  x.plan("unit", [0, "60000ms:0", 0]);
  hold.release();
  await x.until("the integration step's check to run", () => checkSets(x)[0]?.state === "running" && units(x) === 2);
}
const checkSets = (x: ReturnType<typeof setup>) => x.store.readChecks("Q")?.steps["Q.integrate"]?.sets ?? [];
const units = (x: ReturnType<typeof setup>) => x.runs().filter((r) => r === "unit").length;
/** The machine's slot is free: nothing held or waiting in the coordinator's file. */
const slotFree = () => { const c = readCapacity(); return !c || (!c.held.length && !c.waiting.length); };

test("a server that stopped while the integration step's check ran: interrupted, run again at Resume (not before), the slot free after (EC1 P9)", async () => {
  const hold = holdWork();
  // With Job Objects, as on the user's machine: ending the server ends the check's whole tree.
  const x = setup([step("Q1", "slow")], { jobs: true });
  try {
    await integrationCheckRunning(x, hold);
    assert.ok(!slotFree(), "the check holds the slot");
    x.restart();
    assert.equal(checkSets(x)[0]!.state, "interrupted", "what the old server ran is interrupted, not failed");
    assert.equal(x.queue().run?.state, "paused", "a plain restart brings the run back paused");
    assert.equal(x.integ().status, "checking");
    assert.ok(slotFree(), "the new server's coordinator holds nothing for the old server's check");
    // P9: after a plain restart the check runs again when the run goes on, not by itself.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(units(x), 2, "not run again before Resume");
    x.engine.resume("Q");
    await x.until("the check run again and the step in its review", () => units(x) === 3 && ["review", "done"].includes(x.integ().status));
    assert.deepEqual(checkSets(x).map((s) => s.state), ["passed"], "the same set, run again from its start");
    await x.until("the slot free", slotFree);
  } finally { hold.done(); x.stop(); }
});

test("a server that stopped while the integration step's check ran, its done and merge not recorded: the merge is aborted, the step and its check run again at Resume", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow")], { jobs: true });
  try {
    await integrationCheckRunning(x, hold);
    x.stop();
    // As if the server had stopped earlier still, in the middle of its merge (the M11 case, with a check running).
    const start = x.crashBeforeDone();
    x.git(x.wt(), "reset", "-q", "--hard", start);
    x.git(x.wt(), "merge", "--no-commit", "--no-ff", "main");
    x.restart();
    assert.equal(x.integ().status, "running");
    x.engine.resume("Q");
    const started = () => x.integ().timeline.filter((e) => e.type === "step.started" && e.session === NEXUS_SESSION).length;
    await x.until("the step run again, and its check", () => started() === 2 && units(x) === 3 && ["review", "done"].includes(x.integ().status));
    assert.deepEqual(checkSets(x).map((s) => s.state), ["interrupted", "passed"], "the old done's set stays interrupted; the new done's passed");
    await x.until("the slot free", slotFree);
  } finally { hold.done(); x.stop(); }
});

test("an update while the integration step's check ran: the drain ends it, and the next server runs it again at once (EC1 P9)", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow")], { jobs: true });
  try {
    await integrationCheckRunning(x, hold);
    x.engine.drainForUpdate(false);
    await x.until("the drain to end the check", () => x.engine.idle() && checkSets(x)[0]!.state === "interrupted");
    assert.equal(x.queue().run?.resume_after_restart, true);
    x.restart(); // the successor resumes the held run by itself
    await x.until("the check run again and the step in its review", () => units(x) === 3 && ["review", "done"].includes(x.integ().status));
    assert.deepEqual(checkSets(x).map((s) => s.state), ["passed"]);
    await x.until("the slot free", slotFree);
  } finally { hold.done(); x.stop(); }
});
