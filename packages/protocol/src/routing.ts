// What a step runs on (docs/protocol/runtimes.md, "Kinds and their defaults"): its runtime, model, effort and fallback chain, by the
// precedence decided with queue FB (2026-11-14), strongest first: the step's own values in the queue YAML; the queue's;
// what the run's start named explicitly (--runtime, --model, --effort, or the session it continues); the step's kind's
// defaults (the project's own, else the global ones); the project's defaults. Pure and free of Node: the engine, the
// estimates and the dashboard use it alike.
import { effortIssue, type Effort, type FallbackEntry, type KindDefaults, type ProjectFile, type RunFile } from "./schemas.ts";
import { TAG_KINDS } from "./tags.ts";

type WorkerRuntime = "claude" | "codex";

/** A level of the precedence: what it names. */
interface Level { runtime?: WorkerRuntime; model?: string; effort?: Effort; fallback?: FallbackEntry[] }

/** Where a value came from. */
type ValueSource = "step" | "queue" | "start" | "kind" | "project";

/** What a step runs on, and where each value came from (`model`, `effort`: none when no level names one). */
export interface Routed {
  runtime: WorkerRuntime; model?: string; effort?: Effort;
  /** The fallback chain, from the strongest level that names one; empty: none (the run waits, as before fallbacks). */
  fallback: FallbackEntry[];
  from: { runtime: ValueSource; model?: ValueSource; effort?: ValueSource; fallback?: ValueSource };
}

/**
 * The run's start: the values it resolved (`runtime` always), and which of them it named explicitly (`explicit`):
 * --runtime, --model, --effort, or all three when it continues a session. The others came from the project's defaults
 * and count only as those, so the kind's defaults go over them.
 */
export interface StartValues { runtime: WorkerRuntime; model?: string; effort?: Effort; explicit: readonly StartKey[] }

/** The values a run's start resolves. */
export const START_KEYS = ["runtime", "model", "effort"] as const;
type StartKey = (typeof START_KEYS)[number];

/**
 * A run's start as its run file records it: its values, those it took from the project's defaults (`from_defaults`)
 * not explicit. Undefined for an older run file without its values.
 */
export function runStart(run: Pick<RunFile, "runtime" | "model" | "effort" | "from_defaults">): StartValues | undefined {
  if (!run.runtime) return undefined;
  const d = new Set(run.from_defaults ?? []);
  return { runtime: run.runtime, model: run.model, effort: run.effort, explicit: START_KEYS.filter((k) => !d.has(k)) };
}

/** A kind's defaults in the project's effective settings; undefined for no kind, or one Nexus does not know. */
export function kindDefaults(project: Pick<ProjectFile, "kinds">, kind: string | undefined): KindDefaults | undefined {
  return kind && (TAG_KINDS as readonly string[]).includes(kind) ? project.kinds[kind as (typeof TAG_KINDS)[number]] : undefined;
}

/**
 * The step's runtime, model, effort and fallback chain. The runtime is the strongest level's that names one. A model
 * or effort comes from the strongest level that names one and belongs to that runtime: the step's always (its own
 * values go together); the queue's when the queue names no runtime or the same one; the start's (explicit ones only)
 * and the kind's only when their runtime is the step's; else the project's default for that runtime. So the kind
 * overrides only what the start took from the defaults, and a start with an explicit runtime keeps its own values for
 * a kind on another runtime. The fallback chain is the strongest level's that names one (step, queue, kind).
 */
export function routeStep(o: {
  step: Level; queue: Level; start: StartValues; kind?: KindDefaults; project: Pick<ProjectFile, "runtimes">;
}): Routed {
  const { step, queue, start, kind, project } = o;
  const explicit = new Set(start.explicit);
  const startLevel: Level = {
    runtime: explicit.has("runtime") ? start.runtime : undefined,
    model: explicit.has("model") ? start.model : undefined,
    effort: explicit.has("effort") ? start.effort : undefined,
  };
  const [runtime, runtimeFrom]: [WorkerRuntime, ValueSource] = step.runtime ? [step.runtime, "step"]
    : queue.runtime ? [queue.runtime, "queue"]
    : startLevel.runtime ? [startLevel.runtime, "start"]
    : kind ? [kind.runtime, "kind"]
    : [project.runtimes.default, "project"];
  // Each level with the runtime its model and effort belong to (undefined: any).
  const levels: [ValueSource, Level, WorkerRuntime | undefined][] = [
    ["step", step, undefined],
    ["queue", queue, queue.runtime],
    ["start", startLevel, start.runtime],
    ...(kind ? [["kind", kind, kind.runtime] as [ValueSource, Level, WorkerRuntime]] : []),
    ["project", project.runtimes[runtime], runtime],
  ];
  const pick = (key: "model" | "effort") => {
    for (const [source, level, owner] of levels) {
      if (owner !== undefined && owner !== runtime) continue;
      if (level[key] !== undefined) return { value: level[key], source };
    }
    return undefined;
  };
  const model = pick("model") as { value: string; source: ValueSource } | undefined;
  const effort = pick("effort") as { value: Effort; source: ValueSource } | undefined;
  const chain: [ValueSource, FallbackEntry[] | undefined][] = [["step", step.fallback], ["queue", queue.fallback], ["kind", kind?.fallback]];
  const fb = chain.find(([, f]) => f !== undefined);
  return {
    runtime, model: model?.value, effort: effort?.value, fallback: fb?.[1] ?? [],
    from: { runtime: runtimeFrom, model: model?.source, effort: effort?.source, fallback: fb?.[0] },
  };
}

/**
 * What is wrong with a fallback chain (empty: nothing): an effort its runtime does not take, or an entry after `wait`
 * (waiting ends the chain).
 */
