// A closed queue that waits for nothing comes in the project's state as its summary (`archived`: the steps' timelines,
// messages, checks and texts left out; packages/protocol/src/archive.ts). Opening it reads its whole view from
// GET /api/projects/:id/queues/:queue; until that lands the item is not shown (queue AQ).
import type { QueueView } from "@nexus/protocol";

/** The URL of the queue's whole view, when the state holds it as a summary; undefined otherwise (nothing to read). */
export const detailsPath = (listed: Pick<QueueView, "id" | "archived"> | undefined): string | undefined =>
  listed?.archived ? `/queues/${encodeURIComponent(listed.id)}` : undefined;

/** The queue as its views show it: the state's own, or for a summary its whole view once read (of the same queue). */
export function openedQueue(listed: QueueView | undefined, details: QueueView | undefined): QueueView | undefined {
  if (!listed?.archived) return listed;
  return details?.id === listed.id ? details : undefined;
}
