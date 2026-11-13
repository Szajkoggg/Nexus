// The queue engine: drives an approved queue step by step through a Nexus-launched session, delivers notes,
// messages and answers to live sessions, and records what the agent does. See docs/DESIGN.md, "Nexus drives the
// queue, step by step". All of its state is in files (run.yaml, runtime.json, delivered.jsonl, activity.jsonl);
// the processes are the only thing a restart loses, and a restart pauses the runs that had one.
import { AcceptedPusher } from "./accepted.ts";
import type { GitRunner } from "./deploy.ts";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ENDED_RUN_STATES,
  ActionError, ProjectStore, USER_SESSION, ensureUserSession, liftByContinue, loadProjectState, stopPlace, newId, normPath, now, readUsage,
  writeUsage, CLAUDE_EFFORTS, RETRY_LIMIT, effortIssue, formatClock, type Effort, type ProjectFile, type StepDef, type InboxView, type ProjectState, type QueueView, type RunFile, type SessionFile,
  type SessionView, type StepView,
  addNote,
} from "@nexus/protocol";
import type { AgentProcess, StreamFacts, TurnFailure } from "./agent.ts";
import { ClaudeSession, nexusDenyRules } from "./claude.ts";
import { CodexSession, gitWritableRoots } from "./codex.ts";

interface Live { proc: AgentProcess; session: string }

export interface StartOptions {
  model?: string; effort?: Effort; session?: string; runtime?: "claude" | "codex";
  /** Started by a chain: the queue whose being done started it (recorded on the run). */
  after?: string;
}

/** A chain: start the queue when another one is done (queues/<id>/start.yaml). */
export interface ChainOptions extends Omit<StartOptions, "after"> { after: string; by: "user" | "orchestrator"; reason?: string }

/** A turn that failed for a passing reason is tried again RETRY_LIMIT times (5), after 1, 2, 4, 8 and 16 minutes. */
export { RETRY_LIMIT };
export const RETRY_BASE_MS = 60_000;
/** A run waiting for the usage window goes on this long after the window's reset. */
export const USAGE_MARGIN_MS = 60_000;

export interface EngineOptions {
  /** The first retry's delay; each further one doubles it. Tests make it short. */
  retryBaseMs?: number;
  usageMarginMs?: number;
  /** How the push of accepted steps runs git, and its time limit (tests). */
  git?: GitRunner;
  pushTimeoutMs?: number;
  /** The clock of the long timers (schedules, usage waits, retries); tests control it. */
  clock?: Clock;
}

/** What the engine's long timers run on: the real clock, or one a test moves. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** A long timer is armed in pieces of at most this (Node's setTimeout fires at once beyond 2^31-1 ms, about 24.8 days). */
export const MAX_TIMER_MS = 24 * 60 * 60_000;
/** A schedule this late (the server was not running at its time) does not start: it is missed. */
export const MISSED_MS = 15 * 60_000;

/** A schedule: at a time (ISO 8601), or "usage-reset". */
export interface ScheduleOptions extends Omit<StartOptions, "after"> { at: string; by: "user" | "orchestrator"; reason?: string }

/**
 * When the usage window of a runtime resets, from the latest usage data: Claude Code's 5-hour window; for Codex, of
 * its windows not yet reset, the last to reset among those at or above the pause threshold (the run waits for all of
 * them), else the first to reset. Undefined while nothing is known.
 */
export function usageReset(runtime: "claude" | "codex", threshold: number, nowMs: number): number | undefined {
  const windows = Object.entries(readUsage()?.windows ?? {})
    .filter(([k, w]) => (runtime === "codex" ? k.startsWith("codex_") : k === "five_hour") && w.resets_at && Date.parse(w.resets_at) > nowMs);
  if (!windows.length) return undefined;
  const full = windows.filter(([, w]) => w.utilization >= threshold).map(([, w]) => Date.parse(w.resets_at!));
  return full.length ? Math.max(...full) : Math.min(...windows.map(([, w]) => Date.parse(w.resets_at!)));
}

/** A process asked to end for a restart (another model or effort) is killed if it has not exited by then. */
export const RESTART_KILL_MS = 10_000;

const RUNTIME_NAME = { claude: "Claude Code", codex: "Codex" } as const;

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

/** States in which a run still goes on by itself. */
const GOING = ["running", "pausing", "usage_wait", "retry_wait"];

export class Engine {
  private readonly live = new Map<string, Live>();   // by Nexus session id
  private readonly store: ProjectStore;
  private readonly changed: () => void;
  private timers = new Map<string, NodeJS.Timeout>();
  /** The long timers (by queue for a retry or usage wait, `start:<queue>` for a schedule), on `clock`. */
  private readonly clockTimers = new Map<string, unknown>();
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
  /** Set while checkStarts runs: a start inside it notifies changes, which must not look again meanwhile. */
  private checkingStarts = false;
  private readonly retryBaseMs: number;
  private readonly usageMarginMs: number;

  constructor(store: ProjectStore, changed: () => void, options: EngineOptions = {}) {
    this.store = store;
    this.changed = changed;
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.usageMarginMs = options.usageMarginMs ?? USAGE_MARGIN_MS;
    this.clock = options.clock ?? REAL_CLOCK;
    this.pusher = new AcceptedPusher(store, changed, { run: options.git, timeout: options.pushTimeoutMs });
    this.recoverAfterRestart();
    // Schedules are armed again; what came due while no server ran is looked at once this one is up.
    for (const id of this.store.queueIds()) {
      const plan = this.store.readStart(id);
      if (plan?.at && !plan.failed) this.armStart(id, Date.parse(plan.at));
    }
    this.timers.set("starts", setTimeout(() => { this.timers.delete("starts"); this.checkStarts(); }, 1500));
  }

