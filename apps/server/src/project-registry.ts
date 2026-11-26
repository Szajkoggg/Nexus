// The projects this server has loaded (queue LCF; LC2 finding 4): made from the registry (refresh), taken out (drop),
// their agents and writes stopped for an update's hand-over (release), and all dropped before a failed hand-over's
// start over (dropAll), each its model, engine, orchestrator, conversations, merger and watcher. What main.ts kept at
// module level comes in as arguments (`RegistryParts`); the HTTP server (its port taken again after a failed
// hand-over) stays in main.ts, as do the decisions on a change.
import { errorText } from "@nexus/protocol/errors";
import { ProjectModel, ProjectStore, ensureGlobalSettings, readRegistry } from "@nexus/protocol";
import { Capacity } from "./capacity.ts";
import { Conversations } from "./conversations.ts";
import type { Coordinator } from "./coordinator.ts";
import type { DeployPlanner } from "./deploy-plan.ts";
import { readCrash } from "./crash.ts";
import { readDeployChanges } from "./deploy.ts";
import { Engine } from "./engine.ts";
import { projectPart, type Lifecycle } from "./lifecycle.ts";
import { Merger } from "./merger.ts";
import { Orchestrator } from "./orchestrator.ts";
import { perf } from "./perf.ts";
import type { push as pushNotice } from "./remote.ts";
import { stopProject } from "./removal.ts";
import { readSnapshots } from "./snapshots.ts";
import { watchProject as watchProjectFiles, type ProjectWatch } from "./watchers.ts";

/**
 * A project loaded in this server. `model`: its files kept in memory (docs/design/model.md). `store` is the model's:
 * every reader in this server (the requests, the user's actions, the engine, the orchestrator, the merger and the rest)
 * reads through it, and the state it derives (loadProjectState over it) is the model's, once per change.
 */
export interface Entry { id: string; root: string; store: ProjectStore; model: ProjectModel; engine: Engine; orchestrator: Orchestrator; conversations: Conversations; merger: Merger; error?: string }

/** What the registry works with, kept by main.ts: its maps, and the server's parts the projects' parts are wired to. */
export interface RegistryParts {
  /** The loaded projects, by id (main.ts reads it everywhere). */
  projects: Map<string, Entry>;
  /** Over every project's engine: one queue per checkout, and the limit on queues running at once. */
  coordinator: Coordinator;
  /** Each project's change waiting for its 150 ms (main.ts, changed). */
  pending: Map<string, NodeJS.Timeout>;
  /** Each project's watchers of its .nexus folder, and the notes folder watched beside it. */
  watchers: Map<string, ProjectWatch>;
  watchedNotes: Map<string, string>;
  /** The live stream and the attention watch: what they keep of a project is forgotten when it is dropped. */
  live: { forget(id: string): void };
  watch: { forget(id: string): void };
  planner: Pick<DeployPlanner, "atBoundary" | "notices" | "shutdown">;
  lifecycle: Pick<Lifecycle, "busy" | "notice">;
  /** A project's files changed (its decisions run), and a line of a session's log only came. */
  changed(id: string): void;
  logChanged(id: string, path: string): void;
  /** The capacity's grants changed (the dashboards are told). */
  capacityChanged(): void;
  push: typeof pushNotice;
  /**
   * Ends at once every agent's job still running (worker-process.ts endAgentJobs): release's last act, for an agent
   * that did not exit in its wait. The successor never knew its job, so its write guard could not see such a process.
   */
  endAgents(): void;
  /** How long release waits for the agents' exits before it ends their jobs (10 s; a test's shorter). */
  exitWaitMs?: number;
}

export class ProjectRegistry {
  private readonly p: RegistryParts;
  /**
   * One heavy operation on the workstation at a time, across projects (src/capacity.ts). Made at the first refresh,
   * when this server is active, which writes <NEXUS_HOME>/capacity.yaml anew: the grants of a server before it ended
   * with its processes.
   */
  private capacity?: Capacity;

