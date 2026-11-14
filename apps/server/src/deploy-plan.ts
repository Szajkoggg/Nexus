// Planned deploys (docs/ideas/deploy-timing.md): "deploy once this step is in", or "once this queue is done", instead
// of only at once. The plan is one file, <NEXUS_HOME>/deploy-plan.json, with one writer: the server (on
// `POST /api/server/plan` and `/api/server/cancel-plan`, which `nexus server update --after` and `nexus server
// cancel-plan` send, and as the plan's target moves on). One plan at a time.
//
// - After a step: the moment the step is in (done or skipped; one waiting for its review once it is accepted), the
//   update starts (src/lifecycle.ts). Its drain holds every running queue at its step's end, so the step's queue opens
//   no next step: the engine asks at each step boundary (Engine option `boundary`), so nothing of the next step slips
//   in even when the turn ends before the file watcher looks. After the restart the queue goes on by itself.
// - After a queue: when the queue is done, every step closed (src/protocol stepClosed), its closing step included.
// - The plan is dropped, and the user and the orchestrator are told, when its step fails, stops or is rejected, or
//   its queue gets a failed or stopped step, is cancelled or goes away. A failed update drops it too.
// - The plan stays across a plain restart of the server. The hand-over of the update it started ends it, so the
//   successor never deploys again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId, nexusHome, now, renameRetrying, stepClosed, type ProjectState } from "@nexus/protocol";
import type { UpdateAsker } from "./handover.ts";
import type { UpdateStatus } from "./lifecycle.ts";

/** What a plan waits for: a step of a queue, or (no `step`) the whole queue. */
export interface PlanTarget { project: string; queue: string; step?: string }

export interface DeployPlan {
  id: string;
  after: PlanTarget;
  /** What the update deploys (default main). */
  ref?: string;
  /** The orchestrator session that planned it (absent when the user did); it is told the outcome. */
  by?: UpdateAsker;
  created_at: string;
  /** Said when it was set: the step's queue runs on a worktree branch of its own. */
  warning?: string;
  /** The update it started: set once the target was in. */
  started?: { at: string; update: string };
}

/**
 * How a plan ended. `carried-out`: its update handed over (the successor finds nothing to do); `dropped`: its target
 * will not be in (a failed, stopped or rejected step); `update-failed`: the update it started failed; `cancelled`: by
 * cancel-plan, or by cancelling the update it started.
 */
export interface EndedPlan { plan: DeployPlan; at: string; why: "carried-out" | "dropped" | "update-failed" | "cancelled"; reason: string; by?: UpdateAsker }

export interface PlanFile { protocol: 1; plan?: DeployPlan; ended?: EndedPlan }

/** What an orchestrator is told about a plan that ended without its deploy (Orchestrator `news.plan`). */
export interface PlanNotice { key: string; project: string; session?: string; at: string; fact: string; todo: string }

export const deployPlanFile = () => join(nexusHome(), "deploy-plan.json");

export function readPlanFile(file = deployPlanFile()): PlanFile {
  if (!existsSync(file)) return { protocol: 1 };
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as PlanFile;
    return v && typeof v === "object" ? { protocol: 1, plan: validPlan(v.plan), ended: v.ended && validPlan(v.ended.plan) ? v.ended : undefined } : { protocol: 1 };
  } catch { return { protocol: 1 }; }
}

function validPlan(p: unknown): DeployPlan | undefined {
  const x = p as DeployPlan | undefined;
  return x && typeof x.id === "string" && typeof x.after?.project === "string" && typeof x.after?.queue === "string" ? x : undefined;
}

function writePlanFile(f: PlanFile, file = deployPlanFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(f, null, 2) + "\n");
  renameRetrying(file + ".tmp", file);
}

/** "Q/S" or "Q", for the texts. */
export const targetText = (t: PlanTarget) => (t.step ? `step ${t.queue}/${t.step}` : `queue ${t.queue}`);

/**
 * Where a plan's target stands in its project's state: `in` (deploy now), `dropped` (it will not be in: why), or
 * waiting (what for).
 */
