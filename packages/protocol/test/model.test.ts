// The model of a project's files (model.ts; docs/design/model.md): fed line by line and by write-through, it gives
// what a read of the files gives, and what a model thrown away and built again gives.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectModel, ProjectStore, addNote, deleteNote, loadProjectState, resetWork, workCounts, type Event, type ProjectState } from "../src/index.ts";
import { generateNexus } from "./synthetic.ts";

process.env.NEXUS_HOME = mkdtempSync(join(tmpdir(), "nexus-model-home-"));
const temp = mkdtempSync(join(tmpdir(), "nexus-model-"));
after(() => rmSync(temp, { recursive: true, force: true }));

let n = 0;
function project(): { root: string; files: ProjectStore; model: ProjectModel } {
  const root = join(temp, `p${++n}`);
  generateNexus(root, { scale: 0.1, seed: n });
  const files = ProjectStore.forRoot(root);
  return { root, files, model: new ProjectModel(files.dir) };
}
const plain = ({ generated_at: _g, ...s }: ProjectState) => s;
let ids = 0;
const event = (session: string, body: Record<string, unknown>) =>
  ({ v: 1, id: `T${String(++ids).padStart(6, "0")}`, at: new Date(Date.UTC(2026, 10, 1) + ids * 1000).toISOString(), session, ...body }) as Event;

/** The model gives what the files give now, and what a model built afresh gives. */
function same(p: { files: ProjectStore; model: ProjectModel }, what: string): void {
  const fed = p.model.current();
  assert.deepEqual(plain(fed), plain(loadProjectState(p.files)), `${what}: against the files`);
  const fresh = new ProjectModel(p.files.dir);
  try { assert.deepEqual(plain(fed), plain(fresh.current()), `${what}: against a model built again`); } finally { fresh.close(); }
  for (const s of p.files.sessionIds()) {
    assert.deepEqual(p.model.store.readActivity(s), p.files.readActivity(s), `${what}: ${s}'s activity`);
    assert.deepEqual(p.model.store.readChat(s), p.files.readChat(s), `${what}: ${s}'s chat`);
  }
}

test("fed line by line and by write-through, the model gives what the files give and what a rebuilt model gives", () => {
  const p = project();
  same(p, "at the start");
  const worker = p.files.sessionIds().find((s) => s.startsWith("w-"))!;
  const q = p.files.readSession(worker).queue!;
  const step = p.files.readQueue(q).steps[0]!.id;
  // This process's writes (write-through), through either store.
  p.files.appendEvent(event(worker, { type: "step.progress", queue: q, step, text: "half way" }));
  p.files.appendActivity(worker, { at: new Date().toISOString(), kind: "tool", text: "Read a.ts", queue: q, step });
  same(p, "an event and an activity line");
  p.model.store.writeQueue({ ...p.files.readQueue(q), title: "Renamed" });
  same(p, "a queue rewritten");
  addNote(p.files, q, step, "look at the header");
  same(p, "a note added");
  const note = loadProjectState(p.files).queues.find((x) => x.id === q)!.steps[0]!.notes.at(-1)!;
  deleteNote(p.files, q, step, note.id);
  same(p, "a note withdrawn");
  p.files.writeSession({ protocol: 1, id: "new-one", project: "synthetic", role: "worker", runtime: "claude", cwd: "C:/x", launched_by: "nexus", created_at: new Date().toISOString(), queue: q });
  p.files.appendEvent(event("new-one", { type: "step.progress", queue: q, step, text: "from a new session" }));
  same(p, "a new session");
  p.files.archiveRun(q);
  same(p, "a run archived");
  // Another process's writes, as the watcher reports them.
  const log = join(p.files.sessionDir(worker), "events.jsonl");
  appendFileSync(log, `${JSON.stringify(event(worker, { type: "step.progress", queue: q, step, text: "from the CLI" }))}\n`);
  p.model.touched(log);
  same(p, "another process's line");
});

