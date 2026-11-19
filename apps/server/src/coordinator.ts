// Over the projects' engines, the two rules about queues running side by side (DESIGN.md, "Never two queues in one
// checkout"): a checkout (the project's own, or a queue's worktree) has one queue at work at a time, and at most
// `max_running` queues run at once across all projects, and at most a project's own `max_running` of that project's
// (both limits hold; decided 2026-11-15, queue OP). A direct start that would break any of them is refused with the
// reason; a planned start (a chain or a schedule) that came due waits, says why on its plan (`held`), and starts by
// itself once it may. Waiting starts go in the order their plans were made, across projects; every start inside a
// pass is followed by a fresh look, so a pass never starts two queues into one checkout or past a limit.
//
// A queue coming back from waiting (an answer, a review: it counted no more meanwhile) asks too before it opens a new
// turn or its next step: with a limit full, its engine holds the run (`held` in run.yaml, decided 2026-11-15, queue
// LQ). Each pass first lets the held runs go on, in the order they became ready, and only then the planned starts: what
// has begun goes ahead of what has not.
//
// The limits are settings: the global `defaults.max_running` (<NEXUS_HOME>/settings.yaml, changed from the dashboard's
// server panel; limits.json, where it was kept before, is its copy for an older server) and a project's own value of it
// (its effective `defaults.max_running`: the global one when it has none of its own).
import {
  compareIds, isOpenQuestion, runHoldsCheckout, runCounted, loadProjectState, readGlobalSettings,
  type ProjectState, type ProjectStore, type QueueView,
} from "@nexus/protocol";
import { checkoutPath, samePath } from "./worktree.ts";

/** What the coordinator needs of a project's engine. */
export interface Member {
  readonly store: ProjectStore;
  /** Shut down: it counts no more (its successor, if any, is another member). */
  isStopped(): boolean;
  /** It may start queues now (not shut down, not draining for an update). */
  accepting(): boolean;
  /** Its planned starts that came due (or may have), each with when its plan was made. */
  duePlans(): { queue: string; created_at: string }[];
  /** Starts the queue of a due plan, or records why it waits; whether it started. */
  startDue(queue: string): boolean;
  /** Its runs held at the limit, each with since when (run.yaml `held`). */
  heldRuns(): { queue: string; since: string }[];
  /** The answers (inbox entry ids) that reached a worker while its turn was live: part of the work it is at. */
  liveAnswers(): ReadonlySet<string>;
  /** Lets a held run go on if a place is free now, or records why it still waits; whether it went on. */
  releaseHeld(queue: string): boolean;
}

/** A queue whose run holds its checkout. `counts`: it is running (not waiting), so it counts toward the limit. */
export interface Holder { project: string; name: string; queue: string; state: string; checkout: string; counts: boolean }

/** Why a queue may not start (or go on) now. `detail`: the reason, without the queue it is about. */
export interface Block { kind: "checkout" | "limit"; detail: string }

/** As a planned start shows it: "waits for the checkout: queue X runs there", "waits: 2 queues run, the limit is 2". */
export const waitingText = (b: Block): string => b.kind === "checkout" ? `waits for the checkout: ${b.detail}` : `waits: ${b.detail}`;

/** As a refused action says it: "queue B cannot start: its checkout is in use, queue X runs there". */
export const refusalText = (queue: string, verb: string, b: Block): string =>
  b.kind === "checkout" ? `queue ${queue} cannot ${verb}: its checkout is in use, ${b.detail}` : `queue ${queue} cannot ${verb}: ${b.detail}`;

/** The queues of a project whose runs hold their checkouts. */
function holdersOf(state: ProjectState, live: ReadonlySet<string> = new Set()): Holder[] {
  return state.queues.filter((q) => runHoldsCheckout(q.run)).map((q) => ({
    project: state.project.id, name: state.project.name, queue: q.id, state: q.run!.state, checkout: checkoutPath(state, q),
    counts: atWork(state, q, live),
  }));
}

