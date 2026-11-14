// Planned starts of queues: the plan (queues/<id>/plan.yaml: start when the queues it waits for are done; plan.ts has
// the rules) and schedules (queues/<id>/start.yaml: start at a time, or when a runtime's usage window resets). The
// engine owns the runs; the scheduler decides when a planned start comes due and asks the engine to start the queue. Also the long timers both use (ClockTimers): a retry or usage wait
// of a run, and a schedule's time, armed on a clock tests can move.
import {
  ActionError, HOLDING_RUN_STATES, checkPredecessors, doneForPlan, effortIssue, formatClock, loadProjectState, newPlan, now, readUsage,
  type PlanBy, type ProjectState, type ProjectStore, type QueueView, type RunFile, type StartFile, type StartView,
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

/** A place in the plan: start the queue when these queues are done (none: as soon as it may). */
export interface PlanOptions extends Omit<StartOptions, "after"> { after: string[]; by: PlanBy; reason?: string }

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
   * Puts `queueId` into the plan: it starts once every queue in `o.after` is done (none: as soon as it may) and its
   * current revision is approved. Replaces the queue's predecessors by `o.by`'s rule (newPlan: the orchestrator keeps
   * the user's) and its start's options (a schedule goes). When it may start already, it starts now (or, while an
   * update drains, right after it). Returns what happened, in a sentence.
   */
  plan(queueId: string, o: PlanOptions): string {
    const state = loadProjectState(this.store);
    const q = queueOf(state, queueId);
    const after = checkPredecessors(state, q.id, o.after);
    const options = this.planOptions(state, q, o);
    const file = newPlan(this.store.readPlan(q.id), q.id, after, { by: o.by, reason: o.reason });
    const done = after.filter((id) => doneForPlan(state.project, state.queues.find((x) => x.id === id)!));
    const ready = done.length === after.length;
    const busy = o.session ? state.queues.find((x) => x.id !== q.id && !!x.run && x.run.session === o.session && HOLDING_RUN_STATES.includes(x.run.state)) : undefined;
    const block = ready && q.approved && !this.deps.draining() && !busy ? this.deps.block(state, q) : undefined;
    this.timers.clear(`start:${q.id}`);
    const at = now();
    this.store.writePlan(q.id, file);
    const doneText = done.length ? `${done.length === 1 ? "queue" : "queues"} ${done.join(", ")} ${done.length === 1 ? "is" : "are"} done` : "";
    if (ready && q.approved && !this.deps.draining() && !busy && !block) {
      this.store.writeStart(q.id, { protocol: 1, ...options, by: o.by, reason: o.reason, revision: q.revision, created_at: at });
      const run = this.deps.start(q.id, { ...options, after: after.length ? after : undefined });
      return `${doneText ? `${doneText}: ` : ""}queue ${q.id} started now in session ${run.session}`;
    }
    this.store.writeStart(q.id, {
      protocol: 1, ...options, by: o.by, reason: o.reason, revision: q.revision, created_at: at,
      held: block ? { since: at, kind: block.kind, reason: waitingText(block) } : undefined,
    });
    this.deps.changed();
    const approval = q.approved ? "" : ` (and once revision ${q.revision} is approved)`;
    const kept = file.after.filter((e) => e.by === "user").map((e) => e.queue);
    const yours = o.by === "orchestrator" && kept.length ? `; it waits for ${kept.join(", ")} by the user's decision` : "";
    if (!ready) return `queue ${q.id} starts when ${after.length === 1 ? "queue" : "queues"} ${after.join(", ")} ${after.length === 1 ? "is" : "are"} done${approval}${yours}`;
    const lead = doneText ? `${doneText}; ` : "";
    if (!q.approved) return `${lead}queue ${q.id} starts once revision ${q.revision} is approved${yours}`;
    if (block) return `${lead}queue ${q.id} ${waitingText(block)}; it starts by itself then${yours}`;
    return busy ? `queue ${q.id} starts when session ${o.session} is free (it runs queue ${busy.id}${doneText ? `; ${doneText}` : ""})${yours}`
      : `queue ${q.id} starts after the Nexus update${doneText ? ` (${doneText})` : ""}${yours}`;
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

  /**
   * Takes the queue out of the plan: its predecessors (an unused plan) and its planned start go. The orchestrator may
   * not take out a queue the user put into the plan or made wait for another (it proposes that instead). A used plan
   * stays, for the view.
   */
  cancelStart(queueId: string, by: PlanBy = "user"): string {
    const start = this.store.readStart(queueId);
    const raw = this.store.readPlan(queueId);
    const plan = raw && !raw.started_at ? raw : undefined;
    if (!start && !plan) throw new ActionError(`queue ${queueId} has no planned start`, 409);
    const mine = plan ? plan.after.filter((e) => e.by === "user").map((e) => e.queue) : [];
    if (by === "orchestrator" && plan && (mine.length || plan.by === "user")) {
      throw new ActionError(`queue ${queueId} is in the plan by the user's decision${mine.length ? ` (it waits for ${mine.join(", ")})` : ""}: you may not take it out; propose the change to the user with nexus plan propose`, 409);
    }
    if (plan) this.store.clearPlan(queueId);
    this.store.clearStart(queueId);
    this.timers.clear(`start:${queueId}`);
    this.deps.changed();
    const when = start?.at ? `at ${formatClock(start.at, new Date(this.timers.clock.now()))}` : plan?.after.length ? `after ${plan.after.map((e) => e.queue).join(", ")}` : start?.after ? `after ${start.after}` : "as soon as it may";
    return `the planned start of queue ${queueId} (${when}) is cancelled`;
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
   * The planned starts that came due: a queue in the plan whose predecessors are all done (and whose time came, with a
   * schedule). The coordinator's pass looks at each, across projects, in the order the plans were made. None while an
   * update drains (the plans stay, and the next server or cancelDrain looks again). A plan that waited (for its
   * approval, its checkout or the limit) but is no longer due (a queue it follows was opened again) stops saying so.
   */
  duePlans(): { queue: string; created_at: string }[] {
    if (this.deps.stopped() || this.deps.draining()) return [];
    // Most projects have nothing planned: only one that has is read whole. A used plan, kept for the view, plans nothing.
    const planned = (id: string) => {
      try {
        if (this.store.readStart(id)) return true;
        const plan = this.store.readPlan(id);
        return !!plan && !plan.started_at;
      } catch { return false; }
    };
    if (!this.store.queueIds().some(planned)) return [];
    const state = loadProjectState(this.store);
    const t = this.timers.clock.now();
    const out: { queue: string; created_at: string }[] = [];
    for (const q of state.queues) {
      const plan = q.plan && !q.plan.used ? q.plan : undefined;
      const start = q.start;
      if ((!plan && !start) || start?.failed) continue;
      const due = (!plan || plan.ready) && (!start?.at || t >= Date.parse(start.at));
      if (due) out.push({ queue: q.id, created_at: start?.created_at ?? plan!.created_at });
      else if (start?.held) { const { waiting: _w, blocked: _b, held: _h, ...file } = start; this.store.writeStart(q.id, file); }
    }
    return out;
  }

  /**
   * Starts the queue whose planned start is due (its predecessors are done; a schedule's time has come); returns
   * whether it started. A queue whose current revision is not approved waits for it (`held`, kind `approval`), and
   * starts by itself once it is. A planned queue whose session to continue is busy waits for it to free (one session
   * never runs two queues); a schedule does not wait: its session busy, it fails. A queue whose checkout another queue
   * holds, or that would pass the limit on queues running at once, waits and records why on its start (`held`); a held
   * schedule is never missed. A schedule more than MISSED_MS late (the server was not running) that was not held does
   * not start: it is `missed`. A start that fails (the queue stopped, …) is recorded as `failed`, an item waiting for
   * the user (a missed one is told to the orchestrator too); it is not tried again by itself.
   */
  startDue(queueId: string): boolean {
    if (this.deps.stopped() || this.deps.draining()) return false;
    const state = loadProjectState(this.store);
    const q = state.queues.find((x) => x.id === queueId);
    const plan = q?.plan && !q.plan.used ? q.plan : undefined;
    const start = q?.start;
    if (!q || (!plan && !start) || start?.failed) return false;
    if (plan && !plan.ready) return false;
    const t = this.timers.clock.now();
    const { waiting: _w, blocked: _b, held, ...file }: Partial<StartView> & StartFile = start ?? { protocol: 1, by: plan!.by, reason: plan!.reason, revision: q.revision, created_at: plan!.created_at };
    const fail = (reason: string, missed?: boolean) => this.store.writeStart(q.id, { ...file, failed: { at: now(), reason, missed } });
    const hold = (kind: "approval" | "checkout" | "limit", reason: string) => {
      if (held?.reason !== reason) this.store.writeStart(q.id, { ...file, held: { since: held?.since ?? now(), kind, reason } });
    };
    const busy = file.session ? state.queues.find((x) => x.id !== q.id && !!x.run && x.run.session === file.session && HOLDING_RUN_STATES.includes(x.run.state)) : undefined;
    if (file.at) {
      const at = Date.parse(file.at);
      if (t < at) return false;
      if (!held && t - at > MISSED_MS) { fail(`missed: Nexus was not running at ${formatClock(file.at, new Date(t))}`, true); return false; }
      if (busy) { fail(`session ${file.session} was running queue ${busy.id}`); return false; }
    } else if (busy) return false;
    // Not approved (a new revision, a withdrawal): it waits for the user's approval rather than failing.
    if (!q.approved && !q.rejection && q.status !== "stopped") { hold("approval", `waits for approval of revision ${q.revision}`); return false; }
    const block = this.deps.block(state, q);
    if (block) { hold(block.kind, waitingText(block)); return false; }
    const after = plan?.after.map((e) => e.queue) ?? [];
    try {
      const run = this.deps.start(q.id, { runtime: file.runtime, model: file.model, effort: file.effort, session: file.session, after: after.length ? after : undefined });
      const why = after.length ? `${after.length === 1 ? "queue" : "queues"} ${after.join(", ")} ${after.length === 1 ? "is" : "are"} done` : file.at ? "its scheduled time came" : "it was planned to start as soon as it may";
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
