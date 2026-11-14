// The shared setup of the planned-deploy tests (deploy-plan*.test.ts): project p with queue Q on the fake `claude`, its
// engine wired to a DeployPlanner as main.ts does, and a Lifecycle around it, against a temporary git repository
// standing in for the server's checkout (a development checkout: never moved, never pushed), npm stubbed, and a
// stand-in successor (fake-successor.ts). Split from deploy-plan.test.ts so the files run side by side (queue PD2).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, newId, now, routeAnswers, setStepLevel, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Lifecycle } from "../src/lifecycle.ts";
import { DeployPlanner, readPlanFile } from "../src/deploy-plan.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { until } from "./wait.ts";

export const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");

/** A git repository standing in for this server's checkout: a development checkout on branch `dev`. */
export function repo(base: string) {
  const root = join(base, "checkout");
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "dev");
  writeFileSync(join(root, "package-lock.json"), '{ "lock": 1 }\n');
  git("add", "-A"); git("commit", "-q", "-m", "A: where it runs");
  return root;
}

export interface Options {
  successor?: "ready" | "crash"; busyElsewhere?: () => boolean; orchestrator?: boolean; levels?: Record<string, number>;
  /** The project is the server's checkout itself (as for Nexus): its steps' commits are what a deploy deploys. */
  inRepo?: boolean;
  /** The project's own `provisional_counts`. */
  provisionalCounts?: boolean;
  /**
   * An orchestrator session (no process) whose reviews the test makes: each step waiting for its review is accepted,
   * a level-3 one provisionally.
   */
  reviewer?: boolean;
}

/**
 * Project p with queue Q (`behaviours`, one step each), its engine wired to a planner as main.ts does, and a Lifecycle
 * around it. Everything the server would do outside (push notifications, the process's exit) is recorded.
 */
