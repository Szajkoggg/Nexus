// The statistics (stats.ts) on a known history of two projects: the share accepted in the first round, the average
// rounds, stops and failures, the median working time, grouping by model, effort and every tag facet (a project's own
// prefixed activities and areas only within it), the planned against the reported activities, "few data" under 5
// steps, the untagged group, fallback turns, the estimated use, --since, and the metrics of a project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectStore, approveQueue, loadProjectState, projectMetrics, sinceTime, statsReport, statsText, stepStats, type Event, type StepDef, type TurnRecord,
} from "../src/index.ts";

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 15, h, m)).toISOString();
let seq = 0;

function project(id: string, steps: StepDef[]) {
  const root = mkdtempSync(join(tmpdir(), `nexus-stats-${id}-`));
  const store = ProjectStore.init(root, { id, name: id, root });
  store.writeTags({ ...store.readTags(), prefix: id, areas: [{ name: "engine", at: at(0) }], activities: [{ name: `${id}:terrain`, at: at(0) }] });
  store.writeSession({ protocol: 1, id: "w", project: id, role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0), queue: "A" });
  store.writeSession({ protocol: 1, id: "o", project: id, role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0) });
  store.writeQueue({ protocol: 1, id: "A", title: "A", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps });
  approveQueue(store, "A");
  const emit = (session: string, h: number, m: number, body: Record<string, unknown>) =>
    store.appendEvent({ v: 1, id: `e${String(++seq).padStart(4, "0")}`, at: at(h, m), session, queue: "A", ...body } as Event);
  /** A round of work on a step: started, done (with the activities reported), then the orchestrator's decision. */
  const round = (step: string, h: number, then: "accept" | "send-back" | "none", activities?: string[]) => {
    emit("w", h, 0, { type: "step.started", step });
    emit("w", h, 10, { type: "step.done", step, summary: "s", ...(activities ? { activities } : {}) });
    if (then === "accept") emit("o", h, 20, { type: "review.accepted", step });
    if (then === "send-back") emit("o", h, 20, { type: "review.sent_back", step, text: "fix" });
  };
  return { store, emit, round };
}

const step = (id: string, tags: Partial<StepDef> = {}): StepDef => ({ id, title: id, goal: "g", acceptance: [], ...tags });

function turn(projectId: string, s: string, h: number, minutes: number, more: Partial<TurnRecord> = {}): TurnRecord {
  return { v: 1, at: at(h, minutes), started_at: at(h, 0), duration_ms: minutes * 60_000, project: projectId, session: "w", role: "worker", runtime: "claude", queue: "A", step: s, model: "opus", effort: "high", outcome: "ok", tokens: { input: 1000, output: 0, cache_read: 0, cache_creation: 0 }, ...more };
}

function history() {
  const p = project("p", [
    step("A1", { kind: "code", size: "S", activities: ["feature"], area: "engine", origin: "user" }),
    step("A2", { kind: "code", size: "M", activities: ["feature", "test"], area: "engine", origin: "user" }),
    step("A3", { kind: "debugging", size: "L", activities: ["bugfix"], origin: "ci" }),
    step("A4", { kind: "code", size: "M", activities: ["p:terrain"], area: "engine", origin: "orchestrator" }),
    step("A5"), // before tags: untagged
    step("A6", { kind: "code", size: "S", origin: "user" }), // never started
    step("A7", { kind: "code", size: "S", origin: "user" }), // done, waiting for its review
  ]);
  p.round("A1", 1, "accept", ["feature"]);
  p.round("A2", 2, "send-back", ["feature"]);
  p.round("A2", 3, "accept", ["feature"]);
  p.emit("w", 4, 0, { type: "step.started", step: "A3" });
  p.emit("w", 4, 30, { type: "step.failed", step: "A3", reason: "cannot" });
  p.emit("w", 5, 0, { type: "step.started", step: "A4" });
  p.emit("w", 5, 5, { type: "queue.stop", step: "A4", condition: "c", reason: "r" });
  p.round("A4", 6, "accept", ["p:terrain"]);
  p.round("A5", 7, "accept", ["bugfix", "p:terrain"]);
  p.round("A7", 8, "none");
  const q = project("q", [step("A1", { kind: "code", size: "S", activities: ["feature", "q:terrain"], area: "engine", origin: "user" })]);
  q.round("A1", 9, "accept");
  const turns: TurnRecord[] = [
    turn("p", "A1", 1, 10, { windows_start: { five_hour: { utilization: 0.1, resets_at: at(6) } }, windows_end: { five_hour: { utilization: 0.12, resets_at: at(6) } } }),
    turn("p", "A2", 2, 20), turn("p", "A2", 3, 10),
    turn("p", "A3", 4, 30, { model: "sonnet", effort: "medium" }),
    turn("p", "A4", 5, 5), turn("p", "A4", 6, 40, { fallback: { from: "codex", reason: "full" } }),
    turn("p", "A5", 7, 30, { effort: undefined }),
    turn("p", "A7", 8, 10),
    turn("q", "A1", 9, 50),
    // Not a worker's: no step of its own, but it shares the window.
    { v: 1, at: at(1, 10), started_at: at(1, 0), duration_ms: 600_000, project: "p", session: "o", role: "orchestrator", runtime: "claude", outcome: "ok", tokens: { input: 1000, output: 0, cache_read: 0, cache_creation: 0 } },
  ];
  const states = [loadProjectState(p.store), loadProjectState(q.store)];
  return { p, q, states, steps: stepStats(states, turns) };
}

