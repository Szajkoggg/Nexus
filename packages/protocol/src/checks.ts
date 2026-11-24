// The checks Nexus runs after a worker's `nexus step done` (docs/protocol/checks.md, "Checks run by Nexus"; queue EC), as the
// derivation reads them: the engine writes queues/<id>/checks.yaml (one writer), and a step's status follows it. A
// step.done whose checks have not passed is no review yet: `checking` while they wait for the machine or run; a fix
// round (`running`, its `check_fix`) when they failed twice; `waiting` while the orchestrator decides a disputed failure
// that could not be run on the base. Pure, free of Node: the dashboard reads the same rules.
import type { CheckRun, CheckSet, ChecksFile, Event } from "./schemas.ts";
import type { QueueView, StepView } from "./state.ts";
import { CHECK_UNIT, checkMetric } from "./metrics.ts";

type StepDone = Extract<Event, { type: "step.done" }>;

/** The set of checks Nexus ran for one step.done of a step. */
export function checkSetOf(file: ChecksFile | undefined, step: string, done: string): CheckSet | undefined {
  return file?.steps[step]?.sets.find((s) => s.done === done);
}

/** Whether a step.done of the step reached its review: no failed checks of Nexus's after it (a fix round's done). */
function reachedReview(file: ChecksFile | undefined, step: string, done: string): boolean {
  const set = checkSetOf(file, step, done);
  return !set || set.state === "passed" || set.state === "accepted"
    || (set.state === "failed" && set.dispute?.outcome === "accepted");
}

/**
 * The step's review rounds so far: its step.dones that reached review (a check-fix round's do not count), leaving out
 * `except` (a step.done whose checks are still to run).
 */
export function reviewRound(q: Pick<QueueView, "check_runs">, st: Pick<StepView, "id" | "timeline">, except?: string): number {
  return st.timeline.filter((e) => e.type === "step.done" && e.id !== except && reachedReview(q.check_runs, st.id, e.id)).length;
}

/** One check's outcome in a few words: "passed", "passed on the second run (flaky)", "exit code 1; 2 tests failed". */
function checkRunSummary(c: CheckRun): string {
  const last = c.runs.at(-1);
  if (c.ok) return c.flaky ? "failed, then passed on the second run (flaky)" : c.snapshot_rerun ? "passed (rerun after a disk snapshot)" : "passed";
  if (c.missing_script) return "missing script";
  if (!last) return "not run";
  const why = last.timed_out ? "ended at its time limit" : last.exit_code === null || last.exit_code === undefined ? "ended" : `exit code ${last.exit_code}`;
  const tests = last.failed_tests?.length ? `; ${last.failed_tests.length} test${last.failed_tests.length === 1 ? "" : "s"} failed` : "";
  return `${why}${tests}${c.runs.length > 1 ? ", twice" : ""}`;
}

/** The latest step.done event of a step. */
export function lastDone(st: Pick<StepView, "timeline">): StepDone | undefined {
  return st.timeline.findLast((e): e is StepDone => e.type === "step.done");
}

/**
 * The latest step.done, when the step runs now for its check-fix round: the worker took it up (`nexus step start`
 * while the done waited for its review, so with no verdict between: state.ts, fix_round_of), and Nexus's set for that
 * done failed or was accepted. Not a step started again after a send-back, a rejection or an acceptance (queue NL).
 */
function takenUpDone(q: Pick<QueueView, "check_runs">, st: Pick<StepView, "id" | "status" | "timeline" | "fix_round_of">): { done: StepDone; set: CheckSet } | undefined {
  if (st.status !== "running" || q.check_runs?.steps[st.id]?.by !== "nexus") return undefined;
  const done = lastDone(st);
  if (!done || st.fix_round_of !== done.id) return undefined;
  const set = checkSetOf(q.check_runs, st.id, done.id);
  return set?.state === "failed" || set?.state === "accepted" ? { done, set } : undefined;
}

/**
 * A review verdict at `at` on a step whose check-fix round the worker took up and whose failure Nexus accepted before
 * it: the step waits for its review since, as of its done, so the verdict is weighed against that review. The events
 * are replayed with the step running for that round; without this, the helper's pass-on, the orchestrator's and the
 * user's acceptances and every other verdict were dropped until applyCheckSets set the review after the replay
 * (queue NL: ND/ND1, 2026-11-19).
 */
export function enterAcceptedReview(q: QueueView, st: StepView, at: string): void {
  const taken = takenUpDone(q, st);
  if (!taken || !reachedReview(q.check_runs, st.id, taken.done.id)) return;
  if (taken.set.ended_at && at < taken.set.ended_at) return; // before Nexus accepted the failure
  toReviewAsOf(q, st, taken.done);
}

/**
 * A review verdict at `at` that does not count: the step's latest done has a set of Nexus's checks that never let it
 * into its review (queued, running, interrupted, or failed and not accepted), or one whose failure Nexus accepted only
 * after `at`. The replay has the step in its review from its step.done; without this a verdict written in such a
 * moment (from a stale view: the derived state had the step checking or in its check-fix round) was taken as the
 * review of work whose checks failed (queue LH: NL's reverse window, a set that failed before its round was taken up).
 */
export function verdictBeforeReview(q: Pick<QueueView, "check_runs">, st: Pick<StepView, "id" | "timeline">, at: string): boolean {
  if (q.check_runs?.steps[st.id]?.by !== "nexus") return false;
  const done = lastDone(st);
  if (!done) return false;
  const set = checkSetOf(q.check_runs, st.id, done.id);
  if (!set) return false; // its checks not asked for yet: nothing known against it (older records)
  if (!reachedReview(q.check_runs, st.id, done.id)) return true;
  return set.state === "failed" && !!set.ended_at && at < set.ended_at;
}

