// The shared setup of the engine tests (engine*.test.ts), against the fake runtimes (test/fake-claude.ts,
// test/fake-codex.ts): no model, no tokens. Split from engine.test.ts so its parts run side by side (queue TS2).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers, type StepDef } from "@nexus/protocol";
import { Engine, type EngineOptions } from "../src/engine.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";
import { tempDir } from "./temp-dirs.ts";
import { QUICK_ENGINE, WAIT_MS, until as waitUntil } from "./wait.ts";

export const here = dirname(fileURLToPath(import.meta.url));
export const WINDOW = { claude: 1000, codex: 2000 } as const;

/**
 * Short retries, usage margins and the engine's own waits, so the tests wait milliseconds where the server waits
 * minutes; the fake runtimes as processes of their own (for the tests of real processes, scripts/real-process-tests.ts).
 */
export const REAL_PROCESSES: EngineOptions = { retryBaseMs: 30, usageMarginMs: 100, ...QUICK_ENGINE };

/** REAL_PROCESSES with the fake runtimes in the test's own process (in-process-runtime.ts): every other engine test. */
export const FAST: EngineOptions = { ...REAL_PROCESSES, spawn: inProcessRuntime() };

export function setup(behaviours: string[], options: EngineOptions = FAST) {
  const root = tempDir("nexus-engine-");
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

/**
 * A saved file damaged before the next server reads it (queue LCK): a queue's file (run.yaml, plan.yaml, checks.yaml,
 * any other under queues/<queue>/) or a session's runtime.json. `as`: "unparsable" (the default; not YAML or JSON at
 * all) or "schema" (parsed, but not what the schema takes: a file an older server cannot read, as after a rollback).
 */
type Damage = ({ queue: string; file: string } | { session: string; file: "runtime.json" }) & { as?: "unparsable" | "schema" };

const DAMAGED = {
  yaml: { unparsable: "state: [unclosed\n", schema: "protocol: 1\nstate: 42\nsteps: nonsense\n" },
  json: { unparsable: "{ \"state\": ", schema: "{ \"protocol\": 1, \"state\": 42 }\n" },
} as const;

/** Writes each damaged file (Damage); returns their paths, in order. */
function damage(store: ProjectStore, files: Damage[]): string[] {
  return files.map((d) => {
    const path = "queue" in d ? join(store.dir, "queues", d.queue, d.file) : join(store.dir, "sessions", d.session, d.file);
    writeFileSync(path, DAMAGED[d.file.endsWith(".json") ? "json" : "yaml"][d.as ?? "unparsable"]);
    return path;
  });
}

/**
 * The next server on the same files, as after a restart. `corrupt`: files damaged first (damage()), as a server that
 * died mid-write or a rollback to an older schema leaves them.
 */
export function restart(store: ProjectStore, options: EngineOptions = FAST, o: { corrupt?: Damage[] } = {}): Engine {
  if (o.corrupt) damage(store, o.corrupt);
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