test("each step with an outcome, with its rounds, decision, stops, failures, time, model and use", () => {
  const { steps } = history();
  const pick = (proj: string, id: string) => steps.find((s) => s.project === proj && s.step === id)!;
  assert.deepEqual(steps.map((s) => `${s.project}/${s.step}`), ["p/A1", "p/A2", "p/A3", "p/A4", "p/A5", "p/A7", "q/A1"], "A6 never started: left out");
  const a2 = pick("p", "A2");
  assert.deepEqual([a2.rounds, a2.accepted, a2.first, a2.decided, a2.work_ms], [2, true, false, true, 30 * 60_000]);
  const a3 = pick("p", "A3");
  assert.deepEqual([a3.status, a3.failures, a3.decided, a3.first, a3.model, a3.effort], ["failed", 1, true, false, "sonnet", "medium"]);
  const a4 = pick("p", "A4");
  assert.deepEqual([a4.stops, a4.first, a4.fallback], [1, true, true]);
  assert.deepEqual([pick("p", "A7").status, pick("p", "A7").decided], ["review", false]);
  // A1 shared the window's 2 % with the orchestrator's turn running alongside, half each.
  assert.equal(Math.round(pick("p", "A1").usage["claude:five_hour"]! * 1e6) / 1e6, 0.01);
  assert.equal(pick("p", "A2").usage_missing, 0, "no window named: nothing missing");
});

test("by model and effort: first-round rate, average rounds, median, few data", () => {
  const { steps } = history();
  const r = statsReport(steps, { by: "model", project: "p" });
  const opus = r.groups.find((g) => g.key === "opus")!;
  assert.deepEqual([opus.steps, opus.few, opus.decided, opus.first_accepted, opus.avg_rounds, opus.stops, opus.failures, opus.fallback], [5, false, 4, 3, 1.2, 1, 0, 1]);
  assert.equal(opus.first_rate, 0.75);
  // Accepted steps' work: A1 10, A2 30, A4 45, A5 30 minutes.
  assert.deepEqual([opus.median_ms, opus.p25_ms, opus.p75_ms].map((x) => x! / 60_000), [30, 25, 33.75]);
  const sonnet = r.groups.find((g) => g.key === "sonnet")!;
  assert.deepEqual([sonnet.steps, sonnet.few, sonnet.first_rate, sonnet.failures, sonnet.median_ms], [1, true, 0, 1, undefined]);
  const effort = statsReport(steps, { by: "effort", project: "p" });
  assert.deepEqual(effort.groups.map((g) => [g.key, g.steps]), [["high", 4], ["default", 1], ["medium", 1]]);
});

