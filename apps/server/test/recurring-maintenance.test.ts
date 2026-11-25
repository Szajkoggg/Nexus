// Recurring queues after every N queues, and maintenance runs (docs/protocol/planning.md, "Recurring queues"), against the fake
// runtimes: an "after 5 queues" recurring runs once 5 of the project's queues are done (removed queues and recurring
// runs not counted, so two of them never start each other); survey or fix_small is part of what the user approves; a
// survey run that leaves a commit is stopped; a maintenance run with findings tells the orchestrator once, with the
// report's path, and one without closes quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, ensureUserSession, loadProjectState, newId, now, routeAnswers, type Event } from "@nexus/protocol";
import { Engine, SURVEY_CONDITION } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { QUICK_ENGINE, until as waitUntil, LONGER } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

/** A template whose one step does what `what` says to the fake; `maintenance` makes it a maintenance template. */
const template = (id: string, maintenance?: string) => `template:
  id: ${id}
  title: Template ${id}
${maintenance ? `maintenance: ${maintenance}\n` : ""}params:
  - name: what
    description: what the fake does
    default: done
title: "${id}: {{what}}"
steps:
  - id: "{{id}}1"
    title: Step
    goal: "FAKE: {{what}}"
    size: S
${maintenance ? `  - id: "{{id}}2"
    maintenance: fix_small
    title: Fix
    goal: "FAKE: done"
    size: S
` : ""}`;

/** The system's temporary folder as it was: each test points TEMP at a folder of its own, which must not nest. */
const TMP = tmpdir();

