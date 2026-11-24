// Nexus runs the queue's checks (src/check-runs.ts; queue EC, EC3): after the worker's `nexus step done` the engine
// runs them through the capacity coordinator, writes checks.yaml and a log per run, runs a failing check once more
// (flaky when it passes then), gives the worker a check-fix round with what failed, halts the run for the orchestrator
// after the limit, runs the checks again after a restart or an update's drain, and judges a disputed failure on the
// queue's base commit. Against the fake runtimes; the checks are a small Node script whose outcomes each test plans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, onWrite, readCapacity, routeAnswers, updateSettings, type ChecksFile } from "@nexus/protocol";
import { Orchestrator } from "../src/orchestrator.ts";
import { Capacity } from "../src/capacity.ts";
import { failedTests } from "../src/check-runs.ts";
import { Engine, type EngineOptions } from "../src/engine.ts";
import { FAST, restart, setup } from "./engine-setup.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { LONGER, until as waitUntil } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

process.env.NEXUS_HOME ??= mkdtempSync(join(tmpdir(), "nexus-checks-home-"));
const lockFile = () => join(mkdtempSync(join(tmpdir(), "nexus-checks-lock-")), "full-test.lock");
/** Without Job Objects (a second or two a process on Windows): these tests are about the engine, not the tree. */
const capacity = (jobs = false) => new Capacity({ testLock: lockFile(), pollMs: 20, jobs });

/**
 * The stand-in checks: `node check.cjs <name>` exits with the next planned code of <name> (the last one stays), after
 * an optional wait ("<ms>ms:<code>"), printing a passing or failing test as node:test's spec reporter does. Run outside
 * the project's checkout (the base worktree), it takes the plan <name>.base; without one there it cannot run ("Missing
 * script"). The test it prints is named after <name>, or the second argument. Each run is logged, once its plan is written.
 */
function standIns(root: string) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-checks-"));
  const script = join(dir, "check.cjs");
  writeFileSync(join(dir, "main-cwd"), root.replaceAll("\\", "/").toLowerCase());
  writeFileSync(script, `const fs = require("fs"), path = require("path");
const dir = __dirname, name = process.argv[2], shown = process.argv[3] || name;
const main = fs.readFileSync(path.join(dir, "main-cwd"), "utf8").trim();
const base = process.cwd().replaceAll("\\\\", "/").toLowerCase() !== main;
const plan = path.join(dir, name + (base ? ".base" : ""));
const log = () => fs.appendFileSync(path.join(dir, "runs.log"), name + (base ? "@base" : "") + "\\n");
if (!fs.existsSync(plan)) { log(); if (base) { console.error("npm error Missing script: " + name); process.exit(1); } process.exit(0); }
const lines = fs.readFileSync(plan, "utf8").split("\\n").filter(Boolean);
const next = lines.length > 1 ? lines.shift() : lines[0];
fs.writeFileSync(plan, lines.join("\\n") + "\\n");
// Logged once the plan is written: a test that ends the check as soon as it sees the run (a restart) cannot end it
// between the plan's truncation and its write, which left the plan empty and every later run failing (queue CK2).
log();
const [wait, code] = next.includes("ms:") ? next.split("ms:").map(Number) : [0, Number(next)];
setTimeout(() => {
  if (code === 0) { console.log("✔ " + shown + " works (1ms)"); process.exit(0); }
  console.log("✖ " + shown + " breaks (2ms)"); console.error("boom: " + shown); process.exit(code);
}, wait);
`);
  return {
    cmd: (name: string, test?: string) => `"${process.execPath}" "${script}" ${name}${test ? ` ${test}` : ""}`,
    plan: (name: string, outcomes: (number | string)[], base = false) => writeFileSync(join(dir, name + (base ? ".base" : "")), outcomes.join("\n") + "\n"),
    runs: () => (existsSync(join(dir, "runs.log")) ? readFileSync(join(dir, "runs.log"), "utf8").trim().split("\n") : []),
  };
}

type Setup = ReturnType<typeof setup>;
/**
 * A project whose queue Q has these checks, run by Nexus (the engine has a capacity coordinator): a stand-in by its
 * name, or a command as it is (a name with a space); `worktree`: the queue's checkout, a folder of its own.
 */
function withChecks(behaviours: string[], names: string[], options: EngineOptions = {}, o: { worktree?: string } = {}) {
  const cap = options.capacity ?? capacity();
  const x = setup(behaviours, { ...FAST, capacity: cap, ...options });
  const s = standIns(x.store.readProject().root);
  const q = x.store.readQueue("Q");
  if (names.length || o.worktree) {
    x.store.writeQueue({ ...q, checks: names.map((n) => (n.includes(" ") ? n : s.cmd(n))), ...(o.worktree ? { worktree: o.worktree } : {}) });
    approveQueue(x.store, "Q");
  }
  const file = () => x.store.readChecks("Q") as ChecksFile;
  const sets = (step = "Q1") => file()?.steps[step]?.sets ?? [];
  return { ...x, ...s, cap, file, sets };
}

const fixMessages = (x: Setup) => x.received().filter((m) => m.text.startsWith("[Nexus] The checks Nexus ran"));

