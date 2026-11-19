// The project's metrics (.nexus/metrics.yaml; metrics.ts, docs/protocol/stats.md "Project metrics"): the orchestrator's
// definition, which the server carries out. The server is the only writer of the file.
import { ActionError } from "./actions.ts";
import { CHECK_UNIT, isCheckMetric, metricDefText, metricRequestIssues, type MetricRequest, type MetricShow } from "./metrics.ts";
import type { MetricDef } from "./schemas.ts";
import { now, type ProjectStore } from "./store.ts";

/**
 * The orchestrator names a metric, or changes one (its `metric.defined` event, from `nexus metric define`): checked
 * (metricRequestIssues), then written whole: what a new definition leaves out (a target, a threshold) is gone. A
 * changed metric keeps its place in the file. Returns what happened, in a sentence.
 */
export function defineMetric(store: ProjectStore, req: MetricRequest, session?: string): string {
  const issues = metricRequestIssues(req);
  if (issues.length) throw new ActionError(issues.join("; "));
  const name = req.name.trim();
  const def: MetricDef = {
    name,
    unit: isCheckMetric(name) ? CHECK_UNIT : req.unit!.trim(),
    show: (req.show ?? "line") as MetricShow,
    ...(req.target !== undefined ? { target: req.target } : {}),
    ...(req.warn_above !== undefined ? { warn_above: req.warn_above } : {}),
    ...(req.warn_below !== undefined ? { warn_below: req.warn_below } : {}),
    at: now(),
    ...(session ? { session } : {}),
  };
  const file = store.readMetrics();
  const known = file.metrics.some((m) => m.name === name);
  store.writeMetrics({ ...file, metrics: known ? file.metrics.map((m) => (m.name === name ? def : m)) : [...file.metrics, def] });
  const how = isCheckMetric(name) ? "its values are the check's times (nexus check --duration)" : `workers record it with nexus metric record ${name} <value>`;
  return `metric ${metricDefText(def)} ${known ? "changed" : "defined"}; ${how}`;
}