  constructor(parts: RegistryParts) { this.p = parts; }

  /**
   * Loads every registered project not loaded yet, and drops the ones taken off the registry (by the server's removal,
   * or by hand): their agents and timers stop, their watchers close, and the coordinator no longer counts them.
   */
  refresh(): void {
    const { projects, coordinator, planner, lifecycle } = this.p;
    const capacity = (this.capacity ??= new Capacity({ onChange: () => this.p.capacityChanged() }));
    const changed = (id: string) => this.p.changed(id);
    // Global settings (docs/protocol/settings.md, "Global settings"): the file exists from the first start on, with the built-in defaults; each project's
    // project.yaml from before them is migrated once, before anything reads it (effective values unchanged).
    ensureGlobalSettings();
    const reg = readRegistry();
    for (const p of reg.projects) {
      if (projects.has(p.id)) continue;
      const files = ProjectStore.forRoot(p.root);
      try { if (files.migrateProject()) console.log(`settings of project ${p.id}: migrated to follow the global settings where equal`); }
      catch (err) { console.error(`settings of project ${p.id}: not migrated: ${errorText(err)}`); }
      // Steps done before review levels keep the meaning they had (docs/protocol/review.md, "Before review levels").
      try { if (files.markReviewLevels()) console.log(`project ${p.id}: steps done from now on are reviewed by level`); }
      catch (err) { console.error(`project ${p.id}: review levels not marked: ${errorText(err)}`); }
      // Steps done from now on declare review decisions; those done before need no list (docs/protocol/review.md, "Review decisions").
      try { if (files.markReviewDecisions()) console.log(`project ${p.id}: steps done from now on declare review decisions`); }
      catch (err) { console.error(`project ${p.id}: review decisions not marked: ${errorText(err)}`); }
      // A deploy planned after a step or queue of this project holds the run at that step's end (src/deploy-plan.ts); so
      // does Nexus merging a worktree queue back into the run's checkout (src/merger.ts), until its fast-forward.
      let merger: Merger | undefined;
      // The project's files read once, here, and kept (docs/design/model.md): the engine's recovery reads its state, and
      // everything after reads through its store.
      const model = new ProjectModel(files.dir);
      const store = model.store;
      // Measured: making the engine recovers the project's runs after a restart (queue SV1 found it reading the whole
      // state once per queue).
      const engine = perf.measure(`engine start ${p.id}`, () => new Engine(store, () => changed(p.id), { coordinator, capacity, snapshots: readSnapshots, boundary: (q, step, state) => planner.atBoundary(p.id, q, step, state) || (merger?.atBoundary(q, step, state) ?? false) }));
      merger = new Merger(store, { start: (q) => void engine.start(q), release: (q, why) => engine.releaseHold(q, why), busy: () => engine.draining || lifecycle.busy, poke: () => changed(p.id), processesLeft: (q) => engine.queueProcessesLeft(q) });
      // Through its usual notices it is told the outcome of an update it asked for (lifecycle.notice), and what changed
      // for agents in each deploy since its session began (deploy-changes.jsonl).
      // Its routine reviews go to short-lived review helpers (src/review-helper.ts) while review_helper.enabled is on.
      const orchestrator = new Orchestrator(store, engine, () => changed(p.id), { update: () => lifecycle.notice(), plan: () => planner.notices(), changes: readDeployChanges, crash: readCrash, push: ({ kind, ...n }) => void this.p.push(n, { kind }) }, { helpers: {} });
      projects.set(p.id, { id: p.id, root: p.root, store, model, engine, orchestrator, merger, conversations: new Conversations(store, orchestrator, () => changed(p.id)) });
      this.watchProject(p.id, store.dir);
    }
    for (const [id, e] of projects) if (!reg.projects.some((p) => p.id === id)) void stopProject(this.drop(e).parts);
  }

