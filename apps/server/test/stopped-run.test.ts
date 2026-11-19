// A run the user stopped (Stop: paused, "stopped by the user") during a step (queue EF, EF3): the derivation keeps the
// step "running", as the step the run goes on with, but no agent works on it, so it is not among the steps at work
// (`nexus server status`, the projects' running count), an update's drain neither holds nor waits for it, a restart
// leaves it so, and Resume goes on with the step as before. Against the fake runtimes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProjectState, queueWorkedOn, stepsWorkedOn } from "@nexus/protocol";
import type { Engine } from "../src/engine.ts";
import { restart, setup } from "./engine-setup.ts";
import { LONGER, until as waitUntil } from "./wait.ts";

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: a step stopped by the user is not at work, the drain does not wait for it, nor after a restart; Resume goes on with it`, async () => {
    process.env.FAKE_SLOW_MS = "1500";
    const { store, engine, queue, received, until } = setup(["slownoop", "done"]);
    let next: Engine | undefined;
    const atWork = () => stepsWorkedOn(loadProjectState(store).queues).map((x) => `${x.queue.id}/${x.step.id}`);
    try {
      engine.start("Q", { runtime });
      await until("the step at work", () => queue().run?.state === "running" && queue().steps[0]!.status === "running", LONGER.step);
      assert.deepEqual(atWork(), ["Q/Q1"]);
      assert.equal(queueWorkedOn(queue()), true);

      engine.stopNow("Q");
      assert.deepEqual([queue().run?.state, queue().run?.reason], ["paused", "stopped by the user"]);
      // The derivation keeps the step it goes on with; nobody works on it.
      assert.equal(queue().steps[0]!.status, "running");
      assert.deepEqual(atWork(), []);
      assert.equal(queueWorkedOn(queue()), false);
      await waitUntil("the stopped turn to end", () => engine.idle(), LONGER.step);

      // An update's drain holds nothing and waits for nothing.
      assert.deepEqual(engine.drainForUpdate(false), [], "a stopped run is not held");
      assert.ok(engine.idle(), "nothing to wait for");
      assert.equal(queue().run?.resume_after_restart, undefined, "the next server does not resume it by itself");
      engine.shutdown();

      // After a restart: still stopped, still not at work.
      next = restart(store);
      next.onChange(loadProjectState(store));
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual([queue().run?.state, queue().run?.reason], ["paused", "stopped by the user"]);
      assert.deepEqual(atWork(), []);

      // Resume: the step goes on in its session, as before, and is at work again.
      const before = received().length;
      next.resume("Q");
      assert.equal(queue().run?.state, "running");
      assert.deepEqual(atWork(), ["Q/Q1"]);
      await until("the step continued", () => received().slice(before).some((m) => /Continue this step where it was left/.test(m.text) && /Q1/.test(m.text)), LONGER.step);
    } finally { engine.shutdown(); next?.shutdown(); delete process.env.FAKE_SLOW_MS; }
  });
}
