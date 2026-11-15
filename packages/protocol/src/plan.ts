// The plan (PROTOCOL.md, "The plan"): which queue starts after which. Each planned queue has queues/<id>/plan.yaml,
// written only by the server: the queues it waits for, each with who set it. Nexus starts a queue by the plan once
// every queue it waits for is done and its current revision is approved (and its checkout and the limit allow: the
// coordinator's rule). A dependency the user set is the user's: the orchestrator builds around it and may only propose
// to change it; the user accepts or declines the proposal with one action, or hands a dependency back to the
// orchestrator. Here: the rules and the views, free of the engine; the scheduler (apps/server) starts the queues.
import { ActionError } from "./actions.ts";
import { now, type ProjectStore } from "./store.ts";
import { loadProjectState, pendingProvisional, stepClosed, type ProjectState, type QueueView } from "./state.ts";
import { runGoing } from "./status-rules.ts";
import type { PlanBy, PlanEntry, PlanFile, ProjectFile } from "./schemas.ts";

/**
 * A queue a planned queue waits for, as it stands. `done`: it is done (every step closed, the closing step too, and,
 * where provisional work does not count, its provisional work confirmed). `blocked`: it waits on something only the
 * user or the orchestrator can change. `cause`: the predecessor is stopped, cancelled or does not exist (the user and
 * the orchestrator are told).
 */
interface PlanEntryView extends PlanEntry { done: boolean; waiting: string; blocked: boolean; cause?: "stopped" | "cancelled" | "missing" }

/**
 * A queue's place in the plan as the dashboard shows it. `used`: the queue started since it was planned (the plan stays,
 * for the view). `ready`: an unused plan whose predecessors are all done. `waiting`: why it has not started (empty once
 * used or ready and approved). `approval`: it waits for the approval of its current revision.
 */
export interface PlanView extends Omit<PlanFile, "after"> {
  after: PlanEntryView[];
  used: boolean;
  ready: boolean;
  approval: boolean;
  waiting: string;
  blocked: boolean;
}

/** A queue counts as done for the plan: every step closed (the closing step too), its provisional work as the project counts it. */
export function doneForPlan(project: Pick<ProjectFile, "defaults">, a: Pick<QueueView, "status" | "steps" | "rejection">): boolean {
  if (a.status !== "done" || !a.steps.every((s) => stepClosed(a, s))) return false;
  return project.defaults.provisional_counts || !a.steps.some(pendingProvisional);
}

/** Why a planned queue still waits for its predecessor `id` (`a`, undefined when it does not exist). */
function predecessorWait(project: Pick<ProjectFile, "defaults">, id: string, a: QueueView | undefined): Omit<PlanEntryView, keyof PlanEntry> {
  if (!a) return { done: false, waiting: `queue ${id} does not exist`, blocked: true, cause: "missing" };
  if (doneForPlan(project, a)) return { done: true, waiting: `queue ${id} is done`, blocked: false };
  if (a.status === "done") {
    const open = a.steps.find((s) => !stepClosed(a, s));
    if (open) return { done: false, waiting: `queue ${id} ended with step ${open.id} ${open.status}`, blocked: true };
    const provisional = a.steps.filter(pendingProvisional).map((s) => s.id);
    return { done: false, waiting: `queue ${id} is done; its provisional work waits for the user's confirmation (${provisional.join(", ")})`, blocked: true };
  }
  if (a.status === "cancelled") return { done: false, waiting: `queue ${id} is cancelled`, blocked: true, cause: "cancelled" };
  if (a.status === "stopped") return { done: false, waiting: `queue ${id} is stopped${a.status_reason ? `: ${a.status_reason}` : ""}`, blocked: true, cause: "stopped" };
  const r = a.run;
  if (r?.state === "halted") return { done: false, waiting: `the run of ${id} halted${r.reason ? `: ${r.reason}` : ""}`, blocked: true };
  if (r?.state === "paused") return { done: false, waiting: `the run of ${id} is paused${r.reason ? `: ${r.reason}` : ""}`, blocked: true };
  if (r?.state === "approval_wait") return { done: false, waiting: `queue ${id} waits for approval of revision ${a.revision}${r.step ? ` (after ${r.step})` : ""}`, blocked: true };
  if (r && runGoing(r)) return { done: false, waiting: `queue ${id} is running${r.step ? ` (at ${r.step})` : ""}`, blocked: false };
  if (a.status === "running" || a.status === "waiting") return { done: false, waiting: `queue ${id} is ${a.status === "waiting" ? "waiting (a question or a review)" : "running"}`, blocked: false };
  if (!a.approved) return { done: false, waiting: `queue ${id} has not started yet; it needs approval`, blocked: false };
  return { done: false, waiting: `queue ${id} has not started yet`, blocked: false };
}

