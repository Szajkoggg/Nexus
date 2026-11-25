// The merge train (docs/protocol/git.md, "The merge train"; docs/design/git.md, "Merging back"): with the project's merge_back on,
// the queues in worktrees of their own that go back into one base integrate one at a time. One queue holds the base:
// its integration step runs (or runs again), or it waits for its fast-forward. The others wait their turn before their
// integration step, in the order they got there; their own steps before it never wait. A fast-forward that cannot go
// (git.yaml `merge.waiting`) lets the next queue go, and once it could go again it queues up behind those already
// waiting (`merge.queued`). Derived from the files alone, so a restarted server finds the same order. The server holds
// and lets go the runs (src/merger.ts); here: the rule and the view.
import type { ProjectFile } from "./schemas.ts";
import { notMergedBack } from "./plan.ts";
import { compareIds } from "./ids.ts";
import { runActive } from "./status-rules.ts";
import { pendingProvisional, stepClosed, type QueueView } from "./state.ts";

type TrainQueue = Pick<QueueView, "id" | "status" | "steps" | "run" | "git" | "rejection">;
/** What the train reads of the project's settings. */
type TrainProject = { defaults: Pick<ProjectFile["defaults"], "merge_back" | "provisional_counts"> };

/**
 * One base's train: `active`, the queues that hold the base (one, but for a moment of change: the first goes first);
 * `line`, the queues waiting their turn, first to go first. Each ordered by when it got there.
 */
export interface Train { base: string; active: string[]; line: string[] }

/** A queue's place in the line of its base's train: `after`, the queue just before it (none: it goes next). */
export interface TrainPlace { base: string; position: number; after?: string }

/** The base a queue goes back into ("" when unknown: such queues make a train of their own). */
export const trainBase = (q: Pick<QueueView, "git">): string => q.git?.base?.ref ?? "";

/**
 * A run on its way to its integration step: at work (running, pausing), or held at a step's end to go on by itself
 * (paused with resume_after_restart: held for the merge train, or for a merge back).
 */
export const runOnTrack = (r: QueueView["run"]): boolean =>
  !!r && (runActive(r) || (r.state === "paused" && !!r.resume_after_restart));

/** When a queue got to its integration step: the latest end of its other steps. */
function readyAt(q: TrainQueue, integ: QueueView["steps"][number]): string {
  return q.steps.filter((s) => s !== integ).map((s) => s.finished_at ?? "").reduce((a, b) => (b > a ? b : a), "");
}

/** Where a queue stands in its base's train, with the time that orders it there; undefined when it is not in it. */
function trainState(project: TrainProject, q: TrainQueue): { kind: "active" | "line"; key: string } | undefined {
  const integ = q.steps.find((s) => s.integration);
  if (!integ || q.status === "cancelled" || q.status === "stopped" || q.git?.cleaned || !notMergedBack(q)) return undefined;
  const merge = q.git?.merge;
  const since = integ.segments.at(-1)?.start ?? integ.started_at ?? "";
  // Its integration step at work, or waiting for its review: it holds the base, unless its run halted (the user acts).
  if (integ.status === "running" || integ.status === "waiting" || integ.status === "review") {
    return q.run?.state === "halted" ? undefined : { kind: "active", key: since };
  }
  if (integ.status === "pending") {
    // Asked to run again (the base moved on): it keeps the base until that run is through.
    if (merge?.reintegrating) return { kind: "active", key: since };
    // Every other step closed and its run going (or held there): waiting for its turn.
    if (!q.steps.every((s) => s === integ || stepClosed(q, s))) return undefined;
    return runOnTrack(q.run) ? { kind: "line", key: readyAt(q, integ) } : undefined;
  }
  if (integ.status !== "done") return undefined;
  // Integrated, not merged back yet: it waits for its fast-forward (holding the base), waits on something the user
  // should know of (out of the train until that is over), or queued up behind the others again.
  if (merge?.queued) return { kind: "line", key: merge.queued.since };
  if (merge?.waiting) return undefined;
  if (!project.defaults.provisional_counts && q.steps.some(pendingProvisional)) return undefined;
  return { kind: "active", key: since };
}

/** The trains of a project's queues, by base; none while the project's merge_back is off (the user merges back). */
export function trainsOf(project: TrainProject, queues: readonly TrainQueue[]): Map<string, Train> {
  const out = new Map<string, Train>();
  if (!project.defaults.merge_back) return out;
  const found = new Map<string, { active: [string, string][]; line: [string, string][] }>();
  for (const q of queues) {
    const s = trainState(project, q);
    if (!s) continue;
    const base = trainBase(q);
    const t = found.get(base) ?? { active: [], line: [] };
    t[s.kind].push([s.key, q.id]);
    found.set(base, t);
  }
  const order = (xs: [string, string][]) => xs.sort((a, b) => a[0].localeCompare(b[0]) || compareIds(a[1], b[1])).map((x) => x[1]);
  for (const [base, t] of found) out.set(base, { base, active: order(t.active), line: order(t.line) });
  return out;
}

/** The queue may start its integration step now: no other queue holds its base, and it is first in line. */
export function mayIntegrate(train: Train | undefined, queue: string): boolean {
  if (!train) return true;
  return !train.active.some((x) => x !== queue) && (train.line[0] ?? queue) === queue;
}

/**
 * The queue may move its base now (a fast-forward, a run again of its integration step, holding the base's checkout
 * for it): it holds the base (the first of those that do), or nobody does and it is first in line (or the line is
 * empty: a queue back from a wait).
 */
export function mayMergeBack(train: Train | undefined, queue: string): boolean {
  if (!train) return true;
  if (train.active.includes(queue)) return train.active[0] === queue;
  return !train.active.length && (train.line[0] ?? queue) === queue;
}

/** The queue's place in the line of its base's train; undefined when it is not waiting there. */
export function trainPlace(trains: ReadonlyMap<string, Train>, q: Pick<QueueView, "id" | "git">): TrainPlace | undefined {
  const train = trains.get(trainBase(q));
  const i = train ? train.line.indexOf(q.id) : -1;
  if (!train || i < 0) return undefined;
  const after = i > 0 ? train.line[i - 1] : train.active[0];
  return { base: train.base, position: i + 1, ...(after ? { after } : {}) };
}

/** "waits to integrate after A (one queue at a time merges back into main)". */
export function trainText(place: TrainPlace): string {
  const into = place.base || "its base";
  return place.after ? `waits to integrate after ${place.after} (one queue at a time merges back into ${into})` : `integrates next into ${into}`;
}
