// Statistics (decided 2026-11-14, docs/ideas/statistics.md and tags.md; docs/protocol/stats.md, "Statistics"): how steps went, by
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
import { compareIds } from "./ids.ts";
import { windowKind } from "./digest.ts";

/** What a report groups by: the step's model or effort (from its worker turns), or one of its tag facets. */
export const STAT_DIMENSIONS = ["model", "effort", "kind", "activity", "area", "size", "origin"] as const;
export type StatDimension = (typeof STAT_DIMENSIONS)[number];
/** The tag facets a report can be narrowed to (one value each): the Stats view's filters. */
export const STAT_FILTERS = ["kind", "activity", "area", "size", "origin"] as const;
export type StatFilter = Partial<Record<(typeof STAT_FILTERS)[number], string>>;

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
  /**
   * How its session came to it (queue CT): `switch`, it opened in a fresh session after context care's switch (run.yaml
   * `switches`, `why: context`); `same`, in the session that ran the queue's step before it; `other`, anything else
   * (a run's first step, a runtime switch, the closing refactoring step, a session chosen at a start).
   */
  session_from: "switch" | "same" | "other";
  /** Its send-backs (by anyone) and the check-fix rounds after its failed checks. */
  send_backs: number; check_fix_rounds: number;
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
    const starts = (s: StepView) => s.timeline.filter((e) => e.type === "step.started");
    const opened = starts(st)[0]?.session;
    const k = q.steps.indexOf(st);
    const before = q.steps.slice(0, k).reverse().map((s) => starts(s).at(-1)?.session).find((x) => !!x);
    const switched = !!q.run?.switches?.some((x) => x.step === st.id && (x.why ?? "context") === "context");
    out.push({
      project: p.project.id, queue: q.id, step: st.id, at: outcomes.at(-1)!.at, status: st.status,
      model: last?.model, effort: last?.effort, runtime: last?.runtime,
      tags: st.tags, observed: st.observed_activities,
      rounds, accepted, first: accepted && rounds <= 1, decided: accepted || st.status === "rejected" || st.status === "failed",
      stops: st.timeline.filter((e) => e.type === "queue.stop").length,
      failures: st.timeline.filter((e) => e.type === "step.failed").length,
      work_ms: durations.length ? durations.reduce((a, b) => a + b, 0) : undefined,
      turns: own.length, fallback: own.some((x) => !!x.t.fallback), usage, usage_missing: missing,
      session_from: switched ? "switch" : opened && opened === before ? "same" : "other",
      send_backs: st.sent_back.length,
      check_fix_rounds: (q.check_runs?.steps[st.id]?.sets ?? []).filter((x) => x.state === "failed").length,
    });
  }
  return out;
}

/** How the planned and the reported activities of an activity group's steps compare (tags.ts, activityDifference). */
interface ActivityCounts {
  /** Steps that planned it; that reported doing it; reported it without planning it; planned it and reported others. */
  planned: number; observed: number; unplanned: number; skipped: number;
}

export interface StatGroup {
  key: string;
  steps: number;
  /** The runtimes of its steps' last worker turns, sorted. */
  runtimes: string[];
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
  /** By window: how many of its steps have an estimate in it (what a use per step divides by). */
  usage_steps: Record<string, number>;
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
  /** The tag filter applied (StatFilter): only steps under each value given. */
  filter?: StatFilter;
  /** Steps counted in all (a step of several activities is in several groups). */
  steps: number;
  groups: StatGroup[];
  /** Every step counted, as one group (key "all"): each step once. */
  total: StatGroup;
  /** By tag facet: the values the steps in the range (and project) have before the tag filter, sorted; what it can pick. */
  facets: Record<(typeof STAT_FILTERS)[number], string[]>;
}

/** A quantile of sorted numbers, interpolated. */
function quantile(sorted: readonly number[], q: number): number | undefined {
  if (!sorted.length) return undefined;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo));
}

/**
 * A project's own name (an area, a prefixed activity) as a key: it counts only within its project, so across projects
 * it reads `<project>/<name>` and two projects' "engine" areas stay apart.
 */
