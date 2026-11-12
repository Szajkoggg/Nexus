// The queue engine against fake runtimes (test/fake-claude.ts, test/fake-codex.ts): no model, no tokens. Every
// scenario runs with both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, addNote, answerAsUser, approveQueue, loadProjectState, routeAnswers, sendMessage, type StepDef,
} from "@nexus/protocol";
import { Engine } from "../src/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
const WINDOW = { claude: 1000, codex: 2000 } as const;

function setup(behaviours: string[]) {
  const root = mkdtempSync(join(tmpdir(), "nexus-engine-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const steps: StepDef[] = behaviours.map((b, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], history: [] });
  approveQueue(store, "Q");
  // The server calls onChange after every file change; here every engine notification does.
  const engine: Engine = new Engine(store, () => { routeAnswers(store); engine.onChange(loadProjectState(store)); });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; priority: string | null; busy: boolean }) : []);
  const until = async (what: string, pred: () => boolean, ms = 20_000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}; run: ${JSON.stringify(queue().run)}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return { store, engine, queue, received, until };
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: runs a queue to the end and puts each step's notes into its opening turn`, async () => {
    const { store, engine, queue, received, until } = setup(["done", "done"]);
    addNote(store, "Q", "Q2", "Keep the debris as it is.");
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished");
      const q = queue();
      assert.deepEqual(q.steps.map((s) => s.status), ["done", "done"]);
      assert.equal(q.status, "done");
      const turns = received().filter((m) => m.text.startsWith("[Nexus] Queue"));
      assert.equal(turns.length, 2);
      assert.match(turns[1]!.text, /step Q2 \(2 of 2\)[\s\S]*Keep the debris as it is\./);
      assert.doesNotMatch(turns[0]!.text, /Keep the debris/);
      assert.ok(q.steps[1]!.notes[0]!.read_at, "the note counts as delivered");
      const s = loadProjectState(store).sessions.find((x) => x.id === q.run!.session)!;
      assert.equal(s.live?.context_window, WINDOW[runtime]);
      assert.equal(s.runtime, runtime);
      assert.ok(s.native_id, "the runtime's own session id is recorded");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a turn without an outcome is nudged once, then the run halts`, async () => {
    const { store, engine, queue, received, until } = setup(["noop"]);
    try {
      engine.start("Q", { runtime });
      await until("the run to halt", () => queue().run?.state === "halted");
      assert.match(queue().run!.reason!, /without an outcome/);
      assert.equal(received().filter((m) => m.text.includes("has no outcome yet")).length, 1);
      assert.ok(loadProjectState(store).attention.some((a) => a.kind === "stopped" && a.queue === "Q"));
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a blocking question holds the queue until the answer arrives as the next turn`, async () => {
    const { store, engine, queue, received, until } = setup(["ask", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the question", () => queue().steps[0]!.status === "waiting");
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(queue().run?.state, "running", "waiting on a question is not a halt");
      assert.equal(queue().steps[1]!.status, "pending");
      const qid = loadProjectState(store).questions[0]!.qid;
      answerAsUser(store, qid, "Left.", true);
      engine.onChange(loadProjectState(store));
      await until("the run to finish", () => queue().run?.state === "finished");
      const answer = received().find((m) => m.text.startsWith("[Nexus] Answer"));
      assert.ok(answer);
      assert.match(answer.text, /Left\./);
      assert.equal(answer.priority, null, "an idle session gets the answer as a turn");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a message reaches a working turn as 'next', without interrupting it`, async () => {
    process.env.FAKE_SLOW_MS = "2500";
    const { store, engine, queue, received, until } = setup(["slow"]);
    try {
      engine.start("Q", { runtime });
      await until("the step to run", () => queue().steps[0]!.status === "running");
      sendMessage(store, queue().run!.session, "Use the grassland settings.", { queue: "Q", step: "Q1" });
      engine.onChange(loadProjectState(store));
      await until("the run to finish", () => queue().run?.state === "finished");
      const m = received().find((x) => x.text.includes("grassland"));
      assert.deepEqual([m?.priority, m?.busy], ["next", true]);
      assert.ok(queue().steps[0]!.messages[0]!.read_at, "the message counts as delivered");
    } finally { engine.shutdown(); delete process.env.FAKE_SLOW_MS; }
  });

  test(`${runtime}: a stop condition halts the run and the queue`, async () => {
    const { engine, queue, until } = setup(["stop", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the run to halt", () => queue().run?.state === "halted");
      assert.equal(queue().status, "stopped");
      assert.equal(queue().steps[1]!.status, "pending");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: pause takes effect after the running step; resume goes on`, async () => {
    process.env.FAKE_SLOW_MS = "1500";
    const { engine, queue, until } = setup(["slow", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the step to run", () => queue().steps[0]!.status === "running");
      engine.pause("Q");
      assert.equal(queue().run?.state, "pausing");
      await until("the pause", () => queue().run?.state === "paused");
      assert.deepEqual(queue().steps.map((s) => s.status), ["done", "pending"]);
      engine.resume("Q");
      await until("the run to finish", () => queue().run?.state === "finished");
    } finally { engine.shutdown(); delete process.env.FAKE_SLOW_MS; }
  });
}

test("model and effort reach Claude Code as flags, and are kept on the session", async () => {
  const { store, engine, queue, until } = setup(["done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  try {
    engine.start("Q", { runtime: "claude", model: "sonnet", effort: "high" });
    await until("the run to finish", () => queue().run?.state === "finished");
    const argv = (JSON.parse(readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n")[0]!) as { argv: string[] }).argv;
    assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
    assert.equal(argv[argv.indexOf("--effort") + 1], "high");
    const s = loadProjectState(store).sessions.find((x) => x.id === queue().run!.session)!;
    assert.deepEqual([s.model, s.effort], ["sonnet", "high"]);
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
});

test("Codex gets the effort on every turn and the project's reviewer when the thread starts; max is refused", async () => {
  const { store, engine, queue, until } = setup(["done", "done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  const p = store.readProject();
  store.writeProject({ ...p, runtimes: { ...p.runtimes, codex: { ...p.runtimes.codex, effort: "medium", approval_policy: "on-request", approvals_reviewer: "auto_review" } } });
  try {
    assert.throws(() => engine.start("Q", { runtime: "codex", effort: "max" }), /Codex takes effort/);
    engine.start("Q", { runtime: "codex" });
    await until("the run to finish", () => queue().run?.state === "finished");
    const calls = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(calls.filter((c) => c.method === "thread/start").map((c) => [c.approvalPolicy, c.approvalsReviewer]), [["on-request", "auto_review"]]);
    assert.deepEqual(calls.filter((c) => c.method === "turn/start").map((c) => c.effort), ["medium", "medium"]);
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
});

test("an unapproved revision cannot start", () => {
  const { store, engine } = setup(["done"]);
  const q = store.readQueue("Q");
  store.writeQueue({ ...q, steps: [...q.steps, { id: "Q9", title: "Added", goal: "", acceptance: [] }] });
  assert.throws(() => engine.start("Q"), /approve/);
  engine.shutdown();
});
