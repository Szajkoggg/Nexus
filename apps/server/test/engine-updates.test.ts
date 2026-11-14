// Updates of Nexus itself: a running queue held at its step's end and resumed by the next server, pauses and stops
// during an update, and agents that exit after their last step.done (split from engine.test.ts, queue TS2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, addNote, answerAsUser, approveQueue, loadProjectState, reportFolder, routeAnswers, runTimes, sendMessage, setStepLevel, type StepDef,
} from "@nexus/protocol";
import { Engine, RETRY_LIMIT, type EngineOptions } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil, LONGER, holdWork } from "./wait.ts";
import { FAST, WINDOW, activityOf, fixtureRun, here, restart, setup } from "./engine-setup.ts";
// ---------------------------------------------------------------- updates of Nexus itself


test("an update holds a running queue at its step's end; the next server resumes it, and only it", async () => {
  const work = holdWork();
  const { store, engine, queue, until } = setup(["slow", "done"]);
  fixtureRun(store, "R", "paused", "paused by the user");
  fixtureRun(store, "H", "halted", "fake condition: fake stop");
  let next: Engine | undefined;
  try {
    engine.start("Q");
    await until("the step to run", () => queue().steps[0]!.status === "running", LONGER.step);
    assert.deepEqual(engine.drainForUpdate(false), ["Q"]);
    assert.equal(queue().run?.state, "pausing");
    assert.throws(() => engine.start("R"), /updating/);
    work.release();
    await until("the hold", () => queue().run?.state === "paused" && engine.idle(), LONGER.run);
    assert.deepEqual(queue().steps.map((s) => s.status), ["done", "pending"]);
    engine.shutdown();

    // The restart: a new engine on the same files.
    next = new Engine(store, () => { routeAnswers(store); acceptReviews(store); next!.onChange(loadProjectState(store)); });
    await until("the resumed run to finish", () => queue().run?.state === "finished", LONGER.run);
    assert.equal(store.readRun("R")?.state, "paused", "a queue the user paused stays paused");
    assert.equal(store.readRun("H")?.state, "halted", "a halted queue stays halted");
  } finally { engine.shutdown(); next?.shutdown(); work.done(); }
});

test("pausing during an update, or a stop condition met, keeps a queue from resuming after the restart", async () => {
  const work = holdWork();
  const a = setup(["slow", "done"]);
  try {
    a.engine.start("Q");
    await a.until("the step to run", () => a.queue().steps[0]!.status === "running", LONGER.step);
    a.engine.drainForUpdate(false);
    a.engine.pause("Q");
    work.release();
    await a.until("the pause", () => a.queue().run?.state === "paused", LONGER.run);
    assert.equal(a.queue().run?.resume_after_restart, undefined, "the user's pause wins");
  } finally { a.engine.shutdown(); work.done(); }

  const b = setup(["stop", "done"]);
  try {
    b.engine.start("Q");
    b.engine.drainForUpdate(false);
    await b.until("the halt", () => b.queue().run?.state === "halted", LONGER.run);
    assert.equal(b.queue().run?.resume_after_restart, undefined, "a stop condition is not undone by a restart");
  } finally { b.engine.shutdown(); }
});

test("a cancelled update lets the held queue go on", async () => {
  const work = holdWork();
  const { engine, queue, until } = setup(["slow", "done"]);
  try {
    engine.start("Q");
    await until("the step to run", () => queue().steps[0]!.status === "running", LONGER.step);
    engine.drainForUpdate(false);
    engine.cancelDrain();
    assert.equal(queue().run?.state, "running");
    work.release();
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
  } finally { engine.shutdown(); work.done(); }
});

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: an agent that exits after the last step.done finishes the run: no retry, no new process, nothing waits`, async () => {
    const { store, engine, queue, until } = setup(["done", "doneexit"]);
    process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
    const seen = new Set<string>();
    const watch = setInterval(() => { const s = store.readRun("Q")?.state; if (s) seen.add(s); }, 20);
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      await new Promise((r) => setTimeout(r, 1500)); // time enough for a retry or a new process, were there one
      const q = queue();
      assert.equal(q.status, "done");
      assert.equal(q.run?.state, "finished");
      assert.ok(!seen.has("retry_wait") && !seen.has("halted"), `states seen: ${[...seen].join(", ")}`);
      const starts = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[]; method?: string })
        .filter((a) => a.argv || a.method === "thread/start" || a.method === "thread/resume");
      assert.equal(starts.length, 1, "one process start");
      assert.deepEqual(loadProjectState(store).attention, [], "nothing waits for the user");
      assert.ok(q.run?.ended_at);
    } finally { clearInterval(watch); engine.shutdown(); delete process.env.FAKE_ARGS; }
  });

  test(`${runtime}: an agent that exits after a step.done while the step waits for review: no retry; once accepted, a new process resumes the session`, async () => {
    const { store, engine, queue, until } = setup(["doneexit", "done"]);
    setStepLevel(store, "Q", "Q1", 1); // the user reviews it: the fake reviewer leaves it to the test
    process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
    const seen = new Set<string>();
    const watch = setInterval(() => { const s = store.readRun("Q")?.state; if (s) seen.add(s); }, 20);
    try {
      engine.start("Q", { runtime });
      await until("Q1 in review", () => queue().steps[0]!.status === "review", LONGER.step);
      await new Promise((r) => setTimeout(r, 1500)); // time enough for the exit, and for a retry were there one
      assert.equal(queue().run?.state, "running", "the run waits for the review");
      engine.acceptReview("Q", "Q1");
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      const q = queue();
      assert.ok(!seen.has("retry_wait") && !seen.has("halted"), `states seen: ${[...seen].join(", ")}`);
      assert.equal(q.steps[1]!.session, q.steps[0]!.session, "Q2 ran in the same session");
      const starts = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[]; method?: string })
        .filter((a) => a.argv || a.method === "thread/start" || a.method === "thread/resume");
      assert.equal(starts.length, 2, "a second process, for Q2");
    } finally { clearInterval(watch); engine.shutdown(); delete process.env.FAKE_ARGS; }
  });
}