const ownKey = (s: StepStat, name: string, across: boolean) => (across ? `${s.project}/${name}` : name);
/** An activity as a key: Nexus's activities are compared across projects as they are, a project's own are its own. */
const activityKey = (s: StepStat, a: string, across: boolean) => (PROJECT_ACTIVITY.test(a) ? ownKey(s, a, across) : a);

/** The keys a step falls under. */
function keysOf(s: StepStat, by: StatDimension, across: boolean): string[] {
  switch (by) {
    case "model": return [s.model ?? UNTAGGED];
    case "effort": return [s.effort ?? (s.model ? "default" : UNTAGGED)];
    case "area": return [s.tags.area ? ownKey(s, s.tags.area, across) : UNTAGGED];
    case "activity": {
      const all = [...new Set([...(s.tags.activities ?? []), ...(s.observed ?? [])])];
      return all.length ? all.map((a) => activityKey(s, a, across)) : [UNTAGGED];
    }
    case "kind": case "size": case "origin": return [s.tags[by] ?? UNTAGGED];
  }
}

/**
 * The report: the steps (of `project`, or all) whose last outcome is at or after `since`, grouped by `by`, the
 * largest group first.
 */
export function statsReport(all: readonly StepStat[], o: { by: StatDimension; project?: string; since?: string; filter?: StatFilter }): StatsReport {
  const ranged = all.filter((s) => (!o.project || s.project === o.project) && (!o.since || s.at >= o.since));
  const across = !o.project && new Set(ranged.map((s) => s.project)).size > 1;
  const filter = Object.entries(o.filter ?? {}).filter(([, v]) => v) as [(typeof STAT_FILTERS)[number], string][];
  const steps = ranged.filter((s) => filter.every(([facet, v]) => keysOf(s, facet, across).includes(v)));
  const groups = new Map<string, StepStat[]>();
  for (const s of steps) for (const key of keysOf(s, o.by, across)) groups.set(key, [...(groups.get(key) ?? []), s]);
  const out = [...groups].map(([key, xs]) => groupOf(key, xs, o.by, across)).sort((a, b) => b.steps - a.steps || a.key.localeCompare(b.key));
  const facets = Object.fromEntries(STAT_FILTERS.map((f) => [f, [...new Set(ranged.flatMap((s) => keysOf(s, f, across)))].sort()])) as StatsReport["facets"];
  return {
    by: o.by, project: o.project, since: o.since, ...(filter.length ? { filter: Object.fromEntries(filter) } : {}),
    steps: steps.length, groups: out, total: groupOf("all", steps, o.by, across), facets,
  };
}

/** One group's figures from its steps. */
function groupOf(key: string, xs: readonly StepStat[], by: StatDimension, across: boolean): StatGroup {
  const decided = xs.filter((s) => s.decided).length;
  const first = xs.filter((s) => s.first).length;
  const done = xs.filter((s) => s.rounds > 0);
  const times = xs.filter((s) => s.accepted && s.work_ms !== undefined).map((s) => s.work_ms!).sort((a, b) => a - b);
  const usage: Record<string, number> = {}, usageSteps: Record<string, number> = {};
  for (const s of xs) for (const [w, v] of Object.entries(s.usage)) { usage[w] = (usage[w] ?? 0) + v; usageSteps[w] = (usageSteps[w] ?? 0) + 1; }
  const g: StatGroup = {
    key, steps: xs.length, runtimes: [...new Set(xs.map((s) => s.runtime).filter((r): r is string => !!r))].sort(),
    few: xs.length < FEW_STEPS, decided, first_accepted: first,
    first_rate: decided ? first / decided : undefined,
    avg_rounds: done.length ? done.reduce((a, s) => a + s.rounds, 0) / done.length : undefined,
    stops: xs.reduce((a, s) => a + s.stops, 0), failures: xs.reduce((a, s) => a + s.failures, 0),
    median_ms: quantile(times, 0.5), p25_ms: quantile(times, 0.25), p75_ms: quantile(times, 0.75),
    usage, usage_steps: usageSteps, usage_missing: xs.reduce((a, s) => a + s.usage_missing, 0), fallback: xs.filter((s) => s.fallback).length,
  };
  if (by === "activity" && key !== UNTAGGED && key !== "all") {
    const has = (list: readonly string[] | undefined, s: StepStat) => !!list?.some((a) => activityKey(s, a, across) === key);
    g.activities = {
      planned: xs.filter((s) => has(s.tags.activities, s)).length,
      observed: xs.filter((s) => has(s.observed, s)).length,
      unplanned: xs.filter((s) => has(s.observed, s) && !has(s.tags.activities, s)).length,
      skipped: xs.filter((s) => s.observed && has(s.tags.activities, s) && !has(s.observed, s)).length,
    };
  }
  return g;
}

