// Layout faults (scripts/capture/faults.ts): the judging of what the page's collector gathered. No browser here: the
// geometry is written by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, findFaults, type Box, type Line } from "../capture/faults.ts";

const box = (name: string, left: number, top: number, right: number, bottom: number): Box => ({ name, rect: { left, top, right, bottom } });
/** A line through the points, sampled every 2 px as the collector does. */
function line(name: string, ...pts: [number, number][]): Line {
  const points: [number, number][] = [];
  pts.slice(1).forEach(([x2, y2], i) => {
    const [x1, y1] = pts[i]!, n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 2));
    for (let k = i ? 1 : 0; k <= n; k++) points.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
  });
  return { name, points };
}

test("a line through a box between its ends is a fault; ending on a box's edge is not", () => {
  const boxes = [box("A", 0, 0, 100, 50), box("B", 150, 0, 250, 50), box("C", 300, 0, 400, 50)];
  const f = findFaults({ boxes, lines: [line("A>C", [100, 25], [300, 25]), line("A>B", [100, 10], [150, 10])], cut: [] });
  assert.deepEqual(f.through, [{ line: "A>C", box: "B" }]);
  // Around B instead: above it, through the gap.
  const around = findFaults({ boxes, lines: [line("A>C", [100, 25], [125, 25], [125, -10], [275, -10], [275, 25], [300, 25])], cut: [] });
  assert.deepEqual(around.through, []);
});

test("boxes that overlap are a fault; boxes that touch are not", () => {
  const f = findFaults({ boxes: [box("A", 0, 0, 100, 50), box("B", 100, 0, 200, 50), box("C", 190, 40, 300, 90)], lines: [], cut: [] });
  assert.deepEqual(f.overlaps, [{ a: "B", b: "C" }]);
});

test("crossings are counted once each, and lines meeting at a shared end are not a crossing", () => {
  const f = findFaults({
    boxes: [],
    lines: [line("a", [0, 0], [100, 100]), line("b", [0, 100], [100, 0]), line("c", [100, 100], [200, 100]), line("d", [100, 100], [100, 200])],
    cut: [],
  });
  assert.equal(f.crossings, 1);
});

test("the report names each fault and says the crossings are not one", () => {
  const f = findFaults({
    boxes: [box("A", 0, 0, 100, 50), box("B", 50, 20, 150, 70)],
    lines: [line("X>Y", [-20, 25], [200, 25])],
    cut: [{ name: "span.title", axis: "x", text: "Statistics views: the project page", scroll: 310.1, client: 309.9 }],
  });
  const text = describe(f).join("\n");
  assert.match(text, /lines through boxes: 2\n {2}X>Y runs through A\n {2}X>Y runs through B/);
  assert.match(text, /overlapping boxes: 1\n {2}A overlaps B/);
  assert.match(text, /text cut short: 1\n {2}span\.title \(width 310\.1 > 309\.9\): "Statistics views: the project page"/);
  assert.match(text, /line crossings \(not a fault\): 0/);
});
