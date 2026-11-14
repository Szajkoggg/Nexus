// What each role's runtime record (sessions/<id>/runtime.json) holds after a turn, against the fake runtimes. Written
// before the agent processes moved onto AgentHost (queue R2), from what the engine, the orchestrator and the
// conversations recorded then: the move must not change it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers, type RuntimeFile } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";
import { acceptReviews } from "./fake-reviewer.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-records-"));
  process.env.NEXUS_HOME = join(root, "home");
  delete process.env.FAKE_LOG;
  delete process.env.FAKE_ARGS;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100 });
  const orchestrator = new Orchestrator(store, engine, () => {});
  const conversations = new Conversations(store, orchestrator, () => {});
  const until = async (what: string, pred: () => boolean, ms = 20_000) => {
    const t = Date.now();
    while (!pred()) { if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); }
  };
  const stop = () => { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); };
  return { store, engine, orchestrator, conversations, until, stop };
}

/** The record's fields, sorted, with the values that do not vary (pid and updated_at do). */
function shape(r: RuntimeFile | undefined): Record<string, unknown> {
  assert.ok(r, "the session has a runtime record");
  assert.equal(typeof r.pid, "number", "the process id is recorded");
  assert.ok(r.updated_at);
  const { pid: _pid, updated_at: _at, ...rest } = r;
  return Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
}

const CONTEXT = {
  claude: { context_tokens: 100, context_window: 1000, model: "fake-model" },
  codex: { context_tokens: 120, context_window: 2000, model: "fake-codex-model" },
} as const;

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime} worker: the runtime record counts turns, keeps the cost (Claude) and ends exited`, async () => {
    const { store, engine, until, stop } = setup();
    try {
      store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "Step 1", goal: "FAKE: done", acceptance: [] }], approvals: [], history: [] });
      approveQueue(store, "Q");
      const run = engine.start("Q", { runtime });
      await until("the run to finish and its process to exit", () => store.readRun("Q")?.state === "finished" && store.readRuntime(run.session)?.state === "exited");
      assert.deepEqual(shape(store.readRuntime(run.session)), {
        ...CONTEXT[runtime], ...(runtime === "claude" ? { cost_usd: 0 } : {}), state: "exited", turns: 1,
      });
    } finally { stop(); }
  });
}

test("claude orchestrator: the runtime record keeps the cost and counts no turns", async () => {
  const { store, orchestrator, until, stop } = setup();
  try {
    orchestrator.say("Hello");
    const id = () => store.readProject().orchestrator?.session;
    await until("the reply", () => !!id() && orchestrator.view().chat.some((c) => c.from === "orchestrator") && store.readRuntime(id()!)?.state === "idle");
    assert.deepEqual(shape(store.readRuntime(id()!)), { ...CONTEXT.claude, cost_usd: 0, state: "idle", turns: 0 });
  } finally { stop(); }
});

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime} conversation: the record is working during a turn, so idle means the turn is over`, async () => {
    process.env.FAKE_CHAT_SLOW_MS = "2000";
    const { store, conversations, until, stop } = setup();
    try {
      const c = conversations.create({ title: "Talk", runtime });
      conversations.say(c.id, "FAKE-SLOW");
      await until("the turn at work", () => conversations.view(c.id).chat.some((x) => x.kind === "tool"));
      assert.equal(store.readRuntime(c.id)?.state, "working");
      await until("the reply", () => conversations.view(c.id).chat.some((x) => x.from === "partner" && x.kind === "message") && store.readRuntime(c.id)?.state === "idle");
    } finally { stop(); delete process.env.FAKE_CHAT_SLOW_MS; }
  });

  test(`${runtime} conversation: the runtime record has no cost and counts no turns`, async () => {
    const { store, conversations, until, stop } = setup();
    try {
      const c = conversations.create({ title: "Talk", runtime });
      conversations.say(c.id, "Hello");
      await until("the reply", () => conversations.view(c.id).chat.some((x) => x.from === "partner") && store.readRuntime(c.id)?.state === "idle");
      assert.deepEqual(shape(store.readRuntime(c.id)), { ...CONTEXT[runtime], state: "idle", turns: 0 });
    } finally { stop(); }
  });
}
