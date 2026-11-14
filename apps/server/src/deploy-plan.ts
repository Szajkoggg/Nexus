// Planned deploys (docs/ideas/deploy-timing.md): "deploy once this step is in", "once this queue is done", or "at
// this time", instead of only at once. The plan is one file, <NEXUS_HOME>/deploy-plan.json, with one writer: the
// server (on `POST /api/server/plan` and `/api/server/cancel-plan`, which `nexus server update --after|--at` and
// `nexus server cancel-plan` send, and as the plan moves on). One plan at a time.
//
// - After a step: the moment the step is in (done or skipped; one waiting for its review once it is accepted), the
//   update starts (src/lifecycle.ts). Its drain holds every running queue at its step's end, so the step's queue opens
//   no next step: the engine asks at each step boundary (Engine option `boundary`), so nothing of the next step slips
//   in even when the turn ends before the file watcher looks. After the restart the queue goes on by itself.
// - After a queue: when the queue is done, every step closed (src/protocol stepClosed), its closing step included.
// - At a time: the update starts then, so from then on no new step starts and the running ones finish. With a
//   deadline, a drain still waiting then goes on as with `now`: the running steps are interrupted and continue after
//   the restart (Lifecycle.hurry). Without one it waits.
// - Provisional work (review level 3): with a project's `provisional_counts` off, a provisional step counts as in only
//   once the user confirmed it, and the deploy waits while the commit it would deploy holds provisional work of that
//   project the user has not confirmed (as the push of accepted work does, src/accepted.ts). Meanwhile only the plan's
//   own queue is held (at the step's end); everything else goes on. The user and the orchestrator are told.
// - The plan is dropped, and the user and the orchestrator are told, when its step fails, stops or is rejected, or
//   its queue gets a failed or stopped step, is cancelled or goes away. A failed update drops it too.
// - The plan stays across a plain restart of the server. The hand-over of the update it started ends it, so the
//   successor never deploys again.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId, nexusHome, now, pendingProvisional, renameRetrying, stepClosed, type ProjectState } from "@nexus/protocol";
import type { UpdateAsker } from "./handover.ts";
import type { UpdateStatus } from "./lifecycle.ts";

/** What a plan waits for: a step of a queue, or (no `step`) the whole queue. */
export interface PlanTarget { project: string; queue: string; step?: string }

export interface DeployPlan {
  id: string;
  /** After a step or a queue; or, with `at`, at a time. */
  after?: PlanTarget;
  /** The time (ISO 8601) from which no new step starts and the update waits for the running ones. */
  at?: string;
  /** With `at`: the time (ISO 8601) at which a drain still waiting interrupts the running steps. */
  deadline?: string;
  /** What the update deploys (default main). */
  ref?: string;
  /** The orchestrator session that planned it (absent when the user did); it is told the outcome. */
  by?: UpdateAsker;
  created_at: string;
  /** Said when it was set: the step's queue runs on a worktree branch of its own. */
  warning?: string;
  /** Its time or target came, and it waits for the user's confirmation of this provisional work (`queue/step`). */
  waiting_for?: string[];
  /** The run it holds at the target step's end while it waits (resumed by the restart, or when the plan ends). */
  held?: { project: string; queue: string };
  /** The update it started: set once it was due. */
  started?: { at: string; update: string };
}

/**
 * How a plan ended. `carried-out`: its update handed over (the successor finds nothing to do); `dropped`: its target
 * will not be in (a failed, stopped or rejected step); `update-failed`: the update it started failed; `cancelled`: by
 * cancel-plan, or by cancelling the update it started.
 */
export interface EndedPlan { plan: DeployPlan; at: string; why: "carried-out" | "dropped" | "update-failed" | "cancelled"; reason: string; by?: UpdateAsker }

export interface PlanFile { protocol: 1; plan?: DeployPlan; ended?: EndedPlan }

/** What an orchestrator is told about a plan (Orchestrator `news.plan`). */
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
  if (!x || typeof x.id !== "string") return undefined;
  const after = typeof x.after?.project === "string" && typeof x.after?.queue === "string";
  return after || (typeof x.at === "string" && !Number.isNaN(Date.parse(x.at))) ? x : undefined;
}

function writePlanFile(f: PlanFile, file = deployPlanFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(f, null, 2) + "\n");
  renameRetrying(file + ".tmp", file);
}

/** A time as the user reads it, on this machine: "2026-11-15 06:00". */
export const localTime = (iso: string) => new Date(iso).toLocaleString("sv-SE").slice(0, 16);

