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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, ensureUserSession, loadProjectState, newId, now, routeAnswers, type Event } from "@nexus/protocol";
import { Engine, SURVEY_CONDITION } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { QUICK_ENGINE, until as waitUntil, LONGER } from "./wait.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");
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

function setup(opts: { orchestrator?: boolean; git?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-recurring-m-"));
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
  const engine = new Engine(store, tick, { ...QUICK_ENGINE, retryBaseMs: 30, startupMs: 20 });
  if (opts.orchestrator) orchestrator = new Orchestrator(store, engine, tick);
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
  return { root, store, engine, reviews, get orchestrator() { return orchestrator!; }, state, runs, until, doneQueue, stop };
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

test("one that has run counts from its run through a new set and approval, and runs at the next change once N are done; one that never ran counts from the approval", async () => {
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
    // The approval counts from the run again (Q3 and Q4), and is a change: R runs at once.
    x.engine.approveRecurring("R");
    await x.until("R's second run done", () => x.runs("R").length === 2 && x.runs("R").every((q) => q.status === "done"));
    await sleep(600);
    assert.deepEqual([x.runs("R").length, x.runs("N").length], [2, 0]);
    assert.deepEqual([counted("R"), counted("N")], [0, 0], "the runs count for neither");
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
    await x.until("NONE to finish", () => x.state().queues.find((q) => q.id === "NONE")?.run?.state === "finished");
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
