// The workers' cleanup barrier at a step's end (AgentProcess.cleanup) in the in-process engine tests, with a cleanup
// that takes time or times out and a kill that comes late (gated-cleanup.ts's delayMs and timeoutMs, in-process-runtime's
// ProcessEnds; survey LC3, F5/F17, queue LCK). Without them an in-process cleanup resolves in a microtask, so the
// barrier never lasts and never fails off Windows. A timed-out cleanup is asked once more within the same barrier;
// only a second timeout halts the run (the user's decision with queue LCK, F5). A pending barrier keeps the engine
// from being idle, so an update's drain waits for its outcome; one that fails during the drain leaves the run held
// (D1 with queue LCG, survey LC4 finding 1; worker-cleanup-restart.test.ts has the same against a real job host).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentProcess } from "../src/agent.ts";
import type { Launch } from "../src/agent-host.ts";
import { FAST, activityOf, restart, setup } from "./engine-setup.ts";
import { gatedCleanup } from "./gated-cleanup.ts";
import { inProcessRuntime, letEnd, type ProcessEnds } from "./in-process-runtime.ts";
import { LONGER } from "./wait.ts";

test("a cleanup that takes time holds the next step: it opens only after the cleanup ended, and no message of it reaches the runtime before", async () => {
  const cleanedAt: number[] = [];
  const atCleanupEnd: string[] = [];
  const runtime = inProcessRuntime();
  // The session's own cleanup runs after gatedCleanup's delay, at the barrier's end: what it sees is what the delay held.
  const watch: { look?: () => void } = {}; // set once the engine is made
  const make = (launch: Launch): AgentProcess => {
    const proc = runtime(launch);
    const own = proc.cleanup?.bind(proc);
    proc.cleanup = async () => { watch.look?.(); await own?.(); cleanedAt.push(Date.now()); };
    return proc;
  };
  const g = gatedCleanup({ make, delayMs: 50 });
  const { engine, queue, received, until } = setup(["done", "done"], { ...FAST, spawn: g.spawn });
  watch.look = () => {
    if (cleanedAt.length) return; // the first cleanup only: Q1's end
    atCleanupEnd.push(`Q2 ${queue().steps[1]!.status}`, `Q2's message ${received().some((m) => m.text.includes("step Q2")) ? "sent" : "not sent"}`);
  };
  try {
    engine.start("Q", { runtime: "claude" });
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(atCleanupEnd, ["Q2 pending", "Q2's message not sent"], "nothing of Q2 while the cleanup lasted");
    assert.deepEqual(g.calls[0], { turned: true, outcome: "done" });
    const q2 = Date.parse(queue().steps[1]!.started_at!);
    assert.ok(q2 >= cleanedAt[0]!, `Q2 opened (${q2}) after the cleanup ended (${cleanedAt[0]})`);
    assert.deepEqual(queue().steps.map((s) => s.status), ["done", "done"]);
  } finally { engine.shutdown(); }
});

/** The process's kill and exit times, through in-process-runtime's wrap. */
function watched() {
  const seen: { killedAt?: number; exitedAt?: number; spawned: number } = { spawned: 0 };
  const wrap = (proc: AgentProcess) => {
    seen.spawned++;
    const kill = proc.kill.bind(proc);
    proc.kill = (force?: boolean) => { seen.killedAt ??= Date.now(); kill(force); };
    proc.on("exit", () => { seen.exitedAt ??= Date.now(); });
    return proc;
  };
  return { seen, wrap };
}

const retried = (x: ReturnType<typeof setup>) => activityOf(x.store, x.queue().steps[0]!.session!).filter((e) => e.text.includes("cleanup timed out; Nexus asks for it once more"));

test("one cleanup timeout: Nexus asks once more, with no kill, and the run goes on once the second cleanup ends", async () => {
  const { seen, wrap } = watched();
  const g = gatedCleanup({ make: inProcessRuntime({ wrap }), timeoutMs: 50, timeouts: 1 });
  const x = setup(["done", "done"], { ...FAST, spawn: g.spawn });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(g.calls.slice(0, 2), [{ turned: true, outcome: "failed" }, { turned: true, outcome: "done" }], "the timeout, then the second cleanup of the same process");
    assert.deepEqual(x.queue().steps.map((s) => s.status), ["done", "done"]);
    assert.equal(seen.spawned, 1, "the same process ran Q2");
    assert.equal(retried(x).length, 1, "the retry is in the session's activity");
    assert.equal(seen.killedAt, undefined, "no kill while the run went on");
  } finally { x.engine.shutdown(); }
});

