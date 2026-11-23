// Recurring queues (docs/protocol/planning.md, "Recurring queues"): at each time of a recurring's schedule, while the user's standing
// approval holds (its hash is the one approved), Nexus makes the queue from the template and starts it through the
// plan, as an approved queue (its approval marked `standing`). The only writer of .nexus/recurring/<id>.yaml: the
// orchestrator's `nexus recurring set` arrives here through the server, and so do the user's actions.
import {
  ActionError, RECURRING_ID, applyDraft, countStart, countable, countedQueues, everyText, fillTemplate, formatClock, loadProjectState, nextOccurrence, parseEvery, readTemplates,
  resolveRecurring, revisionHash, runQueueId, scheduleText, type MaintenanceMode, type ProjectState, type ProjectStore, type RecurringFile, type Resolved,
} from "@nexus/protocol";
import { MISSED_MS, type ClockTimers, type PlanOptions } from "./scheduler.ts";

/** What the recurring queues need of the engine. */
export interface RecurrerDeps {
  /** Puts the queue into the plan (Scheduler.plan): it starts now, or waits for its checkout, the limit or an update. */
  plan(queueId: string, o: PlanOptions): string;
  stopped(): boolean;
  changed(): void;
}

/** What `nexus recurring set` gives (and the user, from the dashboard, later). */
export interface RecurringSet {
  id: string;
  template: string;
  params: Record<string, string>;
  /** At a time, or after N queues: exactly one. */
  every?: string;
  after_queues?: number;
  /** The maintenance mode for this project, over the template's. */
  maintenance?: MaintenanceMode;
  by: "orchestrator" | "user";
  reason?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
/** The later of two ISO times: a recurring's `handled` never goes back. */
const later = (a: string | undefined, b: string) => (a !== undefined && a > b ? a : b);
const TERMINAL = new Set(["done", "cancelled"]);

/**
 * A recurring the user brings back after it stood still, paused or with a time that passed without a run (`skipped`):
 * its "after N queues" count starts again when it is set or approved (queue CK), instead of going on from its last run.
 */
const resumes = (r: Pick<RecurringFile, "paused" | "skipped"> | undefined): boolean => !!r && (!!r.paused || !!r.skipped);

export class Recurrer {
  private readonly store: ProjectStore;
  private readonly timers: ClockTimers;
  private readonly deps: RecurrerDeps;

  constructor(store: ProjectStore, timers: ClockTimers, deps: RecurrerDeps) {
    this.store = store;
    this.timers = timers;
    this.deps = deps;
  }

  private get now(): number { return this.timers.clock.now(); }

  /** Arms every recurring's next time (a new server); times that passed while none ran are missed, or come now. */
  armAll(): void {
    for (const id of this.store.recurringIds()) {
      try { this.arm(id); } catch { /* an unreadable file shows as a warning in the state */ }
    }
  }

  private resolve(r: Pick<RecurringFile, "id" | "template" | "params" | "every" | "after_queues" | "maintenance">): Resolved {
    return resolveRecurring(r, readTemplates(this.store.readProject().root));
  }

  private read(id: string): RecurringFile {
    const r = this.store.readRecurring(id);
    if (!r) throw new ActionError(`no recurring queue ${id}`, 404);
    return r;
  }

  /**
   * Sets a recurring queue (new, or a change): checks the id, the schedule (at a time, or after N queues) and that the
   * template fills with these values (and the maintenance mode, for a maintenance template). A set takes the standing
   * approval away, whatever it changes: the recurring waits for the user's approval again. Returns what happened.
   */
  set(o: RecurringSet): string {
    if (!RECURRING_ID.test(o.id)) throw new ActionError("a recurring queue's id is 1-16 letters, digits, dashes or underscores, starting with a letter or digit");
    let every: string | undefined;
    let schedule: string;
    try {
      every = o.every === undefined ? undefined : everyText(parseEvery(o.every));
      schedule = scheduleText({ every, after_queues: o.after_queues });
    } catch (e) { throw new ActionError((e as Error).message); }
    const resolved = this.resolve({ ...o, every });
    if ("problem" in resolved) throw new ActionError(resolved.problem);
    const old = this.store.readRecurring(o.id);
    const at = iso(this.now);
    this.store.writeRecurring({
      protocol: 1, id: o.id, template: o.template, params: o.params, every, after_queues: o.after_queues, maintenance: o.maintenance,
      set_by: o.by, reason: o.reason, paused: old?.paused, last: old?.last, created_at: old?.created_at ?? at, updated_at: at,
      // Times from now on count, and queues done since its last run (or from now on, if it never ran): a set never
      // starts what came before it, nor throws away what was done since it ran. One paused or skipped counts from now
      // (the user's decision of 2026-11-23, queue CK): what was done meanwhile does not start it at once.
      handled: at, baseline: o.after_queues !== undefined ? (resumes(old) ? this.doneNow() : this.countStart(old)) : undefined,
    });
    this.arm(o.id);
    this.deps.changed();
    const mode = resolved.queue.maintenance ? `, maintenance ${String(resolved.queue.maintenance)}` : "";
    const what = `template ${resolved.template.id} (${resolved.template.layer}), ${schedule}${mode}`;
    const wait = old?.approval ? "the user's standing approval is taken away: it waits for their approval again" : "it waits for the user's approval";
    return `recurring ${o.id} ${old ? "changed" : "set"}: ${what}; ${wait}, and runs only once approved`;
  }