function setup(opts: { orchestrator?: boolean; git?: boolean } = {}) {
  const root = mkdtempSync(join(TMP, "nexus-recurring-m-"));
  // The reports' folder is <temp>/nexus-reports/<project>: copies of this file running side by side (the load tool)
  // have the same project id, and one's `nexus report` was refused for the other's file. A temporary folder of its own.
  const temp = join(root, "temp");
  mkdirSync(temp);
  process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp;
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_REVIEW_ACCEPT = "1";
  const shipped = join(root, "shipped");
  mkdirSync(shipped);
  process.env.NEXUS_SHIPPED_TEMPLATES = shipped;
  writeFileSync(join(shipped, "tiny.yaml"), template("tiny"));
  writeFileSync(join(shipped, "care.yaml"), template("care", "survey"));
  if (opts.git) {
    const git = (...a: string[]) => execFileSync("git", [...G, ...a], { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), ".nexus/\nhome/\nshipped/\nfake.log\nfake-*\n");
    git("add", ".gitignore"); git("commit", "-qm", "init");
  }
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { notify: !!opts.orchestrator } });
  let orchestrator: Orchestrator | undefined;
  const reviews = { accept: true };
  const tick = () => { routeAnswers(store); if (reviews.accept) acceptReviews(store); const s = loadProjectState(store); orchestrator?.onChange(s); engine.onChange(s); };
  const make = () => new Engine(store, tick, { spawn: inProcessRuntime(), ...QUICK_ENGINE, retryBaseMs: 30, startupMs: 20 });
  let engine = make();
  if (opts.orchestrator) orchestrator = new Orchestrator(store, engine, tick, {}, { spawn: inProcessRuntime() });
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const runs = (id: string) => state().queues.filter((q) => q.id.startsWith(`${id}-`));
  const until = (what: string, pred: () => boolean, ms = LONGER.run) => waitUntil(what, pred, ms, () => `; queues: ${state().queues.map((q) => `${q.id} ${q.status}`).join(", ")}; recurring: ${JSON.stringify(state().recurring.map((r) => ({ id: r.id, status: r.status, counted: r.counted, skipped: r.skipped })))}`);
  // A queue of the project done by hand (its step done and accepted), as other work of the project would leave it.
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: now() });
  const user = ensureUserSession(store);
  const emit = (session: string, body: Record<string, unknown>) => store.appendEvent({ v: 1, id: newId(), at: now(), session, ...body } as Event);
  const doneQueue = (id: string) => {
    store.writeQueue({ protocol: 1, id, title: `Work ${id}`, revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [{ id: `${id}1`, title: "S", goal: "", acceptance: [] }] });
    approveQueue(store, id);
    emit("w", { type: "step.started", queue: id, step: `${id}1` });
    emit("w", { type: "step.done", queue: id, step: `${id}1`, summary: "ok" });
    emit(user.id, { type: "review.accepted", queue: id, step: `${id}1` });
  };
  const stop = () => { clearInterval(timer); orchestrator?.shutdown(); engine.shutdown(); delete process.env.NEXUS_SHIPPED_TEMPLATES; };
  /** The next server on the same files (without an orchestrator): the old engine shut down, a new one made. */
  const restart = () => { engine.shutdown(); engine = make(); };
  return { root, store, get engine() { return engine; }, restart, reviews, get orchestrator() { return orchestrator!; }, state, runs, until, doneQueue, stop };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("after the 5th done queue it runs; a removed queue and the recurring runs do not count, so two such recurrings never start each other", async () => {
  const x = setup();
  try {
    x.doneQueue("OLD"); // done before the recurring: not counted
    for (const id of ["A", "B"]) {
      assert.match(x.engine.setRecurring({ id, template: "tiny", params: {}, after_queues: 5, by: "orchestrator" }), new RegExp(`recurring ${id} set: template tiny \\(nexus\\), after 5 queues`));
      x.engine.approveRecurring(id);
    }
    for (const id of ["Q1", "Q2", "Q3", "Q4"]) x.doneQueue(id);
    rmSync(x.store.queueDir("Q2"), { recursive: true }); // removed: no longer counted
    x.doneQueue("Q5");
    await sleep(600);
    assert.deepEqual(x.state().recurring.map((r) => [r.id, r.counted]), [["A", 4], ["B", 4]]);
    assert.deepEqual([...x.runs("A"), ...x.runs("B")], [], "4 counted: nothing yet");
    x.doneQueue("Q6");
    await x.until("both runs done", () => x.runs("A").length === 1 && x.runs("B").length === 1 && [...x.runs("A"), ...x.runs("B")].every((q) => q.status === "done"));
    assert.equal(x.store.readQueue(x.runs("A")[0]!.id).approvals[0]!.standing?.id, "A");
    // Each one's run is done, and neither counts it: no further run, the counts start again at 0.
    await sleep(800);
    assert.deepEqual([x.runs("A").length, x.runs("B").length], [1, 1]);
    assert.deepEqual(x.state().recurring.map((r) => r.counted), [0, 0]);
  } finally { x.stop(); }
});

test("one that has run counts from its run through a new set; once a count passed without a run it counts from its approval (queue CK); one that never ran counts from the approval", async () => {
  const x = setup();
  try {
    const counted = (id: string) => x.state().recurring.find((r) => r.id === id)?.counted;
    x.engine.setRecurring({ id: "R", template: "tiny", params: {}, after_queues: 2, by: "orchestrator" });
    x.engine.approveRecurring("R");
    x.doneQueue("Q1"); x.doneQueue("Q2");
    await x.until("R's first run done", () => x.runs("R").length === 1 && x.runs("R")[0]!.status === "done");
    assert.deepEqual(x.store.readRecurring("R")!.last?.baseline, ["Q1", "Q2"], "the run keeps where its count started");
    assert.equal(counted("R"), 0, "its own run is not counted");
    x.doneQueue("Q3");
    // A set (the same, or another value) takes the approval away; the count since the run goes on through it.
    x.engine.setRecurring({ id: "R", template: "tiny", params: {}, after_queues: 2, by: "orchestrator" });
    assert.equal(counted("R"), 1, "Q3, done since the run");
    // A never-run recurring set now counts from its approval: Q4, done before it, does not count.
    x.engine.setRecurring({ id: "N", template: "tiny", params: {}, after_queues: 2, by: "orchestrator" });
    x.doneQueue("Q4");
    x.engine.approveRecurring("N");
    assert.equal(counted("N"), 0);
    // R's 2nd queue came without its approval: that count passes without a run.
    await x.until("R's count to pass without a run", () => x.store.readRecurring("R")!.skipped?.kind === "approval");
    // Skipped, it counts from the approval (the user's decision of 2026-11-23, queue CK): Q3 and Q4 do not start it.
    x.engine.approveRecurring("R");
    assert.equal(counted("R"), 0, "counted from the approval");
    await sleep(600);
    assert.equal(x.runs("R").length, 1, "not run at once");
    x.doneQueue("Q5");
    await sleep(600);
    assert.deepEqual([x.runs("R").length, counted("R"), counted("N")], [1, 1, 1]);
    x.doneQueue("Q6"); // N queues after the approval, for both
    await x.until("R's second run done", () => x.runs("R").length === 2 && x.runs("R").every((q) => q.status === "done"));
    await x.until("N's first run done", () => x.runs("N").length === 1 && x.runs("N")[0]!.status === "done");
    await sleep(600);
    assert.deepEqual([x.runs("R").length, x.runs("N").length], [2, 1]);
    assert.deepEqual([counted("R"), counted("N")], [0, 0], "the runs count for neither");
  } finally { x.stop(); }
});

