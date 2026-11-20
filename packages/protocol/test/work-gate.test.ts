// The work gate (queue SM, the decision of 2026-11-18): the reads' work counted, not timed, on a synthetic .nexus at
// 1x and 4x Nexus's own size (synthetic.ts). It measures the reads two ways: straight from the files (as the CLI, and
// the server's readers not moved yet, read: recorded for comparison) and through the server's model of the files
// (model.ts, docs/design/model.md), where its rules hold: one appended line reads that line (and the 64 bytes before
// it); a request makes no whole read; the start reads the project once; the counts are the same at 1x and 4x.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ProjectModel, ProjectStore, loadProjectState, newId, releaseOrphanedSteps, resetWork, workCounts, type Event, type WorkCounts } from "../src/index.ts";
import { NEXUS_SIZE, generateNexus, type SyntheticSize } from "./synthetic.ts";

process.env.NEXUS_HOME = mkdtempSync(join(tmpdir(), "nexus-gate-home-"));
const temp = mkdtempSync(join(tmpdir(), "nexus-gate-"));
after(() => rmSync(temp, { recursive: true, force: true }));

/** The work of `fn`'s reads. */
function counted(fn: () => unknown): WorkCounts {
  resetWork();
  fn();
  return workCounts();
}
type Line = WorkCounts & { line: number };

interface Files {
  /** One whole derivation: what a request after a change cost before the model. */
  rebuild: WorkCounts;
  /** The engine's recovery at the start before the model: releaseOrphanedSteps for every queue, then one more state. */
  start: WorkCounts;
}
interface Model {
  /** The engine's recovery through the model: one state for every queue. */
  start: WorkCounts;
  /** A request's state when nothing changed. */
  request: WorkCounts;
  /** The conversation list's reads (Conversations.list): every session file, every conversation's chat. */
  conversations: WorkCounts;
  /** One activity line appended (a streaming agent's), the state read, and the session's activity read (its view). */
  activityLine: Line;
  /** One event appended (an agent's nexus), reported by the watcher, then the state. */
  eventLine: Line;
  /** A streaming agent's runtime record rewritten (its context tokens), then the state. */
  runtime: Line;
}

function conversationList(st: ProjectStore): void {
  for (const id of st.sessionIds()) if (st.readSession(id).role === "conversation") st.readChat(id);
}

function measureAt(scale: number): { size: SyntheticSize; files: Files; model: Model } {
  const root = join(temp, `x${scale}`);
  const size = generateNexus(root, { scale });
  const st = ProjectStore.forRoot(root);
  // ---- straight from the files
  loadProjectState(st); // warm: the first read pays for the module's and the disk's caches
  const rebuild = counted(() => loadProjectState(st));
  const queues = st.queueIds();
  // Measured on one queue and counted for all: the same whole read each, a whole run takes minutes at 4x.
  const one = counted(() => releaseOrphanedSteps(st, queues[0]!));
  const files: Files = { rebuild, start: Object.fromEntries(Object.entries(one).map(([k, v]) => [k, v * queues.length + rebuild[k as keyof WorkCounts]])) as unknown as WorkCounts };

  // ---- through the model
  const model = new ProjectModel(st.dir);
  try {
    const start = counted(() => {
      let state = model.current();
      for (const q of queues) if (releaseOrphanedSteps(st, q, { state }).length) state = model.current();
    });
    const request = counted(() => model.current());
    conversationList(model.store);
    const conversations = counted(() => conversationList(model.store));
    const session = st.sessionIds().find((s) => s.startsWith("w-"))!;
    const dir = st.sessionDir(session);
    const grew = (file: string, fn: () => void): Line => { const size0 = statSync(file).size; const w = counted(fn); return { ...w, line: statSync(file).size - size0 }; };
    model.store.readActivity(session); // its view is open
    const activityLine = grew(join(dir, "activity.jsonl"), () => {
      st.appendActivity(session, { at: "2026-11-20T10:00:00.000Z", kind: "tool", text: "Read packages/protocol/src/state.ts" });
      model.current();
      model.store.readActivity(session);
    });
    const eventLine = grew(join(dir, "events.jsonl"), () => {
      st.appendEvent({ v: 1, id: newId(), at: "2026-11-20T10:00:01.000Z", session, type: "log", level: "info", text: "a line" } as Event);
      model.current();
    });
    const runtime = grew(join(dir, "runtime.json"), () => {
      st.writeRuntime(session, { ...st.readRuntime(session)!, context_tokens: 123_456 });
      resetWork(); // the write's own read of the record before it is the writer's, not the model's
      model.current();
    });
    return { size, files, model: { start, request, conversations, activityLine, eventLine, runtime } };
  } finally { model.close(); }
}

let x1: ReturnType<typeof measureAt>, x4: ReturnType<typeof measureAt>;
before(() => { x1 = measureAt(1); x4 = measureAt(4); });

const row = (what: string, a: WorkCounts, b: WorkCounts) =>
  `${what.padEnd(44)} 1x: ${a.files} files, ${a.bytes} bytes, ${a.probes} probes, ${a.rebuilds} rebuilds | 4x: ${b.files} files, ${b.bytes} bytes, ${b.probes} probes, ${b.rebuilds} rebuilds`;

