// Planned starts of queues: the plan (queues/<id>/plan.yaml: start when the queues it waits for are done; plan.ts has
// the rules) and schedules (queues/<id>/start.yaml: start at a time, or when a runtime's usage window resets). The
// engine owns the runs; the scheduler decides when a planned start comes due and asks the engine to start the queue. Also the long timers both use (ClockTimers): a retry or usage wait
// of a run, and a schedule's time, armed on a clock tests can move.
import { errorText } from "@nexus/protocol/errors";
import {
  ActionError, runGoing, changesOfUser, checkPredecessors, doneForPlan, effortIssue, formatClock, loadProjectState, newId, newPlan, now, openPlan,
  openPlanFile, readUsage, reorderedFollowers,
  type PlanBy, type PlanFile, type PlanUndo, type ProjectState, type ProjectStore, type QueueView, type RunFile, type StartFile, type StartView,
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

/**
 * A place in the plan: start the queue when these queues are done (none: as soon as it may). `undo`: a change of the
 * user's this plan is part of (the file keeps it, and the queue does not start before its window ends).
 */
export interface PlanOptions extends Omit<StartOptions, "after"> { after: string[]; by: PlanBy; reason?: string; undo?: PlanUndo }

/** How long the dashboard offers to undo a change of the user's to the plan. */
const UNDO_SHOWN_MS = 10_000;
/** How long the server takes an undo: the dashboard's window and the request's way. */
const UNDO_MS = UNDO_SHOWN_MS + 2_000;

/** What a change of the user's to the plan answers: what happened, and what its undo needs. */
export interface PlanChange { message: string; undo: { change: string; until: string; queues: string[] } }

/** A plan file as an undo keeps it: without an undo of its own. */
function bare(p: PlanFile | undefined): Omit<PlanFile, "undo"> | null {
  if (!p) return null;
  const { undo: _u, ...rest } = p;
  return rest;
}

/** The undo window of a plan has not ended: its queue does not start yet. */
const undoOpen = (p: Pick<PlanFile, "undo"> | undefined, t: number) => !!p?.undo && Date.parse(p.undo.until) > t;

/** What a change answers about its undo: its id, the end of its window, and the queues whose plans it wrote. */
const undoAnswer = (u: Pick<PlanUndo, "change" | "until">, queues: string[]): PlanChange["undo"] => ({ change: u.change, until: u.until, queues });

/** The queues a plan waits for, as a message lists them. */
const afterList = (p: { after: readonly { queue: string }[] }) => p.after.map((e) => e.queue).join(", ");

/**
 * When the usage window of a runtime resets, from the latest usage data: Claude Code's 5-hour window; for Codex, of
 * its windows not yet reset, the last to reset among those at or above the pause threshold (the run waits for all of
 * them), else the first to reset. Undefined while nothing is known.
 */
function usageReset(runtime: "claude" | "codex", threshold: number, nowMs: number): number | undefined {
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
  /** How long a change of the user's to the plan can be undone (UNDO_MS; tests make it short). */
  undoMs?: number;
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
      const undo = this.store.readPlan(id)?.undo;
      if (undo && Date.parse(undo.until) > this.timers.clock.now()) this.armUndo(id, Date.parse(undo.until));
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
    const file: PlanFile = { ...newPlan(this.store.readPlan(q.id), q.id, after, { by: o.by, reason: o.reason, at: o.undo?.at }), undo: o.undo };
    const done = after.filter((id) => doneForPlan(state.project, state.queues.find((x) => x.id === id)!));
    const ready = done.length === after.length;
    const busy = holdingSession(state, o.session, q.id);
    const free = ready && q.approved && !this.deps.draining() && !busy && !o.undo;
    const block = free ? this.deps.block(state, q) : undefined;
    this.timers.clear(`start:${q.id}`);
    const at = now();
    this.store.writePlan(q.id, file);
    if (o.undo) this.armUndo(q.id, Date.parse(o.undo.until));
    const doneText = done.length ? areDone(done) : "";
    if (free && !block) {
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
    if (!ready) return `queue ${q.id} starts when ${areDone(after)}${approval}${yours}`;
    const lead = doneText ? `${doneText}; ` : "";
    if (!q.approved) return `${lead}queue ${q.id} starts once revision ${q.revision} is approved${yours}`;
    if (block) return `${lead}queue ${q.id} ${waitingText(block)}; it starts by itself then${yours}`;
    if (o.undo && !busy && !this.deps.draining()) return `${lead}queue ${q.id} starts once the change can no longer be undone`;
    return busy ? `queue ${q.id} starts when session ${o.session} is free (it runs queue ${busy.id}${doneText ? `; ${doneText}` : ""})${yours}`
      : `queue ${q.id} starts after the Nexus update${doneText ? ` (${doneText})` : ""}${yours}`;
  }

  /**
   * The user's reorder (plan.ts, reorderedFollowers): `queueId` after `after` (null: with no queue before it); those
   * that waited for it wait for its old predecessors. Its start's options stay; a schedule goes. Every plan it writes
   * keeps what undoes it, and none of those queues starts before the undo window ends. Returns what happened.
   */
  move(queueId: string, after: string | null): PlanChange {
    const state = loadProjectState(this.store);
    const q = queueOf(state, queueId);
    if (after) checkPredecessors(state, q.id, [after], { loop: false });
    this.planOptions(state, q, {});
    const plans = new Map(state.queues.flatMap((x) => {
      const p = x.id === q.id || openPlan(x) ? openPlanFile(this.store.readPlan(x.id)) : undefined;
      return p ? [[x.id, p] as const] : [];
    }));
    const undo = this.newUndo("move", q.id);
    const followers = reorderedFollowers(plans, q.id, after, undo.at);
    const files = [q.id, ...followers.keys()];
    for (const [id, p] of followers) {
      this.store.writePlan(id, { ...p, undo: { ...undo, plan: bare(plans.get(id)) } });
      this.armUndo(id, Date.parse(undo.until));
    }
    const start = this.store.readStart(q.id);
    const said = this.plan(q.id, {
      after: after ? [after] : [], by: "user", runtime: start?.runtime, model: start?.model, effort: start?.effort, session: start?.session,
      undo: { ...undo, plan: bare(this.store.readPlan(q.id)), files, start: start ?? null },
    });
    const moved = [...followers.entries()].map(([id, p]) => `${id} now waits for ${p.after.length ? afterList(p) : "nothing before it"}`);
    return { message: moved.length ? `${said}; ${moved.join("; ")}` : said, undo: undoAnswer(undo, files) };
  }

  /**
   * The user's "also after": `queueId`, in the plan, waits for `after` too, a dependency of the user's ("set by you");
   * its other predecessors stay as they are. Undoable as a move is.
   */
  addPredecessor(queueId: string, after: string): PlanChange {
    const { state, q, plan } = this.plannedQueue(queueId);
    if (!plan) throw new ActionError(`queue ${q.id} is not in the plan: put it in with move`, 409);
    if (plan.after.some((e) => e.queue === after)) throw new ActionError(`queue ${q.id} waits for ${after} already`, 409);
    checkPredecessors(state, q.id, [...plan.after.map((e) => e.queue), after]);
    const undo = this.newUndo("add", q.id);
    const next = this.writeOwnChange(q.id, {
      ...plan, after: [...plan.after, { queue: after, by: "user", at: undo.at }], updated_at: undo.at,
      undo: { ...undo, plan: bare(plan), files: [q.id] },
    });
    return { message: `queue ${q.id} now waits for ${afterList(next)}`, undo: undoAnswer(undo, [q.id]) };
  }

  /**
   * The user takes `after` out of the predecessors of `queueId`, whoever set it; the others stay as they are. It is
   * the user's decision (`removed`, told to the orchestrator, which may not put it back itself, only propose it). With
   * none left, the queue stays in the plan and starts as soon as it may, once the undo window has ended.
   */
  removePredecessor(queueId: string, after: string): PlanChange {
    const { q, plan } = this.plannedQueue(queueId);
    const entry = plan?.after.find((e) => e.queue === after);
    if (!plan || !entry) throw new ActionError(`queue ${q.id} does not wait for ${after}`, 409);
    const undo = this.newUndo("remove", q.id);
    const next: PlanFile & { undo: PlanUndo } = {
      ...plan, after: plan.after.filter((e) => e.queue !== after), updated_at: undo.at,
      decisions: [...plan.decisions, { at: undo.at, kind: "removed", queues: [after], set_by: entry.by, change: undo.change }],
      undo: { ...undo, plan: bare(plan), files: [q.id] },
    };
    // A proposal that no longer changes anything of the user's is moot.
    if (next.proposal && !changesOfUser(next, next.proposal.after)) next.proposal = undefined;
    this.writeOwnChange(q.id, next);
    const left = next.after.length ? `now waits for ${afterList(next)}` : "waits for no other queue: it starts as soon as it may";
    return { message: `queue ${q.id} no longer waits for ${after}; it ${left}`, undo: undoAnswer(undo, [q.id]) };
  }

  /**
   * Undoes the user's change `change` to the plan, made on `queueId` (a move, an added or a removed predecessor): every
   * plan file it wrote is as it was before (and, for a move, the queue's start.yaml), and the undo is recorded on the
   * queue (`undone`, told to the orchestrator). Refused once the window has ended, when one of those plans changed
   * since, or when one of those queues started.
   */
  undo(queueId: string, change: string): string {
    const own = this.store.readPlan(queueId);
    const u = own?.undo;
    if (!u || u.change !== change || u.queue !== queueId) throw new ActionError(`that change to the plan of queue ${queueId} can no longer be undone: the plan changed since`, 409);
    if (this.timers.clock.now() > Date.parse(u.until)) throw new ActionError(`that change to the plan of queue ${queueId} can no longer be undone: its time is over`, 409);
    const state = loadProjectState(this.store);
    const files = new Map((u.files ?? [queueId]).map((id) => [id, id === queueId ? own : this.store.readPlan(id)] as const));
    for (const [id, p] of files) {
      const x = state.queues.find((y) => y.id === id);
      if (p?.started_at || runGoing(x?.run)) throw new ActionError(`that change can no longer be undone: queue ${id} started since`, 409);
      if (!p?.undo || p.undo.change !== change || p.updated_at !== p.undo.at) throw new ActionError(`that change can no longer be undone: the plan of queue ${id} changed since`, 409);
    }
    const at = now();
    for (const [id, p] of files) {
      const before = p!.undo!.plan;
      this.timers.clear(`undo:${id}`);
      if (!before) this.store.clearPlan(id);
      else if (id !== queueId) this.store.writePlan(id, before);
      // The queue the change was made to: as it was, with the undo recorded (the change's own decision stays, so the
      // orchestrator, told of a removal, is told of its undo too).
      else this.store.writePlan(id, { ...before, decisions: [...p!.decisions, { at, kind: "undone", change, undid: u.kind }] });
    }
    if (u.start !== undefined) {
      this.timers.clear(`start:${queueId}`);
      if (u.start) {
        this.store.writeStart(queueId, u.start);
        if (u.start.at && !u.start.failed) this.armStart(queueId, Date.parse(u.start.at));
      } else this.store.clearStart(queueId);
    }
    this.deps.changed();
    const back = this.store.readPlan(queueId);
    const place = !back || back.started_at ? "is not in the plan" : back.after.length ? `waits for ${afterList(back)}` : "starts as soon as it may";
    return `undone: queue ${queueId} ${place} again`;
  }

  /** A queue the user changes the plan of, which may be planned, and its plan file while it is open (none: not in the plan). */
  private plannedQueue(queueId: string): { state: ProjectState; q: QueueView; plan: PlanFile | undefined } {
    const state = loadProjectState(this.store);
    const q = queueOf(state, queueId);
    this.planOptions(state, q, {});
    return { state, q, plan: openPlanFile(this.store.readPlan(q.id)) };
  }

  /** Writes a change of the user's to the plan of `queueId` alone, and arms the end of its undo window. Returns `next`. */
  private writeOwnChange(queueId: string, next: PlanFile & { undo: PlanUndo }): PlanFile {
    this.store.writePlan(queueId, next);
    this.armUndo(queueId, Date.parse(next.undo.until));
    this.deps.changed();
    return next;
  }

  /** A new change of the user's to the plan of `queue`: its id, time and undo window (each file adds what it was). */
  private newUndo(kind: PlanUndo["kind"], queue: string): Omit<PlanUndo, "plan"> {
    const t = this.timers.clock.now();
    return { change: newId(), kind, queue, at: new Date(t).toISOString(), until: new Date(t + (this.deps.undoMs ?? UNDO_MS)).toISOString() };
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
    const plan = openPlanFile(this.store.readPlan(queueId));
    if (!start && !plan) throw new ActionError(`queue ${queueId} has no planned start`, 409);
    const mine = plan ? plan.after.filter((e) => e.by === "user").map((e) => e.queue) : [];
    if (by === "orchestrator" && plan && (mine.length || plan.by === "user")) {
      throw new ActionError(`queue ${queueId} is in the plan by the user's decision${mine.length ? ` (it waits for ${mine.join(", ")})` : ""}: you may not take it out; propose the change to the user with nexus plan propose`, 409);
    }
    if (plan) this.store.clearPlan(queueId);
    this.store.clearStart(queueId);
    this.timers.clear(`start:${queueId}`);
    this.deps.changed();
    const when = start?.at ? `at ${formatClock(start.at, new Date(this.timers.clock.now()))}` : plan?.after.length ? `after ${afterList(plan)}` : start?.after ? `after ${start.after}` : "as soon as it may";
    return `the planned start of queue ${queueId} (${when}) is cancelled`;
  }

  /** What every planned start checks: the queue can be planned, and the start's options make sense. */
  private planOptions(state: ProjectState, q: QueueView, o: Omit<StartOptions, "after">): Pick<StartOptions, "runtime" | "model" | "effort" | "session"> {
    if (q.status === "done" || q.status === "cancelled") throw new ActionError(`queue ${q.id} is ${q.status}`, 409);
    if (runGoing(q.run)) throw new ActionError(`queue ${q.id} is already running`, 409);
    const runtime = o.session ? undefined : o.runtime ?? state.project.runtimes.default;
    const issue = runtime ? effortIssue(runtime, o.effort) : undefined;
    if (issue) throw new ActionError(issue);
    if (o.session) {
      const s = state.sessions.find((x) => x.id === o.session);
      if (!s || s.role !== "worker" || s.launched_by !== "nexus" || s.runtime === "external") throw new ActionError(`session ${o.session} is not a worker session Nexus launched`, 409);
    }
    return { runtime: o.session ? undefined : o.runtime, model: o.model, effort: o.effort, session: o.session };
  }

  /** At the end of a change's undo window the plans are looked at: its queues may start now. */
  private armUndo(queueId: string, at: number): void {
    this.timers.wakeAt(`undo:${queueId}`, at, () => { this.deps.checkStarts(); this.deps.changed(); });
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
        return !!this.store.readStart(id) || !!openPlanFile(this.store.readPlan(id));
      } catch { return false; }
    };
    if (!this.store.queueIds().some(planned)) return [];
    const state = loadProjectState(this.store);
    const t = this.timers.clock.now();
    const out: { queue: string; created_at: string }[] = [];
    for (const q of state.queues) {
      const plan = openPlan(q);
      const start = q.start;
      if ((!plan && !start) || start?.failed) continue;
      const due = (!plan || (plan.ready && !undoOpen(plan, t))) && (!start?.at || t >= Date.parse(start.at));
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
    const plan = q && openPlan(q);
    const start = q?.start;
    if (!q || (!plan && !start) || start?.failed) return false;
    const t = this.timers.clock.now();
    if (plan && (!plan.ready || undoOpen(plan, t))) return false;
    const { waiting: _w, blocked: _b, held, ...file }: Partial<StartView> & StartFile = start ?? { protocol: 1, by: plan!.by, reason: plan!.reason, revision: q.revision, created_at: plan!.created_at };
    const fail = (reason: string, missed?: boolean) => this.store.writeStart(q.id, { ...file, failed: { at: now(), reason, missed } });
    const hold = (kind: "approval" | "checkout" | "limit", reason: string) => {
      if (held?.reason !== reason) this.store.writeStart(q.id, { ...file, held: { since: held?.since ?? now(), kind, reason } });
    };
    const busy = holdingSession(state, file.session, q.id);
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
      const why = after.length ? areDone(after) : file.at ? "its scheduled time came" : "it was planned to start as soon as it may";
      this.store.appendActivity(run.session, { at: now(), kind: "turn_start", text: `Nexus started queue ${q.id}: ${why}${held ? ` (it waited since ${formatClock(held.since, new Date(t))}: ${held.reason})` : ""}`, queue: q.id });
      return true;
    } catch (e) { fail(errorText(e)); return false; }
  }
}

function queueOf(state: ProjectState, id: string): QueueView {
  const q = state.queues.find((x) => x.id === id);
  if (!q) throw new ActionError(`unknown queue ${id}`, 404);
  return q;
}

/** "queue A is done", "queues A, B are done". */
const areDone = (ids: readonly string[]) => `${ids.length === 1 ? "queue" : "queues"} ${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} done`;

/** The queue (other than `except`) whose run holds `session`: one session never runs two queues. */
function holdingSession(state: ProjectState, session: string | undefined, except: string): QueueView | undefined {
  if (!session) return undefined;
  return state.queues.find((x) => x.id !== except && !!x.run && x.run.session === session && runGoing(x.run));
}