/** "step Q/S" or "queue Q", for the texts. */
export const targetText = (t: PlanTarget) => (t.step ? `step ${t.queue}/${t.step}` : `queue ${t.queue}`);

/** "after step Q/S", "after queue Q" or "at 2026-11-15 06:00". */
export const whenText = (p: Pick<DeployPlan, "after" | "at">) => (p.after ? `after ${targetText(p.after)}` : `at ${localTime(p.at!)}`);

/**
 * A time given for a plan: "HH:MM" (its next occurrence, today or tomorrow), "YYYY-MM-DD HH:MM" (this machine's local
 * time), or ISO 8601. Returns ISO 8601.
 */
export function planTime(text: string, from = new Date()): string {
  const t = text.trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (clock) {
    const [h, m] = [Number(clock[1]), Number(clock[2])];
    if (h > 23 || m > 59) throw new PlanError(`not a time of day: ${t}`);
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(t);
  if (local) {
    const [y, mo, da, h, mi] = local.slice(1).map(Number) as [number, number, number, number, number];
    const d = new Date(y, mo - 1, da, h, mi, 0, 0);
    if (d.getMonth() !== mo - 1 || h > 23 || mi > 59) throw new PlanError(`not a date and time: ${t}`);
    return d.toISOString();
  }
  const ms = Date.parse(t);
  if (/^\d{4}-\d{2}-\d{2}T/.test(t) && !Number.isNaN(ms)) return new Date(ms).toISOString();
  throw new PlanError(`give the time as HH:MM, "YYYY-MM-DD HH:MM" or ISO 8601, not "${t}"`);
}

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

/**
 * The provisional work the user has not confirmed that keeps a deploy of commit `sha` waiting, as `queue/step`: in each
 * project whose `provisional_counts` is off, a step with a provisional acceptance waiting for the user whose recorded
 * review commit is `sha` or an ancestor of it and that made commits of its own (as src/accepted.ts holds a push), and
 * the plan's own target step while it is such a step (it counts only once confirmed, commits or not).
 */
export function unconfirmedIn(states: ProjectState[], sha: string | undefined, isAncestor: (a: string, b: string) => boolean, target?: PlanTarget): string[] {
  const out: string[] = [];
  for (const state of states) {
    if (state.project.defaults.provisional_counts) continue;
    for (const q of state.queues) for (const st of q.steps) {
      if (!pendingProvisional(st)) continue;
      const own = q.push?.review[st.id]?.sha;
      const isTarget = target?.project === state.project.id && target.queue === q.id && target.step === st.id;
      const madeCommits = !!own && q.git?.steps[st.id]?.[0]?.start !== own;
      if (isTarget || (sha && own && madeCommits && (own === sha || isAncestor(own, sha)))) out.push(`${q.id}/${st.id}`);
    }
  }
  return out;
}

/** What the planner needs of the update lifecycle (src/lifecycle.ts). */
export interface PlanLifecycle {
  readonly busy: boolean;
  readonly status: UpdateStatus;
  start(opts: { ref?: string; by?: UpdateAsker }): UpdateStatus;
  cancel(): void;
  hurry(): void;
}

export interface PlannerOptions {
  lifecycle: PlanLifecycle;
  /** A project's current state (undefined: unknown project, or not loaded). */
  state: (project: string) => ProjectState | undefined;
  /** Every registered project's id. */
  projects?: () => string[];
  /** The checkout this server deploys (where the plan's ref is resolved): the server's root. */
  root?: string;
  /** Runs git in `root` (tests may replace it); returns its output, throws on a non-zero exit. */
  git?: (root: string, args: string[]) => string;
  /** A push notification for the user's devices. */
  push?: (n: { title: string; body: string; url: string; tag: string }) => void;
  /** The plan changed: dashboards reload the server's state; projects look again (their orchestrators are told). */
  changed?: () => void;
  /** A run the plan held at its step's end goes on (the plan ended without its deploy): Engine.releaseHold. */
  release?: (project: string, queue: string, reason: string) => void;
  file?: string;
}

const runGit = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();

export class DeployPlanner {
  private f: PlanFile;
  private readonly o: PlannerOptions;
  private timer?: NodeJS.Timeout;

  constructor(o: PlannerOptions) {
    this.o = o;
    this.f = readPlanFile(this.file);
  }

  /**
   * This server now owns the files (a start, a successor's take-over, a predecessor's rollback): read the plan again.
   * One started by an update that never got to its hand-over (a plain start after the server stopped mid-drain) did not
   * deploy: it waits again, and starts its update once it is due. Its timers are armed again.
   */
  recover(): void {
    this.f = readPlanFile(this.file);
    const p = this.f.plan;
    if (p?.started && !(this.o.lifecycle.busy && this.o.lifecycle.status.id === p.started.update)) {
      this.f = { ...this.f, plan: { ...p, started: undefined } };
      this.write();
    }
    this.arm();
  }

  /** Stops its timers (the server's shutdown, tests). */
  shutdown(): void { clearTimeout(this.timer); this.timer = undefined; }

  private get file(): string { return this.o.file ?? deployPlanFile(); }
  private write(): void { writePlanFile(this.f, this.file); this.arm(); this.o.changed?.(); }

  /** The plan, with what it waits for, in a sentence. */
  view(): (DeployPlan & { waiting?: string }) | null {
    const p = this.f.plan;
    if (!p) return null;
    if (p.started) return p;
    if (p.waiting_for?.length) return { ...p, waiting: `waits for the user's confirmation of provisional work: ${p.waiting_for.join(", ")}` };
    const j = this.verdict(p);
    return { ...p, waiting: j.verdict !== "in" ? j.reason : undefined };
  }

  get plan(): DeployPlan | undefined { return this.f.plan; }
  get ended(): EndedPlan | undefined { return this.f.ended; }

  /**
   * Plans a deploy for after a step or a queue, or at a time (with an optional deadline). Refused while another plan
   * stands or an update is under way, for an unknown project, queue or step, for a target that will not be in, and for
   * a time that has passed. A target already in deploys now (unless it waits for the user's confirmation).
   */
  set(o: { after?: PlanTarget; at?: string; deadline?: string; ref?: string; by?: UpdateAsker }): { text: string; plan?: DeployPlan; update?: UpdateStatus } {
    const p0 = this.f.plan;
    if (p0) throw new PlanError(`a deploy is already planned ${whenText(p0)}; cancel it first (nexus server cancel-plan)`);
    if (this.o.lifecycle.busy) throw new PlanError(`an update is already ${this.o.lifecycle.status.phase}`);
    if (!o.after === !o.at) throw new PlanError("plan a deploy either after a step or queue, or at a time");
    if (o.deadline && !o.at) throw new PlanError("a deadline goes with a time (at)");
    let warning: string | undefined;
    if (o.after) {
      const state = this.o.state(o.after.project);
      if (!state) throw new PlanError(`no project ${o.after.project}`);
      const q = state.queues.find((x) => x.id === o.after!.queue);
      if (!q) throw new PlanError(`no queue ${o.after.queue} in project ${o.after.project}`);
      if (o.after.step && !q.steps.some((s) => s.id === o.after!.step)) throw new PlanError(`no step ${o.after.step} in queue ${o.after.queue}`);
      const j = judgePlan(o.after, state);
      if (j.verdict === "dropped") throw new PlanError(`${j.reason}: it will not be in, so no deploy is planned after it`);
      // A queue on a worktree branch of its own: its commits are on that branch, and in a deploy of main only once merged.
      warning = q.worktree && !q.git?.merged ? `queue ${q.id} runs on its own worktree branch${q.branch ? ` (${q.branch})` : ""}: its work is in the deploy only once it is merged into main` : undefined;
    } else {
      if (Date.parse(o.at!) <= Date.now()) throw new PlanError(`${localTime(o.at!)} has passed`);
      if (o.deadline && Date.parse(o.deadline) <= Date.parse(o.at!)) throw new PlanError(`the deadline ${localTime(o.deadline)} is not after ${localTime(o.at!)}`);
    }
    const plan: DeployPlan = { id: newId(), after: o.after, at: o.at, deadline: o.deadline, ref: o.ref || undefined, by: o.by, created_at: now(), warning };
    this.f = { ...this.f, plan };
    const outcome = this.evaluate();
    if (outcome === "triggered") {
      return { text: `${targetText(o.after!)} is already in: the update starts now`, plan: this.f.plan, update: this.o.lifecycle.status };
    }
    if (outcome === "dropped") throw new PlanError(this.f.ended?.reason ?? "the update did not start");
    if (outcome !== "waits") this.write();
    const p = this.f.plan!;
    const why = p.waiting_for?.length ? `it waits for the user's confirmation of provisional work: ${p.waiting_for.join(", ")}` : this.view()?.waiting;
    const deadline = p.deadline ? `; at ${localTime(p.deadline)} the running steps are interrupted if it is still waiting for them` : p.at ? "; it waits for the running steps without a deadline" : "";
    return { text: `a deploy is planned ${whenText(p)}${why ? ` (${why})` : ""}${deadline}${warning ? `; note: ${warning}` : ""}`, plan: p };
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
    return `the deploy planned ${whenText(p)} is cancelled${also}`;
  }

  /** After a change in a project: starts the deploy once it is due, waits, or drops the plan when it will not be. */
  check(project: string, state: ProjectState): void {
    const p = this.f.plan;
    if (!p || p.started) return;
    // Another project's change matters only to what may hold the plan (a confirmation of provisional work).
    if (p.after && p.after.project !== project && !p.waiting_for?.length) return;
    this.evaluate(p.after?.project === project ? state : undefined);
  }

  /**
   * The engine of `project` is at the end of step `step` of `queue` and is about to go on: whether it should not.
   * `true`: the plan's target is in and its update started, holding the queue. `{ hold }`: it is in but waits for the
   * user's confirmation of provisional work: the engine holds the run here. Asked before the next step opens or the
   * run finishes.
   */
  atBoundary(project: string, queue: string, _step: string, state: ProjectState): boolean | { hold: string } {
    const p = this.f.plan;
    if (!p || p.started || !p.after || p.after.project !== project || p.after.queue !== queue) return false;
    const outcome = this.evaluate(state);
    if (outcome === "triggered") return true;
    if (outcome !== "waits") return false;
    this.f = { ...this.f, plan: { ...this.f.plan!, held: { project, queue } } };
    this.write();
    return { hold: `held for the deploy planned ${whenText(p)}, which waits for the user's confirmation of provisional work (${this.f.plan!.waiting_for!.join(", ")}); it goes on after that deploy` };
  }

  /** Where the plan stands now: its target judged, or its time. */
  private verdict(p: DeployPlan, given?: ProjectState): ReturnType<typeof judgePlan> {
    if (p.at) return Date.parse(p.at) <= Date.now() ? { verdict: "in" } : { verdict: "waiting", reason: `until ${localTime(p.at)}` };
    const state = given ?? this.o.state(p.after!.project);
    return state ? judgePlan(p.after!, state) : { verdict: "waiting", reason: `project ${p.after!.project} is not loaded` };
  }

  /** Looks at the plan: starts its update when it is due and nothing holds it, records what holds it, or drops it. */
  private evaluate(given?: ProjectState): "triggered" | "waits" | "waiting" | "dropped" | "none" {
    const p = this.f.plan;
    if (!p || p.started) return "none";
    const j = this.verdict(p, given);
    if (j.verdict === "dropped") { this.drop(j.reason); return "dropped"; }
    if (j.verdict === "waiting") return "waiting";
    const holders = this.unconfirmed(p, given);
    if (holders.length) { this.waitFor(holders); return "waits"; }
    this.trigger();
    return this.f.plan ? "triggered" : "dropped";
  }

  /** The provisional work the user has not confirmed that keeps this plan's deploy waiting (unconfirmedIn). */
  private unconfirmed(p: DeployPlan, given?: ProjectState): string[] {
    const ids = this.o.projects?.() ?? (p.after ? [p.after.project] : []);
    const states = ids.map((id) => (given && id === p.after?.project ? given : this.o.state(id))).filter((s): s is ProjectState => !!s);
    if (states.every((s) => s.project.defaults.provisional_counts)) return [];
    const git = this.o.git ?? runGit;
    const root = this.o.root;
    let sha: string | undefined;
    if (root) { try { sha = git(root, ["rev-parse", `${p.ref || "main"}^{commit}`]); } catch { sha = undefined; } }
    const isAncestor = (a: string, b: string) => { if (!root) return false; try { git(root, ["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; } };
    return unconfirmedIn(states, sha, isAncestor, p.after);
  }

  /** It is due, but waits for the user's confirmation: recorded, and told once for each set of work it waits for. */
  private waitFor(holders: string[]): void {
    const p = this.f.plan!;
    if (p.waiting_for?.join() === holders.join()) return;
    this.f = { ...this.f, plan: { ...p, waiting_for: holders } };
    this.write();
    this.o.push?.({ title: "Nexus: planned deploy waits", body: `The deploy planned ${whenText(p)} waits for your confirmation of provisional work: ${holders.join(", ")}`.slice(0, 180), url: "/?settings", tag: "nexus-deploy-plan" });
  }

  /** It is due: start the update (or, when one is under way already, let it carry the plan). */
  private trigger(): void {
    const p = { ...this.f.plan!, waiting_for: undefined };
    const l = this.o.lifecycle;
    if (l.busy) {
      this.f = { ...this.f, plan: { ...p, started: { at: now(), update: l.status.id ?? "" } } };
      this.write();
      return;
    }
    // Recorded first: the drain's own writes come back through check(), which must not start it again.
    this.f = { ...this.f, plan: { ...p, started: { at: now(), update: "" } } };
    let status: UpdateStatus;
    try { status = l.start({ ref: p.ref, by: p.by }); }
    catch (err) { this.f = { ...this.f, plan: p }; this.drop(`the update did not start: ${(err as Error).message}`); return; }
    this.f = { ...this.f, plan: { ...p, started: { at: this.f.plan!.started!.at, update: status.id ?? "" } } };
    this.write();
  }

  /** The timers: the plan's time, and its deadline once its update drains. */
  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const p = this.f.plan;
    if (!p?.at) return;
    const due = p.started ? (p.deadline ? Date.parse(p.deadline) : undefined) : Date.parse(p.at);
    if (due === undefined) return;
    const fire = () => {
      const q = this.f.plan;
      if (!q || q.id !== p.id) return;
      if (!q.started) { this.evaluate(); return; }
      // The deadline: a drain still waiting for running steps interrupts them (they continue after the restart).
      if (this.o.lifecycle.status.id === q.started.update && this.o.lifecycle.status.phase === "draining") this.o.lifecycle.hurry();
    };
    const wait = due - Date.now();
    if (wait <= 0) { queueMicrotask(fire); return; }
    // Long waits in pieces (a timer's limit is about 24.8 days).
    this.timer = setTimeout(() => (Date.now() >= due ? fire() : this.arm()), Math.min(wait + 20, 2 ** 31 - 1));
    this.timer.unref();
  }

  private drop(reason: string): void {
    const p = this.f.plan!;
    this.end("dropped", reason);
    this.o.push?.({ title: "Nexus: planned deploy dropped", body: `No deploy ${whenText(p)}: ${reason}`.slice(0, 180), url: "/?settings", tag: "nexus-deploy-plan" });
  }

  private end(why: EndedPlan["why"], reason: string, by?: UpdateAsker): void {
    const p = this.f.plan!;
    this.f = { protocol: 1, ended: { plan: p, at: now(), why, reason, by } };
    this.write();
    // A run it held while it waited goes on, unless its update holds it now (the restart, or a cancelled drain,
    // resumes it then).
    if (p.held && !p.started) this.o.release?.(p.held.project, p.held.queue, `the end of the deploy planned ${whenText(p)}`);
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
   * What the orchestrator is told about the plan, each once (key in its applied.jsonl): the one that planned it, else
   * the target project's (a plan at a time the user set tells no orchestrator). That it waits for the user's
   * confirmation of provisional work; and its end without its deploy, except a plan carried out (the update's own
   * outcome tells), an update failure that the update's outcome already tells its asker, or a cancel by the one that
   * planned it.
   */
  notices(): PlanNotice[] {
    const out: PlanNotice[] = [];
    const w = this.f.plan;
    if (w?.waiting_for?.length && !w.started) {
      const project = w.by?.project ?? w.after?.project;
      if (project) {
        out.push({
          key: `notify:deploy-plan:${w.id}:waits:${w.waiting_for.join(",")}`, project, session: w.by?.session, at: w.created_at,
          fact: `The deploy planned ${whenText(w)} waits: it would include provisional work the user has not confirmed (${w.waiting_for.join(", ")}). It goes ahead once the user confirms it${w.held ? `; queue ${w.held.queue} is held at its step's end meanwhile` : ""}.`,
          todo: "Tell the user briefly; only the user confirms provisional work.",
        });
      }
    }
    const e = this.f.ended;
    if (!e || e.why === "carried-out") return out;
    const p = e.plan;
    if (e.why === "update-failed" && p.by) return out;
    if (e.why === "cancelled" && (!p.by || (e.by && e.by.session === p.by.session))) return out;
    const project = p.by?.project ?? p.after?.project;
    if (!project) return out;
    const what = whenText(p);
    const base = { key: `notify:deploy-plan:${p.id}:${e.why}`, project, session: p.by?.session, at: e.at };
    if (e.why === "dropped") out.push({ ...base, fact: `The deploy planned ${what} will not happen: ${e.reason}. The plan is dropped.`, todo: "Tell the user briefly, with what you propose; plan or run a deploy again only when the user asks." });
    else if (e.why === "update-failed") out.push({ ...base, fact: `The deploy planned ${what} started, and the update failed: ${e.reason}. The plan is dropped.`, todo: "Tell the user briefly, with what you propose." });
    else out.push({ ...base, fact: `The deploy you planned ${what} was cancelled by the user.`, todo: "Take note; nothing to do unless the user asks." });
    return out;
  }
}

export class PlanError extends Error {}
