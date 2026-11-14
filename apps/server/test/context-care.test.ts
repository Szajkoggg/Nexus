// Context care against the fake runtimes: at the end of a step whose session's context is fuller than the project's
// threshold, the next step runs in a fresh session seeded with the context summary. The fakes report the context fill
// FAKE_CONTEXT_FILL asks for (fake-behaviour.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers, sendMessage, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

interface Received { text: string; priority: string | null; busy: boolean; session: string | null }

function setup(behaviours: string[], opts: { fill: number; care?: boolean; noSummary?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "nexus-care-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_CONTEXT_FILL = String(opts.fill);
  if (opts.noSummary) process.env.FAKE_NO_SUMMARY = "1"; else delete process.env.FAKE_NO_SUMMARY;
  const store = ProjectStore.init(root, { id: "p", name: "P", root, defaults: { context_care: opts.care ?? true, context_reuse_threshold: 0.6 } });
  const steps: StepDef[] = behaviours.map((b, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
  store.writeQueue({
    protocol: 1, id: "Q", title: "Queue", description: "The queue's own description: fracture the rock.", revision: 1, status: "proposed",
    stop_conditions: [], checks: [], steps, approvals: [], withdrawals: [], history: [],
  });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100 });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const received = (): Received[] => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Received) : []);
  const until = async (what: string, pred: () => boolean, ms = 20_000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}; run: ${JSON.stringify(queue().run)}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const done = () => { engine.shutdown(); delete process.env.FAKE_CONTEXT_FILL; delete process.env.FAKE_NO_SUMMARY; delete process.env.FAKE_SLOW_MS; };
  return { store, engine, queue, received, until, done };
}

