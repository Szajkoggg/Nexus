// Nexus runs the queue's checks (src/check-runs.ts; queue EC, EC3): after the worker's `nexus step done` the engine
// runs them through the capacity coordinator, writes checks.yaml and a log per run, runs a failing check once more
// (flaky when it passes then), gives the worker a check-fix round with what failed, halts the run for the orchestrator
// after the limit, runs the checks again after a restart or an update's drain, and judges a disputed failure on the
// queue's base commit. Against the fake runtimes; the checks are a small Node script whose outcomes each test plans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, routeAnswers, updateSettings, type ChecksFile } from "@nexus/protocol";
import { Orchestrator } from "../src/orchestrator.ts";
import { Capacity } from "../src/capacity.ts";
import { failedTests } from "../src/check-runs.ts";
import { Engine, type EngineOptions } from "../src/engine.ts";
import { FAST, restart, setup } from "./engine-setup.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { LONGER, until as waitUntil } from "./wait.ts";

process.env.NEXUS_HOME ??= mkdtempSync(join(tmpdir(), "nexus-checks-home-"));
const lockFile = () => join(mkdtempSync(join(tmpdir(), "nexus-checks-lock-")), "full-test.lock");
/** Without Job Objects (a second or two a process on Windows): these tests are about the engine, not the tree. */
const capacity = (jobs = false) => new Capacity({ testLock: lockFile(), pollMs: 20, jobs });

/**
 * The stand-in checks: `node check.cjs <name>` exits with the next planned code of <name> (the last one stays), after
 * an optional wait ("<ms>ms:<code>"), printing a passing or failing test as node:test's spec reporter does. Run outside
 * the project's checkout (the base worktree), it takes the plan <name>.base; without one there it cannot run ("Missing
 * script"). The test it prints is named after <name>, or the second argument. Each run is logged.
 */
function standIns(root: string) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-checks-"));
  const script = join(dir, "check.cjs");
  writeFileSync(join(dir, "main-cwd"), root.replaceAll("\\", "/").toLowerCase());
  writeFileSync(script, `const fs = require("fs"), path = require("path");
const dir = __dirname, name = process.argv[2], shown = process.argv[3] || name;
const main = fs.readFileSync(path.join(dir, "main-cwd"), "utf8").trim();
const base = process.cwd().replaceAll("\\\\", "/").toLowerCase() !== main;
fs.appendFileSync(path.join(dir, "runs.log"), name + (base ? "@base" : "") + "\\n");
const plan = path.join(dir, name + (base ? ".base" : ""));
if (!fs.existsSync(plan)) { if (base) { console.error("npm error Missing script: " + name); process.exit(1); } process.exit(0); }
const lines = fs.readFileSync(plan, "utf8").split("\\n").filter(Boolean);
const next = lines.length > 1 ? lines.shift() : lines[0];
fs.writeFileSync(plan, lines.join("\\n") + "\\n");
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
/** A project whose queue Q has these checks, run by Nexus (the engine has a capacity coordinator). */
function withChecks(behaviours: string[], names: string[], options: EngineOptions = {}) {
  const cap = options.capacity ?? capacity();
  const x = setup(behaviours, { ...FAST, capacity: cap, ...options });
  const s = standIns(x.store.readProject().root);
  x.store.writeQueue({ ...x.store.readQueue("Q"), checks: names.map((n) => s.cmd(n)) });
  approveQueue(x.store, "Q");
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
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run, );
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
  const cap = capacity();
  let orchestrator: Orchestrator;
  const engine: Engine = new Engine(store, () => tick(), { ...FAST, capacity: cap });
  orchestrator = new Orchestrator(store, engine, () => tick());
  function tick() { routeAnswers(store); acceptReviews(store); const st = loadProjectState(store); orchestrator.onChange(st); engine.onChange(st); }
  const timer = setInterval(tick, 150);
  const queue = (id: string) => loadProjectState(store).queues.find((q) => q.id === id)!;
  const sets = (id: string) => store.readChecks(id)?.steps[`${id}1`]?.sets ?? [];
  const said = (re: RegExp) => orchestrator.view().chat.some((c) => re.test(c.text));
  const until = (what: string, pred: () => boolean, ms = LONGER.run) => waitUntil(what, pred, ms, () => `; ${queues.map((id) => `${id}: ${queue(id).steps[0]!.status} run=${queue(id).run?.state}`).join("; ")}; chat: ${JSON.stringify(orchestrator.view().chat.slice(-3).map((c) => c.text.slice(0, 160)))}`);
  const hello = async () => { orchestrator.say("Hello"); await until("the orchestrator's session", () => !!orchestrator.session(), LONGER.step); };
  const decide = (q: string, verdict: string, reason: string) => orchestrator.say(`FAKE-NEXUS: ${JSON.stringify(["check", "decide", q, `${q}1`, verdict, "--reason", reason])}`);
  const stop = () => { clearInterval(timer); engine.shutdown(); orchestrator.shutdown(); cap.shutdown(); delete process.env.FAKE_CHECK_DISPUTE; delete process.env.FAKE_REVIEW_ACCEPT; };
  return { store, engine, ...s, queue, sets, said, until, hello, decide, stop };
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

test("the failing tests' names, from node:test's spec reporter and TAP; none from an unknown format", () => {
  const spec = "✔ works (1ms)\n✖ engine › halts (12.5ms)\n  AssertionError: no\n✖ failing tests:\n\n✖ engine › halts (12.5ms)\n";
  assert.deepEqual(failedTests(spec), ["engine › halts"]);
  assert.deepEqual(failedTests("ok 1 - fine\nnot ok 2 - breaks here # time=3ms\n"), ["breaks here"]);
  assert.deepEqual(failedTests("FAIL src/a.test.js\n  Expected 1, got 2\n"), []);
});
