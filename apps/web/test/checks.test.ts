// The checks Nexus runs, as the dashboard says them (src/checks.ts): the step's word and colours, the line under it,
// and the latest set's checks one by one (queue EC).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckSet } from "@nexus/protocol";
import { checkLine, checkRows, checkTone, checkWord } from "../src/checks.ts";

const SINCE = "2026-11-18T10:02:00.000Z";
const NOW = new Date("2026-11-18T10:05:00.000Z");
const clock = (iso: string) => new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

test("a step's word and colours while the checks decide it; a check-fix round apart from the review rounds", () => {
  assert.equal(checkWord({ status: "checking", checking: { phase: "queued", since: SINCE } }), "checks queued");
  assert.equal(checkWord({ status: "checking", checking: { phase: "running", since: SINCE, check: "npm test" } }), "checks running");
  assert.equal(checkWord({ status: "checking", checking: { phase: "base", since: SINCE } }), "checks on the base");
  assert.equal(checkWord({ status: "waiting", checking: { phase: "decision", since: SINCE } }), "waiting: orchestrator decides");
  assert.equal(checkWord({ status: "running", check_fix: 1, check_fix_limit: 3 }), "check fix 1 of 3");
  assert.equal(checkWord({ status: "running" }), undefined, "a plain running step keeps its word");
  assert.equal(checkWord({ status: "waiting" }), undefined, "waiting for an answer keeps its word");
  assert.equal(checkWord({ status: "review", check_fix: 1 }), undefined, "a step that reached review after a fix round reads review");
  assert.equal(checkTone({ status: "checking", checking: { phase: "queued", since: SINCE } }), "queued");
  assert.equal(checkTone({ status: "checking", checking: { phase: "running", since: SINCE } }), "checking");
  assert.equal(checkTone({ status: "running" }), "running");
});

test("the line under the step: what runs and since when, or what it waits for", () => {
  assert.equal(checkLine({ status: "checking", checking: { phase: "queued", since: SINCE } }, NOW), `waiting for the machine since ${clock(SINCE)}`);
  assert.equal(checkLine({ status: "checking", checking: { phase: "running", since: SINCE, check: "npm test" } }, NOW), `npm test since ${clock(SINCE)}`);
  assert.equal(checkLine({ status: "checking", checking: { phase: "base", since: SINCE, check: "npm test" } }, NOW), `npm test on the queue's base commit since ${clock(SINCE)}`);
  assert.equal(checkLine({ status: "waiting", checking: { phase: "decision", since: SINCE } }, NOW), "a disputed failure: the orchestrator decides");
  assert.equal(checkLine({ status: "running", check_fix: 1 }, NOW), undefined);
});

test("the latest set's checks one by one: passed, flaky, failed with its tests and log, running, waiting its turn", () => {
  const run = (o: Partial<CheckSet["checks"][number]["runs"][number]>) => ({ started_at: SINCE, log: "checks/A2/r1f0-x.1.log", ...o });
  const set: CheckSet = {
    done: "d1", round: 1, fix: 0, requested_at: SINCE, state: "running",
    checks: [
      { name: "npm run lint", command: "npm run lint", runs: [run({ ended_at: SINCE, exit_code: 0, duration: 12 })], ok: true },
      { name: "npm run typecheck", command: "npm run typecheck", runs: [run({ ended_at: SINCE, exit_code: 1 }), run({ ended_at: SINCE, exit_code: 0, duration: 30 })], ok: true, flaky: true },
      { name: "npm test", command: "npm test", runs: [run({ ended_at: SINCE, exit_code: 1 }), run({ ended_at: SINCE, exit_code: 1, duration: 200, failed_tests: ["engine › halts"], log: "checks/A2/r1f0-3-npm-test.2.log" })], ok: false },
      { name: "npm run build", command: "npm run build", runs: [run({})] },
    ],
  };
  const rows = checkRows(set, ["npm run lint", "npm run typecheck", "npm test", "npm run build", "npm run e2e"]);
  assert.deepEqual(rows.map((r) => [r.name, r.state]), [
    ["npm run lint", "passed"], ["npm run typecheck", "flaky"], ["npm test", "failed"], ["npm run build", "running"], ["npm run e2e", "waiting"],
  ]);
  assert.deepEqual(rows[2], { name: "npm test", state: "failed", duration: 200, tests: ["engine › halts"], log: "checks/A2/r1f0-3-npm-test.2.log" });
});
