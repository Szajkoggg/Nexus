// A server starting on damaged saved state (survey LC3, F9/F10/F15; queue LCK): engine-setup's restart() with
// `corrupt`, which damages a queue's file or a session's runtime.json before the next Engine is made. The rule is
// docs/design/state.md, "Missing and unreadable files", with the user's decisions of queue LCK:
// - F9: an unreadable run.yaml, plan.yaml or start.yaml does not keep the engine from starting: that one queue is left
//   out of the recovery (a warning in the project's state names the file, the server's log says it is not recovered),
//   the other queues are recovered, and the file is not written over.
// - F10: an unreadable runtime.json at the recovery: a warning; the session is marked exited, a turn the old server
//   left open is knowingly dropped (the warning says so), and the file is set aside as runtime.json.corrupt.
// - F15: an unreadable checks.yaml leaves that queue's checks out of the recovery, with a warning; the others' sets
//   are recovered.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectState, now, type ChecksFile } from "@nexus/protocol";
import { Capacity } from "../src/capacity.ts";
import type { Engine } from "../src/engine.ts";
import { tempDir } from "./temp-dirs.ts";
import { FAST, fixtureRun, restart, setup } from "./engine-setup.ts";
import { holdWork } from "./wait.ts";

/**
 * A queue Q at work (or finished: `done`) and a queue R a server left running too; the server gone (shut down) before
 * Q's step ends.
 */
async function interrupted(o: { done?: boolean } = {}) {
  const hold = holdWork();
  const x = setup([o.done ? "done" : "slow"]);
  x.engine.start("Q", { runtime: "claude" });
  if (o.done) await x.until("Q finished", () => x.queue().run?.state === "finished");
  else await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
  const session = x.queue().run!.session;
  x.engine.shutdown();
  hold.done();
  // The old server's handling of its process's exit reads the run: done before the files are damaged.
  await x.until("the old process exited", () => x.store.readRuntime(session)?.state === "exited");
  fixtureRun(x.store, "R", "running");
  return { ...x, session };
}