test("a paused one let go on counts from then, also through a set and an approval: what was done while it was paused does not start it (queue CK)", async () => {
  const x = setup();
  try {
    const counted = (id: string) => x.state().recurring.find((r) => r.id === id)?.counted;
    x.engine.setRecurring({ id: "P", template: "tiny", params: {}, after_queues: 2, by: "orchestrator" });
    x.engine.approveRecurring("P");
    x.doneQueue("Q1"); x.doneQueue("Q2");
    await x.until("P's first run done", () => x.runs("P").length === 1 && x.runs("P")[0]!.status === "done");
    x.engine.pauseRecurring("P", true);
    x.doneQueue("Q3");
    await sleep(600);
    // Let go on: Q3, done while paused, does not count.
    x.engine.pauseRecurring("P", false);
    assert.equal(counted("P"), 0, "counted from the moment it goes on");
    x.doneQueue("Q4");
    await sleep(600);
    assert.deepEqual([x.runs("P").length, counted("P")], [1, 1], "one queue since it went on: no run");
    // Paused again, set and approved while paused, then let go on: the count starts at each of them again.
    x.engine.pauseRecurring("P", true);
    x.doneQueue("Q5");
    x.engine.setRecurring({ id: "P", template: "tiny", params: {}, after_queues: 2, by: "orchestrator" });
    assert.equal(counted("P"), 0, "a set of a paused one counts from the set");
    x.engine.approveRecurring("P");
    x.doneQueue("Q6");
    x.engine.pauseRecurring("P", false);
    assert.equal(counted("P"), 0);
    await sleep(600);
    assert.equal(x.runs("P").length, 1, "not run at once");
    x.doneQueue("Q7"); x.doneQueue("Q8");
    await x.until("P's second run done, N queues after it went on", () => x.runs("P").length === 2 && x.runs("P")[1]!.status === "done");
  } finally { x.stop(); }
});

test("one never paused nor skipped keeps counting from its run through a set and an approval: the queues done since its run count (the rule before queue CK)", async () => {
  const x = setup();
  try {
    x.engine.setRecurring({ id: "K", template: "tiny", params: {}, after_queues: 2, by: "orchestrator" });
    x.engine.approveRecurring("K");
    x.doneQueue("Q1"); x.doneQueue("Q2");
    await x.until("K's first run done", () => x.runs("K").length === 1 && x.runs("K")[0]!.status === "done");
    x.doneQueue("Q3");
    x.engine.setRecurring({ id: "K", template: "tiny", params: {}, after_queues: 3, by: "orchestrator" });
    x.doneQueue("Q4");
    assert.equal(x.store.readRecurring("K")!.skipped, undefined, "below N: nothing passed without a run");
    x.engine.approveRecurring("K");
    assert.equal(x.state().recurring.find((r) => r.id === "K")?.counted, 2, "Q3 and Q4, done since its run");
    x.doneQueue("Q5");
    await x.until("K's second run done", () => x.runs("K").length === 2 && x.runs("K")[1]!.status === "done");
  } finally { x.stop(); }
});

