// The per-turn record (<NEXUS_HOME>/turns.jsonl, written by AgentHost for every role): one line per turn of a
// worker, an orchestrator and a thinking partner, with the outcome, tokens, cost and the usage windows known at the
// turn's start and end. Against the fake runtimes; no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, readTurns, readUsage, routeAnswers, type StepDef, type TurnRecord } from "@nexus/protocol";
import { Conversations } from "../src/conversations.ts";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

function setup(behaviours: string[] = ["done"]) {
  const root = mkdtempSync(join(tmpdir(), "nexus-turns-"));
  process.env.NEXUS_HOME = join(root, "home");
  delete process.env.FAKE_LOG;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const steps: StepDef[] = behaviours.map((b, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => tick(), { retryBaseMs: 60_000, usageMarginMs: 100 });
  const orchestrator = new Orchestrator(store, engine, () => tick());
  const conversations = new Conversations(store, orchestrator, () => tick());
  function tick() { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); }
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; turns: ${JSON.stringify(readTurns().entries)}`);
  const stop = () => { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); };
  return { store, engine, orchestrator, conversations, queue, until, stop };
}
const turnsOf = (role: TurnRecord["role"]) => readTurns().entries.filter((t) => t.role === role);

test("a worker's, an orchestrator's and a partner's turn each yield one record", async () => {
  process.env.FAKE_COST = "1";
  const { engine, orchestrator, conversations, queue, until, stop } = setup(["done"]);
  try {
    engine.start("Q", { runtime: "claude" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    orchestrator.say("Hello");
    await until("the orchestrator's turn", () => turnsOf("orchestrator").length === 1);
    const c = conversations.create({ title: "Mining" });
    conversations.say(c.id, "Let us think about mining.");
    await until("the partner's turn", () => turnsOf("conversation").length === 1);
    await new Promise((r) => setTimeout(r, 300));

    const [w] = turnsOf("worker");
    assert.equal(turnsOf("worker").length, 1);
    const run = queue().run!;
    assert.deepEqual(
      [w!.project, w!.session, w!.runtime, w!.model, w!.queue, w!.step, w!.outcome, w!.failure, w!.cost_usd],
      ["p", run.session, "claude", "fake-model", "Q", "Q1", "ok", undefined, 0.01],
    );
    assert.deepEqual(w!.tokens, { input: 10, output: 5, cache_read: 100, cache_creation: 1 }, "the turn's own tokens");
    assert.ok(w!.started_at && w!.started_at <= w!.at && w!.duration_ms! >= 0);
    assert.equal(w!.windows_start, undefined, "no usage data anywhere: the window fields stay empty");
    assert.equal(w!.windows_end, undefined);

    const [o] = turnsOf("orchestrator"), [p] = turnsOf("conversation");
    assert.deepEqual([o!.outcome, o!.queue, o!.step, o!.session], ["ok", undefined, undefined, orchestrator.session()!.id]);
    assert.deepEqual([p!.outcome, p!.session, p!.runtime], ["ok", c.id, "claude"]);
    assert.equal(readTurns().entries.length, 3, "one record per turn, no more");
    console.log("sample record:", JSON.stringify(w));
  } finally { stop(); delete process.env.FAKE_COST; }
});

test("a failed turn is recorded with its kind and code; a turn its process does not finish is marked interrupted", async () => {
  const a = setup(["auth"]);
  try {
    a.engine.start("Q", { runtime: "codex" });
    await a.until("the halt", () => a.queue().run?.state === "halted", LONGER.run);
    const [t] = turnsOf("worker");
    assert.deepEqual([t!.runtime, t!.outcome, t!.failure, t!.step], ["codex", "lasting", "unauthorized", "Q1"]);
  } finally { a.stop(); }

  process.env.FAKE_SLOW_MS = "5000";
  const b = setup(["slow"]);
  try {
    b.engine.start("Q", { runtime: "claude" });
    await b.until("the step to run", () => b.queue().steps[0]!.status === "running", LONGER.step);
    b.engine.shutdown(); // as an update's hand-over or a stop of the server: the process ends mid-turn
    await b.until("the record", () => turnsOf("worker").length === 1);
    const [t] = turnsOf("worker");
    assert.deepEqual([t!.outcome, t!.tokens, t!.cost_usd, t!.step], ["interrupted", undefined, undefined, "Q1"]);
  } finally { b.stop(); delete process.env.FAKE_SLOW_MS; }
});

test("an orchestrator's turn's usage windows reach usage.json, the usage pause sees them, and the records carry them", async () => {
  const { engine, orchestrator, queue, until, stop } = setup(["done"]);
  try {
    process.env.FAKE_USAGE = "0.95";
    orchestrator.say("Hello");
    await until("the orchestrator's turn", () => turnsOf("orchestrator").length === 1);
    assert.equal(readUsage()?.windows.five_hour?.utilization, 0.95, "the orchestrator's windows are in usage.json");
    const [o] = turnsOf("orchestrator");
    assert.equal(o!.windows_start, undefined, "nothing was known when its first turn began");
    assert.equal(o!.windows_end?.five_hour?.utilization, 0.95);
    assert.ok(o!.windows_end?.five_hour?.resets_at);

    delete process.env.FAKE_USAGE;
    engine.start("Q", { runtime: "claude" });
    await until("the usage wait", () => queue().run?.state === "usage_wait");
    assert.match(queue().run!.reason!, /5-hour window is at 95 %/);

    // A later turn's record has the windows known at its start too.
    orchestrator.say("Again");
    await until("the second turn", () => turnsOf("orchestrator").length === 2);
    assert.equal(turnsOf("orchestrator")[1]!.windows_start?.five_hour?.utilization, 0.95);
  } finally { stop(); delete process.env.FAKE_USAGE; }
});
