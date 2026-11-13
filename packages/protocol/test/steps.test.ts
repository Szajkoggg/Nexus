// How a step's own runtime, model and effort read (src/steps.ts), in the dashboard and in `nexus status`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepValuesText } from "../src/steps.ts";

test("a step's own values, compact; nothing for a step on the run's", () => {
  assert.equal(stepValuesText({}), undefined);
  assert.equal(stepValuesText({ runtime: "codex", model: "gpt-6-luna", effort: "low" }), "Codex · gpt-6-luna · low effort");
  assert.equal(stepValuesText({ runtime: "claude" }), "Claude Code");
  assert.equal(stepValuesText({ model: "haiku" }), "haiku");
  assert.equal(stepValuesText({ effort: "max" }), "max effort");
});
