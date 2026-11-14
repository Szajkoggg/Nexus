// The morning digest: what happened in a project after a time, newest first, and what is at work now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newestFirst, projectDigest, projectRunning, usageSince, type DigestEvent } from "../src/digest.ts";
import type { Activity, Event, ProjectState, Refusal, TurnRecord } from "../src/index.ts";

const T = (hhmm: string, day = 13) => `2026-11-${day}T${hhmm}:00.000Z`;
const ev = (at: string, body: Record<string, unknown>) => ({ v: 1, id: `e${at}`, at, session: "S1", ...body }) as unknown as Event;
const queue = (id: string, status: string, over: Record<string, unknown> = {}) =>
  ({ id, title: `${id} title`, status, steps: [], questions: [], ...over });
const state = (queues: unknown[]): ProjectState => ({ project: { id: "p", name: "Proj" }, queues, sessions: [], questions: [], attention: [], warnings: [], generated_at: T("12:00") }) as unknown as ProjectState;
const refusal = (at: string, input: string, step = "B2"): Refusal => ({ at, session: "S1", runtime: "claude", by: "permissions", tool: "Write", input, queue: "B", step });
const retry = (at: string, text: string): Activity => ({ at, kind: "retry", text, queue: "B", step: "B2" });
const brief = (es: DigestEvent[]) => es.map((e) => `${e.at.slice(11, 16)} ${e.kind} ${e.queue ?? ""}${e.step ? "/" + e.step : ""}${e.count ? ` x${e.count}` : ""}${e.report ? " report" : ""}`);

test("only what happened after the time, newest first: step outcomes, stops, finished queues with their report", () => {
  const s = state([
    queue("A", "done", { steps: [{ id: "A1", status: "done", finished_at: T("08:20") }], report: { path: ".nexus/queues/A/report.md", summary: "", at: T("08:21") } }),
    queue("C", "cancelled", { steps: [], run: { ended_at: T("07:00") } }),
    queue("O", "done", { steps: [{ id: "O1", status: "done", finished_at: T("23:00", 12) }] }),
    queue("W", "stopped"),
  ]);
  const events = [
    ev(T("23:10", 12), { type: "step.done", queue: "O", step: "O1", summary: "old" }),
    ev(T("08:20"), { type: "step.done", queue: "A", step: "A1", summary: "a rule; 587 passed" }),
    ev(T("09:00"), { type: "step.failed", queue: "B", step: "B1", reason: "tests" }),
    ev(T("10:43"), { type: "queue.stop", queue: "W", step: "W4c", condition: "c", reason: "look faults remain" }),
    ev(T("10:50"), { type: "step.started", queue: "B", step: "B2" }),
  ];
  const d = projectDigest({ state: s, events, refusals: [], activity: [] }, T("00:00"));
  assert.deepEqual(brief(d), ["10:43 stopped W/W4c", "09:00 failed B/B1", "08:20 done A/A1", "08:20 queue_done A report", "07:00 queue_cancelled C"]);
  assert.equal(d[0]!.text, "look faults remain");
  assert.equal(d[0]!.project_name, "Proj");
  assert.deepEqual(projectDigest({ state: s, events, refusals: [], activity: [] }, T("10:43")), [], "exactly at the time is not after it");
});

test("refused actions and retries: one line per step with how many, at the latest", () => {
  const d = projectDigest({
    state: state([]), events: [],
    refusals: [refusal(T("00:54"), ".nexus/queues/N7/report.md"), refusal(T("00:50"), "x.md"), refusal(T("00:10", 12), "old"), refusal(T("01:00"), "y", "B3")],
    activity: [retry(T("00:21"), "overloaded"), retry(T("00:24"), "overloaded; went on"), { at: T("00:30"), kind: "error", text: "no", queue: "B", step: "B2" }],
  }, T("00:00"));
  assert.deepEqual(brief(d), ["01:00 refused B/B3 x1", "00:54 refused B/B2 x2", "00:24 retried B/B2 x2"]);
  assert.equal(d[1]!.text, "Write .nexus/queues/N7/report.md");
  assert.equal(d[2]!.text, "overloaded; went on");
});

