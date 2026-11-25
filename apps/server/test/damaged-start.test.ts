// A server starting on damaged saved state (survey LC3, F9/F10/F15; queue LCK): engine-setup's restart() with
// `corrupt`, which damages a queue's file or a session's runtime.json before the next Engine is made. These tests hold
// today's behaviour, which the survey names as gaps: an unreadable run.yaml or plan.yaml throws out of the Engine's
// constructor (the project's engine does not start), while an unreadable checks.yaml or git.yaml is a warning and an
// unreadable runtime.json is skipped at recovery. The fix steps of queue LCK change what they decide on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectState } from "@nexus/protocol";
import type { Engine } from "../src/engine.ts";
import { FAST, restart, setup } from "./engine-setup.ts";
import { holdWork } from "./wait.ts";

/** A queue Q whose step runs, and the server gone (shut down) before it ends. */
async function interrupted() {
  const hold = holdWork();
  const x = setup(["slow"]);
  x.engine.start("Q", { runtime: "claude" });
  await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
  const session = x.queue().run!.session;
  x.engine.shutdown();
  hold.done();
  // The old server's handling of its process's exit reads the run: done before the files are damaged.
  await x.until("the old process exited", () => x.store.readRuntime(session)?.state === "exited");
  return { ...x, session };
}

for (const file of ["run.yaml", "plan.yaml"]) {
  for (const as of ["unparsable", "schema"] as const) {
    test(`${as === "unparsable" ? "an unparsable" : "a schema-invalid"} ${file} throws out of the next Engine's constructor, naming the file (F9, as it stands)`, async () => {
      const { store } = await interrupted();
      let next: Engine | undefined;
      try {
        assert.throws(() => { next = restart(store, FAST, { corrupt: [{ queue: "Q", file, as }] }); }, (e: Error) => {
          assert.equal(e.name, "UnreadableFileError");
          assert.ok(e.message.includes(`queues/Q/${file} cannot be read`), e.message);
          return true;
        });
        assert.ok(!existsSync(join(store.dir, "queues", "Q", `${file}.corrupt`)), "never set aside");
      } finally { next?.shutdown(); }
    });
  }
}

for (const file of ["checks.yaml", "git.yaml"]) {
  test(`an unparsable ${file} is a warning naming the file; the next Engine starts and pauses the run as after any restart`, async () => {
    const { store, queue } = await interrupted();
    const next = restart(store, FAST, { corrupt: [{ queue: "Q", file }] });
    try {
      const state = loadProjectState(store);
      assert.ok(state.warnings.some((w) => w.includes(`queues/Q/${file} cannot be read`)), JSON.stringify(state.warnings));
      assert.equal(queue().run?.state, "paused");
      assert.equal(queue().run?.reason, "the Nexus server restarted; resume to continue");
    } finally { next.shutdown(); }
  });
}

test("an unreadable runtime.json is skipped at recovery: the next Engine starts, warns, and leaves the record as it is, not exited (F10, as it stands)", async () => {
  const { store, queue, session } = await interrupted();
  // The control: a readable record a crashed server left `working` is recovered as `exited`.
  store.writeRuntime(session, { ...store.readRuntime(session)!, state: "working" });
  restart(store).shutdown();
  assert.equal(store.readRuntime(session)?.state, "exited");
  store.writeRuntime(session, { ...store.readRuntime(session)!, state: "working" });
  const next = restart(store, FAST, { corrupt: [{ session, file: "runtime.json", as: "schema" }] });
  const path = join(store.dir, "sessions", session, "runtime.json");
  const damaged = readFileSync(path, "utf8");
  try {
    const state = loadProjectState(store);
    assert.ok(state.warnings.some((w) => w.includes(`sessions/${session}/runtime.json cannot be read`)), JSON.stringify(state.warnings));
    assert.equal(queue().run?.state, "paused", "the run is recovered as after any restart");
    assert.equal(readFileSync(path, "utf8"), damaged, "the record is not written exited");
    assert.ok(!existsSync(`${path}.corrupt`), "nor set aside until it is written again");
  } finally { next.shutdown(); }
});
