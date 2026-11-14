// The queue engine: drives an approved queue step by step through a Nexus-launched session, delivers notes,
// messages and answers to live sessions, and records what the agent does. See docs/DESIGN.md, "Nexus drives the
// queue, step by step". All of its state is in files (run.yaml, runtime.json, delivered.jsonl, activity.jsonl);
// the processes are the only thing a restart loses, and a restart pauses the runs that had one.
import { recordStepEnd, recordStepStart } from "./gitinfo.ts";
import { AcceptedPusher } from "./accepted.ts";
import type { GitRunner } from "./deploy.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  CHECKOUT_RUN_STATES, ENDED_RUN_STATES, HOLDING_RUN_STATES,
  ActionError, ProjectStore, USER_SESSION, ensureUserSession, liftByContinue, loadProjectState, releaseOrphanedSteps, stepClosed, reportFile, ensureReportFolder, newId, normPath, now, readUsage,
  RETRY_LIMIT, effortIssue, formatClock, type Effort, type ProjectFile, type StepDef, type ProjectState, type QueueView, type RunFile, type SessionFile,
  type SessionView, type StepView,
  addNote,
} from "@nexus/protocol";
import type { TurnFailure } from "./agent.ts";
import { AgentHost, ROLE_RECORDS, type AgentHostOptions, type Hosted, type Launch } from "./agent-host.ts";
import { nexusDenyRules } from "./claude.ts";
import {
  RUNTIME_NAME, WORKER_BRIEFING, carriedMessages, formatInbox, freshSessionSeed, noOutcomeNudge, stepOpening, summaryReason,
  summaryRequest, switchReason, userStopNow,
} from "./prompts.ts";
import {
  ClockTimers, REAL_CLOCK, Scheduler, type ChainOptions, type Clock, type ScheduleOptions,
} from "./scheduler.ts";
import { gitBranch, worktreeFor } from "./worktree.ts";
import { Coordinator, refusalText, type Member } from "./coordinator.ts";
import { gitWritableRoots } from "./codex.ts";
import {
  assertCanResume, assertCanStart, startedRun, stoppedMessage, toFinished, toHalted, toHeldForUpdate,
  toApprovalWait, toPaused, toPausedByUser, toResumed, toRetryWait, toRevision, toUnheld, toUsageWait,
} from "./run-state.ts";

type Live = Hosted;

export interface StartOptions {
  model?: string; effort?: Effort; session?: string; runtime?: "claude" | "codex";
  /** Started by a chain: the queue whose being done started it (recorded on the run). */
  after?: string;
}

// Moved to src/scheduler.ts; still exported here, where the tests import them.
export { MAX_TIMER_MS, type Clock } from "./scheduler.ts";

/** A turn that failed for a passing reason is tried again RETRY_LIMIT times (5), after 1, 2, 4, 8 and 16 minutes. */
export { RETRY_LIMIT };
export const RETRY_BASE_MS = 60_000;
/** A run waiting for the usage window goes on this long after the window's reset. */
export const USAGE_MARGIN_MS = 60_000;

/** A step with one of these has its outcome: its round of commits ends with the turn that gave it. */
const OUTCOME: ReadonlySet<string> = new Set(["done", "review", "failed", "stopped"]);

export interface EngineOptions {
  /** The first retry's delay; each further one doubles it. Tests make it short. */
  retryBaseMs?: number;
  usageMarginMs?: number;
  /** How the push of accepted steps runs git, and its time limit (tests). */
  git?: GitRunner;
  pushTimeoutMs?: number;
  /** The clock of the long timers (schedules, usage waits, retries); tests control it. */
  clock?: Clock;
  /** Makes the workers' processes; tests give a stand-in (AgentHostOptions.spawn). */
  spawn?: AgentHostOptions["spawn"];
  /**
   * The server's coordinator over all projects' engines (the checkout rule and the limit on queues running at once);
   * without one, the engine has one of its own, with the limit of <NEXUS_HOME>/limits.json.
   */
  coordinator?: Coordinator;
}

/** A process asked to end for a restart (another model or effort) is killed if it has not exited by then. */
export const RESTART_KILL_MS = 10_000;

/** The runtime, model and effort a step runs on. */
export interface StepValues { runtime: "claude" | "codex"; model?: string; effort?: Effort }

/**
 * What a step runs on: its own values, else the run's. A step on another runtime than the run's takes a value it does
 * not name from the project's defaults for that runtime (the run's model and effort belong to the run's runtime).
 */
export function stepValues(run: StepValues, step: Pick<StepDef, "runtime" | "model" | "effort">, project: ProjectFile): StepValues {
  const runtime = step.runtime ?? run.runtime;
  const same = runtime === run.runtime;
  const d = project.runtimes[runtime];
  return { runtime, model: step.model ?? (same ? run.model : d.model), effort: step.effort ?? (same ? run.effort : d.effort) };
}

export class Engine implements Member {
  /** The workers' processes, by Nexus session id. */
  private readonly host: AgentHost;
  readonly store: ProjectStore;
  /** Over all projects' engines: one queue per checkout, and the limit on queues running at once. */
  private readonly coordinator: Coordinator;
  private readonly changed: () => void;
  private timers = new Map<string, NodeJS.Timeout>();
  /** The long timers (by queue for a retry or usage wait, `start:<queue>` for a schedule), on `clock`. */
  private readonly clockTimers: ClockTimers;
  /** Planned starts: chains and schedules. */
  private readonly scheduler: Scheduler;
  private readonly clock: Clock;
  private busy = new Set<string>();
  /** Set while Nexus drains for an update: nothing new starts. */
  draining = false;
  /** Set by shutdown: this engine writes nothing more (its successor may already own the files). */
  private stopped = false;
  /** Sessions whose process Nexus itself is ending: their exit is no failure. */
  private readonly ending = new Set<string>();
  /** Sessions whose process Nexus ends to start it again with another model or effort (Claude Code). */
  private readonly restarting = new Set<string>();
  private readonly retryBaseMs: number;
  private readonly usageMarginMs: number;