test("the work of the reads at 1x and 4x: straight from the files, and through the model", (t) => {
  t.diagnostic(`synthetic 1x: ${x1.size.queues} queues, ${x1.size.sessions} sessions, ${x1.size.lines.events} events, ${x1.size.lines.activity} activity lines; 4x: ${x4.size.queues} queues, ${x4.size.sessions} sessions`);
  t.diagnostic(row("files: a whole rebuild (a request after a change)", x1.files.rebuild, x4.files.rebuild));
  t.diagnostic(row("files: the start (a state per queue)", x1.files.start, x4.files.start));
  t.diagnostic(row("model: the start (one state for every queue)", x1.model.start, x4.model.start));
  t.diagnostic(row("model: a request, nothing changed", x1.model.request, x4.model.request));
  t.diagnostic(row("model: the conversation list", x1.model.conversations, x4.model.conversations));
  t.diagnostic(row(`model: one activity line (${x1.model.activityLine.line} bytes)`, x1.model.activityLine, x4.model.activityLine));
  t.diagnostic(row(`model: one event line (${x1.model.eventLine.line} bytes)`, x1.model.eventLine, x4.model.eventLine));
  t.diagnostic(row("model: a runtime record rewritten", x1.model.runtime, x4.model.runtime));
  // Straight from the files, every change reads the whole project again, and the start once per queue.
  assert.equal(x1.files.start.rebuilds, x1.size.queues + 1);
  assert.equal(x4.files.start.rebuilds, x4.size.queues + 1);
  const ratio = x4.files.rebuild.bytes / x1.files.rebuild.bytes;
  assert.ok(ratio > 3 && ratio < 5, `a rebuild from the files reads about 4 times as much at 4x (${ratio.toFixed(2)})`);
});

test("rule: one appended activity line reads that line (and the 64 bytes before it), and derives nothing", () => {
  for (const { model: m } of [x1, x4]) {
    assert.equal(m.activityLine.rebuilds, 0);
    assert.ok(m.activityLine.bytes <= m.activityLine.line + 64, `${m.activityLine.bytes} bytes read for a line of ${m.activityLine.line}`);
  }
});
test("rule: one appended event reads that line (and the 64 bytes before it), and derives the state once", () => {
  for (const { model: m } of [x1, x4]) {
    assert.equal(m.eventLine.rebuilds, 1);
    assert.ok(m.eventLine.bytes <= m.eventLine.line + 64, `${m.eventLine.bytes} bytes read for a line of ${m.eventLine.line}`);
  }
});
test("rule: a rewritten runtime record is read alone, once", () => {
  for (const { model: m } of [x1, x4]) {
    assert.equal(m.runtime.files, 1);
    assert.ok(m.runtime.bytes <= m.runtime.line + 400, `${m.runtime.bytes} bytes read`);
  }
});
test("rule: the start reads the project once and derives its state once, at 1x and at 4x", () => {
  for (const { model: m, files } of [x1, x4]) {
    assert.equal(m.start.rebuilds, 1);
    assert.ok(m.start.bytes <= files.rebuild.bytes * 1.05, `${m.start.bytes} bytes against a whole read's ${files.rebuild.bytes}`);
  }
});
test("rule: a request makes no read; the counts are the same at 1x and 4x", () => {
  for (const { model: m } of [x1, x4]) {
    assert.deepEqual(m.request, { files: 0, bytes: 0, probes: 0, listings: 0, rebuilds: 0 });
    assert.deepEqual(m.conversations, { files: 0, bytes: 0, probes: 0, listings: 0, rebuilds: 0 });
  }
  const same = (k: "activityLine" | "eventLine" | "runtime") => ({ ...x1.model[k], line: 0, bytes: x1.model[k].bytes - x1.model[k].line });
  const at4 = (k: "activityLine" | "eventLine" | "runtime") => ({ ...x4.model[k], line: 0, bytes: x4.model[k].bytes - x4.model[k].line });
  for (const k of ["activityLine", "eventLine", "runtime"] as const) assert.deepEqual(at4(k), same(k), k);
});

/** Every file of a tree, by its path from the root, and a hash of its contents. */
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(`${relative(dir, p)}\n`).update(readFileSync(p)).update("\n");
    }
  };
  walk(dir);
  return h.digest("hex");
}

test("the generator gives the same tree for the same seed, another for another seed", () => {
  const root = join(temp, "seeded");
  const tree = (seed: number) => { rmSync(root, { recursive: true, force: true }); generateNexus(root, { seed, scale: 0.2 }); return treeHash(join(root, ".nexus")); };
  const a = tree(7);
  assert.equal(tree(7), a);
  assert.notEqual(tree(8), a);
});

test("the generated 1x is calibrated on Nexus's own .nexus (within 15%)", (t) => {
  const near = (what: string, got: number, want: number) => {
    t.diagnostic(`${what}: ${got} generated, ${want} in Nexus's`);
    assert.ok(Math.abs(got - want) <= want * 0.15, `${what}: ${got} against ${want}`);
  };
  const s = x1.size;
  near("queues", s.queues, NEXUS_SIZE.queues);
  near("steps", s.steps, NEXUS_SIZE.steps);
  near("sessions", s.sessions, NEXUS_SIZE.sessions);
  for (const [role, n] of Object.entries(NEXUS_SIZE.roles)) near(`${role} sessions`, s.roles[role] ?? 0, n);
  for (const k of ["events", "activity", "chat", "inbox", "applied"] as const) {
    near(`${k} lines`, s.lines[k], NEXUS_SIZE.lines[k]);
    near(`${k} bytes`, s.bytes[k], NEXUS_SIZE.bytes[k]);
  }
  near("queue.yaml bytes", s.bytes.queue, NEXUS_SIZE.bytes.queue);
  for (const k of ["run", "git", "push", "checks", "start", "plan", "runtime"] as const) near(`${k} files`, s.files[k], NEXUS_SIZE.files[k]);
});