  /** Pushes what was accepted (src/accepted.ts). */
  readonly pusher: AcceptedPusher;

  /** "Push again" on a queue whose last push of an accepted step failed. */
  pushAgain(queueId: string): string { return this.pusher.pushAgain(queueId); }

  // ---------------------------------------------------------------- user actions

  start(queueId: string, opts: StartOptions = {}): RunFile {
    if (this.draining) throw new ActionError("Nexus is updating; start the queue after the restart", 409);
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    if (q.rejection) throw new ActionError(rejectedMessage(q), 409);
    if (!q.approved) throw new ActionError("approve the queue's current revision first", 409);
    if (q.run && GOING.includes(q.run.state)) throw new ActionError("the queue is already running", 409);
    if (q.status === "stopped") throw new ActionError(stoppedMessage(q), 409);
    if (q.status === "done" || q.status === "cancelled") throw new ActionError(`the queue is ${q.status}`, 409);
    if (!q.steps.some((s) => s.status !== "done" && s.status !== "skipped")) throw new ActionError("no step left to run", 409);

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
    for (const st of q.steps.filter((x) => x.status !== "done" && x.status !== "skipped")) {
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
    const run: RunFile = {
      protocol: 1, session: session.id, state: "running", started_at: now(), updated_at: now(), revision: q.revision,
      runtime: values.runtime, model: values.model, effort: values.effort, after: opts.after,
    };
    this.store.writeRun(queueId, run);
    this.store.clearStart(queueId); // a planned start is used up by any start
    this.clearClockTimer(`start:${queueId}`);
    this.ensureProcess(session);
    this.advance(queueId);
    return run;
  }

  pause(queueId: string): void {
    const run = this.run(queueId);
    // Also a queue held for an update: the user's pause wins, so the restart does not resume it. A pending retry or
    // usage wait is cancelled.
    if (run.state === "running" || run.state === "usage_wait" || run.state === "retry_wait" || run.resume_after_restart) {
      const working = this.live.get(run.session)?.proc.state === "working";
      this.clearTimer(queueId);
      this.writeRun(queueId, { ...run, state: working ? "pausing" : "paused", reason: "paused by the user", resume_after_restart: undefined, resume_at: undefined });
    }
  }

  /**
   * The user's Continue on a stopped queue: lifts the stop (a `lift` by Continue) and goes on. A run of this revision
   * resumes, reopening the stopped step in its session (unless the orchestrator skipped it: then the next pending
   * one opens). Without a run (an imported stop), or with a finished one or one of an older revision, the queue
   * starts afresh at its first pending step.
   */
  continueQueue(queueId: string): string {
    if (this.draining) throw new ActionError("Nexus is updating; continue the queue after the restart", 409);
    const lift = liftByContinue(this.store, queueId);
    const run = this.store.readRun(queueId);
    const q = this.queue(loadProjectState(this.store), queueId);
    const older = run && (run.revision !== undefined ? run.revision < q.revision : q.history.some((h) => h.replaced_at > run.started_at));
    if (!run || run.state === "finished" || older) {
      const started = this.start(queueId);
      return `the stop is lifted; queue ${queueId} starts at its first pending step in session ${started.session}`;
    }
    this.resume(queueId, `the user lifted the stop with Continue${lift.reason ? `; the stop was: ${lift.reason}` : ""}`);
    return `the stop is lifted; queue ${queueId} goes on in session ${run.session}`;
  }

  /** `why`: said to the agent when the step is continued (a retry after a failed turn, a lifted stop). */
  resume(queueId: string, why?: string): void {
    const run = this.run(queueId);
    if (run.state === "running") return;
    if (run.state === "finished") throw new ActionError("the run is finished", 409);
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    if (q.rejection) throw new ActionError(rejectedMessage(q), 409);
    if (!q.approved) throw new ActionError("approve the queue's current revision first", 409);
    if (q.status === "stopped") throw new ActionError(stoppedMessage(q), 409);
    if (q.status === "cancelled") throw new ActionError(`queue ${q.id} is cancelled`, 409);
    // A run of an older revision would reopen a step the new revision may have replaced, in the old session. A run
    // without the field is older when a revision was replaced after it started. A run paused by a rejection is the
    // exception: the approved revision dealt with it, and the run goes on at its first pending step.
    const older = run.revision !== undefined ? run.revision < q.revision : q.history.some((h) => h.replaced_at > run.started_at);
    if (older && !run.rejected) throw new ActionError(`the run belongs to revision ${run.revision ?? "an earlier one"} and the queue is at revision ${q.revision}: start the queue instead of resuming`, 409);
    const session = this.sessionFile(state, run.session);
    this.ensureProcess(session);
    this.clearTimer(queueId);
    this.writeRun(queueId, { ...run, state: "running", reason: undefined, nudged: false, resume_after_restart: undefined, resume_at: undefined, ...(run.rejected ? { rejected: undefined, revision: q.revision } : {}) });
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
      const working = this.live.get(run.session)?.proc.state === "working";
      const reason = "the Nexus server is updating; it goes on by itself afterwards";
      this.writeRun(id, { ...run, state: working && !now ? "pausing" : "paused", reason, resume_after_restart: true });
      held.push(id);
    }
    if (now) for (const [, l] of this.live) if (l.proc.state === "working") { this.ending.add(l.session); l.proc.kill(); }
    return held;
  }