/**
 * The queue's run is at work, so it counts toward the limit. A queue waiting for a review or an answer is not, nor one
 * waiting for the usage window, a retry or an approval, nor one held at the limit, nor one whose steps are all done
 * (its run is about to finish). A worker that asked with --can-continue and works on in its live turn is at work; one
 * back from waiting is from when its engine lets it go on (returning).
 */
function atWork(state: ProjectState, q: QueueView, live: ReadonlySet<string>): boolean {
  if (!runCounted(q.run) || q.status === "done") return false;
  return q.status === "waiting" ? workingOn(state, q) : !returning(state, q, live);
}

/**
 * An inbox entry that brings an idle worker back from waiting, so its turn asks for a place under the limit first: a
 * send-back, or an answer that did not reach the worker's live turn (`live`: those that did are part of its work).
 */
export const bringsBack = (m: { type: string; id: string }, live: ReadonlySet<string>): boolean =>
  m.type === "send_back" || (m.type === "answer" && !live.has(m.id));

/**
 * The queue is back from waiting but its engine has not let it go on yet (it asks for a place first, heldAtLimit): its
 * worker idle, with an unread entry that brings it back (bringsBack), an answer not yet in its inbox, or between a
 * step whose review ended and the next one.
 */
function returning(state: ProjectState, q: QueueView, live: ReadonlySet<string>): boolean {
  const run = q.run!;
  const s = state.sessions.find((x) => x.id === run.session);
  if (s?.live?.state !== "idle") return false;
  const current = q.steps.find((x) => x.id === run.step);
  if (current && (current.status === "done" || current.status === "skipped") && q.steps.some((x) => x.status === "pending")) return true;
  if (s.inbox.some((m) => !m.read_at && bringsBack(m, live))) return true;
  return state.questions.some((x) => x.session === run.session && x.state === "answered" && !s.inbox.some((m) => m.type === "answer" && m.qid === x.qid));
}

/** The queue's worker works on in a live turn beside its open question (asked with --can-continue). */
function workingOn(state: ProjectState, q: QueueView): boolean {
  const run = q.run!;
  if (state.sessions.find((s) => s.id === run.session)?.live?.state !== "working") return false;
  if (q.steps.some((s) => s.status === "review")) return false;
  const open = q.questions.filter((x) => isOpenQuestion(x) && (!x.step || x.step === run.step));
  return open.length > 0 && open.every((x) => x.can_continue);
}

export class Coordinator {
  private readonly members = new Set<Member>();
  private readonly limitOf: () => number;
  /** Set while a pass runs; a look asked for meanwhile makes it look once more. */
  private passing = false;
  private again = false;
  /** The pass running (or one asked for meanwhile) starts the due plans too, not only the held runs. */
  private startsToo = false;
  /** The holders, kept within a pass until a start changes them. */
  private cache?: Holder[];
  private wakeTimer?: NodeJS.Timeout;

  constructor(o: { limit?: () => number } = {}) {
    this.limitOf = o.limit ?? (() => readGlobalSettings().defaults.max_running);
  }

  add(m: Member): void { this.members.add(m); }
  remove(m: Member): void { this.members.delete(m); }

  /** How many queues may run at once, across all projects. */
  limit(): number { return this.limitOf(); }

  /** The queues holding their checkouts, across the projects. */
  holders(): Holder[] {
    if (this.cache) return this.cache;
    const out: Holder[] = [];
    for (const m of this.members) {
      if (m.isStopped()) continue;
      try { out.push(...holdersOf(loadProjectState(m.store), m.liveAnswers())); } catch { /* a project that cannot be read holds nothing */ }
    }
    if (this.passing) this.cache = out;
    return out;
  }

