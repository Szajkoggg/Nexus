// The pure part of the project's metrics (metrics.ts): a check's time as a metric without a definition, the warning
// threshold (strictly beyond it), the checks of a definition, and how values and definitions read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { metricDef, metricDefText, metricRequestIssues, metricValueText, metricWarning } from "../src/metrics.ts";

const file = { metrics: [{ name: "bundle-kb", unit: "KB", show: "bar" as const, target: 400, warn_above: 500 }, { name: "check:npm test", unit: "s", show: "line" as const, warn_above: 300 }] };

test("a metric's definition: the project's own, a check's time in seconds without one, else none", () => {
  assert.equal(metricDef(file, "bundle-kb")?.unit, "KB");
  assert.deepEqual(metricDef(file, "check:lint"), { name: "check:lint", unit: "s", show: "line" });
  assert.equal(metricDef(file, "check:npm test")?.warn_above, 300, "a check's own definition wins");
  assert.equal(metricDef(file, "fps"), undefined);
});

test("a value is beyond its threshold only strictly; a metric without one never is", () => {
  assert.deepEqual(metricWarning({ warn_above: 500 }, 500.1), { side: "above", limit: 500 });
  assert.equal(metricWarning({ warn_above: 500 }, 500), undefined);
  assert.deepEqual(metricWarning({ warn_below: -1 }, -2), { side: "below", limit: -1 });
  assert.equal(metricWarning({ warn_below: -1 }, -1), undefined);
  assert.equal(metricWarning({}, 1e9), undefined);
  assert.equal(metricWarning(undefined, 1e9), undefined);
});

test("a definition's checks, and how values and definitions read", () => {
  assert.deepEqual(metricRequestIssues({ name: "fps.p95", unit: "fps", show: "number", target: 60, warn_below: 30 }), []);
  assert.deepEqual(metricRequestIssues({ name: "check:npm test" }), [], "a check's time takes no unit");
  assert.equal(metricRequestIssues({ name: "a", unit: "x", warn_above: Number.NaN }).length, 1);
  assert.equal(metricValueText(512, "KB"), "512 KB");
  assert.equal(metricValueText(0.1 + 0.2, "s"), "0.3 s");
  assert.equal(metricDefText(file.metrics[0]!), "bundle-kb (KB, bar; target 400; warn above 500)");
});
