// A queue's earlier sessions keep no process (queue PRC): a fresh start of the queue ends the process a stopped run's
// session still has, and so does the queue's closing (done or cancelled), before its worktree is cleaned up. A Resume
// goes on in the same session and its process. Against the fake runtimes, in-process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProjectState, orchestratorStatusChange } from "@nexus/protocol";
import { activityOf, setup } from "./engine-setup.ts";
import { LONGER } from "./wait.ts";

for (const runtime of ["claude", "codex"] as const) {
  /** A queue whose first step fails: its run halts, its session's process stays (idle). */
  const halted = async (steps: string[]) => {
    const x = setup(steps);
    x.engine.start("Q", { runtime });
    await x.until("the halt", () => x.queue().run?.state === "halted", LONGER.run);
    const session = x.queue().run!.session;
    await x.until("the halted run's process idle", () => x.store.readRuntime(session)?.state === "idle", LONGER.step);
    assert.equal(x.engine.alive(), true, "the halted run's process is still alive");
    return { ...x, session };
  };
  const exits = (store: ReturnType<typeof setup>["store"], session: string) => activityOf(store, session).filter((a) => a.kind === "exit" || (a.kind === "error" && /process exited/.test(a.text ?? "")));

  test(`${runtime}: a fresh start ends the process a stopped run's session still has`, async () => {
    const { store, engine, queue, until, session: old } = await halted(["fail", "done"]);
    try {
      engine.start("Q", { runtime });
      const fresh = queue().run!.session;
      assert.notEqual(fresh, old, "the run goes on in a fresh session");
      await until("the old session's process to exit", () => store.readRuntime(old)?.state === "exited", LONGER.step);
      assert.match(exits(store, old).map((a) => a.text).join("\n"), /ended by Nexus/);
      await until("the fresh run to end", () => queue().steps[1]!.status === "done", LONGER.run);
    } finally { engine.shutdown(); }
  });

  for (const close of ["cancelled", "done"] as const) {
    test(`${runtime}: a queue ${close} while an earlier session's process lives keeps no process`, async () => {
      const { store, engine, until, session } = await halted(["fail"]);
      try {
        if (close === "cancelled") orchestratorStatusChange(store, { queue: "Q", to: "cancelled", reason: "test" });
        else {
          orchestratorStatusChange(store, { queue: "Q", step: "Q1", to: "skipped", reason: "test" });
          orchestratorStatusChange(store, { queue: "Q", to: "finished", reason: "test" });
        }
        // The server calls onChange after every file change.
        engine.onChange(loadProjectState(store));
        await until(`no process of the ${close} queue`, () => !engine.alive(), LONGER.step);
        assert.equal(store.readRuntime(session)?.state, "exited");
        assert.equal(engine.endQueueProcesses("Q"), true, "nothing left for a cleanup to wait for");
      } finally { engine.shutdown(); }
    });
  }

  test(`${runtime}: a Resume goes on in the same session and its process`, async () => {
    const { store, engine, queue, until, received, session } = await halted(["fail", "done"]);
    try {
      const before = received().length;
      engine.resume("Q");
      assert.equal(queue().run!.session, session, "the same session");
      await until("the continued step's turn", () => received().length > before, LONGER.step);
      await until("its turn to end", () => queue().run?.state !== "running" || store.readRuntime(session)?.state === "idle", LONGER.step);
      assert.notEqual(store.readRuntime(session)?.state, "exited", "the process was not ended");
      assert.deepEqual(exits(store, session), [], "no process of the session exited");
    } finally { engine.shutdown(); }
  });
}
