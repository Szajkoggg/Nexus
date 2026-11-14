// One honest status per queue (UX survey Q3, proposals' quick fix 3): what a glance at a queue should say, from its
// steps, its questions and its run together, so that "running" shows only while a run really runs, apart from
// waiting, and a queue whose steps say running while nothing runs reads as paused. Pure and unit tested; QueueRow
// shows it as a dot and a word, and the later layouts (the desktop rail, the digest) use it too.
import { HOLDING_RUN_STATES } from "@nexus/protocol/times";
import { formatClock, t, type Key, type Params } from "./i18n.ts";

export type Tone = "running" | "waiting" | "review" | "stopped" | "failed" | "approval" | "paused" | "planned" | "done" | "cancelled";

export interface HonestStatus {
  tone: Tone;
  /** "running · SF3", "stopped at W4c", "waiting for your review · UX2", "needs your approval"… in the interface language. */
  label: string;
  /**
   * What the label says apart from its language: its key in the catalogue and the key's parameters, for shorter forms
   * of the same status (rail.ts shortStatus). Absent for a status word the dashboard does not know (shown as it is).
   */
  says?: { key: Key; params?: Params };
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
  /** `held`: it came due but waits for its checkout or for a place under the limit on queues running at once. */
  start?: { at?: string; after?: string; failed?: unknown; held?: { kind: "checkout" | "limit" } };
  /** The latest approval pins the current revision; absent: taken as approved (older callers). */
  approved?: boolean;
  revision?: number;
}

/** A planned start: "starts after HS", "starts at 14:00", "planned". */
function startOf(start: NonNullable<QueueLike["start"]>, now: Date): { key: Key; params?: Params } {
  if (start.after) return { key: "status.startsAfter", params: { queue: start.after } };
  if (start.at) return { key: "status.startsAt", params: { time: formatClock(start.at, now) } };
  return { key: "status.planned" };
}

export function queueStatus(q: QueueLike, now = new Date()): HonestStatus {
  const questions = q.questions.filter((x) => x.state === "open" || x.state === "escalated");
  const base = {
    questions: questions.length,
    closed: q.steps.filter((s) => s.status === "done" || s.status === "skipped").length,
    inReview: q.steps.filter((s) => s.status === "review").length,
    total: q.steps.length,
  };
  /** A status in its words; the step it is about follows them ("running · SF3") unless the words name it (`named`). */
  const is = (tone: Tone, key: Key, params?: Params, step?: string, named = false): HonestStatus => {
    const words = t(key, params);
    return {
      tone, label: step && !named ? t("status.withStep", { label: words, step }) : words,
      says: params ? { key, params } : { key }, ...(step ? { step } : {}), ...base,
    };
  };
  const run = q.run && HOLDING_RUN_STATES.includes(q.run.state) ? q.run : undefined;
  const revision = q.revision ?? 1;

  if (q.status === "cancelled") return is("cancelled", "status.cancelled");
  // A revision waiting for approval comes first: nothing of the queue runs, and no planned start fires, until it is
  // approved ("needs approval (revision 3) · then starts after HS"). A first revision with no plan keeps the plain words.
  // A run that ended a step and waits for that approval says so ("waits for approval of revision 3 · after SF2").
  if (q.approved === false && run?.state === "approval_wait") {
    return run.step ? is("approval", "status.approvalWaitAfter", { revision, step: run.step }) : is("approval", "status.approvalWait", { revision });
  }
  if (q.approved === false && q.status !== "done" && q.status !== "draft" && (revision > 1 || q.start || q.status !== "proposed")) {
    if (q.start && !q.start.failed) {
      const st = startOf(q.start, now);
      return is("approval", "status.needsApprovalThen", { revision, start: t(st.key, st.params), startKind: st.key, ...st.params });
    }
    return is("approval", "status.needsApprovalRevision", { revision });
  }
  if (q.status === "stopped") {
    // Where the stop is, while that step holds it; a stop whose step was skipped since is the queue's.
    const s = q.stop_step ? q.steps.find((x) => x.id === q.stop_step) : undefined;
    const held = s && s.status !== "skipped" && s.status !== "done";
    return held ? is("stopped", "status.stoppedAt", { step: s.id }, s.id, true) : is("stopped", "status.stopped");
  }
  const failed = q.steps.find((s) => s.status === "failed");
  if (failed && !run) return is("failed", "status.failedAt", { step: failed.id }, failed.id, true);
  const mine = q.steps.filter((s) => s.status === "review" && s.review_with !== "orchestrator");
  if (mine.length === 1) return is("review", "status.yourReview", undefined, mine[0]!.id);
  if (mine.length > 1) return is("review", "status.yourReviews", { count: mine.length }, mine[0]!.id, true);
  const blocking = questions.find((x) => !x.can_continue);
  if (blocking) return is("waiting", "status.waitingAnswer", undefined, blocking.step);
  const theirs = q.steps.find((s) => s.status === "review");
  if (theirs) return is("review", "status.orchestratorReviews", undefined, theirs.id);
  if (run) {
    switch (run.state) {
      case "running": return is("running", "status.running", undefined, run.step);
      case "pausing": return run.step ? is("running", "status.pausingAfter", { step: run.step }, run.step, true) : is("running", "status.pausingThisStep");
      case "retry_wait": return is("waiting", "status.retry", undefined, run.step);
      case "usage_wait": return is("waiting", "status.usage", undefined, run.step);
    }
  }
  if (q.status === "done") return is("done", "status.done");
  // A planned start that has not come, or could not start.
  if (q.start) {
    if (q.start.failed) return is("failed", "status.didNotStart");
    // Came due, but another queue works in its checkout, or as many run as the limit allows: it starts by itself.
    if (q.start.held) return is("planned", q.start.held.kind === "checkout" ? "status.heldCheckout" : "status.heldLimit");
    const st = startOf(q.start, now);
    return is("planned", st.key, st.params);
  }
  // The steps say a run is at work, but none runs: honest about it.
  if (q.status === "running" || q.status === "waiting" || q.status === "paused") return is("paused", "status.paused", undefined, q.current_step ?? q.run?.step);
  if (q.status === "proposed") return is("approval", "status.needsYourApproval");
  if (q.status === "approved") return is("planned", "status.approved");
  return { tone: "planned", label: q.status, ...base };
}
