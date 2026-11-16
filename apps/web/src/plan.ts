// The plan as the Queues view shows it (PROTOCOL.md, "The plan"): what runs now, then what follows, in columns; lines
// from each queue to those it waits for; on every queue what it waits for. Pure and unit tested; components/Plan.tsx
// draws it (lanes on a desktop, an ordered list on the phone).
import { runGoing } from "@nexus/protocol/status-rules";
import { formatClock, type Key, type Params } from "./i18n.ts";
import { openPlan, queueStatus, type HonestStatus, type QueueLike } from "./queueStatus.ts";

/** What the plan view reads of a queue (a QueueView fits). */
export interface PlanQueue extends Omit<QueueLike, "plan" | "start"> {
  id: string;
  title: string;
  plan?: {
    used: boolean;
    created_at?: string;
    after: readonly { queue: string; by: "user" | "orchestrator"; done: boolean; cause?: "stopped" | "cancelled" | "missing" }[];
    /** The orchestrator's proposal to change dependencies the user set, until the user decides. */
    proposal?: { after: readonly string[]; reason: string };
  };
  start?: {
    at?: string; after?: string; usage?: "claude" | "codex"; created_at?: string;
    failed?: { reason: string }; held?: { kind: "approval" | "checkout" | "limit"; reason: string };
  };
  /** Its place in the merge train: it waits for its turn to integrate, after `after`. */
  train?: { after?: string };
}

/**
 * Why a queue has not started, in a word and its colour (`tone`): its approval, a queue before it stopped or gone, its time, the usage window, its checkout, the limit, a failed start; or that it starts now.
 */
export interface Why { key: Key; params?: Params; tone: "approval" | "blocked" | "time" | "usage" | "checkout" | "limit" | "failed" | "ready" }

/** A queue it waits for, as the card names it: who set it ("set by you"), done or not. */
interface Before { queue: string; by: "user" | "orchestrator"; done: boolean }

export interface PlanNode {
  id: string;
  title: string;
  /** 0: now (running, waiting, paused or stopped: in progress); 1: next; 2 and on: later. */
  column: number;
  /** In progress now: its honest status says where it stands. */
  now: boolean;
  /** In the plan (planned, or a schedule). A queue only some planned queue waits for may not be. */
  planned: boolean;
  status: HonestStatus;
  /** Why it has not started (planned queues): first what only the user can do. In progress: why it waits (the merge train). */
  why: Why[];
  /** The queues it waits for, in its plan's order (an unused plan). */
  before: Before[];
  /** The orchestrator's proposal for it, waiting for the user. */
  proposal?: { after: readonly string[]; reason: string };
  /** The user may move it in the plan: not in progress now. */
  movable: boolean;
}

export interface PlanLayout {
  /** The columns, left to right: now, next, then …; each queue once. */
  columns: PlanNode[][];
  /** A line from a queue (`from`) to one that waits for it (`to`), with who set it. */
  edges: { from: string; to: string; by: "user" | "orchestrator" }[];
  /** Approved queues outside the plan: they wait until someone puts them in it. */
  outside: { id: string; title: string }[];
}

const NOW_STATUS = new Set(["running", "waiting", "paused", "stopped"]);
const ENDED = new Set(["done", "cancelled"]);

/** In progress now: at work, waiting for a review or an answer, paused, stopped, or its run holds its checkout. */
export function isNow(q: Pick<PlanQueue, "status" | "run">): boolean {
  if (ENDED.has(q.status)) return false;
  return NOW_STATUS.has(q.status) || runGoing(q.run);
}

/** In the plan: a place that is not used yet (planned and not started since), or a schedule. */
export const isPlanned = (q: Pick<PlanQueue, "plan" | "start" | "status">): boolean =>
  !ENDED.has(q.status) && (!!openPlan(q) || !!q.start);

/** The queues it waits for (an unused plan; a start.yaml from before the plan names one). */
function beforeOf(q: PlanQueue): Before[] {
  const plan = openPlan(q);
  if (plan) return plan.after.map((e) => ({ queue: e.queue, by: e.by, done: e.done }));
  return q.start?.after ? [{ queue: q.start.after, by: "user", done: false }] : [];
}

/** Why a planned queue has not started: what the user can do first, then what it waits for. */
export function whyOf(q: PlanQueue, now = new Date()): Why[] {
  const out: Why[] = [];
  if (q.start?.failed) out.push({ key: "plan.why.failed", params: { reason: q.start.failed.reason }, tone: "failed" });
  if (q.approved === false) out.push({ key: "plan.why.approval", params: { revision: q.revision ?? 1 }, tone: "approval" });
  for (const e of openPlan(q)?.after ?? []) {
    if (!e.done && e.cause) out.push({ key: `plan.why.${e.cause}`, params: { queue: e.queue }, tone: "blocked" });
  }
  // The queues it waits for are on the card as they are ("after RN · set by you"); a reason of their own only when
  // nothing else is said.
  const open = beforeOf(q).filter((b) => !b.done);
  if (q.start?.at && !q.start.held) {
    out.push(q.start.usage
      ? { key: "plan.why.usage", params: { time: formatClock(q.start.at, now) }, tone: "usage" }
      : { key: "plan.why.at", params: { time: formatClock(q.start.at, now) }, tone: "time" });
  }
  const held = q.start?.held;
  if (held && held.kind !== "approval") out.push({ key: held.kind === "checkout" ? "plan.why.checkout" : "plan.why.limit", params: { reason: held.reason }, tone: held.kind });
  if (!out.length && !open.length) out.push({ key: "plan.why.ready", tone: "ready" });
  return out;
}

