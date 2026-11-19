// The stamps Nexus writes and the order it reads logs in, across clock steps (docs/DESIGN.md, "Clock steps"; queue FL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOCK_AHEAD_MS, inFileOrder, now, observe } from "../src/clock.ts";
import { ProjectStore, approveQueue, loadProjectState, newId, type Event, type QueueFile, type SessionFile } from "../src/index.ts";

test("a stamp is never earlier than a time read or stamped before, nor taken up from far ahead", () => {
  const ahead = new Date(Date.now() + 60_000).toISOString();
  observe(ahead);
  const a = now();
  assert.ok(a > ahead, `${a} comes after the time read, ${ahead}`);
  assert.ok(now() >= a, "never back");
  observe(new Date(Date.now() + CLOCK_AHEAD_MS + 3_600_000).toISOString());
  assert.ok(Date.parse(now()) < Date.now() + CLOCK_AHEAD_MS, "a time far ahead is not taken up");
  observe(undefined); observe("not a time");
});

test("logs merge by time and id, each keeping the order it was written in", () => {
  const log = (name: string, ...ats: string[]) => ats.map((at, i) => ({ id: `${name}${i}`, at }));
  const t = (s: number) => `2026-11-18T10:00:${String(s).padStart(2, "0")}.000Z`;
  const ids = (xs: { item: { id: string } }[]) => xs.map((x) => x.item.id);
  // Without a clock step: the plain order by (at, id).
  const a = log("a", t(1), t(3), t(5)), b = log("b", t(2), t(3), t(4));
  assert.deepEqual(ids(inFileOrder([a, b], (x) => x.at, (x) => x.id)), ["a0", "b0", "a1", "b1", "b2", "a2"]);
  // A log written across a backward step keeps its order; its later lines take the time they follow.
  const stepped = log("s", t(10), t(2), t(11));
  const merged = inFileOrder([stepped, log("o", t(5))], (x) => x.at, (x) => x.id);
  assert.deepEqual(ids(merged), ["o0", "s0", "s1", "s2"]);
  assert.equal(merged[2]!.at, t(10), "the effective time of the stepped line");
  assert.deepEqual(inFileOrder([[], []], (x: { at: string; id: string }) => x.at, (x) => x.id), []);
});

test("old logs read right: a worker's log across a backward step, and the user's interruption between", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-clock-"));
  process.env.NEXUS_HOME = join(root, "home");
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  const q: QueueFile = { protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], withdrawals: [], changes: [], approvals: [], history: [],
    steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }, { id: "Q2", title: "Two", goal: "", acceptance: [] }] };
  st.writeQueue(q);
  approveQueue(st, "Q");
  const session = (role: SessionFile["role"]) => {
    const s: SessionFile = { protocol: 1, id: newId(), project: "p", role, runtime: "external", cwd: root, launched_by: "external", created_at: "2026-11-18T09:00:00.000Z" };
    st.writeSession(s);
    return s.id;
  };
  const w = session("worker"), u = session("user");
  const emit = (s: string, at: string, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at, session: s, ...body } as Event);
  // Files as an older Nexus wrote them: Q1 started, then the clock stepped back 60 s before its outcome.
  emit(w, "2026-11-18T10:01:00.000Z", { type: "step.started", queue: "Q", step: "Q1" });
  emit(w, "2026-11-18T10:00:10.000Z", { type: "step.done", queue: "Q", step: "Q1", summary: "built" });
  // Q2 started, the user interrupted it, and it started again.
  emit(w, "2026-11-18T10:00:20.000Z", { type: "step.started", queue: "Q", step: "Q2" });
  emit(u, "2026-11-18T10:01:30.000Z", { type: "step.interrupted", queue: "Q", step: "Q2", text: "Stopped at once" });
  emit(w, "2026-11-18T10:01:40.000Z", { type: "step.started", queue: "Q", step: "Q2" });
  const steps = loadProjectState(st).queues[0]!.steps;
  assert.equal(steps[0]!.status, "review", "the outcome after its start, as written");
  assert.equal(steps[0]!.segments.length, 1);
  assert.equal(steps[0]!.segments[0]!.end, "2026-11-18T10:00:10.000Z", "the stretch ended (times are kept as written)");
  assert.equal(steps[1]!.status, "running");
  assert.deepEqual(steps[1]!.segments.map((s) => !!s.end), [true, false], "the interrupted stretch closed, the new one open");
});