  constructor(store: ProjectStore, changed: () => void, options: EngineOptions = {}) {
    this.store = store;
    this.changed = changed;
    this.host = new AgentHost(store, ROLE_RECORDS.worker, { spawn: options.spawn });
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.usageMarginMs = options.usageMarginMs ?? USAGE_MARGIN_MS;
    this.clock = options.clock ?? REAL_CLOCK;
    this.clockTimers = new ClockTimers(this.clock, () => this.stopped);
    this.coordinator = options.coordinator ?? new Coordinator();
    this.scheduler = new Scheduler(store, this.clockTimers, {
      start: (queueId, opts) => this.start(queueId, opts), draining: () => this.draining, stopped: () => this.stopped,
      changed: () => this.changed(), usageMarginMs: this.usageMarginMs,
      block: (state, q) => this.coordinator.startBlock(state, q), checkStarts: () => this.checkStarts(),
    });
    this.coordinator.add(this);
    this.pusher = new AcceptedPusher(store, changed, { run: options.git, timeout: options.pushTimeoutMs });
    this.recoverAfterRestart();
    // Schedules are armed again; what came due while no server ran is looked at once this one is up.
    this.scheduler.armAll();
    this.timers.set("starts", setTimeout(() => { this.timers.delete("starts"); this.checkStarts(); }, 1500));
  }

  /** Pushes what was accepted (src/accepted.ts). */
  readonly pusher: AcceptedPusher;

  /** "Push again" on a queue whose last push of an accepted step failed. */
  pushAgain(queueId: string): string { return this.pusher.pushAgain(queueId); }

  // ---------------------------------------------------------------- user actions

  start(queueId: string, opts: StartOptions = {}): RunFile {
    if (this.draining) throw new ActionError("Nexus is updating; start the queue after the restart", 409);
    let state = loadProjectState(this.store);
    let q = this.queue(state, queueId);
    assertCanStart(q);
    // Never two queues in one checkout, and no more queues at once than the limit (a planned start waits instead).
    const block = this.coordinator.startBlock(state, q);
    if (block) throw new ActionError(refusalText(queueId, "start", block), 409);
    // The new run replaces the run record: a step an earlier run left open goes back to pending, so it runs again
    // when it comes first (and no two steps show running).
    if (releaseOrphanedSteps(this.store, queueId, { replacing: true }).length) { state = loadProjectState(this.store); q = this.queue(state, queueId); }
    if (q.steps.every((s) => stepClosed(q, s))) throw new ActionError("no step left to run", 409);

    // The run's own values: what was asked, else the continued session's, else the project's defaults.
    const reused = opts.session ? this.sessionFile(state, opts.session) : undefined;
    if (reused && reused.runtime === "external") throw new ActionError("only a session Nexus launched (and started at least once) can be continued", 409);
    const runtime = reused ? reused.runtime as "claude" | "codex" : opts.runtime ?? state.project.runtimes.default;
    const values: StepValues = {
      runtime,
      model: opts.model ?? (reused ? reused.model : state.project.runtimes[runtime].model),
      effort: opts.effort ?? (reused ? reused.effort : state.project.runtimes[runtime].effort),
    };
    const own = effortIssue(runtime, values.effort);
    if (own) throw new ActionError(own);
    // Every step still to run is checked now, so a bad combination refuses the start rather than halting the run later.
    for (const st of q.steps.filter((x) => !stepClosed(q, x))) {
      const w = stepValues(values, st, state.project);
      const issue = effortIssue(w.runtime, w.effort);
      if (issue) throw new ActionError(`step ${st.id} would run on ${RUNTIME_NAME[w.runtime]} at effort ${w.effort}: ${issue}`, 409);
    }
    const first = q.steps.find((x) => x.status === "pending");
    const want = first ? stepValues(values, first, state.project) : values;
    if (reused && want.runtime !== reused.runtime) {
      throw new ActionError(`step ${first!.id} runs on ${RUNTIME_NAME[want.runtime]}; the session to continue is a ${RUNTIME_NAME[reused.runtime as "claude" | "codex"]} session`, 409);
    }
    const session = reused
      ? this.reuseSession(state, reused.id, queueId, want.model, want.effort)
      : this.newSession(state, q, want.runtime, want.model, want.effort);
    const run = startedRun({ session: session.id, revision: q.revision, ...values, after: opts.after, at: now() });
    this.store.writeRun(queueId, run);
    this.store.clearStart(queueId); // a planned start is used up by any start
    this.scheduler.disarm(queueId);
    this.ensureProcess(session);
    this.advance(queueId);
    return run;
  }

  pause(queueId: string): void {
    const run = this.run(queueId);
    // Also a queue held for an update: the user's pause wins, so the restart does not resume it. A pending retry or
    // usage wait is cancelled. A run waiting for an approval is paused too (a later resume goes on under the approved
    // revision).
    if (run.state === "running" || run.state === "usage_wait" || run.state === "retry_wait" || run.state === "approval_wait" || run.resume_after_restart) {
      const working = this.host.get(run.session)?.proc.state === "working";
      this.clearTimer(queueId);
      this.writeRun(queueId, toPausedByUser(run, "paused by the user", { pausing: working }));
    }
  }

  /**
   * The user's Continue on a stopped queue: lifts the stop (a `lift` by Continue) and goes on. Its run
   * resumes, reopening the stopped step in its session (unless the orchestrator skipped it: then the next pending
   * one opens). Without a run (an imported stop), or with a finished one, the queue starts afresh at its first
   * pending step. A run of an older revision resumes too: a revision changes no started step.
   */
  continueQueue(queueId: string): string {
    if (this.draining) throw new ActionError("Nexus is updating; continue the queue after the restart", 409);
    // Checked before the stop is lifted, so a refusal leaves the queue as it was.
    const before = this.store.readRun(queueId);
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    const block = !before || before.state === "finished" ? this.coordinator.startBlock(state, q)
      : CHECKOUT_RUN_STATES.includes(before.state) ? undefined : this.coordinator.checkoutBlock(state, q);
    if (block) throw new ActionError(refusalText(queueId, "continue", block), 409);
    const lift = liftByContinue(this.store, queueId);
    const run = this.store.readRun(queueId);
    if (!run || run.state === "finished") {
      const started = this.start(queueId);
      return `the stop is lifted; queue ${queueId} starts at its first pending step in session ${started.session}`;
    }
    this.resume(queueId, `the user lifted the stop with Continue${lift.reason ? `; the stop was: ${lift.reason}` : ""}`);
    return `the stop is lifted; queue ${queueId} goes on in session ${run.session}`;
  }