  /**
   * Takes a project out of this server: out of the map and the coordinator, its watcher closed, its pending change
   * dropped, its push baseline forgotten. Returns its parts that run agents or timers (for stopProject), and the closing
   * of its watcher (on Windows an open watcher may hold the folder).
   */
  drop(e: Entry): { parts: Parameters<typeof stopProject>[0]; closed: Promise<void> } {
    const { projects, coordinator, pending, watchers, watchedNotes, watch, live } = this.p;
    projects.delete(e.id);
    coordinator.remove(e.engine);
    clearTimeout(pending.get(e.id));
    pending.delete(e.id);
    const w = watchers.get(e.id);
    watchers.delete(e.id);
    watchedNotes.delete(e.id);
    watch.forget(e.id);
    e.model.close();
    live.forget(e.id);
    return { parts: [e.engine, e.orchestrator, e.conversations, e.merger], closed: (w?.close() ?? Promise.resolve()).catch((err: Error) => console.error(`watch ${e.id}: not closed: ${err.message}`)) };
  }

  /**
   * The projects' side of an update's hand-over (the predecessor's release): no change waits, the watchers close, the
   * planner and the capacity stop writing, every agent stops (chat turns still running cut off and recorded first), and
   * their exits are waited for (up to 10 s); then every agent's job still running is ended at once (LCF6: before, an
   * agent that outlived the wait ran on beside the successor, whose write guard did not know its job). The HTTP server
   * is main.ts's.
   */
  async release(): Promise<void> {
    const { projects, pending, watchers, planner } = this.p;
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    const closing = [...watchers.values()].map((w) => w.close());
    watchers.clear();
    await Promise.all(closing);
    planner.shutdown(); // its timers write the plan file: no longer this server's
    this.capacity?.shutdown(); // so does the coordinator: the successor writes capacity.yaml anew
    this.capacity = undefined;
    // Chat turns still running are cut off first and recorded: the successor goes on with them (src/lifecycle.ts).
    await stopAgents([...projects.values()].map((e) => ({
      shutdown: () => projectPart(e).shutdown(),
      alive: () => e.engine.alive() || e.orchestrator.alive() || e.conversations.alive(),
    })), this.p.exitWaitMs);
    this.p.endAgents();
  }

  /**
   * Before a failed hand-over's start over (reacquire): the released projects' engines are shut down for good, and
   * each is dropped as a removed project is: its model stops hearing of this process's writes, the coordinator forgets
   * its engine (queue LH: they were only cleared, two write listeners per project left behind, and every write after
   * the next activation touched the old models too). The next refresh loads them anew.
   */
  dropAll(): void {
    for (const e of [...this.p.projects.values()]) this.drop(e);
  }

  /** At the server's own end (SIGINT, SIGTERM): the capacity and every project's parts stop, nothing waited for. */
  shutdown(): void {
    this.capacity?.shutdown();
    for (const e of this.p.projects.values()) { e.engine.shutdown(); e.orchestrator.shutdown(); e.conversations.shutdown(); e.merger.shutdown(); }
  }

  /** Watches the project's .nexus folder (watchers.ts): a change runs its decisions, a log line goes to the dashboards. */
  private watchProject(id: string, dir: string): void {
    this.p.watchers.set(id, watchProjectFiles(id, dir, { model: () => this.p.projects.get(id)?.model, changed: () => this.p.changed(id), log: (path) => this.p.logChanged(id, path) }));
  }
}

/**
 * The agents' part of an update's release (ProjectRegistry.release): every part stops, then their exits are waited for,
 * up to `waitMs` (10 s), since an agent's exit is written to its runtime file. Apart from the registry so that a test
 * can release an engine of its own with a short wait (survey LC4, recommended addition 1).
 */
export async function stopAgents(parts: readonly { shutdown(): void; alive(): boolean }[], waitMs = 10_000): Promise<void> {
  for (const p of parts) p.shutdown();
  for (const until = Date.now() + waitMs; parts.some((p) => p.alive()) && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
}