test("two cleanup timeouts halt the run, saying twice; the process is killed after, and the halt does not wait for its exit", async () => {
  const ends: ProcessEnds = { kill: { delayMs: 50 }, dropped: [] };
  const { seen, wrap } = watched();
  const g = gatedCleanup({ make: inProcessRuntime({ ends, wrap }), timeoutMs: 50 });
  const x = setup(["done", "done"], { ...FAST, spawn: g.spawn });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run halted", () => x.queue().run?.state === "halted", LONGER.run);
    const run = x.queue().run!;
    assert.equal(run.reason, "worker process cleanup timed out twice");
    assert.deepEqual(x.queue().steps.map((s) => s.status), ["done", "pending"], "Q2 never opens");
    assert.ok(!x.received().some((m) => m.text.includes("step Q2")));
    assert.deepEqual(g.calls, [{ turned: true, outcome: "failed" }, { turned: true, outcome: "failed" }], "two cleanups, both timed out");
    assert.equal(retried(x).length, 1);
    await x.until("the killed process exited", () => seen.exitedAt !== undefined);
    const { killedAt, exitedAt } = seen;
    assert.ok(killedAt !== undefined, "the process is killed");
    assert.ok(exitedAt! - killedAt >= 45, `the kill came late (${exitedAt! - killedAt} ms after it was asked)`);
    assert.ok(Date.parse(run.ended_at!) <= killedAt, `the run halted (${run.ended_at}) before the kill was asked (${new Date(killedAt).toISOString()}), so before the exit`);
  } finally { letEnd(ends); x.engine.shutdown(); }
});

test("Resume after a halt by two cleanup timeouts goes on at the next step in a new process; the done step is not run again", async () => {
  const { seen, wrap } = watched();
  const g = gatedCleanup({ make: inProcessRuntime({ wrap }), timeoutMs: 50, timeouts: 2 });
  const x = setup(["done", "done"], { ...FAST, spawn: g.spawn });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the run halted", () => x.queue().run?.state === "halted", LONGER.run);
    assert.equal(x.queue().run!.reason, "worker process cleanup timed out twice");
    await x.until("the killed process exited", () => seen.exitedAt !== undefined);
    const q1 = x.queue().steps[0]!;
    x.engine.resume("Q");
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    const [s1, s2] = x.queue().steps;
    assert.deepEqual([s1!.status, s2!.status], ["done", "done"]);
    assert.equal(s1!.timeline.filter((e) => e.type === "step.started").length, 1, "Q1 opened once");
    assert.equal(s1!.timeline.filter((e) => e.type === "step.done").length, 1, "Q1 done once");
    assert.equal(s1!.started_at, q1.started_at);
    assert.equal(s2!.timeline.filter((e) => e.type === "step.started").length, 1, "Q2 opened once");
    assert.equal(seen.spawned, 2, "Q2 ran in a new process (the session's conversation resumed in it)");
    assert.deepEqual(g.calls.map((c) => c.outcome), ["failed", "failed", "done"], "the new process's cleanup after Q2 ran as usual");
  } finally { x.engine.shutdown(); }
});

test("a Resume asked while the first cleanup times out waits for the second one, then goes on", async () => {
  const g = gatedCleanup({ make: inProcessRuntime(), timeoutMs: 50, timeouts: 1 });
  g.hold();
  const x = setup(["done", "done"], { ...FAST, spawn: g.spawn });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the cleanup at the gate", () => g.held() > 0, LONGER.run);
    x.engine.pause("Q");
    x.engine.resume("Q");
    assert.equal(x.queue().run?.state, "paused", "the resume waits for the cleanup");
    g.release();
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(g.calls.slice(0, 2).map((c) => c.outcome), ["failed", "done"]);
    assert.deepEqual(x.queue().steps.map((s) => s.status), ["done", "done"]);
  } finally { g.release(); x.engine.shutdown(); }
});

test("a pending cleanup keeps the engine from being idle: cleaningSessions names its session until the outcome, then the engine is idle again", async () => {
  const g = gatedCleanup({ make: inProcessRuntime() });
  g.hold();
  const x = setup(["done"], { ...FAST, spawn: g.spawn });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the cleanup at the gate", () => g.held() > 0, LONGER.run);
    const session = x.queue().run!.session;
    assert.deepEqual(x.engine.cleaningSessions(), [session], "the pending barrier is the session's");
    assert.equal(x.engine.idle(), false, "a pending cleanup is waited for, as a turn is");
    g.release();
    await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(x.engine.cleaningSessions(), []);
    assert.equal(x.engine.idle(), true);
  } finally { g.release(); x.engine.shutdown(); }
});