export function judgePlan(t: PlanTarget, state: ProjectState): { verdict: "in" } | { verdict: "dropped"; reason: string } | { verdict: "waiting"; reason: string } {
  const q = state.queues.find((x) => x.id === t.queue);
  if (!q) return { verdict: "dropped", reason: `queue ${t.queue} no longer exists` };
  if (q.status === "cancelled") return { verdict: "dropped", reason: `queue ${t.queue} was cancelled` };
  if (t.step) {
    const st = q.steps.find((s) => s.id === t.step);
    if (!st) return { verdict: "dropped", reason: `step ${t.queue}/${t.step} no longer exists` };
    // In: done (also accepted after its review) or skipped. A step in review counts once it is accepted.
    if (st.status === "done" || st.status === "skipped") return { verdict: "in" };
    if (st.status === "failed" || st.status === "stopped") return { verdict: "dropped", reason: `step ${t.queue}/${t.step} ${st.status}${st.reason ? `: ${st.reason}` : ""}` };
    if (st.status === "rejected") return { verdict: "dropped", reason: `step ${t.queue}/${t.step} was rejected` };
    return { verdict: "waiting", reason: st.status === "review" ? `step ${t.queue}/${t.step} waits for its review` : `step ${t.queue}/${t.step} is ${st.status}` };
  }
  // A queue is done when every step is closed, its closing step included; a stopped or failed step means it is not.
  if (q.steps.length && q.steps.every((s) => stepClosed(q, s))) return { verdict: "in" };
  const bad = q.steps.find((s) => s.status === "failed" || s.status === "stopped");
  if (bad) return { verdict: "dropped", reason: `step ${t.queue}/${bad.id} ${bad.status}${bad.reason ? `: ${bad.reason}` : ""}, so queue ${t.queue} is not done` };
  if (q.status === "stopped") return { verdict: "dropped", reason: `queue ${t.queue} stopped${q.status_reason ? `: ${q.status_reason}` : ""}` };
  const left = q.steps.filter((s) => !stepClosed(q, s)).length;
  return { verdict: "waiting", reason: `queue ${t.queue} has ${left} step${left === 1 ? "" : "s"} left` };
}

/** What the planner needs of the update lifecycle (src/lifecycle.ts). */
export interface PlanLifecycle {
  readonly busy: boolean;
  readonly status: UpdateStatus;
  start(opts: { ref?: string; by?: UpdateAsker }): UpdateStatus;
  cancel(): void;
}

export interface PlannerOptions {
  lifecycle: PlanLifecycle;
  /** A project's current state (undefined: unknown project, or not loaded). */
  state: (project: string) => ProjectState | undefined;
  /** A push notification for the user's devices. */
  push?: (n: { title: string; body: string; url: string; tag: string }) => void;
  /** The plan changed: dashboards reload the server's state; projects look again (their orchestrators are told). */
  changed?: () => void;
  file?: string;
}

export class DeployPlanner {
  private f: PlanFile;
  private readonly o: PlannerOptions;

  constructor(o: PlannerOptions) {
    this.o = o;
    this.f = readPlanFile(this.file);
  }

  /**
   * This server now owns the files (a start, a successor's take-over, a predecessor's rollback): read the plan again.
   * One started by an update that never got to its hand-over (a plain start after the server stopped mid-drain) did not
   * deploy: it waits again, and starts its update once its target is in.
   */
  recover(): void {
    this.f = readPlanFile(this.file);
    const p = this.f.plan;
    if (p?.started && !(this.o.lifecycle.busy && this.o.lifecycle.status.id === p.started.update)) {
      this.f = { ...this.f, plan: { ...p, started: undefined } };
      this.write();
    }
  }

  private get file(): string { return this.o.file ?? deployPlanFile(); }
  private write(): void { writePlanFile(this.f, this.file); this.o.changed?.(); }

  /** The plan, with where its target stands. */
  view(): (DeployPlan & { waiting?: string }) | null {
    const p = this.f.plan;
    if (!p) return null;
    if (p.started) return p;
    const state = this.o.state(p.after.project);
    const j = state ? judgePlan(p.after, state) : undefined;
    return { ...p, waiting: j && j.verdict !== "in" ? j.reason : undefined };
  }

