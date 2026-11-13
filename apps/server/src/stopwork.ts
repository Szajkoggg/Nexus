// The work a stopped step left: the user decides about it where the stop is lifted (Continue, or approving a new
// revision of the stopped queue). Keep: the commits stay (and go out with the next accepted commit under
// push-after-acceptance); recorded, then the stop is lifted as before. Discard: recorded, the stop stays, and the
// orchestrator is told (src/orchestrator.ts) to draft a revision whose first pending step reverts the step's own
// commits; approving a revision then lifts the stop without asking again. With no commits of the step's own nothing
// is asked. Uncommitted changes in the checkout are shown, labelled as not necessarily the step's, and never cleaned.
import { ActionError, loadProjectState, now, type ProjectStore, type QueueView, type StatusChange } from "@nexus/protocol";
import { leftBehind } from "./gitinfo.ts";

export type WorkChoice = "keep" | "discard";

/** When the queue's stop came: the stopped step's latest queue.stop (an imported stop has none). */
function stopAt(q: QueueView): string | undefined {
  return q.steps.find((s) => s.id === q.stop_step)?.timeline.findLast((e) => e.type === "queue.stop")?.at;
}

/** A Discard recorded for the queue's present stop. */
export function discardRecorded(q: QueueView): StatusChange | undefined {
  const since = stopAt(q) ?? "";
  return q.changes.findLast((c) => c.kind === "work" && c.to === "discarded" && c.step === q.stop_step && c.at >= since);
}

/**
 * Before a lift (Continue, or the approval of a stopped queue): checks and records the user's choice about the stopped
 * step's work. Returns whether the lift goes ahead; Discard stops it (with what to tell the user).
 */
export function decideStoppedWork(store: ProjectStore, queueId: string, choice: unknown, by: "user_continue" | "user_approval"): { proceed: true } | { proceed: false; message: string } {
  if (choice !== undefined && choice !== null && choice !== "keep" && choice !== "discard") throw new ActionError("work is keep or discard");
  const q = loadProjectState(store).queues.find((x) => x.id === queueId);
  if (!q || q.status !== "stopped") return { proceed: true };
  // What the lift itself would refuse is refused first, so no choice is recorded for a lift that does not happen.
  const going = q.run && ["running", "pausing"].includes(q.run.state);
  if (going) throw new ActionError(`queue ${queueId}'s run is still going; stop it first`, 409);
  if (by === "user_continue" && !q.approved) throw new ActionError(`revision ${q.revision} of queue ${queueId} is not approved: approve it instead, which lifts the stop`, 409);
  if (by === "user_approval" && q.approved) throw new ActionError("this revision is already approved", 409);
  // Once Discard is recorded, approving a revision (the orchestrator's revert) lifts without asking again.
  if (by === "user_approval" && discardRecorded(q)) return { proceed: true };
  const left = leftBehind(store, q);
  if (!left || !left.commits.length) return { proceed: true }; // nothing of the step's own: nothing to decide
  if (!choice) {
    throw new ActionError(`step ${left.step} left ${left.commits.length} commit${left.commits.length === 1 ? "" : "s"} of its own: choose Keep or Discard (work: keep | discard)`, 409);
  }
  const file = store.readQueue(queueId);
  const change: StatusChange = {
    at: now(), kind: "work", by, step: left.step, from: "stopped", to: choice === "keep" ? "kept" : "discarded",
    commits: left.commits.map((c) => c.sha), revision: file.revision,
  };
  store.writeQueue({ ...file, changes: [...file.changes, change], updated_at: change.at });
  if (choice === "keep") return { proceed: true };
  return { proceed: false, message: `the work of step ${left.step} is to be discarded: the stop stays; the orchestrator drafts a revision that reverts its ${left.commits.length} commit${left.commits.length === 1 ? "" : "s"}, and approving it lifts the stop` };
}
