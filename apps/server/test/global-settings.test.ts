// Effective settings in running sessions, against the fake runtimes (GS2): what a run took from the project's
// defaults is resolved again at each step, what its start chose stays; other changed settings reach a worker at its
// next step and a thinking partner at its next message. The global settings file is <NEXUS_HOME>/settings.yaml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, builtInSettings, loadProjectState, readGlobalSettings, routeAnswers, writeGlobalSettings, type GlobalSettings, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

type Step = Partial<StepDef> & { fake: string };

function setup(steps: Step[]) {
  const root = mkdtempSync(join(tmpdir(), "nexus-global-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "args.log");
  process.env.FAKE_SLOW_MS = "1500";
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], withdrawals: [], history: [],
    steps: steps.map(({ fake, ...s }, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${fake}`, acceptance: [], ...s })),
  });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); engine.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100 });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const args = () => (existsSync(process.env.FAKE_ARGS!) ? readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>) : []);
  const until = async (what: string, pred: () => boolean, ms = 30_000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}; run: ${JSON.stringify(queue().run)}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const done = () => { engine.shutdown(); delete process.env.FAKE_ARGS; delete process.env.FAKE_SLOW_MS; };
  return { store, engine, queue, args, until, done };
}

/** Changes the global settings, as the server's global settings page will. */
const setGlobal = (change: (g: GlobalSettings) => void) => { const g = readGlobalSettings(); change(g); writeGlobalSettings(g); };

/** A Claude Code process's start: resumed or not, and the value of an option. */
const claudeStart = (a: Record<string, any>) => {
  const argv = a.argv as string[];
  const opt = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  return { resume: argv.includes("--resume"), model: opt("--model"), effort: opt("--effort"), permission: opt("--permission-mode") };
};

test("claude: a changed global model reaches a running queue that took the default, at its next step", async () => {
  const x = setup([{ fake: "slow" }, { fake: "done" }]);
  try {
    setGlobal((g) => { g.runtimes.claude.model = "fake-old"; });
    x.engine.start("Q", { runtime: "claude" });
    assert.deepEqual(x.queue().run!.from_defaults, ["model", "effort"], "the start chose the runtime only");
    await x.until("Q1 to run", () => x.queue().steps[0]!.status === "running");
    setGlobal((g) => { g.runtimes.claude.model = "fake-new"; });
    await x.until("the run to finish", () => x.queue().run?.state === "finished");
    const starts = x.args().filter((a) => a.argv).map(claudeStart);
    assert.deepEqual(starts.map((s) => [s.resume, s.model]), [[false, "fake-old"], [true, "fake-new"]], "the session resumed on the new model for Q2");
    assert.equal(new Set(x.queue().steps.map((s) => s.session)).size, 1, "the same session");
    assert.equal(x.queue().run!.model, "fake-old", "the run's record keeps what its start resolved");
  } finally { x.done(); }
});

test("codex: a changed global model reaches the next step's turn on the same thread", async () => {
  const x = setup([{ fake: "slow" }, { fake: "done" }]);
  try {
    setGlobal((g) => { g.runtimes.codex.model = "codex-old"; });
    x.engine.start("Q", { runtime: "codex" });
    await x.until("Q1 to run", () => x.queue().steps[0]!.status === "running");
    setGlobal((g) => { g.runtimes.codex.model = "codex-new"; });
    await x.until("the run to finish", () => x.queue().run?.state === "finished");
    assert.equal(x.args().filter((a) => a.method === "thread/start" || a.method === "thread/resume").length, 1, "one thread, never restarted");
    assert.deepEqual(x.args().filter((a) => a.method === "turn/start").map((a) => a.model), [null, "codex-new"]);
  } finally { x.done(); }
});

test("a run started with an explicit model keeps it when the global model changes", async () => {
  const x = setup([{ fake: "slow" }, { fake: "done" }]);
  try {
    x.engine.start("Q", { runtime: "claude", model: "opus" });
    assert.deepEqual(x.queue().run!.from_defaults, ["effort"]);
    await x.until("Q1 to run", () => x.queue().steps[0]!.status === "running");
    setGlobal((g) => { g.runtimes.claude.model = "fake-new"; });
    await x.until("the run to finish", () => x.queue().run?.state === "finished");
    assert.deepEqual(x.args().filter((a) => a.argv).map(claudeStart).map((s) => s.model), ["opus"], "one process, on opus throughout");
  } finally { x.done(); }
});

test("a project's own value wins over the global one, also at the next step", async () => {
  const x = setup([{ fake: "slow" }, { fake: "done" }]);
  try {
    x.store.updateProject((p) => ({ ...p, runtimes: { ...p.runtimes, claude: { ...p.runtimes.claude, model: "project-own" } } }));
    x.engine.start("Q", { runtime: "claude" });
    await x.until("Q1 to run", () => x.queue().steps[0]!.status === "running");
    setGlobal((g) => { g.runtimes.claude.model = "fake-new"; });
    await x.until("the run to finish", () => x.queue().run?.state === "finished");
    assert.deepEqual(x.args().filter((a) => a.argv).map(claudeStart).map((s) => s.model), ["project-own"]);
  } finally { x.done(); }
});

test("a changed default that makes a step's effort invalid halts the step with the reason", async () => {
  const x = setup([{ fake: "slow" }, { fake: "done", effort: "ultra" }]);
  try {
    setGlobal((g) => { g.runtimes.default = "codex"; });
    x.engine.start("Q"); // the runtime from the defaults: Codex, which takes ultra
    assert.deepEqual(x.queue().run!.from_defaults, ["runtime", "model", "effort"]);
    await x.until("Q1 to run", () => x.queue().steps[0]!.status === "running");
    setGlobal((g) => { g.runtimes.default = "claude"; });
    await x.until("the halt", () => x.queue().run?.state === "halted");
    assert.match(x.queue().run!.reason!, /^step Q2: Claude Code takes effort low, medium, high, xhigh, max/);
    assert.equal(x.queue().steps[1]!.status, "pending", "the step did not open");
  } finally { x.done(); }
});

test("other changed settings reach a worker at its next step: a new permission mode restarts its process", async () => {
  const x = setup([{ fake: "slow" }, { fake: "done" }]);
  try {
    x.engine.start("Q", { runtime: "claude", model: "opus" });
    await x.until("Q1 to run", () => x.queue().steps[0]!.status === "running");
    setGlobal((g) => { g.runtimes.claude.permission_mode = "auto"; });
    await x.until("the run to finish", () => x.queue().run?.state === "finished");
    const starts = x.args().filter((a) => a.argv).map(claudeStart);
    assert.deepEqual(starts.map((s) => [s.resume, s.permission, s.model]), [[false, "acceptEdits", "opus"], [true, "auto", "opus"]]);
  } finally { x.done(); }
});

test("a thinking partner follows the conversation settings from its next message; one with its own model keeps it", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-global-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_ARGS = join(root, "args.log");
  delete process.env.FAKE_LOG;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const engine = new Engine(store, () => {});
  const orchestrator = new Orchestrator(store, engine, () => {});
  const conversations = new Conversations(store, orchestrator, () => {});
  const args = () => (existsSync(process.env.FAKE_ARGS!) ? readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>) : []);
  const until = async (what: string, pred: () => boolean) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > 20_000) assert.fail(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); } };
  const replies = (id: string) => store.readChat(id).entries.filter((e) => e.from === "partner").length;
  try {
    const follows = conversations.create({ title: "Follows" });
    const own = conversations.create({ title: "Own", model: "own-model" });
    assert.equal(follows.model, undefined, "no model of its own");
    conversations.say(follows.id, "first");
    conversations.say(own.id, "first");
    await until("both replies", () => replies(follows.id) === 1 && replies(own.id) === 1);
    setGlobal((g) => { g.conversations.model = "partner-new"; });
    conversations.say(follows.id, "second");
    conversations.say(own.id, "second");
    await until("both second replies", () => replies(follows.id) === 2 && replies(own.id) === 2);
    const models = (id: string) => args().filter((a) => a.argv && (a.argv as string[]).join(" ").includes(store.readSession(id).native_id!)).map((a) => claudeStart(a).model);
    assert.deepEqual(models(follows.id), [null, "partner-new"], "a new process on the new model, for the next message");
    assert.deepEqual(models(own.id), ["own-model"], "its own model: the same process");
  } finally { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); delete process.env.FAKE_ARGS; }
});

test("the global file starts as the built-in defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-global-"));
  process.env.NEXUS_HOME = join(root, "home");
  assert.deepEqual(readGlobalSettings(), builtInSettings());
});

test("the orchestrator follows its model from the project's effective settings from its next message", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-global-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_ARGS = join(root, "args.log");
  delete process.env.FAKE_LOG;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const engine = new Engine(store, () => {});
  const orchestrator = new Orchestrator(store, engine, () => {});
  const args = () => (existsSync(process.env.FAKE_ARGS!) ? readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>) : []);
  const until = async (what: string, pred: () => boolean) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > 20_000) assert.fail(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); } };
  const replies = () => orchestrator.view().chat.filter((c) => c.from === "orchestrator" && c.kind !== "tool").length;
  try {
    orchestrator.say("first");
    await until("the first reply", () => replies() === 1);
    assert.deepEqual(store.readStoredProject().orchestrator, { session: store.readProject().orchestrator!.session }, "its section follows the global settings");
    setGlobal((g) => { g.orchestrator.model = "orch-new"; });
    orchestrator.say("second");
    await until("the second reply", () => replies() === 2);
    assert.deepEqual(args().filter((a) => a.argv).map((a) => claudeStart(a).model), [null, "orch-new"]);
    assert.equal(store.readSession(store.readProject().orchestrator!.session!).model, "orch-new", "its session records the model it runs on");
  } finally { orchestrator.shutdown(); engine.shutdown(); delete process.env.FAKE_ARGS; }
});
