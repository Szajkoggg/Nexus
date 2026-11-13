// The run's state transitions and the guards of starting and resuming a queue (DESIGN.md, "The run's state
// transitions"). Every write of run.yaml that sets a state goes through one of the transitions here: each returns the
// next run record and owns which fields it sets and clears. They are pure; the engine writes the result (adding
// ended_at and updated_at) and keeps the side effects (timers, processes, messages to the agent).
import { ActionError, runIsOlder, stopPlace, type Effort, type QueueView, type RunFile } from "@nexus/protocol";

/** States in which a run still goes on by itself. */
export const GOING: readonly string[] = ["running", "pausing", "usage_wait", "retry_wait"];

// ---------------------------------------------------------------- transitions

/** A new run record, running from `at` (it replaces the earlier one). */
export function startedRun(o: {
  session: string; revision: number; runtime: "claude" | "codex"; model?: string; effort?: Effort; after?: string; at: string;
}): RunFile {
  return {
    protocol: 1, session: o.session, state: "running", started_at: o.at, updated_at: o.at, revision: o.revision,
    runtime: o.runtime, model: o.model, effort: o.effort, after: o.after,
  };
}

/**
 * Going on after a pause, halt or wait (the user's resume, a retry or usage wait that came due, the restart after an
 * update): no reason, no wait, not nudged. A run paused by a rejection takes the approved `revision` and is no longer
 * rejected.
 */
export function toResumed(run: RunFile, revision: number): RunFile {
  return {
    ...run, state: "running", reason: undefined, nudged: false, resume_after_restart: undefined, resume_at: undefined,
    ...(run.rejected ? { rejected: undefined, revision } : {}),
  };
}

/** An update that was cancelled: a run held at the end of its step (pausing) goes on as it was. */
export function toUnheld(run: RunFile): RunFile {
  return { ...run, state: "running", reason: undefined, resume_after_restart: undefined };
}

/**
 * The user stops the run (Pause, Stop now, a rejected step): pausing while a turn is at work, else paused. A pending
 * retry or usage wait is dropped, and so is a hold for an update (the user's pause wins over the restart's resume).
 */
export function toPausedByUser(run: RunFile, reason: string, o: { pausing?: boolean; rejected?: string } = {}): RunFile {
  return {
    ...run, state: o.pausing ? "pausing" : "paused", reason, resume_after_restart: undefined, resume_at: undefined,
    ...(o.rejected ? { rejected: o.rejected } : {}),
  };
}

/** Held for an update of Nexus (pausing while a turn is at work, else paused): the next server resumes it by itself. */
export function toHeldForUpdate(run: RunFile, reason: string, o: { pausing?: boolean } = {}): RunFile {
  return { ...run, state: o.pausing ? "pausing" : "paused", reason, resume_after_restart: true };
}

/**
 * Paused, everything else kept: a pausing run whose step ended (its reason and hold for an update stay), a pausing
 * run whose turn failed, a run a server restart caught (with their own reason).
 */
export function toPaused(run: RunFile, reason?: string): RunFile {
  return { ...run, state: "paused", ...(reason !== undefined ? { reason } : {}) };
}

/** Halted: needs the user. No wait and no hold for an update; `failure` names the runtime's failure that halted it. */
export function toHalted(run: RunFile, reason: string, failure?: string): RunFile {
  return { ...run, state: "halted", reason, resume_after_restart: undefined, resume_at: undefined, ...(failure !== undefined ? { failure } : {}) };
}

/** Finished: no step left. Nothing of a pause, wait, retry or failure is kept (nothing reads them on a finished run). */
export function toFinished(run: RunFile): RunFile {
  return { ...run, state: "finished", reason: undefined, retries: undefined, failure: undefined, resume_at: undefined, resume_after_restart: undefined };
}

/** Waiting for the usage window to reset at `until`; it goes on by itself, so no hold for an update. */
export function toUsageWait(run: RunFile, reason: string, until: string): RunFile {
  return { ...run, state: "usage_wait", reason, resume_at: until, resume_after_restart: undefined };
}

/** A turn failed for a passing reason: tried again at `at`, the `tries`-th time in a row (a hold for an update stays). */
export function toRetryWait(run: RunFile, o: { tries: number; failure: string; reason: string; at: string }): RunFile {
  return { ...run, state: "retry_wait", retries: o.tries, failure: o.failure, reason: o.reason, resume_at: o.at };
}

// ---------------------------------------------------------------- guards

/** Why a queue with a rejected step does not go on, and what lets it. */
export function rejectedMessage(q: QueueView): string {
  return `step ${q.rejection!.step} of queue ${q.id} was rejected: the run goes on once you approve a new revision of the queue that deals with it (the orchestrator proposes one)`;
}

/** Why a stopped queue does not go on: where the stop is and its own reason, and the user's two ways out. */
export function stoppedMessage(q: QueueView): string {
  return `queue ${q.id} is stopped${stopPlace(q)}: ${q.status_reason ?? "a stop condition was met"}. Only the user lifts a stop: with Continue in the dashboard, or by approving a new revision of the queue`;
}

/** What both a start and a resume need first: no rejected step, the current revision approved. */
function assertApprovedAndNotRejected(q: QueueView): void {
  if (q.rejection) throw new ActionError(rejectedMessage(q), 409);
  if (!q.approved) throw new ActionError("approve the queue's current revision first", 409);
}

/** A queue may start a new run: approved, not rejected, not going already, not stopped, done or cancelled. */
export function assertCanStart(q: QueueView): void {
  assertApprovedAndNotRejected(q);
  if (q.run && GOING.includes(q.run.state)) throw new ActionError("the queue is already running", 409);
  if (q.status === "stopped") throw new ActionError(stoppedMessage(q), 409);
  if (q.status === "done" || q.status === "cancelled") throw new ActionError(`the queue is ${q.status}`, 409);
}

/**
 * A queue's run may be resumed: approved, not rejected, not stopped or cancelled, and the run of this revision. A run
 * of an older revision would reopen a step the new revision may have replaced, in the old session; a run paused by a
 * rejection is the exception (the approved revision dealt with it, and the run goes on at its first pending step).
 */
export function assertCanResume(q: QueueView, run: RunFile): void {
  assertApprovedAndNotRejected(q);
  if (q.status === "stopped") throw new ActionError(stoppedMessage(q), 409);
  if (q.status === "cancelled") throw new ActionError(`queue ${q.id} is cancelled`, 409);
  if (runIsOlder(run, q.revision, q.history) && !run.rejected) {
    throw new ActionError(`the run belongs to revision ${run.revision ?? "an earlier one"} and the queue is at revision ${q.revision}: start the queue instead of resuming`, 409);
  }
}