  /**
   * Goes on with a paused, halted or waiting run in its session, ensuring its process. Also the way an approval_wait
   * run goes on once its revision is approved (onChange, a cancelled drain, the restart). `why`: said to the agent when
   * the step is continued (a retry after a failed turn, a lifted stop).
   */
  resume(queueId: string, why?: string): void {
    const run = this.run(queueId);
    if (run.state === "running") return;
    if (run.state === "finished") throw new ActionError("the run is finished", 409);
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    assertCanResume(q, run);
    // A halted run holds no checkout: another queue may have started there meanwhile.
    if (!CHECKOUT_RUN_STATES.includes(run.state)) {
      const block = this.coordinator.checkoutBlock(state, q);
      if (block) throw new ActionError(refusalText(queueId, "go on", block), 409);
    }
    const session = this.sessionFile(state, run.session);
    this.ensureProcess(session);
    this.clearTimer(queueId);
    this.writeRun(queueId, toResumed(run, q.revision));
    // A step left unfinished (stopped, failed, interrupted) is continued rather than skipped; one waiting for an
    // answer just waits on (the answer arrives through the inbox). A rejected step is never run again.
    const open = q.steps.find((s) => s.id === run.step && !["done", "skipped", "review", "rejected"].includes(s.status));
    // A step sent back while the run was paused or halted: the send-back, still in the inbox, opens its next turn.
    const sentBack = open && state.sessions.find((x) => x.id === run.session)?.inbox.some((m) => m.type === "send_back" && m.step === open.id && !m.read_at);
    if (open?.status === "waiting" || sentBack) this.changed();
    else if (open) this.openStep(queueId, open, q, "continue", why);
    else this.advance(queueId);
  }

  // ---------------------------------------------------------------- updates of Nexus itself

  /**
   * Gets ready for a restart: running queues stop at the end of their current step (or at once with `now`) and are
   * marked to be resumed by the next server; a queue waiting to retry a turn is held too and retries after the
   * restart. Queues paused, halted, waiting for the usage window or pausing at the user's request are left alone: a
   * restart does not resume them (the usage wait goes on by itself).
   */
  drainForUpdate(now: boolean): string[] {
    this.draining = true;
    const held: string[] = [];
    for (const id of this.store.queueIds()) {
      const run = this.store.readRun(id);
      if (run?.state === "retry_wait") { this.writeRun(id, { ...run, resume_after_restart: true }); held.push(id); continue; }
      if (!run || run.state !== "running") continue;
      const working = this.host.get(run.session)?.proc.state === "working";
      const reason = "the Nexus server is updating; it goes on by itself afterwards";
      this.writeRun(id, toHeldForUpdate(run, reason, { pausing: working && !now }));
      held.push(id);
    }
    if (now) for (const l of this.host.all()) if (l.proc.state === "working") { this.ending.add(l.session); l.proc.kill(); }
    return held;
  }

  /** No agent of this project is in the middle of a turn. */
  idle(): boolean {
    return this.host.idle();
  }

  /** The update did not happen: the queues it held go on now. */
  cancelDrain(): void {
    this.draining = false;
    for (const id of this.store.queueIds()) {
      const run = this.store.readRun(id);
      if (run?.state === "retry_wait" || run?.state === "usage_wait") {
        // Its timer may have come while draining and done nothing: set it again.
        if (run.resume_after_restart) this.writeRun(id, { ...run, resume_after_restart: undefined });
        if (run.resume_at) this.schedule(id, run.resume_at, run.state === "usage_wait" ? this.usageMarginMs : 0);
        continue;
      }
      if (run?.state === "approval_wait") { if (this.queue(loadProjectState(this.store), id).approved) this.continueApproved(id); continue; }
      if (!run?.resume_after_restart) continue;
      if (run.state === "pausing") this.writeRun(id, toUnheld(run));
      else if (run.state === "paused") { try { this.resume(id); } catch (e) { this.halt(id, (e as Error).message); } }
    }
    this.checkStarts();
  }

  /** Interrupts the running turn and pauses the run. */
  stopNow(queueId: string, text?: string): void {
    const run = this.run(queueId);
    const live = this.host.get(run.session);
    this.clearTimer(queueId);
    this.writeRun(queueId, toPausedByUser(run, "stopped by the user"));
    if (live && live.proc.state === "working") {
      live.proc.send(
        userStopNow(text),
        "now",
      );
    }
  }

  /**
   * The user rejects a step waiting for their review (review.rejected, with an optional reason): the step is marked
   * rejected, the run pauses, nothing is reverted. The orchestrator is told (src/orchestrator.ts) and proposes what
   * follows as revisions; the run goes on only after the user approves a newer revision, at its first pending step,
   * and nothing of the queue is pushed until then.
   */
  rejectStep(queueId: string, step: string, text?: unknown): string {
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    const st = q.steps.find((s) => s.id === step);
    if (!st) throw new ActionError(`no step ${step}`, 404);
    if (st.status !== "review" || st.review_with !== "user") throw new ActionError(`step ${queueId}/${step} is not waiting for your review`, 409);
    const why = typeof text === "string" && text.trim() ? text.trim() : undefined;
    const user = ensureUserSession(this.store);
    this.store.appendEvent({ v: 1, id: newId(), at: now(), session: user.id, type: "review.rejected", queue: queueId, step, text: why });
    const run = this.store.readRun(queueId);
    if (run && run.state !== "finished") {
      this.clearTimer(queueId);
      this.writeRun(queueId, toPausedByUser(run, `step ${step} was rejected by the user${why ? `: ${why}` : ""}`, { rejected: step }));
    }
    this.changed();
    return `step ${queueId}/${step} rejected; the run is paused`;
  }

  /**
   * The user accepts a step in review, optionally with a note: to the next step of the queue (by default; a note from
   * the user on the next pending step, delivered when it starts) or to the orchestrator (recorded on the event and
   * told by the orchestrator, src/orchestrator.ts). Without a next step the note goes to the orchestrator. Returns
   * where it went.
   */
  acceptReview(queueId: string, step: string, text?: unknown, to?: unknown): { to?: "next" | "orchestrator"; step?: string } {
    if (to !== undefined && to !== null && to !== "next" && to !== "orchestrator") throw new ActionError("a note goes to next or orchestrator");
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    const index = q.steps.findIndex((s) => s.id === step);
    const st = q.steps[index];
    if (!st) throw new ActionError(`no step ${step}`, 404);
    if (st.status !== "review") throw new ActionError("the step is not waiting for review", 409);
    // A halted run holds no checkout: accepting goes on only where no other queue works now.
    const own = q.run;
    if (own && own.state !== "finished" && !CHECKOUT_RUN_STATES.includes(own.state)) {
      const block = this.coordinator.checkoutBlock(state, q);
      if (block) throw new ActionError(refusalText(queueId, "go on", block), 409);
    }
    const note = typeof text === "string" && text.trim() ? text.trim() : undefined;
    const next = q.steps.slice(index + 1).find((s) => s.status === "pending");
    const dest = !note ? undefined : to === "orchestrator" || !next ? "orchestrator" as const : "next" as const;
    if (dest === "next") addNote(this.store, queueId, next!.id, note);
    const user = ensureUserSession(this.store);
    this.store.appendEvent({ v: 1, id: newId(), at: now(), session: user.id, type: "review.accepted", queue: queueId, step, text: note, to: dest });
    this.advance(queueId);
    return { to: dest, step: dest === "next" ? next!.id : undefined };
  }

