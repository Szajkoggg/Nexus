// workerRuntime (queue CHC): the one place a runtime setting or a session's runtime becomes the runtime a process runs
// on: `codex` is Codex, anything else (claude, the orchestrator's `external`, none) Claude Code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { workerRuntime, type WorkerRuntime } from "../src/runtimes.ts";

test("codex is Codex; claude, external, an empty or missing value is Claude Code", () => {
  const cases: [string | undefined | null, WorkerRuntime][] = [
    ["codex", "codex"], ["claude", "claude"], ["external", "claude"], ["", "claude"], [undefined, "claude"], [null, "claude"], ["Codex", "claude"],
  ];
  for (const [x, want] of cases) assert.equal(workerRuntime(x), want, String(x));
});