  /** The user's standing approval of what the recurring is now (its hash). Only the user's action calls this. */
  approve(id: string): string {
    const r = this.read(id);
    const resolved = this.resolve(r);
    if ("problem" in resolved) throw new ActionError(`recurring ${id} cannot run: ${resolved.problem}`, 409);
    if (r.approval?.hash === resolved.hash) throw new ActionError(`recurring ${id} is already approved`, 409);
    const at = iso(this.now);
    this.store.writeRecurring({
      ...r, approval: { hash: resolved.hash, at }, updated_at: at,
      skipped: r.skipped?.kind === "approval" ? undefined : r.skipped,
      handled: later(r.handled, at),
      // After N queues: the count goes on from its last run, or starts at the approval if it never ran; one paused or
      // skipped starts it at the approval (queue CK).
      ...(r.after_queues !== undefined ? { baseline: resumes(r) ? this.doneNow() : this.countStart(r) } : {}),
    });
    this.arm(id);
    this.deps.changed();
    return `recurring ${id} approved: it runs by itself (${scheduleText(r)}) while it stays as it is`;
  }

  /** The user pauses it (its times pass without a run) or lets it go on. */
  pause(id: string, paused: boolean): string {
    const r = this.read(id);
    if (!!r.paused === paused) throw new ActionError(`recurring ${id} is ${paused ? "paused already" : "not paused"}`, 409);
    const at = iso(this.now);
    // Let go on after N queues, it counts from now (the user's decision of 2026-11-23, queue CK): the queues done while
    // it was paused do not start it at once.
    const baseline = !paused && r.after_queues !== undefined ? { baseline: this.doneNow() } : {};
    this.store.writeRecurring({ ...r, paused: paused || undefined, updated_at: at, handled: later(r.handled, at), ...baseline });
    this.arm(id);
    this.deps.changed();
    return paused ? `recurring ${id} paused` : `recurring ${id} goes on (${scheduleText(r)})`;
  }

  /** The user removes it; the queues it made stay. */
  remove(id: string): string {
    this.read(id);
    this.store.clearRecurring(id);
    this.timers.clear(`recurring:${id}`);
    this.deps.changed();
    return `recurring ${id} removed; the queues it made stay`;
  }

  /**
   * Arms the recurring's next time. Times more than MISSED_MS ago (no server ran then) are made up for once: the latest
   * of them is decided as if it came now (`catch-up`: with every reason a time passes without a run), the older ones
   * are missed, each looked at as at its time but without a run. A time less late than that comes now instead, and then
   * every older one is missed.
   */
  private arm(id: string): void {
    this.timers.clear(`recurring:${id}`);
    const r = this.store.readRecurring(id);
    if (!r || this.deps.stopped() || r.every === undefined) return; // after N queues: counted at each change (check)
    const every = parseEvery(r.every);
    const passed: number[] = [];
    let next = nextOccurrence(every, Date.parse(r.handled ?? r.created_at));
    while (next <= this.now - MISSED_MS) {
      passed.push(next);
      next = nextOccurrence(every, next);
    }
    const catchUp = next > this.now ? passed.pop() : undefined;
    for (const due of passed) this.decide(this.store.readRecurring(id)!, due, "missed");
    if (catchUp !== undefined) {
      this.decide(this.store.readRecurring(id)!, catchUp, "catch-up");
      this.deps.changed();
    }
    const due = next;
    if (due <= this.now) { this.fire(id, due); return; }
    this.timers.wakeAt(`recurring:${id}`, due, () => this.fire(id, due));
  }

  /** The project's queues an "after N queues" schedule counts, done now (a new count starts from them). */
  private doneNow(): string[] {
    return countable(loadProjectState(this.store).queues);
  }

  /** Where the count starts at an approval or a set (`r`: the file before it): at its last run, or now if none. */
  private countStart(r: Pick<RecurringFile, "last"> | undefined): string[] {
    return countStart(r ?? {}, loadProjectState(this.store).queues);
  }