  /** Another queue holds the checkout `q` works in: which one. */
  checkoutBlock(state: ProjectState, q: Pick<QueueView, "id" | "worktree">): Block | undefined {
    const path = checkoutPath(state, q);
    const other = this.holders().find((h) => !(h.project === state.project.id && h.queue === q.id) && samePath(h.checkout, path));
    if (!other) return undefined;
    const which = `queue ${other.queue}${other.project !== state.project.id ? ` of ${other.name}` : ""}`;
    return { kind: "checkout", detail: other.state === "paused" ? `${which} is paused there` : `${which} runs there` };
  }

  /**
   * As many queues run as a limit allows: the global one (across all projects), or the project's own (its effective
   * `defaults.max_running`, which is the global one unless it has a value of its own).
   */
  limitBlock(state: ProjectState, q: Pick<QueueView, "id">): Block | undefined {
    const limit = this.limit();
    const others = this.holders().filter((h) => h.counts && !(h.project === state.project.id && h.queue === q.id));
    if (others.length >= limit) return { kind: "limit", detail: `${others.length} ${others.length === 1 ? "queue runs" : "queues run"}, the limit is ${limit}` };
    const own = state.project.defaults.max_running;
    const mine = others.filter((h) => h.project === state.project.id).length;
    if (mine < own) return undefined;
    return { kind: "limit", detail: `${mine} ${mine === 1 ? "queue" : "queues"} of ${state.project.name} ${mine === 1 ? "runs" : "run"}, its limit is ${own}` };
  }

  /** Why `q` may not start now: its checkout is held, or the limit is reached. */
  startBlock(state: ProjectState, q: Pick<QueueView, "id" | "worktree">): Block | undefined {
    return this.checkoutBlock(state, q) ?? this.limitBlock(state, q);
  }

  /** A run was written: the holders kept within a pass are read again. */
  runChanged(): void { this.cache = undefined; }

  /** A look at the planned starts soon (after a run ended, paused, or went waiting; after the limit changed). */
  wake(): void {
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = undefined; this.checkStarts(); }, 0);
  }

  /**
   * Lets the runs held at the limit go on, then starts the planned starts that came due, in the order their plans
   * were made, across the projects. Each that goes is followed by a fresh look at the holders, so the next one sees
   * it. One that may not go on or start yet records why.
   */
  checkStarts(): void { this.pass(true); }

  /**
   * Lets the runs held at the limit go on, as far as places are free, in the order they became ready (across the
   * projects): before a queue back from waiting asks for a place of its own, so the runs held before it go first.
   */
  releaseHeld(): void { this.pass(false); }

  private pass(starts: boolean): void {
    // Within a pass, the held runs had their turn already this round: only a look at the starts is asked for again.
    if (this.passing) { if (starts) { this.again = true; this.startsToo = true; } return; }
    this.passing = true;
    this.startsToo = starts;
    try {
      // A start inside the pass may ask for another look (its change notices); a few rounds settle it.
      for (let round = 0; round < 5; round++) {
        this.again = false;
        this.cache = undefined;
        this.inOrder((m) => m.heldRuns().map((h) => ({ queue: h.queue, at: h.since })), (m, queue) => m.releaseHeld(queue));
        if (this.startsToo) this.inOrder((m) => m.duePlans().map((d) => ({ queue: d.queue, at: d.created_at })), (m, queue) => m.startDue(queue));
        if (!this.again) break;
      }
    } finally {
      this.passing = false;
      this.cache = undefined;
    }
  }

  /**
   * The accepting members' queues `of` lists, in the order of their `at`, across the projects (then by project and
   * queue): each `go`es while its member still accepts, and one that went is followed by a fresh look at the holders.
   */
  private inOrder(of: (m: Member) => { queue: string; at: string }[], go: (m: Member, queue: string) => boolean): void {
    const all = [...this.members].filter((m) => m.accepting())
      .flatMap((m) => of(m).map((x) => ({ m, ...x })))
      .sort((a, b) => a.at.localeCompare(b.at) || compareIds(a.m.store.dir, b.m.store.dir) || compareIds(a.queue, b.queue));
    for (const x of all) if (x.m.accepting() && go(x.m, x.queue)) this.cache = undefined;
  }
}
