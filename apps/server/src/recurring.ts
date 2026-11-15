// Recurring queues (PROTOCOL.md, "Recurring queues"): at each time of a recurring's schedule, while the user's standing
// approval holds (its hash is the one approved), Nexus makes the queue from the template and starts it through the
// plan, as an approved queue (its approval marked `standing`). The only writer of .nexus/recurring/<id>.yaml: the
// orchestrator's `nexus recurring set` arrives here through the server, and so do the user's actions.
import {
  ActionError, RECURRING_ID, applyDraft, everyText, fillTemplate, formatClock, loadProjectState, nextOccurrence, parseEvery, readTemplates, resolveRecurring,
  revisionHash, runQueueId, type ProjectStore, type RecurringFile, type Resolved,
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
  every: string;
  by: "orchestrator" | "user";
  reason?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const TERMINAL = new Set(["done", "cancelled"]);

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

  private resolve(r: Pick<RecurringFile, "id" | "template" | "params" | "every">): Resolved {
    return resolveRecurring(r, readTemplates(this.store.readProject().root));
  }

  private read(id: string): RecurringFile {
    const r = this.store.readRecurring(id);
    if (!r) throw new ActionError(`no recurring queue ${id}`, 404);
    return r;
  }

  /**
   * Sets a recurring queue (new, or a change): checks the id, the schedule and that the template fills with these
   * values. A set takes the standing approval away, whatever it changes: the recurring waits for the user's approval
   * again. Returns what happened, in a sentence.
   */
  set(o: RecurringSet): string {
    if (!RECURRING_ID.test(o.id)) throw new ActionError("a recurring queue's id is 1-16 letters, digits, dashes or underscores, starting with a letter or digit");
    let every: string;
    try { every = everyText(parseEvery(o.every)); } catch (e) { throw new ActionError((e as Error).message); }
    const resolved = this.resolve({ ...o, every });
    if ("problem" in resolved) throw new ActionError(resolved.problem);
    const old = this.store.readRecurring(o.id);
    const at = iso(this.now);
    this.store.writeRecurring({
      protocol: 1, id: o.id, template: o.template, params: o.params, every, set_by: o.by, reason: o.reason,
      paused: old?.paused, last: old?.last, created_at: old?.created_at ?? at, updated_at: at,
      // Times from now on count; a set never starts a time that has passed.
      handled: at,
    });
    this.arm(o.id);
    this.deps.changed();
    const what = `template ${resolved.template.id} (${resolved.template.layer}), ${every}`;
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
      handled: [r.handled, at].filter((x): x is string => !!x).sort().at(-1),
    });
    this.arm(id);
    this.deps.changed();
    return `recurring ${id} approved: it runs by itself at its times (${r.every}) while it stays as it is`;
  }

  /** The user pauses it (its times pass without a run) or lets it go on. */
  pause(id: string, paused: boolean): string {
    const r = this.read(id);
    if (!!r.paused === paused) throw new ActionError(`recurring ${id} is ${paused ? "paused already" : "not paused"}`, 409);
    const at = iso(this.now);
    this.store.writeRecurring({ ...r, paused: paused || undefined, updated_at: at, handled: [r.handled, at].filter((x): x is string => !!x).sort().at(-1) });
    this.arm(id);
    this.deps.changed();
    return paused ? `recurring ${id} paused` : `recurring ${id} goes on at its times (${r.every})`;
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
   * Arms the recurring's next time. Times more than MISSED_MS ago (no server ran then) are missed, each looked at as
   * at its time but without a run; a time less late comes now.
   */
  private arm(id: string): void {
    this.timers.clear(`recurring:${id}`);
    let r = this.store.readRecurring(id);
    if (!r || this.deps.stopped()) return;
    const every = parseEvery(r.every);
    let next = nextOccurrence(every, Date.parse(r.handled ?? r.created_at));
    while (next <= this.now - MISSED_MS) {
      this.decide(r, next, true);
      r = this.store.readRecurring(id)!;
      next = nextOccurrence(every, next);
    }
    const due = next;
    if (due <= this.now) { this.fire(id, due); return; }
    this.timers.wakeAt(`recurring:${id}`, due, () => this.fire(id, due));
  }

  private fire(id: string, due: number): void {
    if (this.deps.stopped()) return;
    const r = this.store.readRecurring(id);
    if (!r || (r.handled && Date.parse(r.handled) >= due)) return;
    this.decide(r, due, false);
    this.deps.changed();
    this.arm(id);
  }

  /**
   * One time of the schedule: the queue is made and started only when the recurring is not paused, its template
   * resolves, its standing approval pins exactly the hash it has now, the time is not missed, and its previous run has
   * closed. Every other way the time passes without a run, and the file says why (`skipped`).
   */
  private decide(r: RecurringFile, due: number, late: boolean): void {
    const at = iso(this.now);
    const base: RecurringFile = { ...r, handled: iso(due) };
    const pass = (kind: NonNullable<RecurringFile["skipped"]>["kind"], reason: string) => this.store.writeRecurring({ ...base, skipped: { due: iso(due), at, kind, reason } });
    if (r.paused) { this.store.writeRecurring(base); return; }
    const resolved = this.resolve(r);
    if ("problem" in resolved) { pass("template", resolved.problem); return; }
    if (!r.approval) { pass("approval", "it has no standing approval"); return; }
    if (r.approval.hash !== resolved.hash) { pass("approval", "it changed since your approval (its template, values or schedule)"); return; }
    if (late) { pass("missed", `missed: Nexus was not running at ${formatClock(iso(due), new Date(this.now))}`); return; }
    const state = loadProjectState(this.store);
    const previous = r.last && state.queues.find((q) => q.id === r.last!.queue);
    if (previous && !TERMINAL.has(previous.status)) { pass("previous", `its previous run ${previous.id} is still ${previous.status}`); return; }
    let queue: string | undefined;
    try {
      queue = runQueueId(r.id, due, (x) => state.queues.some((q) => q.id.toLowerCase() === x.toLowerCase()));
      // The queue is the template filled for this run: the same content the standing approval's hash pinned (it was
      // resolved just now), with this run's id. The draft path checks it as any queue (its tags, its step ids).
      const { status: _status, ...filled } = fillTemplate(resolved.template, r.params, queue);
      applyDraft(this.store, { ...filled, status: "proposed" });
      const q = this.store.readQueue(queue);
      this.store.writeQueue({
        ...q, status: "approved", updated_at: at,
        approvals: [{ revision: q.revision, at, hash: revisionHash(q), standing: { id: r.id, approved_at: r.approval.at, hash: r.approval.hash } }],
      });
      this.store.writeRecurring({ ...base, last: { queue, at, due: iso(due) }, skipped: undefined });
      this.deps.plan(queue, { after: [], by: "user", reason: `recurring ${r.id}: its time ${formatClock(iso(due), new Date(this.now))} came (standing approval of ${r.approval.at})` });
    } catch (e) {
      const made = queue && this.store.queueIds().includes(queue);
      this.store.writeRecurring({ ...base, ...(made ? { last: { queue: queue!, at, due: iso(due) } } : {}), skipped: { due: iso(due), at, kind: "failed", reason: (e as Error).message } });
    }
  }
}