test("a line still being written waits for its newline; line numbers count blank and broken lines", () => {
  const p = project();
  const chatter = p.files.sessionIds().find((s) => s.startsWith("o-"))!;
  const chat = join(p.files.sessionDir(chatter), "chat.jsonl");
  const before = p.model.store.readChat(chatter).entries.length;
  appendFileSync(chat, "\nnot json\n");
  appendFileSync(chat, JSON.stringify({ at: "2026-11-20T10:00:00.000Z", from: "user", text: "half" }).slice(0, 20));
  p.model.touched(chat);
  const half = p.model.store.readChat(chatter);
  assert.equal(half.entries.length, before);
  assert.equal(half.errors.length, 1);
  writeFileSync(chat, `${JSON.stringify({ at: "2026-11-20T10:00:00.000Z", from: "user", text: "half" }).slice(20)}\n`, { flag: "a" });
  p.model.touched(chat);
  assert.deepEqual(p.model.store.readChat(chatter), p.files.readChat(chatter));
  assert.equal(p.model.store.readChat(chatter).entries.length, before + 1);
});

test("a log rewritten under its position is read again whole, and counted", () => {
  const p = project();
  const worker = p.files.sessionIds().find((s) => s.startsWith("w-"))!;
  const file = join(p.files.sessionDir(worker), "activity.jsonl");
  p.model.store.readActivity(worker);
  const line = (text: string) => `${JSON.stringify({ at: "2026-11-20T10:00:00.000Z", kind: "tool", text })}\n`;
  writeFileSync(file, line("one") + line("two"));
  p.model.touched(file);
  assert.deepEqual(p.model.store.readActivity(worker), p.files.readActivity(worker), "shorter");
  writeFileSync(file, line("one") + line("dos") + line("three"));
  p.model.touched(file);
  assert.deepEqual(p.model.store.readActivity(worker), p.files.readActivity(worker), "longer, other bytes just before its position (within the 64 compared)");
  assert.equal(p.model.cache.resets, 2);
});

test("what the model hands out is read-only: a reader that changes it fails", () => {
  const p = project();
  const worker = p.files.sessionIds().find((s) => s.startsWith("w-"))!;
  const e = p.model.store.readEvents(worker).entries[0]!;
  assert.throws(() => { (e as { at: string }).at = "x"; }, TypeError);
});

test("the state is derived once per change; an activity line changes nothing of it", () => {
  const p = project();
  const s1 = p.model.current();
  assert.equal(p.model.current(), s1, "asked again: the same state");
  const worker = p.files.sessionIds().find((s) => s.startsWith("w-"))!;
  p.files.appendActivity(worker, { at: new Date().toISOString(), kind: "tool", text: "Bash npm test" });
  assert.equal(p.model.current(), s1, "an activity line: the same state");
  p.files.appendEvent(event(worker, { type: "log", level: "info", text: "x" }));
  assert.notEqual(p.model.current(), s1, "an event: derived again");
  p.model.changed();
  const s2 = p.model.current();
  p.model.rebuild();
  assert.deepEqual(plain(p.model.current()), plain(s2), "thrown away and built again: the same");
});

test("the logs other processes append to now are read on before the state, unreported by the watcher", () => {
  const p = project();
  const worker = p.files.sessionIds().find((s) => s.startsWith("w-"))!;
  const model = new ProjectModel(p.files.dir, { volatile: () => [worker] });
  try {
    const before = model.current().sessions.find((s) => s.id === worker)!.event_count;
    appendFileSync(join(p.files.sessionDir(worker), "events.jsonl"), `${JSON.stringify(event(worker, { type: "log", level: "info", text: "step done, just now" }))}\n`);
    resetWork();
    assert.equal(model.current().sessions.find((s) => s.id === worker)!.event_count, before + 1);
    assert.ok(workCounts().bytes < 400, `only the line read (${workCounts().bytes} bytes)`);
  } finally { model.close(); }
});