/** The view of queue `q`'s plan file among the project's queues. */
export function planView(project: Pick<ProjectFile, "defaults">, q: Pick<QueueView, "approved" | "revision">, plan: PlanFile, queues: ReadonlyMap<string, QueueView>): PlanView {
  const after = plan.after.map((e) => ({ ...e, ...predecessorWait(project, e.queue, queues.get(e.queue)) }));
  const used = !!plan.started_at;
  const ready = !used && after.every((e) => e.done);
  const approval = !used && !q.approved;
  const parts = [...(approval ? [`needs approval of revision ${q.revision}`] : []), ...after.filter((e) => !e.done).map((e) => e.waiting)];
  return {
    ...plan, after, used, ready, approval,
    waiting: used ? "" : parts.join("; "),
    blocked: !used && after.some((e) => !e.done && e.blocked),
  };
}

/** The queue's plan while it counts: planned and not started since (a used plan stays only for the view). */
export const openPlan = (q: Pick<QueueView, "plan">): PlanView | undefined => (q.plan && !q.plan.used ? q.plan : undefined);

/** A plan file while it counts: the queue has not started since it was planned. */
export const openPlanFile = (p: PlanFile | undefined): PlanFile | undefined => (p && !p.started_at ? p : undefined);

/** The queue is in the plan: its plan counts, or it has a planned start. */
export const inPlan = (q: Pick<QueueView, "plan" | "start">): boolean => !!openPlan(q) || !!q.start;

/** The unused plans' predecessors, by queue: what the loop check follows. */
function planEdges(state: Pick<ProjectState, "queues">): Map<string, string[]> {
  return new Map(state.queues.flatMap((q) => {
    const plan = openPlan(q);
    return plan ? [[q.id, plan.after.map((e) => e.queue)] as const] : [];
  }));
}

/**
 * A loop the plan would get if `queue` waited for `after`: the path back to it ("C waits for B, B waits for A, …"),
 * or undefined. Follows the unused plans (`edges`).
 */
