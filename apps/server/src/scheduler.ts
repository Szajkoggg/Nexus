// Planned starts of queues (queues/<id>/start.yaml): chains (start when another queue is done) and schedules (start at a
// time, or when a runtime's usage window resets). The engine owns the runs; the scheduler decides when a planned start
// comes due and asks the engine to start the queue. Also the long timers both use (ClockTimers): a retry or usage wait
// of a run, and a schedule's time, armed on a clock tests can move.
import {
  ActionError, HOLDING_RUN_STATES, effortIssue, formatClock, loadProjectState, now, readUsage, type ProjectState, type ProjectStore, type QueueView, type RunFile,
} from "@nexus/protocol";
import type { StartOptions } from "./engine.ts";
import { waitingText, type Block } from "./coordinator.ts";
import { RUNTIME_NAME } from "./prompts.ts";

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

/** A chain: start the queue when another one is done (queues/<id>/start.yaml). */
export interface ChainOptions extends Omit<StartOptions, "after"> { after: string; by: "user" | "orchestrator"; reason?: string }

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

/** The long timers, by key, on a clock: each armed in pieces of at most MAX_TIMER_MS. */
export class ClockTimers {
  readonly clock: Clock;
  private readonly stopped: () => boolean;
  private readonly armed = new Map<string, unknown>();

  /** `stopped`: once true, a timer that comes does nothing. */
  constructor(clock: Clock, stopped: () => boolean) {
    this.clock = clock;
    this.stopped = stopped;
  }

  /**
   * Calls `fire` at `at` (ms since the epoch, on the clock), under `key` (replacing what was armed there). The
   * timer is armed in pieces of at most MAX_TIMER_MS, each re-checking the clock, so a time weeks ahead neither fires
   * at once (as setTimeout does beyond 2^31-1 ms) nor early.
   */
  wakeAt(key: string, at: number, fire: () => void): void {
    this.clear(key);
    const piece = Math.max(0, Math.min(at - this.clock.now(), MAX_TIMER_MS));
    this.armed.set(key, this.clock.setTimeout(() => {
      this.armed.delete(key);
      if (this.stopped()) return;
      if (this.clock.now() >= at) fire(); else this.wakeAt(key, at, fire);
    }, piece));
  }

  /** Disarms what is armed under `key`. */
  clear(key: string): void {
    if (this.armed.has(key)) this.clock.clearTimeout(this.armed.get(key));
    this.armed.delete(key);
  }

  /** Disarms every timer. */
  clearAll(): void {
    for (const t of this.armed.values()) this.clock.clearTimeout(t);
    this.armed.clear();
  }
}

/** What the scheduler needs of the engine. */
export interface SchedulerDeps {
  /** Starts the queue (Engine.start): throws when it cannot. */
  start(queueId: string, opts: StartOptions): RunFile;
  /** Nexus drains for an update: nothing new starts. */
  draining(): boolean;
  /** The engine was shut down: nothing more is written. */
  stopped(): boolean;
  changed(): void;
  /** Why the queue may not start now (its checkout held, the limit reached): the coordinator's startBlock. */
  block(state: ProjectState, q: QueueView): Block | undefined;
  /** A look at the planned starts of every project (the coordinator's pass). */
  checkStarts(): void;
  /** A start at "usage-reset" comes this long after the reset. */
  usageMarginMs: number;
}

export class Scheduler {
  private readonly store: ProjectStore;
  private readonly timers: ClockTimers;
  private readonly deps: SchedulerDeps;

  constructor(store: ProjectStore, timers: ClockTimers, deps: SchedulerDeps) {
    this.store = store;
    this.timers = timers;
    this.deps = deps;
  }

  /** Arms the schedules again (a new server): what came due while no server ran is looked at by checkStarts. */
  armAll(): void {
    for (const id of this.store.queueIds()) {
      const plan = this.store.readStart(id);
      if (plan?.at && !plan.failed) this.armStart(id, Date.parse(plan.at));
    }
  }

  /** A start of the queue used its plan up: its schedule's timer goes. */
  disarm(queueId: string): void { this.timers.clear(`start:${queueId}`); }

