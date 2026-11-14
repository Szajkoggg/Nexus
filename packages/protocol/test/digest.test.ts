// The morning digest: what happened in a project after a time, newest first, and what is at work now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newestFirst, projectDigest, projectRunning, type DigestEvent } from "../src/digest.ts";
import type { Activity, Event, ProjectState, Refusal } from "../src/index.ts";

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

test("across projects the lines merge newest first; what is at work now, with since when", () => {
  const a = { at: T("08:00"), project: "a", project_name: "A", kind: "done", text: "" } as DigestEvent;
  const b = { at: T("09:00"), project: "b", project_name: "B", kind: "stopped", text: "" } as DigestEvent;
  assert.deepEqual(newestFirst([a, b]).map((e) => e.project), ["b", "a"]);
  const s = state([
    queue("SF", "running", { run: { state: "running", step: "SF3", started_at: T("07:00") }, steps: [{ id: "SF3", status: "running", segments: [{ start: T("07:00") }, { start: T("11:20") }] }] }),
    queue("P", "running", { run: { state: "paused", step: "P1" } }),
    queue("U", "waiting", { run: { state: "usage_wait", started_at: T("06:00") }, current_step: "U2", steps: [] }),
    queue("AW", "running", { run: { state: "approval_wait", step: "AW1", started_at: T("06:00") }, steps: [] }), // waits for the user
  ]);
  assert.deepEqual(projectRunning(s), [
    { project: "p", project_name: "Proj", queue: "SF", step: "SF3", since: T("11:20") },
    { project: "p", project_name: "Proj", queue: "U", step: "U2", since: T("06:00") },
  ]);
});