export function setup(behaviours: string[], o: Options = {}) {
  const base = mkdtempSync(join(tmpdir(), "nexus-plan-"));
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  process.env.FAKE_SUCCESSOR = o.successor ?? "ready";
  process.env.FAKE_READY_MS = "200";
  const checkout = repo(base);
  const root = o.inRepo ? checkout : join(base, "project");
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  if (o.provisionalCounts !== undefined) { const p = store.readProject(); store.writeProject({ ...p, defaults: { ...p.defaults, provisional_counts: o.provisionalCounts } }); }
  let reviewer: string | undefined;
  if (o.reviewer) {
    reviewer = newId();
    store.writeSession({ protocol: 1, id: reviewer, project: "p", role: "orchestrator", runtime: "claude", native_id: randomUUID(), title: "Orchestrator", cwd: root, launched_by: "nexus", created_at: now() });
    store.writeProject({ ...store.readProject(), orchestrator: { runtime: "claude", notify: true, session: reviewer } });
  }
  /** The orchestrator's reviews, made by the test: level 3 provisionally, others accepted. */
  const review = () => {
    if (!reviewer) return;
    for (const q of loadProjectState(store).queues) for (const st of q.steps) {
      if (st.status !== "review" || st.review_with !== "orchestrator") continue;
      // As a real orchestrator, only after the server recorded the commit the step entered review at (src/accepted.ts).
      if (q.push?.review[st.id]?.finished_at !== st.finished_at) continue;
      store.appendEvent({ v: 1, id: newId(), at: now(), session: reviewer, type: st.level === 3 ? "review.provisional" : "review.accepted", queue: q.id, step: st.id });
    }
  };
  const steps: StepDef[] = behaviours.map((b, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], history: [] });
  approveQueue(store, "Q");
  for (const [step, level] of Object.entries(o.levels ?? {})) setStepLevel(store, "Q", step, level as 1 | 2 | 3);

  const pushed: { title: string; body: string }[] = [];
  const drains: string[][] = []; // the step statuses of Q at each drain: when the update started
  let exited = false;
  let orchestrator: Orchestrator | undefined;
  const tick = () => {
    routeAnswers(store); acceptReviews(store); review();
    planner.check("p", loadProjectState(store)); // as main.ts: before the engine goes on
    orchestrator?.onChange(loadProjectState(store));
    engine.onChange(loadProjectState(store));
  };
  let engine: Engine = new Engine(store, tick, { boundary: (q, step, state) => planner.atBoundary("p", q, step, state) });
  const parts = () => [
    { id: "p", idle: () => engine.idle(), drain: (n: boolean) => { drains.push(queue().steps.map((s) => s.status)); return engine.drainForUpdate(n); }, cancel: () => engine.cancelDrain(), shutdown: () => engine.shutdown(), hurry: () => engine.hurryDrain() },
    // Another project whose step still runs: the drain waits for it.
    ...(o.busyElsewhere ? [{ id: "other", idle: () => !o.busyElsewhere!(), drain: () => [], cancel: () => {}, shutdown: () => {} }] : []),
  ];
  const lifecycle = new Lifecycle(parts, () => {}, {
    root: checkout,
    successor: [process.execPath, join(here, "fake-successor.ts")],
    timeoutMs: 15_000,
    npm: async () => {},
    release: async () => { engine.shutdown(); await until("the agent to exit", () => !engine.alive()); },
    // As main.ts: new engines (and orchestrators) recover the held runs, and the planner reads its file again.
    reacquire: async () => {
      engine = new Engine(store, tick, { boundary: (q, step, state) => planner.atBoundary("p", q, step, state) });
      if (orchestrator) { orchestrator.shutdown(); orchestrator = newOrchestrator(); }
      planner.recover();
    },
    settled: () => tick(),
    notify: (text) => pushed.push({ title: "update failed", body: text }),
    exit: () => { exited = true; },
    ended: (id, how, reason) => planner.updateEnded(id, how, reason),
  });
  const newOrchestrator = () => new Orchestrator(store, engine, tick, { plan: () => planner.notices(), update: () => lifecycle.notice() });
  const planner = new DeployPlanner({
    lifecycle, state: (id) => (id === "p" ? loadProjectState(store) : undefined), projects: () => ["p"], root: checkout,
    push: (n) => pushed.push(n), release: (_p, q, reason) => engine.releaseHold(q, reason),
  });
  if (o.orchestrator) {
    process.env.FAKE_REVIEW_ACCEPT = "1"; // the fake orchestrator accepts each step waiting for its review
    const p = store.readProject();
    const session = { protocol: 1 as const, id: newId(), project: "p", role: "orchestrator" as const, runtime: "claude" as const, native_id: randomUUID(), title: "Orchestrator", cwd: root, launched_by: "nexus" as const, created_at: now() };
    store.writeSession(session);
    store.writeProject({ ...p, orchestrator: { runtime: "claude", notify: true, session: session.id } });
    orchestrator = newOrchestrator();
  }
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const statuses = () => queue().steps.map((s) => s.status);
  // The file watcher also sees the server's own writes (push.yaml's review records): a reviewer waits for those.
  const timer = o.reviewer ? setInterval(tick, 150) : undefined;
  const stop = () => { clearInterval(timer); engine.shutdown(); orchestrator?.shutdown(); planner.shutdown(); for (const k of ["FAKE_SUCCESSOR", "FAKE_READY_MS", "FAKE_REVIEW_ACCEPT"]) delete process.env[k]; };
  const show = () => `; run: ${JSON.stringify(queue().run)}; steps: ${statuses().join(" ")}; update: ${JSON.stringify(lifecycle.status)}; plan: ${JSON.stringify(readPlanFile())}`;
  /** A commit in the checkout (a step's work, made while the step runs). */
  const commit = (message: string) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", message], { cwd: checkout });
  return { store, checkout, commit, review, engine: () => engine, lifecycle, planner, queue, statuses, pushed, drains, exited: () => exited, orchestrator: () => orchestrator, stop, show, tick };
}

/** The successor's side, on the same files: a new engine, planner and lifecycle, as main.ts builds them at its start. */
export function successor(t: ReturnType<typeof setup>) {
  let engine: Engine;
  const lifecycle = new Lifecycle(() => [{ id: "p", idle: () => engine.idle(), drain: (n) => engine.drainForUpdate(n), cancel: () => engine.cancelDrain(), shutdown: () => engine.shutdown() }], () => {}, { npm: async () => {}, exit: () => {} });
  const planner = new DeployPlanner({ lifecycle, state: () => loadProjectState(t.store), projects: () => ["p"], root: t.checkout, release: (_p, q, reason) => engine.releaseHold(q, reason) });
  const tick = () => { routeAnswers(t.store); acceptReviews(t.store); t.review(); planner.check("p", loadProjectState(t.store)); engine.onChange(loadProjectState(t.store)); };
  engine = new Engine(t.store, tick, { boundary: (q, step, state) => planner.atBoundary("p", q, step, state) });
  planner.recover();
  const timer = setInterval(tick, 150);
  return { engine, lifecycle, planner, tick, stop: () => { clearInterval(timer); engine.shutdown(); planner.shutdown(); } };
}

export const handedOver = (t: ReturnType<typeof setup>) => () => t.exited();