/** console.warn's lines while `fn` runs. */
function warned<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const m = mock.method(console, "warn", (...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  try { return { value: fn(), lines }; } finally { m.mock.restore(); }
}

const RESTARTED = "the Nexus server restarted; resume to continue";

const F9 = [
  { name: "run.yaml of a running queue", file: "run.yaml", done: false },
  { name: "run.yaml of a finished queue", file: "run.yaml", done: true },
  { name: "plan.yaml", file: "plan.yaml", done: false },
  { name: "start.yaml", file: "start.yaml", done: false },
];

for (const v of F9) {
  for (const as of ["unparsable", "schema"] as const) {
    test(`F9: ${as === "unparsable" ? "an unparsable" : "a schema-invalid"} ${v.name}: the next Engine starts, the queue is left out with a warning naming the file, the other queue is recovered, the file stays as it was`, async () => {
      const { store, queue } = await interrupted({ done: v.done });
      const path = join(store.dir, "queues", "Q", v.file);
      let next: Engine | undefined;
      try {
        const { lines } = warned(() => { next = restart(store, FAST, { corrupt: [{ queue: "Q", file: v.file, as }] }); });
        const damaged = readFileSync(path, "utf8");
        const state = loadProjectState(store);
        assert.ok(state.warnings.some((w) => w.includes(`queues/Q/${v.file} cannot be read`)), `the state's warning names the file: ${state.warnings.join(" | ")}`);
        if (v.file === "run.yaml") assert.ok(lines.some((l) => l.includes(`queues/Q/${v.file} cannot be read`) && l.includes("queue Q is not recovered")), `the log says so: ${lines.join(" | ")}`);
        const r = state.queues.find((q) => q.id === "R")!.run!;
        assert.equal(r.state, "paused", "the other queue is recovered");
        assert.equal(r.reason, RESTARTED);
        if (v.file !== "run.yaml") assert.equal(queue().run?.state, "paused", "Q itself is recovered: only its plan cannot be read");
        next!.onChange(state); // the server's first look after the start
        assert.equal(readFileSync(path, "utf8"), damaged, "the file is not written over");
        assert.ok(!existsSync(`${path}.corrupt`), "nor set aside");
      } finally { next?.shutdown(); }
    });
  }
}

test("F9's edge: an unparsable checks.yaml or git.yaml is a warning naming the file; the next Engine starts and pauses the run as after any restart", async () => {
  for (const file of ["checks.yaml", "git.yaml"]) {
    const { store, queue } = await interrupted();
    const next = restart(store, FAST, { corrupt: [{ queue: "Q", file }] });
    try {
      const state = loadProjectState(store);
      assert.ok(state.warnings.some((w) => w.includes(`queues/Q/${file} cannot be read`)), JSON.stringify(state.warnings));
      assert.equal(queue().run?.state, "paused");
      assert.equal(queue().run?.reason, RESTARTED);
    } finally { next.shutdown(); }
  }
});

test("F10: an unreadable runtime.json at the recovery warns that the left turn is dropped, marks the session exited and sets the file aside", async () => {
  const { store, queue, session } = await interrupted();
  const path = join(store.dir, "sessions", session, "runtime.json");
  // The control: a readable record a crashed server left `working` is recovered as `exited`.
  store.writeRuntime(session, { ...store.readRuntime(session)!, state: "working" });
  restart(store).shutdown();
  assert.equal(store.readRuntime(session)?.state, "exited");
  store.writeRuntime(session, { ...store.readRuntime(session)!, state: "working" });
  let next: Engine | undefined;
  try {
    const { lines } = warned(() => { next = restart(store, FAST, { corrupt: [{ session, file: "runtime.json", as: "schema" }] }); });
    const damaged = readFileSync(`${path}.corrupt`, "utf8");
    assert.match(damaged, /"state": 42/, "set aside as it was");
    assert.ok(lines.some((l) => l.includes(`sessions/${session}/runtime.json cannot be read`) && l.includes("marked exited") && l.includes("not recorded")), `the warning names the file and the dropped turn: ${lines.join(" | ")}`);
    const record = store.readRuntime(session)!;
    assert.equal(record.state, "exited");
    assert.equal(record.conversation_saved, false, "nothing known of the conversation: it starts as one without a record would");
    assert.equal(queue().run?.state, "paused", "the run is recovered as after any restart");
    assert.ok(!loadProjectState(store).warnings.some((w) => w.includes("runtime.json")), "the state's warning is gone with the file");
  } finally { next?.shutdown(); }
});

test("F15: an unreadable checks.yaml leaves that queue's checks out of the recovery with a warning; another queue's running set is interrupted", async () => {
  const { store } = await interrupted();
  const t = now();
  const running: ChecksFile = { protocol: 1, steps: { R1: { by: "nexus", sets: [{ done: "e1", round: 1, fix: 0, requested_at: t, state: "running", checks: [{ name: "unit", command: "npm test", runs: [{ started_at: t, log: "r1.log" }] }] }] } } };
  store.writeChecks("R", running);
  let next: Engine | undefined;
  try {
    const { lines } = warned(() => { next = restart(store, { ...FAST, capacity: new Capacity({ testLock: join(tempDir("nexus-checks-lock-"), "full-test.lock"), pollMs: 20 }) }, { corrupt: [{ queue: "Q", file: "checks.yaml" }] }); });
    const path = join(store.dir, "queues", "Q", "checks.yaml");
    assert.ok(lines.some((l) => l.includes("queues/Q/checks.yaml cannot be read") && l.includes("its checks are not recovered")), lines.join(" | "));
    const set = store.readChecks("R")!.steps.R1!.sets[0]!;
    assert.equal(set.state, "interrupted", "R's set is recovered");
    assert.equal(set.checks[0]!.runs[0]!.interrupted, true);
    assert.equal(readFileSync(path, "utf8"), "state: [unclosed\n", "Q's file is not written over");
  } finally { next?.shutdown(); }
});
