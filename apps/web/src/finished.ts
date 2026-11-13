// Finished queues fold into one group at the bottom of the project page. Which queues go there, in which order, and
// what each compact line says, as a pure helper (unit tested); the dashboard draws the group.

/** "Finished" is the queue status done or cancelled. */
export const FINISHED_STATUSES: readonly string[] = ["done", "cancelled"];

/** What the helper reads of a queue (a QueueView has all of it). */
export interface QueueLike {
  id: string;
  status: string;
  steps: { status: string; started_at?: string; finished_at?: string }[];
  questions?: { state: string }[];
  run?: { started_at: string; ended_at?: string };
  updated?: string;
}

export interface FinishedRow<Q> { queue: Q; finished_at?: string; ran_ms?: number }

/** Something in the queue still waits for the user: a step in review, an open or escalated question. */
export function waitsForUser(q: QueueLike): boolean {
  return q.steps.some((s) => s.status === "review") || (q.questions ?? []).some((x) => x.state === "open" || x.state === "escalated");
}

const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN);

/**
 * When a finished queue finished: its last step's outcome, else the end of its run, else its latest event; and how
 * long it ran: from its first step's start (or its run's) to then.
 */
export function finishOf(q: QueueLike): { finished_at?: string; ran_ms?: number } {
  const ends = q.steps.map((s) => s.finished_at).filter((x): x is string => !!x);
  const finished_at = ends.sort().at(-1) ?? q.run?.ended_at ?? q.updated;
  const starts = [...q.steps.map((s) => s.started_at), q.run?.started_at].filter((x): x is string => !!x).sort();
  const ran = finished_at && starts[0] ? ms(finished_at) - ms(starts[0]) : NaN;
  return { finished_at, ran_ms: Number.isFinite(ran) && ran >= 0 ? ran : undefined };
}

/**
 * Splits the queues: `active` keeps their order; `finished` holds the done and cancelled queues that wait for nothing,
 * most recently finished first, those without a finish time last (in their original order).
 * `waiting` names further queues that wait for the user (the project's attention list).
 */
export function splitFinished<Q extends QueueLike>(queues: readonly Q[], waiting: ReadonlySet<string> = new Set()): { active: Q[]; finished: FinishedRow<Q>[] } {
  const active: Q[] = [];
  const finished: FinishedRow<Q>[] = [];
  for (const q of queues) {
    if (FINISHED_STATUSES.includes(q.status) && !waitsForUser(q) && !waiting.has(q.id)) finished.push({ queue: q, ...finishOf(q) });
    else active.push(q);
  }
  finished.sort((a, b) => {
    if (!a.finished_at || !b.finished_at) return a.finished_at ? -1 : b.finished_at ? 1 : 0;
    return ms(b.finished_at) - ms(a.finished_at);
  });
  return { active, finished };
}
