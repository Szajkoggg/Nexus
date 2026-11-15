// The store's write count (store.ts, writeCount): every write through the store moves it, a read never does. The
// server passes one state snapshot on until it moves (apps/server/src/main.ts, stateOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, addNote, approveQueue, deleteNote, loadProjectState, newId, writeCount, type Event } from "../src/index.ts";

function project() {
  const root = mkdtempSync(join(tmpdir(), "nexus-writes-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.writeQueue({ protocol: 1, id: "Q", title: "Q", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [{ id: "A", title: "A", goal: "", acceptance: [] }] });
  return st;
}

test("every kind of write through the store moves the count; a read does not", () => {
  const st = project();
  const moved = (what: string, write: () => void) => { const before = writeCount(); write(); assert.ok(writeCount() > before, what); };
  moved("a YAML file", () => st.writeQueue({ ...st.readQueue("Q"), title: "Q2" }));
  moved("an appended line", () => st.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: "s1", type: "log", level: "info", text: "x" } as Event));
  moved("an approval", () => approveQueue(st, "Q"));
  moved("a note", () => addNote(st, "Q", "A", "look at the header"));
  const note = loadProjectState(st).queues[0]!.steps[0]!.notes[0]!;
  moved("a note withdrawn", () => deleteNote(st, "Q", "A", note.id));
  const before = writeCount();
  loadProjectState(st); st.readQueue("Q"); st.readRun("Q");
  assert.equal(writeCount(), before, "reads leave it");
});
