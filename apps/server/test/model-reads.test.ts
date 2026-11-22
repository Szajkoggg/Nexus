// The suite's stores read through the server's model of the files (queue MF; docs/design/model.md, "Its reads are
// read-only"): npm test, test:files and the load tool load apps/server/test/model-reads.ts before every file. What a
// store made without a reader hands out is then the model's, frozen, so a test or code that changes it fails in the
// checks as it would in the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, loadProjectState, newId, type Event } from "@nexus/protocol";

process.env.NEXUS_HOME = mkdtempSync(join(tmpdir(), "nexus-model-reads-home-"));

test("a test's store reads through the model: the state and the log entries it hands out are frozen, and changing them fails", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-model-reads-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: new Date().toISOString(), queue: "Q" });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "Step", goal: "", acceptance: [] }] });
  store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: "w", type: "step.started", queue: "Q", step: "Q1" } as Event);
  const state = loadProjectState(store);
  assert.equal(loadProjectState(new ProjectStore(store.dir)), state, "one shared derivation: the model's");
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.queues[0]!.steps[0]), "the state is frozen deeply");
  assert.throws(() => { (state.queues[0]!.steps[0] as { status: string }).status = "running"; }, TypeError);
  assert.throws(() => { (state.queues as unknown[]).push({}); }, TypeError);
  const e = store.readEvents("w").entries[0]!;
  assert.throws(() => { (e as { at: string }).at = "x"; }, TypeError, "a log entry too");
  const own = structuredClone(state);
  own.queues[0]!.steps[0]!.status = "running";
  assert.equal(own.queues[0]!.steps[0]!.status, "running", "a copy of its own is the code's to change");
});
