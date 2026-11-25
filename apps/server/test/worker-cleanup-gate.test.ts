// H1, H4 and H3's chain of the LWH survey (queue WHR, WHR4): what meets a worker's cleanup while it is held inside the
// native phase. The worker's processes run in a real job host compiled with the test's gate (gated-cleanup.ts,
// nativeGate): End has opened and checked the handle of the step's helper (a real process holding a real directory)
// and waits at AwaitExit's 2000 ms wait until the test opens the gate. The helper's TerminateProcess is not made and
// returns false/5 (injected, as the WH2 trace): the helper ends by itself when the test releases it (the wait's success),
// or lives on (its failure). A stop, a pipe's end, a host's kill, resumes, an inbox entry and a review's acceptance
// meet the held wait; then the wait's outcome arrives. Beside it, worker B holds its own directory and is never
// touched. Only processes these tests started are handled, each by the identity the test checked. The helpers share
// the job host's console ("…shared" behaviours, fake-behaviour.ts): a helper with a conhost of its own in the job dies
// with that conhost when the cleanup ends it first, and the job's member order would decide the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadProjectState, sendMessage } from "@nexus/protocol";
import { LONGER, holds, until } from "./wait.ts";
import { FAILED, RUNTIMES, alive, atGate, isLocked, locked, sameHandle, windows, workerA, workerB } from "./worker-gate-fixture.ts";

// The fake runtimes as processes of their own (scripts/real-process-tests.ts).
process.env.NEXUS_CLAUDE = fileURLToPath(new URL("./fake-claude.ts", import.meta.url));
process.env.NEXUS_CODEX = fileURLToPath(new URL("./fake-codex.ts", import.meta.url));

for (const runtime of RUNTIMES) {
  test(`${runtime}: End -> AwaitExit -> C -> next turn: a late exit after false/5 acknowledges once and the next step runs once`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      a.finishTurn();
      await atGate(a);
      await holds("nothing goes on while the wait is held", () => a.openings("Q2") === 0 && a.queue().run?.state === "running", 300);
      a.releaseHelper();
      await until("the helper ends by itself", () => !alive(a.helper), LONGER.step);
      a.gate.open();
      await a.until("the queue finishes", () => a.queue().run?.state === "finished", LONGER.run);
      sameHandle(a, ["0"]);
      assert.equal(a.cleanups.calls[0]!.outcome, "done");
      assert.equal(a.openings("Q1"), 1, "Q1 not repeated");
      assert.equal(a.openings("Q2"), 1, "Q2 once");
      assert.equal(isLocked(a.dir), false, "the directory is free");
      a.contentKept();
      locked(b.dir);
      assert.ok(alive(b.pid));
    } finally { await a.end(); await b.end(); }
  });

  test(`${runtime}: End -> AwaitExit with the helper alive: no C, the run halts with code 5, no next step; the job's end frees the directory`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      a.finishTurn();
      await atGate(a);
      a.gate.open();
      await a.until("the run halts", () => a.queue().run?.state === "halted", LONGER.step);
      assert.match(a.queue().run!.reason!, FAILED);
      assert.equal(a.cleanups.calls[0]!.outcome, "failed");
      await until("the worker's job ends", () => a.runtimeState() === "exited" && !alive(a.helper), LONGER.processes);
      sameHandle(a, ["258"]);
      assert.equal(isLocked(a.dir), false);
      await holds("no next step", () => a.openings("Q2") === 0 && a.queue().steps[1]!.status === "pending" && a.queue().run?.state === "halted", 300);
      assert.equal(a.openings("Q1"), 1);
      a.contentKept();
      locked(b.dir);
    } finally { await a.end(); await b.end(); }
  });
}

// H1: the stops, the pipe's end and the host's kill at the held wait, each followed by the wait's success or failure.
for (const [runtime, outcome] of [["claude", "success"], ["codex", "failure"]] as const) {
  test(`${runtime}: Stop now at the held wait, then its ${outcome}: the run pauses at once, nothing is sent, Q2 never starts`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      a.finishTurn();
      await atGate(a);
      const sent = a.received().length;
      a.engine.stopNow("Q");
      assert.equal(a.queue().run?.state, "paused");
      assert.equal(a.queue().run?.reason, "stopped by the user");
      if (outcome === "success") a.releaseHelper();
      a.gate.open();
      if (outcome === "success") {
        await until("the cleanup is done", () => a.cleanups.calls[0]!.outcome === "done", LONGER.step);
        await holds("the run stays paused, nothing starts", () => a.queue().run?.state === "paused" && a.openings("Q2") === 0, 500);
        assert.equal(a.runtimeState() === "exited", false, "the idle process is kept for Resume");
      } else {
        await a.until("the failure halts the run", () => a.queue().run?.state === "halted", LONGER.step);
        assert.match(a.queue().run!.reason!, FAILED, "today's rule: a cleanup failure halts, also a paused run");
        await until("the worker's job ends", () => a.runtimeState() === "exited" && !alive(a.helper), LONGER.processes);
      }
      assert.equal(a.received().length, sent, "no message to the idle worker (it is not working: no stop text)");
      assert.equal(isLocked(a.dir), false);
      assert.equal(a.queue().steps[1]!.status, "pending");
      a.contentKept();
      locked(b.dir);
    } finally { await a.end(); await b.end(); }
  });
}

