// Step and run times as the dashboard shows them: derived from the events and the run file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectStore, formatClock, formatDuration, loadProjectState, newId, runTimes, stepTimes, type Event, type SessionFile,
} from "../src/index.ts";

const T0 = Date.parse("2026-11-12T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const MIN = 60_000;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-times-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.writeQueue({
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [],
    steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }, { id: "Q2", title: "Two", goal: "", acceptance: [] }],
    approvals: [], history: [],
  });
  const w: SessionFile = { protocol: 1, id: newId(), project: "p", role: "worker", runtime: "external", cwd: root, launched_by: "external", created_at: at(0) };
  st.writeSession(w);
  const emit = (min: number, body: Record<string, unknown>) =>
    st.appendEvent({ v: 1, id: newId(), at: at(min), session: w.id, queue: "Q", ...body } as Event);
  const step = (id: string) => loadProjectState(st).queues[0]!.steps.find((s) => s.id === id)!;
  return { st, w, emit, step };
}

test("a running step: started, no end, the elapsed time grows with the clock", () => {
  const { emit, step } = setup();
  emit(1, { type: "step.started", step: "Q1" });
  emit(5, { type: "step.progress", step: "Q1", text: "half way" });
  const s = step("Q1");
  assert.equal(s.started_at, at(1));
  const t = stepTimes(s.segments, T0 + 13 * MIN);
  assert.equal(t.running, true);
  assert.equal(t.ended, undefined);
  assert.equal(t.duration_ms, 12 * MIN);
  assert.equal(stepTimes(s.segments, T0 + 20 * MIN).duration_ms, 19 * MIN);
  assert.equal(t.segments, 1);
});

test("a done step and a failed step: from the start to the outcome", () => {
  const { emit, step } = setup();
  emit(1, { type: "step.started", step: "Q1" });
  emit(73, { type: "step.done", step: "Q1", summary: "ok" });
  emit(74, { type: "step.started", step: "Q2" });
  emit(80, { type: "step.failed", step: "Q2", reason: "no" });
  const done = stepTimes(step("Q1").segments, T0 + 999 * MIN);
  assert.deepEqual(done, { started: at(1), ended: at(73), running: false, duration_ms: 72 * MIN, working_ms: 72 * MIN, segments: 1 });
  assert.equal(formatDuration(done.duration_ms!), "1 h 12 min");
  const failed = stepTimes(step("Q2").segments, T0 + 999 * MIN);
  assert.equal(failed.ended, at(80));
  assert.equal(failed.duration_ms, 6 * MIN);
});

test("a step started, stopped and started again: duration from the first start, working time is the stretches", () => {
  const { emit, step } = setup();
  emit(0, { type: "step.started", step: "Q1" });
  emit(10, { type: "queue.stop", step: "Q1", condition: "a decision", reason: "ask the user" });
  emit(60, { type: "step.started", step: "Q1" });
  let s = step("Q1");
  assert.equal(s.started_at, at(0), "a resumed step keeps its first start");
  let t = stepTimes(s.segments, T0 + 65 * MIN);
  assert.equal(t.running, true);
  assert.equal(t.duration_ms, 65 * MIN);
  assert.equal(t.working_ms, 15 * MIN);
  emit(80, { type: "step.done", step: "Q1", summary: "ok" });
  s = step("Q1");
  t = stepTimes(s.segments, T0 + 999 * MIN);
  assert.deepEqual(s.segments, [{ start: at(0), end: at(10) }, { start: at(60), end: at(80) }]);
  assert.equal(t.duration_ms, 80 * MIN);
  assert.equal(t.working_ms, 30 * MIN);
  assert.equal(t.segments, 2);
});

test("started again without an outcome in between: the earlier stretch ends at the step's last event", () => {
  const { emit, step } = setup();
  emit(0, { type: "step.started", step: "Q1" });
  emit(7, { type: "step.progress", step: "Q1", text: "where I am" });
  emit(30, { type: "step.started", step: "Q1" });
  emit(40, { type: "step.done", step: "Q1", summary: "ok" });
  const t = stepTimes(step("Q1").segments, T0);
  assert.equal(t.working_ms, 17 * MIN);
  assert.equal(t.duration_ms, 40 * MIN);
});

test("a halted run: its span ends when it halted, and so does the stretch of the step it left", () => {
  const { st, w, emit, step } = setup();
  emit(1, { type: "step.started", step: "Q1" });
  emit(2, { type: "step.done", step: "Q1", summary: "ok" });
  emit(3, { type: "step.started", step: "Q2" });
  st.writeRun("Q", { protocol: 1, session: w.id, state: "halted", reason: "step Q2 ended twice without an outcome", step: "Q2", started_at: at(0), ended_at: at(9), updated_at: at(9) });
  const q = loadProjectState(st).queues[0]!;
  const r = runTimes(q.run!, T0 + 999 * MIN);
  assert.deepEqual(r, { started: at(0), ended: at(9), running: false, total_ms: 9 * MIN });
  const t = stepTimes(step("Q2").segments, T0 + 999 * MIN);
  assert.equal(t.running, false);
  assert.equal(t.ended, at(9));
  assert.equal(t.duration_ms, 6 * MIN);
});

test("a run's span: running grows, finished stops; an older run file without ended_at uses updated_at", () => {
  const running = runTimes({ state: "running", started_at: at(0), updated_at: at(5) }, T0 + 30 * MIN);
  assert.deepEqual(running, { started: at(0), ended: undefined, running: true, total_ms: 30 * MIN });
  assert.equal(runTimes({ state: "usage_wait", started_at: at(0), updated_at: at(5) }, T0 + 30 * MIN).running, true);
  assert.equal(runTimes({ state: "finished", started_at: at(0), ended_at: at(88), updated_at: at(90) }, T0 + 999 * MIN).total_ms, 88 * MIN);
  assert.equal(runTimes({ state: "paused", started_at: at(0), updated_at: at(20) }, T0 + 999 * MIN).ended, at(20));
});

test("durations and clock times read as the dashboard shows them", () => {
  assert.equal(formatDuration(0), "<1 min");
  assert.equal(formatDuration(59_999), "<1 min");
  assert.equal(formatDuration(12 * MIN + 59_000), "12 min");
  assert.equal(formatDuration(60 * MIN), "1 h");
  assert.equal(formatDuration(72 * MIN), "1 h 12 min");
  assert.equal(formatDuration(26 * 60 * MIN), "1 d 2 h");
  assert.equal(formatDuration(48 * 60 * MIN), "2 d");
  const now = new Date(2026, 10, 12, 18, 0);
  assert.equal(formatClock(new Date(2026, 10, 12, 9, 5).toISOString(), now), "09:05");
  assert.equal(formatClock(new Date(2026, 10, 11, 23, 59).toISOString(), now), "11 Nov 23:59");
  assert.equal(formatClock(new Date(2025, 0, 3, 7, 0).toISOString(), now), "3 Jan 2025 07:00");
});