export function fallbackIssues(chain: readonly FallbackEntry[] | undefined): string[] {
  const out: string[] = [];
  (chain ?? []).forEach((e, i) => {
    if (i > 0 && chain![i - 1] === "wait") out.push(`fallback entry ${i + 1} comes after wait, which ends the chain`);
    if (e === "wait") return;
    const issue = effortIssue(e.runtime, e.effort);
    if (issue) out.push(`fallback entry ${i + 1} (${e.runtime} at effort ${e.effort}): ${issue}`);
  });
  return out;
}

/** What is wrong with the kinds' defaults (an effort a runtime does not take, a bad fallback chain), by kind. */
export function kindIssues(kinds: Partial<Record<string, KindDefaults>>): string[] {
  return Object.entries(kinds).flatMap(([k, d]) => {
    if (!d) return [];
    const own = effortIssue(d.runtime, d.effort);
    return [...(own ? [`kind ${k}: ${own}`] : []), ...fallbackIssues(d.fallback).map((x) => `kind ${k}: ${x}`)];
  });
}

// ---------------------------------------------------------------- usage: beyond the threshold, and the fallback chain

/** A usage window as the server knows it (usage.json). */
interface UsageWindow { utilization: number; resets_at?: string }

/**
 * A window as a person reads it, with its runtime: "Claude Code's 5-hour window", "Claude Code's 7-day window",
 * "Codex's 5-hour window" (Codex's names give the length: codex_5h, codex_7d).
 */
function windowLabel(name: string): string {
  const codex = name.startsWith("codex_");
  const raw = codex ? name.slice("codex_".length) : name;
  const span = /^(\d+)h$/.exec(raw) ? `${raw.slice(0, -1)}-hour` : /^(\d+)d$/.exec(raw) ? `${raw.slice(0, -1)}-day`
    : raw.replaceAll("_", " ").replace(/^five hour/, "5-hour").replace(/^seven day/, "7-day");
  return `${codex ? "Codex" : "Claude Code"}'s ${span} window`;
}

/**
 * Why a runtime counts as full, in the words every view uses (the run's usage wait, a step's fallback, the dashboard's
 * "On Codex: …" line): "Claude Code's 7-day window at 96 % (limit 90 %)".
 */
function windowReason(name: string, utilization: number, threshold: number): string {
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  return `${windowLabel(name)} at ${pct(utilization)} (limit ${pct(threshold)})`;
}

/**
 * Whether a runtime is beyond the usage threshold now, and until when (docs/protocol/runtimes.md, "Fallback when usage runs out"):
 * any of its windows (Claude Code's five_hour, seven_day and the like; Codex's codex_*) at or above `threshold`. A
 * window the runtime has not reported is free; one whose `resets_at` has passed counts as reset, without a fresh
 * reading; one without a reset time cannot be waited for and counts as free. With several full windows, the later
 * reset counts. Undefined: free.
 */
export function overThreshold(runtime: WorkerRuntime, windows: Readonly<Record<string, UsageWindow>>, threshold: number, nowMs: number): { until: string; reason: string } | undefined {
  const full = Object.entries(windows)
    .filter(([k, w]) => (runtime === "codex") === k.startsWith("codex_") && w.utilization >= threshold && !!w.resets_at && Date.parse(w.resets_at) > nowMs)
    .sort(([, a], [, b]) => Date.parse(a.resets_at!) - Date.parse(b.resets_at!));
  const last = full.at(-1);
  if (!last) return undefined;
  const [name, w] = last;
  return { until: w.resets_at!, reason: windowReason(name, w.utilization, threshold) };
}

/** The values a step runs on. */
export interface RunOn { runtime: WorkerRuntime; model?: string; effort?: Effort }

/**
 * Where a step opens, given the usage now: on its own values (`primary`) while their runtime is free; else on the
 * first entry of its fallback chain whose runtime is free (`fallback`, with why: the primary's full window); at a
 * `wait` entry, or when the chain has no free entry left, it waits (`wait`) until the earliest reset among the runtimes
 * it tried (both full: the one that comes back first). An entry's model or effort left out is the project's for its
 * runtime.
 */
export function chooseRoute(routed: Pick<Routed, "runtime" | "model" | "effort" | "fallback">, o: {
  windows: Readonly<Record<string, UsageWindow>>; threshold: number; nowMs: number; project: Pick<ProjectFile, "runtimes">;
}): { kind: "primary"; values: RunOn } | { kind: "fallback"; values: RunOn; reason: string } | { kind: "wait"; until: string; reason: string } {
  const primary: RunOn = { runtime: routed.runtime, model: routed.model, effort: routed.effort };
  const full = overThreshold(primary.runtime, o.windows, o.threshold, o.nowMs);
  if (!full) return { kind: "primary", values: primary };
  const tried = [full];
  for (const e of routed.fallback) {
    if (e === "wait") return { kind: "wait", until: earliest(tried), reason: `${full.reason}; its fallback is to wait` };
    const busy = overThreshold(e.runtime, o.windows, o.threshold, o.nowMs);
    if (!busy) {
      const d = o.project.runtimes[e.runtime];
      return { kind: "fallback", values: { runtime: e.runtime, model: e.model ?? d.model, effort: e.effort ?? d.effort }, reason: full.reason };
    }
    tried.push(busy);
  }
  return {
    kind: "wait", until: earliest(tried),
    reason: tried.length > 1 ? `${tried.map((t) => t.reason).join("; ")}: every runtime of the chain is beyond the limit` : full.reason,
  };
}
const earliest = (xs: { until: string }[]) => xs.map((x) => x.until).sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
