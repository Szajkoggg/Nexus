// Review decisions with the agents (queue RVD, RVD3), against both fake runtimes: the worker declares its list with
// `nexus decide` before `nexus step done` and then waits; the review helper answers the reviewer's decision, is
// refused the user's, and hands the step to the user; the orchestrator answers at level 3 provisionally; only a
// lawful acceptance starts the next step, whose opening carries the decisions. A worker never answers, and a review
// decision is no question: nothing reaches the worker while its review is open. The rules: packages/protocol/test/
// review-decisions.test.ts; the CLI's refusals: packages/cli/test/decide.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, answerDecision, applyDraft, approveQueue, currentAnswer, loadProjectState, routeAnswers, updateSettings, type StepDef } from "@nexus/protocol";
import { cliRun } from "../../../packages/cli/test/run-cli.ts";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { QUICK_ENGINE, LONGER, WAIT_MS, until as waitUntil } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

function setup(runtime: "claude" | "codex") {
  const root = mkdtempSync(join(tmpdir(), "nexus-decide-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  delete process.env.FAKE_REVIEW_ACCEPT;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.markReviewDecisions(new Date(Date.now() - 60_000).toISOString());
  updateSettings(store, { review_helper: { runtime, model: null, effort: null } });
  const spawn = inProcessRuntime();
  const engine: Engine = new Engine(store, () => tick(), { spawn, ...QUICK_ENGINE });
  const orchestrator: Orchestrator = new Orchestrator(store, engine, () => tick(), {}, { spawn, helpers: { spawn } });
  function tick() { routeAnswers(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const step = (q: string, s: string) => state().queues.find((x) => x.id === q)!.steps.find((x) => x.id === s)!;
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; steps: ${state().queues.flatMap((q) => q.steps.map((s) => `${s.id}=${s.status}/${s.review_with ?? "-"}/${s.helper?.state ?? "-"}`)).join(" ")}; warnings: ${state().warnings.slice(-3).join(" | ")}`);
  const delivered = () => existsSync(process.env.FAKE_LOG!)
    ? readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { text: string; session: string | null }) : [];
  const to = (session: string) => delivered().filter((d) => d.session === session).map((d) => d.text);
  /** `nexus <args>` as the session `session`. */
  const nexus = (session: string, ...args: string[]) => cliRun(args, { env: { ...process.env, NEXUS_SESSION: session, NEXUS_DIR: store.dir }, cwd: root });
  const run = async (id: string, steps: Partial<StepDef>[], level: 2 | 3) => {
    if (!orchestrator.session()) {
      orchestrator.say("Hello");
      await until("the orchestrator's session", () => !!orchestrator.session());
    }
    applyDraft(store, {
      id, title: "Decided", review_level: level,
      steps: steps.map((s, i) => ({ id: `${id}${i + 1}`, title: `Step ${i + 1}`, goal: "FAKE: done", acceptance: [`Criterion ${i + 1}`], ...s })),
    });
    approveQueue(store, id);
    engine.start(id, { runtime });
  };
  const stop = () => { clearInterval(timer); engine.shutdown(); orchestrator.shutdown(); };
  return { store, engine, orchestrator, state, step, until, to, nexus, run, tick, stop };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A design step's two decisions: the user's layout (bound to its pictures) and a reviewer's technical choice. */
const DECISIONS = [
  'FAKE-DECIDE: ["Which layout?","--option","A","--option","B","--recommend","B","--for","user","--material","layout@492","--why","The panel keeps it."]',
  'FAKE-DECIDE: ["Keep the cache?","--option","keep","--option","drop","--fix-option","drop","--for","reviewer"]',
].join("\n");

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: level 2: the helper answers the reviewer's decision and hands the user's over; the worker waits; only the user's lawful Accept starts the next step, which gets the answers`, async () => {
    const x = setup(runtime);
    try {
      await x.run("R", [{ goal: `FAKE: done FAKE-HELPER: decide\n${DECISIONS}` }, { goal: "FAKE: done FAKE-HELPER: accept" }], 2);
      await x.until("R1 waits for the user", () => x.step("R", "R1").status === "review" && x.step("R", "R1").review_with === "user", LONGER.run);
      const r1 = x.step("R", "R1");
      const worker = r1.session!;
      assert.equal(r1.decision_list, "declared");
      const [d1, d2] = r1.decisions.items;
      assert.deepEqual([d1!.id, d1!.for, d1!.recommended, d1!.material, d2!.id, d2!.for], ["D1", "user", "B", ["layout@492"], "D2", "reviewer"]);
      assert.deepEqual(d2!.options.map((o) => o.effect ?? null), [null, "fix"]);
      // The helper answered the reviewer's decision with its reasons, was refused the user's, and handed the step over.
      assert.equal(currentAnswer(d2!, 1)?.by, "helper");
      assert.equal(currentAnswer(d2!, 1)?.choice, "keep");
      assert.equal(currentAnswer(d1!, 1), undefined, "no helper answer to the user's decision");
      const helper = x.state().sessions.find((s) => s.role === "helper")!;
      assert.equal(helper.runtime, runtime, "the helper runs on the runtime under test");
      const packet = readFileSync(join(x.store.sessionDir(helper.id), "packet.md"), "utf8");
      for (const part of ["Review decisions:", "D1 (version 1, the user's, by the worker): Which layout?", "options: \"A\", \"B\" (recommended)", "material: layout@492", "only the user answers it", "D2 (version 1, a reviewer's", "\"drop\" (asks for a change)", "nexus review decide R R1 <decision>", "nexus review ask-user R R1"]) {
        assert.ok(packet.includes(part), `the packet has ${JSON.stringify(part)}:\n${packet}`);
      }
      assert.ok(x.state().warnings.every((w) => !w.includes("review.decided")), "the refused answer was never written");
      // The worker waits: nothing reaches it while the review is open, and it may neither answer nor accept.
      const seen = x.to(worker).length;
      const answered = await x.nexus(worker, "review", "decide", "R", "R1", "D1", "--choice", "B", "--reason", "mine");
      assert.equal(answered.status, 2);
      assert.match(answered.stderr, /a worker proposes decisions \(nexus decide\), it never answers them/);
      const late = await x.nexus(worker, "decide", "R1", "Another?", "--option", "x", "--option", "y");
      assert.match(late.stderr, /is not at work: its worker declares its decisions before step.done/);
      assert.throws(() => x.engine.acceptReview("R", "R1"), /1 decision is open: D1 \(not answered\)/);
      x.tick(); await sleep(600);
      assert.equal(x.to(worker).length, seen, "no turn for the worker during its review");
      assert.equal(x.step("R", "R2").status, "pending");
      // The user answers (a saved answer is no acceptance), then accepts: the next step starts with the decisions.
      const a1 = answerDecision(x.store, { queue: "R", step: "R1", decision: "D1", version: 1, round: 1, choice: "A", text: "denser" }).answer;
      x.tick(); await sleep(400);
      assert.equal(x.step("R", "R2").status, "pending", "an answer starts nothing");
      x.engine.acceptReview("R", "R1", undefined, undefined, { D1: a1, D2: currentAnswer(d2!, 1)!.event });
      await x.until("the run to finish", () => x.state().queues.find((q) => q.id === "R")?.run?.state === "finished", LONGER.run);
      const opening = x.to(x.step("R", "R2").session!).find((t) => t.includes("step R2 (2 of 2)"))!;
      assert.ok(opening.includes(`Decisions from earlier reviews (build on them):\n- R1, D1 "Which layout?": "A" (denser), by the user\n- R1, D2 "Keep the cache?": "keep" (fake helper: D2 settled by the evidence), by the review helper`), opening);
      // A step declared none by itself (the fake's default): its review needs no answer.
      assert.equal(x.step("R", "R2").decision_list, "none");
      assert.equal(x.step("R", "R2").accepted?.by, "helper");
      assert.equal(x.state().questions.length, 0, "no decision became a question");
    } finally { x.stop(); }
  });

  test(`${runtime}: a question at work and the review's decisions stay apart: the answer releases the worker and settles no decision`, async () => {
    const x = setup(runtime);
    try {
      await x.run("Q", [{ goal: `FAKE: ask1\n${DECISIONS}` }, { goal: "FAKE: done" }], 2);
      await x.until("Q1 in review", () => x.step("Q", "Q1").status === "review", LONGER.run);
      const [question] = x.state().questions;
      assert.equal(question?.answers.at(-1)?.text, "fake answer", "the orchestrator answered the question; the worker went on");
      const q1 = x.step("Q", "Q1");
      assert.deepEqual(q1.decisions.items.map((d) => [d.id, d.answers.length]), [["D1", 0], ["D2", 0]], "the question's answer settles no decision");
      // A question in the round: Nexus passes the step on without a helper, and the orchestrator's notice lists both.
      await x.until("passed on", () => x.step("Q", "Q1").helper?.state === "passed_on", LONGER.step);
      assert.deepEqual(x.step("Q", "Q1").helper?.reasons, ["question"]);
      const orch = x.orchestrator.session()!.id;
      // Level 2: the orchestrator answers the reviewer's decision, is refused the user's, and hands it over.
      assert.equal((await x.nexus(orch, "review", "decide", "Q", "Q1", "D2", "--choice", "keep", "--reason", "fresh")).status, 0);
      assert.match((await x.nexus(orch, "review", "decide", "Q", "Q1", "D1", "--choice", "A", "--reason", "mine")).stderr, /decision D1 is the user's and step Q1 is at review level 2 with away mode off: hand it to the user/);
      assert.match((await x.nexus(orch, "review", "accept", "Q", "Q1")).stderr, /1 decision is open: D1 \(not answered\)/);
      assert.equal((await x.nexus(orch, "review", "ask-user", "Q", "Q1", "D1 is the user's layout")).status, 0);
      assert.equal(x.step("Q", "Q1").review_with, "user");
      assert.equal(x.step("Q", "Q2").status, "pending");
    } finally { x.stop(); }
  });

  test(`${runtime}: level 3: the orchestrator's acceptance waits for the decisions; it answers the user's provisionally, accepts provisionally, and the next step gets the answer marked provisional`, async () => {
    const x = setup(runtime);
    try {
      await x.run("T", [{ goal: `FAKE: done\n${DECISIONS}` }, { goal: "FAKE: done" }], 3);
      // The helper passes level 3 on; the orchestrator's notice lists the decisions and who answers them.
      await x.until("T1 passed on to the orchestrator", () => x.step("T", "T1").helper?.state === "passed_on", LONGER.run);
      const orch = x.orchestrator.session()!.id;
      await x.until("the review notice", () => x.to(orch).some((t) => t.includes("Step T1 of queue T is done and waits for your review")), LONGER.step);
      const notice = x.to(orch).find((t) => t.includes("Step T1 of queue T is done and waits for your review"))!;
      for (const part of ["Review decisions:", "D1 (version 1, the user's", "the orchestrator answers it provisionally", "D2 (version 1, a reviewer's", "nexus review decide T T1 <decision>"]) {
        assert.ok(notice.includes(part), `the notice has ${JSON.stringify(part)}:\n${notice}`);
      }
      const held = await x.nexus(orch, "review", "provisional", "T", "T1", "--note", "look at the layout");
      assert.match(held.stderr, /cannot be accepted yet: 2 decisions are open: D1 \(not answered\), D2 \(not answered\)/);
      const fix = await x.nexus(orch, "review", "decide", "T", "T1", "D2", "--choice", "drop", "--reason", "the cache is stale");
      assert.equal(fix.status, 0, fix.stderr);
      assert.match((await x.nexus(orch, "review", "provisional", "T", "T1")).stderr, /the answer "drop" asks for a change/);
      assert.equal((await x.nexus(orch, "review", "decide", "T", "T1", "D2", "--choice", "keep", "--reason", "measured: fresh")).status, 0);
      const d1 = await x.nexus(orch, "review", "decide", "T", "T1", "D1", "--choice", "B", "--reason", "as recommended; the user confirms");
      assert.match(d1.stdout, /answered "B" provisionally/);
      assert.equal(x.step("T", "T2").status, "pending", "answers start nothing");
      assert.equal((await x.nexus(orch, "review", "provisional", "T", "T1", "--note", "the layout")).status, 0);
      assert.equal(x.step("T", "T1").status, "done");
      await x.until("T2 opened", () => !!x.step("T", "T2").session && x.to(x.step("T", "T2").session!).some((t) => t.includes("step T2 (2 of 2)")), LONGER.run);
      const opening = x.to(x.step("T", "T2").session!).find((t) => t.includes("step T2 (2 of 2)"))!;
      assert.ok(opening.includes(`- T1, D1 "Which layout?": "B" (as recommended; the user confirms), by the orchestrator, provisional: the user has not confirmed it yet`), opening);
      assert.ok(opening.includes(`- T1, D2 "Keep the cache?": "keep" (measured: fresh), by the orchestrator`), opening);
    } finally { x.stop(); }
  });
}
