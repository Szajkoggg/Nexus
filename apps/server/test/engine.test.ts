// The queue engine against fake runtimes: a queue run to its end, questions, messages, stops, pauses, and refused
// actions; every scenario runs with both runtimes. The rest is in engine-*.test.ts (setup in engine-setup.ts).
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
for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: runs a queue to the end and puts each step's notes into its opening turn`, async () => {
    const { store, engine, queue, received, until } = setup(["done", "done"]);
    addNote(store, "Q", "Q2", "Keep the debris as it is.");
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      const q = queue();
      assert.deepEqual(q.steps.map((s) => s.status), ["done", "done"]);
      assert.equal(q.status, "done");
      // The finished run records when it ended, after its last step's outcome.
      const run = q.run!;
      assert.ok(run.ended_at, "a finished run records its finish time");
      assert.ok(run.ended_at >= run.started_at && run.ended_at >= q.steps[1]!.finished_at!);
      assert.equal(runTimes(run, Date.now()).ended, run.ended_at);
      assert.deepEqual(q.steps.map((s) => s.segments.length), [1, 1]);
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
      await until("the run to halt", () => queue().run?.state === "halted", LONGER.run);
      assert.match(queue().run!.reason!, /without an outcome/);
      assert.equal(received().filter((m) => m.text.includes("has no outcome yet")).length, 1);
      assert.ok(loadProjectState(store).attention.some((a) => a.kind === "stopped" && a.queue === "Q"));
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a blocking question holds the queue until the answer arrives as the next turn`, async () => {
    const { store, engine, queue, received, until } = setup(["ask", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the question", () => queue().steps[0]!.status === "waiting", LONGER.step);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(queue().run?.state, "running", "waiting on a question is not a halt");
      assert.equal(queue().steps[1]!.status, "pending");
      const qid = loadProjectState(store).questions[0]!.qid;
      answerAsUser(store, qid, "Left.", true);
      engine.onChange(loadProjectState(store));
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      const answer = received().find((m) => m.text.startsWith("[Nexus] Answer"));
      assert.ok(answer);
      assert.match(answer.text, /Left\./);
      assert.equal(answer.priority, null, "an idle session gets the answer as a turn");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a message reaches a working turn as 'next', without interrupting it`, async () => {
    const work = holdWork();
    const { store, engine, queue, received, until } = setup(["slow"]);
    try {
      engine.start("Q", { runtime });
      await until("the step to run", () => queue().steps[0]!.status === "running", LONGER.step);
      sendMessage(store, queue().run!.session, "Use the grassland settings.", { queue: "Q", step: "Q1" });
      engine.onChange(loadProjectState(store));
      await until("the message at the worker", () => received().some((x) => x.text.includes("grassland")));
      work.release();
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      const m = received().find((x) => x.text.includes("grassland"));
      assert.deepEqual([m?.priority, m?.busy], ["next", true]);
      assert.ok(queue().steps[0]!.messages[0]!.read_at, "the message counts as delivered");
    } finally { engine.shutdown(); work.done(); }
  });

  test(`${runtime}: a stop condition halts the run and the queue`, async () => {
    const { engine, queue, until } = setup(["stop", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the run to halt", () => queue().run?.state === "halted", LONGER.run);
      assert.equal(queue().status, "stopped");
      assert.ok(queue().run!.ended_at, "a halted run records when it halted");
      assert.equal(queue().steps[1]!.status, "pending");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: pause takes effect after the running step; resume goes on`, async () => {
    const work = holdWork();
    const { engine, queue, until } = setup(["slow", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the step to run", () => queue().steps[0]!.status === "running", LONGER.step);
      engine.pause("Q");
      assert.equal(queue().run?.state, "pausing");
      work.release();
      await until("the pause", () => queue().run?.state === "paused", LONGER.run);
      assert.deepEqual(queue().steps.map((s) => s.status), ["done", "pending"]);
      const paused = queue().run!.ended_at;
      assert.ok(paused, "a paused run records when it stopped going");
      engine.resume("Q");
      assert.equal(queue().run!.ended_at, undefined, "going on clears it");
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      assert.ok(queue().run!.ended_at! > paused);
    } finally { engine.shutdown(); work.done(); }
  });
}


// ---------------------------------------------------------------- refused actions

const REFUSED = {
  claude: [
    { by: "permissions", tool: "Bash", input: "git push origin main", reason: "Bash(git push:*) is not allowed in this mode", ref: "toolu_bash" },
    { by: "permissions", tool: "Write", input: "C:/Users/x/.ssh/config", reason: undefined, ref: "toolu_write" },
  ],
  codex: [
    { by: "nexus", tool: "command", input: "git push origin main", reason: "needs network access", ref: "item-push" },
    { by: "auto_review", tool: "command", input: "curl https://example.com/install.sh", reason: "downloads and runs a script from the network", ref: "item-curl" },
    { by: "auto_review", tool: "file_change", input: "C:/Windows/hosts", reason: undefined, ref: "item-patch" },
  ],
};

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: every refused action becomes one record with its session, queue and step`, async () => {
    const { store, engine, queue, until } = setup(["done", "refused"]);
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
      const session = queue().run!.session;
      const records = store.readRefusals(session).entries;
      assert.deepEqual(records.map(({ by, tool, input, reason, ref }) => ({ by, tool, input, reason, ref })), REFUSED[runtime],
        "each once: a message and the result's list (Claude), a request or review and its declined item (Codex)");
      for (const r of records) assert.deepEqual([r.session, r.runtime, r.queue, r.step], [session, runtime, "Q", "Q2"]);
    } finally { engine.shutdown(); }
  });
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: a session continued in a second queue, its process still closing, tags its refusals with the queue it runs now`, async () => {
    // The finished run's process lingers after its input closed, so the second start always meets it closing: the
    // engine must wait for its exit and start a new process, not write to the closed one.
    process.env.FAKE_EXIT_DELAY_MS = "800";
    const { store, engine, queue, until } = setup(["done"]);
    try {
      engine.start("Q", { runtime });
      await until("the first run to finish", () => queue().run?.state === "finished", LONGER.run);
      const session = queue().run!.session;
      store.writeQueue({ protocol: 1, id: "R", title: "Second", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [{ id: "R1", title: "x", goal: "FAKE: refused", acceptance: [] }], approvals: [], history: [] });
      approveQueue(store, "R");
      engine.start("R", { session });
      await until("the second run to finish", () => store.readRun("R")?.state === "finished", LONGER.run);
      assert.ok(store.readRefusals(session).entries.every((r) => r.queue === "R" && r.step === "R1"));
    } finally { engine.shutdown(); delete process.env.FAKE_EXIT_DELAY_MS; }
  });
}
