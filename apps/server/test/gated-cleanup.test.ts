// The shared cleanup stand-in (gated-cleanup.ts) on a process stand-in: counting, holding, releasing, failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CleanupTimedOut, type AgentEvents, type AgentProcess } from "../src/agent.ts";
import type { Launch } from "../src/agent-host.ts";
import { gatedCleanup } from "./gated-cleanup.ts";

class Stand extends EventEmitter<AgentEvents> implements AgentProcess {
  state: "working" | "idle" | "exited" = "idle";
  readonly pid = 1;
  cleaned = 0;
  send(): void { this.state = "working"; }
  stop(): boolean { return true; }
  close(): void {}
  kill(): void {}
  cleanup(): Promise<void> { this.cleaned++; return Promise.resolve(); }
}

const launch = { runtime: "claude", options: {} } as unknown as Launch;
const settled = async <T>(p: Promise<T>): Promise<"done" | "failed" | "waiting"> =>
  Promise.race([p.then(() => "done" as const, () => "failed" as const), new Promise<"waiting">((r) => setTimeout(() => r("waiting"), 30))]);

test("gatedCleanup counts every cleanup, holds them at its gate, and releases or fails them (queue LH)", async () => {
  const g = gatedCleanup({ make: () => new Stand() });
  const proc = g.spawn(launch) as Stand;
  assert.equal(await settled(proc.cleanup()), "done", "an open gate: the process's own cleanup runs");
  assert.equal(proc.cleaned, 1);
  proc.send();
  g.hold();
  const held = proc.cleanup();
  assert.equal(await settled(held), "waiting");
  assert.equal(g.held(), 1);
  g.release();
  assert.equal(await settled(held), "done");
  assert.equal(proc.cleaned, 2);
  g.hold();
  const failing = proc.cleanup();
  g.fail("boom");
  await assert.rejects(failing, /boom/);
  await assert.rejects(proc.cleanup(), /boom/, "later ones fail too, until a release");
  assert.equal(proc.cleaned, 2, "a failed cleanup never reaches the process's own");
  assert.deepEqual(g.calls, [{ turned: false, outcome: "done" }, { turned: true, outcome: "done" }, { turned: true, outcome: "failed" }, { turned: true, outcome: "failed" }]);
});

test("gatedCleanup's failBeforeTurn fails a cleanup only before the process's first turn (queue LH)", async () => {
  const g = gatedCleanup({ make: () => new Stand(), failBeforeTurn: "worker cleanup timed out" });
  const proc = g.spawn(launch) as Stand;
  await assert.rejects(proc.cleanup(), CleanupTimedOut, "that message fails as the job host's timeout does");
  proc.send();
  await proc.cleanup();
  assert.equal(proc.cleaned, 1);
});

test("gatedCleanup's delayMs makes a cleanup that passes the gate take that long before the process's own; timeoutMs fails it as the job host's limit does, all or the first `timeouts` (queue LCK)", async () => {
  const slow = gatedCleanup({ make: () => new Stand(), delayMs: 40 });
  const proc = slow.spawn(launch) as Stand;
  const p = proc.cleanup();
  assert.equal(await settled(p), "waiting");
  assert.equal(proc.cleaned, 0, "not before the delay");
  await p;
  assert.equal(proc.cleaned, 1);
  const late = gatedCleanup({ make: () => new Stand(), timeoutMs: 45 });
  const stuck = late.spawn(launch) as Stand;
  const q = stuck.cleanup();
  assert.equal(await settled(q), "waiting");
  await assert.rejects(q, (e) => e instanceof CleanupTimedOut && e.message === "worker cleanup timed out");
  await assert.rejects(stuck.cleanup(), CleanupTimedOut, "without `timeouts`, every one");
  assert.equal(stuck.cleaned, 0, "a timed-out cleanup never reaches the process's own");
  assert.deepEqual(late.calls, [{ turned: false, outcome: "failed" }, { turned: false, outcome: "failed" }]);
  const once = gatedCleanup({ make: () => new Stand(), timeoutMs: 1, timeouts: 1 });
  const retried = once.spawn(launch) as Stand;
  await assert.rejects(retried.cleanup(), CleanupTimedOut);
  await retried.cleanup();
  assert.equal(retried.cleaned, 1, "the second runs the process's own");
});
