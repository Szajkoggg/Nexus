// The workers' cleanup barrier at a step's end (AgentProcess.cleanup) in the in-process engine tests, with a cleanup
// that takes time or times out and a kill that comes late (gated-cleanup.ts's delayMs and timeoutMs, in-process-runtime's
// ProcessEnds; survey LC3, F5/F17, queue LCK). Without them an in-process cleanup resolves in a microtask, so the
// barrier never lasts and never fails off Windows. A timed-out cleanup is asked once more within the same barrier;
// only a second timeout halts the run (the user's decision with queue LCK, F5).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentProcess } from "../src/agent.ts";
import type { Launch } from "../src/agent-host.ts";
import { FAST, activityOf, setup } from "./engine-setup.ts";
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
    proc.kill = () => { seen.killedAt ??= Date.now(); kill(); };
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
