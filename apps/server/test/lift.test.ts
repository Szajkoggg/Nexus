// Lifting a stop (queue SQ, the W scenario): a queue stopped at a step gets a new revision, the user approves it, and
// a start runs the stopped step again and the new steps. Against the fake runtimes; no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, routeAnswers, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";

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
  const engine: Engine = new Engine(store, () => { routeAnswers(store); engine.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100 });
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
  /** Revision 2: the stopped step Q2 revised (it runs again), a new step Q2b after it. */
  const revise = () => applyDraft(store, {
    id: "Q", title: "Queue", stop_conditions: ["the art is missing"], checks: [],
    steps: [step("Q1", "done"), { ...step("Q2", "done"), title: "Step Q2, with the art" }, step("Q2b", "done"), step("Q3", "done")],
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
    const { store, engine, state, queue, opened, until, revise } = setup([step("Q1", "done"), step("Q2", "stop"), step("Q3", "done")]);
    try {
      engine.start("Q", { runtime });
      await until("the halt", () => queue().run?.state === "halted");
      assert.equal(queue().status, "stopped");
      assert.match(queue().run!.reason!, /stopped at step Q2: fake condition: fake stop/, "the halt names the step and the cause");
      assert.throws(() => engine.start("Q", { runtime }), /queue Q is stopped at step Q2: fake condition: fake stop/);

      revise();
      assert.equal(queue().status, "stopped", "a draft alone lifts nothing");
      assert.throws(() => engine.resume("Q"), /approve/);
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

test("resume refuses a run of an older revision, also a run record without its revision; start begins afresh", async () => {
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
    assert.throws(() => engine.resume("Q"), /run belongs to revision 1 and the queue is at revision 2: start the queue/);

    // An older run record, written before runs carried their revision: older when a revision was replaced after it began.
    const { revision: _r, ...legacy } = store.readRun("Q")!;
    store.writeRun("Q", legacy);
    assert.throws(() => engine.resume("Q"), /run belongs to revision an earlier one/);

    engine.start("Q");
    await until("the run to finish", () => queue().run?.state === "finished");
    assert.deepEqual(opened(), ["Q1", "Q2", "Q2b", "Q3"]);
  } finally { engine.shutdown(); delete process.env.FAKE_SLOW_MS; }
});