test("across projects the lines merge newest first; what runs now, with since when", () => {
  const a = { at: T("08:00"), project: "a", project_name: "A", kind: "done", text: "" } as DigestEvent;
  const b = { at: T("09:00"), project: "b", project_name: "B", kind: "stopped", text: "" } as DigestEvent;
  assert.deepEqual(newestFirst([a, b]).map((e) => e.project), ["b", "a"]);
  const s = state([
    queue("SF", "running", { run: { state: "running", step: "SF3", started_at: T("07:00") }, steps: [{ id: "SF3", status: "running", segments: [{ start: T("07:00") }, { start: T("11:20") }] }] }),
    queue("P", "running", { run: { state: "paused", step: "P1" } }),
    queue("U", "waiting", { run: { state: "usage_wait", started_at: T("06:00") }, current_step: "U2", steps: [] }),
    queue("AW", "running", { run: { state: "approval_wait", step: "AW1", started_at: T("06:00") }, steps: [] }), // waits for the user
    queue("PS", "running", { run: { state: "pausing", step: "PS1", started_at: T("09:00") }, steps: [{ id: "PS1", status: "running", segments: [{ start: T("09:30") }] }] }),
    queue("RT", "running", { run: { state: "retry_wait", step: "RT1", started_at: T("09:00") }, steps: [] }),
    queue("RV", "running", { run: { state: "running", step: "RV1", started_at: T("09:00") }, steps: [{ id: "RV1", status: "review", review_with: "orchestrator", segments: [] }] }),
    queue("QU", "waiting", { run: { state: "running", step: "QU1", started_at: T("09:00") }, steps: [{ id: "QU1", status: "waiting", segments: [] }], questions: [{ state: "open", can_continue: false }] }),
    queue("QC", "running", { run: { state: "running", step: "QC1", started_at: T("09:00") }, steps: [{ id: "QC1", status: "running", segments: [] }], questions: [{ state: "open", can_continue: true }] }),
  ]);
  // Only runs that go and that nothing holds (runsNow): as the rail's "Running in" (queue FU). The usage window, a
  // retry, a review or a blocking question is not running.
  assert.deepEqual(projectRunning(s), [
    { project: "p", project_name: "Proj", queue: "SF", step: "SF3", since: T("11:20") },
    { project: "p", project_name: "Proj", queue: "PS", step: "PS1", since: T("09:30") },
    { project: "p", project_name: "Proj", queue: "QC", step: "QC1", since: T("09:00") },
  ]);
});

// ---------------------------------------------------------------- the usage line (queue FU)

const turn = (at: string, over: Partial<TurnRecord> = {}): TurnRecord =>
  ({ v: 1, at, started_at: at, project: "p", session: "S1", role: "worker", runtime: "claude", outcome: "ok", ...over });
const win = (u5: number | undefined, u7: number | undefined) =>
  ({ ...(u5 !== undefined ? { five_hour: { utilization: u5 } } : {}), ...(u7 !== undefined ? { seven_day: { utilization: u7 } } : {}) });

test("usage since a time: the 5-hour peak, the 7-day window's latest value, no waits", () => {
  const turns = [
    turn(T("07:00"), { windows_end: win(0.95, 0.3) }), // before the time: not counted
    turn(T("08:10"), { windows_end: win(0.4, 0.35) }),
    turn(T("09:30"), { windows_end: win(0.82, 0.41) }),
    turn(T("10:00"), { windows_end: win(0.2, 0.44), session: "S2" }),
    turn(T("10:30"), { runtime: "codex", windows_end: { codex_7d: { utilization: 0.12 } } }),
  ];
  assert.deepEqual(usageSince(turns, [], T("08:00"), new Date(T("11:00"))), { turns: 4, peak_5h: 0.82, now_7d: 0.44, waits: 0, wait_ms: 0 });
  // Codex's weekly window counts as a 7-day one; the higher of the two runtimes' is shown.
  assert.equal(usageSince([turn(T("10:30"), { runtime: "codex", windows_end: { codex_7d: { utilization: 0.6 } } })], [], T("08:00")).now_7d, 0.6);
  // No turn in the period: nothing about the windows.
  assert.deepEqual(usageSince(turns, [], T("10:45"), new Date(T("11:00"))), { turns: 0, waits: 0, wait_ms: 0 });
});

test("usage waits: a turn that hit a limit until its session's next turn, or now while its run waits; a threshold wait from its start", () => {
  const now = new Date(T("12:00"));
  const turns = [
    turn(T("08:30"), { outcome: "usage", failure: "rate_limit" }),
    turn(T("09:45", 13), { started_at: T("09:40") }), // S1 goes on after 70 min
    turn(T("11:00"), { session: "S2", outcome: "usage" }), // S2 still waits: until now, 60 min
  ];
  const runs = [
    { session: "S2", state: "usage_wait", updated_at: T("11:00") }, // explained by S2's turn: not counted twice
    { session: "S3", state: "usage_wait", updated_at: T("11:30") }, // a threshold wait: 30 min so far
    { session: "S4", state: "usage_wait", updated_at: T("06:00") }, // began before the time: counted from it, 4 h
    { session: "S5", state: "running", updated_at: T("11:50") },
  ];
  const u = usageSince(turns, runs, T("08:00"), now);
  assert.equal(u.waits, 4);
  assert.equal(u.wait_ms, (70 + 60 + 30 + 240) * 60_000);
});
