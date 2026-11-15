// A project's Stats tab (src/metrics.ts): one card per metric, its values in the range in step order, the target and
// the warning threshold as reference lines inside the axis, a value beyond the threshold marked, each point leading to
// its step, a metric without a value, and clean axis ticks.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectMetrics } from "@nexus/protocol/stats";
import { metricCards, niceAxis, stepMetrics } from "../src/metrics.ts";

const at = (d: number) => new Date(Date.UTC(2026, 10, d, 12)).toISOString();
const value = (name: string, v: number, d: number, step: string, over: Record<string, unknown> = {}) =>
  ({ name, value: v, unit: "KB", at: at(d), event: `e${d}${step}`, session: "w", queue: "UI", step, ...over });

const metrics: ProjectMetrics = {
  metrics: [
    { name: "bundle-kb", unit: "KB", show: "line", target: 400, warn_above: 450 },
    { name: "long-files", unit: "files", show: "bar", warn_below: 2 },
    { name: "startup-ms", unit: "ms", show: "line", target: 800 },
    { name: "check:npm test", unit: "s", show: "line" },
  ],
  values: [
    value("bundle-kb", 410, 10, "UI1", { commit: "abc1234" }),
    value("bundle-kb", 457, 12, "UI2", { warn: { side: "above", limit: 450 } }),
    value("long-files", 1, 12, "UI2", { unit: "files", warn: { side: "below", limit: 2 } }),
    value("bundle-kb", 421, 14, "UI 3"),
    value("check:npm test", 212, 14, "UI 3", { unit: "s" }),
  ],
};

test("the target and the threshold are reference lines, inside the axis", () => {
  const [bundle, files] = metricCards("p", metrics);
  assert.deepEqual(bundle!.refs, [{ value: 400, kind: "target" }, { value: 450, kind: "warn" }]);
  assert.ok(bundle!.axis.min <= 400 && bundle!.axis.max >= 457, "the line, the target and the threshold all in sight");
  assert.ok(bundle!.axis.min > 0, "a line need not start at zero");
  assert.deepEqual(files!.refs, [{ value: 2, kind: "warn" }], "a threshold below");
  assert.equal(files!.axis.min, 0, "bars start at zero");
});

test("a value beyond the threshold is marked; each point leads to its step", () => {
  const [bundle] = metricCards("p", metrics);
  assert.deepEqual(bundle!.points.map((p) => [p.value, p.warn, p.queue, p.step, p.href]), [
    [410, false, "UI", "UI1", "#/p/UI/UI1"],
    [457, true, "UI", "UI2", "#/p/UI/UI2"],
    [421, false, "UI", "UI 3", "#/p/UI/UI%203"],
  ]);
  assert.equal(bundle!.points[0]!.commit, "abc1234");
  assert.deepEqual([bundle!.last?.step, bundle!.change], ["UI 3", 11]);
});

test("a metric without a value: a card without points, its target still drawn; the range leaves values out", () => {
  const cards = metricCards("p", metrics, at(13));
  const startup = cards.find((c) => c.def.name === "startup-ms")!;
  assert.deepEqual([startup.points, startup.last, startup.change, startup.refs], [[], undefined, undefined, [{ value: 800, kind: "target" }]]);
  assert.deepEqual(cards.map((c) => c.def.name), ["bundle-kb", "long-files", "startup-ms", "check:npm test"], "every metric, in the endpoint's order");
  assert.deepEqual(cards[0]!.points.map((p) => p.value), [421], "only the values at or after the range's start");
  assert.equal(cards[1]!.points.length, 0, "long-files' only value is before it");
  assert.equal(cards[0]!.change, undefined, "one value: no change to tell");
});

test("clean axis ticks", () => {
  assert.deepEqual(niceAxis(368, 480), { min: 350, max: 500, ticks: [350, 400, 450, 500] });
  assert.deepEqual(niceAxis(0, 15.75), { min: 0, max: 20, ticks: [0, 5, 10, 15, 20] });
  assert.deepEqual(niceAxis(0.1, 0.38).ticks, [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(niceAxis(5, 5), { min: 5, max: 5.6, ticks: [5, 5.2, 5.4, 5.6] }, "one value: a tenth of it around it");
});

test("a step's metrics: the latest of each, a beyond-threshold one marked, a check's time only when it warns", () => {
  const warn = { side: "above" as const, limit: 450 };
  const rows = stepMetrics([
    { name: "bundle-kb", value: 470, unit: "KB", commit: "aaa", warn },
    { name: "check:npm test", value: 212, unit: "s" },
    { name: "bundle-kb", value: 457, unit: "KB", commit: "bbb", warn },
    { name: "check:npm run build", value: 95, unit: "s", warn: { side: "above", limit: 60 } },
    { name: "known-bugs", value: 3, unit: "bugs" },
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.value, r.commit, r.warn?.limit, r.earlier]), [
    ["bundle-kb", 457, "bbb", 450, 1], ["check:npm run build", 95, undefined, 60, 0], ["known-bugs", 3, undefined, undefined, 0],
  ]);
  assert.deepEqual(stepMetrics([]), []);
});
