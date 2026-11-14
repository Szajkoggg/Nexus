// Failures of a turn: retries of passing failures, halts on lasting ones, usage limits, crashes, and an update's
// hand-over right after a turn (split from engine.test.ts, queue TS2).
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
// ---------------------------------------------------------------- failures of a turn


for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: a turn that fails twice for a passing reason is tried again, and the queue goes on`, async () => {
    const { store, engine, queue, received, until } = setup(["overloaded2", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      assert.deepEqual(queue().steps.map((s) => s.status), ["done", "done"]);
      assert.equal(queue().run?.retries, undefined, "a turn that ended well clears the count");
      const opened = received().filter((m) => m.text.includes("step Q1 (1 of 2)"));
      assert.equal(opened.length, 3, "the first turn and two retries");
      assert.match(opened[2]!.text, /Continue this step[\s\S]*this is the retry/);
      assert.ok(!received().some((m) => /has no outcome yet/.test(m.text)), "a failed turn is no turn without an outcome");
      const kinds = activityOf(store, queue().run!.session).filter((a) => a.kind === "retry").map((a) => a.text);
      assert.equal(kinds.filter((t) => t.startsWith("Nexus tries")).length, 2);
      assert.ok(kinds.some((t) => !t.startsWith("Nexus tries")), "the runtime's own retries are recorded");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a passing failure that does not pass halts the run after ${RETRY_LIMIT} retries, naming it`, async () => {
    const { engine, queue, received, until } = setup(["overloaded"]);
    try {
      engine.start("Q", { runtime });
      await until("the halt", () => queue().run?.state === "halted", LONGER.run);
      assert.match(queue().run!.reason!, new RegExp(`failed ${RETRY_LIMIT + 1} times in a row.*(overloaded|serverOverloaded)`));
      assert.equal(received().filter((m) => m.text.includes("step Q1")).length, RETRY_LIMIT + 1);
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a Cloudflare 403 is retried like a passing failure: two then success goes on, six halt naming it`, async () => {
    const { engine, queue, received, until } = setup(["cloudflare2", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      assert.deepEqual(queue().steps.map((s) => s.status), ["done", "done"]);
      assert.equal(received().filter((m) => m.text.includes("step Q1 (1 of 2)")).length, 3, "the first turn and two retries");
    } finally { engine.shutdown(); }
    const six = setup(["cloudflare6", "done"]);
    try {
      six.engine.start("Q", { runtime });
      await six.until("the halt", () => six.queue().run?.state === "halted", LONGER.run);
      const reason = six.queue().run!.reason!;
      assert.match(reason, new RegExp(`failed ${RETRY_LIMIT + 1} times in a row; the last time: edge_block_403: .*403.*Cloudflare`));
      assert.equal(six.queue().run!.failure, "edge_block_403");
      assert.equal(six.received().filter((m) => m.text.includes("step Q1 (1 of 2)")).length, RETRY_LIMIT + 1);
    } finally { six.engine.shutdown(); }
  });

  test(`${runtime}: an authentication failure halts the run at once`, async () => {
    const { store, engine, queue, received, until } = setup(["auth", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the halt", () => queue().run?.state === "halted", LONGER.run);
      assert.match(queue().run!.reason!, /authentication_failed|unauthorized/);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(received().length, 1, "no retry and no nudge");
      assert.ok(!activityOf(store, queue().run!.session).some((a) => a.text.startsWith("Nexus tries")));
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a runtime process that crashes mid-turn is tried again on a process that resumes the session`, async () => {
    const { store, engine, queue, until } = setup(["crash1", "done"]);
    process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      const calls = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[]; method?: string; threadId?: string });
      const session = store.readSession(queue().run!.session);
      if (runtime === "claude") {
        const starts = calls.filter((c) => c.argv).map((c) => c.argv!);
        assert.equal(starts.length, 2);
        assert.equal(starts[0]![starts[0]!.indexOf("--session-id") + 1], session.native_id);
        assert.equal(starts[1]![starts[1]!.indexOf("--resume") + 1], session.native_id, "the new process resumes the same session");
      } else {
        assert.deepEqual(calls.filter((c) => c.method === "thread/resume").map((c) => c.threadId), [session.native_id]);
      }
    } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
  });

  test(`${runtime}: a usage limit with a reset time waits for the window, not for the backoff`, async () => {
    const { engine, queue, until } = setup(["limit1", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the usage wait", () => queue().run?.state === "usage_wait");
      const run = queue().run!;
      assert.ok(run.resume_at && Date.parse(run.resume_at) > Date.now() - 1000, "it waits for the reset the runtime named");
      assert.equal(run.retries, undefined, "not counted as a retry");
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a Nexus shutdown is not retried and does not halt the run`, async () => {
    process.env.FAKE_SLOW_MS = "5000";
    const { store, engine, queue, until } = setup(["slow"]);
    let next: Engine | undefined;
    try {
      engine.start("Q", { runtime });
      await until("the step to run", () => queue().steps[0]!.status === "running", LONGER.step);
      const session = queue().run!.session;
      engine.shutdown();
      await until("the process to exit", () => store.readRuntime(session)?.state === "exited");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(queue().run?.state, "running", "the stopped engine wrote nothing");
      next = restart(store);
      assert.equal(queue().run?.state, "paused");
      assert.match(queue().run!.reason!, /restarted/);
    } finally { engine.shutdown(); next?.shutdown(); delete process.env.FAKE_SLOW_MS; }
  });

  test(`${runtime}: a retry pending at an update's restart is made after it`, async () => {
    const { store, engine, queue, until } = setup(["overloaded1", "done"], { retryBaseMs: 1500, usageMarginMs: 100 });
    let next: Engine | undefined;
    try {
      engine.start("Q", { runtime });
      await until("the retry wait", () => queue().run?.state === "retry_wait");
      assert.deepEqual(engine.drainForUpdate(false), ["Q"], "held like a running queue");
      assert.equal(queue().run?.resume_after_restart, true);
      assert.ok(engine.idle());
      engine.shutdown();
      next = restart(store, { retryBaseMs: 1500, usageMarginMs: 100 });
      assert.equal(queue().run?.state, "retry_wait", "it still waits for its retry");
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      assert.deepEqual(queue().steps.map((s) => s.status), ["done", "done"]);
    } finally { engine.shutdown(); next?.shutdown(); }
  });
}

test("a pause or a stop by the user cancels a pending retry", async () => {
  for (const action of ["pause", "stop"] as const) {
    const { engine, queue, until } = setup(["overloaded1", "done"], { retryBaseMs: 600, usageMarginMs: 100 });
    try {
      engine.start("Q");
      await until("the retry wait", () => queue().run?.state === "retry_wait");
      if (action === "pause") engine.pause("Q"); else engine.stopNow("Q");
      assert.equal(queue().run?.state, "paused");
      assert.equal(queue().run?.resume_at, undefined);
      await new Promise((r) => setTimeout(r, 900));
      assert.equal(queue().run?.state, "paused", `no retry after a ${action}`);
    } finally { engine.shutdown(); }
  }
});

/**
 * The N2C case: an update holds a run at the end of its step, and the hand-over stops the agent right after the turn
 * ends (before the engine has looked at the step). The stop is no failure: the run is not halted, and the next server
 * finishes it, or goes on with the step left.
 */
for (const behaviours of [["slow"], ["slow", "done"]]) {
  test(`an update's hand-over right after the last turn of a step: the run ${behaviours.length === 1 ? "ends finished" : "resumes"}`, async () => {
    const work = holdWork();
    const { store, engine, queue, until } = setup(behaviours);
    let next: Engine | undefined;
    try {
      engine.start("Q");
      await until("the step to run", () => queue().steps[0]!.status === "running", LONGER.step);
      engine.drainForUpdate(false);
      work.release();
      await waitUntil("the engine to be idle", () => engine.idle());
      assert.equal(queue().run?.state, "pausing", "caught before the engine's own look at the ended turn");
      engine.shutdown(); // the hand-over
      const session = queue().run!.session;
      await until("the process to exit", () => store.readRuntime(session)?.state === "exited");
      assert.notEqual(queue().run?.state, "halted");
      next = restart(store);
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      assert.ok(queue().steps.every((s) => s.status === "done"));
      assert.equal(queue().run?.resume_after_restart, undefined);
    } finally { engine.shutdown(); next?.shutdown(); work.done(); }
  });
}

test("an unapproved revision cannot start", () => {
  const { store, engine } = setup(["done"]);
  const q = store.readQueue("Q");
  store.writeQueue({ ...q, steps: [...q.steps, { id: "Q9", title: "Added", goal: "", acceptance: [] }] });
  assert.throws(() => engine.start("Q"), /approve/);
  engine.shutdown();
});
