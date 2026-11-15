// Statistics (decided 2026-11-14, docs/ideas/statistics.md and tags.md; PROTOCOL.md, "Statistics"): how steps went, by
// model, effort or a tag facet, for the orchestrator choosing a model and effort and for the user watching the use of
// the subscription. Raw numbers would mislead (hard work goes to strong models), so beside the counts: the share
// accepted in the first round, the average rounds, stops and failures, the median working time, and the estimated use
// of the usage windows (usage-estimate.ts). A group of fewer than FEW_STEPS steps is marked "few data". Steps and turns
// without a tag fall in UNTAGGED. Pure and free of Node: `nexus stats` reads the files, and the server's statistics
// endpoints and the dashboard use the same functions.
import type { MetricDef, TurnRecord } from "./schemas.ts";
import type { ProjectState, StepView } from "./state.ts";
import { PROJECT_ACTIVITY, type StepTags } from "./tags.ts";
import { usageEstimates } from "./usage-estimate.ts";
import { metricDef, type MetricValue } from "./metrics.ts";
import { formatSeconds } from "./times.ts";

/** What a report groups by: the step's model or effort (from its worker turns), or one of its tag facets. */
export const STAT_DIMENSIONS = ["model", "effort", "kind", "activity", "area", "size", "origin"] as const;
export type StatDimension = (typeof STAT_DIMENSIONS)[number];

/** A group with fewer steps than this is marked "few data" (the estimates' minimum too). */
const FEW_STEPS = 5;
/** The group of steps without the facet (older queues before tags), and of steps with no worker turn's model. */
const UNTAGGED = "untagged";

/** One step as the statistics count it: one with an outcome (done, failed, or stopped at), of any project. */
export interface StepStat {
  project: string; queue: string; step: string;
  /** Its last outcome (step.done, step.failed, queue.stop at it): what --since compares. */
  at: string;
  status: StepView["status"];
  /** From its worker turns: the last turn's model and effort and runtime (as the estimates take them). */
  model?: string; effort?: string; runtime?: string;
  tags: StepTags;
  observed?: string[];
  /** Its rounds of work: how many times it was reported done. */
  rounds: number;
  /** Accepted (done); accepted in its first round; decided (accepted, rejected or failed). */
  accepted: boolean; first: boolean; decided: boolean;
  stops: number; failures: number;
  /** The sum of its worker turns' durations (its own work, never the wait for a review); none without turns. */
  work_ms?: number;
  turns: number;
  /** Some of its worker turns ran on a fallback (TurnRecord `fallback`). */
  fallback: boolean;
  /** Estimated use, by window (`<runtime>:<window>`, in utilization, 0 to 1), summed over its worker turns. */
  usage: Record<string, number>;
  /** Its worker turns without an estimate in a window they name (a reset, a reading missing, unknown tokens). */
  usage_missing: number;
}

const OUTCOMES = new Set(["step.done", "step.failed", "queue.stop"]);

/**
 * Every step with an outcome in the projects given, with what its worker turns say. The usage estimate is computed
 * over every turn given (all projects and roles share the windows), so pass them all.
 */
export function stepStats(projects: readonly Pick<ProjectState, "project" | "queues">[], turns: readonly TurnRecord[]): StepStat[] {
  const estimates = usageEstimates(turns);
  const byStep = new Map<string, { t: TurnRecord; e: (typeof estimates)[number] }[]>();
  turns.forEach((t, i) => {
    if (t.role !== "worker" || !t.queue || !t.step) return;
    const key = `${t.project}/${t.queue}/${t.step}`;
    const list = byStep.get(key) ?? [];
    list.push({ t, e: estimates[i]! });
    byStep.set(key, list);
  });
  const out: StepStat[] = [];
  for (const p of projects) for (const q of p.queues) for (const st of q.steps) {
    const outcomes = st.timeline.filter((e) => OUTCOMES.has(e.type));
    if (!outcomes.length) continue;
    const own = (byStep.get(`${p.project.id}/${q.id}/${st.id}`) ?? []).sort((a, b) => a.t.at.localeCompare(b.t.at));
    const last = own.at(-1)?.t;
    const rounds = st.timeline.filter((e) => e.type === "step.done").length;
    const accepted = st.status === "done";
    const usage: Record<string, number> = {};
    let missing = 0;
    for (const { t, e } of own) {
      let gap = false;
      for (const [w, x] of Object.entries(e)) {
        if ("share" in x) usage[`${t.runtime}:${w}`] = (usage[`${t.runtime}:${w}`] ?? 0) + x.share;
        else gap = true;
      }
      if (gap) missing++;
    }
    const durations = own.map((x) => x.t.duration_ms).filter((d): d is number => d !== undefined);
    out.push({
      project: p.project.id, queue: q.id, step: st.id, at: outcomes.at(-1)!.at, status: st.status,
      model: last?.model, effort: last?.effort, runtime: last?.runtime,
      tags: st.tags, observed: st.observed_activities,
      rounds, accepted, first: accepted && rounds <= 1, decided: accepted || st.status === "rejected" || st.status === "failed",
      stops: st.timeline.filter((e) => e.type === "queue.stop").length,
      failures: st.timeline.filter((e) => e.type === "step.failed").length,
      work_ms: durations.length ? durations.reduce((a, b) => a + b, 0) : undefined,
      turns: own.length, fallback: own.some((x) => !!x.t.fallback), usage, usage_missing: missing,
    });
  }
  return out;
}

