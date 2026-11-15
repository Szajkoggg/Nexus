// The project's checks (defaults.checks, queue SA): a run fixes them at its start and every step's opening lists them
// before the queue's own; a change of the setting reaches a queue at its next run. Against the fake runtimes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { approveQueue, loadProjectState, updateSettings } from "@nexus/protocol";
import { setup } from "./engine-setup.ts";
import { LONGER, holdWork } from "./wait.ts";

/** The "Checks for every step" list of a step's opening, one name per entry. */
function checksOf(text: string): string[] {
  const m = /\nChecks for every step:\n((?:- .*\n?)+)/.exec(text);
  return m ? m[1]!.trim().split("\n").map((l) => l.slice(2)) : [];
}

test("a run fixes the project's checks at its start: its steps list them first, a change reaches the next run", async () => {
  const work = holdWork();
  process.env.FAKE_SLOW_MS = "60000";
  const { store, engine, queue, received, until } = setup(["slow", "done"]);
  try {
    // The queue's own checks; one of them is also the project's and runs once.
    const q = store.readQueue("Q")!;
    store.writeQueue({ ...q, checks: ["npm run typecheck", "npm test"] });
    approveQueue(store, "Q");
    updateSettings(store, { defaults: { checks: [" npm test ", "npm run lint", ""] } });
    assert.deepEqual(store.readProject().defaults.checks, ["npm test", "npm run lint"], "trimmed, empty lines dropped");

    engine.start("Q");
    assert.deepEqual(queue().run!.checks, ["npm test", "npm run lint"], "the run fixed them at its start");
    await until("Q1 at work", () => queue().steps[0]!.segments.length > 0, LONGER.step);
    const opening = (step: string) => received().find((m) => m.text.includes(`step ${step} (`))?.text ?? "";
    assert.deepEqual(checksOf(opening("Q1")), ["npm test", "npm run lint", "npm run typecheck"], "the project's first, each once");

    // Changed while the run goes on: its next step still runs what the run fixed.
    updateSettings(store, { defaults: { checks: ["npm run knip"] } });
    work.release();
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(checksOf(opening("Q2")), ["npm test", "npm run lint", "npm run typecheck"]);

    // The next run (another queue here) takes the setting as it is now.
    store.writeQueue({ protocol: 1, id: "B", title: "Next", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [],
      steps: [{ id: "B1", title: "One", goal: "FAKE: done", acceptance: [] }] });
    approveQueue(store, "B");
    engine.start("B");
    const b = () => loadProjectState(store).queues.find((x) => x.id === "B")!;
    await until("B to finish", () => b().run?.state === "finished", LONGER.run);
    assert.deepEqual(b().run!.checks, ["npm run knip"]);
    assert.deepEqual(checksOf(opening("B1")), ["npm run knip"], "a queue without checks of its own gets only the project's");
  } finally {
    engine.shutdown();
    work.done();
    delete process.env.FAKE_SLOW_MS;
  }
});
