// A worker whose start is being corrected when the user acts (queue LCR, LC-F1 and LC-F2 at the role): its record
// claims a conversation the runtime never saved, so after an update's restart Claude Code refuses the resume and the
// adapter starts it afresh once (queue RN). Held at that refusal (FakeGates), the user's Stop at once and pause stay in
// force: no later event of the corrected start lifts them, no work follows, and only the user's explicit Continue goes
// on; a message that reaches the worker meanwhile goes into its step once, and each step opens once. The paths of
// stop-at-once.test.ts and engine.test.ts (pause), with the fakes in this process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { answerAsUser, loadProjectState, sendMessage } from "@nexus/protocol";
import type { Engine } from "../src/engine.ts";
import { FakeGates, type FakeHeld } from "./fake-behaviour.ts";
import { restart, setup } from "./engine-setup.ts";
import { LONGER, holdWork, holds, until } from "./wait.ts";

/**
 * A worker run whose session's record claims a saved conversation the fake never saved, restarted as after an update,
 * its resume held at the refusal (the corrected start not begun). `starts` lists each start's session flag.
 */
async function correcting(behaviours: string[], gates: FakeGates) {
  process.env.FAKE_START_MS = "60000"; // the first process never reads its step: nothing is saved
  const x = setup(behaviours);
  const args = join(dirname(process.env.FAKE_LOG!), "args.log");
  process.env.FAKE_ARGS = args;
  const starts = () => existsSync(args) ? readFileSync(args, "utf8").split("\n").filter(Boolean).map((l) => {
    const argv = (JSON.parse(l) as { argv: string[] }).argv;
    return argv.find((a) => a === "--resume" || a === "--session-id")!;
  }) : [];
  x.engine.start("Q", { runtime: "claude" });
  const session = x.queue().run!.session;
  await x.until("the first start", () => starts().length === 1);
  x.engine.drainForUpdate(true);
  await x.until("the process to exit", () => x.store.readRuntime(session)?.state === "exited");
  x.engine.shutdown();
  delete process.env.FAKE_START_MS;
  x.store.writeRuntime(session, { ...x.store.readRuntime(session)!, conversation_saved: true });
  process.env.FAKE_GATES = gates.id;
  const next = restart(x.store);
  let held: FakeHeld | undefined;
  void gates.reached("refusal").then((h) => { held = h; });
  await x.until("the resume held at its refusal", () => !!held);
  /** How many times the step's turn was opened, by step. */
  const opened = (step: string) => x.received().filter((m) => m.text.includes(`step ${step} (`)).length;
  return { ...x, session, next, held: held!, starts, opened };
}

function cleanup(gates: FakeGates, engines: (Engine | undefined)[]): void {
  for (const e of engines) e?.shutdown();
  gates.dispose();
  delete process.env.FAKE_GATES;
  delete process.env.FAKE_ARGS;
  delete process.env.FAKE_START_MS;
}