export function planLoop(edges: ReadonlyMap<string, readonly string[]>, queue: string, after: readonly string[]): string[] | undefined {
  const seen = new Set<string>();
  const walk = (at: string, path: string[]): string[] | undefined => {
    if (at === queue) return path;
    if (seen.has(at)) return undefined;
    seen.add(at);
    for (const next of edges.get(at) ?? []) {
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return undefined;
  };
  for (const a of after) {
    const found = walk(a, [queue, a]);
    if (found) return found;
  }
  return undefined;
}

/** "B waits for A, A waits for B". */
const loopText = (path: string[]) => path.slice(0, -1).map((x, i) => `${x} waits for ${path[i + 1]}`).join(", ");

/**
 * Checks a new list of predecessors for `queue`: each exists, is not the queue itself nor cancelled, and (unless `loop`
 * is false) the plan gets no loop. Returns the list without repeats.
 */
export function checkPredecessors(state: Pick<ProjectState, "queues">, queue: string, after: readonly string[], o: { loop?: boolean } = {}): string[] {
  const list = [...new Set(after)];
  for (const id of list) {
    if (id === queue) throw new ActionError("a queue cannot start after itself");
    const a = state.queues.find((x) => x.id === id);
    if (!a) throw new ActionError(`unknown queue ${id}`, 404);
    if (a.status === "cancelled") throw new ActionError(`queue ${id} is cancelled: it will never be done`, 409);
  }
  // A reorder checks its loop on the plan as it will be (reorderedFollowers).
  const loop = o.loop === false ? undefined : planLoop(planEdges(state), queue, list);
  if (loop) throw new ActionError(`that would be a loop in the plan: ${loopText(loop)}`, 409);
  return list;
}

/** The predecessors the user set that a new list `after` leaves out. */
function droppedUserEntries(plan: Pick<PlanFile, "after" | "started_at"> | undefined, after: readonly string[]): string[] {
  if (!plan || plan.started_at) return [];
  return plan.after.filter((e) => e.by === "user" && !after.includes(e.queue)).map((e) => e.queue);
}

/**
 * The entries of a plan whose predecessors `by` sets to `after` (checked already). The user's list is wholly theirs.
 * The orchestrator's must keep every predecessor the user set (refused otherwise: it may only propose that, with
 * `nexus plan propose`); entries it keeps stay as they were, new ones are its own. A used plan (the queue started since)
 * is history: a new plan starts afresh.
 */
function planEntries(old: PlanFile | undefined, queue: string, after: readonly string[], by: PlanBy, reason: string | undefined, at: string): PlanEntry[] {
  const live = openPlanFile(old);
  if (by === "orchestrator") {
    const dropped = droppedUserEntries(live, after);
    if (dropped.length) {
      throw new ActionError(`queue ${queue} waits for ${dropped.join(", ")} by the user's decision: you may not change that; keep ${dropped.length === 1 ? "it" : "them"} (--after ${dropped.join(" --after ")}), or propose the change to the user: nexus plan propose ${queue} ${after.map((x) => `--after ${x} `).join("")}--reason "..."`, 409);
    }
  }
  return after.map((id) => {
    const kept = live?.after.find((e) => e.queue === id);
    if (kept && (by === "orchestrator" || kept.by === "user")) return kept;
    return { queue: id, by, at, reason };
  });
}

/** A plan file for `queue` with predecessors `after` set by `by` (planEntries' rule), replacing `old`. */
export function newPlan(old: PlanFile | undefined, queue: string, after: readonly string[], o: { by: PlanBy; reason?: string; at?: string }): PlanFile {
  const at = o.at ?? now();
  const live = openPlanFile(old);
  const entries = planEntries(old, queue, after, o.by, o.reason, at);
  // The user's own plan: put in by the user. The orchestrator's: by whoever put it in first, while it is unused.
  const by: PlanBy = o.by === "user" ? "user" : live?.by ?? "orchestrator";
  return {
    protocol: 1, by, reason: o.by === "user" ? o.reason : live?.reason ?? o.reason, after: entries,
    created_at: live?.created_at ?? at, updated_at: at,
    // A proposal stays only while the user's dependencies it is about stay as they were.
    proposal: live?.proposal && o.by === "orchestrator" ? live.proposal : undefined,
    decisions: old?.decisions ?? [],
  };
}

const listText = (ids: readonly string[]) => ids.length ? `after ${ids.join(", ")}` : "with no queue before it (it starts as soon as it may)";

/** A proposal as the user reads it: "B after C instead of after A: <reason>". */
export function proposalText(queue: string, plan: Pick<PlanFile, "after" | "proposal">): string {
  const p = plan.proposal!;
  return `The orchestrator proposes queue ${queue} ${listText(p.after)} instead of ${listText(plan.after.map((e) => e.queue))}: ${p.reason}`;
}

/**
 * The user's reorder, as in a list (decided 2026-11-14): moving `queue` after `after` (null: to the front, with no
 * queue before it) makes `after` its only predecessor, and every queue that waited for it waits for its old
 * predecessors instead (keeping its other ones). `plans`: the unused plans by queue (used ones are history and stay).
 * Returns the plans of the queues that waited for it, changed (the moved queue's own plan is set by the scheduler,
 * which may start it); the entries that take the moved queue's place are the user's. Throws when the plan would get a
 * loop.
 */
export function reorderedFollowers(plans: ReadonlyMap<string, PlanFile>, queue: string, after: string | null, at: string): Map<string, PlanFile> {
  if (after === queue) throw new ActionError("a queue cannot start after itself");
  const old = plans.get(queue)?.after ?? [];
  const out = new Map<string, PlanFile>();
  for (const [id, plan] of plans) {
    if (id === queue || !plan.after.some((e) => e.queue === queue)) continue;
    const next: PlanEntry[] = [];
    for (const e of plan.after) {
      if (e.queue !== queue) { if (!next.some((x) => x.queue === e.queue)) next.push(e); continue; }
      // In the moved queue's place: its old predecessors, as the user's now.
      for (const o of old) {
        if (o.queue !== id && !next.some((x) => x.queue === o.queue) && !plan.after.some((x) => x.queue === o.queue)) next.push({ queue: o.queue, by: "user", at });
      }
    }
    out.set(id, { ...plan, after: next, updated_at: at });
  }
  const edges = new Map<string, string[]>([...plans].map(([id, p]) => [id, (out.get(id) ?? p).after.map((e) => e.queue)]));
  edges.set(queue, after ? [after] : []);
  const loop = after ? planLoop(edges, queue, [after]) : undefined;
  if (loop) throw new ActionError(`that would be a loop in the plan: ${loopText(loop)}`, 409);
  return out;
}

/**
 * The orchestrator proposes predecessors `after` for `queue` (the whole list), changing dependencies the user set. The
 * proposal must drop one of those (else the orchestrator sets the list itself), and is checked as a plan would be.
 * Replaces an earlier proposal of the queue. Returns what happened, in a sentence.
 */
export function proposePlan(store: ProjectStore, queue: string, after: readonly string[], reason: string): string {
  const state = loadProjectState(store);
  const q = state.queues.find((x) => x.id === queue);
  if (!q) throw new ActionError(`unknown queue ${queue}`, 404);
  if (q.status === "done" || q.status === "cancelled") throw new ActionError(`queue ${queue} is ${q.status}`, 409);
  const plan = store.readPlan(queue);
  const list = checkPredecessors(state, queue, after);
  if (!droppedUserEntries(plan, list).length) {
    throw new ActionError(`this changes no dependency the user set: set it yourself with nexus run ${queue} start ${list.length ? list.map((x) => `--after ${x}`).join(" ") : "--next"} --reason "..."`, 409);
  }
  const at = now();
  store.writePlan(queue, { ...plan!, proposal: { at, after: list, reason }, updated_at: at });
  return `proposed to the user: queue ${queue} ${listText(list)}; the user accepts or declines it, and you are told`;
}

function planOf(store: ProjectStore, queue: string): PlanFile {
  const plan = store.readPlan(queue);
  if (!plan) throw new ActionError(`queue ${queue} is not in the plan`, 409);
  return plan;
}

/**
 * The user accepts the orchestrator's proposal for `queue`: its predecessors become the proposed list. Those it keeps
 * stay as they were (a dependency the user set stays theirs); new ones are the orchestrator's.
 */
export function acceptPlanProposal(store: ProjectStore, queue: string): string {
  const plan = planOf(store, queue);
  const p = plan.proposal;
  if (!p) throw new ActionError(`queue ${queue} has no proposal to decide`, 409);
  const list = checkPredecessors(loadProjectState(store), queue, p.after);
  const at = now();
  const after = list.map((id) => plan.after.find((e) => e.queue === id) ?? { queue: id, by: "orchestrator" as const, at, reason: p.reason });
  store.writePlan(queue, {
    ...plan, after, proposal: undefined, updated_at: at,
    decisions: [...plan.decisions, { at, kind: "accepted", after: p.after, reason: p.reason }],
  });
  return `queue ${queue} now starts ${listText(list)}`;
}

/** The user declines the orchestrator's proposal for `queue`: the plan stays as it was. */
export function declinePlanProposal(store: ProjectStore, queue: string): string {
  const plan = planOf(store, queue);
  const p = plan.proposal;
  if (!p) throw new ActionError(`queue ${queue} has no proposal to decide`, 409);
  const at = now();
  store.writePlan(queue, {
    ...plan, proposal: undefined, updated_at: at,
    decisions: [...plan.decisions, { at, kind: "declined", after: p.after, reason: p.reason }],
  });
  return `the proposal for queue ${queue} is declined; it still starts ${listText(plan.after.map((e) => e.queue))}`;
}

/**
 * The user hands dependencies of `queue` back to the orchestrator ("let the orchestrator decide"): the predecessor
 * `after`, or every one the user set. A pending proposal about them is moot: it goes.
 */
export function handBackPlan(store: ProjectStore, queue: string, after?: string): string {
  const plan = planOf(store, queue);
  const mine = plan.after.filter((e) => e.by === "user" && (!after || e.queue === after));
  // A queue the user put into the plan with no queue before it: handing it back hands its place in the plan back.
  const place = !after && !plan.after.length && plan.by === "user";
  if (!mine.length && !place) throw new ActionError(after ? `queue ${queue} does not wait for ${after} by your decision` : `queue ${queue} has no dependency you set`, 409);
  const at = now();
  const queues = mine.map((e) => e.queue);
  const next: PlanFile = {
    ...plan, updated_at: at,
    by: plan.after.every((e) => e.by !== "user" || queues.includes(e.queue)) ? "orchestrator" : plan.by,
    after: plan.after.map((e) => queues.includes(e.queue) ? { ...e, by: "orchestrator" } : e),
    decisions: [...plan.decisions, { at, kind: "handed_back", queues }],
  };
  // A proposal that no longer changes a dependency of the user's is moot: the orchestrator decides it itself.
  if (next.proposal && !droppedUserEntries(next, next.proposal.after).length) next.proposal = undefined;
  store.writePlan(queue, next);
  return place && !queues.length ? `the orchestrator decides now when queue ${queue} starts`
    : `the orchestrator decides now whether queue ${queue} waits for ${queues.join(", ")}`;
}