/** A taken-up check-fix round's step back in its review, as of the done (the step.started kept its review_with). */
function toReviewAsOf(q: QueueView, st: StepView, done: StepDone): void {
  st.status = "review"; st.finished_at = done.at;
  if (q.status === "running") q.status = "waiting";
}

/**
 * The queue's checks.yaml cannot be read (queue LF, F6): whether a step's latest done passed its checks is unknown, so a
 * step its events put in review is held as `checking`, as its checks had not run, rather than reviewed as if they had
 * passed. The state warns of the file, and the engine halts the run with the reason.
 */
function holdUnread(q: QueueView, st: StepView): void {
  const done = lastDone(st);
  if (st.status !== "review" || !done) return;
  st.checking = { phase: "queued", since: done.at };
  st.status = "checking";
  st.review_with = undefined;
  if (q.status === "waiting") q.status = "running";
}

/** The set of checks Nexus ran (or runs) for the step's latest step.done, if any. */
export function latestCheckSet(q: Pick<QueueView, "check_runs">, st: Pick<StepView, "id" | "timeline">): CheckSet | undefined {
  const done = lastDone(st);
  return done && checkSetOf(q.check_runs, st.id, done.id);
}

/**
 * The integration step ran without a model (queue MI, M6): its checks all passed and its review level is 2 or 3, so
 * Nexus accepts it itself, and nobody is asked to review it. Not at level 1 (the user's), not when the review was handed
 * to the user, and not without any check (the merge is untested then).
 */
export function acceptedByNexus(q: Pick<QueueView, "check_runs">, st: Pick<StepView, "id" | "timeline" | "model_free" | "status" | "level" | "asked_user">): boolean {
  if (!st.model_free || st.status !== "review" || st.level === 1 || st.asked_user) return false;
  const set = latestCheckSet(q, st);
  return set?.state === "passed" && set.checks.length > 0;
}

/**
 * Reads the engine's checks of the step into the derived step (after its events): their results among the step's
 * checks and metrics, and its status where the latest step.done's checks have not passed. `limit`: the project's
 * `defaults.check_fix_limit`, given to a step in a check-fix round.
 */
export function applyCheckSets(q: QueueView, st: StepView, limit?: number): void {
  if (q.check_runs_error !== undefined) return holdUnread(q, st);
  const entry = q.check_runs?.steps[st.id];
  if (!entry) return;
  st.checks_by = entry.by;
  for (const set of entry.sets) for (const c of set.checks) {
    // Not a command (not on the server's PATH, or an older queue's check in words): not run, and failed (queue CK).
    if (c.not_command) { st.checks.push({ name: c.name, ok: false, not_command: true, summary: "not on the server's PATH: not run", at: set.ended_at ?? set.requested_at, by: "nexus" }); continue; }
    const last = c.runs.at(-1);
    if (!last?.ended_at || last.interrupted || c.ok === undefined) continue;
    st.checks.push({ name: c.name, ok: c.ok, summary: checkRunSummary(c), duration: last.duration, at: last.ended_at, by: "nexus", ...(c.flaky ? { flaky: true } : {}) });
    if (last.duration !== undefined) st.metrics.push({ name: checkMetric(c.name), value: last.duration, unit: CHECK_UNIT, at: last.ended_at, event: `check:${set.done}:${c.name}`, session: st.session ?? "nexus", commit: set.commit ?? undefined });
  }
  st.checks.sort((a, b) => a.at.localeCompare(b.at));
  if (entry.by !== "nexus") return;
  const done = lastDone(st);
  if (!done) return;
  const set = checkSetOf(q.check_runs, st.id, done.id);
  // The worker took up its check-fix round (`nexus step start` after the failed set's done): the step runs in that
  // round, a dispute it says there is read as from the round's start, and an accepted one sends it to its review after
  // all (as of the done: the step.started kept the done's review_with).
  const takenUp = !!takenUpDone(q, st);
  if (st.status !== "review" && !takenUp) return;
  const toReview = () => { if (takenUp) toReviewAsOf(q, st, done); };
  const reopen = (status: "checking" | "running" | "waiting") => {
    st.status = status;
    st.review_with = undefined;
    if (status === "running") st.finished_at = undefined;
    if (q.status === "waiting") q.status = "running"; // waiting for nothing but these checks (stepWaits looks again)
  };
  if (!set || set.state === "queued" || set.state === "running" || set.state === "interrupted") {
    const running = set?.state === "running" ? set.checks.find((c) => c.runs.at(-1) && !c.runs.at(-1)!.ended_at) : undefined;
    st.checking = {
      phase: set?.state === "running" ? "running" : "queued", since: (set?.state === "running" ? set.granted_at : undefined) ?? set?.requested_at ?? done.at,
      ...(running ? { check: running.name } : {}), ...(set?.state === "interrupted" && set.unrunnable ? { unrunnable: set.unrunnable } : {}),
    };
    return reopen("checking");
  }
  if (set.state !== "failed") return toReview(); // passed or accepted: its review
  st.check_fix = set.fix + 1;
  if (limit !== undefined) st.check_fix_limit = limit;
  if (set.limit) st.check_limit = true;
  const d = set.dispute;
  if (d?.outcome === "accepted") return toReview();
  const disputed = st.timeline.findLast((e) => e.type === "check.disputed" && e.at >= done.at);
  if (d && !d.outcome) {
    if (d.base?.state === "unrunnable") { st.checking = { phase: "decision", since: d.at }; return reopen("waiting"); }
    st.checking = { phase: "base", since: d.at, check: d.name };
    return reopen("checking");
  }
  if (!d && disputed) {
    // The worker's word, not yet taken up by the engine: the base run comes next.
    st.checking = { phase: "base", since: disputed.at };
    return reopen("checking");
  }
  reopen("running");
}