  /**
   * Plans to start `queueId` when queue `o.after` is done. When it already is, the queue starts now (or, while an
   * update drains, right after it). Replaces an earlier plan of the queue. Returns what happened, in a sentence.
   */
  chain(queueId: string, o: ChainOptions): string {
    const state = loadProjectState(this.store);
    const q = queueOf(state, queueId);
    const a = state.queues.find((x) => x.id === o.after);
    if (!a) throw new ActionError(`unknown queue ${o.after}`, 404);
    if (a.id === q.id) throw new ActionError("a queue cannot start after itself");
    const options = this.planOptions(state, q, o);
    if (a.status === "cancelled") throw new ActionError(`queue ${a.id} is cancelled: it will never be done`, 409);
    // No loop: following the plans from A must not come back to this queue.
    for (let at: string | undefined = a.id, seen = new Set<string>(); at && !seen.has(at); seen.add(at), at = this.store.readStart(at)?.after) {
      if (at === q.id) throw new ActionError(`queue ${a.id} already waits for ${q.id} (through its planned starts): that would be a loop`, 409);
    }
    const busy = o.session ? state.queues.find((x) => x.id !== q.id && !!x.run && x.run.session === o.session && HOLDING_RUN_STATES.includes(x.run.state)) : undefined;
    const block = a.status === "done" && !this.deps.draining() && !busy ? this.deps.block(state, q) : undefined;
    if (a.status === "done" && !this.deps.draining() && !busy && !block) {
      const run = this.deps.start(q.id, { ...options, after: a.id });
      return `queue ${a.id} is already done: queue ${q.id} started now in session ${run.session}`;
    }
    this.timers.clear(`start:${q.id}`);
    const at = now();
    this.store.writeStart(q.id, {
      protocol: 1, after: a.id, ...options, by: o.by, reason: o.reason, revision: q.revision, created_at: at,
      held: block ? { since: at, kind: block.kind, reason: waitingText(block) } : undefined,
    });
    this.deps.changed();
    if (a.status !== "done") return `queue ${q.id} starts when queue ${a.id} is done`;
    if (block) return `queue ${a.id} is done; queue ${q.id} ${waitingText(block)}; it starts by itself then`;
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
    const q = queueOf(state, queueId);
    const options = this.planOptions(state, q, o);
    let at: number;
    let usage: "claude" | "codex" | undefined;
    if (o.at === "usage-reset") {
      const s = o.session ? state.sessions.find((x) => x.id === o.session) : undefined;
      usage = s ? (s.runtime === "codex" ? "codex" : "claude") : o.runtime ?? state.project.runtimes.default;
      const reset = usageReset(usage, state.project.defaults.usage_pause_threshold, this.timers.clock.now());
      if (!reset) throw new ActionError(`no usage window of ${RUNTIME_NAME[usage]} is known yet (Nexus learns them from a run): give a time instead`, 409);
      at = reset + this.deps.usageMarginMs;
    } else {
      at = Date.parse(o.at);
      if (Number.isNaN(at)) throw new ActionError(`not a time: ${o.at}`);
      if (at < this.timers.clock.now() - 60_000) throw new ActionError(`${o.at} is in the past`);
    }
    const iso = new Date(at).toISOString();
    this.store.writeStart(q.id, {
      protocol: 1, at: iso, usage, ...options, by: o.by, reason: o.reason, revision: q.revision, created_at: now(),
    });
    this.armStart(q.id, at);
    this.deps.changed();
    return `queue ${q.id} starts at ${formatClock(iso, new Date(this.timers.clock.now()))}${usage ? ` (when the ${RUNTIME_NAME[usage]} usage window resets)` : ""}`;
  }

  /** Cancels the planned start of a queue. */
  cancelStart(queueId: string): string {
    const plan = this.store.readStart(queueId);
    if (!plan) throw new ActionError(`queue ${queueId} has no planned start`, 409);
    this.store.clearStart(queueId);
    this.timers.clear(`start:${queueId}`);
    this.deps.changed();
    return `the planned start of queue ${queueId} (${plan.after ? `after ${plan.after}` : `at ${formatClock(plan.at!, new Date(this.timers.clock.now()))}`}) is cancelled`;
  }

  /** What every planned start checks: the queue can be planned, and the start's options make sense. */
  private planOptions(state: ProjectState, q: QueueView, o: Omit<StartOptions, "after">): Pick<StartOptions, "runtime" | "model" | "effort" | "session"> {
    if (q.status === "done" || q.status === "cancelled") throw new ActionError(`queue ${q.id} is ${q.status}`, 409);
    if (q.run && HOLDING_RUN_STATES.includes(q.run.state)) throw new ActionError(`queue ${q.id} is already running`, 409);
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
    this.timers.wakeAt(`start:${queueId}`, at, () => { this.deps.checkStarts(); this.deps.changed(); });
  }

