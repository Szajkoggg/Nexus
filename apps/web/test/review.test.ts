import { test } from "node:test";
import assert from "node:assert/strict";
import { noteTargets, showsReviewActions } from "../src/review.ts";

test("review actions show only on a step waiting for the user's review", () => {
  assert.equal(showsReviewActions({ id: "A", status: "review", review_with: "user" }), true, "policy wait");
  assert.equal(showsReviewActions({ id: "A", status: "review" }), true, "an older view without review_with");
  assert.equal(showsReviewActions({ id: "A", status: "review", review_with: "orchestrator" }), false, "the orchestrator holds it");
  assert.equal(showsReviewActions({ id: "A", status: "done" }), false, "went on under continue");
  for (const status of ["pending", "running", "waiting", "failed", "skipped", "stopped"]) assert.equal(showsReviewActions({ id: "A", status }), false, status);
});

test("a note goes to the next pending step, or only to the orchestrator on the last", () => {
  const steps = [{ id: "A", status: "done" }, { id: "B", status: "review" }, { id: "C", status: "skipped" }, { id: "D", status: "pending" }];
  assert.deepEqual(noteTargets(steps, "B"), { next: "D", orchestrator: true });
  assert.deepEqual(noteTargets(steps.slice(0, 3), "B"), { next: undefined, orchestrator: true }, "nothing pending after it");
});
