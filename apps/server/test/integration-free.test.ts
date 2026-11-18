// The integration step without a model (queue MI; PROTOCOL.md, "The integration step", "Without a model"), against the
// fake runtimes, temporary git repositories and stand-in checks that Nexus runs itself (the engine has a capacity
// coordinator). A clean merge with green checks is done and accepted by Nexus without the worker's opening it; a
// conflict the project lets a worker resolve opens the step for the worker, one it does not stops the queue without a
// worker; a failing check gives the worker the step as a check-fix round; a merge that changes a lockfile runs the
// worktree setup before the checks; at a step boundary a base that merges cleanly is merged into the queue's branch, one
// that conflicts is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTEGRATION_CONDITION, NEXUS_SESSION, ProjectStore, approveQueue, loadProjectState, routeAnswers, updateSettings, type StepDef } from "@nexus/protocol";
import { Capacity } from "../src/capacity.ts";
import { Engine } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { LONGER, holdWork, until as waitUntil } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

const step = (id: string, behaviour: string): StepDef => ({ id, title: `Step ${id}`, goal: `FAKE: ${behaviour}`, acceptance: [] });
/** The system's temporary folder as it was: each test points TEMP at a folder of its own, which must not nest. */
const TMP = tmpdir();
const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

/**
 * Stand-in checks (and setup): `node check.cjs <name>` logs its name and exits with the next planned code of <name>
 * (`plan`; the last one stays; none planned: 0).
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
const code = Number(next);
if (code) { console.log("✖ " + name + " breaks (2ms)"); process.exit(code); }
console.log("✔ " + name + " works (1ms)");
`);
  return {
    cmd: (name: string) => `"${process.execPath}" "${script}" ${name}`,
    plan: (name: string, outcomes: number[]) => writeFileSync(join(dir, name), outcomes.join("\n") + "\n"),
    runs: () => (existsSync(join(dir, "runs.log")) ? readFileSync(join(dir, "runs.log"), "utf8").trim().split("\n") : []),
  };
}

function setup(steps: StepDef[], o: { resolve?: boolean; checks?: boolean } = {}) {
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
  const cap = new Capacity({ testLock: join(mkdtempSync(join(TMP, "nexus-free-lock-")), "full-test.lock"), pollMs: 20, jobs: false });
  // The fake reviewer stands in for the user, but leaves the integration step Nexus ran without a model to Nexus.
  const free = () => new Set(loadProjectState(store).queues.flatMap((q) => q.steps.filter((x) => x.model_free).map((x) => `${q.id}/${x.id}`)));
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store, free()); engine.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100, capacity: cap });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n") : [])
    .map((l) => JSON.parse(l) as { text: string; session: string | null });
  const openings = () => received().filter((r) => /(^|\n)\[Nexus\] Queue Q /.test(r.text)).map((r) => ({ ...r, step: /step (\S+) \(\d+ of \d+\)/.exec(r.text)![1]! }));
  const until = (what: string, pred: () => boolean, ms: number = LONGER.run) =>
    waitUntil(what, pred, ms, () => `; run ${JSON.stringify(queue().run)}; ${queue().steps.map((x) => `${x.id}=${x.status}`).join(" ")}; ${queue().status_reason ?? ""}`);
  const wt = () => store.readQueue("Q").worktree!;
  const onMain = (file: string, text: string) => { writeFileSync(join(root, file), text); git(root, "add", file); git(root, "commit", "-qm", `main: ${file}`); return git(root, "rev-parse", "HEAD"); };
  const integ = () => queue().steps.find((x) => x.id === "Q.integrate")!;
  const stop = () => { engine.shutdown(); cap.shutdown(); };
  return { root, store, git, engine, queue, received, openings, until, wt, onMain, integ, stop, ...s };
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
  const x = setup([step("Q1", "commit"), step("Q2", "slow")], { resolve: true });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q2 at work", () => x.queue().steps[1]!.status === "running");
    x.onMain("Q1.txt", "main's own Q1\n"); // the file the queue's Q1 committed: a conflict
    hold.release();
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