  /** Called after every change to the project's files (debounced by the server). */
  onChange(state: ProjectState): void {
    if (!this.stopped) this.pusher.onChange(state);
    for (const l of this.host.all()) this.deliverInbox(state, l);
    for (const q of state.queues) if (q.run && (q.run.state === "running" || q.run.state === "pausing")) this.advance(q.id, state);
    for (const q of state.queues) if (q.run?.state === "approval_wait" && q.approved) this.continueApproved(q.id);
    this.checkStarts();
  }

  /** A run waiting for an approval that came goes on (not while an update drains: the restart or cancelDrain does it). */
  private continueApproved(queueId: string): void {
    if (this.stopped || this.draining) return;
    try { this.resume(queueId); } catch (e) { this.halt(queueId, `could not go on after the approval: ${(e as Error).message}`); }
  }

  // ---------------------------------------------------------------- planned starts: chains and schedules (src/scheduler.ts)

  /**
   * Plans to start `queueId` when queue `o.after` is done. When it already is, the queue starts now (or, while an
   * update drains, right after it). Replaces an earlier plan of the queue. Returns what happened, in a sentence.
   */
  chain(queueId: string, o: ChainOptions): string { return this.scheduler.chain(queueId, o); }

  /**
   * Plans to start `queueId` at a time (`o.at`, ISO 8601, in the future), or when the usage window of the runtime it
   * would run on resets (`o.at` = "usage-reset"). Replaces an earlier plan of the queue. Returns what happened.
   */
  scheduleStart(queueId: string, o: ScheduleOptions): string { return this.scheduler.scheduleStart(queueId, o); }

  /** Cancels the planned start of a queue. */
  cancelStart(queueId: string): string { return this.scheduler.cancelStart(queueId); }

  /** Starts the queues whose planned starts are due, in every project (the coordinator's pass). */
  private checkStarts(): void { this.coordinator.checkStarts(); }

  // Member (src/coordinator.ts): what the coordinator asks of this project's engine.
  isStopped(): boolean { return this.stopped; }
  accepting(): boolean { return !this.stopped && !this.draining; }
  duePlans(): { queue: string; created_at: string }[] { return this.scheduler.duePlans(); }
  startDue(queueId: string): boolean { return this.scheduler.startDue(queueId); }

  /** Activity of a session, optionally only what was tagged with a step. */
  activity(session: string, queue?: string, step?: string, limit = 300) {
    const items = this.store.readActivity(session).entries.filter((a) => (!queue || a.queue === queue) && (!step || a.step === step));
    return items.slice(-limit);
  }

  shutdown(): void {
    this.stopped = true;
    this.coordinator.remove(this);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.clockTimers.clearAll();
    for (const l of this.host.all()) l.proc.kill();
  }

  /** A process of this engine's is still running (after shutdown: not yet exited). */
  alive(): boolean {
    return this.host.alive();
  }

  // ---------------------------------------------------------------- driving

  /**
   * Looks at the run's current step after anything happened and decides what comes next. Opens a turn only when
   * the session is idle, so it is safe to call at any time and any number of times.
   */
  private advance(queueId: string, given?: ProjectState): void {
    if (this.stopped) return;
    if (this.busy.has(queueId)) { setTimeout(() => this.advance(queueId), 50); return; }
    this.busy.add(queueId);
    try { this.advanceUnlocked(queueId, given); }
    catch (err) { this.halt(queueId, `engine error: ${(err as Error).message}`); }
    finally { this.busy.delete(queueId); }
  }

  private advanceUnlocked(queueId: string, given?: ProjectState): void {
    const run = this.store.readRun(queueId);
    if (!run || (run.state !== "running" && run.state !== "pausing")) return;
    const state = given ?? loadProjectState(this.store);
    const q = this.queue(state, queueId);
    if (this.restarting.has(run.session)) return; // the process restarts with another model or effort
    const live = this.host.get(run.session);
    if (!live || live.proc.state === "exited") return this.halt(queueId, "the session's process is not running");
    if (live.proc.state === "working") return;

    // A new revision never stops the step at work: its turns, questions, answers and nudges go on as below, and only
    // the step's end looks at the approval.
    const current = run.step ? q.steps.find((s) => s.id === run.step) : undefined;
    if (q.status === "stopped") return this.halt(queueId, stoppedMessage(q));
    if (current) {
      switch (current.status) {
        case "running":
        case "pending": {
          // Something for the agent is on its way (a message, or an answer not yet routed to its inbox): the next
          // turn brings it, so this is not a turn without an outcome.
          const s = state.sessions.find((x) => x.id === run.session);
          const unread = s?.inbox.some((m) => !m.read_at);
          const unrouted = state.questions.some((x) => x.session === run.session && x.state === "answered"
            && !s?.inbox.some((m) => m.type === "answer" && m.qid === x.qid));
          if (unread || unrouted) return;
          // The turn ended and the step has no outcome: ask once, then hand it to the user.
          if (run.nudged) return this.halt(queueId, `step ${current.id} ended twice without an outcome`);
          this.writeRun(queueId, { ...run, nudged: true });
          live.proc.send(noOutcomeNudge(current.id));
          return;
        }
        case "waiting":
          return; // a blocking question: its answer arrives through the inbox and starts the next turn
        case "review":
          return; // waits for its review: the user's (policy wait) or the orchestrator's (policy orchestrator)
        case "failed":
        case "stopped":
          return this.halt(queueId, `step ${current.id} ${current.status}${current.reason ? `: ${current.reason}` : ""}`);
        default:
          break; // done or skipped: go on
      }
    }

    // The step's end. A newer revision waiting for approval: the run waits for it, keeping its session (also while an
    // update drains: it stays so across the restart), and goes on by itself once approved; the user's pause wins.
    if (!q.approved) {
      if (run.state === "pausing" && !run.resume_after_restart) return this.writeRun(queueId, toPaused(run));
      this.writeRun(queueId, toApprovalWait(run, q.revision));
      this.store.appendActivity(run.session, { at: now(), kind: "turn_end", text: `Nexus waits for the approval of revision ${q.revision} of queue ${queueId} before it goes on`, queue: queueId, step: run.step });
      return;
    }
    // Approved: the run goes on in the same session under the queue's current revision.
    if (run.revision !== q.revision) { this.writeRun(queueId, toRevision(run, q.revision)); return this.advanceUnlocked(queueId, state); }

    const next = q.steps.find((s) => s.status === "pending");
    if (!next) {
      // Also when pausing (for the user or an update): nothing is left to pause before.
      this.writeRun(queueId, toFinished(run));
      this.ending.add(run.session);
      live.proc.close();
      return;
    }
    if (run.state === "pausing") return this.writeRun(queueId, toPaused(run));
    const want = stepValues(this.runValues(state, run), next, state.project);
    const issue = effortIssue(want.runtime, want.effort);
    if (issue) return this.halt(queueId, `step ${next.id}: ${issue}`);
    const wait = this.usageWait(state, want.runtime);
    if (wait) {
      this.writeRun(queueId, toUsageWait(run, wait.reason, wait.until));
      this.schedule(queueId, wait.until, this.usageMarginMs);
      return;
    }
    if (this.prepareStep(queueId, run, state, q, current, next, want, live)) return;
    this.openStep(queueId, next, q, "start");
  }