/** Why a queue in progress waits: its turn to integrate (the merge train), after the queue before it. */
function trainWhy(q: PlanQueue): Why[] {
  return q.train?.after ? [{ key: "plan.why.train", params: { queue: q.train.after }, tone: "time" }] : [];
}

/**
 * The plan's layout: the queues in progress in the first column; each planned queue one column right of the latest of
 * the queues it waits for that are shown (those done are not); a queue only some planned queue waits for (approved
 * but not planned, say) shows too, where it would stand. Within a column the queues follow those they wait for
 * (their average row), then the order they were planned in.
 */
export function planLayout(all: readonly PlanQueue[], now = new Date()): PlanLayout {
  const byId = new Map(all.map((q) => [q.id, q]));
  const shown = new Set<string>();
  for (const q of all) if (isNow(q) || isPlanned(q)) shown.add(q.id);
  // The queues planned queues wait for that are neither done nor shown yet: shown too (they hold the plan).
  for (let grew = true; grew;) {
    grew = false;
    for (const id of [...shown]) {
      for (const b of beforeOf(byId.get(id)!)) {
        const p = byId.get(b.queue);
        if (p && !b.done && !ENDED.has(p.status) && !shown.has(p.id)) { shown.add(p.id); grew = true; }
      }
    }
  }

  const column = new Map<string, number>();
  const columnOf = (id: string, path: Set<string>): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    const q = byId.get(id)!;
    let c = 1;
    if (isNow(q)) c = 0;
    else if (!path.has(id)) {
      path.add(id);
      for (const b of beforeOf(q)) if (shown.has(b.queue)) c = Math.max(c, columnOf(b.queue, path) + 1);
      path.delete(id);
    }
    column.set(id, c);
    return c;
  };
  for (const id of shown) columnOf(id, new Set());

  const nodes = new Map<string, PlanNode>();
  for (const id of shown) {
    const q = byId.get(id)!;
    const n = isNow(q);
    const proposal = openPlan(q)?.proposal;
    nodes.set(id, {
      id, title: q.title, column: column.get(id)!, now: n, planned: isPlanned(q),
      status: queueStatus(q as QueueLike, now), why: n ? trainWhy(q) : whyOf(q, now), before: n ? [] : beforeOf(q),
      ...(proposal ? { proposal } : {}), movable: !n,
    });
  }
  const width = Math.max(0, ...[...nodes.values()].map((n) => n.column)) + 1;
  const columns: PlanNode[][] = Array.from({ length: shown.size ? width : 0 }, () => []);
  const madeAt = (id: string) => byId.get(id)?.plan?.created_at ?? byId.get(id)?.start?.created_at ?? "";
  const row = new Map<string, number>();
  for (let c = 0; c < columns.length; c++) {
    const here = [...nodes.values()].filter((n) => n.column === c);
    const weight = (n: PlanNode) => {
      const rows = n.before.map((b) => row.get(b.queue)).filter((r): r is number => r !== undefined);
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.MAX_SAFE_INTEGER;
    };
    here.sort((a, b) => weight(a) - weight(b) || madeAt(a.id).localeCompare(madeAt(b.id)) || a.id.localeCompare(b.id));
    here.forEach((n, i) => row.set(n.id, i));
    columns[c] = here;
  }
  const edges = [...nodes.values()].flatMap((n) => n.before.filter((b) => nodes.has(b.queue)).map((b) => ({ from: b.queue, to: n.id, by: b.by })));
  const outside = all.filter((q) => !shown.has(q.id) && q.status === "approved" && q.approved !== false && !q.run)
    .map((q) => ({ id: q.id, title: q.title }));
  return { columns, edges, outside };
}

/**
 * What the user may move a queue after: every other queue not ended (cancelled ones never come, done ones would start
 * it at once: "first" says that), those in the plan's order first.
 */
export function moveTargets(l: PlanLayout, all: readonly PlanQueue[], queue: string): { id: string; title: string }[] {
  const shown = planList(l).map((n) => n.id);
  return all.filter((q) => q.id !== queue && !ENDED.has(q.status))
    .sort((a, b) => (shown.indexOf(a.id) + 1 || 1e9) - (shown.indexOf(b.id) + 1 || 1e9) || a.id.localeCompare(b.id))
    .map((q) => ({ id: q.id, title: q.title }));
}

/** The phone's list: the columns one after another, each in its order. */
export const planList = (l: PlanLayout): PlanNode[] => l.columns.flat();

/**
 * A queue's expected time as the card says it (GET /api/projects/:id/estimates): "about 40 min (estimate)" (to 5
 * minutes), "about 2.5 h (estimate)" (to half an hour under 10 h, whole hours above), "no estimate" while too few steps
 * are finished; nothing when no step is left.
 */
export function estimateWords(e: { steps: number; ms?: number } | undefined): { key: Key; params?: Params } | undefined {
  if (!e || !e.steps) return undefined;
  if (e.ms === undefined) return { key: "plan.estimate.none" };
  const minutes = e.ms / 60_000;
  if (minutes < 55) return { key: "plan.estimate.minutes", params: { minutes: Math.max(5, Math.round(minutes / 5) * 5) } };
  const hours = minutes / 60;
  return { key: "plan.estimate.hours", params: { hours: hours < 9.75 ? Math.max(1, Math.round(hours * 2) / 2) : Math.round(hours) } };
}
