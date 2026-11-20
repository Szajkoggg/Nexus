// The work gate (queue SM, the decision of 2026-11-18): the reads' work counted, not timed, on a synthetic .nexus at
// 1x and 4x Nexus's own size (synthetic.ts). Until the model (docs/design/model.md) it records today's numbers and
// holds what they are now (a change or an appended line rebuilds everything; the start rebuilds once per queue); its
// rules are written as skipped tests that SM3 turns on: one appended line reads only that line, a request makes no whole
// read, the counts are the same at 1x and 4x.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ProjectStore, loadProjectState, newId, releaseOrphanedSteps, resetWork, workCounts, type Event, type WorkCounts } from "../src/index.ts";
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

interface Measured {
  size: SyntheticSize;
  /** One whole derivation: what the server's first request, or any request after a change, costs today. */
  rebuild: WorkCounts;
  /** The engine's recovery at the start: releaseOrphanedSteps for every queue, then one more state. */
  start: WorkCounts;
  /** One activity line appended (a streaming agent's), then the state the server reads for the change. */
  activityLine: WorkCounts & { line: number };
  /** One event appended (an agent's nexus), then the state for the change. */
  eventLine: WorkCounts & { line: number };
  /** The conversation list's reads (apps/server/src/conversations.ts, Conversations.list): every session file, every conversation's chat. */
  conversations: WorkCounts;
}

function measureAt(scale: number): Measured {
  const root = join(temp, `x${scale}`);
  const size = generateNexus(root, { scale });
  const st = ProjectStore.forRoot(root);
  loadProjectState(st); // warm: the first read pays for the module's and the disk's caches
  const rebuild = counted(() => loadProjectState(st));
  const queues = st.queueIds();
  // Today's recovery (engine.ts, recoverAfterRestart): one releaseOrphanedSteps per queue, each a whole state, then a
  // state of its own. Measured on one queue and counted for all: the same work each, a whole run takes minutes at 4x.
  const one = counted(() => releaseOrphanedSteps(st, queues[0]!));
  const times = (w: WorkCounts, n: number): WorkCounts => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v * n])) as unknown as WorkCounts;
  const add = (a: WorkCounts, b: WorkCounts): WorkCounts => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v + b[k as keyof WorkCounts]])) as unknown as WorkCounts;
  const start = add(times(one, queues.length), rebuild);
  const session = st.sessionIds().find((s) => s.startsWith("w-"))!;
  const activityFile = join(st.sessionDir(session), "activity.jsonl");
  const before1 = statSync(activityFile).size;
  const activityLine = { ...counted(() => { st.appendActivity(session, { at: new Date().toISOString(), kind: "tool", text: "Read packages/protocol/src/state.ts" }); loadProjectState(st); }), line: statSync(activityFile).size - before1 };
  const eventsFile = join(st.sessionDir(session), "events.jsonl");
  const before2 = statSync(eventsFile).size;
  const eventLine = { ...counted(() => { st.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session, type: "log", level: "info", text: "a line" } as Event); loadProjectState(st); }), line: statSync(eventsFile).size - before2 };
  const conversations = counted(() => {
    for (const id of st.sessionIds()) {
      const s = st.readSession(id);
      if (s.role === "conversation") st.readChat(id);
    }
  });
  return { size, rebuild, start, activityLine, eventLine, conversations };
}

let x1: Measured, x4: Measured;
before(() => { x1 = measureAt(1); x4 = measureAt(4); });

const row = (what: string, a: WorkCounts, b: WorkCounts) =>
  `${what.padEnd(34)} 1x: ${a.files} files, ${(a.bytes / 1e6).toFixed(2)} MB, ${a.probes} probes, ${a.rebuilds} rebuilds | 4x: ${b.files} files, ${(b.bytes / 1e6).toFixed(2)} MB, ${b.probes} probes, ${b.rebuilds} rebuilds`;

test("the work of today's reads at 1x and 4x, recorded", (t) => {
  t.diagnostic(`synthetic 1x: ${x1.size.queues} queues, ${x1.size.sessions} sessions, ${x1.size.lines.events} events, ${x1.size.lines.activity} activity lines; 4x: ${x4.size.queues} queues, ${x4.size.sessions} sessions`);
  t.diagnostic(row("a whole rebuild (a request after a change)", x1.rebuild, x4.rebuild));
  t.diagnostic(row("the start (recovery, every queue)", x1.start, x4.start));
  t.diagnostic(row(`one activity line (${x1.activityLine.line} bytes) and its change`, x1.activityLine, x4.activityLine));
  t.diagnostic(row(`one event line (${x1.eventLine.line} bytes) and its change`, x1.eventLine, x4.eventLine));
  t.diagnostic(row("the conversation list", x1.conversations, x4.conversations));
  // Today: every change reads the whole project again, and the start once per queue; all of it grows with the history.
  assert.equal(x1.rebuild.rebuilds, 1);
  assert.equal(x1.start.rebuilds, x1.size.queues + 1, "the start: a state per queue, and one more");
  assert.equal(x4.start.rebuilds, x4.size.queues + 1);
  for (const m of [x1, x4]) {
    assert.equal(m.activityLine.rebuilds, 1, "an activity line: a whole rebuild");
    assert.ok(m.activityLine.bytes >= m.rebuild.bytes, "an activity line: the whole project read again");
    assert.ok(m.eventLine.bytes >= m.rebuild.bytes, "an event line: the whole project read again");
  }
  const ratio = x4.rebuild.bytes / x1.rebuild.bytes;
  assert.ok(ratio > 3 && ratio < 5, `a rebuild reads about 4 times as much at 4x (${ratio.toFixed(2)})`);
});

// The gate's rules, on from SM3 (the model): each fails today (run them without the skip to see by how much).
test("rule: one appended activity line reads that line (and the 64 bytes before it), and rebuilds nothing", { skip: "on with SM3 (the model)" }, () => {
  for (const m of [x1, x4]) {
    assert.equal(m.activityLine.rebuilds, 0);
    assert.ok(m.activityLine.bytes <= m.activityLine.line + 64, `${m.activityLine.bytes} bytes read for a line of ${m.activityLine.line}`);
  }
});
test("rule: one appended event reads that line (and the 64 bytes before it)", { skip: "on with SM3 (the model)" }, () => {
  for (const m of [x1, x4]) assert.ok(m.eventLine.bytes <= m.eventLine.line + 64, `${m.eventLine.bytes} bytes read for a line of ${m.eventLine.line}`);
});
test("rule: the start reads the project once, the same at 1x and 4x in rebuilds", { skip: "on with SM3 (the model)" }, () => {
  assert.equal(x1.start.rebuilds, 1);
  assert.equal(x4.start.rebuilds, 1);
});
test("rule: a request makes no whole read; the counts are the same at 1x and 4x", { skip: "on with SM3 (the model)" }, () => {
  assert.deepEqual(x4.conversations, x1.conversations);
  assert.deepEqual({ ...x4.activityLine, line: 0 }, { ...x1.activityLine, line: 0 });
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
