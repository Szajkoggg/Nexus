// The queue engine: drives an approved queue step by step through a Nexus-launched session, delivers notes,
// messages and answers to live sessions, and records what the agent does. See docs/design/overview.md, "Nexus drives the
// queue, step by step". All of its state is in files (run.yaml, runtime.json, delivered.jsonl, activity.jsonl);
// the processes are the only thing a restart loses, and a restart pauses the runs that had one.
import { changedFiles, checkoutOf, checkoutStatus, git as gitRead, headOnce, ownWorktree, recordStepEnd, recordStepStart, recordTurn, revParse } from "./gitinfo.ts";
import { AcceptedPusher } from "./accepted.ts";
import type { GitRunner } from "./deploy.ts";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  runCounted, runHoldsCheckout, runEnded, runGoing,
  ActionError, INTEGRATION_CONDITION, NEXUS_SESSION, ProjectStore, USER_SESSION, acceptedByNexus, ensureNexusSession, fileList, ensureUserSession, lastDone, stepChecks, liftByContinue, loadProjectState, openPlanFile, releaseOrphanedSteps, stepClosed, reportFile, ensureReportFolder, newId, normPath, now, readUsage,
  RETRY_LIMIT, START_KEYS, chooseRoute, contextBeyond, effortIssue, formatClock, kindDefaults, overThreshold, routeStep, runStart, type Effort, type Routed, type ProjectFile, type StartValues, type ProjectState, type QueueView, type RunFile, type SessionFile,
  type SessionView, type StepView, type PlanBy,
  addNote,
} from "@nexus/protocol";
import { reachable, type TurnFailure } from "./agent.ts";
import { AgentHost, ROLE_RECORDS, type AgentHostOptions, type Hosted, type Launch } from "./agent-host.ts";
import { nexusDenyRules } from "./claude.ts";
import {
  RUNTIME_NAME, carriedMessages, midStepSeed, formatInbox, withLanguages, workerBriefing, workerLanguages, freshSessionSeed, modelFreeFixPreface, noOutcomeNudge, stepOpening, summaryReason,
  summaryRequest, switchReason, userStopNow, type ContextSize, type PullText,
} from "./prompts.ts";
import { shellRules } from "./shell-rules.ts";
import { questionBarrier } from "@nexus/protocol/status-rules";
import {
  ClockTimers, REAL_CLOCK, Scheduler, type PlanChange, type PlanOptions, type Clock, type ScheduleOptions,
} from "./scheduler.ts";
import { Recurrer, type RecurringSet } from "./recurring.ts";
import { StaticReminder } from "./static-reminder.ts";
import { gitBranch, recordSetup, runSetup, setupPending, worktreeFor } from "./worktree.ts";
import { closingContext } from "./closing.ts";
import { perf } from "./perf.ts";
import { integrationContext, mergeBase, mergeConflicts, mergedText, pullBase, pullBefore, recoverPull, type IntegrationContext } from "./integration.ts";
import { Coordinator, bringsBack, refusalText, waitingText, type Member } from "./coordinator.ts";
import type { Capacity } from "./capacity.ts";
import { CHECK_DRAIN_WAIT_MS, CheckRunner } from "./check-runs.ts";
import type { SnapshotReader } from "./snapshots.ts";
import { gitWritableRoots } from "./codex.ts";
import {
  assertCanResume, assertCanStart, startedRun, stoppedMessage, toFinished, toHalted, toHeldForUpdate,
  toApprovalWait, toLimitHeld, toLimitReleased, toPaused, toPausedByUser, toResumed, toRetryWait, toRevision, toUnheld, toUsageWait,
} from "./run-state.ts";

type Live = Hosted;

/**
 * The integration step Nexus runs without a model is `running` from its own session with no done since its start: the
 * server stopped between the two (both are written in one pass, queue MI).
 */
function interruptedWithoutModel(st: StepView): boolean {
  if (!st.model_free || st.status !== "running") return false;
  const started = st.timeline.findLast((e) => e.type === "step.started");
  const done = lastDone(st);
  return started?.session === NEXUS_SESSION && (!done || done.at < started.at);
}

/** A step's questions hold its next work, independently of other queues and of the asking session. */
function questionsHold(state: ProjectState, queue: string, step: string | undefined): boolean {
  return questionBarrier(state.questions, queue, step, state.queues.find(q => q.id === queue)?.run?.answers_resumed).blocked;
}

export interface StartOptions {
  model?: string; effort?: Effort; session?: string; runtime?: "claude" | "codex";
  /** Started by the plan: the queues whose being done started it (recorded on the run). */
  after?: string[];
}

// Moved to src/scheduler.ts; still exported here, where the tests import them.
export { MAX_TIMER_MS, type Clock } from "./scheduler.ts";

/** A turn that failed for a passing reason is tried again RETRY_LIMIT times (5), after 1, 2, 4, 8 and 16 minutes. */
export { RETRY_LIMIT };
const RETRY_BASE_MS = 60_000;
/** A run waiting for the usage window goes on this long after the window's reset. */
const USAGE_MARGIN_MS = 60_000;

/**
 * How long a turn's end without the step's outcome waits for the work the agent left running in the background (a
 * command, a sub-agent) before the usual rule (one nudge, then a halt) applies. docs/design/engine.md, "Background work".
 */
const BACKGROUND_LIMIT_MS = 30 * 60_000;

/** After background work ends with the session idle, Nexus looks again this much later: Claude Code starts a turn by itself first. */
const BACKGROUND_SETTLE_MS = 2000;

/** After a turn ends, how long the engine lets the CLI's last events land in the files before it decides. */
const TURN_SETTLE_MS = 300;

/** After the engine starts, how long before it resumes what an update held, and looks at the planned starts. */
const STARTUP_MS = 1500;

/** The condition under which Nexus stops a survey run that left work (Engine.surveyLeftWork). */
export const SURVEY_CONDITION = "Nexus: a survey run leaves no commit and no changed tracked file";

/** A step with one of these has its outcome: its round of commits ends with the turn that gave it. */
const OUTCOME: ReadonlySet<string> = new Set(["done", "review", "checking", "failed", "stopped"]);
/** A step past its work: its outcome, or skipped or rejected. A turn now is no turn of the step's (turnFailed). */
const STEP_ENDED: ReadonlySet<string> = new Set([...OUTCOME, "skipped", "rejected"]);
/** The usage window a runtime's failed turn fills (routing.ts, overThreshold: codex's start with `codex_`). */
const limitWindow = (runtime: "claude" | "codex") => (runtime === "codex" ? "codex_limit" : "limit");

export interface EngineOptions {
  /** The first retry's delay; each further one doubles it. Tests make it short. */
  retryBaseMs?: number;
  usageMarginMs?: number;
  /**
   * After a turn ends, how long the engine waits for the CLI's last events before it decides (TURN_SETTLE_MS); tests
   * make it short: the fake runtimes write theirs before the turn ends.
   */
  turnSettleMs?: number;
  /**
   * How long after a Claude turn's end a turn of the CLI's own may still begin (ClaudeOptions.lateTurnMs: by default
   * claude.ts's LATE_TURN_MS). A test whose fake starts that turn only after the engine looked holds the moment open,
   * so how long the engine takes to look (under load, past the default) does not decide the test.
   */
  lateTurnMs?: number;
  /** After the engine starts, how long before it resumes held runs and looks at planned starts (STARTUP_MS); tests make it short. */
  startupMs?: number;
  /** How long a turn's end waits for background work (BACKGROUND_LIMIT_MS); tests make it short. */
  backgroundLimitMs?: number;
  /** How long a change of the user's to the plan can be undone (the scheduler's UNDO_MS); tests make it short. */
  undoMs?: number;
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
  /**
   * Asked at the end of a step (done or skipped) before the run goes on (the next step, or its end): whether to stop
   * here (src/deploy-plan.ts). `true`: a deploy planned after this step or queue just started its update, whose drain
   * held the run. `{ hold }`: the planned deploy waits (for the user's confirmation of provisional work): the engine
   * holds the run here, to be resumed by the restart of that deploy (or when the plan ends without it). The engine then
   * looks at the run again.
   */
  boundary?: (queueId: string, step: string, state: ProjectState) => boolean | { hold: string };
  /**
   * The workstation's capacity coordinator (src/capacity.ts). With it, Nexus runs each step's checks after the worker's
   * `nexus step done` (src/check-runs.ts); without it (an engine of an older kind of test), the worker reports them.
   */
  capacity?: Capacity;
  /** Reads the Windows volume shadow copies made while a failed check ran (src/snapshots.ts): the server's; tests leave it out or give a fake. */
  snapshots?: SnapshotReader;
  /** A check's time limit (CHECK_LIMIT_MS) and how long an update's drain waits for running checks; tests make them short. */
  checkLimitMs?: number;
  checkDrainWaitMs?: number;
}

/** A process asked to end for a restart (another model or effort) is killed if it has not exited by then. */
const RESTART_KILL_MS = 10_000;

/**
 * Context care's idle switch (queue FI): a session idle this long at a step boundary has lost its prompt cache (it
 * lives an hour), so its next turn would write the whole context again.
 */
const IDLE_SWITCH_MS = 60 * 60_000;

/**
 * How many minutes a session has been idle at `nowMs`, when that is beyond IDLE_SWITCH_MS and its context summary is
 * fresh: written at or after the start of its latest turn (the summary covers everything the session did). Otherwise
 * undefined: no idle switch.
 */
function idleMinutes(last: { started_at: string; ended_at: string } | undefined, summary: { at: string } | undefined, nowMs: number): number | undefined {
  if (!last || !summary || summary.at < last.started_at) return undefined;
  const idle = nowMs - Date.parse(last.ended_at);
  return idle > IDLE_SWITCH_MS ? Math.floor(idle / 60_000) : undefined;
}

/** The runtime, model and effort a step runs on. */
export interface StepValues { runtime: "claude" | "codex"; model?: string; effort?: Effort }

/**
 * What a step runs on, and its fallback chain, by the precedence of routing.ts (routeStep): the step's own values, the
 * queue's, what the run's start named, the step's kind's defaults, the project's defaults.
 */
