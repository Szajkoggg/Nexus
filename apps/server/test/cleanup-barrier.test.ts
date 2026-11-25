// The workers' cleanup barrier at a step's end (AgentProcess.cleanup) in the in-process engine tests, with a cleanup
// that takes time or times out and a kill that comes late (gated-cleanup.ts's delayMs and timeoutMs, in-process-runtime's
// ProcessEnds; survey LC3, F5/F17, queue LCK). Without them an in-process cleanup resolves in a microtask, so the
// barrier never lasts and never fails off Windows. These tests hold today's behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentProcess } from "../src/agent.ts";
import type { Launch } from "../src/agent-host.ts";
import { FAST, setup } from "./engine-setup.ts";
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

test("a cleanup that times out halts the run, naming it; the process is killed after, and the halt does not wait for its exit", async () => {
  const ends: ProcessEnds = { kill: { delayMs: 50 }, dropped: [] };
  let killedAt: number | undefined, exitedAt: number | undefined;
  const watch = (proc: AgentProcess) => {
    const kill = proc.kill.bind(proc);
    proc.kill = () => { killedAt ??= Date.now(); kill(); };
    proc.on("exit", () => { exitedAt ??= Date.now(); });
    return proc;
  };
  const g = gatedCleanup({ make: inProcessRuntime({ ends, wrap: watch }), timeoutMs: 50 });
  const { engine, queue, received, until } = setup(["done", "done"], { ...FAST, spawn: g.spawn });
  try {
    engine.start("Q", { runtime: "claude" });
    await until("the run halted", () => queue().run?.state === "halted", LONGER.run);
    const run = queue().run!;
    assert.equal(run.reason, "worker process cleanup failed: Error: worker cleanup timed out");
    assert.deepEqual(queue().steps.map((s) => s.status), ["done", "pending"], "Q2 never opens");
    assert.ok(!received().some((m) => m.text.includes("step Q2")));
    assert.deepEqual(g.calls, [{ turned: true, outcome: "failed" }]);
    await until("the killed process exited", () => exitedAt !== undefined);
    assert.ok(killedAt !== undefined, "the process is killed");
    assert.ok(exitedAt! - killedAt >= 45, `the kill came late (${exitedAt! - killedAt} ms after it was asked)`);
    assert.ok(Date.parse(run.ended_at!) <= killedAt, `the run halted (${run.ended_at}) before the kill was asked (${new Date(killedAt).toISOString()}), so before the exit`);
  } finally { letEnd(ends); engine.shutdown(); }
});