/** The quality signals of one group of steps (SwitchReport). */
interface SwitchGroup {
  steps: number;
  /** Fewer than FEW_STEPS steps: read with care. */
  few: boolean;
  decided: number; first_accepted: number;
  /** first_accepted / decided; absent with nothing decided. */
  first_rate?: number;
  /** Steps sent back at least once; their share of the steps; all send-backs. */
  sent_back: number; send_back_rate?: number; send_backs: number;
  /** Check-fix rounds, all, and per step. */
  check_fix_rounds: number; check_fix_avg?: number;
}

/**
 * Whether context care's switches cost quality (queue CT): the steps (of `project`, or all; with an outcome at or after
 * `since`) that opened in a fresh session after a context switch, against those that went on in the session of the step
 * before; the other steps (a run's first, a runtime switch…) apart, counted in neither.
 */
export interface SwitchReport { project?: string; since?: string; switched: SwitchGroup; same: SwitchGroup; other: number }

export function switchReport(all: readonly StepStat[], o: { project?: string; since?: string } = {}): SwitchReport {
  const xs = all.filter((s) => (!o.project || s.project === o.project) && (!o.since || s.at >= o.since));
  const group = (g: readonly StepStat[]): SwitchGroup => {
    const decided = g.filter((s) => s.decided).length, first = g.filter((s) => s.first).length;
    const sent = g.filter((s) => s.send_backs > 0).length, fixes = g.reduce((a, s) => a + s.check_fix_rounds, 0);
    return {
      steps: g.length, few: g.length < FEW_STEPS, decided, first_accepted: first, first_rate: decided ? first / decided : undefined,
      sent_back: sent, send_back_rate: g.length ? sent / g.length : undefined, send_backs: g.reduce((a, s) => a + s.send_backs, 0),
      check_fix_rounds: fixes, check_fix_avg: g.length ? fixes / g.length : undefined,
    };
  };
  return {
    project: o.project, since: o.since,
    switched: group(xs.filter((s) => s.session_from === "switch")), same: group(xs.filter((s) => s.session_from === "same")),
    other: xs.filter((s) => s.session_from === "other").length,
  };
}

/** The comparison as `nexus stats --switches` prints it. */
export function switchReportText(r: SwitchReport): string {
  const line = (name: string, g: SwitchGroup) => {
    if (!g.steps) return `- ${name}: no step`;
    const parts = [`${plural(g.steps, "step")}${g.few ? " (few data)" : ""}`];
    parts.push(g.first_rate !== undefined ? `accepted in the first round ${g.first_accepted} of ${g.decided} (${pct(g.first_rate)})` : "none decided yet");
    parts.push(`sent back ${g.sent_back} of ${g.steps} (${pct(g.send_back_rate!)}; ${plural(g.send_backs, "send-back")})`);
    parts.push(`${plural(g.check_fix_rounds, "check-fix round")} (${Math.round(g.check_fix_avg! * 100) / 100} per step)`);
    return `- ${name}: ${parts.join("; ")}`;
  };
  return [
    `Steps after a context switch and without one (${r.project ? `project ${r.project}` : "all projects"}${r.since ? `, since ${r.since}` : ""})`,
    line("after a context switch (a fresh session)", r.switched),
    line("without a switch (the session of the step before)", r.same),
    `Not compared: ${plural(r.other, "step")} that opened a session otherwise (a run's first step, a runtime switch, the closing refactoring step). A switch is read from the queue's current run record. Groups of fewer than 5 steps are few data.`,
  ].join("\n");
}