test("by each tag facet, the untagged in a group of their own; size gives the measured time per planned size", () => {
  const { steps } = history();
  const by = (d: "kind" | "size" | "origin" | "area") => statsReport(steps, { by: d, project: "p" }).groups.map((g) => [g.key, g.steps]);
  assert.deepEqual(by("kind"), [["code", 4], ["debugging", 1], ["untagged", 1]]);
  assert.deepEqual(by("origin"), [["user", 3], ["ci", 1], ["orchestrator", 1], ["untagged", 1]]);
  assert.deepEqual(by("area"), [["engine", 3], ["untagged", 3]]);
  const size = statsReport(steps, { by: "size", project: "p" });
  assert.deepEqual(size.groups.map((g) => [g.key, g.steps, g.median_ms && g.median_ms / 60_000]), [["M", 2, 37.5], ["S", 2, 10], ["L", 1, undefined], ["untagged", 1, 30]]);
});

test("activities: planned against reported; a project's own names count within it, Nexus's across projects", () => {
  const { steps } = history();
  const own = statsReport(steps, { by: "activity", project: "p" });
  const g = (r: typeof own, k: string) => r.groups.find((x) => x.key === k);
  assert.deepEqual(g(own, "feature")!.activities, { planned: 2, observed: 2, unplanned: 0, skipped: 0 });
  assert.deepEqual(g(own, "test")!.activities, { planned: 1, observed: 0, unplanned: 0, skipped: 1 }, "A2 planned a test, reported none");
  assert.deepEqual(g(own, "bugfix")!.activities, { planned: 1, observed: 1, unplanned: 1, skipped: 0 }, "A3 planned it (no report); A5 did it unplanned");
  assert.deepEqual(g(own, "p:terrain")!.activities, { planned: 1, observed: 2, unplanned: 1, skipped: 0 });
  const all = statsReport(steps, { by: "activity" });
  assert.equal(g(all, "feature")!.steps, 3, "Nexus's activity across both projects");
  assert.ok(g(all, "p/p:terrain") && g(all, "q/q:terrain"), "each project's own activity apart");
  assert.equal(g(all, "p:terrain"), undefined);
  const areas = statsReport(steps, { by: "area" });
  assert.deepEqual(areas.groups.filter((x) => x.key.endsWith("engine")).map((x) => [x.key, x.steps]), [["p/engine", 3], ["q/engine", 1]], "two projects' engine areas apart");
});

test("--since keeps the steps whose last outcome is at or after it; the text marks few data and says use is estimated", () => {
  const { steps } = history();
  const r = statsReport(steps, { by: "model", since: at(6) });
  assert.equal(r.steps, 4, "A4 (6:10), A5, A7, q/A1");
  assert.equal(sinceTime("nonsense"), undefined);
  assert.equal(sinceTime("2026-11-15T06:00:00Z"), at(6));
  const text = statsText(statsReport(steps, { by: "model", project: "p" }));
  assert.match(text, /^Steps by model \(project p; 6 steps with an outcome\)$/m);
  assert.match(text, /^- opus: 5 steps; accepted in the first round 3 of 4 \(75 %\); 1\.2 rounds on average; 1 stop, 0 failures; median work 30 min \(25 min to 33 min 45 s\); estimated use claude:five_hour 1 %; 1 on a fallback$/m);
  assert.match(text, /^- sonnet: 1 step \(few data\); accepted in the first round 0 of 1 \(0 %\); 0 stops, 1 failure$/m);
  assert.match(text, /Use is estimated/);
});

test("a project's metrics: its own and the checks' times seen, with each value's step", () => {
  const { p } = history();
  p.store.writeMetrics({ protocol: 1, metrics: [{ name: "bundle-kb", unit: "KB", show: "bar", warn_above: 500 }] });
  p.emit("w", 10, 0, { type: "metric.recorded", step: "A1", name: "bundle-kb", value: 600, unit: "KB", commit: "abc" });
  p.emit("w", 10, 1, { type: "check.result", step: "A1", name: "npm test", ok: true, duration: 12 });
  const m = projectMetrics(loadProjectState(p.store));
  assert.deepEqual(m.metrics.map((d) => [d.name, d.unit]), [["bundle-kb", "KB"], ["check:npm test", "s"]]);
  assert.deepEqual(m.values.map((v) => [v.name, v.value, v.queue, v.step, v.commit, v.warn?.side]), [["bundle-kb", 600, "A", "A1", "abc", "above"], ["check:npm test", 12, "A", "A1", undefined, undefined]]);
});
