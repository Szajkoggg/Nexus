// Lifting a stop (queue SQ, the W scenario): a queue stopped at a step gets a new revision, the user approves it, and
// a start runs the stopped step again and the new steps. Against the fake runtimes; no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, orchestratorStatusChange, routeAnswers, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

const step = (id: string, behaviour: string): StepDef => ({ id, title: `Step ${id}`, goal: `FAKE: ${behaviour}`, acceptance: [] });

function setup(steps: StepDef[]) {
  const root = mkdtempSync(join(tmpdir(), "nexus-lift-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: ["the art is missing"], checks: [], steps });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100 });
  const state = () => loadProjectState(store);
  const queue = () => state().queues.find((q) => q.id === "Q")!;
  const opened = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n") : [])
    .map((l) => (JSON.parse(l) as { text: string }).text).filter((t) => t.startsWith("[Nexus] Queue"))
    .map((t) => /step (\S+) \(/.exec(t)![1]!);
  const until = async (what: string, pred: () => boolean, ms = 20_000) => {
    for (const t = Date.now(); !pred();) {
      if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}; run: ${JSON.stringify(queue().run)}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  /** Revision 2: a new step Q2b after Q2; the steps there are kept as they are (a revision changes no started step). */
  const revise = () => applyDraft(store, {
    id: "Q", title: "Queue", stop_conditions: ["the art is missing"], checks: [],
    steps: store.readQueue("Q").steps.flatMap(({ status: _s, status_note: _n, ...s }) => (s.id === "Q2" ? [s, step("Q2b", "done")] : [s])),
  });
  return { store, engine, state, queue, opened, until, revise };
}

/** After a lift: approved, run record archived, nothing about Q waits for the user. */
function assertLifted(store: ProjectStore, q: ReturnType<ReturnType<typeof setup>["queue"]>, reason: RegExp, attention: { queue?: string }[]) {
  assert.equal(q.status, "approved");
  assert.ok(q.approved);
  const lift = q.changes.at(-1)!;
  assert.deepEqual([lift.kind, lift.by, lift.from, lift.to, lift.revision], ["lift", "user_approval", "stopped", "approved", 2]);
  assert.match(lift.reason ?? "", reason, "the old stop's reason is kept in the lift");
  assert.equal(q.steps.find((s) => s.id === "Q2")!.status, "pending", "the stopped step is pending again");
  assert.equal(store.readRun("Q"), undefined, "the old run record is archived");
  assert.ok(!attention.some((a) => a.queue === "Q"), `nothing about Q waits for the user: ${JSON.stringify(attention)}`);
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: a queue stopped by nexus stop is lifted by approving a new revision; start runs the stopped step again`, async () => {
    const { store, engine, state, queue, opened, until, revise } = setup([step("Q1", "done"), step("Q2", "stop1"), step("Q3", "done")]);
    try {
      engine.start("Q", { runtime });
      await until("the halt", () => queue().run?.state === "halted");
      assert.equal(queue().status, "stopped");
      assert.match(queue().run!.reason!, /stopped at step Q2: fake condition: fake stop/, "the halt names the step and the cause");
      assert.throws(() => engine.start("Q", { runtime }), /queue Q is stopped at step Q2: fake condition: fake stop/);

      revise();
      assert.equal(queue().status, "stopped", "a draft alone lifts nothing");
      assert.throws(() => engine.resume("Q"), /approving a new revision/);
      const archivesBefore = readdirSync(store.queueDir("Q")).filter((f) => /^run\..+\.yaml$/.test(f)).length;
      approveQueue(store, "Q");
      const s = state();
      assertLifted(store, s.queues.find((q) => q.id === "Q")!, /fake condition: fake stop/, s.attention);
      assert.equal(readdirSync(store.queueDir("Q")).filter((f) => /^run\..+\.yaml$/.test(f)).length, archivesBefore + 1, "kept as run.<time>.yaml");

      engine.start("Q", { runtime });
      assert.equal(queue().run?.revision, 2, "the run records the revision it was started on");
      await until("the run to finish", () => queue().run?.state === "finished");
      assert.deepEqual(opened(), ["Q1", "Q2", "Q2", "Q2b", "Q3"], "after the lift the first pending step is the stopped one");
      assert.deepEqual(queue().steps.map((x) => x.status), ["done", "done", "done", "done"]);
      assert.equal(queue().status, "done");
    } finally { engine.shutdown(); }
  });
}

test("a queue imported as stopped is lifted the same way, and its stop note is kept in the lift", async () => {
  const { store, engine, state, queue, opened, until, revise } = setup([step("Q1", "done"), step("Q2", "done"), step("Q3", "done")]);
  // As an import writes it: the stop in the file, no event, no run.
  const q = store.readQueue("Q");
  store.writeQueue({
    ...q, status: "stopped", status_note: "Stopped at Q2: the cliff art is not delivered",
    steps: q.steps.map((s) => (s.id === "Q1" ? { ...s, status: "done" as const } : s.id === "Q2" ? { ...s, status: "stopped" as const, status_note: "waits for art" } : s)),
  });
  try {
    assert.ok(queue().approved, "the stop is not part of the approved revision");
    assert.throws(() => engine.start("Q"), /queue Q is stopped at step Q2: Stopped at Q2: the cliff art is not delivered/);
    assert.ok(state().attention.some((a) => a.queue === "Q" && a.kind === "stopped"));

    revise();
    approveQueue(store, "Q");
    const s = state();
    assertLifted(store, s.queues.find((x) => x.id === "Q")!, /the cliff art is not delivered/, s.attention);
    assert.equal(store.readQueue("Q").status, "approved", "approving writes the queue approved");

    engine.start("Q");
    await until("the run to finish", () => queue().run?.state === "finished");
    assert.deepEqual(opened(), ["Q2", "Q2b", "Q3"], "the done step stays done; the stopped one runs again");
  } finally { engine.shutdown(); }
});

test("resume goes on with a run of an older revision (also a run record without its revision) in its session; it takes the new revision", async () => {
  process.env.FAKE_SLOW_MS = "800";
  const { store, engine, queue, opened, until, revise } = setup([step("Q1", "slow"), step("Q2", "done"), step("Q3", "done")]);
  try {
    engine.start("Q");
    await until("the step to run", () => queue().steps[0]!.status === "running");
    engine.pause("Q");
    await until("the pause", () => queue().run?.state === "paused");
    revise();
    approveQueue(store, "Q");
    assert.ok(store.readRun("Q"), "a queue that was not stopped keeps its run record");
    // An older run record, written before runs carried their revision: older when a revision was replaced after it began.
    const { revision: _r, ...legacy } = store.readRun("Q")!;
    store.writeRun("Q", legacy);
    const session = legacy.session;

    engine.resume("Q");
    await until("the run to finish", () => queue().run?.state === "finished");
    assert.deepEqual(opened(), ["Q1", "Q2", "Q2b", "Q3"]);
    assert.equal(queue().run!.session, session, "the same session");
    assert.equal(queue().run!.revision, 2, "the run took the new revision");
  } finally { engine.shutdown(); delete process.env.FAKE_SLOW_MS; }
});

// ---------------------------------------------------------------- Continue (the user's lift without a new revision)

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: Continue lifts the stop and the stopped step runs again in its session`, async () => {
    const { store, engine, queue, opened, until } = setup([step("Q1", "done"), step("Q2", "stop1"), step("Q3", "done")]);
    try {
      engine.start("Q", { runtime });
      await until("the stop", () => queue().run?.state === "halted");
      const session = queue().run!.session;
      assert.match(engine.continueQueue("Q"), /the stop is lifted; queue Q goes on/);
      const lift = queue().changes.at(-1)!;
      assert.deepEqual([lift.kind, lift.by, lift.from, lift.to, lift.reason], ["lift", "user_continue", "stopped", "approved", "fake condition: fake stop"]);
      await until("the run to finish", () => queue().run?.state === "finished");
      assert.deepEqual(opened(), ["Q1", "Q2", "Q2", "Q3"]);
      assert.equal(queue().run!.session, session, "the same session goes on");
      assert.deepEqual(queue().steps.map((s) => s.status), ["done", "done", "done"]);
      const received = readFileSync(process.env.FAKE_LOG!, "utf8");
      assert.match(received, /Continue this step where it was left \(the user lifted the stop with Continue; the stop was: fake condition: fake stop\)/);
    } finally { engine.shutdown(); }
  });
}

test("Continue with no run record (an imported stop) starts at the first pending step", async () => {
  const { store, engine, queue, opened, until } = setup([step("Q1", "done"), step("Q2", "done"), step("Q3", "done")]);
  const q = store.readQueue("Q");
  store.writeQueue({
    ...q, status: "stopped", status_note: "Stopped at Q2: waiting for the art",
    steps: q.steps.map((s) => (s.id === "Q1" ? { ...s, status: "done" as const } : s.id === "Q2" ? { ...s, status: "stopped" as const } : s)),
  });
  try {
    assert.equal(store.readRun("Q"), undefined);
    assert.match(engine.continueQueue("Q"), /starts at its first pending step/);
    await until("the run to finish", () => queue().run?.state === "finished");
    assert.deepEqual(opened(), ["Q2", "Q3"]);
    assert.equal(queue().changes.at(-1)!.reason, "Stopped at Q2: waiting for the art");
  } finally { engine.shutdown(); }
});

test("Continue is refused unless the queue is stopped and its current revision approved (approving lifts it then)", async () => {
  const { engine, queue, until, revise } = setup([step("Q1", "stop"), step("Q2", "done"), step("Q3", "done")]);
  try {
    assert.throws(() => engine.continueQueue("Q"), /queue Q is not stopped \(it is approved\)/);
    engine.start("Q");
    await until("the stop", () => queue().run?.state === "halted");
    revise();
    assert.throws(() => engine.continueQueue("Q"), /revision 2 of queue Q is not approved: approve it instead/);
    assert.equal(queue().status, "stopped", "nothing was lifted");
    assert.equal(queue().changes.length, 0);
  } finally { engine.shutdown(); }
});

test("Continue after the orchestrator skipped the stopped step opens the next pending one", async () => {
  const { store, engine, queue, opened, until } = setup([step("Q1", "stop"), step("Q2", "done")]);
  try {
    engine.start("Q");
    await until("the stop", () => queue().run?.state === "halted");
    orchestratorStatusChange(store, { queue: "Q", step: "Q1", to: "skipped", reason: "done by hand" });
    engine.continueQueue("Q");
    await until("the run to finish", () => queue().run?.state === "finished");
    assert.deepEqual(opened(), ["Q1", "Q2"]);
    assert.deepEqual(queue().steps.map((s) => s.status), ["skipped", "done"]);
  } finally { engine.shutdown(); }
});

// The W case of Project Honeycomb: a step stops through a stop condition; the orchestrator skips it (a revision
// replaced it) and proposes lifting the stop; resume is refused, naming Continue; Continue opens the next pending step.
for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: the W case: stop, skip the stopped step, propose-lift, resume refused, Continue opens the next pending step`, async () => {
    const { store, engine, state, queue, opened, until } = setup([step("W1", "done"), step("W4b", "stop"), step("W4c", "done"), step("W5", "done")]);
    try {
      engine.start("Q", { runtime });
      await until("the stop", () => queue().run?.state === "halted");
      assert.match(queue().run!.reason!, /queue Q is stopped at step W4b: fake condition: fake stop\. Only the user lifts a stop: with Continue in the dashboard, or by approving a new revision/);

      orchestratorStatusChange(store, { queue: "Q", step: "W4b", to: "skipped", reason: "replaced by W4c" });
      orchestratorStatusChange(store, { queue: "Q", to: "propose-lift", reason: "W4b was replaced; W4c can run" });
      const s = state();
      const q = s.queues.find((x) => x.id === "Q")!;
      assert.equal(q.status, "stopped", "skipping and proposing lift nothing");
      assert.equal(q.current_step, undefined);
      const item = s.attention.find((a) => a.queue === "Q" && a.kind === "stopped")!;
      assert.equal(item.lift?.place, " (the stop came from W4b, now skipped)");
      assert.equal(item.lift?.continue, true);
      assert.equal(item.lift?.proposal?.reason, "W4b was replaced; W4c can run");

      assert.throws(() => engine.resume("Q"), /queue Q is stopped \(the stop came from W4b, now skipped\): fake condition: fake stop\. Only the user lifts a stop: with Continue in the dashboard/);
      assert.throws(() => engine.start("Q", { runtime }), /with Continue in the dashboard/);

      assert.match(engine.continueQueue("Q"), /goes on in session/);
      await until("the run to finish", () => queue().run?.state === "finished");
      assert.deepEqual(opened(), ["W1", "W4b", "W4c", "W5"], "Continue opens W4c; nothing reopens W4b");
      assert.deepEqual(queue().steps.map((x) => x.status), ["done", "skipped", "done", "done"]);
      assert.ok(!state().attention.some((a) => a.queue === "Q"));
    } finally { engine.shutdown(); }
  });
}
