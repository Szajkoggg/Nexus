// How a step's own runtime, model and effort read (src/steps.ts), in the dashboard and in `nexus status`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepChecks, stepValuesText } from "../src/steps.ts";

test("a step's own values, compact; nothing for a step on the run's", () => {
  assert.equal(stepValuesText({}), undefined);
  assert.equal(stepValuesText({ runtime: "codex", model: "gpt-6-luna", effort: "low" }), "Codex · gpt-6-luna · low effort");
  assert.equal(stepValuesText({ runtime: "claude" }), "Claude Code");
  assert.equal(stepValuesText({ model: "haiku" }), "haiku");
  assert.equal(stepValuesText({ effort: "max" }), "max effort");
});

test("a step's checks: the project's first, then the queue's own; one named twice runs once", () => {
  assert.deepEqual(stepChecks(["npm run lint"], []), ["npm run lint"], "a queue without checks of its own gets the project's");
  assert.deepEqual(stepChecks(undefined, ["npm test"]), ["npm test"], "a run from before the setting: the queue's only");
  assert.deepEqual(stepChecks(["npm run lint", "npm test"], ["npm run typecheck", "npm test", " npm run lint "]),
    ["npm run lint", "npm test", "npm run typecheck"], "the same check does not run twice");
  assert.deepEqual(stepChecks(["", "  "], []), [], "blank names are no checks");
});
