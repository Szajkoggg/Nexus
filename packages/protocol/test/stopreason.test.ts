// A stop's condition and reason kept apart (queue QR): the derived queue has both, its waiting item the reason as its
// text and the condition beside it; a stop known as one text (imported as stopped) shows that text as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, loadProjectState, newId, type Event } from "../src/index.ts";

function project(status: "proposed" | "stopped" = "proposed", note?: string) {
  const root = mkdtempSync(join(tmpdir(), "nexus-stopreason-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: new Date().toISOString() });
  st.writeQueue({ protocol: 1, id: "M", title: "Mining", revision: 1, status, status_note: note, stop_conditions: ["A number the sheet does not give is needed"], checks: [],
    steps: [{ id: "M1", title: "Ore", goal: "", acceptance: [] }, { id: "M2", title: "Yield", goal: "", acceptance: [] }] } as never);
  if (status === "proposed") approveQueue(st, "M");
  const emit = (body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: "w", ...body } as Event);
  return { st, emit };
}

test("a stop with a condition and a reason derives both, apart, and the waiting item shows the reason", () => {
  const x = project();
  x.emit({ type: "step.started", queue: "M", step: "M2" });
  x.emit({ type: "queue.stop", queue: "M", step: "M2", condition: "A number the sheet does not give is needed", reason: "The yield of deep veins is not in the sheet." });
  const s = loadProjectState(x.st);
  const q = s.queues[0]!;
  assert.equal(q.status, "stopped");
  assert.deepEqual(q.stop, { condition: "A number the sheet does not give is needed", reason: "The yield of deep veins is not in the sheet." });
  assert.equal(q.status_reason, "A number the sheet does not give is needed: The yield of deep veins is not in the sheet.", "the one text stays for its readers");
  assert.equal(q.steps[1]!.reason, "The yield of deep veins is not in the sheet.");
  const a = s.attention.find((x) => x.kind === "stopped")!;
  assert.equal(a.text, "The yield of deep veins is not in the sheet.");
  assert.equal(a.condition, "A number the sheet does not give is needed");
});

test("an old single-text stop (imported as stopped) still shows its text, with no condition apart", () => {
  const x = project("stopped", "Stopped by hand: the sheet is being redone");
  const s = loadProjectState(x.st);
  const q = s.queues[0]!;
  assert.equal(q.status, "stopped");
  assert.equal(q.stop, undefined);
  assert.equal(q.status_reason, "Stopped by hand: the sheet is being redone");
  const a = s.attention.find((x) => x.kind === "stopped")!;
  assert.equal(a.text, "Stopped by hand: the sheet is being redone");
  assert.equal("condition" in a, false);
});

test("a lift clears the stop; a later stop replaces it", () => {
  const x = project();
  x.emit({ type: "step.started", queue: "M", step: "M2" });
  x.emit({ type: "queue.stop", queue: "M", step: "M2", condition: "c1", reason: "r1" });
  const file = x.st.readQueue("M");
  x.st.writeQueue({ ...file, changes: [{ at: new Date().toISOString(), kind: "lift", by: "user_continue", from: "stopped", to: "approved" }] } as never);
  assert.equal(loadProjectState(x.st).queues[0]!.stop, undefined);
  x.emit({ type: "step.started", queue: "M", step: "M2" });
  x.emit({ type: "queue.stop", queue: "M", step: "M2", condition: "c2", reason: "r2" });
  assert.deepEqual(loadProjectState(x.st).queues[0]!.stop, { condition: "c2", reason: "r2" });
});
