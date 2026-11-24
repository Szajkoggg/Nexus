// The flaky checks report (`nexus stats --flaky`, queue NKR3): checks.yaml's flaky records grouped by the test that
// failed on the first run, the check's name when its failing tests are unknown, filtered by a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChecksFile, flakyReport, flakyText, type FlakySource } from "@nexus/protocol";

const run = (at: string, failed?: string[], ok = false) => ({ started_at: at, log: "x.log", exit_code: ok ? 0 : 1, ...(failed ? { failed_tests: failed } : {}) });
const set = (at: string, checks: unknown[]) => ({ done: "d", round: 1, fix: 0, requested_at: at, ended_at: at, state: "passed", checks });
const flaky = (name: string, at: string, failed?: string[]) => ({ name, command: name, runs: [run(at, failed), run(at, undefined, true)], ok: true, flaky: true });

function source(project: string, queue: string, steps: Record<string, unknown[]>): FlakySource {
  return { project, queue, checks: ChecksFile.parse({ protocol: 1, steps: Object.fromEntries(Object.entries(steps).map(([k, sets]) => [k, { by: "nexus", sets }])) }) };
}

test("groups flaky records by failing test, falls back to the check's name, and skips passes and failures", () => {
  const a = source("p", "A", {
    A1: [set("2026-11-10T10:00:00.000Z", [flaky("npm test", "2026-11-10T10:00:00.000Z", ["engine › halts", "store › writes"])])],
    A2: [set("2026-11-12T10:00:00.000Z", [
      flaky("npm test", "2026-11-12T10:00:00.000Z", ["engine › halts"]),
      flaky("npm run lint", "2026-11-12T10:05:00.000Z"),
      { name: "npm run typecheck", command: "npm run typecheck", runs: [run("2026-11-12T10:00:00.000Z", ["x"])], ok: false },
      { name: "npm run build", command: "npm run build", runs: [run("2026-11-12T10:00:00.000Z", undefined, true)], ok: true },
    ])],
  });
  const b = source("p", "B", { B3: [set("2026-11-14T08:00:00.000Z", [flaky("npm test", "2026-11-14T08:00:00.000Z", ["engine › halts"])])] });
  const groups = flakyReport([a, b]);
  assert.deepEqual(groups, [
    { test: "engine › halts", byCheck: false, count: 3, checks: ["npm test"], steps: ["A/A1", "A/A2", "B/B3"], last: "2026-11-14T08:00:00.000Z" },
    { test: "npm run lint", byCheck: true, count: 1, checks: ["npm run lint"], steps: ["A/A2"], last: "2026-11-12T10:05:00.000Z" },
    { test: "store › writes", byCheck: false, count: 1, checks: ["npm test"], steps: ["A/A1"], last: "2026-11-10T10:00:00.000Z" },
  ]);
  const since = flakyReport([a, b], "2026-11-11T00:00:00.000Z");
  assert.deepEqual(since.map((g) => [g.test, g.count, g.steps]), [["engine › halts", 2, ["A/A2", "B/B3"]], ["npm run lint", 1, ["A/A2"]]]);
});

test("names the project in a step's place when the sources span several projects", () => {
  const groups = flakyReport([
    source("p", "A", { A1: [set("2026-11-10T10:00:00.000Z", [flaky("npm test", "2026-11-10T10:00:00.000Z", ["t"])])] }),
    source("q", "C", { C1: [set("2026-11-11T10:00:00.000Z", [flaky("npm test", "2026-11-11T10:00:00.000Z", ["t"])])] }),
  ]);
  assert.deepEqual(groups[0]?.steps, ["p/A/A1", "q/C/C1"]);
});

test("the text: a header, then each test with its count, last time, check and places; or that there were none", () => {
  const groups = flakyReport([source("p", "A", { A1: [set("2026-11-10T10:00:00.000Z", [flaky("npm run lint", "2026-11-10T10:00:00.000Z")])] })]);
  assert.equal(flakyText(groups, "2026-11-01"), [
    "flaky checks since 2026-11-01: 1 test, 1 time",
    "npm run lint (the check; its failing tests unknown)",
    "  1 time, last 2026-11-10 10:00; check npm run lint",
    "  in A/A1",
  ].join("\n"));
  assert.equal(flakyText([], "2026-11-01"), "no flaky checks since 2026-11-01");
});