  /**
   * Makes the session fit the next step before it opens; returns whether it took the next move instead.
   *
   * - Another runtime than the session's, or (context care, DESIGN.md "Context care between steps") a context fuller
   *   than the project's threshold: the step runs in a fresh session with the step's runtime, model and effort,
   *   seeded with the ended step's context summary and the queue's text. A missing summary is asked for once; if it is
   *   still missing, the seed is the queue's description and its finished steps' summaries. Without a known context
   *   window the fill does not count.
   * - The same runtime with another model or effort: Claude Code's process is restarted with `--resume` and the new
   *   values (the step opens when the new process is up); Codex takes them with the next turn.
   */
  private prepareStep(queueId: string, run: RunFile, state: ProjectState, q: QueueView, done: StepView | undefined, next: StepView, want: StepValues, live: Live): boolean {
    const defaults = state.project.defaults;
    const old = state.sessions.find((x) => x.id === run.session);
    if (!old || old.runtime === "external") return false;
    const tokens = old.live?.context_tokens, window = old.live?.context_window;
    const fill = tokens && window ? tokens / window : undefined;
    const why = old.runtime !== want.runtime ? "runtime"
      : defaults.context_care && fill !== undefined && fill > defaults.context_reuse_threshold ? "context" : undefined;
    if (why) {
      // Fresh: written by this session at or after its latest start of the step that just ended.
      const since = done?.timeline.filter((e) => e.type === "step.started" && e.session === old.id).at(-1)?.at ?? run.started_at;
      const fresh = !!done && !!old.context && old.context.at >= since;
      const asked = !!done && run.summary_asked === done.id;
      if (done && !fresh && !asked) {
        const because = summaryReason(why, next.id, want.runtime, fill);
        this.writeRun(queueId, { ...run, summary_asked: done.id });
        live.proc.send(summaryRequest(done.id, because));
        this.store.appendActivity(old.id, { at: now(), kind: "turn_start", text: `Nexus asked for the context summary of step ${done.id} (${because})`, queue: queueId, step: done.id });
        return true;
      }
      this.switchSession(queueId, run, q, old, live, done, next, want, why, fill, fresh ? (asked ? "asked" : "written") : "fallback");
      return true;
    }
    if (old.model === want.model && old.effort === want.effort) return false;
    const file = this.store.readSession(old.id);
    this.store.writeSession({ ...file, model: want.model, effort: want.effort });
    const what = `${want.model ?? "the runtime's default model"}, ${want.effort ? `${want.effort} effort` : "the default effort"}`;
    if (live.proc.retune) {
      live.proc.retune(want.model, want.effort);
      this.store.appendActivity(old.id, { at: now(), kind: "turn_start", text: `Nexus switches the session to ${what} for step ${next.id}`, queue: queueId, step: next.id });
      return false;
    }
    // Claude Code takes model and effort at start: end the idle process, and resume the session with the new values
    // once it has exited (never two processes on one session); the exit handler then decides again.
    this.restarting.add(old.id);
    this.ending.add(old.id);
    live.proc.close();
    const proc = live.proc;
    this.timers.set(`restart:${old.id}`, setTimeout(() => { this.timers.delete(`restart:${old.id}`); if (proc.state !== "exited") proc.kill(); }, RESTART_KILL_MS));
    this.store.appendActivity(old.id, { at: now(), kind: "turn_end", text: `Nexus restarts the session's process on ${what} for step ${next.id}`, queue: queueId, step: next.id });
    return true;
  }

  /** Goes on with `next` in a fresh session (with `want`'s runtime, model and effort) that continues `old`. */
  private switchSession(queueId: string, run: RunFile, q: QueueView, old: SessionView, live: Live, done: StepView | undefined, next: StepView, want: StepValues, why: "context" | "runtime", fill: number | undefined, source: "written" | "asked" | "fallback"): void {
    const oldFile = this.store.readSession(old.id);
    const part = (run.switches?.length ?? 0) + 2;
    const fresh: SessionFile = {
      protocol: 1, id: newId(), project: oldFile.project, role: "worker", runtime: want.runtime,
      native_id: want.runtime === "claude" ? randomUUID() : null,
      title: `${q.id} worker (${part})`, cwd: oldFile.cwd, branch: gitBranch(oldFile.cwd) ?? oldFile.branch, queue: q.id,
      launched_by: "nexus", created_at: now(), model: want.model, effort: want.effort, continues: old.id,
    };
    this.store.writeSession(fresh);
    this.store.writeSession({ ...oldFile, continued_by: fresh.id });
    // What the old session has not read yet goes into the new one's first turn; the old process ends.
    const unread = (loadProjectState(this.store).sessions.find((x) => x.id === old.id)?.inbox ?? []).filter((m) => !m.read_at);
    this.ending.add(old.id);
    live.proc.close();
    const because = switchReason(why, next.id, want.runtime, old.runtime as "claude" | "codex", fill);
    this.writeRun(queueId, {
      ...run, session: fresh.id, summary_asked: undefined,
      switches: [...(run.switches ?? []), { at: now(), from: old.id, to: fresh.id, step: next.id, why, fill, summary: source }],
    });
    this.store.appendActivity(old.id, { at: now(), kind: "turn_end", text: `Nexus goes on in a fresh session (${fresh.id}): ${because}`, queue: queueId, step: done?.id ?? next.id });
    for (const m of unread) this.store.appendDelivered(old.id, { at: now(), kind: "inbox", id: m.id, via: "carried", to: fresh.id });
    const state = loadProjectState(this.store);
    this.ensureProcess(fresh);
    const seed = freshSessionSeed(q, because, done, next, source === "fallback" ? undefined : old.context);
    const carried = carriedMessages(unread.map((m) => formatInbox(m, state)));
    this.openStep(queueId, next, this.queue(state, queueId), "start", undefined, { before: seed, after: carried });
  }

