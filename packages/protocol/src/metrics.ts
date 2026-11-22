// A project's metrics (decided 2026-11-14, docs/ideas/statistics.md; docs/protocol/stats.md, "Project metrics"): what the
// project measures, named by the orchestrator (`nexus metric define`, into .nexus/metrics.yaml, which only the server
// writes), and the values its workers record (`nexus metric record`, a `metric.recorded` event among the worker's own
// events, with the queue, the step and the HEAD commit). The checks' times exist as metrics without a definition:
// `check:<the check's name>`, in seconds, from `check.result`'s duration. A value beyond its metric's warning threshold
// is marked on the derived step and told to the orchestrator. Pure and free of Node: the dashboard may import it
// (`@nexus/protocol/metrics`); the definition, which writes the file, is in metric-define.ts.
import type { MetricDef, MetricsFile } from "./schemas.ts";

/** How a metric is shown in the statistics' views: a line over time, bars per step, or the latest number. */
export const METRIC_SHOWS = ["line", "bar", "number"] as const;
export type MetricShow = (typeof METRIC_SHOWS)[number];

/** A metric's own name: lowercase words and digits joined by hyphens, dots or underscores (bundle-kb, fps.p95). */
const METRIC_NAME = /^[a-z0-9]+(?:[-._][a-z0-9]+)*$/;
const NAME_MAX = 64;
const UNIT_MAX = 16;

/** The prefix of a check's time as a metric: `check:npm test` is how long the check `npm test` ran, in seconds. */
export const CHECK_METRIC = "check:";
export const CHECK_UNIT = "s";

/** A check's time as a metric's name. */
export const checkMetric = (check: string) => `${CHECK_METRIC}${check.trim()}`;
export const isCheckMetric = (name: string) => name.startsWith(CHECK_METRIC);

/**
 * One value of a metric on its step (StepView.metrics): a worker's `metric.recorded`, or a check's time (`check:<name>`,
 * from `check.result`). `event`: the event's id; `commit`: the HEAD of the checkout when it was reported; `warn`: the
 * value is beyond its metric's warning threshold as the metric is defined now.
 */
export interface MetricValue {
  name: string; value: number; unit: string; at: string; event: string; session: string; commit?: string;
  warn?: { side: "above" | "below"; limit: number };
}

/** What a definition asks for (`nexus metric define`, the `metric.defined` event). */
export interface MetricRequest {
  name: string; unit?: string; show?: string;
  target?: number; warn_above?: number; warn_below?: number;
}

/**
 * Why a definition cannot be taken, one reason each; empty when it can. A check's time takes no unit but seconds; one
 * warning threshold at most (above or below); numbers are finite.
 */
export function metricRequestIssues(r: MetricRequest): string[] {
  const out: string[] = [];
  const name = r.name.trim();
  if (isCheckMetric(name)) {
    if (!name.slice(CHECK_METRIC.length).trim()) out.push(`a check's time is ${CHECK_METRIC}<the check's name, as reported with nexus check>, e.g. "${CHECK_METRIC}npm test"`);
    if (r.unit !== undefined && r.unit.trim() !== CHECK_UNIT) out.push(`a check's time is in seconds: its unit is ${CHECK_UNIT} (or leave --unit out), not ${r.unit}`);
  } else {
    if (!METRIC_NAME.test(name) || name.length > NAME_MAX) out.push(`a metric's name is lowercase words and digits joined by hyphens, dots or underscores (bundle-kb, fps.p95; at most ${NAME_MAX} characters), not "${r.name}"`);
    const unit = r.unit?.trim();
    if (!unit) out.push("a metric needs its unit (--unit ms, KB, fps, %, count, …)");
    else if (unit.length > UNIT_MAX || /\s/.test(unit)) out.push(`a unit is one short word (at most ${UNIT_MAX} characters, no spaces), not "${r.unit}"`);
  }
  if (r.show !== undefined && !(METRIC_SHOWS as readonly string[]).includes(r.show)) out.push(`--show is one of ${METRIC_SHOWS.join(", ")}, not ${r.show}`);
  for (const [k, v] of [["target", r.target], ["warn-above", r.warn_above], ["warn-below", r.warn_below]] as const) {
    if (v !== undefined && !Number.isFinite(v)) out.push(`--${k} takes a number`);
  }
  if (r.warn_above !== undefined && r.warn_below !== undefined) out.push("give one warning threshold: --warn-above or --warn-below, not both");
  return out;
}

/** The definition a metric's values are read by: the project's, or a check's time without one (in seconds, a line). */
export function metricDef(file: Pick<MetricsFile, "metrics">, name: string): MetricDef | undefined {
  const own = file.metrics.find((m) => m.name === name);
  if (own) return own;
  return isCheckMetric(name) ? { name, unit: CHECK_UNIT, show: "line" } : undefined;
}

/** Whether a value is beyond its metric's warning threshold, and which (strictly above, or strictly below). */
export function metricWarning(def: Pick<MetricDef, "warn_above" | "warn_below"> | undefined, value: number): { side: "above" | "below"; limit: number } | undefined {
  if (def?.warn_above !== undefined && value > def.warn_above) return { side: "above", limit: def.warn_above };
  if (def?.warn_below !== undefined && value < def.warn_below) return { side: "below", limit: def.warn_below };
  return undefined;
}

/** A value with its unit: "512 KB", "12.5 s", "87 %". */
export function metricValueText(value: number, unit: string): string {
  return `${Number.isInteger(value) ? value : Number(value.toPrecision(6))} ${unit}`;
}

/** A definition on one line: "bundle-kb (KB, bar; target 400; warn above 500)". */
export function metricDefText(d: MetricDef): string {
  const more = [
    d.target !== undefined ? `target ${d.target}` : "",
    d.warn_above !== undefined ? `warn above ${d.warn_above}` : "",
    d.warn_below !== undefined ? `warn below ${d.warn_below}` : "",
  ].filter(Boolean);
  return `${d.name} (${d.unit}, ${d.show}${more.length ? `; ${more.join("; ")}` : ""})`;
}