for (const [runtime, outcome] of [["codex", "success"], ["claude", "failure"]] as const) {
  test(`${runtime}: Stop at once at the held wait, then its ${outcome}: paused at once, the exit waits for the wait, Q2 never starts`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      a.finishTurn();
      await atGate(a);
      let stopped = false;
      const stop = a.engine.stopAtOnce("Q").then(() => { stopped = true; });
      assert.equal(a.queue().run?.state, "paused");
      assert.match(a.queue().run!.reason!, /stopped at once by the user/);
      await holds("the exit waits for the held cleanup (K is read after it)", () => !stopped && alive(a.helper), 300);
      if (outcome === "success") a.releaseHelper();
      a.gate.open();
      await stop;
      assert.equal(a.runtimeState(), "exited");
      await until("the job's members are gone", () => !alive(a.helper), LONGER.processes);
      const run = a.queue().run!;
      if (outcome === "success") {
        assert.equal(a.cleanups.calls[0]!.outcome, "done");
        assert.equal(run.state, "paused", "the pause holds");
      } else {
        assert.equal(a.cleanups.calls[0]!.outcome, "failed");
        assert.equal(run.state, "halted", "today's rule: a cleanup failure halts, also a paused run");
        assert.match(run.reason!, FAILED);
      }
      assert.equal(isLocked(a.dir), false);
      await holds("Q2 never starts", () => a.openings("Q2") === 0 && a.queue().steps[1]!.status === "pending", 300);
      a.contentKept();
      locked(b.dir);
    } finally { await a.end(); await b.end(); }
  });
}

test("claude: the server's pipe ends at the held wait (the server lost), then the wait succeeds: the job ends everything, the files keep Q2 pending", windows, async () => {
  const b = await workerB("claude");
  const a = await workerA("claude", ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
  try {
    a.finishTurn();
    await atGate(a);
    const host = a.gate.hosts.at(-1)!;
    const exited = new Promise<void>((r) => host.once("close", () => r()));
    a.engine.shutdown();
    host.stdin.end();
    a.releaseHelper();
    a.gate.open();
    await exited;
    assert.equal(alive(a.helper), false);
    assert.equal(isLocked(a.dir), false);
    const q = loadProjectState(a.store).queues.find((x) => x.id === "Q")!;
    assert.equal(q.steps[0]!.status, "done");
    assert.equal(q.steps[1]!.status, "pending");
    assert.notEqual(q.run?.state, "finished");
    assert.equal(a.openings("Q2"), 0);
    a.contentKept();
    locked(b.dir);
  } finally { await a.end(); await b.end(); }
});

// The host's loss under a held cleanup is the worker process's exit: the job's close (kill-on-close) has ended its
// members, the engine drops the outcome of a process it no longer holds (cleanWorker), and the run goes on in a new
// process as after any exit between turns. Pinned as today's behaviour: Q1 is not repeated, Q2 runs once.
for (const runtime of RUNTIMES) {
  test(`${runtime}: the host is killed at the held wait: the job's close ends its members; the run goes on in a new process, Q1 not repeated, Q2 once`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      a.finishTurn();
      await atGate(a);
      const hosts = a.gate.hosts.length;
      a.gate.hosts.at(-1)!.kill();
      await a.until("Q2 opens", () => a.openings("Q2") >= 1, LONGER.run);
      assert.equal(alive(a.helper), false, "the old job's members ended before the next step");
      assert.equal(isLocked(a.dir), false);
      await a.until("the queue finishes", () => a.queue().run?.state === "finished", LONGER.run);
      assert.deepEqual(a.cleanups.calls[0], { turned: true, outcome: "failed" }, "the held cleanup failed with its host");
      assert.ok(a.gate.hosts.length > hosts, "a new host for the new process");
      assert.equal(a.openings("Q1"), 1, "Q1 not repeated");
      assert.equal(a.openings("Q2"), 1, "Q2 once");
      a.contentKept();
      locked(b.dir);
    } finally { await a.end(); await b.end(); }
  });
}