  get plan(): DeployPlan | undefined { return this.f.plan; }
  get ended(): EndedPlan | undefined { return this.f.ended; }

  /**
   * Plans a deploy for after a step or a queue. Refused while another plan stands or an update is under way, for an
   * unknown project, queue or step, and for a target that will not be in. A target already in deploys now.
   */
  set(o: { after: PlanTarget; ref?: string; by?: UpdateAsker }): { text: string; plan?: DeployPlan; update?: UpdateStatus } {
    const p0 = this.f.plan;
    if (p0) throw new PlanError(`a deploy is already planned after ${targetText(p0.after)}; cancel it first (nexus server cancel-plan)`);
    if (this.o.lifecycle.busy) throw new PlanError(`an update is already ${this.o.lifecycle.status.phase}`);
    const state = this.o.state(o.after.project);
    if (!state) throw new PlanError(`no project ${o.after.project}`);
    const q = state.queues.find((x) => x.id === o.after.queue);
    if (!q) throw new PlanError(`no queue ${o.after.queue} in project ${o.after.project}`);
    if (o.after.step && !q.steps.some((s) => s.id === o.after.step)) throw new PlanError(`no step ${o.after.step} in queue ${o.after.queue}`);
    const j = judgePlan(o.after, state);
    if (j.verdict === "dropped") throw new PlanError(`${j.reason}: it will not be in, so no deploy is planned after it`);
    // A queue on a worktree branch of its own: its commits are on that branch, and in a deploy of main only once merged.
    const warning = q.worktree && !q.git?.merged ? `queue ${q.id} runs on its own worktree branch${q.branch ? ` (${q.branch})` : ""}: its work is in the deploy only once it is merged into main` : undefined;
    const plan: DeployPlan = { id: newId(), after: o.after, ref: o.ref || undefined, by: o.by, created_at: now(), warning };
    this.f = { ...this.f, plan };
    if (j.verdict === "in") {
      const update = this.trigger();
      if (!this.f.plan) throw new PlanError(this.f.ended?.reason ?? "the update did not start");
      return { text: `${targetText(o.after)} is already in: the update starts now`, plan: this.f.plan, update };
    }
    this.write();
    return { text: `a deploy is planned after ${targetText(o.after)} (${j.reason})${warning ? `; note: ${warning}` : ""}`, plan };
  }

  /** Cancels the plan; if it started its update and that still drains, the drain is cancelled too (the held queues go on). */
  cancel(by?: UpdateAsker): string {
    const p = this.f.plan;
    if (!p) throw new PlanError("no deploy is planned");
    let also = "";
    if (p.started && this.o.lifecycle.status.id === p.started.update && this.o.lifecycle.status.phase === "draining") {
      this.end("cancelled", "the plan was cancelled", by);
      this.o.lifecycle.cancel();
      also = "; the update it started is cancelled, the held queues go on";
    } else if (p.started && this.o.lifecycle.busy) {
      throw new PlanError(`the update it started is already ${this.o.lifecycle.status.phase}; it cannot be cancelled now`);
    } else this.end("cancelled", "the plan was cancelled", by);
    return `the deploy planned after ${targetText(p.after)} is cancelled${also}`;
  }

  /** After a change in a project: starts the deploy once the target is in, or drops the plan when it will not be. */
  check(project: string, state: ProjectState): void {
    const p = this.f.plan;
    if (!p || p.started || p.after.project !== project) return;
    const j = judgePlan(p.after, state);
    if (j.verdict === "in") this.trigger();
    else if (j.verdict === "dropped") this.drop(j.reason);
  }

  /**
   * The engine of `project` is at the end of step `step` of `queue` and is about to go on: whether it should not (the
   * plan's target is in and its update started, holding the queue). Asked before the next step opens or the run
   * finishes.
   */
  atBoundary(project: string, queue: string, _step: string, state: ProjectState): boolean {
    const p = this.f.plan;
    if (!p || p.started || p.after.project !== project || p.after.queue !== queue) return false;
    if (judgePlan(p.after, state).verdict !== "in") return false;
    this.trigger();
    return true;
  }