/** How the planned and the reported activities of an activity group's steps compare (tags.ts, activityDifference). */
interface ActivityCounts {
  /** Steps that planned it; that reported doing it; reported it without planning it; planned it and reported others. */
  planned: number; observed: number; unplanned: number; skipped: number;
}

interface StatGroup {
  key: string;
  steps: number;
  /** Fewer than FEW_STEPS steps: read with care. */
  few: boolean;
  decided: number;
  first_accepted: number;
  /** first_accepted / decided; absent with nothing decided. */
  first_rate?: number;
  /** The average rounds of the steps reported done at least once. */
  avg_rounds?: number;
  stops: number; failures: number;
  /** Working time of its accepted steps: the median and the quartiles (by size, how the planned size came out). */
  median_ms?: number; p25_ms?: number; p75_ms?: number;
  /** Estimated use by window, summed; an estimate, and the turns without one. */
  usage: Record<string, number>;
  usage_missing: number;
  /** Steps with a turn on a fallback. */
  fallback: number;
  activities?: ActivityCounts;
}

export interface StatsReport {
  by: StatDimension;
  /** The one project counted; absent: every project. */
  project?: string;
  since?: string;
  /** Steps counted in all (a step of several activities is in several groups). */
  steps: number;
  groups: StatGroup[];
}

/** A quantile of sorted numbers, interpolated. */
function quantile(sorted: readonly number[], q: number): number | undefined {
  if (!sorted.length) return undefined;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo));
}

/**
 * The keys a step falls under. A project's own names (its areas, its prefixed activities) count only within their
 * project: across projects they read `<project>/<name>`, so two projects' "engine" areas stay apart; Nexus's
 * activities are compared across projects as they are.
 */
function keysOf(s: StepStat, by: StatDimension, across: boolean): string[] {
  const own = (name: string) => (across ? `${s.project}/${name}` : name);
  switch (by) {
    case "model": return [s.model ?? UNTAGGED];
    case "effort": return [s.effort ?? (s.model ? "default" : UNTAGGED)];
    case "area": return [s.tags.area ? own(s.tags.area) : UNTAGGED];
    case "activity": {
      const all = [...new Set([...(s.tags.activities ?? []), ...(s.observed ?? [])])];
      return all.length ? all.map((a) => (PROJECT_ACTIVITY.test(a) ? own(a) : a)) : [UNTAGGED];
    }
    case "kind": case "size": case "origin": return [s.tags[by] ?? UNTAGGED];
  }
}

/**
 * The report: the steps (of `project`, or all) whose last outcome is at or after `since`, grouped by `by`, the
 * largest group first.
 */
export function statsReport(all: readonly StepStat[], o: { by: StatDimension; project?: string; since?: string }): StatsReport {
  const steps = all.filter((s) => (!o.project || s.project === o.project) && (!o.since || s.at >= o.since));
  const across = !o.project && new Set(steps.map((s) => s.project)).size > 1;
  const groups = new Map<string, { key: string; steps: StepStat[] }>();
  for (const s of steps) for (const key of keysOf(s, o.by, across)) {
    const g = groups.get(key) ?? { key, steps: [] };
    g.steps.push(s);
    groups.set(key, g);
  }
  const out = [...groups.values()].map(({ key, steps: xs }): StatGroup => {
    const decided = xs.filter((s) => s.decided).length;
    const first = xs.filter((s) => s.first).length;
    const done = xs.filter((s) => s.rounds > 0);
    const times = xs.filter((s) => s.accepted && s.work_ms !== undefined).map((s) => s.work_ms!).sort((a, b) => a - b);
    const usage: Record<string, number> = {};
    for (const s of xs) for (const [w, v] of Object.entries(s.usage)) usage[w] = (usage[w] ?? 0) + v;
    const g: StatGroup = {
      key, steps: xs.length, few: xs.length < FEW_STEPS, decided, first_accepted: first,
      first_rate: decided ? first / decided : undefined,
      avg_rounds: done.length ? done.reduce((a, s) => a + s.rounds, 0) / done.length : undefined,
      stops: xs.reduce((a, s) => a + s.stops, 0), failures: xs.reduce((a, s) => a + s.failures, 0),
      median_ms: quantile(times, 0.5), p25_ms: quantile(times, 0.25), p75_ms: quantile(times, 0.75),
      usage, usage_missing: xs.reduce((a, s) => a + s.usage_missing, 0), fallback: xs.filter((s) => s.fallback).length,
    };
    if (o.by === "activity" && key !== UNTAGGED) {
      const has = (list: readonly string[] | undefined, s: StepStat) => !!list?.some((a) => (PROJECT_ACTIVITY.test(a) && across ? `${s.project}/${a}` : a) === key);
      g.activities = {
        planned: xs.filter((s) => has(s.tags.activities, s)).length,
        observed: xs.filter((s) => has(s.observed, s)).length,
        unplanned: xs.filter((s) => has(s.observed, s) && !has(s.tags.activities, s)).length,
        skipped: xs.filter((s) => s.observed && has(s.tags.activities, s) && !has(s.observed, s)).length,
      };
    }
    return g;
  }).sort((a, b) => b.steps - a.steps || a.key.localeCompare(b.key));
  return { by: o.by, project: o.project, since: o.since, steps: steps.length, groups: out };
}