  /** The run's own runtime, model and effort; an older run file without them: its session's. */
  private runValues(state: ProjectState, run: RunFile): StepValues {
    if (run.runtime) return { runtime: run.runtime, model: run.model, effort: run.effort };
    const s = this.sessionFile(state, run.session);
    return { runtime: s.runtime === "codex" ? "codex" : "claude", model: s.model, effort: s.effort };
  }

  private openStep(queueId: string, step: StepView, q: QueueView, mode: "start" | "continue", why?: string, around: { before?: string; after?: string } = {}): void {
    const run = this.run(queueId);
    const live = this.host.get(run.session);
    if (!live) return this.halt(queueId, "the session's process is not running");
    const state = loadProjectState(this.store);
    const project = state.project;
    const notes = step.notes.filter((n) => !n.read_at && n.to !== "orchestrator"); // the orchestrator's are not the worker's
    const answers = state.questions.filter((x) => x.session === run.session && x.step === step.id && x.state === "answered");
    const last = !q.steps.some((s) => s.status === "pending" && s.id !== step.id);
    const opening = stepOpening({
      q, step, mode, why, projectStopConditions: project.defaults.stop_conditions, notes, answers, last,
      report: reportFile(project.id, q.id),
    });
    live.proc.send([around.before, opening, around.after].filter(Boolean).join("\n\n"));
    for (const n of notes) this.store.appendDelivered(run.session, { at: now(), kind: "note", id: n.id, via: "turn" });
    recordStepStart(this.store, queueId, step.id, run.session);
    this.writeRun(queueId, { ...run, step: step.id, nudged: false, ...(mode === "start" ? { retries: undefined, failure: undefined, summary_asked: undefined } : {}) });
    this.store.appendActivity(run.session, { at: now(), kind: "turn_start", text: `Nexus opened step ${step.id}${mode === "continue" ? " (continue)" : ""}${around.before ? " in a fresh session, with what the previous one handed over" : ""}`, queue: queueId, step: step.id });
  }

  /** Hands unread inbox entries to a live session: inside a running turn, or as a new turn when it is idle. */
  private deliverInbox(state: ProjectState, l: Live): void {
    // A process Nexus is ending gets nothing more (a session taken over had its unread entries carried across).
    if (l.proc.state === "exited" || this.ending.has(l.session)) return;
    const s = state.sessions.find((x) => x.id === l.session);
    const unread = (s?.inbox ?? []).filter((m) => !m.read_at);
    if (!unread.length) return;
    const run = state.queues.find((q) => q.run?.session === l.session)?.run;
    const idleAllowed = !run || run.state === "running" || run.state === "pausing";
    for (const m of unread) {
      const text = formatInbox(m, state);
      if (m.type === "stop") l.proc.send(text, "now");
      else if (l.proc.state === "working") l.proc.send(text, "next");
      else if (idleAllowed) l.proc.send(text);
      else continue; // a paused run: keep it for later
      if (m.type === "send_back") recordStepStart(this.store, m.queue, m.step, l.session); // the next round
      this.store.appendDelivered(l.session, { at: now(), kind: "inbox", id: m.id, via: l.proc.state === "working" ? "inject" : "turn" });
    }
  }

  /** Halts a run that is not halted yet; `failure`: the runtime's failure that halted it. */
  private halt(queueId: string, reason: string, failure?: string): void {
    const run = this.store.readRun(queueId);
    if (!run || run.state === "halted") return;
    this.clearTimer(queueId);
    this.writeRun(queueId, toHalted(run, reason, failure));
  }

  /** The queue has no step left: every step is done or skipped, or rejected by the user and released (stepClosed). */
  private nothingLeft(queueId: string): boolean {
    const q = loadProjectState(this.store).queues.find((x) => x.id === queueId);
    return !!q && q.steps.length > 0 && q.steps.every((s) => stepClosed(q, s));
  }

  /** Ends a going run as finished (its last step is done). */
  private finish(queueId: string): void {
    const run = this.store.readRun(queueId);
    if (!run || (run.state !== "running" && run.state !== "pausing")) return;
    this.clearTimer(queueId);
    this.writeRun(queueId, toFinished(run));
  }

  /**
   * A turn of the run's session failed (or its process ended without Nexus asking). Passing: try the turn again
   * after a growing delay, at most RETRY_LIMIT times in a row. A usage limit with a reset time: wait for it.
   * Lasting, or out of tries: halt, naming the failure. A pause the user asked for wins over any of these.
   */
  private turnFailed(queueId: string, f: TurnFailure): void {
    if (this.stopped) return;
    const run = this.store.readRun(queueId);
    if (!run || (run.state !== "running" && run.state !== "pausing")) return;
    const what = `${f.code}: ${f.text}`;
    if (run.state === "pausing" && !run.resume_after_restart) {
      return this.writeRun(queueId, toPaused(run, `paused by the user; the last turn failed (${what})`));
    }
    if (f.kind === "lasting") return this.halt(queueId, `the turn failed (${what})`, f.code);
    if (f.kind === "usage" && f.resetsAt) {
      this.writeRun(queueId, toUsageWait(run, `the usage limit was reached (${what}); goes on when it resets`, f.resetsAt));
      this.schedule(queueId, f.resetsAt, this.usageMarginMs);
      return;
    }
    const tries = (run.retries ?? 0) + 1;
    if (tries > RETRY_LIMIT) return this.halt(queueId, `the turn failed ${tries} times in a row; the last time: ${what}`, f.code);
    const at = new Date(this.clock.now() + this.retryBaseMs * 2 ** (tries - 1)).toISOString();
    this.writeRun(queueId, toRetryWait(run, { tries, failure: f.code, reason: `the turn failed (${what}); retry ${tries} of ${RETRY_LIMIT}`, at }));
    this.store.appendActivity(run.session, { at: now(), kind: "retry", text: `Nexus tries the turn again at ${formatClock(at, new Date())} (${tries} of ${RETRY_LIMIT}): ${what}`, queue: queueId, step: run.step });
    this.schedule(queueId, at, 0);
  }

  // ---------------------------------------------------------------- sessions and processes