  /**
   * At each change: the "after N queues" recurrings whose count reached N come due now (decide); whatever comes of it,
   * a new count starts. `state`: the project's state now.
   */
  check(state: ProjectState): void {
    if (this.deps.stopped() || !state.recurring.some((r) => r.after_queues !== undefined)) return;
    for (const view of state.recurring) {
      if (view.after_queues === undefined || (view.counted ?? 0) < view.after_queues) continue;
      const r = this.store.readRecurring(view.id);
      if (!r || r.after_queues === undefined || countedQueues(r, state.queues) < r.after_queues) continue;
      this.decide(r, this.now, "due");
      this.deps.changed();
    }
  }

  private fire(id: string, due: number): void {
    if (this.deps.stopped()) return;
    const r = this.store.readRecurring(id);
    if (!r || (r.handled && Date.parse(r.handled) >= due)) return;
    this.decide(r, due, "due");
    this.deps.changed();
    this.arm(id);
  }

  /**
   * One time of the schedule: the queue is made and started only when the recurring is not paused, its template
   * resolves, its standing approval pins exactly the hash it has now, the time is not missed, and its previous run has
   * closed. Every other way the time passes without a run, and the file says why (`skipped`). `how`: the time came
   * (`due`), passed while Nexus was not running and is missed, or passed so and is made up for now (`catch-up`: decided
   * as a time that came, and its run's `last` says so).
   */
  private decide(r: RecurringFile, due: number, how: "due" | "missed" | "catch-up"): void {
    const at = iso(this.now);
    // After N queues the count starts again from what is done now (the queue made here is a recurring run: not counted).
    const base: RecurringFile = { ...r, handled: iso(due), ...(r.after_queues !== undefined ? { baseline: this.doneNow() } : {}) };
    const pass = (kind: NonNullable<RecurringFile["skipped"]>["kind"], reason: string) => this.store.writeRecurring({ ...base, skipped: { due: iso(due), at, kind, reason } });
    if (r.paused) { this.store.writeRecurring(base); return; }
    const resolved = this.resolve(r);
    if ("problem" in resolved) { pass("template", resolved.problem); return; }
    if (!r.approval) { pass("approval", "it has no standing approval"); return; }
    if (r.approval.hash !== resolved.hash) { pass("approval", "it changed since your approval (its template, values or schedule)"); return; }
    const clock = formatClock(iso(due), new Date(this.now));
    if (how === "missed") { pass("missed", `missed: Nexus was not running at ${clock}`); return; }
    const when = r.every === undefined ? `${r.after_queues} queues were done`
      : how === "catch-up" ? `its time ${clock} passed while Nexus was not running: made up for now` : `its time ${clock} came`;
    const state = loadProjectState(this.store);
    const previous = r.last && state.queues.find((q) => q.id === r.last!.queue);
    if (previous && !TERMINAL.has(previous.status)) { pass("previous", `its previous run ${previous.id} is still ${previous.status}`); return; }
    let queue: string | undefined;
    try {
      queue = runQueueId(r.id, due, (x) => state.queues.some((q) => q.id.toLowerCase() === x.toLowerCase()));
      // The queue is the template filled for this run: the same content the standing approval's hash pinned (it was
      // resolved just now), with this run's id. The draft path checks it as any queue (its tags, its step ids).
      const { status: _status, ...filled } = fillTemplate(resolved.template, r.params, queue, { maintenance: r.maintenance });
      applyDraft(this.store, { ...filled, status: "proposed" });
      const q = this.store.readQueue(queue);
      this.store.writeQueue({
        ...q, status: "approved", updated_at: at,
        approvals: [{ revision: q.revision, at, hash: revisionHash(q), standing: { id: r.id, approved_at: r.approval.at, hash: r.approval.hash } }],
      });
      // A run keeps its count's start with it (`last.baseline`): an approval or a set later counts from it again.
      this.store.writeRecurring({ ...base, last: { queue, at, due: iso(due), ...(how === "catch-up" ? { caught_up: iso(due) } : {}), baseline: base.baseline }, skipped: undefined });
      this.deps.plan(queue, { after: [], by: "user", reason: `recurring ${r.id}: ${when} (standing approval of ${r.approval.at})` });
    } catch (e) {
      const made = queue && this.store.queueIds().includes(queue);
      this.store.writeRecurring({ ...base, ...(made ? { last: { queue: queue!, at, due: iso(due), baseline: base.baseline } } : {}), skipped: { due: iso(due), at, kind: "failed", reason: (e as Error).message } });
    }
  }
}