/** One usage window's course, day by day (UsageDays). */
interface UsageDay {
  runtime: string;
  /** The window's name as the runtime reports it (five_hour, seven_day, codex_7d…). */
  window: string;
  /** "5h": the highest reading of each day; "7d": the level at each day's end. Utilization, 0 to 1; null: unknown. */
  kind: "5h" | "7d";
  values: (number | null)[];
}
/** GET /api/usage/days: the days (local dates, oldest first) and each window's values for them. */
export interface UsageDays { days: string[]; windows: UsageDay[] }

/** Runtimes in the order the statistics list them: Claude Code's first, then by name. */
export const byRuntime = (a: string, b: string): number => (a === b ? 0 : a === "claude" ? -1 : b === "claude" ? 1 : a.localeCompare(b));

/** A local date as the days are keyed (2026-11-14): the server's days here, the browser's in the Stats view. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The usage windows day by day from `from`'s day to `to`'s, in local dates, for the Stats view. The readings are
 * every turn's windows at its start and end (turns.jsonl), so a window is known only when some turn ran. A 5-hour
 * window: the highest reading of the day (null on a day without one). A weekly window: the last reading by the
 * day's end, 0 once that reading's reset time has passed, null before its first reading. Only the 5-hour and weekly
 * windows (digest.ts, windowKind) with a reading in the period; Claude Code's first, then by name.
 */
export function usageDays(turns: readonly TurnRecord[], from: Date, to: Date): UsageDays {
  const days: { key: string; start: number; end: number }[] = [];
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d.getTime() <= to.getTime(); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    days.push({ key: dayKey(d), start: d.getTime(), end: next.getTime() });
  }
  const readings = new Map<string, { runtime: string; window: string; kind: "5h" | "7d"; list: { t: number; u: number; reset?: number }[] }>();
  for (const r of turns) {
    for (const [time, windows] of [[r.started_at, r.windows_start], [r.at, r.windows_end]] as const) {
      if (!time || !windows) continue;
      for (const [name, w] of Object.entries(windows)) {
        const kind = windowKind(name);
        if (!kind) continue;
        const id = `${r.runtime}:${name}`;
        const entry = readings.get(id) ?? { runtime: r.runtime, window: name, kind, list: [] };
        entry.list.push({ t: Date.parse(time), u: w.utilization, ...(w.resets_at ? { reset: Date.parse(w.resets_at) } : {}) });
        readings.set(id, entry);
      }
    }
  }
  const first = days[0]?.start ?? 0, last = days.at(-1)?.end ?? 0;
  const windows: UsageDay[] = [];
  for (const { runtime, window, kind, list } of readings.values()) {
    list.sort((a, b) => a.t - b.t);
    if (!list.some((x) => x.t >= first && x.t < last)) continue;
    const values = days.map(({ start, end }) => {
      if (kind === "5h") {
        const own = list.filter((x) => x.t >= start && x.t < end);
        return own.length ? Math.max(...own.map((x) => x.u)) : null;
      }
      const before = list.filter((x) => x.t < end).at(-1);
      if (!before) return null;
      return before.reset !== undefined && before.reset <= end ? 0 : before.u;
    });
    windows.push({ runtime, window, kind, values });
  }
  windows.sort((a, b) => byRuntime(a.runtime, b.runtime)
    || (a.kind === b.kind ? a.window.localeCompare(b.window) : a.kind === "5h" ? -1 : 1));
  return { days: days.map((d) => d.key), windows };
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
    .sort((a, b) => a.at.localeCompare(b.at) || compareIds(a.event, b.event));
  const names = [...state.metrics.metrics.map((m) => m.name), ...values.map((v) => v.name)];
  const metrics = [...new Set(names)].map((n) => metricDef(state.metrics, n)).filter((d): d is MetricDef => !!d);
  return { metrics, values };
}
