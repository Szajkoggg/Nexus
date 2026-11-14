// Check results on a step (queue TS): the reported time is derived onto the step's checks; the latest result of each
// check, with its time, reads on one line (nexus status).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, checksLine, formatSeconds, latestChecks, loadProjectState, newId, type Event } from "../src/index.ts";

test("a check.result's duration is derived onto the step's checks; one without it stays without", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-checks-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }], approvals: [], history: [] });
  st.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "external", cwd: root, launched_by: "external", created_at: new Date().toISOString() });
  let t = Date.parse("2026-11-14T10:00:00Z");
  const emit = (body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: new Date((t += 1000)).toISOString(), session: "w", queue: "Q", step: "Q1", ...body } as Event);
  emit({ type: "step.started" });
  emit({ type: "check.result", name: "test", ok: true, summary: "627 passed", duration: 189.4 });
  emit({ type: "check.result", name: "typecheck", ok: true });
  const step = loadProjectState(st).queues[0]!.steps[0]!;
  assert.deepEqual(step.checks.map(({ name, ok, summary, duration }) => ({ name, ok, summary, duration })), [
    { name: "test", ok: true, summary: "627 passed", duration: 189.4 },
    { name: "typecheck", ok: true, summary: undefined, duration: undefined },
  ]);
});

test("a negative duration is no valid event", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-checks-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  const e = { v: 1, id: newId(), at: new Date().toISOString(), session: "w", type: "check.result", queue: "Q", step: "Q1", name: "test", ok: true, duration: -1 };
  assert.throws(() => st.appendEvent(e as Event));
  assert.equal(st.readEvents("w").entries.length, 0);
});

test("the latest result of each check, in the order first reported, on one line with its time", () => {
  const at = "2026-11-14T10:00:00Z";
  const checks = [
    { name: "test", ok: false, duration: 61, at },
    { name: "typecheck", ok: true, duration: 9.96, at },
    { name: "test", ok: true, duration: 180, at },
    { name: "build", ok: true, at },
  ];
  assert.deepEqual(latestChecks(checks).map((c) => `${c.name} ${c.ok}`), ["test true", "typecheck true", "build true"]);
  assert.equal(checksLine(checks), "test ok (3 min), typecheck ok (10 s), build ok");
  assert.equal(checksLine([]), "");
});

test("seconds read as seconds, then minutes and seconds", () => {
  assert.deepEqual([0, 0.44, 3.25, 9.94, 10.4, 59.4, 59.6, 125, 3600].map(formatSeconds), ["0 s", "0.4 s", "3.3 s", "9.9 s", "10 s", "59 s", "1 min", "2 min 5 s", "60 min"]);
});