/** Q1 was not repeated and Q2 ran once, in a second process (the first one ended with its failed cleanup). */
function q2OnceInNewProcess(x: ReturnType<typeof setup>, seen: { spawned: number }): void {
  const [q1, q2] = x.queue().steps;
  assert.equal(q1!.timeline.filter((e) => e.type === "step.started").length, 1, "Q1 not repeated");
  assert.equal(q2!.timeline.filter((e) => e.type === "step.started").length, 1, "Q2 once");
  assert.equal(seen.spawned, 2, "Q2 ran in a new process");
}

test("an update's drain while a cleanup is pending: the engine stays busy until its outcome; a failure leaves the run held (no halt), says so in the activity and ends the process; the next server goes on by itself in a new process, Q2 once", async () => {
  const { seen, wrap } = watched();
  const g = gatedCleanup({ make: inProcessRuntime({ wrap }) });
  g.hold();
  const x = setup(["done", "done"], { ...FAST, spawn: g.spawn });
  let next: ReturnType<typeof restart> | undefined;
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the cleanup at the gate", () => g.held() > 0, LONGER.run);
    assert.deepEqual(x.engine.drainForUpdate(false), ["Q"], "the update holds the run");
    const held = x.store.readRun("Q")!;
    assert.deepEqual([held.state, held.resume_after_restart], ["paused", true]);
    assert.equal(x.engine.idle(), false, "the drain waits for the pending cleanup");
    g.fail("a member refused to end");
    await x.until("the failed cleanup's process exited", () => seen.exitedAt !== undefined && !x.engine.alive());
    assert.deepEqual(x.store.readRun("Q"), held, "the run stays held for the update: no halt");
    assert.equal(x.engine.idle(), true, "the drain may finish now");
    assert.deepEqual(g.calls.map((c) => c.outcome), ["failed"]);
    const errors = activityOf(x.store, held.session).filter((e) => e.kind === "error" && e.text.includes("a member refused to end"));
    assert.equal(errors.length, 1, "the failure is in the session's activity");
    assert.match(errors[0]!.text, /stays held for the Nexus update/);
    // The update's hand-over: this server stops, the next one starts on the same files.
    x.engine.shutdown();
    g.release();
    next = restart(x.store, { ...FAST, spawn: g.spawn });
    await x.until("the queue finishes", () => x.queue().run?.state === "finished", LONGER.run);
    q2OnceInNewProcess(x, seen);
  } finally { g.release(); x.engine.shutdown(); next?.shutdown(); }
});

// ---------------------------------------------------------------- D2: a cleanup failure on a paused run, the host's end

/** The cleanup failures noted in the session's activity (cleanWorker's notes, not halts), containing `text`. */
const notes = (x: ReturnType<typeof setup>, text: string) => activityOf(x.store, x.queue().run!.session).filter((e) => e.kind === "error" && e.text.startsWith("The worker process cleanup") && e.text.includes(text));

/** D2's outcome for a run the user paused or stopped: paused with its reason, the process ended, Q2 never opened; Resume then runs Q2 once in a new process. */
async function pausedThroughFailure(x: ReturnType<typeof setup>, seen: { exitedAt?: number; spawned: number }, reason: RegExp, note: string): Promise<void> {
  await x.until("the worker's process exited", () => seen.exitedAt !== undefined && !x.engine.alive(), LONGER.run);
  await new Promise((r) => setTimeout(r, 100)); // nothing may follow the exit: no halt, no next step
  const run = x.queue().run!;
  assert.equal(run.state, "paused", "no halt: the run stays paused");
  assert.match(run.reason!, reason, "with its own reason");
  assert.equal(notes(x, note).length, 1, `the cleanup's failure is in the activity (${note})`);
  assert.equal(x.queue().steps[1]!.status, "pending", "Q2 never opens");
  assert.ok(!x.received().some((m) => m.text.includes("step Q2")));
  x.engine.resume("Q");
  await x.until("the run to finish", () => x.queue().run?.state === "finished", LONGER.run);
  q2OnceInNewProcess(x, seen);
}

