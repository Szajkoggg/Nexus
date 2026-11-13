// A step a revision change left open (queue RV, the W case of Project Honeycomb): it goes back to pending through a
// changes entry by Nexus, so a start of the new revision runs it again; an orphan left before (the W4e shape) is
// cleaned at start and at server start; the orchestrator may skip a running step no live run holds. Fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, applyDraft, approveQueue, loadProjectState, newId, orchestratorStatusChange, routeAnswers, type Event, type StepDef,
} from "@nexus/protocol";
import { Engine } from "../src/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

const step = (id: string, behaviour: string): StepDef => ({ id, title: `Step ${id}`, goal: `FAKE: ${behaviour}`, acceptance: [] });

function setup(steps: StepDef[]) {
  const root = mkdtempSync(join(tmpdir(), "nexus-revision-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "W", title: "Cliffs", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps });
  approveQueue(store, "W");
  const engines: Engine[] = [];
  const engine = (): Engine => {
    const e: Engine = new Engine(store, () => { routeAnswers(store); e.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100 });
    engines.push(e);
    return e;
  };
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "W")!;
  const statuses = () => queue().steps.map((s) => `${s.id}=${s.status}`).join(" ");
  const running = () => queue().steps.filter((s) => s.status === "running").map((s) => s.id);
  const opened = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n") : [])
    .map((l) => (JSON.parse(l) as { text: string }).text).filter((t) => t.startsWith("[Nexus] Queue")).map((t) => /step (\S+) \(/.exec(t)![1]!);
  const until = async (what: string, pred: () => boolean, ms = 20_000) => {
    for (const t = Date.now(); !pred();) {
      if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}; run ${JSON.stringify(queue().run)}; ${statuses()}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const revise = (defs: StepDef[]) => applyDraft(store, { id: "W", title: "Cliffs", stop_conditions: [], checks: [], steps: defs });
  const stop = () => { for (const e of engines) e.shutdown(); delete process.env.FAKE_SLOW_MS; };
  return { root, store, engine, queue, statuses, running, opened, until, revise, stop };
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: a run halted by a revision change mid-step: the step goes back to pending and runs again from the new start`, async () => {
    process.env.FAKE_SLOW_MS = "1500";
    const x = setup([step("W1", "done"), step("W4e", "slownoop"), step("W4f", "done")]);
    const e = x.engine();
    try {
      e.start("W", { runtime });
      await x.until("W4e at work", () => x.running().includes("W4e"));
      // A live run holds W4e: the orchestrator may not skip it.
      assert.throws(() => orchestratorStatusChange(x.store, { queue: "W", step: "W4e", to: "skipped", reason: "replaced" }), /W\/W4e is running: a step at work is not skipped/);

      // Revision 2 while W4e works (its turn then ends without an outcome).
      x.revise([step("W1", "done"), { ...step("W4e", "done"), title: "Step W4e, revised" }, step("W4f", "done")]);
      await x.until("the halt", () => x.queue().run?.state === "halted");
      assert.match(x.queue().run!.reason!, /revision changed and is not approved/);
      const q = x.queue();
      assert.equal(q.steps.find((s) => s.id === "W4e")!.status, "pending", "the open step goes back to pending");
      assert.equal(q.steps.find((s) => s.id === "W4e")!.reason, undefined);
      const c = q.changes.at(-1)!;
      assert.deepEqual([c.kind, c.by, c.step, c.from, c.to, c.reason, c.revision], ["status", "nexus", "W4e", "running", "pending", "its run was replaced by revision 2", 2]);
      assert.deepEqual(x.running(), []);

      approveQueue(x.store, "W");
      e.start("W", { runtime });
      let most = 0;
      await x.until("the run to finish", () => { most = Math.max(most, x.running().length); return x.queue().run?.state === "finished"; });
      assert.ok(most <= 1, "never two steps running");
      assert.deepEqual(x.opened(), ["W1", "W4e", "W4e", "W4f"], "the new start begins at W4e, the first pending step");
      assert.equal(x.statuses(), "W1=done W4e=done W4f=done");
      assert.equal(x.queue().status, "done");
    } finally { x.stop(); }
  });
}

/** The W4e shape: W4e opened under revision 1, revision 2 approved, and a run of revision 2 at W4f. */
function orphaned(x: ReturnType<typeof setup>) {
  const s = { protocol: 1 as const, id: "w1", project: "p", role: "worker" as const, runtime: "claude" as const, cwd: x.root, launched_by: "nexus" as const, created_at: new Date(Date.now() - 3_600_000).toISOString() };
  x.store.writeSession(s);
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  const emit = (minAgo: number, body: Record<string, unknown>) => x.store.appendEvent({ v: 1, id: newId(), at: at(minAgo), session: s.id, ...body } as Event);
  emit(50, { type: "step.started", queue: "W", step: "W1" });
  emit(45, { type: "step.done", queue: "W", step: "W1", summary: "ok" });
  emit(40, { type: "step.started", queue: "W", step: "W4e" });
  x.revise([step("W1", "done"), step("W4e", "done"), step("W4f", "done"), step("W5", "done")]);
  approveQueue(x.store, "W");
  emit(1, { type: "step.started", queue: "W", step: "W4f" }); // the new revision's run began at W4f
  x.store.writeRun("W", { protocol: 1, session: s.id, state: "halted", reason: "the session's process is not running", step: "W4f", started_at: at(2), updated_at: at(1), revision: 2 });
  assert.deepEqual(x.running(), ["W4e", "W4f"], "two steps running, as in Honeycomb");
}

test("an orphaned running step (the W4e shape) is cleaned at server start; a step a run of this revision has open stays", () => {
  const x = setup([step("W1", "done"), step("W4e", "done"), step("W4f", "done")]);
  try {
    orphaned(x);
    x.engine();
    assert.deepEqual(x.running(), ["W4f"], "W4e is pending; the run's own W4f stays open for resume");
    assert.equal(x.queue().steps.find((s) => s.id === "W4e")!.status, "pending");
    assert.deepEqual(x.queue().changes.filter((c) => c.by === "nexus").map((c) => [c.step, c.from, c.to]), [["W4e", "running", "pending"]]);
    x.engine();
    assert.equal(x.queue().changes.filter((c) => c.by === "nexus").length, 1, "once");
  } finally { x.stop(); }
});

test("an orphaned running step is cleaned at start, and the start begins there", async () => {
  const x = setup([step("W1", "done"), step("W4e", "done"), step("W4f", "done")]);
  const e = x.engine(); // before the orphan: this one's recovery saw nothing
  try {
    orphaned(x);
    e.start("W");
    await x.until("the run to finish", () => x.queue().run?.state === "finished");
    assert.deepEqual(x.opened(), ["W4e", "W4f", "W5"], "W4e first, as the first pending step; then W4f afresh");
    assert.equal(x.statuses(), "W1=done W4e=done W4f=done W5=done");
  } finally { x.stop(); }
});

test("a step opened by hand under the current revision, with no run, is left alone; the orchestrator may skip an orphan", () => {
  const x = setup([step("W1", "done"), step("W2", "done")]);
  try {
    const s = { protocol: 1 as const, id: "ext", project: "p", role: "worker" as const, runtime: "external" as const, cwd: x.root, launched_by: "external" as const, created_at: new Date().toISOString() };
    x.store.writeSession(s);
    x.store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: "ext", type: "step.started", queue: "W", step: "W1" } as Event);
    x.engine();
    assert.deepEqual(x.running(), ["W1"], "no revision change set it aside");
    // No live run holds it: skipping a running step is allowed then.
    assert.match(orchestratorStatusChange(x.store, { queue: "W", step: "W1", to: "skipped", reason: "done elsewhere" }), /W\/W1 skipped \(was running\)/);
  } finally { x.stop(); }
});
