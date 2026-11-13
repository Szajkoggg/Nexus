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

test("pictures pair with an explicit before, else by label with an earlier round", async () => {
  const { pairPictures } = await import("../src/review.ts");
  const items = [
    { path: "/r/cliff-1.png", label: "Cliff", round: 1 },
    { path: "/r/moss-1.png", label: "Moss", round: 1 },
    { path: "/r/cliff-2.png", label: "Cliff", round: 2 },
    { path: "/r/cliff-3.png", label: "Cliff", round: 3 },
    { path: "/r/sky.png", label: "Sky", round: 2 },
    { path: "/r/lit.png", label: "Lit", before: "/r/unlit.png" },
  ];
  const pairs = pairPictures(items).map((p) => [p.item.path, p.before ?? null, p.beforeLabel ?? null]);
  assert.deepEqual(pairs, [
    ["/r/cliff-1.png", null, null],
    ["/r/moss-1.png", null, null],
    ["/r/cliff-2.png", "/r/cliff-1.png", "round 1"],
    ["/r/cliff-3.png", "/r/cliff-2.png", "round 2"], // the latest earlier round
    ["/r/sky.png", null, null],
    ["/r/lit.png", "/r/unlit.png", "before"],
  ]);
  // Without round numbers: the latest earlier picture with the label; the same round number does not pair.
  assert.deepEqual(pairPictures([{ path: "/a", label: "X" }, { path: "/b", label: "X" }, { path: "/c", label: "X" }]).map((p) => p.before ?? null), [null, "/a", "/b"]);
  assert.deepEqual(pairPictures([{ path: "/a", label: "X", round: 2 }, { path: "/b", label: "X", round: 2 }]).map((p) => p.before ?? null), [null, null]);
});
