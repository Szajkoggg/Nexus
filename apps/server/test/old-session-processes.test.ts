// A queue's earlier sessions keep no process (queue PRC): a fresh start of the queue ends the process a stopped run's
// session still has, and so does the queue's closing (done or cancelled), before its worktree is cleaned up. A Resume
// goes on in the same session and its process. Against the fake runtimes, in-process. Survey LC3, F1 (queue LCK): a
// start that continues the earlier session keeps its process, and a process at work in a turn is closed (it ends after
// its turn), not killed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProjectState, orchestratorStatusChange } from "@nexus/protocol";
import { activityOf, setup } from "./engine-setup.ts";
import { LONGER, holdWork } from "./wait.ts";

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

  test(`${runtime}: a start that continues the halted run's session keeps its process (survey LC3, F1 a)`, async () => {
    const { store, engine, queue, until, received, session: old } = await halted(["fail", "done"]);
    try {
      const before = received().length;
      let exited = false;
      const watch = setInterval(() => { if (store.readRuntime(old)?.state === "exited") exited = true; }, 5);
      try {
        engine.start("Q", { runtime, session: old });
        assert.equal(queue().run!.session, old, "the run goes on in the continued session");
        await until("the continued session's turn", () => received().length > before, LONGER.step);
        // The start goes on at the first pending step (the failed one stays failed): Q2 runs in the continued process.
        await until("Q2 done in the continued session", () => queue().steps[1]!.status === "done", LONGER.run);
      } finally { clearInterval(watch); }
      assert.equal(exited, false, "its runtime record was never exited while the run worked in it");
      assert.deepEqual(exits(store, old).filter((a) => /ended by Nexus/.test(a.text ?? "")), [], "the start did not end its process");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a fresh start beside a stopped run's process at work closes it: it ends after its turn, no failure or retry (survey LC3, F1 b)`, async () => {
    const hold = holdWork();
    const x = setup(["slow", "done"]);
    try {
      x.engine.start("Q", { runtime });
      await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running" && x.store.readRuntime(x.queue().run!.session)?.state === "working", LONGER.step);
      const old = x.queue().run!.session;
      x.engine.stopNow("Q");
      assert.equal(x.queue().run?.state, "paused", "stopped by the user: paused, its turn still at work");
      x.engine.start("Q", { runtime });
      const fresh = x.queue().run!.session;
      assert.notEqual(fresh, old);
      await x.until("the fresh session's process", () => x.store.readRuntime(fresh) !== undefined, LONGER.step);
      assert.equal(x.store.readRuntime(old)?.state, "working", "the old process works on: closed, not killed");
      assert.deepEqual(exits(x.store, old), [], "not ended in its turn");
      hold.release();
      await x.until("the old process to exit after its turn", () => x.store.readRuntime(old)?.state === "exited", LONGER.step);
      assert.match(exits(x.store, old).map((a) => a.text).join("\n"), /ended by Nexus/);
      await x.until("the fresh run to end", () => x.queue().run?.state === "finished", LONGER.run);
      const run = x.queue().run!;
      assert.equal(run.session, fresh);
      assert.equal(run.retries, undefined, "no retry recorded");
      assert.equal(run.failure, undefined, "no failure recorded");
    } finally { hold.done(); x.engine.shutdown(); }
  });
}
