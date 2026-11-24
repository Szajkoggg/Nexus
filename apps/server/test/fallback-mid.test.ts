// Fallback in the middle of a step (docs/protocol/runtimes.md, "Fallback when usage runs out"), against the fake runtimes: before
// each kind of turn within a step (a nudge, a send-back, an answer, an inbox message) a runtime beyond the threshold
// hands the step to a fresh session on its fallback, seeded with the step's goal, progress, commits and uncommitted
// files, which stay in the checkout; a `wait` rule waits in the middle of the step; a turn that failed on the usage
// limit goes on on the next entry of the chain; a running turn is never cut off. The fake Claude Code reports its
// 5-hour window at FAKE_USAGE after each turn, which is how a window fills up while a step works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectStore, answerAsUser, approveQueue, ensureUserSession, loadProjectState, newId, now, readTurns, routeAnswers, sendBack, sendMessage, writeUsage, type StepDef,
} from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { QUICK_ENGINE, WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

type Step = Partial<StepDef> & { fake: string };
const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

function setup(steps: Step[], o: { level?: 1 | 2 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-fallback-mid-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const git = (...a: string[]) => execFileSync("git", [...G, ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".nexus/\nhome/\nfake*\n");
  git("add", "-A"); git("commit", "-qm", "init");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, runtimes: { codex: { model: "codex-default" } } });
  store.writeQueue({
    protocol: 1, id: "Q", title: "Queue", description: "Mid-step fallbacks.", revision: 1, status: "proposed", review_level: o.level, stop_conditions: [], checks: [],
    approvals: [], withdrawals: [], history: [],
    steps: steps.map(({ fake, ...s }, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${fake}`, acceptance: [], ...s })),
  });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); }, { spawn: inProcessRuntime(), ...QUICK_ENGINE, retryBaseMs: 30, usageMarginMs: 100 });
  const timer = setInterval(() => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); }, 150);
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const sessions = () => loadProjectState(store).sessions.filter((s) => s.role === "worker");
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; session: string | null }) : []);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; run: ${JSON.stringify(queue().run)}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
  const stop = () => { clearInterval(timer); engine.shutdown(); delete process.env.FAKE_USAGE; delete process.env.FAKE_SLOW_MS; delete process.env.FAKE_RESET_MS; delete process.env.FAKE_ASK_LINGER_MS; delete process.env.FAKE_SUMMARY_FAIL; delete process.env.FAKE_CONTEXT_FILL; };
  return { root, git, store, engine, queue, sessions, received, until, stop };
}

/** The step went on in a second session, on Codex, recorded as a usage switch and a fallback of the step. */
function assertSwitched(x: ReturnType<typeof setup>, step = "Q1") {
  const run = x.queue().run!;
  assert.deepEqual(x.sessions().map((s) => s.runtime), ["claude", "codex"]);
  assert.deepEqual(run.switches?.map((s) => [s.step, s.why]), [[step, "usage"]]);
  const f = run.fallbacks!.at(-1)!;
  assert.deepEqual([f.step, f.runtime, f.model, f.from.runtime], [step, "codex", "gpt-6-luna", "claude"]);
  const codex = x.sessions()[1]!;
  return x.received().filter((r) => r.session === codex.id).map((r) => r.text);
}

/**
 * The step's question is open and the turn that asked it is over (recorded, the session idle). An answer or a message
 * that comes while that turn still runs goes into it, on the same runtime, and is no turn of its own: no fallback then
 * (the test once raced the turn's end under load and found the step still waiting, or done on Claude Code).
 */
function askedTurnOver(x: ReturnType<typeof setup>): boolean {
  const s = x.sessions()[0];
  return !!s && loadProjectState(x.store).questions.some((q) => q.state === "open")
    && s.live?.state === "idle" && readTurns().entries.some((t) => t.session === s.id);
}

test("before a nudge: a fresh session on the fallback, given the goal, the progress, the commits and the uncommitted files, which stay", async () => {
  const x = setup([{ fake: "partial", kind: "mechanical" }]);
  try {
    process.env.FAKE_USAGE = "0.95"; // Claude Code's turn reports its 5-hour window at 95 %
    x.engine.start("Q");
    await x.until("the step done", () => x.queue().steps[0]!.status === "done" || x.queue().steps[0]!.status === "failed", LONGER.run);
    assert.equal(x.queue().steps[0]!.summary, "fake finished Q1: kept the uncommitted work", "the uncommitted changes stayed in the checkout");
    const [first] = assertSwitched(x);
    assert.match(first!, /^\[Nexus\] You take over step Q1 of queue Q "Queue" in a fresh session, in the middle of the step: Claude Code's 5-hour window at 95 % \(limit 90 %\), so the step goes on on Codex\./);
    assert.match(first!, /Its progress so far:\n- half way \(50 %\)/);
    assert.match(first!, /Its commits so far, oldest first:\n- [0-9a-f]+ Q1 first half/);
    assert.match(first!, /Uncommitted changes it left in the checkout \(git status\)[^\n]*Keep them[^\n]*\n.*Q1-a\.txt\n.*\?\? Q1-b\.txt/);
    assert.match(first!, /\[Nexus\] Queue Q "Queue" \(revision 1, approved\), step Q1 \(1 of 1\): Step 1\.\nContinue this step where it was left/);
    assert.match(first!, /Goal:\nFAKE: partial/);
    assert.ok(!x.received().some((r) => /ended without an outcome/.test(r.text)), "no nudge went to the full runtime");
    assert.equal(readFileSync(join(x.root, "Q1-a.txt"), "utf8"), "first\nsecond\n");
  } finally { x.stop(); }
});

test("answers release the waiting step on its fallback; a message alone cannot bypass an open question", async () => {
  const a = setup([{ fake: "ask1", kind: "mechanical" }]);
  try {
    process.env.FAKE_USAGE = "0.95";
    process.env.FAKE_ASK_LINGER_MS = "500"; // the question comes well before its turn's end
    a.engine.start("Q");
    await a.until("the question, its turn over", () => askedTurnOver(a));
    answerAsUser(a.store, loadProjectState(a.store).questions[0]!.qid, "The left one.");
    await a.until("the step done", () => a.queue().steps[0]!.status === "done", LONGER.run);
    const [first] = assertSwitched(a);
    assert.match(first!, /Messages that came for the previous session and were not read yet:\n\n\[Nexus\] Answer/);
    assert.match(first!, /The left one\./);
  } finally { a.stop(); }
  const m = setup([{ fake: "ask1", kind: "mechanical" }]);
  try {
    process.env.FAKE_USAGE = "0.95";
    process.env.FAKE_ASK_LINGER_MS = "500"; // the question comes well before its turn's end
    m.engine.start("Q");
    await m.until("the question, its turn over", () => askedTurnOver(m));
    sendMessage(m.store, m.queue().run!.session, "Use the new colours.", { queue: "Q", step: "Q1" });
    const before = m.received().length;
    await new Promise(r => setTimeout(r, 500));
    assert.equal(m.received().length, before, "the message waits with the unanswered question");
    assert.equal(m.sessions().length, 1, "no fallback work starts before the answer");
    assert.equal(m.queue().steps[0]!.status, "waiting");
    answerAsUser(m.store, loadProjectState(m.store).questions[0]!.qid, "The right one.");
    await m.until("the step done", () => m.queue().steps[0]!.status === "done", LONGER.run);
    const [first] = assertSwitched(m);
    assert.match(first!, /Message from the user[^\n]*\nUse the new colours\./);
    assert.match(first!, /The right one\./);
  } finally { m.stop(); }
});

test("before a send-back (a fix): the next round runs on the fallback in a fresh session", async () => {
  const x = setup([{ fake: "done", kind: "mechanical" }], { level: 1 });
  try {
    process.env.FAKE_USAGE = "0.95";
    x.engine.start("Q");
    // Its turn over (a send-back during the turn goes into that turn, on the same runtime).
    await x.until("the user's review, the turn over", () => x.queue().steps[0]!.status === "review" && x.sessions()[0]?.live?.state === "idle" && x.store.readGit("Q")?.steps.Q1?.[0]?.ended_at !== undefined);
    sendBack(x.store, { queue: "Q", step: "Q1", from: "user", text: "The button is too small." });
    await x.until("the second round in review", () => x.queue().steps[0]!.status === "review" && x.sessions().length === 2, LONGER.run);
    const [first] = assertSwitched(x);
    assert.match(first!, /The button is too small\./);
    assert.equal(x.store.readGit("Q")!.steps.Q1!.length >= 2, true, "the send-back opened a new round");
    const user = ensureUserSession(x.store).id;
    x.store.appendEvent({ v: 1, id: newId(), at: now(), session: user, type: "review.accepted", queue: "Q", step: "Q1" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
  } finally { x.stop(); }
});

test("a wait rule waits in the middle of the step; the same session goes on after the reset", async () => {
  const x = setup([{ fake: "partial", kind: "design" }]);
  try {
    process.env.FAKE_USAGE = "0.95";
    x.engine.start("Q");
    await x.until("the usage wait", () => x.queue().run?.state === "usage_wait", LONGER.run);
    const run = x.queue().run!;
    assert.match(run.reason!, /Claude Code's 5-hour window at 95 % \(limit 90 %\); its fallback is to wait/);
    assert.deepEqual([x.queue().steps[0]!.status, x.sessions().length, run.switches], ["running", 1, undefined]);
    assert.ok(!x.received().some((r) => /ended without an outcome/.test(r.text)), "no nudge");
    // The window resets (usage.json says so; the fake reports it free from now on): the same session continues.
    delete process.env.FAKE_USAGE;
    writeUsage({ updated_at: new Date().toISOString(), windows: { five_hour: { utilization: 0.1, resets_at: new Date(Date.now() + 3_600_000).toISOString() } } });
    x.engine.resume("Q", "the usage window reset");
    await x.until("the step done", () => x.queue().steps[0]!.status === "done", LONGER.run);
    assert.equal(x.sessions().length, 1, "no fallback, no new session");
  } finally { x.stop(); }
});

test("a turn that failed on the usage limit goes on on the next entry of the chain", async () => {
  const x = setup([{ fake: "limit1", kind: "mechanical" }]);
  try {
    process.env.FAKE_RESET_MS = String(3_600_000);
    x.engine.start("Q");
    await x.until("the step done", () => x.queue().steps[0]!.status === "done", LONGER.run);
    assertSwitched(x);
    assert.match(x.queue().run!.fallbacks![0]!.reason, /^the usage limit was reached \(rate_limit: /);
    assert.equal(x.queue().run!.state === "usage_wait", false);
    assert.ok(readTurns().entries.some((t) => t.runtime === "claude" && t.outcome === "usage"));
  } finally { x.stop(); }
});

test("the summary request's turn failing on the usage limit at a step boundary: the done step stays done, the next one opens on the fallback (queue LF, F2)", async () => {
  const x = setup([{ fake: "done", kind: "mechanical" }, { fake: "done", kind: "mechanical" }]);
  try {
    process.env.FAKE_CONTEXT_FILL = "0.9"; // beyond the threshold (80 % of the fake's window): the summary is asked for
    process.env.FAKE_SUMMARY_FAIL = "limit";
    process.env.FAKE_RESET_MS = String(3_600_000);
    x.engine.start("Q");
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const q = x.queue();
    assert.deepEqual(q.steps.map((s) => s.status), ["done", "done"]);
    assert.deepEqual(q.run!.switches?.map((s) => [s.step, s.why, s.summary]), [["Q2", "runtime", "fallback"]], "no usage switch of the done step Q1");
    assert.deepEqual(x.sessions().map((s) => s.runtime), ["claude", "codex"]);
    assert.equal(q.steps[1]!.session, x.sessions()[1]!.id, "Q2 ran on the fallback's fresh session");
    const codex = x.received().filter((r) => r.session === x.sessions()[1]!.id).map((r) => r.text);
    assert.ok(!codex.some((t) => /step Q1/.test(t) && /continue|take over/i.test(t)), `Q1 was not opened again: ${JSON.stringify(codex.map((t) => t.slice(0, 120)))}`);
    assert.deepEqual(q.run!.fallbacks?.map((f) => [f.step, f.runtime]), [["Q2", "codex"]]);
  } finally { x.stop(); }
});

test("a running turn is never cut off: the window fills during it, the step ends where it runs", async () => {
  const x = setup([{ fake: "slow", kind: "mechanical" }]);
  try {
    process.env.FAKE_SLOW_MS = "2500";
    x.engine.start("Q");
    await x.until("the turn at work", () => x.queue().steps[0]!.status === "running" && x.sessions()[0]?.live?.state === "working");
    writeUsage({ updated_at: new Date().toISOString(), windows: { five_hour: { utilization: 0.97, resets_at: new Date(Date.now() + 3_600_000).toISOString() } } });
    sendMessage(x.store, x.queue().run!.session, "A note while you work.", { queue: "Q", step: "Q1" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual([x.sessions().length, x.queue().run!.switches, x.queue().run!.fallbacks], [1, undefined, undefined]);
  } finally { x.stop(); }
});
