// One honest status per queue (UX survey Q3, proposals' quick fix 3): what a glance at a queue should say, from its
// steps, its questions and its run together, so that "running" shows only while a run really runs, apart from
// waiting, and a queue whose steps say running while nothing runs reads as paused. Pure and unit tested; QueueRow
// shows it as a dot and a word, and the later layouts (the desktop rail, the digest) use it too.
import { HOLDING_RUN_STATES, formatClock } from "@nexus/protocol/times";

export type Tone = "running" | "waiting" | "review" | "stopped" | "failed" | "approval" | "paused" | "planned" | "done" | "cancelled";

export interface HonestStatus {
  tone: Tone;
  /** "running · SF3", "stopped at W4c", "waiting for your review · UX2", "needs your approval"… */
  label: string;
  /** The step it is about, when there is one. */
  step?: string;
  /** Open questions (the worker's, open or passed to the user). */
  questions: number;
  /** Steps closed (done or skipped), steps in review, and all steps: "5 of 11" with "2 in review". */
  closed: number; inReview: number; total: number;
}

export interface QueueLike {
  status: string;
  steps: readonly { id: string; status: string; review_with?: "orchestrator" | "user" }[];
  questions: readonly { state: string; can_continue: boolean; step?: string }[];
  run?: { state: string; step?: string };
  stop_step?: string;
  current_step?: string;
  start?: { at?: string; after?: string; failed?: unknown };
  /** The latest approval pins the current revision; absent: taken as approved (older callers). */
  approved?: boolean;
  revision?: number;
}

/** A planned start in words: "starts after HS", "starts at 14:00". */
const startText = (start: NonNullable<QueueLike["start"]>, now: Date) =>
  start.after ? `starts after ${start.after}` : start.at ? `starts at ${formatClock(start.at, now)}` : "planned";


export function queueStatus(q: QueueLike, now = new Date()): HonestStatus {
  const questions = q.questions.filter((x) => x.state === "open" || x.state === "escalated");
  const base = {
    questions: questions.length,
    closed: q.steps.filter((s) => s.status === "done" || s.status === "skipped").length,
    inReview: q.steps.filter((s) => s.status === "review").length,
    total: q.steps.length,
  };
  const at = (tone: Tone, label: string, step?: string): HonestStatus => ({ tone, label: step ? `${label} · ${step}` : label, ...(step ? { step } : {}), ...base });
  const run = q.run && HOLDING_RUN_STATES.includes(q.run.state) ? q.run : undefined;

  if (q.status === "cancelled") return at("cancelled", "cancelled");
  // A revision waiting for approval comes first: nothing of the queue runs, and no planned start fires, until it is
  // approved ("needs approval (revision 3) · then starts after HS"). A first revision with no plan keeps the plain words.
  // A run that ended a step and waits for that approval says so ("waits for approval of revision 3 · after SF2").
  if (q.approved === false && run?.state === "approval_wait") {
    return { tone: "approval", label: `waits for approval of revision ${q.revision ?? 1}${run.step ? ` · after ${run.step}` : ""}`, ...base };
  }
  if (q.approved === false && q.status !== "done" && q.status !== "draft" && ((q.revision ?? 1) > 1 || q.start || q.status !== "proposed")) {
    const then = q.start && !q.start.failed ? ` · then ${startText(q.start, now)}` : "";
    return { tone: "approval", label: `needs approval (revision ${q.revision ?? 1})${then}`, ...base };
  }
  if (q.status === "stopped") {
    // Where the stop is, while that step holds it; a stop whose step was skipped since is the queue's.
    const s = q.stop_step ? q.steps.find((x) => x.id === q.stop_step) : undefined;
    const held = s && s.status !== "skipped" && s.status !== "done";
    return { tone: "stopped", label: held ? `stopped at ${s.id}` : "stopped", ...(held ? { step: s.id } : {}), ...base };
  }
  const failed = q.steps.find((s) => s.status === "failed");
  if (failed && !run) return { tone: "failed", label: `failed at ${failed.id}`, step: failed.id, ...base };
  const mine = q.steps.filter((s) => s.status === "review" && s.review_with !== "orchestrator");
  if (mine.length === 1) return at("review", "waiting for your review", mine[0]!.id);
  if (mine.length > 1) return { tone: "review", label: `${mine.length} steps wait for your review`, step: mine[0]!.id, ...base };
  const blocking = questions.find((x) => !x.can_continue);
  if (blocking) return at("waiting", "waiting for an answer", blocking.step);
  const theirs = q.steps.find((s) => s.status === "review");
  if (theirs) return at("review", "the orchestrator reviews", theirs.id);
  if (run) {
    switch (run.state) {
      case "running": return at("running", "running", run.step);
      case "pausing": return { tone: "running", label: `pausing after ${run.step ?? "this step"}`, ...(run.step ? { step: run.step } : {}), ...base };
      case "retry_wait": return at("waiting", "waiting to retry", run.step);
      case "usage_wait": return at("waiting", "waiting for the usage window", run.step);
    }
  }
  if (q.status === "done") return at("done", "done");
  // A planned start that has not come, or could not start.
  if (q.start) {
    if (q.start.failed) return at("failed", "did not start");
    return at("planned", startText(q.start, now));
  }
  // The steps say a run is at work, but none runs: honest about it.
  if (q.status === "running" || q.status === "waiting" || q.status === "paused") return at("paused", "paused", q.current_step ?? q.run?.step);
  if (q.status === "proposed") return at("approval", "needs your approval");
  if (q.status === "approved") return at("planned", "approved");
  return at("planned", q.status);
}
