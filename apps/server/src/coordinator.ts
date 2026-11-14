// Over the projects' engines, the two rules about queues running side by side (DESIGN.md, "Never two queues in one
// checkout"): a checkout (the project's own, or a queue's worktree) has one queue at work at a time, and at most
// `max_running` queues run at once across all projects. A direct start that would break either is refused with the
// reason; a planned start (a chain or a schedule) that came due waits, says why on its plan (`held`), and starts by
// itself once it may. Waiting starts go in the order their plans were made, across projects; every start inside a
// pass is followed by a fresh look, so a pass never starts two queues into one checkout or past the limit.
//
// The limit lives in <NEXUS_HOME>/limits.json (one writer: the server, from the dashboard's server panel).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CHECKOUT_RUN_STATES, COUNTED_RUN_STATES, loadProjectState, nexusHome, renameRetrying,
  type ProjectState, type ProjectStore, type QueueView,
} from "@nexus/protocol";
import { checkoutPath, samePath } from "./worktree.ts";

/** How many queues may run at once when nothing else is set. */
export const DEFAULT_MAX_RUNNING = 2;

export interface Limits { max_running: number }

export const limitsFile = () => join(nexusHome(), "limits.json");

/** The server-wide limits; the default for what the file does not say (or when it is missing or unreadable). */
export function readLimits(): Limits {
  const f = limitsFile();
  if (!existsSync(f)) return { max_running: DEFAULT_MAX_RUNNING };
  try {
    const v = JSON.parse(readFileSync(f, "utf8")) as Partial<Limits>;
    return { max_running: validLimit(v.max_running) ? v.max_running : DEFAULT_MAX_RUNNING };
  } catch { return { max_running: DEFAULT_MAX_RUNNING }; }
}

/** A limit is a whole number from 1 to 20. */
export function validLimit(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 20;
}

export function writeLimits(l: Limits): void {
  const f = limitsFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify(l, null, 2) + "\n");
  renameRetrying(f + ".tmp", f);
}

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
export function holdersOf(state: ProjectState): Holder[] {
  return state.queues.filter((q) => q.run && CHECKOUT_RUN_STATES.includes(q.run.state)).map((q) => ({
    project: state.project.id, name: state.project.name, queue: q.id, state: q.run!.state, checkout: checkoutPath(state, q),
    // A queue waiting for a review or an answer does not count, nor one waiting for the usage window, a retry or an
    // approval: only a run at work.
    counts: COUNTED_RUN_STATES.includes(q.run!.state) && q.status !== "waiting",
  }));
}

export class Coordinator {
  private readonly members = new Set<Member>();
  private readonly limitOf: () => number;
  /** Set while a pass runs; a look asked for meanwhile makes it look once more. */
  private passing = false;
  private again = false;
  /** The holders, kept within a pass until a start changes them. */
  private cache?: Holder[];
  private wakeTimer?: NodeJS.Timeout;

  constructor(o: { limit?: () => number } = {}) {
    this.limitOf = o.limit ?? (() => readLimits().max_running);
  }

  add(m: Member): void { this.members.add(m); }
  remove(m: Member): void { this.members.delete(m); }

  /** How many queues may run at once. */
  limit(): number { return this.limitOf(); }

  /** The queues holding their checkouts, across the projects. */
  holders(): Holder[] {
    if (this.cache) return this.cache;
    const out: Holder[] = [];
    for (const m of this.members) {
      if (m.isStopped()) continue;
      try { out.push(...holdersOf(loadProjectState(m.store))); } catch { /* a project that cannot be read holds nothing */ }
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

  /** As many queues run as the limit allows. */
  limitBlock(state: ProjectState, q: Pick<QueueView, "id">): Block | undefined {
    const limit = this.limit();
    const n = this.holders().filter((h) => h.counts && !(h.project === state.project.id && h.queue === q.id)).length;
    return n >= limit ? { kind: "limit", detail: `${n} ${n === 1 ? "queue runs" : "queues run"}, the limit is ${limit}` } : undefined;
  }

  /** Why `q` may not start now: its checkout is held, or the limit is reached. */
  startBlock(state: ProjectState, q: Pick<QueueView, "id" | "worktree">): Block | undefined {
    return this.checkoutBlock(state, q) ?? this.limitBlock(state, q);
  }

  /** A look at the planned starts soon (after a run ended, paused, or went waiting; after the limit changed). */
  wake(): void {
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = undefined; this.checkStarts(); }, 0);
  }

  /**
   * Starts the planned starts that came due, in the order their plans were made, across the projects. Each start is
   * followed by a fresh look at the holders, so the next one sees it. One that may not start yet records why.
   */
  checkStarts(): void {
    if (this.passing) { this.again = true; return; }
    this.passing = true;
    try {
      // A start inside the pass may ask for another look (its change notices); a few rounds settle it.
      for (let round = 0; round < 5; round++) {
        this.again = false;
        this.cache = undefined;
        const due = [...this.members].filter((m) => m.accepting())
          .flatMap((m) => m.duePlans().map((d) => ({ m, ...d })))
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.m.store.dir.localeCompare(b.m.store.dir) || a.queue.localeCompare(b.queue));
        for (const d of due) {
          if (!d.m.accepting()) continue;
          if (d.m.startDue(d.queue)) this.cache = undefined;
        }
        if (!this.again) break;
      }
    } finally {
      this.passing = false;
      this.cache = undefined;
    }
  }
}