test("green checks: the step goes to its review and on; the worker is told Nexus runs them and reports none", async () => {
  const x = withChecks(["done"], ["lint", "unit"]);
  x.plan("lint", [0]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const [set] = x.sets();
    assert.equal(set!.state, "passed");
    assert.deepEqual(set!.checks.map((c) => [c.name.split(" ").at(-1), c.ok, c.runs.length]), [["lint", true, 1], ["unit", true, 1]]);
    assert.equal(x.file().steps.Q1!.by, "nexus");
    assert.ok(existsSync(join(x.store.queueDir("Q"), set!.checks[0]!.runs[0]!.log)), "each run has its log");
    assert.match(readFileSync(join(x.store.queueDir("Q"), set!.checks[0]!.runs[0]!.log), "utf8"), /✔ lint works/);
    assert.deepEqual(x.runs(), ["lint", "unit"]);
    const opening = x.received().find((m) => m.text.includes("step Q1 ("))!.text;
    assert.match(opening, /Nexus runs these itself after your `nexus step done`/);
    const st = x.queue().steps[0]!;
    assert.equal(st.status, "done");
    assert.deepEqual(st.checks.map((c) => [c.ok, c.by]), [[true, "nexus"], [true, "nexus"]], "the results are the step's checks");
    assert.equal(st.timeline.filter((e) => e.type === "check.result").length, 0, "the worker reported none");
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

test("a check failing once and passing the second time is flaky; the step goes on", async () => {
  const x = withChecks(["done"], ["unit"]);
  x.plan("unit", [1, 0]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const c = x.sets()[0]!.checks[0]!;
    assert.deepEqual([c.ok, c.flaky, c.runs.map((r) => r.exit_code)], [true, true, [1, 0]]);
    assert.equal(fixMessages(x).length, 0, "no fix round");
    assert.match(x.queue().steps[0]!.checks[0]!.summary!, /flaky/);
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

test("a check failing twice goes to the worker with the failing tests, the end of its output and its log; the fix round's done runs them again", async () => {
  const x = withChecks(["done"], ["unit"]);
  x.plan("unit", [1, 1, 0]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const [first, second] = x.sets();
    assert.deepEqual([first!.state, first!.fix, second!.state, second!.fix, second!.round], ["failed", 0, "passed", 1, 1]);
    const [m] = fixMessages(x);
    assert.ok(m, "the worker got a check-fix round");
    assert.match(m!.text, /check-fix round 1 of 3/);
    assert.match(m!.text, /Failing tests:\n- unit breaks/);
    assert.match(m!.text, /The end of its output:\n[\s\S]*boom: unit/);
    const log = /Full log: (.+)/.exec(m!.text)![1]!.trim();
    assert.ok(existsSync(log), `the log's full path: ${log}`);
    const st = x.queue().steps[0]!;
    assert.equal(st.sent_back.length, 0, "a fix round is no send-back");
    assert.equal(st.timeline.filter((e) => e.type === "step.done").length, 2);
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

test("a Windows volume shadow copy made while a check failed is kept with its run and named in the fix round (queue CI4)", async () => {
  const asked: [string, string][] = [];
  const snapshot = { at: "2026-11-20T17:44:20.360Z", seconds: 32.5, by: "taskhostw.exe" };
  const x = withChecks(["done"], ["unit"], { snapshots: async (from, to) => { asked.push([from, to]); return [snapshot]; } });
  x.plan("unit", [1, 1, 0]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const [first, second] = x.sets();
    const failed = first!.checks[0]!.runs;
    assert.deepEqual(failed.map((r) => r.snapshots), [[snapshot], [snapshot]], "each failed run keeps the copies made while it ran");
    assert.deepEqual(asked, failed.map((r) => [r.started_at, r.ended_at]), "looked up for the failed runs' own times only");
    assert.equal(second!.checks[0]!.runs[0]!.snapshots, undefined, "a passing run is not looked up");
    const [m] = fixMessages(x);
    assert.match(m!.text, /Failing tests:\n- unit breaks\nWhile it ran, Windows made a volume shadow copy \(at 2026-11-20T17:44:20\.360Z, 32\.5 s, asked by taskhostw\.exe\)/);
    assert.equal(m!.text.match(/volume shadow copy \(/g)!.length, 1, "the same copy named once");
    assert.match(m!.text, /is the machine's \(docs\/design\/tests\.md, "Volume shadow copies stop the tests"\)/);
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

/** A time limit a stand-in's quick run stays inside on a loaded machine (8 s did not, under the load tool), and a planned wait runs past (queue CK). */
const LIMIT_MS = 25_000;
/** How long such a run may take: the usual wait, and the check's limit twice (a run ended at it, and one more within it). */
const LIMITED_RUN_MS = LONGER.run + 2 * LIMIT_MS;

test("a check that runs into its time limit is not run again: the worker gets a check-fix round naming the limit (queue CK)", async () => {
  const x = withChecks(["done"], ["unit"], { checkLimitMs: LIMIT_MS, capacity: capacity(true) });
  x.plan("unit", ["60000ms:0", 0]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LIMITED_RUN_MS);
    const [first, second] = x.sets();
    const c = first!.checks[0]!;
    assert.deepEqual([first!.state, c.ok, c.flaky, c.runs.length, c.runs[0]!.timed_out, c.runs[0]!.exit_code], ["failed", false, undefined, 1, true, null], "one run, ended at the limit");
    assert.deepEqual(x.runs(), ["unit", "unit"], "not run again in its set; once more after the fix round's done");
    const [m] = fixMessages(x);
    assert.match(m!.text, /Check ".*unit" ended at its time limit and was not run again/);
    assert.match(x.queue().steps[0]!.checks[0]!.summary!, /^ended at its time limit$/);
    assert.equal(second!.state, "passed");
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

test("a check that runs into its time limit while Windows made a shadow copy runs once more: passing, it is a snapshot rerun, not flaky (queue CK)", async () => {
  const snapshot = { at: "2026-11-23T09:12:00.000Z", seconds: 41.2, by: "taskhostw.exe" };
  const x = withChecks(["done"], ["unit"], { checkLimitMs: LIMIT_MS, capacity: capacity(true), snapshots: async () => [snapshot] });
  x.plan("unit", ["60000ms:0", 0]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LIMITED_RUN_MS);
    assert.equal(x.sets().length, 1, "no fix round");
    const [set] = x.sets();
    const c = set!.checks[0]!;
    assert.deepEqual([set!.state, c.ok, c.snapshot_rerun, c.flaky], ["passed", true, true, undefined]);
    assert.deepEqual(c.runs.map((r) => [r.timed_out, r.exit_code]), [[true, null], [undefined, 0]]);
    assert.deepEqual(c.runs[0]!.snapshots, [snapshot], "the copy is kept with the timed-out run");
    assert.equal(fixMessages(x).length, 0);
    assert.equal(x.queue().steps[0]!.checks[0]!.summary, "passed (rerun after a disk snapshot)");
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

/** The run halted for a cause the worker cannot fix (queue CK): its reason, the set interrupted with it, no fix round. */
function haltedUnrunnable(x: ReturnType<typeof withChecks>, reason: RegExp) {
  const run = x.queue().run!;
  assert.equal(run.state, "halted");
  assert.match(run.reason!, /^step Q1: the checks cannot run, for a cause outside the checkout the worker cannot fix: /);
  assert.match(run.reason!, reason);
  const set = x.sets().at(-1)!;
  assert.equal(set.state, "interrupted");
  assert.match(set.unrunnable!, reason);
  assert.equal(fixMessages(x).length, 0, "no check-fix round");
  const st = x.queue().steps[0]!;
  assert.deepEqual([st.status, st.check_fix, st.checking?.unrunnable], ["checking", undefined, set.unrunnable], "the step's checks wait, saying why");
}

test("an empty check list passes without running anything (queue CK)", async () => {
  const x = withChecks(["done"], []);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(x.sets().map((s) => [s.state, s.checks.length]), [["passed", 0]]);
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

test("a checkout gone before the checks run: the run halts with \"no checkout\", no check-fix round (queue CK)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-checks-wt-"));
  const x = withChecks(["done"], ["unit"], { capacity: capacity(true) }, { worktree: dir });
  x.plan("unit", ["60000ms:0", 0]);
  let next: Engine | undefined;
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the check to run", () => x.sets()[0]?.state === "running" && x.runs().length === 1, LONGER.run);
    x.engine.shutdown(); // the server stops; its check ends with it, and the worktree's folder goes meanwhile
    x.cap.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    next = restart(x.store, { ...FAST, capacity: capacity(true) });
    next.resume("Q");
    await x.until("the run to halt", () => x.queue().run?.state === "halted", LONGER.run);
    haltedUnrunnable(x, /no checkout: the queue's checkout .*nexus-checks-wt-.* does not exist/);
    assert.equal(x.runs().length, 1, "nothing ran without the checkout (the one run was the old server's, in the folder then)");
  } finally { x.engine.shutdown(); next?.shutdown(); }
});

test("a check whose program is not on the server's PATH: failed, the run halts with the reason, no check-fix round (queue CK)", async () => {
  const x = withChecks(["done"], ["nexus-no-such-program-ck --all", "unit"]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to halt", () => x.queue().run?.state === "halted", LONGER.run);
    haltedUnrunnable(x, /check "nexus-no-such-program-ck --all": "nexus-no-such-program-ck" is not on the server's PATH/);
    const c = x.sets()[0]!.checks[0]!;
    assert.deepEqual([c.not_command, c.ok, c.runs.length], [true, false, 0]);
    assert.deepEqual(x.runs(), [], "the set stopped there: the checks after it did not run");
    const shown = x.queue().steps[0]!.checks.find((v) => v.name === c.name);
    assert.deepEqual([shown?.ok, shown?.summary], [false, "not on the server's PATH: not run"]);
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

test("a check whose npm script is missing: failed after one run, the run halts with the reason, no check-fix round (queue CK)", async () => {
  const x = withChecks(["done"], ["unit", "npm run nexus-no-such-script"]);
  writeFileSync(join(x.store.readProject().root, "package.json"), JSON.stringify({ name: "ck", private: true, scripts: {} }));
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to halt", () => x.queue().run?.state === "halted", LONGER.run);
    haltedUnrunnable(x, /check "npm run nexus-no-such-script": missing script \(.*Missing script: "?nexus-no-such-script/);
    const c = x.sets()[0]!.checks[1]!;
    assert.deepEqual([c.missing_script, c.ok, c.runs.length], [true, false, 1], "not run again");
    assert.equal(x.queue().steps[0]!.checks.find((v) => v.name === c.name)?.summary, "missing script");
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

test("after the limit of check-fix rounds the run halts for the orchestrator; a Resume gives one more round", async () => {
  const x = withChecks(["done"], ["unit"]);
  updateSettings(x.store, { defaults: { check_fix_limit: 1 } });
  x.plan("unit", [1]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to halt", () => x.queue().run?.state === "halted", LONGER.run);
    assert.match(x.queue().run!.reason!, /the checks failed after 1 check-fix round \(the limit, check_fix_limit 1\)/);
    assert.deepEqual(x.sets().map((s) => [s.state, s.fix, !!s.limit]), [["failed", 0, false], ["failed", 1, true]]);
    assert.equal(fixMessages(x).length, 1, "one round only");
    const st = x.queue().steps[0]!;
    assert.deepEqual([st.status, st.check_fix, st.check_limit], ["running", 2, true]);

    x.plan("unit", [0]);
    x.engine.resume("Q");
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.equal(fixMessages(x).length, 2);
    assert.match(fixMessages(x)[1]!.text, /check-fix round 2 of 1 \(beyond the limit: the orchestrator gave one more\)/);
    assert.equal(x.sets().at(-1)!.state, "passed");
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

test("after a fix round every check runs again: one that passed before and broke meanwhile shows as a failure (P3)", async () => {
  const x = withChecks(["done"], ["lint", "unit"]);
  x.plan("unit", [1, 1, 0]);
  x.plan("lint", [0, 1, 1, 0]);
  try {
    x.engine.start("Q", { runtime: "claude" });
    // One wait for each set and fix round, not one for the run: each takes a few processes, and a busy machine
    // stretches them all (queue CI8).
    await x.until("the first set failed", () => x.sets()[0]?.state === "failed", LONGER.run);
    await x.until("the first fix round's set failed", () => x.sets()[1]?.state === "failed", LONGER.run);
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const sets = x.sets();
    const outcome = (i: number) => sets[i]!.checks.map((c) => `${c.name.split(" ").at(-1)}:${c.ok}:${c.runs.length}`);
    assert.deepEqual(outcome(0), ["lint:true:1", "unit:false:2"], "only the failed check runs again at once");
    assert.deepEqual(outcome(1), ["lint:false:2", "unit:true:1"], "after the fix round: all again, the one that passed before too");
    assert.deepEqual(outcome(2), ["lint:true:1", "unit:true:1"]);
    assert.match(fixMessages(x)[1]!.text, /Check ".*lint" failed twice/);
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

test("a restart while a check runs: the check runs again when the run goes on", async () => {
  // With Job Objects: ending a check ends its whole tree (the stand-in's own process too).
  const x = withChecks(["done"], ["unit"], { capacity: capacity(true) });
  x.plan("unit", ["60000ms:0", 0]);
  let next: Engine | undefined;
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the check to run", () => x.sets()[0]?.state === "running" && x.runs().length === 1, LONGER.run);
    x.engine.shutdown(); // the server stops: its check ends with it
    x.cap.shutdown();
    next = restart(x.store, { ...FAST, capacity: capacity(true) });
    assert.equal(x.sets()[0]!.state, "interrupted", "what the old server ran is interrupted, not failed");
    assert.equal(x.queue().steps[0]!.status, "checking");
    next.resume("Q");
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(x.runs(), ["unit", "unit"], "run again");
    assert.equal(x.sets()[0]!.state, "passed");
  } finally { x.engine.shutdown(); next?.shutdown(); }
});

test("an update's drain waits for a running check a while, then ends it; it runs again after the restart", async () => {
  const x = withChecks(["done"], ["unit"], { checkDrainWaitMs: 300, capacity: capacity(true) });
  x.plan("unit", ["60000ms:0", 0]);
  let next: Engine | undefined;
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the check to run", () => x.sets()[0]?.state === "running" && x.runs().length === 1, LONGER.run);
    x.engine.drainForUpdate(false);
    assert.equal(x.engine.idle(), false, "the drain waits for the running check");
    await x.until("the drain to end the check", () => x.engine.idle() && x.sets()[0]!.state === "interrupted", LONGER.step);
    assert.equal(x.sets()[0]!.checks[0]!.runs[0]!.interrupted, true);
    assert.equal(x.queue().run!.resume_after_restart, true);
    x.engine.shutdown();
    next = restart(x.store, { ...FAST, capacity: capacity(true) }); // the successor resumes the held run
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(x.runs(), ["unit", "unit"]);
  } finally { x.engine.shutdown(); next?.shutdown(); x.cap.shutdown(); }
});

test("two projects' checks run one after the other through the coordinator", async () => {
  const shared = capacity();
  const a = withChecks(["done"], ["unit"], { capacity: shared });
  const b = withChecks(["done"], ["unit"], { capacity: shared });
  a.plan("unit", ["700ms:0"]);
  b.plan("unit", ["700ms:0"]);
  try {
    a.engine.start("Q", { runtime: "claude" });
    b.engine.start("Q", { runtime: "claude" });
    await a.until("both runs to finish", () => a.queue().run?.state === "finished" && b.queue().run?.state === "finished", LONGER.run);
    const [x, y] = [a.sets()[0]!, b.sets()[0]!].sort((p, q) => p.granted_at!.localeCompare(q.granted_at!));
    assert.ok(y!.granted_at! >= x!.ended_at!, `one after the other: ${x!.granted_at}..${x!.ended_at} then ${y!.granted_at}`);
  } finally { a.engine.shutdown(); b.engine.shutdown(); shared.shutdown(); }
});

/**
 * A project in a git repository (the queues work in its checkout, so their base is its first commit), with an
 * orchestrator and queues of one step each, every queue with its own stand-in check (`<queue>-unit`, its test always
 * named "shared"). The worker
 * disputes the first check that fails twice (FAKE_CHECK_DISPUTE).
 */
function withOrchestrator(queues: string[]) {
  const root = mkdtempSync(join(tmpdir(), "nexus-dispute-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_CHECK_DISPUTE = "*";
  process.env.FAKE_REVIEW_ACCEPT = "1"; // the fake orchestrator accepts the steps it reviews
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main"); writeFileSync(join(root, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const s = standIns(root);
  for (const id of queues) {
    applyDraft(store, { id, title: `Queue ${id}`, checks: [s.cmd(`${id}-unit`, "shared")], steps: [{ id: `${id}1`, title: "Step 1", goal: "FAKE: done", acceptance: [] }] });
    approveQueue(store, id);
  }
  let cap: Capacity, engine: Engine, orchestrator: Orchestrator;
  // The server: its capacity, engine and orchestrator; `restart` is the next server on the same files.
  const serve = () => {
    cap = capacity();
    engine = new Engine(store, () => tick(), { spawn: inProcessRuntime(), ...FAST, capacity: cap });
    orchestrator = new Orchestrator(store, engine, () => tick(), {}, { spawn: inProcessRuntime() });
  };
  serve();
  function tick() { routeAnswers(store); acceptReviews(store); const st = loadProjectState(store); orchestrator.onChange(st); engine.onChange(st); }
  const timer = setInterval(tick, 150);
  const queue = (id: string) => loadProjectState(store).queues.find((q) => q.id === id)!;
  const sets = (id: string) => store.readChecks(id)?.steps[`${id}1`]?.sets ?? [];
  const said = (re: RegExp) => orchestrator.view().chat.some((c) => re.test(c.text));
  const until = (what: string, pred: () => boolean, ms = LONGER.run) => waitUntil(what, pred, ms, () => `; ${queues.map((id) => `${id}: ${queue(id).steps[0]!.status} run=${queue(id).run?.state}`).join("; ")}; chat: ${JSON.stringify(orchestrator.view().chat.slice(-3).map((c) => c.text.slice(0, 160)))}`);
  const hello = async () => { orchestrator.say("Hello"); await until("the orchestrator's session", () => !!orchestrator.session(), LONGER.step); };
  const decide = (q: string, verdict: string, reason: string) => orchestrator.say(`FAKE-NEXUS: ${JSON.stringify(["check", "decide", q, `${q}1`, verdict, "--reason", reason])}`);
  const down = () => { engine.shutdown(); orchestrator.shutdown(); cap.shutdown(); };
  const restart = () => { down(); serve(); };
  const stop = () => { clearInterval(timer); down(); delete process.env.FAKE_CHECK_DISPUTE; delete process.env.FAKE_REVIEW_ACCEPT; };
  return { store, get engine() { return engine; }, ...s, queue, sets, said, until, hello, decide, restart, stop };
}

test("a disputed failure that fails on the base too is accepted: the step goes to its review, a fix queue is proposed, the orchestrator is told; the same test again goes to that queue (P6)", async () => {
  const x = withOrchestrator(["Q", "R"]);
  x.plan("Q-unit", [1]); x.plan("Q-unit", [1], true);
  x.plan("R-unit", [1]); x.plan("R-unit", [1], true);
  try {
    await x.hello();
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q to finish", () => x.queue("Q").run?.state === "finished");
    const [set] = x.sets("Q");
    assert.deepEqual([set!.state, set!.dispute?.base?.state, set!.dispute?.outcome, set!.fix_queue], ["accepted", "failed", "accepted", { id: "CI", created: true }]);
    assert.ok(x.runs().includes("Q-unit@base"), "run on the base commit, in a worktree of its own");
    const ci = x.queue("CI");
    assert.deepEqual([ci.status, ci.origin, ci.steps.filter((st) => !st.closing).map((st) => st.tags.kind)], ["proposed", "ci", ["debugging", "code"]]);
    assert.match(ci.description!, /- test: shared breaks/);
    assert.match(ci.description!, /queue Q, step Q1 .*fails on the base commit [0-9a-f]+ too\. Log: .+\.log\. The worker's evidence: it fails on the base too/);
    await x.until("the orchestrator to be told", () => x.said(/failure is accepted: it fails on the queue's base commit/) && x.said(/Nexus proposed queue CI/));

    // The same failing test in another queue: no second queue, the occurrence goes to CI.
    x.engine.start("R", { runtime: "claude" });
    await x.until("R to finish", () => x.queue("R").run?.state === "finished");
    assert.deepEqual([x.sets("R")[0]!.state, x.sets("R")[0]!.fix_queue], ["accepted", { id: "CI", created: false }]);
    assert.equal(loadProjectState(x.store).queues.filter((q) => q.origin === "ci").length, 1, "no second fix queue");
    assert.match(x.queue("CI").description!, /queue Q, step Q1[\s\S]*queue R, step R1/);
    await x.until("the orchestrator to be told of R too", () => x.said(/added this occurrence to queue CI/));
  } finally { x.stop(); }
});

test("an older queue's check in words is not a command: not run, failed, the run halts with the reason, no check-fix round, no fix queue, and the orchestrator is told to convert it (queue EF, CK)", async () => {
  const x = withOrchestrator(["Q"]);
  // Approved before the rule: written into the queue directly, as the draft path now refuses it.
  const q = x.store.readQueue("Q");
  x.store.writeQueue({ ...q, checks: [...q.checks, "Az összes teszt zöld"] });
  approveQueue(x.store, "Q");
  x.plan("Q-unit", [0]);
  try {
    await x.hello();
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q to halt", () => x.queue("Q").run?.state === "halted");
    assert.match(x.queue("Q").run!.reason!, /^step Q1: the checks cannot run, for a cause outside the checkout the worker cannot fix: check "Az összes teszt zöld": "Az" is not on the server's PATH/);
    const [set, more] = x.sets("Q");
    assert.equal(more, undefined, "one set: no check-fix round");
    assert.deepEqual([set!.state, set!.unrunnable !== undefined], ["interrupted", true]);
    assert.deepEqual(set!.checks.map((c) => [c.name.split(" ").at(-1), c.ok, c.not_command, c.runs.length]), [["shared", true, undefined, 1], ["zöld", false, true, 0]]);
    assert.deepEqual(x.runs(), ["Q-unit"], "the check in words was not run");
    const state = loadProjectState(x.store);
    assert.equal(state.sessions.flatMap((s) => s.inbox).filter((m) => m.type === "check_failed").length, 0, "no check-fix round");
    assert.equal(state.queues.filter((x) => x.origin === "ci").length, 0, "no fix queue");
    const shown = x.queue("Q").steps[0]!.checks.find((c) => c.name === "Az összes teszt zöld");
    assert.deepEqual([shown?.ok, shown?.not_command], [false, true]);
    assert.equal(x.queue("Q").steps[0]!.checking?.unrunnable, set!.unrunnable, "the step says why its checks wait");
    await x.until("the orchestrator to be told", () => x.said(/The check "Az összes teszt zöld" of queue Q is not a command .*Nexus did not run it at step Q1/));
  } finally { x.stop(); }
});

test("a disputed failure that passes on the base is the queue's: a check-fix round, without a decision (P6)", async () => {
  const x = withOrchestrator(["Q"]);
  x.plan("Q-unit", [1, 1, 0]); x.plan("Q-unit", [0], true);
  try {
    await x.hello();
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q to finish", () => x.queue("Q").run?.state === "finished");
    const [first, second] = x.sets("Q");
    assert.deepEqual([first!.state, first!.dispute?.base?.state, first!.dispute?.outcome, first!.fix_queue], ["failed", "passed", "fix", undefined]);
    assert.equal(second!.state, "passed", "fixed in the round, then all checks passed");
    assert.equal(second!.fix, 1, "the round counted toward the limit");
    assert.equal(loadProjectState(x.store).queues.filter((q) => q.origin === "ci").length, 0, "no fix queue");
    const said = loadProjectState(x.store).sessions.flatMap((s) => s.inbox).filter((m) => m.type === "check_failed").map((m) => m.text);
    assert.ok(said.some((t) => /passes on the queue's base commit [0-9a-f]+: the failure comes with this queue's work/.test(t)), JSON.stringify(said));
  } finally { x.stop(); }
});

test("a disputed failure that cannot run on the base waits for the orchestrator: accept sends the step to its review, fix gives a round; each recorded with its reason (P6)", async () => {
  const x = withOrchestrator(["Q", "R"]);
  x.plan("Q-unit", [1]); // no base plan: the stand-in cannot run there ("Missing script")
  x.plan("R-unit", [1, 1, 0]);
  try {
    await x.hello();
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 to wait for the decision", () => x.queue("Q").steps[0]!.checking?.phase === "decision");
    const [q] = x.sets("Q");
    assert.equal(q!.dispute?.base?.state, "unrunnable");
    assert.match(q!.dispute!.base!.reason!, /cannot run there/);
    assert.equal(x.queue("Q").steps[0]!.status, "waiting");
    await x.until("the orchestrator to be asked", () => x.said(/could not run it on the queue's base/));
    x.decide("Q", "accept", "the machine's network fails it, not the step");
    await x.until("Q to finish", () => x.queue("Q").run?.state === "finished");
    const [accepted] = x.sets("Q");
    assert.deepEqual([accepted!.state, accepted!.dispute?.decided?.verdict, accepted!.dispute?.decided?.reason, accepted!.fix_queue?.created], ["accepted", "accept", "the machine's network fails it, not the step", true]);
    assert.match(x.queue(accepted!.fix_queue!.id).description!, /accepted by the orchestrator: the machine's network fails it/);

    x.engine.start("R", { runtime: "claude" });
    await x.until("R1 to wait for the decision", () => x.queue("R").steps[0]!.checking?.phase === "decision");
    x.decide("R", "fix", "it fails only with this queue's change");
    await x.until("R to finish", () => x.queue("R").run?.state === "finished");
    const [r1, r2] = x.sets("R");
    assert.deepEqual([r1!.state, r1!.dispute?.decided?.verdict, r1!.dispute?.decided?.reason, r1!.dispute?.outcome, r2!.state], ["failed", "fix", "it fails only with this queue's change", "fix", "passed"]);
  } finally { x.stop(); }
});

/** Rejections nobody handled while `body` ran (the server would have exited on one: queue LF, F1). */
async function rejections(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listen = (reason: unknown) => { seen.push(reason); };
  process.on("unhandledRejection", listen);
  try { await body(); await new Promise((r) => setTimeout(r, 300)); }
  finally { process.off("unhandledRejection", listen); }
  return seen;
}

test("a Stop while the disputed check's base worktree is being added: the server goes on, the base run is asked for again and runs at Resume (queue LF, F1)", async () => {
  const x = withOrchestrator(["Q"]);
  x.plan("Q-unit", [1]); x.plan("Q-unit", [1], true);
  const root = x.store.readProject().root;
  // `git worktree add` runs the post-checkout hook: it marks the add's start and holds it long enough for the Stop.
  const marker = join(root, "adding");
  const hook = join(root, ".git", "hooks", "post-checkout");
  writeFileSync(hook, `#!/bin/sh\necho started > "${marker.replaceAll("\\", "/")}"\nsleep 2\n`);
  try {
    await x.hello();
    const seen = await rejections(async () => {
      x.engine.start("Q", { runtime: "claude" });
      await x.until("the base worktree to be added", () => existsSync(marker));
      x.engine.stopNow("Q");
      await x.until("the base run to be given up", () => x.sets("Q")[0]?.dispute?.base?.state === "queued" && x.engine.idle(), LONGER.step);
    });
    assert.deepEqual(seen.map(String), [], "no rejection nobody handled");
    assert.deepEqual([x.queue("Q").run?.state, x.queue("Q").run?.reason], ["paused", "stopped by the user"]);
    assert.deepEqual([x.queue("Q").steps[0]!.status, x.queue("Q").steps[0]!.checking?.phase], ["checking", "base"]);
    assert.equal(x.runs().filter((r) => r.endsWith("@base")).length, 0, "the check did not start on the base");
    const worktrees = () => execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }).split("\n").filter((l) => l.startsWith("worktree ")).length;
    assert.equal(worktrees(), 1, "the base worktree is removed");

    rmSync(hook);
    x.engine.resume("Q");
    await x.until("Q to finish", () => x.queue("Q").run?.state === "finished");
    assert.deepEqual([x.sets("Q")[0]!.state, x.sets("Q")[0]!.dispute?.base?.state], ["accepted", "failed"]);
    assert.equal(x.runs().filter((r) => r.endsWith("@base")).length, 1);
  } finally { x.stop(); }
});

test("a base run stopped while checks.yaml cannot be written: its worktree is still removed and its end released, the run stays stopped (queue LH, finding 3)", async () => {
  // The stop's ticket.cancel() already ends the grant, so the machine's slot is free either way (the survey's "slot
  // held" does not happen); what the unguarded write in the base run's `finally` skipped was the rest of that block:
  // the base worktree's removal and the release, and its throw halted the run the user had stopped.
  const x = withOrchestrator(["Q"]);
  x.plan("Q-unit", [1]); x.plan("Q-unit", [1], true);
  const root = x.store.readProject().root;
  const marker = join(root, "adding");
  const hook = join(root, ".git", "hooks", "post-checkout");
  writeFileSync(hook, `#!/bin/sh\necho started > "${marker.replaceAll("\\", "/")}"\nsleep 2\n`);
  const slotFree = () => { const c = readCapacity(); return !c || (!c.held.length && !c.waiting.length); };
  const worktrees = () => execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }).split("\n").filter((l) => l.startsWith("worktree ")).length;
  let fault: ReturnType<typeof ProjectStore.faultWrites> | undefined;
  try {
    await x.hello();
    const seen = await rejections(async () => {
      x.engine.start("Q", { runtime: "claude" });
      await x.until("the base worktree to be added", () => existsSync(marker));
      x.engine.stopNow("Q");
      // The base run's end (its `finally`) writes checks.yaml: that write fails, as on a full disk.
      fault = ProjectStore.faultWrites({ file: "queues/Q/checks.yaml" });
      await x.until("the base run to end", () => fault!.failed() > 0 && x.engine.idle() && worktrees() === 1, LONGER.step);
    });
    assert.deepEqual(seen.map(String), [], "no rejection nobody handled");
    assert.ok(slotFree(), "the machine's slot given back");
    assert.deepEqual([x.queue("Q").run?.state, x.queue("Q").run?.reason], ["paused", "stopped by the user"], "stopped, not halted by the failed write");
    fault?.clear();
    rmSync(hook);
    x.engine.resume("Q");
    await x.until("Q to finish", () => x.queue("Q").run?.state === "finished");
    assert.equal(x.runs().filter((r) => r.endsWith("@base")).length, 1, "the base run asked for again and run");
  } finally { fault?.clear(); rmSync(hook, { force: true }); x.stop(); }
});

test("an accept decided before a restart and not yet recorded as accepted is finished by the next server: the step goes to its review, with the fix queue already there (queue LF, F5)", async () => {
  const x = withOrchestrator(["Q"]);
  let fault: ReturnType<typeof ProjectStore.faultWrites> | undefined;
  x.plan("Q-unit", [1]); // no base plan: the stand-in cannot run there, the orchestrator decides
  try {
    await x.hello();
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 to wait for the decision", () => x.queue("Q").steps[0]!.checking?.phase === "decision");
    // The server ends inside accept(): its fix queue proposed, the set's outcome not written (queue LH: the test made
    // no restart, and never reached the fix queue being there already). The decision is recorded (decide()'s write,
    // the test's here: the one write the fault lets through); accept's write of the set fails, as at a server's end.
    fault = ProjectStore.faultWrites({ file: "queues/Q/checks.yaml", after: 1 });
    const file = x.store.readChecks("Q")!;
    file.steps.Q1!.sets[0]!.dispute!.decided = { verdict: "accept", reason: "the machine's network fails it", at: new Date().toISOString(), event: "e-decided" };
    x.store.writeChecks("Q", file);
    await x.until("the fix queue proposed, the set's write refused", () => fault!.failed() > 0 && x.store.queueIds().includes("CI"));
    x.restart();
    fault.clear();
    const set = () => x.sets("Q")[0]!;
    assert.deepEqual([set().dispute?.outcome, set().fix_queue], [undefined, undefined], "nothing of the acceptance recorded in the set");
    if (x.queue("Q").run?.state !== "running") x.engine.resume("Q");
    await x.until("Q to finish", () => x.queue("Q").run?.state === "finished");
    assert.deepEqual([set().state, set().dispute?.outcome, set().fix_queue], ["accepted", "accepted", { id: "CI", created: true }], "the fix queue found, and named as made for this failure");
    assert.deepEqual(x.store.queueIds().filter((id) => id.startsWith("CI")), ["CI"], "no second fix queue");
    assert.equal((x.store.readQueue("CI").description ?? "").split("\n").filter((l) => /^- \S+: queue Q, step Q1 /.test(l)).length, 1, "the occurrence once");
  } finally { fault?.clear(); x.stop(); }
});

test("a server that ends between the base run's failure and its acceptance: the next server finishes the acceptance and does not run the base again (queue LH, finding 14)", async () => {
  const x = withOrchestrator(["Q"]);
  x.plan("Q-unit", [1]); x.plan("Q-unit", [1], true);
  let fault: ReturnType<typeof ProjectStore.faultWrites> | undefined;
  // endBase writes the base run's failure; the write after it (accept's) fails, as at a server's end.
  const file = join(x.store.queueDir("Q"), "checks.yaml");
  const unhook = onWrite((f) => {
    if (fault || resolve(f) !== resolve(file)) return;
    if (x.store.readChecks("Q")?.steps.Q1?.sets[0]?.dispute?.base?.state === "failed") fault = ProjectStore.faultWrites({ file: "queues/Q/checks.yaml" });
  });
  try {
    await x.hello();
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the acceptance's write refused", () => (fault?.failed() ?? 0) > 0);
    unhook();
    x.restart();
    fault!.clear();
    const set = () => x.sets("Q")[0]!;
    assert.deepEqual([set().dispute?.base?.state, set().dispute?.outcome], ["failed", undefined], "the failure recorded, its acceptance not");
    if (x.queue("Q").run?.state !== "running") x.engine.resume("Q");
    await x.until("Q to finish", () => x.queue("Q").run?.state === "finished");
    assert.deepEqual([set().state, set().dispute?.outcome, set().fix_queue], ["accepted", "accepted", { id: "CI", created: true }]);
    assert.equal(x.runs().filter((r) => r.endsWith("@base")).length, 1, "the base run not run again");
  } finally { unhook(); fault?.clear(); x.stop(); }
});

test("an unreadable checks.yaml while the checks run: the step does not go to its review, the run halts with the reason, and the check's end is no crash (queue LF, F6)", async () => {
  const x = withChecks(["done"], ["unit"]);
  x.plan("unit", ["1500ms:0"]);
  try {
    const seen = await rejections(async () => {
      x.engine.start("Q", { runtime: "claude" });
      await x.until("the check to run", () => x.sets()[0]?.state === "running" && x.runs().length === 1, LONGER.run);
      writeFileSync(join(x.store.queueDir("Q"), "checks.yaml"), "protocol: 1\nsteps: [unclosed\n");
      x.engine.onChange(loadProjectState(x.store)); // the server's watcher
      await x.until("the run to halt", () => x.queue().run?.state === "halted", LONGER.step);
      await x.until("the check to end", () => x.engine.idle(), LONGER.step);
    });
    assert.deepEqual(seen.map(String), [], "no rejection nobody handled");
    assert.match(x.queue().run!.reason!, /queues\/Q\/checks\.yaml cannot be read/);
    const state = loadProjectState(x.store);
    assert.ok(state.warnings.some((w) => /queue Q checks:/.test(w)), "the state warns of the file");
    assert.notEqual(x.queue().steps[0]!.status, "review", "not to its review as if its checks had run");
    assert.equal(x.queue().steps[0]!.status, "checking");
  } finally { x.engine.shutdown(); x.cap.shutdown(); }
});

test("the failing tests' names, from node:test's spec reporter and TAP; none from an unknown format", () => {
  const spec = "✔ works (1ms)\n✖ engine › halts (12.5ms)\n  AssertionError: no\n✖ failing tests:\n\n✖ engine › halts (12.5ms)\n";
  assert.deepEqual(failedTests(spec), ["engine › halts"]);
  assert.deepEqual(failedTests("ok 1 - fine\nnot ok 2 - breaks here # time=3ms\n"), ["breaks here"]);
  assert.deepEqual(failedTests("FAIL src/a.test.js\n  Expected 1, got 2\n"), []);
});
