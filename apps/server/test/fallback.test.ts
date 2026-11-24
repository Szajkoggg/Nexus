// Fallback at a step boundary when a runtime's usage runs out (docs/protocol/runtimes.md, "Fallback when usage runs out"), against
// the fake runtimes and usage windows written into usage.json (or reported by the fake Claude Code's turn): the next
// step opens on the first free entry of its chain; a `wait` rule waits; back on its own runtime once the window reset
// (also without a fresh reading); a window never reported is free; Claude Code's 7-day window counts; both full: the
// earlier reset; the record in run.yaml, the step view and the turn record; the orchestrator told, but only into its
// inbox while Claude Code is full, and a level-2 review waiting meanwhile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, ensureUserSession, loadProjectState, newId, now, readTurns, readUsage, routeAnswers, writeUsage, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { QUICK_ENGINE, WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

type Step = Partial<StepDef> & { fake: string };
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;

function setup(steps: Step[], o: { orchestrator?: boolean; level?: 1 | 2 | 3 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-fallback-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  process.env.FAKE_ARGS = join(root, "args.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, runtimes: { codex: { model: "codex-default" } }, orchestrator: { notify: !!o.orchestrator } });
  store.writeQueue({
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", review_level: o.level, stop_conditions: [], checks: [], approvals: [], withdrawals: [], history: [],
    steps: steps.map(({ fake, ...s }, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${fake}`, acceptance: [], ...s })),
  });
  approveQueue(store, "Q");
  let orchestrator: Orchestrator | undefined;
  // Level 1: the user's review, accepted here at once (the test is not about review).
  const acceptOwn = () => {
    for (const st of loadProjectState(store).queues[0]!.steps) {
      if (o.level === 1 && st.status === "review" && st.review_with === "user") store.appendEvent({ v: 1, id: newId(), at: now(), session: ensureUserSession(store).id, type: "review.accepted", queue: "Q", step: st.id });
    }
  };
  const tick = () => { routeAnswers(store); acceptReviews(store); acceptOwn(); const s = loadProjectState(store); orchestrator?.onChange(s); engine.onChange(s); };
  const engine: Engine = new Engine(store, tick, { spawn: inProcessRuntime(), ...QUICK_ENGINE, retryBaseMs: 30, usageMarginMs: 100 });
  if (o.orchestrator) orchestrator = new Orchestrator(store, engine, tick, {}, { spawn: inProcessRuntime() });
  const timer = setInterval(tick, 150);
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const sessions = () => loadProjectState(store).sessions;
  const runtimes = () => queue().steps.map((s) => sessions().find((x) => x.id === s.session)?.runtime);
  const args = () => (existsSync(process.env.FAKE_ARGS!) ? readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>) : []);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; run: ${JSON.stringify(queue().run)}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
  const stop = () => { clearInterval(timer); orchestrator?.shutdown(); engine.shutdown(); delete process.env.FAKE_ARGS; delete process.env.FAKE_USAGE; delete process.env.FAKE_SLOW_MS; delete process.env.FAKE_REVIEW_ACCEPT; };
  return { store, engine, get orchestrator() { return orchestrator!; }, queue, runtimes, args, until, stop };
}

/** Claude Code's windows: the 5-hour and the 7-day one, as utilization and reset from now. */
const claude = (five: number, seven = 0.1, reset = HOUR) => ({
  five_hour: { utilization: five, resets_at: iso(reset) }, seven_day: { utilization: seven, resets_at: iso(reset + 24 * HOUR) },
});
const usage = (windows: Record<string, { utilization: number; resets_at?: string }>) => writeUsage({ updated_at: new Date().toISOString(), windows });

test("at a step boundary the next step opens on its fallback: recorded in run.yaml, the step view and the turn record; the orchestrator only in its inbox while Claude Code is full", async () => {
  const x = setup([{ fake: "done", kind: "mechanical" }, { fake: "done", kind: "mechanical" }], { orchestrator: true, level: 1 });
  try {
    x.orchestrator.say("Hello");
    await x.until("the orchestrator's first turn", () => readTurns().entries.some((t) => t.role === "orchestrator"));
    const orch = x.orchestrator.session()!.id;
    const turnsBefore = readTurns().entries.filter((t) => t.role === "orchestrator").length;
    process.env.FAKE_USAGE = "0.95"; // the fake Claude Code's turn reports its 5-hour window at 95 %
    x.engine.start("Q");
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.equal(readUsage()?.windows.five_hour?.utilization, 0.95, "Q1's turn reported the full window");
    assert.deepEqual(x.runtimes(), ["claude", "codex"], "Q1 on Claude Code, Q2 on its fallback");
    const f = x.queue().run!.fallbacks!;
    assert.equal(f.length, 1);
    assert.deepEqual([f[0]!.step, f[0]!.runtime, f[0]!.model, f[0]!.effort, f[0]!.from], ["Q2", "codex", "gpt-6-luna", "low", { runtime: "claude", model: "claude-sonnet-5-5", effort: "low" }]);
    assert.match(f[0]!.reason, /^Claude Code's 5-hour window at 95 % \(limit 90 %\)$/);
    assert.deepEqual(x.queue().steps[1]!.usage_switch, f[0], "the step view carries it");
    const q2 = readTurns().entries.filter((t) => t.role === "worker" && t.step === "Q2");
    assert.ok(q2.length && q2.every((t) => t.runtime === "codex" && t.fallback?.from === "claude" && /Claude Code's 5-hour window at 95 %/.test(t.fallback.reason)), JSON.stringify(q2));
    assert.ok(readTurns().entries.filter((t) => t.role === "worker" && t.step === "Q1").every((t) => !t.fallback));
    // The orchestrator: Claude Code is full, so the notice waits in its inbox and starts no turn.
    const notice = () => x.store.readInbox(orch).entries.find((m) => m.type === "message" && m.from === "nexus" && /Step Q2 of queue Q runs on its fallback, Codex, gpt-6-luna, low effort, instead of Claude Code/.test(m.text));
    await x.until("the notice in its inbox", () => !!notice());
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(readTurns().entries.filter((t) => t.role === "orchestrator").length, turnsBefore, "no turn while Claude Code is full");
    // Free again: it is told (from its inbox, once) and its turn starts.
    delete process.env.FAKE_USAGE;
    usage(claude(0.2));
    await x.until("told", () => x.orchestrator.view().chat.some((c) => /Step Q2 of queue Q runs on its fallback/.test(c.text)));
    await x.until("its turn", () => readTurns().entries.filter((t) => t.role === "orchestrator").length > turnsBefore);
    assert.ok(loadProjectState(x.store).sessions.find((s) => s.id === orch)!.inbox.find((m) => m.id === notice()!.id)?.read_at, "the inbox entry delivered");
  } finally { x.stop(); }
});

test("a wait rule waits for the window's reset; both runtimes full: the run waits for the one that resets first", async () => {
  const a = setup([{ fake: "done", kind: "design" }]);
  try {
    usage(claude(0.95));
    a.engine.start("Q");
    await a.until("the usage wait", () => a.queue().run?.state === "usage_wait");
    assert.match(a.queue().run!.reason!, /Claude Code's 5-hour window at 95 % \(limit 90 %\); its fallback is to wait/);
    assert.equal(a.queue().run!.resume_at, readUsage()!.windows.five_hour!.resets_at);
    assert.deepEqual([a.queue().steps[0]!.status, a.queue().run!.fallbacks], ["pending", undefined]);
  } finally { a.stop(); }
  const b = setup([{ fake: "done", kind: "mechanical" }]);
  try {
    usage({ ...claude(0.95, 0.1, 2 * HOUR), codex_5h: { utilization: 0.97, resets_at: iso(HOUR) } });
    b.engine.start("Q");
    await b.until("the usage wait", () => b.queue().run?.state === "usage_wait");
    assert.equal(b.queue().run!.resume_at, readUsage()!.windows.codex_5h!.resets_at, "the Codex window resets first");
    assert.match(b.queue().run!.reason!, /every runtime of the chain is beyond the limit/);
  } finally { b.stop(); }
});

test("back on its own runtime at the next boundary once the window reset, without a fresh reading; a window never reported is free", async () => {
  const x = setup([{ fake: "summaryslow", kind: "mechanical" }, { fake: "done", kind: "mechanical" }]);
  try {
    // The reset comes while Q1 works (well after the start, also on a busy machine), its turn outlasts it.
    process.env.FAKE_SLOW_MS = "6000";
    usage(claude(0.95, 0.1, 4000)); // no Codex window known: Codex counts as free
    x.engine.start("Q");
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.equal(readUsage()!.windows.five_hour!.utilization, 0.95, "no fresh reading: the window's reset time passed");
    assert.deepEqual(x.runtimes(), ["codex", "claude"]);
    const f = x.queue().run!.fallbacks!;
    assert.deepEqual(f.map((e) => [e.step, e.runtime, !!e.back]), [["Q1", "codex", false], ["Q2", "claude", true]]);
    assert.match(f[1]!.reason, /^its usage is below the limit again$/);
    const starts = x.args().filter((a) => a.argv).map((a) => (a.argv as string[])[(a.argv as string[]).indexOf("--model") + 1]);
    assert.deepEqual(starts, ["claude-sonnet-5-5"], "the Claude Code session it went back to runs on the kind's model");
  } finally { x.stop(); }
});

test("Claude Code's 7-day window counts too", async () => {
  const x = setup([{ fake: "done", kind: "mechanical" }]);
  try {
    usage(claude(0.1, 0.96));
    x.engine.start("Q");
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(x.runtimes(), ["codex"]);
    assert.match(x.queue().run!.fallbacks![0]!.reason, /Claude Code's 7-day window at 96 %/);
  } finally { x.stop(); }
});

test("a level-2 review waits while Claude Code is beyond the threshold, and goes on once it is free", async () => {
  const x = setup([{ fake: "done" }, { fake: "done" }], { orchestrator: true, level: 2 });
  try {
    process.env.FAKE_REVIEW_ACCEPT = "1"; // the fake orchestrator accepts a step waiting for its review
    usage(claude(0.95));
    x.engine.start("Q", { runtime: "codex" });
    await x.until("Q1 in the orchestrator's review", () => x.queue().steps[0]!.status === "review" && x.queue().steps[0]!.review_with === "orchestrator");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(x.queue().steps[0]!.status, "review", "it waits");
    assert.equal(readTurns().entries.filter((t) => t.role === "orchestrator").length, 0, "no orchestrator turn");
    assert.ok(x.orchestrator.session(), "a session exists for its inbox");
    assert.ok(x.store.readInbox(x.orchestrator.session()!.id).entries.some((m) => /Step Q1 of queue Q is done and waits for your review/.test(m.type === "message" ? m.text : "")));
    usage(claude(0.3));
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(x.queue().steps.map((s) => s.status), ["done", "done"]);
  } finally { x.stop(); }
});