test("a restart in the middle of an after-N count keeps it: the queues counted before it still count (survey LC3, F8)", async () => {
  const x = setup();
  try {
    const counted = () => x.state().recurring.find((r) => r.id === "R")?.counted;
    x.engine.setRecurring({ id: "R", template: "tiny", params: {}, after_queues: 2, by: "orchestrator" });
    x.engine.approveRecurring("R");
    x.engine.pauseRecurring("R", true);
    x.engine.pauseRecurring("R", false);
    x.doneQueue("Q1");
    assert.equal(counted(), 1);
    x.restart();
    assert.equal(counted(), 1, "the count's start is in the recurring's file: the new server counts on from it");
    assert.deepEqual(x.runs("R"), [], "not run at the restart");
    x.doneQueue("Q2");
    await x.until("R's run done", () => x.runs("R").length === 1 && x.runs("R")[0]!.status === "done");
    assert.equal(counted(), 0, "a new count after the run");
  } finally { x.stop(); }
});

test("after a skip that is not for the approval (a run that failed to be made), a set counts from the set, and an approval after it from the last run (survey LC3, F8: the rule as it is)", async () => {
  const x = setup();
  try {
    const counted = () => x.state().recurring.find((r) => r.id === "R")?.counted;
    x.engine.setRecurring({ id: "R", template: "tiny", params: {}, after_queues: 3, by: "orchestrator" });
    x.engine.approveRecurring("R");
    x.doneQueue("Q1"); x.doneQueue("Q2"); x.doneQueue("Q3");
    await x.until("R's first run done", () => x.runs("R").length === 1 && x.runs("R")[0]!.status === "done");
    // The file as Recurrer.decide's catch leaves it when a later run could not be made (`failed`).
    const r = x.store.readRecurring("R")!;
    x.store.writeRecurring({ ...r, skipped: { due: now(), at: now(), kind: "failed", reason: "the run could not be made (test)" } });
    x.doneQueue("Q4");
    assert.equal(counted(), 1, "Q4, since the run");
    // A set of a skipped one counts from the set (queue CK), and writes no skip: the skip is gone with it.
    x.engine.setRecurring({ id: "R", template: "tiny", params: {}, after_queues: 3, by: "orchestrator" });
    assert.equal(counted(), 0, "counted from the set");
    assert.equal(x.store.readRecurring("R")!.skipped, undefined, "the set dropped the failed skip");
    x.doneQueue("Q5");
    // The approval after it: no skip left, so the count goes on from the last run (Q4 and Q5), as for one never skipped.
    x.engine.approveRecurring("R");
    assert.equal(counted(), 2, "Q4 and Q5, done since the last run");
    // A second set and approval: the same, the count stays from the last run.
    x.engine.setRecurring({ id: "R", template: "tiny", params: {}, after_queues: 3, by: "orchestrator" });
    assert.equal(counted(), 2, "a set of one not skipped counts on from its run");
    x.engine.approveRecurring("R");
    assert.equal(counted(), 2);
    x.engine.onChange(x.state()); // the look a change makes (Recurrer.check runs in it): below N, it starts nothing
    assert.equal(x.runs("R").length, 1, "below N: no run");
    x.doneQueue("Q6");
    await x.until("R's second run done", () => x.runs("R").length === 2 && x.runs("R")[1]!.status === "done");
  } finally { x.stop(); }
});

