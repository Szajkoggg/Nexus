// The shared cleanup stand-in (gated-cleanup.ts) on a process stand-in: counting, holding, releasing, failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AgentEvents, AgentProcess } from "../src/agent.ts";
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
  await assert.rejects(proc.cleanup(), /worker cleanup timed out/);
  proc.send();
  await proc.cleanup();
  assert.equal(proc.cleaned, 1);
});
