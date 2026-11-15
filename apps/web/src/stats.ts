// The global Stats view's data, made ready for its charts (components/Stats.tsx; the mockup and the reasons for each
// form: docs/ux/stats-mockups.md): the range's start, the comparison rows by model or effort, the headline figures,
// the usage windows' panels. Pure and unit tested; the report and the days come from GET /api/stats and
// GET /api/usage/days (packages/protocol/src/stats.ts).
import type { StatFilter, StatGroup, StatsReport, UsageDays } from "@nexus/protocol/stats";
import { windowKind } from "@nexus/protocol/digest";

export const RANGES = ["7d", "30d", "90d", "all"] as const;
export type Range = (typeof RANGES)[number];
const RANGE_DAYS: Record<Range, number | undefined> = { "7d": 7, "30d": 30, "90d": 90, all: undefined };

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The first day of a range ending today, as a local date (`since` of both endpoints); undefined: all. */
export function rangeSince(range: Range, today = new Date()): string | undefined {
  const n = RANGE_DAYS[range];
  return n === undefined ? undefined : day(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1)));
}

/** What the view asks for: the report's address with the range, grouping, project and tag filter. */
export function statsUrl(o: { range: Range; by: "model" | "effort"; project?: string; filter: StatFilter }, today = new Date()): string {
  const q = new URLSearchParams({ by: o.by });
  const since = rangeSince(o.range, today);
  if (since) q.set("since", since);
  if (o.project) q.set("project", o.project);
  for (const [k, v] of Object.entries(o.filter)) if (v) q.set(k, v);
  return `/api/stats?${q.toString()}`;
}
/** The windows day by day for a range; "all" shows the last 90 days (a line of every day since the first turn reads as noise). */
export const daysUrl = (range: Range, today = new Date()) => `/api/usage/days?since=${rangeSince(range === "all" ? "90d" : range, today)}`;

/** A group's estimated use of one weekly window per step, in per cent (utilization × 100). */
export interface WeeklyUse { runtime: string; window: string; perStep: number }

/**
 * A group's use of each weekly window per step: the summed estimate over the steps that have one in that window.
 * Only weekly windows (the 5-hour window resets too often to compare steps by), Claude Code's first.
 */
export function weeklyUse(g: Pick<StatGroup, "usage" | "usage_steps">): WeeklyUse[] {
  return Object.entries(g.usage)
    .map(([key, sum]) => {
      const [runtime = "", window = ""] = key.split(/:(.*)/s);
      const n = g.usage_steps[key] ?? 0;
      return { runtime, window, perStep: n ? (sum / n) * 100 : 0, n };
    })
    .filter((u) => windowKind(u.window) === "7d" && u.n > 0)
    .sort((a, b) => (a.runtime === "claude" ? -1 : b.runtime === "claude" ? 1 : a.runtime.localeCompare(b.runtime)))
    .map(({ runtime, window, perStep }) => ({ runtime, window, perStep }));
}

/** One row of the comparison: a model's or an effort's figures, times in minutes, rates in per cent. */
export interface CompareRow {
  key: string;
  /** The name shown: a Claude model without its "claude-" prefix; "untagged" and "default" as they are (the view words them). */
  label: string;
  steps: number;
  few: boolean;
  runtimes: string[];
  first: number; decided: number;
  rate?: number;
  rounds?: number;
  median?: number; p25?: number; p75?: number;
  uses: WeeklyUse[];
  /** Turns without an estimate: the use shown leaves them out. */
  missing: number;
  fallback: number; stops: number; failures: number;
}

const minutes = (ms: number | undefined) => (ms === undefined ? undefined : ms / 60_000);

function compareRow(g: StatGroup): CompareRow {
  return {
    key: g.key, label: g.key.replace(/^claude-/, ""), steps: g.steps, few: g.few, runtimes: g.runtimes,
    first: g.first_accepted, decided: g.decided,
    rate: g.first_rate === undefined ? undefined : g.first_rate * 100,
    rounds: g.avg_rounds,
    median: minutes(g.median_ms), p25: minutes(g.p25_ms), p75: minutes(g.p75_ms),
    uses: weeklyUse(g), missing: g.usage_missing, fallback: g.fallback, stops: g.stops, failures: g.failures,
  };
}

/** The comparison's rows, the largest group first (the report's order). */
export const compareRows = (r: StatsReport): CompareRow[] => r.groups.map(compareRow);

/**
 * The scales of the comparison's columns, shared by every row: working time up to the longest third quartile, use
 * per step up to the largest; each rounded up to a clean tick.
 */
export function compareScales(rows: readonly CompareRow[]): { minutes: number; use: number } {
  const longest = Math.max(0, ...rows.map((r) => r.p75 ?? r.median ?? 0));
  const most = Math.max(0, ...rows.flatMap((r) => r.uses.map((u) => u.perStep)));
  return { minutes: niceMax(longest || 60), use: niceMax(most || 1) };
}

/** The smallest of 1, 1.5, 2, 3, 4, 5, 6 or 8 times a power of ten at or above `x`: an axis end with clean ticks. */
export function niceMax(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  return [1, 1.5, 2, 3, 4, 5, 6, 8, 10].map((k) => k * p).find((s) => s >= x - 1e-9) ?? 10 * p;
}

/** The headline: every step counted once (the report's total). */
export interface Headline {
  steps: number; fallback: number;
  rate?: number; first: number; decided: number;
  median?: number; p25?: number; p75?: number;
  /** The weekly window most steps have an estimate in, per step; and how many turns have none. */
  use?: WeeklyUse; missing: number;
}
export function headline(r: StatsReport): Headline {
  const row = compareRow(r.total);
  const counted = (u: WeeklyUse) => r.total.usage_steps[`${u.runtime}:${u.window}`] ?? 0;
  const use = [...row.uses].sort((a, b) => counted(b) - counted(a))[0];
  return { steps: row.steps, fallback: row.fallback, rate: row.rate, first: row.first, decided: row.decided, median: row.median, p25: row.p25, p75: row.p75, use, missing: row.missing };
}

/** One usage window's panel: columns of the daily peak (5-hour) or a line of the day-end level (weekly), in per cent. */
export interface WindowPanel {
  id: string; runtime: string; window: string; kind: "5h" | "7d";
  points: { day: string; value: number | null }[];
  /** The latest known value (a line ends with it labelled). */
  last?: number;
  /** Days at or above the threshold (said in a 5-hour panel's caption). */
  over: number;
}
export function windowPanels(d: UsageDays, threshold: number): WindowPanel[] {
  return d.windows.map((w) => {
    const points = d.days.map((day, i) => ({ day, value: w.values[i] == null ? null : w.values[i]! * 100 }));
    const known = points.filter((p) => p.value !== null);
    return {
      id: `${w.runtime}:${w.window}`, runtime: w.runtime, window: w.window, kind: w.kind, points,
      last: known.at(-1)?.value ?? undefined,
      over: known.filter((p) => p.value! >= threshold * 100).length,
    };
  });
}

/** An estimate, written as one everywhere it appears: "≈ 0.9 %". */
export const estimate = (percent: number): string => `≈ ${percent < 0.1 && percent > 0 ? "<0.1" : (Math.round(percent * 10) / 10).toString()} %`;