/**
 * A --since (or ?since=) as an ISO time: a date ("2026-11-14", from that day's start on this machine) or a time
 * Date.parse reads; undefined when it reads neither.
 */
export function sinceTime(text: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getDate() === Number(m[3]) ? d.toISOString() : undefined;
  }
  const t = Date.parse(text);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** A report's dimension from text, or undefined (the default is the model). */
export const statDimension = (text: string | undefined): StatDimension | undefined =>
  text === undefined ? "model" : (STAT_DIMENSIONS as readonly string[]).includes(text) ? (text as StatDimension) : undefined;

const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;
const time = (ms: number) => formatSeconds(Math.round(ms / 1000));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One group on one line, as `nexus stats` prints it. */
function groupText(g: StatGroup): string {
  const parts = [`${plural(g.steps, "step")}${g.few ? " (few data)" : ""}`];
  parts.push(g.first_rate !== undefined ? `accepted in the first round ${g.first_accepted} of ${g.decided} (${pct(g.first_rate)})` : "none decided yet");
  if (g.avg_rounds !== undefined) { const r = Math.round(g.avg_rounds * 10) / 10; parts.push(`${r} ${r === 1 ? "round" : "rounds"} on average`); }
  parts.push(`${plural(g.stops, "stop")}, ${plural(g.failures, "failure")}`);
  if (g.median_ms !== undefined) parts.push(`median work ${time(g.median_ms)}${g.p25_ms !== g.p75_ms ? ` (${time(g.p25_ms!)} to ${time(g.p75_ms!)})` : ""}`);
  const use = Object.entries(g.usage).sort(([a], [b]) => a.localeCompare(b)).map(([w, v]) => `${w} ${pct(v)}`);
  if (use.length || g.usage_missing) parts.push(`estimated use ${use.join(", ") || "none"}${g.usage_missing ? ` (${plural(g.usage_missing, "turn")} without an estimate)` : ""}`);
  if (g.fallback) parts.push(`${g.fallback} on a fallback`);
  const a = g.activities;
  if (a) parts.push(`planned in ${a.planned}, reported in ${a.observed} (${a.unplanned} unplanned, ${a.skipped} skipped)`);
  return `- ${g.key}: ${parts.join("; ")}`;
}

/** The report as `nexus stats` prints it. */
export function statsText(r: StatsReport): string {
  const head = `Steps by ${r.by} (${r.project ? `project ${r.project}` : "all projects"}${r.since ? `, since ${r.since}` : ""}; ${plural(r.steps, "step")} with an outcome)`;
  const note = "Use is estimated: each turn's part of the window's growth, by tokens among the turns running meanwhile (in utilization of the window). Groups of fewer than 5 steps are few data.";
  return [head, ...(r.groups.length ? r.groups.map(groupText) : ["- no step with an outcome"]), note].join("\n");
}

/** A project's metric values with where each belongs, for its metrics endpoint and views. */
type MetricPoint = MetricValue & { queue: string; step: string };

/** GET /api/projects/:id/metrics: the metrics (the project's own and every check's time seen) and their values, oldest first. */
export interface ProjectMetrics { metrics: MetricDef[]; values: MetricPoint[] }

export function projectMetrics(state: Pick<ProjectState, "metrics" | "queues">): ProjectMetrics {
  const values = state.queues.flatMap((q) => q.steps.flatMap((st) => st.metrics.map((m) => ({ ...m, queue: q.id, step: st.id }))))
    .sort((a, b) => a.at.localeCompare(b.at) || a.event.localeCompare(b.event));
  const names = [...state.metrics.metrics.map((m) => m.name), ...values.map((v) => v.name)];
  const metrics = [...new Set(names)].map((n) => metricDef(state.metrics, n)).filter((d): d is MetricDef => !!d);
  return { metrics, values };
}
