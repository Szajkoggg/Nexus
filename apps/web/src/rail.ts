// The right rail of a desktop (UX proposals, 11A): what runs in the project and what finished in it today, with the
// honest status of each queue (queueStatus.ts). What waits (all projects) comes from mergeAttention. Pure and unit
// tested; components/Rail.tsx draws it.
import { queueStatus, type HonestStatus, type QueueLike as StatusLike, type Tone } from "./queueStatus.ts";
import { splitFinished, type FinishedRow, type QueueLike as FinishLike } from "./finished.ts";

type Q = StatusLike & FinishLike & { id: string };

/** The order of the queues at work: what runs first, then what waits on someone, what is paused, what is planned. */
const ORDER: Partial<Record<Tone, number>> = { running: 0, waiting: 1, review: 2, paused: 3, planned: 4, approval: 4 };

/**
 * The queues at work in a project: running, waiting (for an answer, a retry, the usage window), in review, paused,
 * or with a planned start (a chain or a schedule), also one whose new revision waits for approval first (it says so).
 * A stopped or failed queue and one that needs approval with no plan are not here: they wait for the user, in the
 * rail's first section. Approved queues without a start are not at work yet.
 */
export function atWork<T extends Q>(queues: readonly T[], now = new Date()): { queue: T; status: HonestStatus }[] {
  return queues
    .map((queue) => ({ queue, status: queueStatus(queue, now) }))
    .filter(({ queue, status }) => status.tone === "planned" || status.tone === "approval" ? !!queue.start && !queue.start.failed : ORDER[status.tone] !== undefined)
    .sort((a, b) => ORDER[a.status.tone]! - ORDER[b.status.tone]!);
}

/** The status in a few words, for the end of a rail line: "1/3" while it runs, "review", "after SF", "paused"… */
export function shortStatus(s: HonestStatus): string {
  switch (s.tone) {
    case "running": return s.label.startsWith("pausing") ? "pausing" : `${s.closed}/${s.total}`;
    case "review": return s.label.startsWith("the orchestrator reviews") ? "orchestrator reviews" : "review";
    case "planned": return s.label.replace(/^starts /, "");
    case "approval": return s.label.replace(/ \(revision \d+\)/, "").replace(" · then starts ", " · then ");
    case "waiting": return s.label.startsWith("waiting for an answer") ? "question" : s.label.includes("usage") ? "usage window" : "retry";
    default: return s.label;
  }
}

/** The queues that finished today (the local day of `now`), most recent first; one that still waits for the user is not finished. */
export function finishedToday<T extends Q>(queues: readonly T[], waiting: ReadonlySet<string>, now = new Date()): FinishedRow<T>[] {
  const today = now.toDateString();
  return splitFinished(queues, waiting).finished.filter((r) => !!r.finished_at && new Date(r.finished_at).toDateString() === today);
}