  /** The target is in: start the update (or, when one is under way already, let it carry the plan). */
  private trigger(): UpdateStatus {
    const p = this.f.plan!;
    const l = this.o.lifecycle;
    if (l.busy) {
      this.f = { ...this.f, plan: { ...p, started: { at: now(), update: l.status.id ?? "" } } };
      this.write();
      return l.status;
    }
    // Recorded first: the drain's own writes come back through check(), which must not start it again.
    this.f = { ...this.f, plan: { ...p, started: { at: now(), update: "" } } };
    let status: UpdateStatus;
    try { status = l.start({ ref: p.ref, by: p.by }); }
    catch (err) { this.f = { ...this.f, plan: p }; this.drop(`the update did not start: ${(err as Error).message}`); return l.status; }
    this.f = { ...this.f, plan: { ...p, started: { at: this.f.plan!.started!.at, update: status.id ?? "" } } };
    this.write();
    return status;
  }

  private drop(reason: string): void {
    const p = this.f.plan!;
    this.end("dropped", reason);
    this.o.push?.({ title: "Nexus: planned deploy dropped", body: `No deploy after ${targetText(p.after)}: ${reason}`.slice(0, 180), url: "/?settings", tag: "nexus-deploy-plan" });
  }

  private end(why: EndedPlan["why"], reason: string, by?: UpdateAsker): void {
    const p = this.f.plan!;
    this.f = { protocol: 1, ended: { plan: p, at: now(), why, reason, by } };
    this.write();
  }

  /**
   * The update lifecycle's word on the update `id`: it is handing over (the plan it carries ends: the successor must
   * not deploy again), it failed, or it was cancelled.
   */
  updateEnded(id: string | undefined, how: "handover" | "failed" | "cancelled", reason?: string): void {
    const p = this.f.plan;
    if (p?.started && id && p.started.update === id) {
      if (how === "handover") this.end("carried-out", "its update is handing over");
      else if (how === "failed") this.end("update-failed", reason ?? "the update failed");
      else this.end("cancelled", "the update it started was cancelled");
      return;
    }
    // Failed after the hand-over began (the successor did not come up): the plan carried out turns out failed.
    const e = this.f.ended;
    if (how === "failed" && e?.why === "carried-out" && e.plan.started?.update === id) {
      this.f = { protocol: 1, ended: { ...e, at: now(), why: "update-failed", reason: reason ?? "the update failed" } };
      this.write();
    }
  }

  /**
   * What the orchestrator is told about the plan's end without its deploy, once (key in its applied.jsonl): the one
   * that planned it, else the target project's. None for a plan carried out (the update's own outcome tells), for an
   * update failure that the update's outcome already tells its asker, or for a cancel by the one that planned it.
   */
  notice(): PlanNotice | undefined {
    const e = this.f.ended;
    if (!e || e.why === "carried-out") return undefined;
    const p = e.plan;
    if (e.why === "update-failed" && p.by) return undefined;
    if (e.why === "cancelled" && (!p.by || (e.by && e.by.session === p.by.session))) return undefined;
    const project = p.by?.project ?? p.after.project;
    const what = targetText(p.after);
    const base = { key: `notify:deploy-plan:${p.id}:${e.why}`, project, session: p.by?.session, at: e.at };
    if (e.why === "dropped") return { ...base, fact: `The deploy planned after ${what} will not happen: ${e.reason}. The plan is dropped.`, todo: "Tell the user briefly, with what you propose; plan or run a deploy again only when the user asks." };
    if (e.why === "update-failed") return { ...base, fact: `The deploy planned after ${what} started, and the update failed: ${e.reason}. The plan is dropped.`, todo: "Tell the user briefly, with what you propose." };
    return { ...base, fact: `The deploy you planned after ${what} was cancelled by the user.`, todo: "Take note; nothing to do unless the user asks." };
  }
}

export class PlanError extends Error {}