test("claude worker: Stop at once while its start is corrected ends it with no corrective start; it stays paused until Continue, which runs the step once", async () => {
  const gates = new FakeGates(["refusal"]);
  const work = holdWork();
  let x: Awaited<ReturnType<typeof correcting>> | undefined;
  try {
    x = await correcting(["slow"], gates);
    const w = x;
    const stopping = w.next.stopAtOnce("Q");
    assert.equal(w.queue().run?.state, "paused");
    await stopping;
    w.held.release(); // the refused process is gone: its refusal comes to nothing
    await holds("paused, no other start, nothing received", () => w.queue().run?.state === "paused" && w.starts().length === 2 && w.received().length === 0, 300);
    assert.deepEqual(w.starts(), ["--session-id", "--resume"]);
    assert.equal(w.store.readRuntime(w.session)?.state, "exited");
    assert.equal(w.queue().steps[0]!.status, "pending", "no process read the step: it never started");
    w.next.resume("Q");
    // The record still claims the conversation (the refusal never said otherwise): refused again, corrected once.
    (await gates.reached("refusal")).release();
    await w.until("the step at work", () => w.opened("Q1") === 1, LONGER.step);
    work.release();
    await w.until("the run to finish", () => w.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(w.starts(), ["--session-id", "--resume", "--resume", "--session-id"]);
    assert.equal(w.opened("Q1"), 1, "the step opened once");
    assert.deepEqual(w.queue().steps.map((st) => st.status), ["done"]);
  } finally { cleanup(gates, [x?.engine, x?.next]); work.done(); }
});

test("claude worker: a pause while its start is corrected takes effect after the step; no later event lifts it, and Continue runs the next step once", async () => {
  const gates = new FakeGates(["refusal"]);
  const work = holdWork();
  let x: Awaited<ReturnType<typeof correcting>> | undefined;
  try {
    x = await correcting(["slow", "done"], gates);
    const w = x;
    w.next.pause("Q");
    assert.equal(w.queue().run?.state, "pausing");
    w.held.release();
    await w.until("the step at work in the corrected start", () => w.opened("Q1") === 1, LONGER.step);
    work.release();
    await w.until("the pause", () => w.queue().run?.state === "paused", LONGER.step);
    await holds("paused, the next step not opened", () => w.queue().run?.state === "paused" && w.opened("Q2") === 0, 300);
    assert.deepEqual(w.starts(), ["--session-id", "--resume", "--session-id"]);
    assert.deepEqual(w.queue().steps.map((st) => st.status), ["done", "pending"]);
    w.next.resume("Q");
    await w.until("the run to finish", () => w.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual([w.opened("Q1"), w.opened("Q2")], [1, 1]);
    assert.deepEqual(w.queue().steps.map((st) => st.status), ["done", "done"]);
  } finally { cleanup(gates, [x?.engine, x?.next]); work.done(); }
});

test("claude worker: a message sent to it while its start is corrected goes into the step's turn once, as a next message, and each step opens once", async () => {
  const gates = new FakeGates(["refusal"]);
  const work = holdWork();
  let x: Awaited<ReturnType<typeof correcting>> | undefined;
  try {
    x = await correcting(["slow", "done"], gates);
    const w = x;
    sendMessage(w.store, w.session, "INBOX-LCR4: a note for the running step");
    w.next.onChange(loadProjectState(w.store));
    w.held.release();
    await w.until("the message taken in", () => w.received().some((m) => m.text.includes("INBOX-LCR4")), LONGER.step);
    work.release();
    await w.until("the run to finish", () => w.queue().run?.state === "finished", LONGER.run);
    const notes = w.received().filter((m) => m.text.includes("INBOX-LCR4"));
    assert.equal(notes.length, 1, "the message once");
    assert.equal(notes[0]!.priority, "next");
    assert.equal(notes[0]!.busy, true, "read inside the step's turn");
    const texts = w.received().map((m) => m.text);
    assert.ok(texts.findIndex((t) => t.includes("step Q1 (")) < texts.findIndex((t) => t.includes("INBOX-LCR4")));
    assert.deepEqual([w.opened("Q1"), w.opened("Q2")], [1, 1]);
    assert.deepEqual(w.starts(), ["--session-id", "--resume", "--session-id"]);
    assert.deepEqual(w.queue().steps.map((st) => st.status), ["done", "done"]);
  } finally { cleanup(gates, [x?.engine, x?.next]); work.done(); }
});

// ---------------------------------------------------------------- an answer while the start is corrected

/**
 * A worker whose step asked a blocking question (FAKE: ask1), restarted as after an update with its record saying
 * unsaved though its conversation was saved: the new engine starts its process for the waiting run, Claude Code refuses
 * the fresh start ("already in use"), and that refusal is held, so the corrected start (a resume) has not begun.
 */
async function askedAndCorrecting(gates: FakeGates) {
  const x = setup(["ask1", "done"]);
  const args = join(dirname(process.env.FAKE_LOG!), "args.log");
  process.env.FAKE_ARGS = args;
  const starts = () => existsSync(args) ? readFileSync(args, "utf8").split("\n").filter(Boolean).map((l) => {
    const argv = (JSON.parse(l) as { argv: string[] }).argv;
    return argv.find((a) => a === "--resume" || a === "--session-id")!;
  }) : [];
  x.engine.start("Q", { runtime: "claude" });
  await x.until("the question", () => loadProjectState(x.store).questions.length === 1, LONGER.step);
  const session = x.queue().run!.session;
  const qid = loadProjectState(x.store).questions[0]!.qid;
  await x.until("the asking turn's end", () => x.store.readRuntime(session)?.state === "idle" && x.store.readRuntime(session)?.turns === 1);
  x.engine.drainForUpdate(true);
  x.engine.shutdown();
  await x.until("the process to exit", () => x.store.readRuntime(session)?.state === "exited");
  x.store.writeRuntime(session, { ...x.store.readRuntime(session)!, conversation_saved: false });
  process.env.FAKE_GATES = gates.id;
  const next = restart(x.store);
  let held: FakeHeld | undefined;
  void gates.reached("refusal").then((h) => { held = h; });
  await x.until("the new process's start held at its refusal", () => !!held);
  const opened = (step: string) => x.received().filter((m) => m.text.includes(`step ${step} (`)).length;
  const answers = () => x.received().filter((m) => m.text.includes(qid));
  return { ...x, session, qid, next, held: held!, starts, opened, answers };
}

test("claude worker: an answer (go on) that arrives while its start is corrected reaches the step's turn once, with its qid; the step opens once and the turns count as expected", async () => {
  const gates = new FakeGates(["refusal"]);
  let x: Awaited<ReturnType<typeof askedAndCorrecting>> | undefined;
  try {
    x = await askedAndCorrecting(gates);
    const w = x;
    answerAsUser(w.store, w.qid, "ANSWER-LCR4: take the first way", true);
    w.next.onChange(loadProjectState(w.store));
    assert.deepEqual(w.answers(), [], "held with the refused start: nothing read yet");
    w.held.release();
    await w.until("the run to finish", () => w.queue().run?.state === "finished", LONGER.run);
    assert.equal(w.answers().length, 1, "the answer once");
    assert.match(w.answers()[0]!.text, /ANSWER-LCR4: take the first way/);
    assert.deepEqual([w.opened("Q1"), w.opened("Q2")], [1, 1]);
    // The first engine's start, the refused fresh start, the corrected resume (which answers and runs Q2).
    assert.deepEqual(w.starts(), ["--session-id", "--session-id", "--resume"]);
    // The asking turn, the answer's turn, Q2's turn.
    assert.equal(w.store.readRuntime(w.session)?.turns, 3);
    assert.equal(w.store.readRuntime(w.session)?.conversation_saved, true);
    assert.deepEqual(w.queue().steps.map((st) => st.status), ["done", "done"]);
  } finally { cleanup(gates, [x?.engine, x?.next]); }
});

test("claude worker: an answer that asks to wait, arriving while its start is corrected, is not delivered and the run does not go on until Resume; then once, with its qid", async () => {
  const gates = new FakeGates(["refusal"]);
  let x: Awaited<ReturnType<typeof askedAndCorrecting>> | undefined;
  try {
    x = await askedAndCorrecting(gates);
    const w = x;
    answerAsUser(w.store, w.qid, "ANSWER-LCR4: wait for me", false);
    w.next.onChange(loadProjectState(w.store));
    w.held.release();
    await w.until("the corrected start", () => w.starts().length === 3);
    await holds("the answer held, no step opened, the run not finished", () => w.answers().length === 0 && w.opened("Q2") === 0 && w.queue().run?.state !== "finished", 300);
    assert.equal(w.store.readRuntime(w.session)?.turns, 1, "no turn since the question");
    w.next.resume("Q");
    await w.until("the run to finish", () => w.queue().run?.state === "finished", LONGER.run);
    assert.equal(w.answers().length, 1, "the answer once");
    assert.match(w.answers()[0]!.text, /ANSWER-LCR4: wait for me/);
    assert.deepEqual([w.opened("Q1"), w.opened("Q2")], [1, 1]);
    assert.deepEqual(w.starts(), ["--session-id", "--session-id", "--resume"]);
    assert.equal(w.store.readRuntime(w.session)?.turns, 3);
    assert.deepEqual(w.queue().steps.map((st) => st.status), ["done", "done"]);
  } finally { cleanup(gates, [x?.engine, x?.next]); }
});
