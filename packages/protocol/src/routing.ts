// What a step runs on (PROTOCOL.md, "Kinds and their defaults"): its runtime, model, effort and fallback chain, by the
// precedence decided with queue FB (2026-11-14), strongest first: the step's own values in the queue YAML; the queue's;
// what the run's start named explicitly (--runtime, --model, --effort, or the session it continues); the step's kind's
// defaults (the project's own, else the global ones); the project's defaults. Pure and free of Node: the engine, the
// estimates and the dashboard use it alike.
import { effortIssue, type Effort, type FallbackEntry, type KindDefaults, type ProjectFile } from "./schemas.ts";
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
export interface StartValues { runtime: WorkerRuntime; model?: string; effort?: Effort; explicit: readonly ("runtime" | "model" | "effort")[] }

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