  private newSession(state: ProjectState, q: QueueView, runtime: "claude" | "codex", model?: string, effort?: Effort): SessionFile {
    const issue = effortIssue(runtime, effort);
    if (issue) throw new ActionError(issue);
    const cwd = worktreeFor(this.store, state, q);
    const s: SessionFile = {
      protocol: 1, id: newId(), project: state.project.id, role: "worker", runtime,
      // Claude takes the id Nexus chooses; Codex assigns its thread id when the thread starts.
      native_id: runtime === "claude" ? randomUUID() : null,
      title: `${q.id} worker`, cwd, branch: gitBranch(cwd), queue: q.id, launched_by: "nexus", created_at: now(),
      model: model ?? state.project.runtimes[runtime].model,
      effort: effort ?? state.project.runtimes[runtime].effort,
    };
    this.store.writeSession(s);
    return s;
  }

  private reuseSession(state: ProjectState, id: string, queueId: string, model?: string, effort?: Effort): SessionFile {
    const s = this.sessionFile(state, id);
    if (s.runtime === "external" || s.launched_by !== "nexus" || !s.native_id) throw new ActionError("only a session Nexus launched (and started at least once) can be continued", 409);
    const busy = state.queues.find((q) => q.id !== queueId && q.run?.session === id && HOLDING_RUN_STATES.includes(q.run.state));
    if (busy) throw new ActionError(`that session is running queue ${busy.id}`, 409);
    const issue = effortIssue(s.runtime, effort);
    if (issue) throw new ActionError(issue);
    const updated: SessionFile = { ...s, queue: queueId, model, effort };
    this.store.writeSession(updated);
    return updated;
  }

  private ensureProcess(session: SessionFile): Live {
    const existing = this.host.running(session.id);
    if (existing) {
      // A process Nexus is ending (its run just finished, or its session was switched) cannot take another turn: its
      // input is closed. Wait for its exit as a restart does (never two processes on one session); the exit handler
      // then starts the new process and advances the session's runs.
      if (this.ending.has(session.id) && !this.restarting.has(session.id)) {
        this.restarting.add(session.id);
        const proc = existing.proc;
        this.timers.set(`restart:${session.id}`, setTimeout(() => { this.timers.delete(`restart:${session.id}`); if (proc.state !== "exited") proc.kill(); }, RESTART_KILL_MS));
      }
      return existing;
    }
    const project = this.store.readProject();
    const env = this.host.env(session.id);
    const launch = (resume: boolean): Launch => {
      if (session.runtime === "codex") {
        const codex = project.runtimes.codex;
        const inside = normPath(this.store.dir).toLowerCase().startsWith(normPath(session.cwd).toLowerCase() + "/");
        return { runtime: "codex", options: {
          cwd: session.cwd, model: session.model ?? codex.model, effort: session.effort ?? codex.effort, instructions: WORKER_BRIEFING, env,
          threadId: session.native_id, sandbox: codex.sandbox, approvalPolicy: codex.approval_policy, approvalsReviewer: codex.approvals_reviewer,
          // The folder for reports: the last step's report is written there (outside the working tree).
          writableRoots: [...(inside ? [] : [this.store.dir]), ...gitWritableRoots(session.cwd), ensureReportFolder(project.id)],
        } };
      }
      const claude = project.runtimes.claude;
      return { runtime: "claude", options: {
        cwd: session.cwd,
        uuid: session.native_id!,
        resume, // started before (it has a runtime record): resume it
        model: session.model ?? claude.model,
        effort: session.effort ?? claude.effort,
        permissionMode: claude.permission_mode,
        allowedTools: ["Bash(nexus:*)", ...claude.allowed_tools],
        // The project's .nexus is the server's (and the CLI's) to write, not the worker's file tools'. Its absolute
        // path: the worker's cwd may be a worktree whose own .nexus does not exist.
        disallowedTools: project.defaults.protect_nexus ? nexusDenyRules(this.store.dir) : undefined,
        appendSystemPrompt: WORKER_BRIEFING,
        env,
      } };
    };

    const tag = () => {
      // The run that drives the session now; a session continued from an earlier queue still has that one's run too.
      const runs = this.store.queueIds().map((q) => [q, this.store.readRun(q)] as const).filter(([, r]) => r?.session === session.id);
      const run = runs.find(([, r]) => HOLDING_RUN_STATES.includes(r!.state)) ?? runs.sort(([, a], [, b]) => b!.updated_at.localeCompare(a!.updated_at))[0];
      return run ? { queue: run[0], step: run[1]?.step } : {};
    };
    const runsOf = () => this.store.queueIds().filter((q) => this.store.readRun(q)?.session === session.id);
    // AgentHost keeps the runtime record (a turn's end counts in `turns`), the facts and the usage windows; these
    // handlers run after it.
    return this.host.start(session, launch, {}, () => ({
      activity: (a) => this.store.appendActivity(session.id, { at: now(), ...a, ...tag() }),
      refusal: (r) => {
        // One record per refusal, also across processes of the session (a resumed runtime may repeat its list).
        if (r.ref && this.store.readRefusals(session.id).entries.some((x) => x.ref === r.ref)) return;
        this.store.appendRefusal({ at: now(), session: session.id, runtime: session.runtime === "codex" ? "codex" : "claude", ...r, ...tag() });
        this.changed();
      },
      turnEnd: (end) => {
        // A failed turn is decided at once and is not a turn without an outcome.
        if (end.failure) { for (const q of runsOf()) this.turnFailed(q, end.failure); this.changed(); return; }
        if (end.ok) for (const q of runsOf()) { const r = this.store.readRun(q); if (r?.retries) this.writeRun(q, { ...r, retries: undefined, failure: undefined }); }
        // Let the CLI's last events land in the files, then decide. A step that got its outcome in this turn ends its
        // round of commits here.
        setTimeout(() => {
          const state = loadProjectState(this.store);
          for (const q of state.queues) {
            if (q.run?.session !== session.id) continue;
            const st = q.steps.find((s) => s.id === q.run!.step);
            if (st && OUTCOME.has(st.status)) recordStepEnd(this.store, q.id, st.id);
            this.advance(q.id);
          }
          this.changed();
        }, 300);
      },
      exit: (code) => {
        // Ended by Nexus (shutdown, the hand-over of an update, an update's drain with `now`, a finished run): no
        // failure. Any other exit is a crash, and the turn is tried again on a new process that resumes the session.
        const byNexus = this.stopped || this.ending.delete(session.id);
        this.store.appendActivity(session.id, { at: now(), kind: code === 0 || byNexus ? "exit" : "error", text: `process exited (${code ?? "signal"})${byNexus ? ", ended by Nexus" : ""}`, ...tag() });
        if (this.restarting.delete(session.id)) {
          clearTimeout(this.timers.get(`restart:${session.id}`));
          this.timers.delete(`restart:${session.id}`);
          if (!this.stopped) {
            try { this.ensureProcess(this.store.readSession(session.id)); }
            catch (e) { for (const q of runsOf()) this.halt(q, `could not restart the session: ${(e as Error).message}`); }
            for (const q of runsOf()) this.advance(q);
          }
          this.changed();
          return;
        }
        if (!byNexus) for (const q of runsOf()) {
          // The agent finished the queue's last step and its process then ended (the CLI closing, killed, or crashing
          // after the report): nothing is left to run, so the run is finished, not a failure to retry.
          if (this.nothingLeft(q)) { this.finish(q); continue; }
          this.turnFailed(q, { kind: "passing", code: "processExited", text: `the runtime's process exited (${code ?? "signal"})` });
        }
        this.changed();
      },
    }));
  }

