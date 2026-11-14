// A step a revision change left open (queue RV, the W case of Project Honeycomb): an orphan an earlier server left
// (the W4e shape: no run record holds it) goes back to pending through a changes entry by Nexus, at start and at server
// start, so a start runs it again; the orchestrator may skip a running step no live run holds. A run going on across a
// revision change is approval-wait.test.ts. Fakes only.
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
import { acceptReviews } from "./fake-reviewer.ts";

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
    const e: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); e.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100 });
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