  /** No agent of this project is in the middle of a turn. */
  idle(): boolean {
    return ![...this.live.values()].some((l) => l.proc.state === "working");
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
      if (!run?.resume_after_restart) continue;
      if (run.state === "pausing") this.writeRun(id, { ...run, state: "running", reason: undefined, resume_after_restart: undefined });
      else if (run.state === "paused") { try { this.resume(id); } catch (e) { this.halt(id, (e as Error).message); } }
    }
    this.checkStarts();
  }

  /** Interrupts the running turn and pauses the run. */
  stopNow(queueId: string, text?: string): void {
    const run = this.run(queueId);
    const live = this.live.get(run.session);
    this.clearTimer(queueId);
    this.writeRun(queueId, { ...run, state: "paused", reason: "stopped by the user", resume_after_restart: undefined, resume_at: undefined });
    if (live && live.proc.state === "working") {
      live.proc.send(
        `[Nexus] The user asks you to stop now${text ? `: ${text}` : "."} Leave the work in a consistent state, record where you are with \`nexus step progress\`, and end your turn. Do not start anything new.`,
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
      this.writeRun(queueId, { ...run, state: "paused", reason: `step ${step} was rejected by the user${why ? `: ${why}` : ""}`, rejected: step, resume_after_restart: undefined, resume_at: undefined });
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
    for (const [, l] of this.live) this.deliverInbox(state, l);
    for (const q of state.queues) if (q.run && (q.run.state === "running" || q.run.state === "pausing")) this.advance(q.id, state);
    this.checkStarts();
  }

  // ---------------------------------------------------------------- planned starts: chains and schedules

  /**
   * Plans to start `queueId` when queue `o.after` is done. When it already is, the queue starts now (or, while an
   * update drains, right after it). Replaces an earlier plan of the queue. Returns what happened, in a sentence.
   */
  chain(queueId: string, o: ChainOptions): string {
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    const a = state.queues.find((x) => x.id === o.after);
    if (!a) throw new ActionError(`unknown queue ${o.after}`, 404);
    if (a.id === q.id) throw new ActionError("a queue cannot start after itself");
    const options = this.planOptions(state, q, o);
    if (a.status === "cancelled") throw new ActionError(`queue ${a.id} is cancelled: it will never be done`, 409);
    // No loop: following the plans from A must not come back to this queue.
    for (let at: string | undefined = a.id, seen = new Set<string>(); at && !seen.has(at); seen.add(at), at = this.store.readStart(at)?.after) {
      if (at === q.id) throw new ActionError(`queue ${a.id} already waits for ${q.id} (through its planned starts): that would be a loop`, 409);
    }
    const busy = o.session ? state.queues.find((x) => x.id !== q.id && !!x.run && x.run.session === o.session && GOING.includes(x.run.state)) : undefined;
    if (a.status === "done" && !this.draining && !busy) {
      const run = this.start(q.id, { ...options, after: a.id });
      return `queue ${a.id} is already done: queue ${q.id} started now in session ${run.session}`;
    }
    this.clearClockTimer(`start:${q.id}`);
    this.store.writeStart(q.id, {
      protocol: 1, after: a.id, ...options, by: o.by, reason: o.reason, revision: q.revision, created_at: now(),
    });
    this.changed();
    if (a.status !== "done") return `queue ${q.id} starts when queue ${a.id} is done`;
    return busy ? `queue ${q.id} starts when session ${o.session} is free (it runs queue ${busy.id}; queue ${a.id} is done)`
      : `queue ${q.id} starts after the Nexus update (queue ${a.id} is done)`;
  }

  /**
   * Plans to start `queueId` at a time (`o.at`, ISO 8601, in the future), or when the usage window of the runtime it
   * would run on resets (`o.at` = "usage-reset"; refused while no usage data of that runtime is known). Replaces an
   * earlier plan of the queue. Returns what happened, in a sentence.
   */
  scheduleStart(queueId: string, o: ScheduleOptions): string {
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    const options = this.planOptions(state, q, o);
    let at: number;
    let usage: "claude" | "codex" | undefined;
    if (o.at === "usage-reset") {
      const s = o.session ? state.sessions.find((x) => x.id === o.session) : undefined;
      usage = s ? (s.runtime === "codex" ? "codex" : "claude") : o.runtime ?? state.project.runtimes.default;
      const reset = usageReset(usage, state.project.defaults.usage_pause_threshold, this.clock.now());
      if (!reset) throw new ActionError(`no usage window of ${RUNTIME_NAME[usage]} is known yet (Nexus learns them from a run): give a time instead`, 409);
      at = reset + this.usageMarginMs;
    } else {
      at = Date.parse(o.at);
      if (Number.isNaN(at)) throw new ActionError(`not a time: ${o.at}`);
      if (at < this.clock.now() - 60_000) throw new ActionError(`${o.at} is in the past`);
    }
    const iso = new Date(at).toISOString();
    this.store.writeStart(q.id, {
      protocol: 1, at: iso, usage, ...options, by: o.by, reason: o.reason, revision: q.revision, created_at: now(),
    });
    this.armStart(q.id, at);
    this.changed();
    return `queue ${q.id} starts at ${formatClock(iso, new Date(this.clock.now()))}${usage ? ` (when the ${RUNTIME_NAME[usage]} usage window resets)` : ""}`;
  }

  /** Cancels the planned start of a queue. */
  cancelStart(queueId: string): string {
    const plan = this.store.readStart(queueId);
    if (!plan) throw new ActionError(`queue ${queueId} has no planned start`, 409);
    this.store.clearStart(queueId);
    this.clearClockTimer(`start:${queueId}`);
    this.changed();
    return `the planned start of queue ${queueId} (${plan.after ? `after ${plan.after}` : `at ${formatClock(plan.at!, new Date(this.clock.now()))}`}) is cancelled`;
  }

  /** What every planned start checks: the queue can be planned, and the start's options make sense. */
  private planOptions(state: ProjectState, q: QueueView, o: Omit<StartOptions, "after">): Pick<StartOptions, "runtime" | "model" | "effort" | "session"> {
    if (q.status === "done" || q.status === "cancelled") throw new ActionError(`queue ${q.id} is ${q.status}`, 409);
    if (q.run && GOING.includes(q.run.state)) throw new ActionError(`queue ${q.id} is already running`, 409);
    const runtime = o.session ? undefined : o.runtime ?? state.project.runtimes.default;
    const issue = runtime ? effortIssue(runtime, o.effort) : undefined;
    if (issue) throw new ActionError(issue);
    if (o.session) {
      const s = state.sessions.find((x) => x.id === o.session);
      if (!s || s.role !== "worker" || s.launched_by !== "nexus" || s.runtime === "external") throw new ActionError(`session ${o.session} is not a worker session Nexus launched`, 409);
    }
    return { runtime: o.session ? undefined : o.runtime, model: o.model, effort: o.effort, session: o.session };
  }

  /** Arms the timer of a scheduled start (in pieces of at most a day); when it comes, the plans are looked at. */
  private armStart(queueId: string, at: number): void {
    this.wakeAt(`start:${queueId}`, at, () => { this.checkStarts(); this.changed(); });
  }

  /**
   * Starts each queue whose planned start is due: a chain's queue is done, or a schedule's time has come. Not while an
   * update drains (the plans stay, and the next server or cancelDrain looks again). A chain whose session to continue
   * is busy waits for it to free (one session never runs two queues); a schedule does not wait: its session busy, it
   * fails. A schedule more than MISSED_MS late (the server was not running) does not start: it is `missed`. A start
   * that fails (the queue not approved, stopped, …) is recorded on the plan as `failed`, an item waiting for the user
   * (a missed one is told to the orchestrator too); it is not tried again by itself.
   */
  private checkStarts(): void {
    if (this.stopped || this.draining || this.checkingStarts) return;
    this.checkingStarts = true;
    try {
      const state = loadProjectState(this.store);
      const t = this.clock.now();
      for (const q of state.queues) {
        const plan = q.start;
        if (!plan || plan.failed) continue;
        const { waiting: _w, blocked: _b, ...file } = plan;
        const fail = (reason: string, missed?: boolean) => this.store.writeStart(q.id, { ...file, failed: { at: now(), reason, missed } });
        const busy = plan.session ? state.queues.find((x) => x.id !== q.id && !!x.run && x.run.session === plan.session && GOING.includes(x.run.state)) : undefined;
        if (plan.after) {
          if (state.queues.find((x) => x.id === plan.after)?.status !== "done" || busy) continue;
        } else {
          const at = Date.parse(plan.at!);
          if (t < at) continue;
          if (t - at > MISSED_MS) { fail(`missed: Nexus was not running at ${formatClock(plan.at!, new Date(t))}`, true); continue; }
          if (busy) { fail(`session ${plan.session} was running queue ${busy.id}`); continue; }
        }
        try {
          const run = this.start(q.id, { runtime: plan.runtime, model: plan.model, effort: plan.effort, session: plan.session, after: plan.after });
          this.store.appendActivity(run.session, { at: now(), kind: "turn_start", text: `Nexus started queue ${q.id}: ${plan.after ? `queue ${plan.after} is done` : "its scheduled time came"}`, queue: q.id });
        } catch (e) { fail((e as Error).message); }
      }
    } finally { this.checkingStarts = false; }
  }

  /** Activity of a session, optionally only what was tagged with a step. */
  activity(session: string, queue?: string, step?: string, limit = 300) {
    const items = this.store.readActivity(session).entries.filter((a) => (!queue || a.queue === queue) && (!step || a.step === step));
    return items.slice(-limit);
  }

  shutdown(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const t of this.clockTimers.values()) this.clock.clearTimeout(t);
    this.clockTimers.clear();
    for (const [, l] of this.live) l.proc.kill();
  }

  /** A process of this engine's is still running (after shutdown: not yet exited). */
  alive(): boolean {
    return [...this.live.values()].some((l) => l.proc.state !== "exited");
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
    const live = this.live.get(run.session);
    if (!live || live.proc.state === "exited") return this.halt(queueId, "the session's process is not running");
    if (live.proc.state === "working") return;
    if (!q.approved) return this.halt(queueId, "the queue's revision changed and is not approved");

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
          live.proc.send(`[Nexus] Your turn ended, but step ${current.id} has no outcome yet. Continue the step if work remains; otherwise report it with \`nexus step done ${current.id} --summary "…"\`, \`nexus step failed\`, \`nexus stop\`, or ask with \`nexus ask\` and end your turn.`);
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

    const next = q.steps.find((s) => s.status === "pending");
    if (!next) {
      // Also when pausing (for the user or an update): nothing is left to pause before.
      this.writeRun(queueId, { ...run, state: "finished", reason: undefined, resume_after_restart: undefined, retries: undefined });
      this.ending.add(run.session);
      live.proc.close();
      return;
    }
    if (run.state === "pausing") return this.writeRun(queueId, { ...run, state: "paused" });
    const want = stepValues(this.runValues(state, run), next, state.project);
    const issue = effortIssue(want.runtime, want.effort);
    if (issue) return this.halt(queueId, `step ${next.id}: ${issue}`);
    const wait = this.usageWait(state, want.runtime);
    if (wait) {
      this.writeRun(queueId, { ...run, state: "usage_wait", reason: wait.reason, resume_at: wait.until });
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
        const because = why === "runtime" ? `step ${next.id} runs on ${RUNTIME_NAME[want.runtime]}` : `this session's context is ${Math.round(fill! * 100)}% full`;
        this.writeRun(queueId, { ...run, summary_asked: done.id });
        live.proc.send(`[Nexus] Step ${done.id} is over, and ${because}: the next step runs in a fresh session. Before that, write your context summary with \`nexus context "<what a successor needs to know>" --topics a,b --files x,y\` (what was decided and why, where things are, what is still open), then end your turn. Do not start anything else.`);
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
    const because = why === "runtime"
      ? `step ${next.id} runs on ${RUNTIME_NAME[want.runtime]}, and the session that ran the queue so far is a ${RUNTIME_NAME[old.runtime as "claude" | "codex"]} session`
      : `the session that ran the queue so far had its context ${Math.round(fill! * 100)}% full`;
    this.writeRun(queueId, {
      ...run, session: fresh.id, summary_asked: undefined,
      switches: [...(run.switches ?? []), { at: now(), from: old.id, to: fresh.id, step: next.id, why, fill, summary: source }],
    });
    this.store.appendActivity(old.id, { at: now(), kind: "turn_end", text: `Nexus goes on in a fresh session (${fresh.id}): ${because}`, queue: queueId, step: done?.id ?? next.id });
    for (const m of unread) this.store.appendDelivered(old.id, { at: now(), kind: "inbox", id: m.id, via: "carried", to: fresh.id });
    const state = loadProjectState(this.store);
    this.ensureProcess(fresh);
    const summary = source === "fallback" ? undefined : old.context;
    const seed = [
      `[Nexus] You take over queue ${q.id} "${q.title}" in a fresh session: ${because}. You have not seen its work, only what follows.`,
      summary && done
        ? `\nIts context summary at the end of ${done.id}:\n${summary.text}${summary.topics.length ? `\nTopics: ${summary.topics.join(", ")}` : ""}${summary.files.length ? `\nFiles: ${summary.files.join(", ")}` : ""}`
        : `\nIt left no context summary${done ? ` of ${done.id}` : ""}; the queue's description and its finished steps' summaries below are what there is.`,
      `\nThe queue${q.description ? `:\n${q.description.trim()}` : ` has no description.`}`,
      `\nIts steps:\n${q.steps.map((s) => `- ${s.id} ${s.title}: ${s.id === next.id ? "yours now" : s.status}${s.summary ? `. ${s.summary}` : ""}`).join("\n")}`,
    ].join("\n");
    const carried = unread.length
      ? `Messages that came for the previous session and were not read yet:\n\n${unread.map((m) => formatInbox(m, state)).join("\n\n")}`
      : undefined;
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
    const live = this.live.get(run.session);
    if (!live) return this.halt(queueId, "the session's process is not running");
    const state = loadProjectState(this.store);
    const project = state.project;
    const notes = step.notes.filter((n) => !n.read_at);
    const answers = state.questions.filter((x) => x.session === run.session && x.step === step.id && x.state === "answered");
    const last = !q.steps.some((s) => s.status === "pending" && s.id !== step.id);
    const index = q.steps.findIndex((s) => s.id === step.id);
    const lines = [
      `[Nexus] Queue ${q.id} "${q.title}" (revision ${q.revision}, approved), step ${step.id} (${index + 1} of ${q.steps.length}): ${step.title}.`,
      mode === "continue" ? `Continue this step where it was left${why ? ` (${why})` : step.reason ? ` (it was left: ${step.reason})` : ""}.` : "",
      step.goal ? `\nGoal:\n${step.goal}` : "",
      step.acceptance.length ? `\nAcceptance:\n${step.acceptance.map((a) => `- ${a}`).join("\n")}` : "",
      q.checks.length ? `\nChecks for every step:\n${q.checks.map((c) => `- ${c}`).join("\n")}` : "",
      step.review?.prepare ? `\nReview to prepare: ${step.review.prepare}` : "",
      `\nStop conditions (meeting one ends the queue: report it with \`nexus stop\`):\n${[...q.stop_conditions, ...project.defaults.stop_conditions].map((c) => `- ${c}`).join("\n") || "- none beyond your judgement"}`,
      notes.length ? `\nNotes from the user for this step:\n${notes.map((n) => `- ${n.body}`).join("\n")}` : "",
      answers.length ? `\nAnswers to your questions about this step:\n${answers.map((x) => `- "${x.text}": ${x.answers.at(-1)?.text}`).join("\n")}` : "",
      `\nBegin with \`nexus step start ${step.id}\`${mode === "continue" ? " (again is fine)" : ""}. End with \`nexus step done ${step.id} --summary "…"\`, \`nexus step failed\` or \`nexus stop\`, then write \`nexus context\` and end your turn. Do not start another step.`,
      last ? `\nThis is the queue's last step. After it is done, write a short report of the whole queue (what each step achieved against its acceptance, checks, review material, open questions, a proposed next step) to ${join(this.store.queueDir(q.id), "report.md").replaceAll("\\", "/")} and register it with \`nexus report ${q.id} --file <that path> --summary "…"\`.` : "",
    ].filter(Boolean);
    live.proc.send([around.before, lines.join("\n"), around.after].filter(Boolean).join("\n\n"));
    for (const n of notes) this.store.appendDelivered(run.session, { at: now(), kind: "note", id: n.id, via: "turn" });
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
      this.store.appendDelivered(l.session, { at: now(), kind: "inbox", id: m.id, via: l.proc.state === "working" ? "inject" : "turn" });
    }
  }

  private halt(queueId: string, reason: string): void {
    const run = this.store.readRun(queueId);
    if (!run || run.state === "halted") return;
    this.clearTimer(queueId);
    this.writeRun(queueId, { ...run, state: "halted", reason, resume_after_restart: undefined, resume_at: undefined });
  }

  /** The queue has no step left: every step is done or skipped. */
  private nothingLeft(queueId: string): boolean {
    const q = loadProjectState(this.store).queues.find((x) => x.id === queueId);
    return !!q && q.steps.length > 0 && q.steps.every((s) => s.status === "done" || s.status === "skipped");
  }

  /** Ends a going run as finished (its last step is done). */
  private finish(queueId: string): void {
    const run = this.store.readRun(queueId);
    if (!run || (run.state !== "running" && run.state !== "pausing")) return;
    this.clearTimer(queueId);
    this.writeRun(queueId, { ...run, state: "finished", reason: undefined, retries: undefined, failure: undefined, resume_at: undefined });
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
      return this.writeRun(queueId, { ...run, state: "paused", reason: `paused by the user; the last turn failed (${what})` });
    }
    if (f.kind === "lasting") { this.writeRun(queueId, { ...run, failure: f.code }); return this.halt(queueId, `the turn failed (${what})`); }
    if (f.kind === "usage" && f.resetsAt) {
      this.writeRun(queueId, { ...run, state: "usage_wait", reason: `the usage limit was reached (${what}); goes on when it resets`, resume_at: f.resetsAt, resume_after_restart: undefined });
      this.schedule(queueId, f.resetsAt, this.usageMarginMs);
      return;
    }
    const tries = (run.retries ?? 0) + 1;
    if (tries > RETRY_LIMIT) { this.writeRun(queueId, { ...run, failure: f.code }); return this.halt(queueId, `the turn failed ${tries} times in a row; the last time: ${what}`); }
    const at = new Date(this.clock.now() + this.retryBaseMs * 2 ** (tries - 1)).toISOString();
    this.writeRun(queueId, { ...run, state: "retry_wait", retries: tries, failure: f.code, reason: `the turn failed (${what}); retry ${tries} of ${RETRY_LIMIT}`, resume_at: at });
    this.store.appendActivity(run.session, { at: now(), kind: "retry", text: `Nexus tries the turn again at ${formatClock(at, new Date())} (${tries} of ${RETRY_LIMIT}): ${what}`, queue: queueId, step: run.step });
    this.schedule(queueId, at, 0);
  }

  // ---------------------------------------------------------------- sessions and processes

  private newSession(state: ProjectState, q: QueueView, runtime: "claude" | "codex", model?: string, effort?: Effort): SessionFile {
    if (runtime === "claude" && effort && !CLAUDE_EFFORTS.includes(effort)) throw new ActionError(`Claude Code takes effort ${CLAUDE_EFFORTS.join(", ")}`);
    const cwd = this.worktreeFor(state, q);
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
    const busy = state.queues.find((q) => q.id !== queueId && q.run?.session === id && GOING.includes(q.run.state));
    if (busy) throw new ActionError(`that session is running queue ${busy.id}`, 409);
    if (s.runtime === "claude" && effort && !CLAUDE_EFFORTS.includes(effort)) throw new ActionError(`Claude Code takes effort ${CLAUDE_EFFORTS.join(", ")}`);
    const updated: SessionFile = { ...s, queue: queueId, model, effort };
    this.store.writeSession(updated);
    return updated;
  }

  private ensureProcess(session: SessionFile): Live {
    const existing = this.live.get(session.id);
    if (existing && existing.proc.state !== "exited") {
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
    const env = { NEXUS_SESSION: session.id, NEXUS_DIR: this.store.dir };
    let proc: AgentProcess;
    if (session.runtime === "codex") {
      const codex = project.runtimes.codex;
      const inside = normPath(this.store.dir).toLowerCase().startsWith(normPath(session.cwd).toLowerCase() + "/");
      proc = new CodexSession({
        cwd: session.cwd, model: session.model ?? codex.model, effort: session.effort ?? codex.effort, instructions: WORKER_BRIEFING, env,
        threadId: session.native_id, sandbox: codex.sandbox, approvalPolicy: codex.approval_policy, approvalsReviewer: codex.approvals_reviewer,
        writableRoots: [...(inside ? [] : [this.store.dir]), ...gitWritableRoots(session.cwd)],
      });
    } else {
      const claude = project.runtimes.claude;
      const transcriptExists = this.store.readRuntime(session.id) !== undefined; // started before: resume it
      proc = new ClaudeSession({
        cwd: session.cwd,
        uuid: session.native_id!,
        resume: transcriptExists,
        model: session.model ?? claude.model,
        effort: session.effort ?? claude.effort,
        permissionMode: claude.permission_mode,
        allowedTools: ["Bash(nexus:*)", ...claude.allowed_tools],
        // The project's .nexus is the server's (and the CLI's) to write, not the worker's file tools'. Its absolute
        // path: the worker's cwd may be a worktree whose own .nexus does not exist.
        disallowedTools: project.defaults.protect_nexus ? nexusDenyRules(this.store.dir) : undefined,
        appendSystemPrompt: WORKER_BRIEFING,
        env,
      });
    }
    const l: Live = { proc, session: session.id };
    this.live.set(session.id, l);
    this.writeRuntime(session.id, { state: "idle", pid: proc.pid });

    const tag = () => {
      // The run that drives the session now; a session continued from an earlier queue still has that one's run too.
      const runs = this.store.queueIds().map((q) => [q, this.store.readRun(q)] as const).filter(([, r]) => r?.session === session.id);
      const run = runs.find(([, r]) => GOING.includes(r!.state)) ?? runs.sort(([, a], [, b]) => b!.updated_at.localeCompare(a!.updated_at))[0];
      return run ? { queue: run[0], step: run[1]?.step } : {};
    };
    proc.on("activity", (a) => this.store.appendActivity(session.id, { at: now(), ...a, ...tag() }));
    proc.on("facts", (f) => this.facts(session.id, f));
    proc.on("refusal", (r) => {
      // One record per refusal, also across processes of the session (a resumed runtime may repeat its list).
      if (r.ref && this.store.readRefusals(session.id).entries.some((x) => x.ref === r.ref)) return;
      this.store.appendRefusal({ at: now(), session: session.id, runtime: session.runtime === "codex" ? "codex" : "claude", ...r, ...tag() });
      this.changed();
    });
    const runsOf = () => this.store.queueIds().filter((q) => this.store.readRun(q)?.session === session.id);
    proc.on("turnEnd", (end) => {
      this.writeRuntime(session.id, { state: "idle", turns: (this.store.readRuntime(session.id)?.turns ?? 0) + 1 });
      // A failed turn is decided at once and is not a turn without an outcome.
      if (end.failure) { for (const q of runsOf()) this.turnFailed(q, end.failure); this.changed(); return; }
      if (end.ok) for (const q of runsOf()) { const r = this.store.readRun(q); if (r?.retries) this.writeRun(q, { ...r, retries: undefined, failure: undefined }); }
      // Let the CLI's last events land in the files, then decide.
      setTimeout(() => { for (const q of this.store.queueIds()) if (this.store.readRun(q)?.session === session.id) this.advance(q); this.changed(); }, 300);
    });
    proc.on("exit", (code) => {
      // Ended by Nexus (shutdown, the hand-over of an update, an update's drain with `now`, a finished run): no
      // failure. Any other exit is a crash, and the turn is tried again on a new process that resumes the session.
      const byNexus = this.stopped || this.ending.delete(session.id);
      this.writeRuntime(session.id, { state: "exited" });
      this.store.appendActivity(session.id, { at: now(), kind: code === 0 || byNexus ? "exit" : "error", text: `process exited (${code ?? "signal"})${byNexus ? ", ended by Nexus" : ""}`, ...tag() });
      if (this.live.get(session.id) === l) this.live.delete(session.id);
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
    });
    return l;
  }

  private facts(session: string, f: StreamFacts): void {
    const patch: Record<string, unknown> = {};
    if (f.model) patch.model = f.model;
    if (f.contextTokens !== undefined) patch.context_tokens = f.contextTokens;
    if (f.contextWindow) patch.context_window = f.contextWindow;
    if (f.costUsd !== undefined) patch.cost_usd = f.costUsd;
    if (f.contextTokens !== undefined || f.model) patch.state = "working";
    if (Object.keys(patch).length) this.writeRuntime(session, patch);
    if (f.usage) writeUsage({ updated_at: now(), windows: { ...readUsage()?.windows, ...f.usage } });
    if (f.nativeId) {
      const s = this.store.readSession(session);
      if (s.native_id !== f.nativeId) this.store.writeSession({ ...s, native_id: f.nativeId });
    }
  }

  private writeRuntime(session: string, patch: Record<string, unknown>): void {
    const old = this.store.readRuntime(session);
    this.store.writeRuntime(session, { turns: 0, state: "idle", ...old, ...patch, updated_at: now() } as never);
  }

  /** A queue's working directory: its worktree (created when it says `auto`), else the project's checkout. */
  private worktreeFor(state: ProjectState, q: QueueView): string {
    if (q.worktree && q.worktree !== "auto") return normPath(q.worktree);
    if (q.worktree !== "auto") return normPath(state.project.root);
    const root = state.project.root;
    const dir = normPath(state.project.defaults.worktree_dir ?? join(dirname(root), `${basename(root)}.worktrees`));
    const path = normPath(join(dir, q.id));
    const branch = q.branch ?? `nexus/${q.id}`;
    if (!existsSync(path)) {
      const exists = (() => { try { execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root, stdio: "ignore" }); return true; } catch { return false; } })();
      const args = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, q.base ?? "HEAD"];
      try { execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { throw new ActionError(`could not create the worktree: ${(e as { stderr?: Buffer }).stderr?.toString().trim() || (e as Error).message}`, 500); }
    }
    this.store.writeQueue({ ...this.store.readQueue(q.id), worktree: path, branch, updated_at: now() });
    return path;
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
    this.wakeAt(queueId, due, () => {
      const run = this.store.readRun(queueId);
      if (this.stopped || this.draining || (run?.state !== "usage_wait" && run?.state !== "retry_wait")) return;
      const why = run.state === "retry_wait" ? `the last turn failed: ${run.reason ?? "a passing failure"}; this is the retry` : undefined;
      try { this.resume(queueId, why); } catch (e) { this.halt(queueId, `could not go on: ${(e as Error).message}`); }
      this.changed();
    });
  }

  /**
   * Calls `fire` at `at` (ms since the epoch, on the engine's clock), under `key` (replacing what was armed there). The
   * timer is armed in pieces of at most MAX_TIMER_MS, each re-checking the clock, so a time weeks ahead neither fires
   * at once (as setTimeout does beyond 2^31-1 ms) nor early.
   */
  private wakeAt(key: string, at: number, fire: () => void): void {
    this.clearClockTimer(key);
    const piece = Math.max(0, Math.min(at - this.clock.now(), MAX_TIMER_MS));
    this.clockTimers.set(key, this.clock.setTimeout(() => {
      this.clockTimers.delete(key);
      if (this.stopped) return;
      if (this.clock.now() >= at) fire(); else this.wakeAt(key, at, fire);
    }, piece));
  }

  private clearClockTimer(key: string): void {
    if (this.clockTimers.has(key)) this.clock.clearTimeout(this.clockTimers.get(key));
    this.clockTimers.delete(key);
  }

  /** A queue's retry or usage-wait timer. */
  private clearTimer(queueId: string): void { this.clearClockTimer(queueId); }

  // ---------------------------------------------------------------- helpers

  private recoverAfterRestart(): void {
    const state = loadProjectState(this.store);
    for (const q of this.store.queueIds()) {
      const run = this.store.readRun(q);
      const left = state.queues.find((x) => x.id === q)?.steps.some((s) => s.status !== "done" && s.status !== "skipped");
      if (run && (["running", "pausing"].includes(run.state) || run.resume_after_restart) && left === false) {
        // Its last step was done before the server stopped: the run is over, whatever stopped the process.
        this.writeRun(q, { ...run, state: "finished", reason: undefined, resume_after_restart: undefined, retries: undefined });
      } else if (run?.state === "retry_wait" && run.resume_at) {
        // A retry pending at the restart (held by an update or not) is made when it is due.
        this.schedule(q, run.resume_at, 0);
      } else if (run?.resume_after_restart) {
        // Held for an update: resumed shortly, once this server is up.
        this.writeRun(q, { ...run, state: "paused", reason: "resuming after the Nexus update" });
        this.timers.set(`recover:${q}`, setTimeout(() => {
          this.timers.delete(`recover:${q}`);
          const r = this.store.readRun(q);
          if (!r?.resume_after_restart) return;
          try { this.resume(q); } catch (e) { this.halt(q, `could not resume after the update: ${(e as Error).message}`); }
          this.changed();
        }, 1500));
      } else if (run && ["running", "pausing"].includes(run.state)) {
        this.writeRun(q, { ...run, state: "paused", reason: "the Nexus server restarted; resume to continue" });
      }
      if (run?.state === "usage_wait" && run.resume_at) this.schedule(q, run.resume_at, this.usageMarginMs);
    }
    for (const s of this.store.sessionIds()) {
      const r = this.store.readRuntime(s);
      if (!r || r.state === "exited") continue;
      // A process the previous server left behind (killed without its shutdown) would write into the same
      // session as the one a resume starts: end it first.
      if (r.pid && isAlive(r.pid)) { try { process.kill(r.pid); } catch { /* gone or not ours */ } }
      this.writeRuntime(s, { state: "exited" });
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

/** Why a queue with a rejected step does not go on, and what lets it. */
function rejectedMessage(q: QueueView): string {
  return `step ${q.rejection!.step} of queue ${q.id} was rejected: the run goes on once you approve a new revision of the queue that deals with it (the orchestrator proposes one)`;
}

/** Why a stopped queue does not go on: where the stop is and its own reason, and the user's two ways out. */
function stoppedMessage(q: QueueView): string {
  return `queue ${q.id} is stopped${stopPlace(q)}: ${q.status_reason ?? "a stop condition was met"}. Only the user lifts a stop: with Continue in the dashboard, or by approving a new revision of the queue`;
}

function formatInbox(m: InboxView, state: ProjectState): string {
  if (m.type === "answer") {
    const q = state.questions.find((x) => x.qid === m.qid);
    const how = m.continue === false ? " Wait for further word before going on." : "";
    return `[Nexus] Answer from the ${m.from} to your question${q ? ` "${q.text}"` : ""}:\n${m.text}${how}`;
  }
  if (m.type === "message") return `[Nexus] Message from the ${m.from}${m.step ? ` about step ${m.step}` : ""}:\n${m.text}`;
  if (m.type === "send_back") {
    const step = state.queues.find((q) => q.id === m.queue)?.steps.find((s) => s.id === m.step);
    const lines = m.from === "user"
      ? [
        `[Nexus] The user sent step ${m.step} of queue ${m.queue} back to you (round ${m.round}). What the user wants:`,
        m.text,
        `The user's words win over the step's acceptance criteria where they conflict; the rest of the criteria still hold.`,
      ]
      : [`[Nexus] The orchestrator reviewed step ${m.step} of queue ${m.queue} and sent it back to you (round ${m.round}). What to fix:`, m.text];
    return [
      ...lines,
      step?.acceptance.length ? `\nAcceptance criteria of the step:\n${step.acceptance.map((a) => `- ${a}`).join("\n")}` : "",
      `\nWork on it in this step: \`nexus step start ${m.step}\`, then the checks, review material for this round (\`nexus review add ${m.step} … --round ${m.round}\`), and \`nexus step done ${m.step} --summary "…"\` (or \`nexus step failed\` / \`nexus stop\`), then \`nexus context\`, and end your turn.`,
    ].filter(Boolean).join("\n");
  }
  return `[Nexus] The ${m.from} asks you to stop now${m.text ? `: ${m.text}` : "."} Leave the work consistent and end your turn.`;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function gitBranch(cwd: string): string | null {
  try { return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

const WORKER_BRIEFING = `You are a worker session run by Nexus, the dashboard through which the user follows and steers your work.
Nexus sends you one step of an approved queue at a time. Work on that step only; when its outcome is reported, end your turn: Nexus opens the next step.
Report through the \`nexus\` command (on PATH; your session is set in the environment as NEXUS_SESSION):
- nexus step start <step>                                   when you begin a step
- nexus step progress <step> "<short status>" [--pct N]     at milestones, so the user sees where you are
- nexus review add <step> <file|url>... --label "..."       review material (pictures, sheets, reports)
- nexus check <step> <name> --ok|--fail --summary "..."      results of the step's checks
- nexus step done <step> --summary "..." [--commit <sha>]   when the acceptance criteria are met
- nexus step failed <step> --reason "..."                   when the step cannot be done as written
- nexus stop <step> --condition "..." --reason "..."        when a stop condition is met
- nexus ask "<question>" --step <step> [--can-continue]     a question for the orchestrator or the user; without --can-continue, end your turn after asking: the answer arrives as a message
- nexus context "<what a successor needs to know>" --topics a,b --files x,y   at the end of each step
Messages from the user may arrive while you work, marked [Nexus]; follow them.`;