test("Stop now on a process in its cleanup barrier, the cleanup timing out twice: the run stays paused (stopped by the user), no halt; the failure is in the activity, the process ended, Q2 never opens; Resume runs Q2 once in a new process", async () => {
  const { seen, wrap } = watched();
  const g = gatedCleanup({ make: inProcessRuntime({ wrap }), timeoutMs: 50, timeouts: 2 });
  g.hold();
  const x = setup(["done", "done"], { ...FAST, spawn: g.spawn });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the cleanup at the gate", () => g.held() > 0, LONGER.run);
    x.engine.stopNow("Q");
    assert.deepEqual([x.queue().run?.state, x.queue().run?.reason], ["paused", "stopped by the user"]);
    g.release();
    await pausedThroughFailure(x, seen, /^stopped by the user$/, "timed out twice");
    assert.deepEqual(g.calls.slice(0, 2).map((c) => c.outcome), ["failed", "failed"], "the timeout and its one retry");
  } finally { g.release(); x.engine.shutdown(); }
});

test("Stop at once on a process in its cleanup barrier, one timeout, the retry failing as the job host ends at the kill: the run stays paused (stopped at once), no halt; the failure is in the activity; Resume runs Q2 once in a new process", async () => {
  // The kill waits behind the cleanup, as a K behind a C in the job host: the unforced kill is held; the host's end
  // (the retry's failure, then the exit) carries it out.
  const ends: ProcessEnds = { kill: "unforced", dropped: [] };
  const { seen, wrap } = watched();
  const g = gatedCleanup({ make: inProcessRuntime({ ends, wrap }), timeoutMs: 50, timeouts: 1 });
  g.hold();
  const x = setup(["done", "done"], { ...FAST, spawn: g.spawn });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the cleanup at the gate", () => g.held() > 0, LONGER.run);
    const stop = x.engine.stopAtOnce("Q");
    assert.match(x.queue().run!.reason!, /^stopped at once by the user/);
    g.release();
    // The first cleanup is in its 50 ms limit now; the retry it leads to meets the host's end.
    await new Promise((r) => setTimeout(r, 20));
    g.fail("worker job host exited", { withExit: "after", once: true });
    await stop;
    await pausedThroughFailure(x, seen, /^stopped at once by the user/, "worker job host exited");
    assert.deepEqual(g.calls.slice(0, 2).map((c) => c.outcome), ["failed", "failed"], "the timeout, then the retry's failure");
    assert.equal(retried(x).length, 1, "the retry was asked");
  } finally { letEnd(ends); g.release(); x.engine.shutdown(); }
});

test("a Pause, then the cleanup fails: the run stays paused (paused by the user), no halt; the failure is in the activity, the process ended, Q2 never opens; Resume runs Q2 once in a new process", async () => {
  const { seen, wrap } = watched();
  const g = gatedCleanup({ make: inProcessRuntime({ wrap }) });
  g.hold();
  const x = setup(["done", "done"], { ...FAST, spawn: g.spawn });
  try {
    x.engine.start("Q", { runtime: "claude" });
    await x.until("the cleanup at the gate", () => g.held() > 0, LONGER.run);
    x.engine.pause("Q");
    g.fail("a member refused to end", { once: true });
    await pausedThroughFailure(x, seen, /^paused by the user$/, "a member refused to end");
  } finally { g.release(); x.engine.shutdown(); }
});

// Survey LC4 finding 8: after a runtime crash the job host's end fails the held cleanup ("worker job host exited") and
// the process exits, in either order. Either way it is the process's exit (D2): no halt, the run goes on in a new process.
for (const withExit of ["before", "after"] as const) {
  test(`a running run's cleanup fails as its job host ends, the process's exit coming ${withExit} the failure: taken as the exit, no halt; Q2 runs once in a new process`, async () => {
    const { seen, wrap } = watched();
    const g = gatedCleanup({ make: inProcessRuntime({ wrap }) });
    g.hold();
    const x = setup(["done", "done"], { ...FAST, spawn: g.spawn });
    try {
      x.engine.start("Q", { runtime: "claude" });
      await x.until("the cleanup at the gate", () => g.held() > 0, LONGER.run);
      g.fail("worker job host exited", { withExit, once: true });
      await x.until("the run finishes or halts", () => x.queue().run?.state === "finished" || x.queue().run?.state === "halted", LONGER.run);
      assert.equal(x.queue().run?.state, "finished", `no halt (${x.queue().run?.reason ?? ""})`);
      q2OnceInNewProcess(x, seen);
      assert.equal(notes(x, "takes it as the process's exit").length, 1, "the host's end is in the activity");
    } finally { g.release(); x.engine.shutdown(); }
  });
}
