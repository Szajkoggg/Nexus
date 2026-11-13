// Moving through what waits for the user: where an item stands in the waiting list ("2 of 6") and which comes next.
// Pure, unit tested; the phone's sheets show the place now, and the next item's button and the desktop's waiting
// rail build on the same helper later.
import type { WaitingItem } from "@nexus/protocol/attention";

/** Where an item leads in the dashboard: its project, its queue, and its step unless a stopped queue's item opens the queue. */
export interface Place { project: string; queue?: string; step?: string }

/** The place a waiting item opens (as attentionTarget does: a stopped queue's item opens the queue, whose stop box has Continue). */
export const placeOf = (w: Pick<WaitingItem, "project" | "queue" | "step" | "lift">): Place =>
  ({ project: w.project, queue: w.queue, step: w.lift ? undefined : w.step });

const same = (a: Place, b: Place) => a.project === b.project && (a.queue ?? "") === (b.queue ?? "") && (a.step ?? "") === (b.step ?? "");

export interface WaitingPosition<T> {
  /** The first item at the place, counted from 1; 0 when nothing waits there. */
  at: number;
  total: number;
  /** The next item at another place, wrapping round to the first; none when nothing else waits. */
  next?: T;
}

/**
 * Where a place stands in the waiting list (in its order, newest first) and the item to go to next. Several items at
 * one place (a question and a review on the same step) count as the first of them, and "next" skips the others. A
 * place no longer in the list (just answered) has no position, and its next item is the first that waits.
 */
export function waitingPosition<T extends Pick<WaitingItem, "project" | "queue" | "step" | "lift">>(items: readonly T[], place: Place): WaitingPosition<T> {
  const i = items.findIndex((w) => same(placeOf(w), place));
  const total = items.length;
  if (i < 0) return { at: 0, total, next: items[0] };
  for (let k = 1; k < total; k++) {
    const w = items[(i + k) % total]!;
    if (!same(placeOf(w), place)) return { at: i + 1, total, next: w };
  }
  return { at: i + 1, total };
}
