// Expected times as estimates (queue PV4; decided 2026-11-14): how long a queue's steps still take, from how long
// finished steps took. A step's time is the sum of its worker turns' durations (turns.jsonl `duration_ms`): its own
// work, send-backs included, never the wait for its review (no turn runs then). A step to come is estimated by the
// average of finished steps on the same model and effort, else the same model, else all, each only with at least
// MIN_SAMPLES steps; with fewer finished steps in all there is no estimate. Pure: the server reads the files.
import type { ProjectFile, TurnRecord } from "./schemas.ts";
import { kindDefaults, routeStep, type StartValues } from "./routing.ts";
import { stepClosed, type QueueView } from "./state.ts";

/** Fewer finished steps than this: no estimate (and no group average from fewer). */
export const MIN_SAMPLES = 5;

/** A finished step: how long its worker turns took, on which model and effort (its last turn's). */
export interface Sample { model?: string; effort?: string; ms: number }

/**
 * One sample per finished step that had worker turns with a duration: `done(project, queue, step)` says which steps
 * are finished (done; a skipped step did no work worth counting).
 */
export function stepSamples(turns: readonly TurnRecord[], done: (project: string, queue: string, step: string) => boolean): Sample[] {
  const by = new Map<string, Sample & { at: string }>();
  for (const t of turns) {
    if (t.role !== "worker" || !t.queue || !t.step || t.duration_ms === undefined) continue;
    if (!done(t.project, t.queue, t.step)) continue;
    const key = `${t.project}/${t.queue}/${t.step}`;
    const s = by.get(key);
    if (!s) { by.set(key, { model: t.model, effort: t.effort, ms: t.duration_ms, at: t.at }); continue; }
    s.ms += t.duration_ms;
    if (t.at >= s.at) { s.model = t.model ?? s.model; s.effort = t.effort ?? s.effort; s.at = t.at; }
  }
  return [...by.values()].map(({ at: _at, ...s }) => s);
}

const mean = (xs: readonly Sample[]) => xs.reduce((a, s) => a + s.ms, 0) / xs.length;

/** A step's expected time on `model` at `effort`; undefined while fewer than MIN_SAMPLES steps are finished. */
export function estimateStep(samples: readonly Sample[], model?: string, effort?: string): number | undefined {
  if (samples.length < MIN_SAMPLES) return undefined;
  const exact = samples.filter((s) => s.model === model && s.effort === effort);
  if (exact.length >= MIN_SAMPLES) return mean(exact);
  const sameModel = samples.filter((s) => s.model === model);
  if (sameModel.length >= MIN_SAMPLES) return mean(sameModel);
  return mean(samples);
}

/** A queue's steps left (not closed) and their expected time; `ms` undefined: no estimate. */
export interface QueueEstimate { steps: number; ms?: number }

/** GET /api/projects/:id/estimates: how many finished steps the estimates come from, and each open queue's. */
export interface EstimatesResponse { samples: number; min: number; queues: Record<string, QueueEstimate> }

/**
 * What a queue's steps left are expected to take: each on the model and effort it would run on (routing.ts,
 * routeStep: its own, the queue's, what the run's start or the planned start named, its kind's, the project's). A step
 * already running counts whole.
 */
export function queueEstimate(
  q: Pick<QueueView, "steps" | "run" | "start" | "rejection"> & Partial<Pick<QueueView, "runtime" | "model" | "effort" | "fallback">>,
  project: Pick<ProjectFile, "runtimes" | "kinds">, samples: readonly Sample[],
): QueueEstimate {
  const left = q.steps.filter((s) => !stepClosed(q, s));
  const r = q.run;
  const keys = ["runtime", "model", "effort"] as const;
  const fromDefaults = new Set(r?.from_defaults ?? []);
  const start: StartValues = r?.runtime
    ? { runtime: r.runtime, model: r.model, effort: r.effort, explicit: keys.filter((k) => !fromDefaults.has(k)) }
    : { runtime: q.start?.runtime ?? project.runtimes.default, model: q.start?.model, effort: q.start?.effort, explicit: keys.filter((k) => q.start?.[k] !== undefined) };
  let ms = 0;
  for (const st of left) {
    const v = routeStep({ step: st, queue: q, start, kind: kindDefaults(project, st.tags?.kind), project });
    const e = estimateStep(samples, v.model, v.effort);
    if (e === undefined) return { steps: left.length };
    ms += e;
  }
  return { steps: left.length, ms: Math.round(ms) };
}