const asks = (r: Received[]) => r.filter((m) => m.text.includes("write your context summary"));

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: above the threshold the next step runs in a fresh session seeded with the summary`, async () => {
    const { store, engine, queue, received, until, done } = setup(["summary", "done"], { fill: 0.8 });
    try {
      engine.start("Q", { runtime, model: "fake-model-x", effort: "low" });
      await until("the run to finish", () => queue().run?.state === "finished");
      const q = queue();
      const [first, second] = q.steps.map((s) => s.session!);
      assert.ok(first && second);
      assert.notEqual(first, second, "the second step ran in another session");
      assert.equal(q.run!.session, second, "run.yaml points to the new session");
      assert.deepEqual(q.run!.switches?.map((s) => [s.from, s.to, s.step, s.summary, s.fill]), [[first, second, "Q2", "written", 0.8]]);
      assert.equal(asks(received()).length, 0, "a fresh summary needs no asking");

      const sessions = loadProjectState(store).sessions;
      const old = sessions.find((s) => s.id === first)!, fresh = sessions.find((s) => s.id === second)!;
      assert.equal(old.continued_by, second);
      assert.equal(fresh.continues, first);
      assert.deepEqual([fresh.runtime, fresh.model, fresh.effort, fresh.cwd], [old.runtime, old.model, old.effort, old.cwd]);
      assert.notEqual(fresh.native_id, old.native_id);

      const opening = received().find((m) => m.session === second)!;
      assert.match(opening.text, /^\[Nexus\] You take over queue Q "Queue" in a fresh session[\s\S]*80% full/);
      assert.match(opening.text, /context summary at the end of Q1:\nfake summary of Q1\nTopics: fake, context/);
      assert.match(opening.text, /The queue's own description: fracture the rock\./);
      assert.match(opening.text, /- Q1 Step 1: done\. fake finished Q1\n- Q2 Step 2: yours now/);
      assert.match(opening.text, /\[Nexus\] Queue Q "Queue" \(revision 1, approved\), step Q2 \(2 of 2\)/);
      await until("the old process to end", () => loadProjectState(store).sessions.find((s) => s.id === first)?.live?.state === "exited");
    } finally { done(); }
  });

  test(`${runtime}: below the threshold the next step runs in the same session`, async () => {
    const { engine, queue, received, until, done } = setup(["summary", "done"], { fill: 0.5 });
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished");
      const q = queue();
      assert.equal(q.steps[0]!.session, q.steps[1]!.session);
      assert.equal(q.run!.switches, undefined);
      assert.equal(asks(received()).length, 0);
    } finally { done(); }
  });

  test(`${runtime}: a missing summary is asked for once, and the fresh session gets what was written then`, async () => {
    const { engine, queue, received, until, done } = setup(["done", "done"], { fill: 0.8 });
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished");
      const q = queue();
      assert.equal(asks(received()).length, 1);
      assert.equal(asks(received())[0]!.session, q.steps[0]!.session, "the old session is asked");
      assert.equal(q.run!.switches?.[0]?.summary, "asked");
      const opening = received().find((m) => m.session === q.steps[1]!.session)!;
      assert.match(opening.text, /context summary at the end of Q1:\nfake summary of Q1, on request/);
    } finally { done(); }
  });

  test(`${runtime}: a summary still missing after asking falls back to the queue and its finished steps`, async () => {
    const { engine, queue, received, until, done } = setup(["done", "done", "done"], { fill: 0.8, noSummary: true });
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished");
      const q = queue();
      // Asked once at the end of each step that has a next step (Q1 in the first session, Q2 in the second).
      assert.deepEqual(asks(received()).map((m) => m.session), [q.steps[0]!.session, q.steps[1]!.session]);
      assert.deepEqual(q.run!.switches?.map((s) => [s.step, s.summary]), [["Q2", "fallback"], ["Q3", "fallback"]]);
      assert.equal(new Set(q.steps.map((s) => s.session)).size, 3);
      const opening = received().find((m) => m.session === q.steps[2]!.session)!;
      assert.match(opening.text, /left no context summary of Q2/);
      assert.match(opening.text, /The queue's own description/);
      assert.match(opening.text, /- Q1 Step 1: done\. fake finished Q1\n- Q2 Step 2: done\. fake finished Q2\n- Q3 Step 3: yours now/);
      assert.doesNotMatch(opening.text, /fake summary/);
    } finally { done(); }
  });

  test(`${runtime}: a message unread at the switch reaches the new session's first turn`, async () => {
    process.env.FAKE_SLOW_MS = "1500";
    const { store, engine, queue, received, until, done } = setup(["summaryslow", "done"], { fill: 0.8 });
    try {
      engine.start("Q", { runtime });
      // Accepted at once, while the step's turn still runs (the summary comes slowly).
      await until("Q1 in review", () => queue().steps[0]!.status === "review");
      acceptReviews(store);
      await until("Q1 to be done", () => queue().steps[0]!.status === "done");
      // Written to the old session's inbox while its turn still runs, and not handed over (no onChange) before the
      // turn ends: unread when the switch comes.
      const old = queue().run!.session;
      sendMessage(store, old, "Use the grassland settings.", { queue: "Q", step: "Q1" });
      await until("the run to finish", () => queue().run?.state === "finished");
      const q = queue();
      assert.notEqual(q.steps[1]!.session, old);
      assert.equal(received().filter((m) => m.session === old && m.text.includes("grassland")).length, 0, "the old session never got it");
      const opening = received().find((m) => m.session === q.steps[1]!.session)!;
      assert.match(opening.text, /step Q2 \(2 of 2\)[\s\S]*not read yet:\n\n\[Nexus\] Message from the user about step Q1:\nUse the grassland settings\./);
      const msg = loadProjectState(store).sessions.find((s) => s.id === old)!.inbox[0]!;
      assert.ok(msg.read_at, "the carried message counts as delivered");
      const delivered = store.readDelivered(old).entries.find((d) => d.id === msg.id);
      assert.deepEqual([delivered?.via, delivered?.to], ["carried", q.steps[1]!.session]);
    } finally { done(); }
  });

  test(`${runtime}: with context care off a full session goes on`, async () => {
    const { engine, queue, received, until, done } = setup(["done", "done"], { fill: 0.9, care: false });
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished");
      const q = queue();
      assert.equal(q.steps[0]!.session, q.steps[1]!.session);
      assert.equal(q.run!.switches, undefined);
      assert.equal(asks(received()).length, 0);
    } finally { done(); }
  });
}
