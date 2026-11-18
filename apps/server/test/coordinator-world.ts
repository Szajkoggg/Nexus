// Projects whose engines share one coordinator, as the server's do, against the fake runtimes: the world of the tests
// of the checkout rule and the limits on queues running at once (coordinator.test.ts, limit-hold.test.ts).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, approveQueue, loadProjectState, newId, routeAnswers, updateGlobalSettings, updateSettings,
  type Event, type StepDef,
} from "@nexus/protocol";
import { Engine, type Clock } from "../src/engine.ts";
import { Coordinator } from "../src/coordinator.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil } from "./wait.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");
// Queues in checkouts of their own (plain folders here, no git) end with the integration step, which is not these
// files' subject: its fake reports it done.
process.env.FAKE_INTEGRATE = "done";

const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

/**
 * A queue: its steps' fake behaviours; `own`: in a worktree of its own (a folder), else the project's checkout;
 * `level`: its review level (1: each step waits for the test's acceptance); `coding`: a coding queue, which ends with
 * the closing refactoring step (its project's checkout is then a git repository).
 */
export type Spec = string[] | { steps: string[]; own?: boolean; level?: 1 | 2 | 3; coding?: boolean };

/** What reached the fake agents, in order (FAKE_LOG). */
export interface Received { text: string; session: string | null }

/**
 * Projects sharing one coordinator, each with its engine, under one NEXUS_HOME whose global limit is `limit` (as the
 * server's coordinator, it reads it from the global settings).
 */
export function world(opts: { limit?: number; clock?: Clock } = {}) {
  const base = mkdtempSync(join(tmpdir(), "nexus-coord-"));
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  updateGlobalSettings({ defaults: { max_running: opts.limit ?? 2 } });
  const coordinator = new Coordinator();
  const ticks: (() => void)[] = [];
  const engines: Engine[] = [];

  /** `own`: the project's own limit on its queues running at once (else it follows the global one). */
  const add = (id: string, queues: Record<string, Spec>, own?: number) => {
    const root = join(base, id);
    mkdirSync(root, { recursive: true });
    const specs = Object.values(queues).map((spec) => (Array.isArray(spec) ? { steps: spec } : spec));
    if (specs.some((s) => s.coding)) {
      const git = (...a: string[]) => execFileSync("git", [...G, ...a], { cwd: root, stdio: "ignore" });
      git("init", "-q", "-b", "main");
      writeFileSync(join(root, ".gitignore"), ".nexus/\n");
      git("add", "-A"); git("commit", "-qm", "init");
    }
    const store = ProjectStore.init(root, { id, name: `Project ${id}`, root, orchestrator: { notify: false } });
    if (own !== undefined) updateSettings(store, { defaults: { max_running: own } });
    for (const [qid, spec] of Object.entries(queues)) {
      const s = Array.isArray(spec) ? { steps: spec } : spec;
      const steps: StepDef[] = s.steps.map((b, i) => ({ id: `${qid}${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
      const worktree = s.own ? join(base, `${id}-${qid}`) : undefined;
      if (worktree) mkdirSync(worktree, { recursive: true });
      store.writeQueue({
        protocol: 1, id: qid, title: `Queue ${qid}`, revision: 1, status: "proposed", stop_conditions: [], checks: [], steps,
        approvals: [], withdrawals: [], history: [], ...(worktree ? { worktree } : {}), ...(s.level ? { review_level: s.level } : {}),
        ...(s.coding ? { coding: true } : {}),
      });
      approveQueue(store, qid);
    }
    let engine: Engine | undefined;
    // Stands in for the server's file watcher.
    const tick = () => { routeAnswers(store); acceptReviews(store); engine?.onChange(loadProjectState(store)); };
    engine = new Engine(store, tick, { retryBaseMs: 30, usageMarginMs: 100, coordinator, clock: opts.clock });
    ticks.push(tick);
    engines.push(engine);
    const queue = (q: string) => loadProjectState(store).queues.find((x) => x.id === q)!;
    return { store, engine, queue };
  };

  const timer = setInterval(() => { for (const t of ticks) t(); }, 150);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms);
  const stop = () => { clearInterval(timer); for (const e of engines) e.shutdown(); };
  // Every project's engine looks at its files once, synchronously: what did not start then never would by itself.
  const tick = () => { for (const t of ticks) t(); };
  const received = (): Received[] => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").filter(Boolean) : [])
    .map((l) => JSON.parse(l) as Received);
  return { coordinator, add, until, tick, stop, received };
}

/** Marks a queue's steps done as an external worker would, with no engine involved, and accepted. */
export function doneByHand(store: ProjectStore, queue: string, steps: string[]): void {
  const session = newId();
  store.writeSession({ protocol: 1, id: session, project: store.readProject().id, role: "worker", runtime: "external", cwd: ".", launched_by: "external", created_at: new Date().toISOString() });
  for (const step of steps) for (const type of ["step.started", "step.done"] as const) {
    store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session, type, queue, step, ...(type === "step.done" ? { summary: "by hand" } : {}) } as Event);
  }
  acceptReviews(store);
}

/** The run is at work: running or pausing. */
export const going = (state: string | undefined) => state === "running" || state === "pausing";