  // ---------------------------------------------------------------- usage limits

  /** Claude's 5-hour window, or any of Codex's windows, above the project's threshold. */
  private usageWait(state: ProjectState, runtime: string): { reason: string; until: string } | undefined {
    const windows = readUsage()?.windows ?? {};
    const names = runtime === "codex" ? Object.keys(windows).filter((k) => k.startsWith("codex_")) : ["five_hour"];
    const limit = state.project.defaults.usage_pause_threshold;
    for (const name of names) {
      const w = windows[name];
      if (!w || !w.resets_at || Date.parse(w.resets_at) < this.clock.now() || w.utilization < limit) continue;
      return { reason: `the ${name.replace("codex_", "Codex ").replace("five_hour", "5-hour")} window is at ${Math.round(w.utilization * 100)} % (limit ${Math.round(limit * 100)} %)`, until: w.resets_at };
    }
    return undefined;
  }

  /**
   * Wakes a run waiting for the usage window or for a retry at `at` (plus a margin): it goes on like a resume, so a
   * step left open is continued. Not while draining for an update: the next server (or cancelDrain) sets it again.
   */
  private schedule(queueId: string, at: string, margin: number): void {
    const due = Math.max(this.clock.now() + (margin ? 1000 : 0), Date.parse(at) + margin);
    this.clockTimers.wakeAt(queueId, due, () => {
      const run = this.store.readRun(queueId);
      if (this.stopped || this.draining || (run?.state !== "usage_wait" && run?.state !== "retry_wait")) return;
      const why = run.state === "retry_wait" ? `the last turn failed: ${run.reason ?? "a passing failure"}; this is the retry` : undefined;
      try { this.resume(queueId, why); } catch (e) { this.halt(queueId, `could not go on: ${(e as Error).message}`); }
      this.changed();
    });
  }

  /** A queue's retry or usage-wait timer. */
  private clearTimer(queueId: string): void { this.clockTimers.clear(queueId); }

  // ---------------------------------------------------------------- helpers

  private recoverAfterRestart(): void {
    // A step an earlier run left open while a newer revision went on (no live run of it) goes back to pending.
    for (const q of this.store.queueIds()) releaseOrphanedSteps(this.store, q);
    const state = loadProjectState(this.store);
    for (const q of this.store.queueIds()) {
      const run = this.store.readRun(q);
      const view = state.queues.find((x) => x.id === q);
      const left = view?.steps.some((s) => !stepClosed(view, s));
      if (run && (["running", "pausing"].includes(run.state) || run.resume_after_restart) && left === false) {
        // Its last step was done before the server stopped: the run is over, whatever stopped the process.
        this.writeRun(q, toFinished(run));
      } else if (run?.state === "retry_wait" && run.resume_at) {
        // A retry pending at the restart (held by an update or not) is made when it is due.
        this.schedule(q, run.resume_at, 0);
      } else if (run?.resume_after_restart) {
        // Held for an update: resumed shortly, once this server is up.
        this.writeRun(q, toHeldForUpdate(run, "resuming after the Nexus update"));
        this.timers.set(`recover:${q}`, setTimeout(() => {
          this.timers.delete(`recover:${q}`);
          const r = this.store.readRun(q);
          if (!r?.resume_after_restart) return;
          try { this.resume(q); } catch (e) { this.halt(q, `could not resume after the update: ${(e as Error).message}`); }
          this.changed();
        }, 1500));
      } else if (run && ["running", "pausing"].includes(run.state)) {
        this.writeRun(q, toPaused(run, "the Nexus server restarted; resume to continue"));
      } else if (run?.state === "approval_wait" && view?.approved) {
        // Approved while no server ran (or while an update drained): it goes on shortly, once this server is up.
        this.timers.set(`recover:${q}`, setTimeout(() => {
          this.timers.delete(`recover:${q}`);
          if (this.store.readRun(q)?.state === "approval_wait") this.continueApproved(q);
          this.changed();
        }, 1500));
      }
      if (run?.state === "usage_wait" && run.resume_at) this.schedule(q, run.resume_at, this.usageMarginMs);
    }
    for (const s of this.store.sessionIds()) {
      const r = this.store.readRuntime(s);
      if (!r || r.state === "exited") continue;
      // A process the previous server left behind (killed without its shutdown) would write into the same
      // session as the one a resume starts: end it first.
      if (r.pid && isAlive(r.pid)) { try { process.kill(r.pid); } catch { /* gone or not ours */ } }
      this.host.write(s, { state: "exited" });
    }
  }

  private run(queueId: string): RunFile {
    const run = this.store.readRun(queueId);
    if (!run) throw new ActionError("the queue has no run", 409);
    return run;
  }

  private writeRun(queueId: string, run: RunFile): void {
    // ended_at: set when the run stops going (finished, halted, paused), kept while it stays stopped, cleared when it
    // goes on, so the dashboard can show when it ended and how long it took.
    const old = this.store.readRun(queueId);
    const ended = ENDED_RUN_STATES.has(run.state)
      ? (old && ENDED_RUN_STATES.has(old.state) && old.ended_at ? old.ended_at : now())
      : undefined;
    this.store.writeRun(queueId, { ...run, ended_at: ended, updated_at: now() });
    // A run that stopped going may free its checkout or a place under the limit, for a waiting start in any project.
    if (old?.state !== run.state && !this.stopped) this.coordinator.wake();
  }

  private queue(state: ProjectState, id: string): QueueView {
    const q = state.queues.find((x) => x.id === id);
    if (!q) throw new ActionError(`unknown queue ${id}`, 404);
    return q;
  }

  private sessionFile(state: ProjectState, id: string): SessionFile {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || s.id === USER_SESSION) throw new ActionError(`unknown session ${id}`, 404);
    return s;
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