test("survey and fix_small are part of what the user approves: switching asks for the approval again", () => {
  const x = setup();
  try {
    assert.match(x.engine.setRecurring({ id: "M", template: "care", params: {}, every: "mon 03:00", by: "orchestrator" }), /maintenance survey/);
    x.engine.approveRecurring("M");
    const survey = x.state().recurring[0]!.hash;
    assert.match(x.engine.setRecurring({ id: "M", template: "care", params: {}, every: "mon 03:00", maintenance: "fix_small", by: "orchestrator" }), /maintenance fix_small; the user's standing approval is taken away/);
    const r = x.state().recurring[0]!;
    assert.equal(r.status, "needs_approval");
    assert.notEqual(r.hash, survey, "another hash: the old approval could not hold even if kept");
    assert.throws(() => x.engine.setRecurring({ id: "T", template: "tiny", params: {}, every: "mon 03:00", maintenance: "survey", by: "orchestrator" }), /not a maintenance template/);
  } finally { x.stop(); }
});

test("a survey run that leaves a commit is stopped by Nexus; one that leaves nothing finishes", async () => {
  const x = setup({ git: true });
  try {
    const queue = (id: string, what: string) => {
      x.store.writeQueue({ protocol: 1, id, title: id, revision: 1, status: "proposed", maintenance: "survey", stop_conditions: [], checks: [], steps: [{ id: `${id}1`, title: "Survey", goal: `FAKE: ${what}`, acceptance: [] }] });
      approveQueue(x.store, id);
    };
    // The step is checked when it reports its end, before its review: here nobody reviews it meanwhile.
    x.reviews.accept = false;
    queue("SV", "commit");
    x.engine.start("SV");
    await x.until("SV to stop", () => x.state().queues.find((q) => q.id === "SV")?.status === "stopped");
    const sv = x.state().queues.find((q) => q.id === "SV")!;
    assert.equal(sv.stop?.condition, SURVEY_CONDITION);
    assert.match(sv.stop?.reason ?? "", /^the survey run left 1 commit since step SV1 began$/);
    // Lift nothing; a clean survey in a fresh queue finishes (once the checkout is free: the stopped run halted).
    await x.until("SV's run to halt", () => x.state().queues.find((q) => q.id === "SV")?.run?.state === "halted");
    x.reviews.accept = true;
    queue("OK", "done");
    x.engine.start("OK");
    await x.until("OK to finish", () => x.state().queues.find((q) => q.id === "OK")?.run?.state === "finished");
    assert.equal(x.state().queues.find((q) => q.id === "OK")!.status, "done");
  } finally { x.stop(); }
});

test("a maintenance run with findings tells the orchestrator once, with the report's path; one without closes quietly", async () => {
  const x = setup({ orchestrator: true });
  try {
    const queue = (id: string, findings: number) => {
      x.store.writeQueue({ protocol: 1, id, title: id, revision: 1, status: "proposed", maintenance: "survey", stop_conditions: [], checks: [], steps: [{ id: `${id}1`, title: "Survey", goal: `FAKE: done\nFAKE-FINDINGS: ${findings}`, acceptance: [] }] });
      approveQueue(x.store, id);
    };
    const nexusLines = () => x.orchestrator.view().chat.filter((c) => c.from === "nexus").map((c) => c.text);
    queue("NONE", 0);
    x.engine.start("NONE");
    // The report comes after the last step's done (as the prompt asks it), so the run may finish before it.
    await x.until("NONE to finish, with its report", () => { const q = x.state().queues.find((y) => y.id === "NONE"); return q?.run?.state === "finished" && q.report !== undefined; });
    assert.equal(x.state().queues.find((q) => q.id === "NONE")!.report?.findings, 0);
    queue("SOME", 3);
    x.engine.start("SOME");
    await x.until("the findings notice", () => nexusLines().some((t) => t.startsWith("Maintenance queue SOME")));
    await sleep(800);
    const lines = nexusLines();
    const report = x.state().queues.find((q) => q.id === "SOME")!.report!;
    // Its approval and its review are told as for any queue; its end once, with the report's path.
    assert.deepEqual(lines.filter((t) => /^(Maintenance queue|Queue) SOME\b.* finished/.test(t)), [`Maintenance queue SOME (survey) finished with 3 findings. Report: ${report.path}`], "once, with the path");
    assert.deepEqual(lines.filter((t) => /^(Maintenance queue|Queue) NONE\b.* finished/.test(t)), [], "the run without findings: no notice of its end");
  } finally { x.stop(); }
});
