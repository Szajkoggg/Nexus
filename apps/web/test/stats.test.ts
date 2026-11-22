// The global Stats view's data (src/stats.ts): the range's first day and the addresses asked, the comparison rows
// (grouping as the report gives it, "few data", minutes and per cents), the use per step as an estimate of the weekly
// windows only, the headline from the total, the scales, and the usage windows' panels.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StatGroup, StatsReport } from "@nexus/protocol/stats";
import { compareRows, compareScales, dayOf, daysUrl, estimate, headline, niceMax, rangeSince, rangeSinceIso, statsUrl, weeklyUse, windowPanels } from "../src/stats.ts";

const today = new Date(2026, 10, 15, 14, 30);

function group(key: string, over: Partial<StatGroup> = {}): StatGroup {
  return {
    key, steps: 10, runtimes: ["claude"], few: false, decided: 8, first_accepted: 6, first_rate: 0.75, avg_rounds: 1.25,
    stops: 1, failures: 0, median_ms: 30 * 60_000, p25_ms: 20 * 60_000, p75_ms: 45 * 60_000,
    usage: {}, usage_steps: {}, usage_missing: 0, fallback: 0, ...over,
  };
}
const report = (groups: StatGroup[], total: StatGroup = group("all")): StatsReport => ({
  by: "model", steps: total.steps, groups, total, facets: { kind: [], activity: [], area: [], size: [], origin: [] },
});

test("the range's first day, as a local date; the addresses carry the range, grouping, project and tag filter", () => {
  assert.equal(rangeSince("7d", today), "2026-11-09", "today and the six days before");
  assert.equal(rangeSince("30d", today), "2026-10-17");
  assert.equal(rangeSince("all", today), undefined);
  assert.equal(rangeSinceIso("7d", today), new Date(2026, 10, 9).toISOString(), "the first day's local start as an ISO time");
  assert.equal(rangeSinceIso("all", today), undefined);
  assert.equal(dayOf("2026-11-09").getTime(), new Date(2026, 10, 9).getTime(), "a day's key back to its local start");
  assert.equal(statsUrl({ range: "30d", by: "effort", filter: { kind: "code", area: "" } }, today), "/api/stats?by=effort&since=2026-10-17&kind=code");
  assert.equal(statsUrl({ range: "all", by: "model", project: "p", filter: {} }, today), "/api/stats?by=model&project=p");
  assert.equal(daysUrl("all", today), "/api/usage/days?since=2026-08-18", "all: the last 90 days of windows");
});

test("grouping: one row per group in the report's order, a Claude model without its prefix, times in minutes", () => {
  const rows = compareRows(report([group("claude-opus-5-5", { steps: 12 }), group("gpt-6", { steps: 4, few: true, runtimes: ["codex"], first_rate: undefined, decided: 0, median_ms: undefined })]));
  assert.deepEqual(rows.map((r) => [r.key, r.label, r.steps, r.few, r.runtimes]), [["claude-opus-5-5", "opus-5-5", 12, false, ["claude"]], ["gpt-6", "gpt-6", 4, true, ["codex"]]]);
  assert.deepEqual([rows[0]!.rate, rows[0]!.rounds, rows[0]!.median, rows[0]!.p25, rows[0]!.p75], [75, 1.25, 30, 20, 45]);
  assert.deepEqual([rows[1]!.rate, rows[1]!.median], [undefined, undefined], "nothing decided, nothing accepted: no figure, not zero");
});

test("use per step: the weekly windows only, over the steps with an estimate, Claude Code's first; marked as an estimate", () => {
  const g = group("x", {
    usage: { "codex:codex_7d": 0.03, "claude:seven_day": 0.02, "claude:five_hour": 0.4, "claude:seven_day_opus": 0.01 },
    usage_steps: { "codex:codex_7d": 3, "claude:seven_day": 4, "claude:five_hour": 4, "claude:seven_day_opus": 1 },
  });
  assert.deepEqual(weeklyUse(g), [{ runtime: "claude", window: "seven_day", perStep: 0.5 }, { runtime: "codex", window: "codex_7d", perStep: 1 }]);
  assert.deepEqual(weeklyUse(group("y", { usage: { "claude:seven_day": 0 }, usage_steps: {} })), [], "no step with an estimate: nothing to show");
  assert.equal(estimate(0.5), "≈ 0.5 %");
  assert.equal(estimate(1.25), "≈ 1.3 %");
  assert.equal(estimate(0.04), "≈ <0.1 %");
  assert.equal(estimate(0), "≈ 0 %");
});

test("few data is the report's mark (fewer than 5 steps), kept on the row", () => {
  const rows = compareRows(report([group("a", { steps: 3, few: true }), group("b", { steps: 5 })]));
  assert.deepEqual(rows.map((r) => r.few), [true, false]);
});

test("the headline from the total: each step once, the weekly window most steps have an estimate in", () => {
  const total = group("all", {
    steps: 20, fallback: 2, usage_missing: 3,
    usage: { "claude:seven_day": 0.1, "codex:codex_7d": 0.04 }, usage_steps: { "claude:seven_day": 5, "codex:codex_7d": 8 },
  });
  const h = headline(report([group("a"), group("b")], total));
  assert.deepEqual([h.steps, h.fallback, h.rate, h.first, h.decided, h.median, h.missing], [20, 2, 75, 6, 8, 30, 3]);
  assert.deepEqual(h.use, { runtime: "codex", window: "codex_7d", perStep: 0.5 });
  assert.equal(headline(report([], group("all", { steps: 0, usage: {} }))).use, undefined);
});

test("the scales: up to the longest third quartile and the largest use, on clean ends", () => {
  const rows = compareRows(report([group("a", { p75_ms: 51 * 60_000, usage: { "claude:seven_day": 0.014 }, usage_steps: { "claude:seven_day": 1 } }), group("b")]));
  assert.deepEqual(compareScales(rows), { minutes: 60, use: 1.5 });
  assert.deepEqual(compareScales([]), { minutes: 60, use: 1 });
  assert.deepEqual([niceMax(0.9), niceMax(1.4), niceMax(2.5), niceMax(7), niceMax(42)], [1, 1.5, 3, 8, 50]);
});

test("the windows' panels: per cent, the latest known value, the days at or over the threshold", () => {
  const panels = windowPanels({
    days: ["2026-11-13", "2026-11-14", "2026-11-15"],
    windows: [
      { runtime: "claude", window: "five_hour", kind: "5h", values: [0.95, null, 0.4] },
      { runtime: "claude", window: "seven_day", kind: "7d", values: [0.3, 0.35, null] },
    ],
  }, 0.9);
  assert.deepEqual(panels.map((p) => [p.id, p.kind, p.last, p.over]), [["claude:five_hour", "5h", 40, 1], ["claude:seven_day", "7d", 35, 0]]);
  assert.deepEqual(panels[0]!.points.map((p) => p.value), [95, null, 40]);
});