// H4's remainder (worker-processes.test.ts and coordinator.test.ts hold one deferred resume and a refused one).
for (const runtime of RUNTIMES) {
  test(`${runtime}: Stop now, two resumes and Stop now again at the held wait: the later pause holds after the success; one Resume then runs Q2 once`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      a.finishTurn();
      await atGate(a);
      a.engine.stopNow("Q");
      a.engine.resume("Q");
      a.engine.resume("Q");
      assert.equal(a.queue().run?.state, "paused", "a resume during the cleanup waits for it");
      a.engine.stopNow("Q");
      a.releaseHelper();
      a.gate.open();
      await until("the cleanup is done", () => a.cleanups.calls[0]!.outcome === "done", LONGER.step);
      await holds("the later pause is not lost to the earlier resumes", () => a.queue().run?.state === "paused" && a.openings("Q2") === 0, 500);
      a.engine.resume("Q");
      await a.until("the queue finishes", () => a.queue().run?.state === "finished", LONGER.run);
      assert.equal(a.openings("Q2"), 1, "Q2 once");
      assert.equal(a.openings("Q1"), 1, "Q1 not repeated");
      assert.equal(isLocked(a.dir), false);
      a.contentKept();
      locked(b.dir);
    } finally { await a.end(); await b.end(); }
  });

  test(`${runtime}: a resume waiting at the held wait, then the wait fails: the run halts, the waiting resume does nothing; a later Resume runs Q2 once`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      a.finishTurn();
      await atGate(a);
      a.engine.stopNow("Q");
      a.engine.resume("Q");
      a.gate.open();
      await a.until("the run halts", () => a.queue().run?.state === "halted", LONGER.step);
      assert.match(a.queue().run!.reason!, FAILED);
      await until("the worker's job ends", () => a.runtimeState() === "exited" && !alive(a.helper), LONGER.processes);
      await holds("the waiting resume does not run Q2", () => a.queue().run?.state === "halted" && a.openings("Q2") === 0, 500);
      a.engine.resume("Q");
      await a.until("the queue finishes", () => a.queue().run?.state === "finished", LONGER.run);
      assert.equal(a.openings("Q2"), 1);
      assert.equal(a.openings("Q1"), 1);
      a.contentKept();
      locked(b.dir);
    } finally { await a.end(); await b.end(); }
  });

  test(`${runtime}: a message and the review's acceptance at the held wait: neither is taken before the success; then Q2 once, the message once`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"], { level: 1 }).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      a.finishTurn();
      await atGate(a);
      assert.equal(a.queue().steps[0]!.status, "review");
      const id = sendMessage(a.store, a.session(), "a message during the cleanup");
      a.engine.onChange(loadProjectState(a.store));
      a.engine.acceptReview("Q", "Q1");
      const unread = () => !loadProjectState(a.store).sessions.find((x) => x.id === a.session())?.inbox.find((m) => m.id === id)?.read_at;
      await holds("nothing is delivered while the wait is held", () => unread() && a.openings("Q2") === 0 && a.received().every((m) => !m.text.includes("during the cleanup")), 500);
      a.releaseHelper();
      a.gate.open();
      await a.until("the queue finishes", () => a.queue().run?.state === "finished", LONGER.run);
      assert.equal(a.openings("Q2"), 1);
      assert.equal(a.openings("Q1"), 1);
      assert.equal(a.received().filter((m) => m.text.includes("during the cleanup")).length, 1, "the message reaches the worker once");
      assert.equal(unread(), false);
      a.contentKept();
      locked(b.dir);
    } finally { await a.end(); await b.end(); }
  });

  test(`${runtime}: a real DACL denial halts the run; a Resume while the failed worker's job is held whole runs Q2 once, after it, and Q1 never again`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["owneddenyshared", "done"], { refuse: false }).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      // The cleanup's one open is refused (the helper's DACL) and fails it; the kill that follows is held before its
      // first open, so the old job, its runtime and the helper are all up while the user resumes.
      a.gate.holdOpen(2);
      a.finishTurn();
      await a.until("the denial halts the run", () => a.queue().run?.state === "halted", LONGER.step);
      assert.match(a.queue().run!.reason!, /OpenProcess for worker job member/);
      await until("the kill's cleanup is held before it ends anything", () => !!a.gate.arrived(), LONGER.step);
      assert.equal(a.gate.calls()[0], `OpenProcess ${a.helper} 0`, "the refused open");
      // The helper's DACL refuses Node's signal-0 probe (it opens with terminate access): its directory lock tells.
      locked(a.dir);
      assert.notEqual(a.runtimeState(), "exited", "the failed worker's exit has not reached the engine");
      const hosts = a.gate.hosts.length;
      a.engine.resume("Q");
      await holds("nothing runs while the old job is up", () => a.openings("Q2") === 0 && a.gate.hosts.length === hosts, 500);
      a.gate.open();
      await a.until("the queue finishes", () => a.queue().run?.state === "finished", LONGER.run);
      assert.equal(isLocked(a.dir), false, "the denied helper ended with its job");
      assert.equal(a.openings("Q2"), 1, "Q2 once");
      assert.equal(a.openings("Q1"), 1, "Q1 never again");
      a.contentKept();
      locked(b.dir);
    } finally { await a.end(); await b.end(); }
  });
}