  /**
   * The planned starts that came due: a chain whose queue is done, a schedule whose time came (the coordinator's
   * pass looks at each, across projects, in the order the plans were made). None while an update drains (the plans
   * stay, and the next server or cancelDrain looks again). A plan that waited for its checkout or the limit but is no
   * longer due (the queue it follows was opened again) stops saying so.
   */
  duePlans(): { queue: string; created_at: string }[] {
    if (this.deps.stopped() || this.deps.draining()) return [];
    // Most projects have no plan: only one that has is read whole.
    if (!this.store.queueIds().some((id) => { try { return !!this.store.readStart(id); } catch { return false; } })) return [];
    const state = loadProjectState(this.store);
    const t = this.timers.clock.now();
    const out: { queue: string; created_at: string }[] = [];
    for (const q of state.queues) {
      const plan = q.start;
      if (!plan || plan.failed) continue;
      const due = plan.after ? state.queues.find((x) => x.id === plan.after)?.status === "done" : t >= Date.parse(plan.at!);
      if (due) out.push({ queue: q.id, created_at: plan.created_at });
      else if (plan.held) { const { waiting: _w, blocked: _b, held: _h, ...file } = plan; this.store.writeStart(q.id, file); }
    }
    return out;
  }

  /**
   * Starts the queue whose planned start is due (a chain's queue is done, or a schedule's time has come); returns
   * whether it started. A chain whose session to continue is busy waits for it to free (one session never runs two
   * queues); a schedule does not wait: its session busy, it fails. A queue whose checkout another queue holds, or
   * that would pass the limit on queues running at once, waits and records why on its plan (`held`); a held schedule
   * is never missed. A schedule more than MISSED_MS late (the server was not running) that was not held does not
   * start: it is `missed`. A start that fails (the queue not approved, stopped, …) is recorded on the plan as
   * `failed`, an item waiting for the user (a missed one is told to the orchestrator too); it is not tried again by
   * itself.
   */
  startDue(queueId: string): boolean {
    if (this.deps.stopped() || this.deps.draining()) return false;
    const state = loadProjectState(this.store);
    const q = state.queues.find((x) => x.id === queueId);
    const plan = q?.start;
    if (!q || !plan || plan.failed) return false;
    const t = this.timers.clock.now();
    const { waiting: _w, blocked: _b, held, ...file } = plan;
    const fail = (reason: string, missed?: boolean) => this.store.writeStart(q.id, { ...file, failed: { at: now(), reason, missed } });
    const busy = plan.session ? state.queues.find((x) => x.id !== q.id && !!x.run && x.run.session === plan.session && HOLDING_RUN_STATES.includes(x.run.state)) : undefined;
    if (plan.after) {
      if (state.queues.find((x) => x.id === plan.after)?.status !== "done" || busy) return false;
    } else {
      const at = Date.parse(plan.at!);
      if (t < at) return false;
      if (!held && t - at > MISSED_MS) { fail(`missed: Nexus was not running at ${formatClock(plan.at!, new Date(t))}`, true); return false; }
      if (busy) { fail(`session ${plan.session} was running queue ${busy.id}`); return false; }
    }
    const block = this.deps.block(state, q);
    if (block) {
      const reason = waitingText(block);
      if (held?.reason !== reason) this.store.writeStart(q.id, { ...file, held: { since: held?.since ?? now(), kind: block.kind, reason } });
      return false;
    }
    try {
      const run = this.deps.start(q.id, { runtime: plan.runtime, model: plan.model, effort: plan.effort, session: plan.session, after: plan.after });
      const why = plan.after ? `queue ${plan.after} is done` : "its scheduled time came";
      this.store.appendActivity(run.session, { at: now(), kind: "turn_start", text: `Nexus started queue ${q.id}: ${why}${held ? ` (it waited since ${formatClock(held.since, new Date(t))}: ${held.reason})` : ""}`, queue: q.id });
      return true;
    } catch (e) { fail((e as Error).message); return false; }
  }
}

function queueOf(state: ProjectState, id: string): QueueView {
  const q = state.queues.find((x) => x.id === id);
  if (!q) throw new ActionError(`unknown queue ${id}`, 404);
  return q;
}