function stepRoute(start: StartValues, step: StepView, q: Pick<QueueView, "runtime" | "model" | "effort" | "fallback">, project: ProjectFile): Routed {
  return routeStep({ step, queue: q, start, kind: kindDefaults(project, step.tags.kind), project });
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
  /** Recurring queues: made from their template and started at their times (src/recurring.ts). */
  private readonly recurrer: Recurrer;
  /** The monthly reminder of a project without static analysis (src/static-reminder.ts). */
  private readonly staticReminder: StaticReminder;
  private readonly clock: Clock;
  private busy = new Set<string>();
  /** Set while Nexus drains for an update: nothing new starts. */
  draining = false;
  /** Set by shutdown: this engine writes nothing more (its successor may already own the files). */
  private stopped = false;
  /** Sessions whose process Nexus itself is ending: their exit is no failure. */
  private readonly ending = new Set<string>();
  /**
   * The usage limits turns failed on, by usage window (`limit`, `codex_limit`): full until the reset the failure named,
   * at every route choice (usage.json records no rejection). In memory: after a restart a turn meets the limit again.
   */
  private readonly limitsMet = new Map<string, { utilization: number; resets_at: string }>();
  /**
   * A late turn at a session switch (queue LF, F3). `injected`: the inbox entries sent into a session's running turn
   * (`next`); at the turn's end they become `lastInjected`, which the runtime read in that turn unless it runs them as a
   * turn of its own (AgentProcess.settling). `switchWaits`: sessions whose switch at a step boundary waits for that
   * moment to pass. The entries of a late turn Nexus ended, for the fresh session's first turn, are the run's `carry`.
   */
  private readonly injected = new Map<string, SessionView["inbox"]>();
  private readonly lastInjected = new Map<string, SessionView["inbox"]>();
  private readonly switchWaits = new Set<string>();
  /** A user's immediate stop is waiting for the old process to exit before Resume can open another. */
  private readonly stopping = new Set<string>();
  /** A boundary is not crossed until the worker's descendants have gone. Reset after every turn. */
  private readonly cleaned = new WeakSet<Live["proc"]>();
  private readonly cleaning = new WeakMap<Live["proc"], Promise<void>>();
  /** Sessions whose process Nexus ends to start it again with another model or effort (Claude Code). */
  private readonly restarting = new Set<string>();
  /** Sessions whose process ended after reporting their step, including an already accepted review. */
  private readonly exitedAfterOutcome = new Set<string>();
  private readonly retryBaseMs: number;
  private readonly usageMarginMs: number;
  private readonly turnSettleMs: number;
  private readonly lateTurnMs: number | undefined;
  private readonly startupMs: number;
  private readonly backgroundLimitMs: number;
  private readonly boundary?: EngineOptions["boundary"];
  /**
   * A run whose step's turn ended while background work ran, by queue: since when Nexus waits (on the clock), and
   * whether the wait is over (`expired`: the usual rule applies until the work ends or the step opens again).
   */
  private readonly backgroundWaits = new Map<string, { step: string; since: number; expired?: boolean }>();
  /** The steps of survey runs checked for left work (surveyLeftWork), by queue, step and the time it ended. */
  private readonly surveyChecked = new Set<string>();
  /**
   * The answers (inbox entry ids) that reached a worker while its turn was live, until they are delivered: the turn
   * they open after it is no return from waiting, so it is never held at the limit (the queue was at work, and counted).
   * Lost with a restart, which pauses the runs anyway.
   */
  private readonly liveAnswerIds = new Set<string>();
  /** Worktree setup commands running, by queue (src/worktree.ts, runSetup). */
  private readonly setups = new Map<string, ChildProcess | null>();
  /** Setups an update's drain ended: their end is neither a success nor a failure. */
  private readonly setupsEnded = new Set<string>();
  /** The checks Nexus runs (src/check-runs.ts): only with the capacity coordinator. */
  private readonly checks?: CheckRunner;
  private readonly checkDrainWaitMs: number;

  constructor(store: ProjectStore, changed: () => void, options: EngineOptions = {}) {
    this.store = store;
    this.changed = changed;
    this.host = new AgentHost(store, ROLE_RECORDS.worker, { spawn: options.spawn });
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.usageMarginMs = options.usageMarginMs ?? USAGE_MARGIN_MS;
    this.turnSettleMs = options.turnSettleMs ?? TURN_SETTLE_MS;
    this.lateTurnMs = options.lateTurnMs;
    this.startupMs = options.startupMs ?? STARTUP_MS;
    this.backgroundLimitMs = options.backgroundLimitMs ?? BACKGROUND_LIMIT_MS;
    this.boundary = options.boundary;
    this.clock = options.clock ?? REAL_CLOCK;
    this.clockTimers = new ClockTimers(this.clock, () => this.stopped);
    this.coordinator = options.coordinator ?? new Coordinator();
    this.scheduler = new Scheduler(store, this.clockTimers, {
      start: (queueId, opts) => this.start(queueId, opts), draining: () => this.draining, stopped: () => this.stopped,
      changed: () => this.changed(), usageMarginMs: this.usageMarginMs, undoMs: options.undoMs,
      block: (state, q) => this.coordinator.startBlock(state, q), checkStarts: () => this.checkStarts(),
    });
    this.coordinator.add(this);
    this.pusher = new AcceptedPusher(store, changed, { run: options.git, timeout: options.pushTimeoutMs });
    this.checkDrainWaitMs = options.checkDrainWaitMs ?? CHECK_DRAIN_WAIT_MS;
    // Before the runs are recovered: what the old server left running is marked interrupted, to run again.
    if (options.capacity) {
      this.checks = new CheckRunner(store, options.capacity, {
        project: store.readProject().id,
        ended: (queue) => { if (this.stopped) return; this.advance(queue); this.changed(); },
        halt: (queue, reason) => { this.halt(queue, reason); this.changed(); },
        fixPreface: (queue, step) => this.fixPreface(queue, step),
      }, { limitMs: options.checkLimitMs, snapshots: options.snapshots });
    }
    this.recoverAfterRestart();
    // Chains from before the plan move into it (start.yaml's `after` becomes plan.yaml).
    try { this.store.migrateChains(); } catch { /* an unreadable start.yaml shows as a warning in the state */ }
    // Schedules are armed again; what came due while no server ran is looked at once this one is up.
    this.scheduler.armAll();
    this.recurrer = new Recurrer(store, this.clockTimers, { plan: (queueId, o) => this.scheduler.plan(queueId, o), stopped: () => this.stopped, changed: () => this.changed() });
    this.staticReminder = new StaticReminder(store, this.clockTimers, () => this.changed());
    // The recurring queues' times too, once the engine is up: one that came while no server ran comes now, or is missed.
    // The static analysis reminder looks then too.
    this.timers.set("starts", setTimeout(() => { this.timers.delete("starts"); this.checkStarts(); this.recurrer.armAll(); this.staticReminder.arm(); }, this.startupMs));
  }

  /** Pushes what was accepted (src/accepted.ts). */
  readonly pusher: AcceptedPusher;

  /**
   * The approved queues of this project that could start (or resume, a paused run) now: not at work, their checkout
   * free and a place under the limit (the coordinator's rule, across projects).
   */
  startable(state: ProjectState): QueueView[] {
    return state.queues.filter((q) => q.approved && (q.status === "approved" || (q.status === "paused" && q.run?.state === "paused"))
      && !q.steps.every((s) => stepClosed(q, s)) && !this.coordinator.startBlock(state, q));
  }

  /** "Push again" on a queue whose last push of an accepted step failed. */
  pushAgain(queueId: string): string { return this.pusher.pushAgain(queueId); }

  // ---------------------------------------------------------------- user actions

  start(queueId: string, opts: StartOptions = {}): RunFile {
    if (this.draining) throw new ActionError("Nexus is updating; start the queue after the restart", 409);
    let state = loadProjectState(this.store);
    let q = this.queue(state, queueId);
    assertCanStart(q);
    // Never two queues in one checkout, and no more queues at once than the limit (a planned start waits instead). The
    // runs held at the limit take a free place first.
    this.coordinator.releaseHeld();
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
    // What the start did not choose, nor take from a session it continues, came from the project's defaults: resolved
    // again at each step (startOf), where a step's kind goes over them. The rest is explicit.
    const from_defaults = START_KEYS.filter((k) => !reused && opts[k] === undefined);
    const start: StartValues = { ...values, explicit: START_KEYS.filter((k) => !from_defaults.includes(k)) };
    // Every step still to run is checked now, so a bad combination refuses the start rather than halting the run later.
    for (const st of q.steps.filter((x) => !stepClosed(q, x))) {
      const w = stepRoute(start, st, q, state.project);
      const issue = effortIssue(w.runtime, w.effort);
      if (issue) throw new ActionError(`step ${st.id} would run on ${RUNTIME_NAME[w.runtime]} at effort ${w.effort}: ${issue}`, 409);
    }
    const first = q.steps.find((x) => x.status === "pending");
    const firstRoute = first && stepRoute(start, first, q, state.project);
    const want: StepValues = firstRoute ?? values;
    if (reused && want.runtime !== reused.runtime) {
      throw new ActionError(`step ${first!.id} runs on ${RUNTIME_NAME[want.runtime]}; the session to continue is a ${RUNTIME_NAME[reused.runtime as "claude" | "codex"]} session`, 409);
    }
    // A first step whose runtime is beyond the usage threshold opens on its fallback (advance records it): a new session
    // is made on that one at once. A continued session keeps its own runtime; advance switches from it if it must.
    const choice = firstRoute && !reused ? this.chooseFor(state, firstRoute) : undefined;
    const open = choice?.kind === "fallback" ? choice.values : want;
    const session = reused
      ? this.reuseSession(state, reused.id, queueId, want.model, want.effort)
      : this.newSession(state, q, open.runtime, open.model, open.effort);
    const run = startedRun({ session: session.id, revision: q.revision, ...values, after: opts.after, at: now(), from_defaults,
      checks: state.project.defaults.checks });
    this.store.writeRun(queueId, run);
    this.store.clearStart(queueId); // a planned start is used up by any start
    // The plan stays, used: the queue started since it was planned (a proposal about it is moot).
    const plan = openPlanFile(this.store.readPlan(queueId));
    if (plan) this.store.writePlan(queueId, { ...plan, started_at: now(), proposal: undefined });
    this.scheduler.disarm(queueId);
    // The queue's earlier sessions are done with: a process one of them still has (a halted or paused run's) ends, so
    // it works no turn beside the new run's and holds nothing in the checkout (queue PRC). A continued session is kept.
    this.endProcesses((q) => q === queueId, { keep: session.id });
    this.ensureProcess(session);
    this.advance(queueId);
    return run;
  }

  pause(queueId: string): void {
    const run = this.run(queueId);
    // Also a queue held for an update: the user's pause wins, so the restart does not resume it. A pending retry or
    // usage wait is cancelled. A run waiting for an approval is paused too (a later resume goes on under the approved
    // revision). One already pausing is left to finish its pause.
    if ((runGoing(run) && run.state !== "pausing") || run.resume_after_restart) {
      const working = this.host.get(run.session)?.proc.state === "working";
      this.clearTimer(queueId);
      this.writeRun(queueId, toPausedByUser(run, "paused by the user", { pausing: working }));
    }
  }

  /**
   * The user's Continue on a stopped queue: lifts the stop (a `lift` by Continue) and goes on. Its run
   * resumes, reopening the stopped step in its session (unless the orchestrator skipped it: then the next pending
   * one opens). Without a run (an imported stop), or with a finished one, the queue starts afresh at its first
   * pending step. A run of an older revision resumes too: a revision changes no started step. `skipClosing`: the user
   * skips the queue's closing refactoring step with it (liftByContinue).
   */
  continueQueue(queueId: string, o: { skipClosing?: boolean } = {}): string {
    if (this.draining) throw new ActionError("Nexus is updating; continue the queue after the restart", 409);
    // Checked before the stop is lifted, so a refusal leaves the queue as it was.
    const before = this.store.readRun(queueId);
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    const block = !before || before.state === "finished" ? this.coordinator.startBlock(state, q)
      : runHoldsCheckout(before) ? undefined : this.coordinator.checkoutBlock(state, q);
    if (block) throw new ActionError(refusalText(queueId, "continue", block), 409);
    const lift = liftByContinue(this.store, queueId, o);
    const run = this.store.readRun(queueId);
    if (!run || run.state === "finished") {
      // Nothing left once the closing step is skipped (its stop was the queue's last step): the queue is done.
      if (this.nothingLeft(queueId)) return `the stop is lifted; queue ${queueId} has nothing left to run and is done`;
      const started = this.start(queueId);
      return `the stop is lifted; queue ${queueId} starts at its first pending step in session ${started.session}`;
    }
    this.resume(queueId, `the user lifted the stop with Continue${lift.reason ? `; the stop was: ${lift.reason}` : ""}`);
    return `the stop is lifted; queue ${queueId} goes on in session ${run.session}`;
  }

  /**
   * Goes on with a paused, halted or waiting run in its session, ensuring its process. Also the way an approval_wait
   * run goes on once its revision is approved (onChange, a cancelled drain, the restart). `why`: said to the agent when
   * the step is continued (a retry after a failed turn, a lifted stop). `explicit`: a Resume asked for (by the user or
   * the orchestrator), the only kind that releases the wait a step's last answer asked for; Nexus's own go on through
   * resumeByItself.
   */
  resume(queueId: string, why?: string, explicit = true): void {
    let run = this.run(queueId);
    if (this.stopping.has(run.session)) throw new ActionError("the worker is still exiting; resume once it has stopped", 409);
    const live = this.host.get(run.session);
    const cleanup = live && this.cleaning.get(live.proc);
    if (cleanup) {
      // What refuses a resume whatever the cleanup does (a rejected step, a revision to approve, a stopped or
      // finished queue) refuses it now, not later in a deferred call that halts the run with it. The cleanup takes
      // longer since the worker's job runs below normal priority (queue SV3), which made the wait visible.
      if (run.state === "finished") throw new ActionError("the run is finished", 409);
      if (run.state !== "running") {
        const state = loadProjectState(this.store);
        const q = this.queue(state, queueId);
        assertCanResume(q, run);
        // A checkout another queue holds refuses it now too (queue LH), as the call below would after the wait: a halted
        // run holds no checkout.
        const block = runHoldsCheckout(run) ? undefined : this.coordinator.checkoutBlock(state, q);
        if (block) throw new ActionError(refusalText(queueId, "go on", block), 409);
      }
      // Automatic resumes (a cancelled drain, an approval) wait too. A later pause or other run change cancels
      // this request; cleanup failure already halts the run through cleanWorker.
      const before = JSON.stringify(run);
      void cleanup.then(() => {
        if (this.stopped || JSON.stringify(this.store.readRun(queueId)) !== before) return;
        try { this.resume(queueId, why, explicit); } catch (error) { this.halt(queueId, String(error)); }
      }, () => {});
      return;
    }
    if (run.state === "finished") throw new ActionError("the run is finished", 409);
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    const barrier = questionBarrier(state.questions, queueId, run.step, run.answers_resumed);
    // Every question answered and the last answer asked to wait: an explicit Resume releases it, even of a running run.
    const releasesWait = explicit && barrier.wait && !barrier.remaining;
    if (run.state === "running" && !releasesWait) return;
    assertCanResume(q, run);
    if (releasesWait) {
      run = { ...run, answers_resumed: barrier.last };
      this.writeRun(queueId, run);
      if (run.state === "running") { this.changed(); return; }
    }
    // A halted run holds no checkout: another queue may have started there meanwhile.
    if (!runHoldsCheckout(run)) {
      const block = this.coordinator.checkoutBlock(state, q);
      if (block) throw new ActionError(refusalText(queueId, "go on", block), 409);
    }
    const session = this.sessionFile(state, run.session);
    this.ensureProcess(session);
    this.clearTimer(queueId);
    // A usage wait resumed (by the user, or by itself at the reset): the limits turns met are not held against the next
    // choices; a turn that meets one again records it again (limitsMet).
    if (run.state === "usage_wait") this.limitsMet.clear();
    this.writeRun(queueId, toResumed(run, q.revision));
    // A step left unfinished (stopped, failed, interrupted) is continued rather than skipped; one waiting for an
    // answer just waits on (the answer arrives through the inbox). A rejected step is never run again.
    const open = q.steps.find((s) => s.id === run.step && !["done", "skipped", "review", "checking", "rejected"].includes(s.status));
    // A step sent back while the run was paused or halted: the send-back, still in the inbox, opens its next turn. So
    // does a check-fix round (one more after the limit is given here: src/check-runs.ts).
    const pending = open && (state.sessions.find((x) => x.id === run.session)?.inbox.some(m => !m.read_at
      && ((m.type === "send_back" && m.step === open.id) || m.type === "answer"))
      || !!this.checks?.fixRound(q, open, run.session, state));
    if (open?.status === "waiting" || pending) this.changed();
    // The integration step Nexus ran without a model, left between its start and its done: it runs again (advance).
    else if (open && interruptedWithoutModel(open)) this.advance(queueId);
    else if (open) this.openStep(queueId, open, q, "continue", why);
    else this.advance(queueId);
  }

  /** Nexus goes on with a run by itself (a restart, an approval, a retry): never releasing a last answer's wait. */
  private resumeByItself(queueId: string, why?: string): void {
    this.resume(queueId, why, false);
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
    if (now) this.endSetups();
    // Running checks get a while, then are ended and run again after the restart; none start meanwhile.
    this.checks?.drain(now ? 0 : this.checkDrainWaitMs);
    return held;
  }

  /**
   * The drain goes on as with `now` (an update's deadline came, src/deploy-plan.ts): queues still finishing their step
   * for the update are interrupted, held, and continue that step after the restart.
   */
  hurryDrain(): void {
    if (!this.draining) return;
    for (const id of this.store.queueIds()) {
      const run = this.store.readRun(id);
      if (run?.state === "pausing" && run.resume_after_restart) this.writeRun(id, toHeldForUpdate(run, run.reason ?? "the Nexus server is updating; it goes on by itself afterwards"));
    }
    this.checks?.drain(0);
    for (const l of this.host.all()) if (l.proc.state === "working") { this.ending.add(l.session); l.proc.kill(); }
    this.endSetups();
  }

  /**
   * An update that cannot wait (now, or its deadline came) ends the worktree setups running: not a failure, the setup
   * stays to run (no done_at) and runs again when the held run goes on after the restart.
   */
  private endSetups(): void {
    for (const [queue, p] of this.setups) { this.setupsEnded.add(queue); p?.kill(); }
  }

  /** A run the planned deploy held at its step's end (boundary `hold`) goes on: the plan ended without its deploy. */
  releaseHold(queueId: string, reason: string): void {
    const run = this.store.readRun(queueId);
    if (run?.state !== "paused" || !run.resume_after_restart || this.draining) return;
    try { this.resumeByItself(queueId); } catch (e) { this.halt(queueId, `could not go on after ${reason}: ${(e as Error).message}`); }
  }

  /** No agent of this project is in the middle of a turn, and none of its checks runs. */
  idle(): boolean {
    // A worktree setup running (a new worktree's, or after a merge of the base changed its inputs) is waited for too.
    return this.host.idle() && !this.checks?.running() && !this.setups.size;
  }

  /** The update did not happen: the queues it held go on now. */
  cancelDrain(): void {
    this.draining = false;
    this.checks?.undrain();
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
      else if (run.state === "paused") { try { this.resumeByItself(id); } catch (e) { this.halt(id, (e as Error).message); } }
    }
    this.checkStarts();
  }

  /** Asks the worker to stop through a message and pauses the run. */
  stopNow(queueId: string, text?: string): void {
    const run = this.run(queueId);
    const live = this.host.get(run.session);
    this.clearTimer(queueId);
    this.writeRun(queueId, toPausedByUser(run, "stopped by the user"));
    this.checks?.stop(queueId);
    if (live && live.proc.state === "working" && !live.proc.exiting) {
      live.proc.send(
        userStopNow(text),
        "now",
      );
    } else if (live) this.cleanWorker(queueId, live);
  }

  /** Interrupts and ends this worker's process, keeping its session and all checkout changes for Resume. */
  async stopAtOnce(queueId: string): Promise<void> {
    const run = this.run(queueId);
    const live = this.host.running(run.session);
    if (!live || run.state === "finished" || this.stopping.has(run.session)) throw new ActionError("the worker is not running", 409);
    if (this.store.readSession(run.session).queue !== queueId) throw new ActionError("the worker now belongs to another queue", 409);
    this.stopping.add(run.session);
    this.ending.add(run.session);
    this.restarting.delete(run.session);
    this.clearRestartKill(run.session);
    this.clearTimer(queueId);
    this.endBackgroundWait(queueId);
    // Stamped after the step's last events (writeRun reads the session's log first).
    this.writeRun(queueId, toPausedByUser(run, "stopped at once by the user; uncommitted changes kept"));
    this.checks?.stop(queueId);
    if (run.step) {
      const user = ensureUserSession(this.store);
      this.store.appendEvent({ v: 1, id: newId(), at: now(), session: user.id, type: "step.interrupted", queue: queueId, step: run.step,
        text: "Stopped at once by the user. Uncommitted changes remain; Resume continues in the same session." });
    }
    try {
      await new Promise<void>((resolve) => {
        live.proc.once("exit", () => resolve());
        live.proc.stop();
        live.proc.kill();
      });
    } finally { this.stopping.delete(run.session); this.changed(); }
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
    if (own && own.state !== "finished" && !runHoldsCheckout(own)) {
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
    // A done or cancelled queue keeps no process (queue PRC): a halted run closed as finished, or cancelled, left its
    // session's process idle; nothing would end it before the server stops.
    const closed = new Set(state.queues.filter((q) => q.status === "done" || q.status === "cancelled").map((q) => q.id));
    if (closed.size && !this.stopped) this.endProcesses((q) => closed.has(q), { state });
    for (const l of this.host.all()) this.deliverInbox(state, l);
    // Also a run held at the limit: a stop or a pause still reaches it.
    for (const q of state.queues) if (q.run?.state === "running" || q.run?.state === "pausing") this.advance(q.id, state);
    for (const q of state.queues) if (q.run?.state === "approval_wait" && q.approved) this.continueApproved(q.id);
    // Recurring queues after N queues: a queue that got done may complete a count.
    if (!this.stopped && !this.draining) this.recurrer.check(state);
    this.checkStarts();
  }

  /** A run waiting for an approval that came goes on (not while an update drains: the restart or cancelDrain does it). */
  private continueApproved(queueId: string): void {
    if (this.stopped || this.draining) return;
    try { this.resumeByItself(queueId); } catch (e) { this.halt(queueId, `could not go on after the approval: ${(e as Error).message}`); }
  }

  // ---------------------------------------------------------------- the plan and schedules (src/scheduler.ts)

  /**
   * Puts `queueId` into the plan: it starts when the queues `o.after` are done (none: as soon as it may) and it is
   * approved. When it may start already, it starts now (or, while an update drains, right after it). Replaces its
   * earlier predecessors by `o.by`'s rule (plan.ts). Returns what happened, in a sentence.
   */
  plan(queueId: string, o: PlanOptions): string { return this.scheduler.plan(queueId, o); }

  /** Sets a recurring queue (the orchestrator's `nexus recurring set`): its standing approval goes (Recurrer.set). */
  setRecurring(o: RecurringSet): string { return this.recurrer.set(o); }
  /** The user's standing approval of a recurring queue, its pause and its removal. */
  approveRecurring(id: string): string { return this.recurrer.approve(id); }
  pauseRecurring(id: string, paused: boolean): string { return this.recurrer.pause(id, paused); }
  removeRecurring(id: string): string { return this.recurrer.remove(id); }
  /** The user declined the static analysis template (the orchestrator's `nexus static-analysis decline`). */
  declineStaticAnalysis(reason: string, session?: string): string { return this.staticReminder.decline(reason, session); }

  /** The user's reorder: `queueId` after `after` (null: none before it), as in a list (Scheduler.move); undoable. */
  move(queueId: string, after: string | null): PlanChange { return this.scheduler.move(queueId, after); }
  /** The user's "also after": `queueId` waits for `after` too (Scheduler.addPredecessor); undoable. */
  addPredecessor(queueId: string, after: string): PlanChange { return this.scheduler.addPredecessor(queueId, after); }
  /** The user takes `after` out of the predecessors of `queueId` (Scheduler.removePredecessor); undoable. */
  removePredecessor(queueId: string, after: string): PlanChange { return this.scheduler.removePredecessor(queueId, after); }
  /** Undoes the user's change `change` to the plan, made on `queueId` (Scheduler.undo). */
  undoPlan(queueId: string, change: string): string { return this.scheduler.undo(queueId, change); }

  /**
   * Plans to start `queueId` at a time (`o.at`, ISO 8601, in the future), or when the usage window of the runtime it
   * would run on resets (`o.at` = "usage-reset"). Replaces an earlier plan of the queue. Returns what happened.
   */
  scheduleStart(queueId: string, o: ScheduleOptions): string { return this.scheduler.scheduleStart(queueId, o); }

  /** Takes a queue out of the plan, with its planned start (the orchestrator not one the user put in). */
  cancelStart(queueId: string, by: PlanBy = "user"): string { return this.scheduler.cancelStart(queueId, by); }

  /** Starts the queues whose planned starts are due, in every project (the coordinator's pass). */
  private checkStarts(): void { this.coordinator.checkStarts(); }

  // Member (src/coordinator.ts): what the coordinator asks of this project's engine.
  isStopped(): boolean { return this.stopped; }
  accepting(): boolean { return !this.stopped && !this.draining; }
  duePlans(): { queue: string; created_at: string }[] { return this.scheduler.duePlans(); }
  startDue(queueId: string): boolean { return this.scheduler.startDue(queueId); }
  liveAnswers(): ReadonlySet<string> { return this.liveAnswerIds; }
  heldRuns(): { queue: string; since: string }[] {
    if (!this.accepting()) return [];
    return this.store.queueIds().flatMap((q) => {
      const run = this.store.readRun(q);
      return run?.state === "running" && run.held ? [{ queue: q, since: run.held.since }] : [];
    });
  }

  /**
   * A run held at the limit goes on once a place is free (the coordinator's pass, which takes the held runs in the
   * order they became ready, before any planned start): what it held goes on, the next step or the turn its inbox
   * opens (the answers, a send-back, the messages that came meanwhile). Still full: it records the reason now.
   */
  releaseHeld(queueId: string): boolean {
    if (!this.accepting()) return false;
    const run = this.store.readRun(queueId);
    if (run?.state !== "running" || !run.held) return false;
    const state = loadProjectState(this.store);
    const q = state.queues.find((x) => x.id === queueId);
    if (!q) return false;
    const block = this.coordinator.limitBlock(state, q);
    if (block) {
      if (waitingText(block) !== run.held.reason) this.writeRun(queueId, toLimitHeld(run, waitingText(block), now()));
      return false;
    }
    this.writeRun(queueId, toLimitReleased(run));
    this.store.appendActivity(run.session, { at: now(), kind: "text", text: `Nexus lets queue ${queueId} go on: a place under the limit is free (it waited since ${formatClock(run.held.since, new Date())})`, queue: queueId, step: run.step });
    this.advance(queueId);
    const live = this.host.get(run.session);
    if (live) this.deliverInbox(loadProjectState(this.store), live);
    this.changed();
    return true;
  }

  shutdown(): void {
    this.stopped = true;
    this.coordinator.remove(this);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.clockTimers.clearAll();
    for (const l of this.host.all()) l.proc.kill();
    for (const p of this.setups.values()) p?.kill();
    this.checks?.shutdown();
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
    let live = this.host.get(run.session);
    // Its process has exited and its last output is still being read (AgentProcess.exiting): nothing can reach it, and
    // a turn's end read then leaves it idle. Its exit decides, as any exit does (a crash: the turn is tried again on a
    // new process), and looks again then. A nudge sent now threw, and the run halted with an engine error (queue CXD).
    if (live?.proc.exiting) return;
    const current = run.step ? q.steps.find((s) => s.id === run.step) : undefined;
    // The checks file cannot be read: whether the step's checks passed is unknown, and the derivation holds it in
    // `checking` (protocol checks.ts, holdUnread). Nothing here can run them or tell: the run halts with the reason
    // (queue LF, F6).
    if (current?.status === "checking" && q.check_runs_error !== undefined) {
      return this.halt(queueId, `queues/${queueId}/checks.yaml cannot be read (${q.check_runs_error.split("\n")[0]}): Nexus cannot tell whether the checks of step ${current.id} passed. Repair the file, or move it aside (the step then goes to its review without Nexus's checks), and Resume`);
    }
    // A survey step that reported its end is checked at once, while its turn may still be going and before its review.
    if (current && this.surveyLeftWork(queueId, q, current)) return;
    if ((!live || live.proc.state === "exited") && this.exitedAfterOutcome.has(run.session)) {
      // The process ended after the step's report, while the step waited for its review (see the exit handler): the
      // review decides. Still waiting: nothing to run. Then nothing left: the run is finished. Else (the next step, a
      // send-back): a new process resumes the session.
      if (current?.status === "review") return;
      // Its checks run without it; a fix round, if they fail, starts the process again (below, at the next look).
      if (current?.status === "checking") { if (this.checks) this.checks.step(run, q, current, state); return; }
      if (questionsHold(loadProjectState(this.store), queueId, run.step)) return;
      if (q.steps.every((s) => stepClosed(q, s))) { this.exitedAfterOutcome.delete(run.session); return this.finish(queueId); }
      this.exitedAfterOutcome.delete(run.session);
      live = this.ensureProcess(this.sessionFile(state, run.session));
    }
    if (!live || live.proc.state === "exited") return this.halt(queueId, "the session's process is not running");
    if (live.proc.state === "working" || this.cleaning.has(live.proc)) return;
    if ((q.status === "stopped" || (current && (OUTCOME.has(current.status) || ["skipped", "rejected"].includes(current.status)))) && this.cleanWorker(queueId, live)) return;

    // A new revision never stops the step at work: its turns, questions, answers and nudges go on as below, and only
    // the step's end looks at the approval.
    if (q.status === "stopped") return this.halt(queueId, stoppedMessage(q));
    if (questionsHold(loadProjectState(this.store), queueId, run.step)) {
      if (run.state === "pausing") this.writeRun(queueId, toPaused(run));
      return;
    }
    // The checks Nexus runs after the step's done: while they wait for the machine, run, or wait for the orchestrator's
    // decision on a disputed failure, they have the step (src/check-runs.ts). A pause reaches a fix round before it opens.
    if (current && this.checks) {
      if (this.checks.step(run, q, current, state)) return;
      if (run.state === "pausing" && this.checks.fixRound(q, current, run.session, state)) return this.writeRun(queueId, toPaused(run));
    }
    // The integration step Nexus runs without a model, left between its start and its done (the server stopped in
    // between): it runs again from its start (queue MI).
    if (current && interruptedWithoutModel(current)) return this.integrateAgain(queueId, run, state, q, current);
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
          // Work the agent left running in the background: its end brings the next move, up to a limit.
          const background = this.backgroundWait(queueId, run.session, current.id, live.proc.background ?? []);
          if (background === "wait") return;
          // Before a turn within the step: its runtime beyond the usage threshold goes on on its fallback (or waits).
          if (this.usageGate(queueId, state, run, live)) return;
          // The turn ended and the step has no outcome: ask once, then hand it to the user.
          if (run.nudged) return this.halt(queueId, `step ${current.id} ended twice without an outcome`);
          this.writeRun(queueId, { ...run, nudged: true });
          live.proc.send(noOutcomeNudge(current.id, background));
          return;
        }
        case "waiting":
          return; // a blocking question: its answer arrives through the inbox and starts the next turn
        case "checking":
          return; // the checks Nexus runs have it (above); a step checked by an older server waits for the next look
        case "review":
          // The integration step Nexus ran without a model, every check passed: Nexus accepts it itself (queue MI).
          if (acceptedByNexus(q, current)) { this.acceptWithoutModel(queueId, current); return this.advanceUnlocked(queueId); }
          // Waits for its review: the user's (level 1) or the orchestrator's (2 and 3). The step's turn is over, so a
          // pause asked for (by the user, or an update's drain) takes effect now; the review goes on meanwhile.
          if (run.state === "pausing") return this.writeRun(queueId, toPaused(run));
          return;
        case "failed":
        case "stopped":
          return this.halt(queueId, `step ${current.id} ${current.status}${current.reason ? `: ${current.reason}` : ""}`);
        case "done":
        case "rejected":
        case "skipped":
        default:
          break; // ended: go on
      }
      // The step boundary from here to the next step's opening is a measured section (queue GB).
      return perf.section("step boundary: open", () => this.goOn(queueId, run, state, q, current, live));
    }
    this.goOn(queueId, run, state, q, current, live);
  }

  /** The run goes on after its step `current` ended (or before its first step): the next step opens, or the run ends. */
  private goOn(queueId: string, run: RunFile, state: ProjectState, q: QueueView, current: StepView | undefined, live: Live): void {
    if (current) {
      // A deploy planned after this step (or queue) starts now: its drain holds the run here, so nothing of the next
      // step slips in. Looked at again: held, the run waits for the restart; paused by the user, the pause is reached.
      const stop = this.boundary?.(queueId, current.id, state);
      if (stop === true) return this.advanceUnlocked(queueId);
      if (stop) return this.writeRun(queueId, run.state === "running" ? toHeldForUpdate(run, stop.hold) : toPaused(run));
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
    // After a step (which waited for its review, so the queue counted no more): the next one opens only with a place
    // under the limit, else the run is held until one frees. Also the closing and the integration step.
    if (current && this.heldAtLimit(queueId, run, `step ${next.id}`)) return;
    // At a step boundary the base is merged into the queue's branch when it merges cleanly (queue MI); a change of the
    // setup's inputs makes the setup run again first (below).
    // A merge of the base a server left half done here is aborted first; one Nexus did not start halts the run (F4).
    if (current) { const left = recoverPull(this.store, q); if (left) return this.halt(queueId, left); }
    if (current && current.id !== next.id && !next.integration) pullBase(this.store, state, q, next.id);
    if (this.worktreeSetup(queueId, run, q)) return;
    // The integration step without a model, when the merge is plain (queue MI).
    if (next.integration && this.integrateWithoutModel(queueId, run, state, q, next)) return;
    // The step's own values; beyond the usage threshold, the first free entry of its fallback chain, or a wait for the
    // earliest reset (routing.ts, chooseRoute). Back on its own values at the first step boundary after its runtime
    // is free again.
    const routed = stepRoute(this.startOf(state, run), next, q, state.project);
    const own = effortIssue(routed.runtime, routed.effort);
    if (own) return this.halt(queueId, `step ${next.id}: ${own}`);
    const choice = this.chooseFor(state, routed);
    if (choice.kind === "wait") {
      this.writeRun(queueId, toUsageWait(run, choice.reason, choice.until));
      this.schedule(queueId, choice.until, this.usageMarginMs);
      return;
    }
    const want = choice.values;
    const issue = effortIssue(want.runtime, want.effort);
    if (issue) return this.halt(queueId, `step ${next.id} on its fallback: ${issue}`);
    const routedRun = this.recordRoute(queueId, run, next.id, routed, choice);
    if (this.prepareStep(queueId, routedRun, state, q, current, next, want, live)) return;
    this.openStep(queueId, next, q, "start");
  }

  /**
   * A queue back from waiting (an answer, a review: it counted no more meanwhile) would open a new turn or its next
   * step (`what`): with as many queues running as a limit allows, the run is held (run.yaml `held`, with the reason)
   * and goes on by itself once a place frees, through the coordinator's pass (releaseHeld), which lets the runs held
   * before it go first. A run held already stays so until that pass. True: held, nothing opens now. Never a live turn:
   * what reaches a working session goes into its turn.
   */
  private heldAtLimit(queueId: string, run: RunFile, what: string): boolean {
    if (run.held) return true;
    this.coordinator.releaseHeld();
    const state = loadProjectState(this.store);
    const q = state.queues.find((x) => x.id === queueId);
    const block = q && this.coordinator.limitBlock(state, q);
    if (!block) return false;
    const latest = this.store.readRun(queueId);
    if (latest?.state !== "running") return true;
    const reason = waitingText(block);
    this.writeRun(queueId, toLimitHeld(latest, reason, now()));
    this.store.appendActivity(latest.session, { at: now(), kind: "turn_end", text: `Nexus holds queue ${queueId} before ${what}: it ${reason}; it goes on by itself once a place frees`, queue: queueId, step: latest.step });
    this.changed();
    return true;
  }

  /** Start one cleanup barrier per idle turn; no inbox or next step may enter while it is pending. */
  private cleanWorker(queueId: string, live: Live): boolean {
    const proc = live.proc;
    if (!proc.cleanup || this.cleaned.has(proc)) return false;
    if (this.cleaning.has(proc)) return true;
    const cleanup = proc.cleanup();
    this.cleaning.set(proc, cleanup);
    void cleanup.then(() => {
      this.cleaning.delete(proc);
      this.cleaned.add(proc);
      if (this.stopped || this.host.get(live.session)?.proc !== proc) return;
      this.advance(queueId);
      this.changed();
    }, (error: unknown) => {
      this.cleaning.delete(proc);
      if (this.stopped || this.host.get(live.session)?.proc !== proc) return;
      this.halt(queueId, `worker process cleanup failed: ${String(error)}`);
      this.ending.add(live.session);
      proc.kill();
      this.changed();
    });
    return true;
  }

  /**
   * The project's worktree setup command, still to run in the queue's new worktree before a step opens: started here
   * (once at a time); its success goes on, a failure is tried once more, a second one halts the run with the reason
   * (queue CK), and it runs again when the run goes on. True while it runs (no step opens).
   */
  private worktreeSetup(queueId: string, run: RunFile, q: QueueView): boolean {
    if (this.setups.has(queueId)) return true;
    const command = setupPending(this.store, queueId);
    if (!command || !q.worktree || q.worktree === "auto") return false;
    const cwd = q.worktree;
    this.setups.set(queueId, null);
    this.store.appendActivity(run.session, { at: now(), kind: "text", text: `Nexus runs the worktree setup command in ${cwd}: ${command}`, queue: queueId });
    const once = () => runSetup(command, cwd, { started: (p) => { if (this.setups.has(queueId)) this.setups.set(queueId, p); } });
    // Failing, it is tried once more (a network hiccup, a locked file), then the run halts with its output: the worker
    // cannot fix the machine's install (the user's decision of 2026-11-23, queue CK).
    void once().then((first) => {
      if (!first || this.setupsEnded.has(queueId) || this.stopped) return first;
      this.store.appendActivity(run.session, { at: now(), kind: "error", text: `The worktree setup command failed: ${first}; Nexus tries it once more`, queue: queueId });
      return once();
    }).then((failure) => {
      this.setups.delete(queueId);
      if (this.setupsEnded.delete(queueId) || this.stopped) return;
      recordSetup(this.store, queueId, command, failure, failure ? undefined : gitRead(cwd, ["rev-parse", "HEAD"]));
      const latest = this.store.readRun(queueId);
      this.store.appendActivity(run.session, { at: now(), kind: failure ? "error" : "text", text: failure ? `The worktree setup command failed: ${failure}` : "The worktree setup command succeeded", queue: queueId });
      if (!failure) return this.advance(queueId);
      if (runCounted(latest)) this.halt(queueId, `the worktree setup command (${command}) failed twice: ${failure}`);
    });
    return true;
  }

  /**
   * A turn of `step` ended without its outcome while `work` runs in the background (docs/design/engine.md, "Background work").
   * `wait`: Nexus waits for it (the end of the work, or the limit, looks again); else the usual rule applies, with what
   * the nudge says about the background work: it has finished (Codex starts no turn of its own then), or it still runs
   * after the limit. Undefined: there was none.
   */
  private backgroundWait(queueId: string, session: string, step: string, work: readonly string[]): "wait" | Parameters<typeof noOutcomeNudge>[1] {
    const w = this.backgroundWaits.get(queueId);
    const ours = w?.step === step ? w : undefined;
    if (!work.length) {
      this.endBackgroundWait(queueId);
      return ours ? { finished: true } : undefined;
    }
    if (ours?.expired) return { finished: false, minutes: Math.round((this.clock.now() - ours.since) / 60_000), work };
    const since = ours?.since ?? this.clock.now();
    const due = since + this.backgroundLimitMs;
    if (this.clock.now() >= due) {
      this.backgroundWaits.set(queueId, { step, since, expired: true });
      this.clockTimers.clear(`background:${queueId}`);
      this.store.appendActivity(session, { at: now(), kind: "turn_end", text: `background work still runs after ${Math.round(this.backgroundLimitMs / 60_000)} min (${work.join("; ")}): Nexus waits no longer`, queue: queueId, step });
      return { finished: false, minutes: Math.round((this.clock.now() - since) / 60_000), work };
    }
    if (!ours) {
      this.backgroundWaits.set(queueId, { step, since });
      this.store.appendActivity(session, { at: now(), kind: "turn_end", text: `the turn ended with work running in the background (${work.join("; ")}): Nexus waits for it, up to ${Math.round(this.backgroundLimitMs / 60_000)} min`, queue: queueId, step });
      this.clockTimers.wakeAt(`background:${queueId}`, due, () => { this.advance(queueId); this.changed(); });
    }
    return "wait";
  }

  /** Forgets a run's wait for background work (its step opened again, or the work ended). */
  private endBackgroundWait(queueId: string): void {
    this.backgroundWaits.delete(queueId);
    this.clockTimers.clear(`background:${queueId}`);
  }

  /**
   * Makes the session fit the next step before it opens; returns whether it took the next move instead.
   *
   * - Another runtime than the session's, or (context care, docs/design/usage.md "Context care between steps") a context beyond
   *   the project's threshold (context_reuse_tokens, at most 80 % of the model's window: contextLimit): the step runs in a fresh session with the step's runtime, model and effort,
   *   seeded with the ended step's context summary and the queue's text. A missing summary is asked for once; if it is
   *   still missing, the seed is the queue's description and its finished steps' summaries. Without a known context
   *   window the fill does not count.
   * - The queue's closing refactoring step, in a session that has worked before: it runs in a fresh session, seeded
   *   with the queue's description and its steps' summaries (no summary is asked for).
   * - The same runtime with another model or effort: Claude Code's process is restarted with `--resume` and the new
   *   values (the step opens when the new process is up); Codex takes them with the next turn.
   */
  private prepareStep(queueId: string, run: RunFile, state: ProjectState, q: QueueView, done: StepView | undefined, next: StepView, want: StepValues, live: Live): boolean {
    const defaults = state.project.defaults;
    const old = state.sessions.find((x) => x.id === run.session);
    if (!old || old.runtime === "external") return false;
    // A switch (or the summary asked before it) waits while the runtime may still run a message sent into the step's
    // last turn as a turn of its own; it comes when that moment is over (settled), or that turn ends here (lateTurn).
    const settling = () => {
      if (!live.proc.settling) return false;
      if (!this.switchWaits.has(old.id)) this.store.appendActivity(old.id, { at: now(), kind: "turn_end", text: `Nexus waits a moment before step ${next.id}: a message sent into the last turn may still run as a turn of its own`, queue: queueId, step: done?.id ?? next.id });
      this.switchWaits.add(old.id);
      return true;
    };
    const tokens = old.live?.context_tokens, window = old.live?.context_window;
    const context = tokens && window ? { tokens, fill: tokens / window } : undefined;
    // The closing refactoring step reads the queue's work with fresh eyes: a session that has worked already (on the
    // queue's steps, or on another queue's) gives way to a fresh one, seeded with the queue's text and no summary.
    if (next.closing && old.event_count > 0) {
      if (settling()) return true;
      this.switchSession(queueId, run, q, old, live, done, next, want, "refactor", context, "fallback");
      return true;
    }
    const why = old.runtime !== want.runtime ? "runtime"
      : defaults.context_care && contextBeyond(tokens, window, defaults.context_reuse_tokens) ? "context" : undefined;
    if (why) {
      if (settling()) return true;
      // Fresh: written by this session at or after its latest start of the step that just ended.
      const since = done?.timeline.filter((e) => e.type === "step.started" && e.session === old.id).at(-1)?.at ?? run.started_at;
      const fresh = !!done && !!old.context && old.context.at >= since;
      const asked = !!done && run.summary_asked === done.id;
      if (done && !fresh && !asked) {
        const because = summaryReason(why, next.id, want.runtime, context);
        this.writeRun(queueId, { ...run, summary_asked: done.id });
        live.proc.send(summaryRequest(done.id, because));
        this.store.appendActivity(old.id, { at: now(), kind: "turn_start", text: `Nexus asked for the context summary of step ${done.id} (${because})`, queue: queueId, step: done.id });
        return true;
      }
      this.switchSession(queueId, run, q, old, live, done, next, want, why, context, fresh ?(asked ? "asked" : "written") : "fallback");
      return true;
    }
    // Idle beyond the cache's life (queue FI): the next turn here would write the whole context to the cache again, so
    // with a summary of the session's latest turn the next step runs in a fresh session, below the threshold too.
    // Without one nothing is asked: asking is a turn in this session, which rewrites the cache all the same.
    const idle = defaults.context_care && done ? idleMinutes(old.live?.last_turn, old.context, this.clock.now()) : undefined;
    if (idle !== undefined) {
      if (settling()) return true;
      this.switchSession(queueId, run, q, old, live, done, next, want, "idle", context, "written", idle);
      return true;
    }
    // Settings the process was launched with (permission mode, allow rules, the .nexus protection, sandbox, approvals,
    // the briefing) changed since: a new process from this step on, resuming the session.
    // Its model and effort are not compared here: they change below (Codex per turn, Claude Code by a restart).
    const stale = this.host.stale(old.id, this.launcher(this.store.readSession(old.id)), ["model", "effort"]);
    if (!stale && old.model === want.model && old.effort === want.effort) return false;
    const file = this.store.readSession(old.id);
    this.store.writeSession({ ...file, model: want.model, effort: want.effort });
    const what = stale ? "the project's changed settings" : `${want.model ?? "the runtime's default model"}, ${want.effort ? `${want.effort} effort` : "the default effort"}`;
    if (live.proc.retune && !stale) {
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

  /**
   * Before a turn within the run's step (a nudge, an answer, a send-back, a message; and after a turn that failed on
   * the usage limit, `failed`): when the session's runtime is beyond the usage
   * threshold, the step goes on by its fallback chain (routing.ts, chooseRoute): in a fresh session on the first free
   * entry (or on its own values again, when the session is on a fallback that is full now), seeded with the step's
   * work so far; at `wait`, or with no free entry, the run waits (usage_wait) for the earliest reset. Never while a turn
   * runs. True: taken over (the caller sends nothing now).
   */
  private usageGate(queueId: string, state: ProjectState, run: RunFile, live: Live | undefined, failed?: { until: string; reason: string }): boolean {
    if (questionsHold(state, queueId, run.step)) return true;
    if (!live || live.proc.state === "working" || !reachable(live.proc) || this.ending.has(live.session)) return false;
    const q = state.queues.find((x) => x.id === queueId);
    const step = q?.steps.find((s) => s.id === run.step);
    const session = state.sessions.find((x) => x.id === run.session);
    if (!q || !step || !session || session.runtime === "external") return false;
    const current = session.runtime as "claude" | "codex";
    // A turn that failed on the limit: its runtime is full until the reset it names, whatever usage.json says.
    const windows = { ...this.usageWindows(), ...(failed ? { [limitWindow(current)]: { utilization: 1, resets_at: failed.until } } : {}) };
    const threshold = state.project.defaults.usage_pause_threshold;
    const nowMs = this.clock.now();
    const full = overThreshold(current, windows, threshold, nowMs);
    if (!full) return false;
    const reason = failed?.reason ?? full.reason;
    const routed = stepRoute(this.startOf(state, run), step, q, state.project);
    const choice = chooseRoute(routed, { windows, threshold, nowMs, project: state.project });
    if (choice.kind === "wait") {
      // A failed turn's wait says what it always said (the run-state golden files keep it).
      this.writeRun(queueId, toUsageWait(run, failed ? `${reason}; goes on when it resets` : choice.reason, choice.until));
      this.schedule(queueId, choice.until, this.usageMarginMs);
      this.store.appendActivity(run.session, { at: now(), kind: "turn_end", text: `Nexus holds step ${step.id} until the usage window resets: ${choice.reason}`, queue: queueId, step: step.id });
      return true;
    }
    if (choice.values.runtime === current) return false;
    const issue = effortIssue(choice.values.runtime, choice.values.effort);
    if (issue) { this.halt(queueId, `step ${step.id} on its fallback: ${issue}`); return true; }
    const recorded = this.recordRoute(queueId, run, step.id, routed, choice.kind === "fallback" ? { ...choice, reason } : choice, true);
    this.switchMidStep(queueId, recorded, q, session, live, step, choice.values, reason);
    return true;
  }

  /**
   * Goes on with `step`, in its middle, in a fresh session on `want` that continues `old` (usageGate): the new session
   * gets the step's progress lines, its commits so far and the uncommitted changes (left in the checkout), the old
   * session's unread inbox entries, and the step's opening to continue it.
   */
  private switchMidStep(queueId: string, run: RunFile, q: QueueView, old: SessionView, live: Live, step: StepView, want: StepValues, reason: string): void {
    // What the step has done so far, read before anything opens a new round: its progress lines, its commits since its
    // round began, and what is uncommitted in the checkout (which stays as it is).
    const start = this.store.readGit(queueId)?.steps[step.id]?.at(-1)?.start;
    const lines = (out: string | undefined) => (out ?? "").split(/\r?\n/).filter((x) => x.trim());
    const work = {
      progress: step.timeline.filter((e) => e.type === "step.progress").map((e) => (e.type === "step.progress" ? `${e.text}${e.pct !== undefined ? ` (${e.pct} %)` : ""}` : "")),
      commits: start ? lines(gitRead(old.cwd, ["log", "--reverse", "--format=%h %s", `${start}..HEAD`])) : [],
      uncommitted: lines(gitRead(old.cwd, ["status", "--porcelain=v1", "--untracked-files=all"])),
      diffstat: lines(gitRead(old.cwd, ["diff", "--stat", "HEAD"])).at(-1)?.trim(),
    };
    const { fresh, unread } = this.forkSession(run, q, old, live, want);
    const because = `${reason}, so the step goes on on ${RUNTIME_NAME[want.runtime]}`;
    this.writeRun(queueId, {
      ...run, session: fresh.id, summary_asked: undefined, carry: undefined,
      switches: [...(run.switches ?? []), { at: now(), from: old.id, to: fresh.id, step: step.id, why: "usage", summary: "fallback" }],
    });
    this.store.appendActivity(old.id, { at: now(), kind: "turn_end", text: `Nexus goes on with step ${step.id} in a fresh session (${fresh.id}): ${because}`, queue: queueId, step: step.id });
    const state = loadProjectState(this.store);
    this.ensureProcess(fresh);
    const seed = midStepSeed(q, step, because, work);
    const carried = carriedMessages(unread.map((m) => formatInbox(m, state, true)));
    const view = this.queue(state, queueId);
    const sent = this.openStep(queueId, view.steps.find((s) => s.id === step.id) ?? step, view, "continue", "its earlier session's runtime reached the usage limit", { before: seed, after: carried });
    this.recordCarried(old.id, fresh.id, unread, sent);
  }

  /**
   * Goes on with `next` in a fresh session (with `want`'s runtime, model and effort) that continues `old`; `idle`: how
   * many minutes the old session was idle (why `idle`).
   */
  private switchSession(queueId: string, run: RunFile, q: QueueView, old: SessionView, live: Live, done: StepView | undefined, next: StepView, want: StepValues, why: "context" | "runtime" | "refactor" | "idle", context: ContextSize | undefined, source: "written" | "asked" | "fallback", idle?: number): void {
    const { fresh, unread } = this.forkSession(run, q, old, live, want);
    const because = switchReason(why, next.id, want.runtime, old.runtime as "claude" | "codex", context, idle);
    this.writeRun(queueId, {
      ...run, session: fresh.id, summary_asked: undefined, carry: undefined,
      switches: [...(run.switches ?? []), { at: now(), from: old.id, to: fresh.id, step: next.id, why, fill: context?.fill, ...(context ? { tokens: context.tokens } : {}), ...(idle !== undefined ? { idle_minutes: idle } : {}), summary: source }],
    });
    this.store.appendActivity(old.id, { at: now(), kind: "turn_end", text: `Nexus goes on in a fresh session (${fresh.id}): ${because}`, queue: queueId, step: done?.id ?? next.id });
    const state = loadProjectState(this.store);
    this.ensureProcess(fresh);
    const seed = freshSessionSeed(q, because, done, next, source === "fallback" ? undefined : old.context);
    const carried = carriedMessages(unread.map((m) => formatInbox(m, state)));
    const sent = this.openStep(queueId, next, this.queue(state, queueId), "start", undefined, { before: seed, after: carried });
    this.recordCarried(old.id, fresh.id, unread, sent);
  }

  /** If a newly arrived question held the opening, preserve the messages without claiming delivery. */
  private recordCarried(old: string, fresh: string, unread: SessionView["inbox"], sent: boolean): void {
    for (const m of unread) {
      if (sent) this.store.appendDelivered(old, { at: now(), kind: "inbox", id: m.id, via: "carried", to: fresh });
      else this.store.appendInbox(fresh, m);
    }
  }

  /**
   * A fresh worker session on `want` that continues `old` (switchSession, switchMidStep): written, the old one marked
   * as continued by it and its process ended. Returns it, and what the old session has not read yet, which goes into
   * the new one's first turn.
   */
  private forkSession(run: RunFile, q: QueueView, old: SessionView, live: Live, want: StepValues): { fresh: SessionFile; unread: SessionView["inbox"] } {
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
    const all = loadProjectState(this.store).sessions.find((x) => x.id === old.id)?.inbox ?? [];
    const inbox = all.filter((m) => !m.read_at);
    // What a late turn Nexus ended had taken in (lateTurn, the run's `carry`): delivered to the old session, but never
    // worked on there. The caller's run write drops `carry`.
    const late = all.filter((m) => m.read_at && run.carry?.includes(m.id));
    this.switchWaits.delete(old.id);
    const unread = [...inbox, ...late];
    this.ending.add(old.id);
    live.proc.close();
    return { fresh, unread };
  }

  /**
   * The run's start for the step that opens now (routing.ts, StartValues): its values, with those it took from the
   * project's defaults (`from_defaults`) not explicit, so the effective settings (and a step's kind) decide them now.
   * A model or effort chosen at the start belongs to the runtime the run started on. An older run file without its
   * values: its session's, all explicit.
   */
  private startOf(state: ProjectState, run: RunFile): StartValues {
    const recorded = runStart(run);
    if (recorded) return recorded;
    const s = this.sessionFile(state, run.session);
    return { runtime: s.runtime === "codex" ? "codex" : "claude", model: s.model, effort: s.effort, explicit: START_KEYS };
  }

  private openStep(queueId: string, step: StepView, q: QueueView, mode: "start" | "continue", why?: string, around: { before?: string; after?: string } = {}): boolean {
    const run = this.run(queueId);
    const live = this.host.get(run.session);
    if (!live) { this.halt(queueId, "the session's process is not running"); return false; }
    // Exited, its exit still to come (a Resume in that moment): the exit tries the turn again, as after a crash.
    if (live.proc.exiting) return false;
    const state = loadProjectState(this.store);
    const project = state.project;
    // The step to open and the one the run was at: open questions of either hold the turn (checked again before sending).
    const held = (s: ProjectState) => questionsHold(s, queueId, step.id) || questionsHold(s, queueId, run.step);
    if (held(state)) return false;
    const notes = step.notes.filter((n) => !n.read_at && n.to !== "orchestrator"); // the orchestrator's are not the worker's
    const answers = state.questions.filter((x) => x.queue === queueId && x.step === step.id && x.state === "answered");
    // The report is asked of the last step that runs with a model before the integration step (queue MI): the
    // integration step's worker writes it only for a queue that has none.
    const last = !q.steps.some((s) => s.status === "pending" && s.id !== step.id && !s.integration) && (!step.integration || !q.report);
    // The rounds of commits are recorded before the worker hears of the step: reading HEAD (git) may take a second or
    // two on a busy machine, and a worker told first had committed meanwhile (seen in a full test run, queue TS1). The
    // step before ends its round here at the latest (its turn's end records it a moment later, after the CLI's last
    // events).
    // The step before's end and this one's start read HEAD once: one synchronous go, nothing between (queue SV2B).
    const headNow = headOnce(this.store, queueId);
    if (run.step && run.step !== step.id) recordStepEnd(this.store, queueId, run.step, headNow);
    // The closing refactoring step is given the queue's commit range, read once the step before has ended its round.
    const closing = step.closing ? closingContext(this.store, q) : undefined;
    // The integration step is given the base to merge, where it is now, and whether it may resolve a conflict.
    const integration = step.integration ? this.withConflicts(q, integrationContext(this.store, state, q), mode) : undefined;
    const pull = mode === "start" ? this.pullOpening(q, step.id) : undefined;
    recordStepStart(this.store, queueId, step.id, run.session, headNow);
    // A step this engine opens has its checks run by Nexus; one opened by an older server keeps the worker's.
    if (mode === "start") this.checks?.opened(queueId, step.id);
    const checksByNexus = !!this.checks && this.store.readChecks(queueId)?.steps[step.id]?.by === "nexus";
    const opening = stepOpening({
      q, step, mode, why, projectStopConditions: project.defaults.stop_conditions, projectChecks: run.checks, notes, answers, last,
      report: reportFile(project.id, q.id), languages: workerLanguages(project.languages), closing, integration, checksByNexus, pull,
    });
    if (held(loadProjectState(this.store))) return false;
    live.proc.send([around.before, opening, around.after].filter(Boolean).join("\n\n"));
    for (const n of notes) this.store.appendDelivered(run.session, { at: now(), kind: "note", id: n.id, via: "turn" });
    this.endBackgroundWait(queueId);
    this.writeRun(queueId, { ...run, step: step.id, nudged: false, ...(mode === "start" ? { retries: undefined, failure: undefined, summary_asked: undefined } : {}) });
    this.store.appendActivity(run.session, { at: now(), kind: "turn_start", text: `Nexus opened step ${step.id}${mode === "continue" ? " (continue)" : ""}${around.before ? " in a fresh session, with what the previous one handed over" : ""}`, queue: queueId, step: step.id });
    return true;
  }

  /**
   * The integration step without a model (queue MI; docs/protocol/git.md, "Without a model"): when Nexus runs the step's checks,
   * the queue's worktree has no uncommitted changes to tracked files and the merge is plain, the engine merges the base
   * itself and reports the step done from its own session; the checks then run as after any done. No base branch, or a
   * conflict the project does not let a worker resolve: it stops the step itself. False: a worker opens the step as
   * before (a dirty worktree, a conflict to resolve, an engine without the checks).
   */
  private integrateWithoutModel(queueId: string, run: RunFile, state: ProjectState, q: QueueView, step: StepView): boolean {
    const cwd = ownWorktree(q);
    if (!this.checks || !cwd) return false;
    // HEAD and the checkout's state from one git call, HEAD reused below for the records and the merge: everything up
    // to the merge is one synchronous go, so nothing moves it meanwhile (queue SV2B).
    const status = checkoutStatus(cwd);
    if (!status?.clean) return false;
    const before = () => status.head;
    const ctx = integrationContext(this.store, state, q);
    const conflicts = ctx.base ? mergeConflicts(cwd, ctx.base) : [];
    if (conflicts.length && ctx.resolve) return false;
    ensureNexusSession(this.store);
    const event = (e: Record<string, unknown>) => this.store.appendEvent({ v: 1, id: newId(), at: now(), session: NEXUS_SESSION, queue: queueId, step: step.id, ...e } as Parameters<ProjectStore["appendEvent"]>[0]);
    const say = (text: string) => this.store.appendActivity(NEXUS_SESSION, { at: now(), kind: "text", text, queue: queueId, step: step.id });
    if (run.step && run.step !== step.id) recordStepEnd(this.store, queueId, run.step, before);
    recordStepStart(this.store, queueId, step.id, NEXUS_SESSION, before);
    this.checks.opened(queueId, step.id);
    this.writeRun(queueId, { ...run, step: step.id, nudged: false, retries: undefined, failure: undefined, summary_asked: undefined });
    event({ type: "step.started" });
    const branch = ctx.branch ?? q.branch ?? "the queue's branch";
    const stop = (reason: string) => {
      event({ type: "queue.stop", condition: INTEGRATION_CONDITION, reason });
      say(`Nexus stopped the integration step: ${reason}`);
      recordStepEnd(this.store, queueId, step.id, before); // no merge made, or one aborted: HEAD is where it was
    };
    if (!ctx.base) { stop("no base branch to merge"); return true; }
    if (conflicts.length) { stop(`${fileList(conflicts)}: Nexus does not resolve conflicts (the project's resolve_conflicts setting is off)`); return true; }
    event({ type: "step.progress", text: `Nexus merges ${ctx.base} into ${branch} without a model` });
    const m = mergeBase(cwd, ctx.base, { from: status.head ?? undefined, sha: ctx.sha, clean: true });
    if (!m) { stop(`git could not read ${ctx.base} or the branch`); return true; }
    if (m.result === "conflict") { stop(`${fileList(m.conflicts)}: the merge of ${ctx.base} conflicts`); return true; }
    const sha = m.sha.slice(0, 12);
    const untested = stepChecks(run.checks, q.checks).length ? "" : " No check ran: the merge is untested.";
    const summary = m.result === "merged"
      ? `Nexus merged ${ctx.base} (${sha}) into ${branch} without a model: ${mergedText(m)}; no conflict.${untested}`
      : `${branch} already contains ${ctx.base} (${sha}): nothing to merge.${untested}`;
    event({ type: "step.done", summary, commit: m.result === "merged" ? m.to : m.from, activities: ["integration"] });
    say(summary);
    recordStepEnd(this.store, queueId, step.id, () => (m.result === "merged" ? m.to : m.from));
    this.changed();
    this.advanceUnlocked(queueId);
    return true;
  }

  /**
   * The integration step Nexus ran without a model was left between its start and its done (the server stopped): a
   * merge left half done is aborted, and the step runs again from its start (a merge already made is found as nothing to
   * merge); else a worker opens it.
   */
  private integrateAgain(queueId: string, run: RunFile, state: ProjectState, q: QueueView, step: StepView): void {
    const cwd = ownWorktree(q);
    if (cwd && gitRead(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])) gitRead(cwd, ["merge", "--abort"]);
    const g = this.store.readGit(queueId);
    const last = g?.steps[step.id]?.at(-1);
    if (g && last && last.end === undefined) { last.end = last.start; last.ended_at = now(); this.store.writeGit(queueId, g); }
    if (this.integrateWithoutModel(queueId, run, state, q, step)) return;
    this.openStep(queueId, step, q, "start");
  }

  /** Nexus accepts the integration step it ran without a model, every check passed (queue MI). */
  private acceptWithoutModel(queueId: string, step: StepView): void {
    ensureNexusSession(this.store);
    this.store.appendEvent({ v: 1, id: newId(), at: now(), session: NEXUS_SESSION, type: "review.accepted", queue: queueId, step: step.id, text: "accepted by Nexus: a clean merge without a model, and every check passed" });
    this.store.appendActivity(NEXUS_SESSION, { at: now(), kind: "text", text: `Nexus accepted step ${step.id}: a clean merge without a model, and every check passed`, queue: queueId, step: step.id });
    this.changed();
  }

  /** A check-fix round of the integration step Nexus ran without a model begins with what Nexus did (queue MI). */
  private fixPreface(queueId: string, step: string): string | undefined {
    const state = loadProjectState(this.store);
    const q = state.queues.find((x) => x.id === queueId);
    if (!q?.steps.find((s) => s.id === step)?.model_free) return undefined;
    const cwd = checkoutOf(this.store, q);
    return modelFreeFixPreface(q, step, integrationContext(this.store, state, q), cwd ? revParse(cwd, "HEAD") : undefined);
  }

  /** The integration step's context, with the files Nexus finds in conflict when the step opens anew (queue MI). */
  private withConflicts(q: QueueView, ctx: IntegrationContext, mode: "start" | "continue"): IntegrationContext {
    const cwd = checkoutOf(this.store, q);
    if (!this.checks || mode !== "start" || !ctx.base || !cwd) return ctx;
    const conflicts = mergeConflicts(cwd, ctx.base);
    return conflicts.length ? { ...ctx, conflicts } : ctx;
  }

  /** What the merge of the base right before the step brought, or that it conflicts, for the step's opening (queue MI). */
  private pullOpening(q: QueueView, step: string): PullText | undefined {
    const p = pullBefore(this.store, q.id, step);
    const cwd = checkoutOf(this.store, q);
    if (!p || !cwd) return undefined;
    if (!p.to) return { base: p.base, sha: p.sha, conflicts: p.conflicts ?? [] };
    const commits = Number(gitRead(cwd, ["rev-list", "--count", `${p.from}..${p.sha}`]) ?? 0);
    return { base: p.base, sha: p.sha, merged: { commits, files: changedFiles(cwd, p.from, p.to) } };
  }

  /** Hands unread inbox entries to a live session: inside a running turn, or as a new turn when it is idle. */
  private deliverInbox(state: ProjectState, l: Live): void {
    // A process Nexus is ending gets nothing more (a session taken over had its unread entries carried across).
    if (!reachable(l.proc) || this.ending.has(l.session) || this.cleaning.has(l.proc)) return;
    const s = state.sessions.find((x) => x.id === l.session);
    // While a switch waits for the old session's settling (switchWaits), only a stop reaches it: anything else would
    // start a turn there, taken for a late turn and ended with its process (queue LH); unread, it goes to the fresh
    // session's first turn with the rest of the inbox (switchSession).
    const unread = (s?.inbox ?? []).filter((m) => !m.read_at && (m.type === "stop" || !this.switchWaits.has(l.session)));
    if (!unread.length) return;
    if (l.proc.state === "working") for (const m of unread) if (m.type === "answer") this.liveAnswerIds.add(m.id);
    const owners = state.queues.filter(q => q.run?.session === l.session && q.run.state !== "finished");
    // A reused session can still appear in an older halted run. Its current run owns the inbox barrier.
    const owner = owners.find(q => runGoing(q.run)) ?? owners.find(q => q.id === s?.queue) ?? owners.at(-1);
    const run = owner?.run;
    const step = owner?.steps.find((st) => st.id === run?.step);
    // Partial answers remain durable in the inbox but cannot start or steer work. Stop messages still reach it.
    const questionsOpen = !!owner && questionsHold(state, owner.id, run?.step);
    if (owner && l.proc.state === "idle" && (owner.status === "stopped" || (step && OUTCOME.has(step.status))) && this.cleanWorker(owner.id, l)) return;
    const allowed = !run || (run.state === "running" && owner?.status !== "stopped" && !owner?.rejection && step?.status !== "review");
    const idleAllowed = allowed && !(owner && this.inboxHeld(owner.id, unread, l.proc.state === "idle" && !questionsOpen));
    // A new turn of an idle session within its step (an answer, a send-back, a message): its runtime beyond the usage
    // threshold goes on on the step's fallback in a fresh session, which gets these entries (or the run waits). A stop
    // is not a turn; an entry for a working session goes into its running turn, which is never cut off.
    if (!questionsOpen && owner && run && idleAllowed && l.proc.state !== "working" && unread.some((m) => m.type !== "stop") && this.usageGate(owner.id, state, run, l)) return;
    // The language line goes with each message, so a changed setting reaches the session with its next message.
    const languages = workerLanguages(state.project.languages);
    // When the last answer releases a waiting worker, it sees the accumulated answers in one opening turn.
    const answers = unread.filter(m => m.type === "answer");
    const batch = !questionsOpen && idleAllowed && l.proc.state === "idle" && answers.length
      ? [...answers, ...unread.filter(m => m.type !== "answer" && m.type !== "stop")] : [];
    if (batch.length) {
      // Re-read at the delivery boundary: another question may have arrived while this change was processed.
      if (owner && questionsHold(loadProjectState(this.store), owner.id, run?.step)) return;
      l.proc.send(withLanguages(batch.map(m => formatInbox(m, state, !!owner)).join("\n\n"), languages));
      for (const m of batch) {
        if (m.type === "send_back" || m.type === "check_failed") recordStepStart(this.store, m.queue, m.step, l.session);
        this.store.appendDelivered(l.session, { at: now(), kind: "inbox", id: m.id, via: "turn" });
        this.liveAnswerIds.delete(m.id);
      }
    }
    // One by one: a stop always; the rest neither while questions are open nor when the batch took it. A run's answers
    // go only in the batch, and nothing reaches a run's session while its run may take no turn.
    for (const m of unread) {
      if (m.type !== "stop" && (questionsOpen || batch.includes(m) || (owner && (!idleAllowed || m.type === "answer")))) continue;
      const text = withLanguages(formatInbox(m, state), languages);
      if (m.type === "stop") l.proc.send(text, "now");
      else if (l.proc.state === "working") { l.proc.send(text, "next"); this.injected.set(l.session, [...(this.injected.get(l.session) ?? []), m]); }
      else if (idleAllowed) l.proc.send(text);
      else continue; // a paused run: keep it for later
      if (m.type === "send_back" || m.type === "check_failed") recordStepStart(this.store, m.queue, m.step, l.session); // the next round
      this.store.appendDelivered(l.session, { at: now(), kind: "inbox", id: m.id, via: l.proc.state === "working" ? "inject" : "turn" });
    }
  }

  /**
   * A run held at the limit opens no turn: its entries wait in the inbox (a stop still reaches it). One back from
   * waiting (its answers, a send-back: bringsBack) to an idle session with no question open (`asks`) asks for a place
   * first, and may be held now. Read from the file: the state given may be older than the coordinator's last hold or
   * release.
   */
  private inboxHeld(queueId: string, unread: readonly { type: string; id: string }[], asks: boolean): boolean {
    const run = this.store.readRun(queueId);
    if (!run) return false;
    if (run.held) return true;
    return asks && unread.some((m) => bringsBack(m, this.liveAnswerIds)) && this.heldAtLimit(queueId, run, "the turn its answers or send-back open");
  }

  /** Halts a run that is not halted yet; `failure`: the runtime's failure that halted it. */
  private halt(queueId: string, reason: string, failure?: string): void {
    const run = this.store.readRun(queueId);
    if (!run || run.state === "halted") return;
    this.clearTimer(queueId);
    this.writeRun(queueId, toHalted(run, reason, failure));
  }

  /**
   * A survey run (a maintenance queue in survey mode) only looks and reports: when one of its steps reports its end
   * (done, or waiting for its review), Nexus checks once that the step left no commit since its round began and no
   * changed tracked file in the queue's checkout (untracked files do not count, as at nexus step done). Otherwise it
   * stops the queue, under its own condition (recorded in the user's session, which the server writes), before the
   * step's review; the run halts as at any stop. True when it stopped it.
   */
  private surveyLeftWork(queueId: string, q: QueueView, step: StepView): boolean {
    if (q.maintenance !== "survey" || (step.status !== "done" && step.status !== "review" && step.status !== "checking")) return false;
    const key = `${queueId}:${step.id}:${step.finished_at ?? ""}`;
    if (this.surveyChecked.has(key)) return false;
    this.surveyChecked.add(key);
    const cwd = checkoutOf(this.store, q);
    const head = cwd ? revParse(cwd, "HEAD") : undefined;
    if (!cwd || head === undefined) return false; // not a git repository: nothing to check
    const start = this.store.readGit(queueId)?.steps[step.id]?.at(-1)?.start;
    const commits = start && start !== head ? Number(gitRead(cwd, ["rev-list", "--count", `${start}..HEAD`]) ?? 1) : 0;
    const changed = (gitRead(cwd, ["diff", "--name-only", "HEAD"]) ?? "").split(/\r?\n/).filter((l) => l.trim());
    if (!commits && !changed.length) return false;
    const left = [
      commits ? `${commits} commit${commits === 1 ? "" : "s"} since step ${step.id} began` : "",
      changed.length ? `changed tracked files (${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", ..." : ""})` : "",
    ].filter(Boolean).join(" and ");
    const user = ensureUserSession(this.store);
    // The stopped queue halts its run as any stop does, once the step's turn is over.
    this.store.appendEvent({ v: 1, id: newId(), at: now(), session: user.id, type: "queue.stop", queue: queueId, step: step.id, condition: SURVEY_CONDITION, reason: `the survey run left ${left}` });
    return true;
  }

  /** The queue has no step left: every step is done or skipped, or rejected by the user and released (stepClosed). */
  /** A reported outcome is still success when its review was accepted before process exit arrived. */
  private reportedStep(queueId: string): boolean {
    const run = this.store.readRun(queueId);
    const q = loadProjectState(this.store).queues.find((x) => x.id === queueId);
    const status = q?.steps.find((s) => s.id === run?.step)?.status;
    return status !== undefined && ["review", "checking", "done", "skipped", "rejected"].includes(status);
  }

  private nothingLeft(queueId: string): boolean {
    const state = loadProjectState(this.store);
    const q = state.queues.find((x) => x.id === queueId);
    return !!q && !questionsHold(state, queueId, q.run?.step) && q.steps.length > 0 && q.steps.every((s) => stepClosed(q, s));
  }

  /** Ends a going run as finished (its last step is done). */
  private finish(queueId: string): void {
    const run = this.store.readRun(queueId);
    if (!run || (run.state !== "running" && run.state !== "pausing")) return;
    if (questionsHold(loadProjectState(this.store), queueId, run.step)) return;
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
      // The runtime counts as full until the reset the failure names, at this choice and at the next step's too.
      const runtime = this.store.readSession(run.session).runtime;
      if (runtime === "claude" || runtime === "codex") this.limitsMet.set(limitWindow(runtime), { utilization: 1, resets_at: f.resetsAt });
      // A turn after the step's outcome (the context summary asked for at its boundary): the step is not taken up again
      // on its fallback; the next step opens where the route says now, on the fallback or after a wait (queue LF, F2).
      const step = run.step ? this.queue(loadProjectState(this.store), queueId).steps.find((s) => s.id === run.step) : undefined;
      if (step && STEP_ENDED.has(step.status)) return this.advance(queueId);
      // Within the step: its fallback chain first.
      const live = this.host.get(run.session);
      if (live && this.usageGate(queueId, loadProjectState(this.store), run, live, { until: f.resetsAt, reason: `the usage limit was reached (${what})` })) return;
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
    const busy = state.queues.find((q) => q.id !== queueId && q.run?.session === id && runGoing(q.run));
    if (busy) throw new ActionError(`that session is running queue ${busy.id}`, 409);
    const issue = effortIssue(s.runtime, effort);
    if (issue) throw new ActionError(issue);
    const updated: SessionFile = { ...s, queue: queueId, model, effort };
    this.store.writeSession(updated);
    return updated;
  }

  /**
   * How a worker session's process is started, from the session and the project's effective settings now: also what
   * a running process is compared with to see whether its settings changed (AgentHost.stale).
   */
  private launcher(session: SessionFile): (resume: boolean) => Launch {
    const project = this.store.readProject();
    const env = this.host.env(session.id);
    return (resume: boolean): Launch => {
      if (session.runtime === "codex") {
        const codex = project.runtimes.codex;
        const inside = normPath(this.store.dir).toLowerCase().startsWith(normPath(session.cwd).toLowerCase() + "/");
        return { runtime: "codex", options: {
          cwd: session.cwd, model: session.model ?? codex.model, effort: session.effort ?? codex.effort, instructions: workerBriefing(project.languages, "codex"), env,
          threadId: session.native_id, sandbox: codex.sandbox, approvalPolicy: codex.approval_policy, approvalsReviewer: codex.approvals_reviewer,
          // The folder for reports: the last step's report is written there (outside the working tree).
          writableRoots: [...(inside ? [] : [this.store.dir]), ...gitWritableRoots(session.cwd), ensureReportFolder(project.id)],
          // Without the user's own Codex tools (queue FX): an MCP server runs outside the sandbox, so it could reach
          // this machine's Nexus API; only the servers the project names stay on.
          withoutUserTools: true, keepMcpServers: codex.mcp_servers,
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
        // The nexus CLI on every shell tool; the project's own rules as they are.
        allowedTools: [...shellRules(["nexus"]), ...claude.allowed_tools],
        // The project's .nexus is the server's (and the CLI's) to write, not the worker's file tools'. Its absolute
        // path: the worker's cwd may be a worktree whose own .nexus does not exist.
        disallowedTools: project.defaults.protect_nexus ? nexusDenyRules(this.store.dir) : undefined,
        appendSystemPrompt: workerBriefing(project.languages),
        lateTurnMs: this.lateTurnMs, // undefined: Claude's default
        env,
      } };
    };
  }

  /**
   * The runtime starts a turn of its own with messages sent into the step's last turn while a switch waits (queue LF,
   * F3): the turn is ended at its start, so the old session works no turn beside the fresh one, and those messages go
   * to the fresh session's first turn (forkSession). Its process is ended as at a restart: the exit handler starts the
   * session's process again, and the next look switches.
   */
  private lateTurn(session: string): void {
    this.switchWaits.delete(session);
    const live = this.host.get(session);
    if (!live) return;
    const late = this.lastInjected.get(session) ?? [];
    this.lastInjected.delete(session);
    // Kept in the run's file (queue LH): a server that ends before the switch still gives them to the fresh session.
    for (const id of this.store.queueIds()) {
      const run = this.store.readRun(id);
      if (run?.session === session && run.state !== "finished") this.writeRun(id, { ...run, carry: [...new Set([...(run.carry ?? []), ...late.map((m) => m.id)])] });
    }
    this.store.appendActivity(session, { at: now(), kind: "turn_end", text: `Nexus ends the turn the runtime started by itself at the step's end: the session goes on in a fresh one, which gets ${late.length === 1 ? "the message" : "the messages"} sent into its last turn` });
    this.restarting.add(session);
    this.ending.add(session);
    live.proc.kill();
  }

  /**
   * Ends the worker processes AgentHost holds for a done or cancelled queue (Merger: before its worktree is cleaned up;
   * the user's Clean up). True when none of them is alive any more; a queue not closed is left alone (true: its cleanup
   * is refused anyway).
   */
  endQueueProcesses(queueId: string): boolean {
    const state = loadProjectState(this.store);
    const status = state.queues.find((q) => q.id === queueId)?.status;
    if (status !== "done" && status !== "cancelled") return true;
    return !this.endProcesses((q) => q === queueId, { state });
  }

  /**
   * Ends the processes AgentHost holds for the worker sessions of the queues `of` names (a session belongs to the queue
   * its file names), except `keep`'s and any session a going run works in (queue PRC). A process in the middle of a turn
   * ends after that turn (its input closes: a done queue's last turn may still write its context summary), any other
   * now; one Nexus is ending already (its run finished, its session switched) is left to end as it does. Each exits as
   * one Nexus ended (no failure, nothing to retry) and its runtime record becomes `exited` (AgentHost's exit handler).
   * Returns whether any of them is still alive. `state`: the project's state as it stands, when the caller has it (else
   * the files are read).
   */
  private endProcesses(of: (queue: string) => boolean, o: { keep?: string; state?: ProjectState } = {}): boolean {
    const { state } = o;
    const sessionFile = (id: string) => (state ? state.sessions.find((x) => x.id === id) : this.store.readSession(id));
    const runs = () => (state ? state.queues.map((q) => q.run) : this.store.queueIds().map((q) => this.store.readRun(q)));
    let alive = false;
    let going: Set<string> | undefined; // read once, and only when a process of the queues is found
    for (const l of this.host.all()) {
      if (l.session === o.keep || l.proc.state === "exited") continue;
      let s: SessionFile | undefined;
      try { s = sessionFile(l.session); } catch { continue; }
      if (s?.role !== "worker" || !s.queue || !of(s.queue)) continue;
      going ??= new Set(runs().flatMap((r) => (r && runGoing(r) ? [r.session] : [])));
      if (going.has(l.session)) continue;
      alive = true;
      if (this.ending.has(l.session)) continue;
      this.ending.add(l.session);
      if (l.proc.state === "working") l.proc.close(); else l.proc.kill();
    }
    return alive;
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
    this.exitedAfterOutcome.delete(session.id);
    const launch = this.launcher(session);
    const tag = () => {
      // The run that drives the session now; a session continued from an earlier queue still has that one's run too.
      const runs = this.store.queueIds().map((q) => [q, this.store.readRun(q)] as const).filter(([, r]) => r?.session === session.id);
      const run = runs.find(([, r]) => runGoing(r)) ?? runs.sort(([, a], [, b]) => b!.updated_at.localeCompare(a!.updated_at))[0];
      if (!run) return {};
      // A turn of a step on its fallback says so in its record: what it would have run on, and why it did not.
      const f = run[1]?.fallbacks?.findLast((x) => x.step === run[1]?.step);
      return { queue: run[0], step: run[1]?.step, ...(f && !f.back ? { fallback: { from: f.from.runtime, reason: f.reason } } : {}) };
    };
    const runsOf = () => this.store.queueIds().filter((q) => this.store.readRun(q)?.session === session.id);
    // AgentHost keeps the runtime record (a turn's end counts in `turns`), the facts and the usage windows; these
    // handlers run after it.
    const live = this.host.start(session, launch, {}, () => ({
      tag,
      activity: (a) => {
        if (a.kind === "turn_start" && this.switchWaits.has(session.id)) this.lateTurn(session.id);
        const t: { queue?: string; step?: string } = tag();
        this.store.appendActivity(session.id, { at: now(), ...a, ...t });
        // The HEAD around each turn of a step: which commits the step made (src/gitinfo.ts).
        if ((a.kind === "turn_start" || a.kind === "turn_end") && t.queue && t.step) {
          recordTurn(this.store, t.queue, t.step, a.kind === "turn_start" ? "start" : "end");
        }
      },
      refusal: (r) => {
        // One record per refusal, also across processes of the session (a resumed runtime may repeat its list).
        if (r.ref && this.store.readRefusals(session.id).entries.some((x) => x.ref === r.ref)) return;
        this.store.appendRefusal({ at: now(), session: session.id, runtime: session.runtime === "codex" ? "codex" : "claude", ...r, ...tag() });
        this.changed();
      },
      background: (work) => {
        // The work a run waits for has ended with the session idle: look again a little later (Claude Code starts a
        // turn by itself first; Codex does not, and the usual rule applies).
        if (work.length) return;
        const key = `background-ended:${session.id}`;
        clearTimeout(this.timers.get(key));
        this.timers.set(key, setTimeout(() => {
          this.timers.delete(key);
          for (const q of runsOf()) if (this.backgroundWaits.has(q)) this.advance(q);
          this.changed();
        }, BACKGROUND_SETTLE_MS));
      },
      settled: () => {
        // The messages sent into the last turn were read in it; a switch waiting for this moment comes now.
        this.lastInjected.delete(session.id);
        if (!this.switchWaits.delete(session.id)) return;
        for (const q of runsOf()) this.advance(q);
        this.changed();
      },
      turnEnd: (end) => {
        this.lastInjected.set(session.id, this.injected.get(session.id) ?? []);
        this.injected.delete(session.id);
        const live = this.host.get(session.id);
        if (live && !this.stopping.has(session.id)) {
          this.cleaned.delete(live.proc);
          for (const q of loadProjectState(this.store).queues.filter((q) => q.run?.session === session.id && q.run.state !== "finished")) {
            if (q.run?.state === "paused" || q.run?.state === "halted") this.cleanWorker(q.id, live);
          }
        }
        if (this.stopping.has(session.id)) return;
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
            // The step boundary begins: a measured section (queue GB).
            if (st && OUTCOME.has(st.status)) perf.section("step boundary: end", () => { recordStepEnd(this.store, q.id, st.id); this.advance(q.id); });
            else this.advance(q.id);
          }
          this.changed();
        }, this.turnSettleMs);
      },
      exit: (code) => {
        // Ended by Nexus (shutdown, the hand-over of an update, an update's drain with `now`, a finished run): no
        // failure. Any other exit is a crash, and the turn is tried again on a new process that resumes the session.
        const byNexus = this.stopped || this.ending.delete(session.id);
        this.store.appendActivity(session.id, { at: now(), kind: code === 0 || byNexus ? "exit" : "error", text: `process exited (${code ?? "signal"})${byNexus ? ", ended by Nexus" : ""}`, ...tag() });
        if (this.restarting.delete(session.id)) {
          this.clearRestartKill(session.id);
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
          // Its step reported an outcome: no failed turn, even if review acceptance beat the delayed exit notice.
          // The run waits for review or starts a fresh process for the next step.
          if (this.reportedStep(q)) { this.exitedAfterOutcome.add(session.id); continue; }
          this.turnFailed(q, { kind: "passing", code: "processExited", text: `the runtime's process exited (${code ?? "signal"})` });
        }
        this.changed();
      },
    }));
    // A process that has run no turn has left nothing to clean: its first cleanup barrier comes after a turn (the
    // turn's end clears this mark). Without it, a step boundary that starts a new process (a model change) asked the
    // process to clean while its Windows job host was still starting, and the 15 s cleanup limit then counted the host's
    // start, which on a busy machine took longer and halted the run (queue CI8).
    this.cleaned.add(live.proc);
    return live;
  }

  // ---------------------------------------------------------------- usage limits

  /** The usage windows now: usage.json's, and the limits turns failed on (limitsMet). */
  private usageWindows(): Record<string, { utilization: number; resets_at?: string }> {
    return { ...(readUsage()?.windows ?? {}), ...Object.fromEntries(this.limitsMet) };
  }

  /** Where a step opens given the account's usage windows now and the project's threshold (routing.ts, chooseRoute). */
  private chooseFor(state: ProjectState, routed: Routed): ReturnType<typeof chooseRoute> {
    return chooseRoute(routed, { windows: this.usageWindows(), threshold: state.project.defaults.usage_pause_threshold, nowMs: this.clock.now(), project: state.project });
  }

  /**
   * Records a step that opens on its fallback, or on its own values again after one did (run.yaml `fallbacks`), once
   * per step (advance runs again while a summary is asked for), with an activity line; the orchestrator is told from
   * the record. Returns the run as written.
   */
  private recordRoute(queueId: string, run: RunFile, step: string, own: Routed, choice: ReturnType<typeof chooseRoute>, mid = false): RunFile {
    const list = run.fallbacks ?? [];
    const last = list.at(-1);
    const from = { runtime: own.runtime, model: own.model, effort: own.effort };
    let entry: NonNullable<RunFile["fallbacks"]>[number];
    if (choice.kind === "fallback") {
      if (last && !last.back && last.step === step && last.runtime === choice.values.runtime) return run;
      entry = { at: now(), step, ...choice.values, from, reason: choice.reason };
    } else if (last && !last.back && (last.step !== step || mid)) {
      entry = { at: now(), step, ...from, from: { runtime: last.runtime, model: last.model, effort: last.effort }, reason: "its usage is below the limit again", back: true };
    } else return run;
    const next: RunFile = { ...run, fallbacks: [...list, entry] };
    this.writeRun(queueId, next);
    this.store.appendActivity(run.session, {
      at: now(), kind: "text", queue: queueId, step,
      text: entry.back ? `Step ${step} runs on ${RUNTIME_NAME[entry.runtime]} again: ${entry.reason}` : `Step ${step} runs on its fallback, ${RUNTIME_NAME[entry.runtime]}: ${entry.reason}`,
    });
    return next;
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
      try { this.resumeByItself(queueId, why); } catch (e) { this.halt(queueId, `could not go on: ${(e as Error).message}`); }
      this.changed();
    });
  }

  /** A queue's retry or usage-wait timer. */
  private clearTimer(queueId: string): void { this.clockTimers.clear(queueId); }

  /** Drops the timer that kills a restarting session's old process when it does not exit by itself. */
  private clearRestartKill(session: string): void {
    clearTimeout(this.timers.get(`restart:${session}`));
    this.timers.delete(`restart:${session}`);
  }

  // ---------------------------------------------------------------- helpers

  private recoverAfterRestart(): void {
    // A step an earlier run left open while a newer revision went on (no live run of it) goes back to pending. One
    // state for every queue (queue SM): between two queues it changes only by such a release, read again after one.
    let state = loadProjectState(this.store);
    for (const q of this.store.queueIds()) if (releaseOrphanedSteps(this.store, q, { state }).length) state = loadProjectState(this.store);
    for (const q of this.store.queueIds()) {
      const run = this.store.readRun(q);
      const view = state.queues.find((x) => x.id === q);
      const left = view && (questionsHold(state, q, run?.step) || view.steps.some((s) => !stepClosed(view, s)));
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
          try { this.resumeByItself(q); } catch (e) { this.halt(q, `could not resume after the update: ${(e as Error).message}`); }
          this.changed();
        }, this.startupMs));
      } else if (run && ["running", "pausing"].includes(run.state)) {
        this.writeRun(q, toPaused(run, "the Nexus server restarted; resume to continue"));
      } else if (run?.state === "approval_wait" && view?.approved) {
        // Approved while no server ran (or while an update drained): it goes on shortly, once this server is up.
        this.timers.set(`recover:${q}`, setTimeout(() => {
          this.timers.delete(`recover:${q}`);
          if (this.store.readRun(q)?.state === "approval_wait") this.continueApproved(q);
          this.changed();
        }, this.startupMs));
      }
      if (run?.state === "usage_wait" && run.resume_at) this.schedule(q, run.resume_at, this.usageMarginMs);
    }
    for (const s of this.store.sessionIds()) {
      const r = this.store.readRuntime(s);
      if (!r || r.state === "exited") continue;
      // Windows workers belong to their host's job, which closes when the server pipe closes. A persisted PID
      // alone is not ownership evidence: it may already refer to another program after a restart.
      const jobOwned = process.platform === "win32" && this.store.readSession(s).role === "worker";
      if (!jobOwned && r.pid && isAlive(r.pid)) { try { process.kill(r.pid); } catch { /* gone or not ours */ } }
      // A turn the old server left open (it crashed): recorded as interrupted (queue CK).
      this.host.closeLeftTurn(s);
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
    // A run that stops going is stamped after what its worker wrote last, even a line the watcher has not delivered
    // yet: reading the session's log takes its times up (docs/design/state.md, "Clock steps").
    if (runEnded(run) && !(old && runEnded(old)) && run.session) this.store.readEvents(run.session);
    const ended = runEnded(run)
      ? (old && runEnded(old) && old.ended_at ? old.ended_at : now())
      : undefined;
    this.store.writeRun(queueId, { ...run, ended_at: ended, updated_at: now() });
    this.coordinator.runChanged();
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
