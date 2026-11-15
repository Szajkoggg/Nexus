// A project's Stats tab, its data made ready for the cards (components/ProjectStats.tsx; the mockup
// docs/ux/mockups/21-stats-project.html and the reasons for each form in docs/ux/stats-mockups.md): one card per
// metric in the form the orchestrator gave it (`show`: line, bar, number), its values in the range in step order, the
// target and the warning threshold as reference lines, each value with the step it leads to. Pure and unit tested;
// the metrics come from GET /api/projects/:id/metrics (packages/protocol/src/stats.ts, projectMetrics).
import type { MetricDef } from "@nexus/protocol";
import type { ProjectMetrics } from "@nexus/protocol/stats";
import { itemHash } from "./hash.ts";

/** One value on a card: the value, its step (and the link there), its commit and time, beyond the threshold or not. */
export interface MetricPoint {
  value: number; at: string; queue: string; step: string; commit?: string;
  /** Beyond the warning threshold, as the metric is defined now. */
  warn: boolean;
  /** The step's address: a point leads to its step. */
  href: string;
}

/** A reference line: the target (secondary ink) or the warning threshold (the warn colour, with ⚠). */
interface MetricRef { value: number; kind: "target" | "warn" }

export interface MetricCard {
  def: MetricDef;
  points: MetricPoint[];
  refs: MetricRef[];
  /** The value axis: from `min` to `max`, ticks at clean steps (a bar or a number from zero). */
  axis: { min: number; max: number; ticks: number[] };
  last?: MetricPoint;
  /** The latest value against the first in the range (a number's change); absent with fewer than two values. */
  change?: number;
}

/** Clean ticks over [lo, hi]: a step of 1, 2 or 5 times a power of ten, two to four intervals. */
export function niceAxis(lo: number, hi: number): { min: number; max: number; ticks: number[] } {
  if (hi <= lo) hi = lo + (lo === 0 ? 1 : Math.abs(lo) * 0.1);
  const p = 10 ** Math.floor(Math.log10((hi - lo) / 2));
  const step = [1, 2, 5, 10].map((k) => k * p).find((s) => (hi - lo) / s <= 4)!;
  const min = Number((Math.floor(lo / step) * step).toPrecision(12)), max = Number((Math.ceil(hi / step) * step).toPrecision(12));
  const ticks: number[] = [];
  for (let t = min; t <= max + step / 1e6; t += step) ticks.push(Number(t.toPrecision(12)));
  return { min, max, ticks };
}

/**
 * The cards: every metric (the project's own, then the checks' times seen; projectMetrics' order) with its values at
 * or after `since` (an ISO time; none: all), oldest first. A metric without a value in the range is a card without
 * points. The axis covers the values and the reference lines, with a little room; bars and numbers start at zero.
 */
export function metricCards(project: string, m: ProjectMetrics, since?: string): MetricCard[] {
  return m.metrics.map((def) => {
    const points: MetricPoint[] = m.values
      .filter((v) => v.name === def.name && (!since || v.at >= since))
      .map((v) => ({ value: v.value, at: v.at, queue: v.queue, step: v.step, ...(v.commit ? { commit: v.commit } : {}), warn: !!v.warn, href: itemHash(project, v.queue, v.step) }));
    const refs: MetricRef[] = [
      ...(def.target !== undefined ? [{ value: def.target, kind: "target" as const }] : []),
      ...(def.warn_above !== undefined ? [{ value: def.warn_above, kind: "warn" as const }] : []),
      ...(def.warn_below !== undefined ? [{ value: def.warn_below, kind: "warn" as const }] : []),
    ];
    const all = [...points.map((p) => p.value), ...refs.map((r) => r.value)];
    const fromZero = def.show !== "line";
    const lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 1;
    const room = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
    const axis = niceAxis(fromZero ? Math.min(0, lo) : lo - room, hi + room);
    const last = points.at(-1);
    return { def, points, refs, axis, ...(last ? { last } : {}), ...(points.length > 1 ? { change: last!.value - points[0]!.value } : {}) };
  });
}

/** A step's metric as its details show it: the latest value of each, and whether that one is beyond its threshold. */
export interface StepMetric { name: string; value: number; unit: string; commit?: string; warn?: { side: "above" | "below"; limit: number }; earlier: number }

/**
 * The metrics a step's details list (StepView.metrics, every round's values, oldest first): the latest value of each,
 * in the order first recorded, with how many earlier values it had. A check's time is in the step's checks already:
 * it is listed here only when it is beyond a threshold the orchestrator set for it.
 */
export function stepMetrics(values: readonly { name: string; value: number; unit: string; commit?: string; warn?: { side: "above" | "below"; limit: number } }[]): StepMetric[] {
  const out = new Map<string, StepMetric>();
  for (const v of values) {
    const seen = out.get(v.name);
    out.set(v.name, { name: v.name, value: v.value, unit: v.unit, ...(v.commit ? { commit: v.commit } : {}), ...(v.warn ? { warn: v.warn } : {}), earlier: seen ? seen.earlier + 1 : 0 });
  }
  return [...out.values()].filter((m) => !m.name.startsWith("check:") || m.warn);
}
