// Runtime, model and effort per step, against the fake runtimes: a step on another runtime runs in a fresh session
// seeded like context care's; another model or effort keeps the session (Claude Code restarts its process with
// --resume, Codex takes them per turn); a step without its own values runs on the run's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionError, ProjectStore, applyDraft, approveQueue, loadProjectState, routeAnswers, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

interface Received { text: string; session: string | null }
type Step = Partial<StepDef> & { fake: string };

function setup(steps: Step[]) {
  const root = mkdtempSync(join(tmpdir(), "nexus-stepvalues-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "args.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, runtimes: { codex: { model: "codex-default" } } });
  store.writeQueue({
    protocol: 1, id: "Q", title: "Queue", description: "Mixed runtimes.", revision: 1, status: "proposed",
    stop_conditions: [], checks: [], approvals: [], withdrawals: [], history: [],
    steps: steps.map(({ fake, ...s }, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${fake}`, acceptance: [], ...s })),
  });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100 });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const lines = <T>(f: string): T[] => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as T) : []);
  const received = () => lines<Received>(process.env.FAKE_LOG!);
  const args = () => lines<Record<string, any>>(process.env.FAKE_ARGS!);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; run: ${JSON.stringify(queue().run)}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
  const done = () => { engine.shutdown(); delete process.env.FAKE_ARGS; };
  return { store, engine, queue, received, args, until, done };
}

/** A Claude Code process's --model and --effort, and whether it resumed. */
const claudeStart = (a: Record<string, any>) => {
  const argv = a.argv as string[];
  const opt = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  return { resume: argv.includes("--resume"), model: opt("--model"), effort: opt("--effort") };
};

test("a codex step after a claude step runs in a codex session seeded with the summary; the next step without fields goes back to Claude Code", async () => {
  const { store, engine, queue, received, args, until, done } = setup([{ fake: "summary" }, { fake: "summary", runtime: "codex" }, { fake: "done" }]);
  try {
    engine.start("Q", { runtime: "claude", model: "opus", effort: "high" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const q = queue();
    const sessions = loadProjectState(store).sessions;
    const of = (i: number) => sessions.find((s) => s.id === q.steps[i]!.session)!;
    assert.deepEqual([0, 1, 2].map((i) => of(i).runtime), ["claude", "codex", "claude"]);
    assert.equal(new Set(q.steps.map((s) => s.session)).size, 3, "going back to a runtime used before is a fresh session too");
    // The codex step takes the project's codex defaults (the run's model belongs to Claude Code); the third step the run's.
    assert.deepEqual([of(1).model, of(1).effort], ["codex-default", undefined]);
    assert.deepEqual([of(2).model, of(2).effort], ["opus", "high"]);
    assert.deepEqual([q.run!.runtime, q.run!.model, q.run!.effort], ["claude", "opus", "high"]);
    assert.deepEqual(q.run!.switches?.map((s) => [s.step, s.why, s.summary]), [["Q2", "runtime", "written"], ["Q3", "runtime", "written"]]);
    assert.equal(of(1).continues, of(0).id);
    assert.equal(of(2).continues, of(1).id);
    const opening = received().find((m) => m.session === of(1).id)!;
    assert.match(opening.text, /^\[Nexus\] You take over queue Q "Queue" in a fresh session: step Q2 runs on Codex/);
    assert.match(opening.text, /context summary at the end of Q1:\nfake summary of Q1/);
    assert.match(opening.text, /step Q2 \(2 of 3\)/);
    assert.match(received().find((m) => m.session === of(2).id)!.text, /context summary at the end of Q2:\nfake summary of Q2/);
    const thread = args().find((a) => a.method === "thread/start")!;
    assert.equal(thread.model, "codex-default");
  } finally { done(); }
});

test("claude: a step on haiku keeps the session (the process resumes on haiku), and the next step goes back to the run's model", async () => {
  const { store, engine, queue, args, until, done } = setup([{ fake: "done" }, { fake: "done", model: "haiku", effort: "low" }, { fake: "done" }]);
  try {
    engine.start("Q", { runtime: "claude", model: "opus", effort: "high" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const q = queue();
    assert.equal(new Set(q.steps.map((s) => s.session)).size, 1, "one session throughout");
    assert.equal(q.run!.switches, undefined);
    const starts = args().filter((a) => a.argv).map(claudeStart);
    assert.deepEqual(starts, [
      { resume: false, model: "opus", effort: "high" },
      { resume: true, model: "haiku", effort: "low" },
      { resume: true, model: "opus", effort: "high" },
    ]);
    const s = loadProjectState(store).sessions.find((x) => x.id === q.run!.session)!;
    assert.deepEqual([s.model, s.effort], ["opus", "high"]);
    assert.ok(s.native_id && q.steps.every((st) => st.session === s.id));
  } finally { done(); }
});

test("codex: a step on another model keeps the thread and names its model and effort per turn, then goes back", async () => {
  const { engine, queue, args, until, done } = setup([{ fake: "done" }, { fake: "done", model: "gpt-6-luna", effort: "low" }, { fake: "done" }]);
  try {
    engine.start("Q", { runtime: "codex", model: "gpt-6-astra", effort: "high" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    const q = queue();
    assert.equal(new Set(q.steps.map((s) => s.session)).size, 1);
    assert.equal(args().filter((a) => a.method === "thread/start" || a.method === "thread/resume").length, 1, "one thread, never restarted");
    const turns = args().filter((a) => a.method === "turn/start").map((a) => [a.model, a.effort]);
    assert.deepEqual(turns, [[null, "high"], ["gpt-6-luna", "low"], ["gpt-6-astra", "high"]]);
  } finally { done(); }
});

test("invalid values are refused at draft", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-stepvalues-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const draft = (step: Record<string, unknown>) => applyDraft(store, { id: "D", title: "D", steps: [{ id: "D1", title: "One", ...step }] });
  assert.throws(() => draft({ runtime: "claude", effort: "ultra" }), (e: Error) => e instanceof ActionError && /step D1: Claude Code takes effort low, medium, high, xhigh, max/.test(e.message));
  assert.throws(() => draft({ runtime: "gemini" }), /steps\.0\.runtime/);
  assert.throws(() => draft({ effort: "extreme" }), /steps\.0\.effort/);
  assert.throws(() => draft({ model: "" }), /steps\.0\.model/);
  // Settled only by the run: ultra without a runtime may be meant for a Codex run.
  assert.match(draft({ effort: "ultra" }), /created/);
  assert.match(draft({ runtime: "codex", model: "gpt-6-luna", effort: "ultra" }), /updated/);
});

test("an invalid combination refuses the start with the reason", async () => {
  const { engine, queue, until, done } = setup([{ fake: "done" }, { fake: "done", effort: "ultra" }]);
  try {
    assert.throws(() => engine.start("Q", { runtime: "claude" }), /step Q2 would run on Claude Code at effort ultra: Claude Code takes effort/);
    assert.equal(queue().run, undefined, "nothing started");
    // On a Codex run the same step is fine.
    engine.start("Q", { runtime: "codex" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
  } finally { done(); }
});
