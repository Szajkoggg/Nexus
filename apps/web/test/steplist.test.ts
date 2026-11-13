import { test } from "node:test";
import assert from "node:assert/strict";
import { currentIndex, foldSteps, twoColumns } from "../src/steplist.ts";

const steps = (spec: string) => spec.split(" ").map((x) => { const [id, status] = x.split(":"); return { id: id!, status: status! }; });
// The 11-step queue of mockup 17: three done, two skipped, W4c stopped, five pending.
const W = steps("W1:done W2:skipped W3:done W4:skipped W4b:done W4c:stopped W4d:pending W4e:pending W5:pending W6:pending W7:pending");
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("the 11-step queue: the finished run folds, the stopped step and the next three show, the rest folds", () => {
  const f = foldSteps(W, "W4c");
  assert.deepEqual(f.before, { from: "W1", to: "W4b", count: 5, done: 3, skipped: 2 });
  assert.deepEqual(ids(f.shown), ["W4c", "W4d", "W4e", "W5"]);
  assert.deepEqual(f.after, ["W6", "W7"]);
});

test("a tap unfolds either part", () => {
  assert.deepEqual(ids(foldSteps(W, "W4c", { before: true }).shown), ["W1", "W2", "W3", "W4", "W4b", "W4c", "W4d", "W4e", "W5"]);
  const all = foldSteps(W, "W4c", { before: true, after: true });
  assert.equal(all.before, undefined);
  assert.equal(all.after, undefined);
  assert.deepEqual(ids(all.shown), ids(W));
});

test("a fold of one step would save nothing: it is shown", () => {
  const f = foldSteps(steps("A1:done A2:running A3:pending A4:pending A5:pending A6:pending"), "A2");
  assert.equal(f.before, undefined, "one finished step stays a line");
  assert.deepEqual(ids(f.shown), ["A1", "A2", "A3", "A4", "A5", "A6"], "one step after the three stays a line");
  assert.equal(f.after, undefined);
});

test("without a current step the first unfinished one matters; a queue not started shows its first four", () => {
  const f = foldSteps(steps("B1:pending B2:pending B3:pending B4:pending B5:pending B6:pending"));
  assert.deepEqual(ids(f.shown), ["B1", "B2", "B3", "B4"]);
  assert.deepEqual(f.after, ["B5", "B6"]);
  assert.equal(currentIndex(steps("C1:done C2:skipped C3:pending")), 2);
});

test("only the leading finished run folds: a rejected step before the current one breaks it", () => {
  const f = foldSteps(steps("D1:done D2:done D3:rejected D4:done D5:running"), "D5");
  assert.deepEqual(f.before, { from: "D1", to: "D2", count: 2, done: 2, skipped: 0 });
  assert.deepEqual(ids(f.shown), ["D3", "D4", "D5"]);
});

test("a finished queue folds into its finished run", () => {
  const f = foldSteps(steps("E1:done E2:done E3:skipped"));
  assert.deepEqual(f.before, { from: "E1", to: "E3", count: 3, done: 2, skipped: 1 });
  assert.deepEqual(f.shown, []);
});

test("two columns, filled down the left first", () => {
  assert.deepEqual(twoColumns(ids(W)), [["W1", "W2", "W3", "W4", "W4b", "W4c"], ["W4d", "W4e", "W5", "W6", "W7"]]);
  assert.deepEqual(twoColumns([]), [[], []]);
});
