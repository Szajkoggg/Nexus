// Stands in for the reviewer in tests about something other than review. Every step is reviewed (PROTOCOL.md,
// "Review"): a test project without an orchestrator gets its level-2 and level-3 steps for the user's review, so a
// test that runs a queue through its steps calls this where it stands in for the server's file watcher (before the
// engine's onChange), and each such step is accepted at once, as the user would in the dashboard. A level-1 step is
// left alone: a test that wants a step held for the user gives it level 1.
import { ensureUserSession, loadProjectState, newId, now, type ProjectStore } from "@nexus/protocol";

/** Accepts, as the user, every step waiting for the user's review at level 2 or 3. Returns how many it accepted. */
export function acceptReviews(store: ProjectStore): number {
  let n = 0;
  for (const q of loadProjectState(store).queues) {
    for (const st of q.steps) {
      if (st.status !== "review" || st.review_with !== "user" || st.level === 1) continue;
      const user = ensureUserSession(store);
      // After the step's report also under a test's frozen clock (the worker's events carry the real time).
      const at = st.finished_at && st.finished_at >= now() ? new Date(Date.parse(st.finished_at) + 1).toISOString() : now();
      store.appendEvent({ v: 1, id: newId(), at, session: user.id, type: "review.accepted", queue: q.id, step: st.id });
      n++;
    }
  }
  return n;
}
