// `nexus stats --flaky` (queue NKR3, docs/protocol/cli.md): the project's flaky checks from its queues' checks.yaml,
// by failing test, with --since; run in process (run-cli), with an empty NEXUS_HOME so only this project is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "@nexus/protocol";
import { cliOut } from "./run-cli.ts";

test("nexus stats --flaky lists the flaky tests by name, with --since", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-flaky-"));
  const home = mkdtempSync(join(tmpdir(), "nexus-cli-flaky-home-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  for (const id of ["A", "B"]) store.writeQueue({ protocol: 1, id, title: id, revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: `${id}1`, title: "Step", goal: "", acceptance: [] }] });
  const flakySet = (at: string, failed?: string[]) => ({
    done: "d", round: 1, fix: 0, requested_at: at, ended_at: at, state: "passed" as const,
    checks: [{ name: "npm test", command: "npm test", ok: true, flaky: true, runs: [
      { started_at: at, log: "1.log", exit_code: 1, ...(failed ? { failed_tests: failed } : {}) },
      { started_at: at, log: "2.log", exit_code: 0 },
    ] }],
  });
  store.writeChecks("A", { protocol: 1, steps: { A1: { by: "nexus", sets: [flakySet("2026-11-02T09:00:00.000Z", ["engine › halts"])] } } });
  store.writeChecks("B", { protocol: 1, steps: { B1: { by: "nexus", sets: [flakySet("2026-11-20T09:00:00.000Z", ["engine › halts"]), flakySet("2026-11-21T09:00:00.000Z")] } } });
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_HOME: home, NEXUS_DIR: store.dir };
  delete env.NEXUS_SESSION;

  assert.equal(await cliOut(["stats", "--flaky"], { cwd: root, env }), [
    "flaky checks: 2 tests, 3 times",
    "engine › halts",
    "  2 times, last 2026-11-20 09:00; check npm test",
    "  in A/A1, B/B1",
    "npm test (the check; its failing tests unknown)",
    "  1 time, last 2026-11-21 09:00; check npm test",
    "  in B/B1",
  ].join("\n") + "\n");
  const since = await cliOut(["stats", "--flaky", "--since", "2026-11-10"], { cwd: root, env });
  assert.match(since, /^flaky checks since 2026-11-10: 2 tests, 2 times\n/);
  assert.match(since, /engine › halts\n {2}1 time, last 2026-11-20 09:00; check npm test\n {2}in B\/B1\n/);
  assert.equal(await cliOut(["stats", "--flaky", "--since", "2026-11-25"], { cwd: root, env }), "no flaky checks since 2026-11-25\n");
});
