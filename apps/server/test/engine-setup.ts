// The shared setup of the engine tests (engine*.test.ts), against the fake runtimes (test/fake-claude.ts,
// test/fake-codex.ts): no model, no tokens. Split from engine.test.ts so its parts run side by side (queue TS2).
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers, type StepDef } from "@nexus/protocol";
import { Engine, type EngineOptions } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { WAIT_MS, until as waitUntil } from "./wait.ts";

export const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
export const WINDOW = { claude: 1000, codex: 2000 } as const;

/** Short retries and usage margins, so the tests wait milliseconds where the server waits minutes. */
export const FAST: EngineOptions = { retryBaseMs: 30, usageMarginMs: 100 };

export function setup(behaviours: string[], options: EngineOptions = FAST) {
  const root = mkdtempSync(join(tmpdir(), "nexus-engine-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const steps: StepDef[] = behaviours.map((b, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], history: [] });
  approveQueue(store, "Q");
  // The server calls onChange after every file change; here every engine notification does.
  const engine: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); engine.onChange(loadProjectState(store)); }, options);
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; priority: string | null; busy: boolean }) : []);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; run: ${JSON.stringify(queue().run)}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
  return { store, engine, queue, received, until };
}

/** The next server on the same files, as after a restart. */
export function restart(store: ProjectStore, options: EngineOptions = FAST): Engine {
  const next: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); next.onChange(loadProjectState(store)); }, options);
  return next;
}

export const activityOf = (store: ProjectStore, session: string) => store.readActivity(session).entries;

/** A queue's run, written as a test fixture. */
/** A run left paused or halted, in a worktree of its own (a paused run holds its checkout). */
export function fixtureRun(store: ProjectStore, id: string, state: "paused" | "halted", reason: string) {
  store.writeQueue({ protocol: 1, id, title: id, revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: `${id}1`, title: "x", goal: "FAKE: done", acceptance: [] }], approvals: [], history: [], worktree: join(store.dir, "..", `wt-${id}`) });
  approveQueue(store, id);
  store.writeSession({ protocol: 1, id: `s-${id}`, project: "p", role: "worker", runtime: "claude", native_id: "00000000-0000-4000-8000-000000000000", cwd: store.dir, launched_by: "nexus", created_at: new Date().toISOString() });
  const t = new Date().toISOString();
  store.writeRun(id, { protocol: 1, session: `s-${id}`, state, reason, started_at: t, updated_at: t });
}

