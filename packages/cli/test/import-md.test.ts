import { test } from "node:test";
import assert from "node:assert/strict";
import { importMarkdownQueues } from "../src/import-md.ts";

const opts = { source: "QUEUE.md", now: "2026-11-12T00:00:00Z" };

const TRACKS = [
  "# Work queues",
  "",
  "- **Stop conditions every queue has**: a decision comes up that is the user's (the look, gameplay); an asset is",
  "  missing; a step would grow.",
  "",
  "## Track W: variant B made a system (branch `v2/cliffs`)",
  "",
  "**Status: stopped at W2b** (2026-11-12: the look is open).",
  "",
  "Some context.",
  "",
  "| # | Step | Done when |",
  "|---|---|---|",
  "| W1 | **Voronoi fracture.** Done 2026-11-12 ([log](log/x.md)): numbers. The rock cut into cells | The measure separates; every body closed |",
  "| W2 | **Bodies shaped.** Built 2026-11-12, look still open (stopped). **Bodies shaped.** Per-edge bevels | No body under the minimal width |",
  "| W3 | **Support.** A contact graph | No floating body |",
  "",
  "Checks for each step: the Core tests.",
  "",
  "Stop conditions, beside the common ones:",
  "- The climb probe finds a way up.",
  "- A one-off fix would be needed.",
  "",
  "## Later tracks (not proposed yet)",
  "",
  "- Look guides.",
].join("\n");

test("tracks with a # / Step / Done when table", () => {
  const r = importMarkdownQueues(TRACKS, opts);
  assert.deepEqual(r.defaultStopConditions, [
    "A decision comes up that is the user's (the look, gameplay)", "An asset is missing", "A step would grow",
  ]);
  assert.equal(r.queues.length, 1);
  assert.deepEqual(r.skipped.map((s) => s.heading), ["Later tracks (not proposed yet)"]);
  const q = r.queues[0]!;
  assert.equal(q.id, "W");
  assert.equal(q.title, "Variant B made a system");
  assert.equal(q.branch, "v2/cliffs");
  assert.equal(q.status, "stopped");
  assert.equal(q.description, "Some context.");
  assert.deepEqual(q.checks, ["The Core tests."]);
  assert.deepEqual(q.stop_conditions, ["The climb probe finds a way up.", "A one-off fix would be needed."]);
  assert.deepEqual(q.steps.map((s) => [s.id, s.title, s.status]), [
    ["W1", "Voronoi fracture", "done"], ["W2", "Bodies shaped", "stopped"], ["W3", "Support", undefined],
  ]);
  assert.equal(q.steps[0]!.goal, "The rock cut into cells");
  assert.equal(q.steps[1]!.goal, "Per-edge bevels");
  assert.deepEqual(q.steps[0]!.acceptance, ["The measure separates", "every body closed"]);
});

const SINGLE = [
  "# Workflow queue W",
  "",
  "Approved by the user on 2026-11-11.",
  "",
  "| Step | Deliverable / acceptance | Status |",
  "|---|---|---|",
  "| W1 Current decisions | Short index | done |",
  "| W2 Exchange trial | Traceable records | waiting at a gate |",
  "",
  "Stop at a missing capability or a required user decision.",
].join("\n");

test("a single queue with a Step / acceptance / Status table, prefixed", () => {
  const q = importMarkdownQueues(SINGLE, { ...opts, prefix: "D" }).queues[0]!;
  assert.equal(q.id, "DW");
  assert.equal(q.status, "waiting");
  assert.deepEqual(q.steps.map((s) => [s.id, s.title, s.status]), [
    ["DW1", "Current decisions", "done"], ["DW2", "Exchange trial", "waiting"],
  ]);
  assert.deepEqual(q.stop_conditions, ["Stop at a missing capability or a required user decision."]);
});
