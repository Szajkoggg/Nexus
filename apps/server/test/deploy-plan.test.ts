// Planned deploys (src/deploy-plan.ts, queue PD): a deploy after a step holds the step's queue at that step's end and
// the queue goes on after the restart; a deploy after a queue only once the queue is done; a step waiting for review
// counts once accepted; cancel-plan; a plan dropped (a failed or stopped step, a rejection, a failed update) is told
// to the user and the orchestrator; the hand-over ends the plan so the successor does not deploy again; the plan stays
// across a plain restart. Against a temporary git repository standing in for the server's checkout (a development
// checkout: never moved, never pushed), npm stubbed, a stand-in successor (fake-successor.ts), and the queue engine on
// the fake `claude`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, newId, now, routeAnswers, setStepLevel, writeRegistry, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Lifecycle } from "../src/lifecycle.ts";
import { DeployPlanner, deployPlanFile, judgePlan, readPlanFile } from "../src/deploy-plan.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { serverEnv, spawnServer } from "./helpers.ts";
import { until, LONGER, sleep } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "..", "..", "packages", "cli", "bin", "nexus.js");
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");

/** A git repository standing in for this server's checkout: a development checkout on branch `dev`. */
function repo(base: string) {
  const root = join(base, "checkout");
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "dev");
  writeFileSync(join(root, "package-lock.json"), '{ "lock": 1 }\n');
  git("add", "-A"); git("commit", "-q", "-m", "A: where it runs");
  return root;
}

interface Options { successor?: "ready" | "crash"; busyElsewhere?: () => boolean; orchestrator?: boolean; levels?: Record<string, number> }

/**
 * Project p with queue Q (`behaviours`, one step each), its engine wired to a planner as main.ts does, and a Lifecycle
 * around it. Everything the server would do outside (push notifications, the process's exit) is recorded.
 */
function setup(behaviours: string[], o: Options = {}) {
  const base = mkdtempSync(join(tmpdir(), "nexus-plan-"));
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  process.env.FAKE_SUCCESSOR = o.successor ?? "ready";
  process.env.FAKE_READY_MS = "200";
  const checkout = repo(base);
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const steps: StepDef[] = behaviours.map((b, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], history: [] });
  approveQueue(store, "Q");
  for (const [step, level] of Object.entries(o.levels ?? {})) setStepLevel(store, "Q", step, level as 1 | 2 | 3);

  const pushed: { title: string; body: string }[] = [];
  const drains: string[][] = []; // the step statuses of Q at each drain: when the update started
  let exited = false;
  let orchestrator: Orchestrator | undefined;
  const tick = () => {
    routeAnswers(store); acceptReviews(store);
    planner.check("p", loadProjectState(store)); // as main.ts: before the engine goes on
    orchestrator?.onChange(loadProjectState(store));
    engine.onChange(loadProjectState(store));
  };
  let engine: Engine = new Engine(store, tick, { boundary: (q, step, state) => planner.atBoundary("p", q, step, state) });
  const parts = () => [
    { id: "p", idle: () => engine.idle(), drain: (n: boolean) => { drains.push(queue().steps.map((s) => s.status)); return engine.drainForUpdate(n); }, cancel: () => engine.cancelDrain(), shutdown: () => engine.shutdown() },
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
  const newOrchestrator = () => new Orchestrator(store, engine, tick, { plan: () => planner.notice(), update: () => lifecycle.notice() });
  const planner = new DeployPlanner({ lifecycle, state: (id) => (id === "p" ? loadProjectState(store) : undefined), push: (n) => pushed.push(n) });
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
  const stop = () => { engine.shutdown(); orchestrator?.shutdown(); for (const k of ["FAKE_SUCCESSOR", "FAKE_READY_MS", "FAKE_REVIEW_ACCEPT"]) delete process.env[k]; };
  const show = () => `; run: ${JSON.stringify(queue().run)}; steps: ${statuses().join(" ")}; update: ${JSON.stringify(lifecycle.status)}; plan: ${JSON.stringify(readPlanFile())}`;
  return { store, engine: () => engine, lifecycle, planner, queue, statuses, pushed, drains, exited: () => exited, orchestrator: () => orchestrator, stop, show, tick };
}

/** The successor's side, on the same files: a new engine, planner and lifecycle, as main.ts builds them at its start. */
function successor(t: ReturnType<typeof setup>) {
  let engine: Engine;
  const lifecycle = new Lifecycle(() => [{ id: "p", idle: () => engine.idle(), drain: (n) => engine.drainForUpdate(n), cancel: () => engine.cancelDrain(), shutdown: () => engine.shutdown() }], () => {}, { npm: async () => {}, exit: () => {} });
  const planner = new DeployPlanner({ lifecycle, state: () => loadProjectState(t.store) });
  const tick = () => { routeAnswers(t.store); acceptReviews(t.store); planner.check("p", loadProjectState(t.store)); engine.onChange(loadProjectState(t.store)); };
  engine = new Engine(t.store, tick, { boundary: (q, step, state) => planner.atBoundary("p", q, step, state) });
  planner.recover();
  return { engine, lifecycle, planner, tick };
}

const handedOver = (t: ReturnType<typeof setup>) => () => t.exited();

// ---------------------------------------------------------------- after a step

test("a deploy after a step starts at that step's end, the queue opens no next step, and goes on after the restart; the successor does not deploy again", async () => {
  const t = setup(["done", "done", "done"]);
  let next: ReturnType<typeof successor> | undefined;
  try {
    const r = t.planner.set({ after: { project: "p", queue: "Q", step: "Q1" } });
    assert.match(r.text, /a deploy is planned after step Q\/Q1 \(step Q\/Q1 is pending\)/);
    assert.equal(readPlanFile().plan?.after.step, "Q1", "written to the plan file");
    t.engine().start("Q");
    await until("the hand-over", handedOver(t), LONGER.processes, t.show);
    assert.deepEqual(t.drains, [["done", "pending", "pending"]], "the update started right at Q1's end");
    assert.deepEqual(t.statuses(), ["done", "pending", "pending"], "nothing of Q2 slipped in");
    assert.equal(t.queue().run?.resume_after_restart, true, "the queue is held for the restart");
    const f = readPlanFile();
    assert.equal(f.plan, undefined, "the hand-over ended the plan");
    assert.equal(f.ended?.why, "carried-out");
    assert.equal(t.planner.notice(), undefined, "a plan carried out tells nothing of its own");
    t.engine().shutdown();

    next = successor(t);
    assert.equal(next.planner.plan, undefined, "the successor finds no plan");
    await until("the queue to go on and finish", () => t.queue().run?.state === "finished", LONGER.run, t.show);
    assert.deepEqual(t.statuses(), ["done", "done", "done"]);
    assert.equal(next.lifecycle.status.phase, "idle", "the successor does not deploy again");
  } finally { t.stop(); next?.engine.shutdown(); }
});

test("a step waiting for its review counts only once accepted; its queue then holds at that step", async () => {
  const t = setup(["done", "done"], { levels: { Q1: 1 } });
  try {
    t.planner.set({ after: { project: "p", queue: "Q", step: "Q1" } });
    t.engine().start("Q");
    await until("Q1 in review", () => t.queue().steps[0]!.status === "review", LONGER.step, t.show);
    t.tick();
    await sleep(500);
    assert.equal(t.lifecycle.status.phase, "idle", "no update while the step waits for its review");
    assert.match(t.planner.view()?.waiting ?? "", /waits for its review/);
    t.engine().acceptReview("Q", "Q1");
    await until("the hand-over", handedOver(t), LONGER.processes, t.show);
    assert.deepEqual(t.drains, [["done", "pending"]]);
    assert.deepEqual(t.statuses(), ["done", "pending"]);
  } finally { t.stop(); }
});

// ---------------------------------------------------------------- after a queue

test("a deploy after a queue starts only once the queue is done", async () => {
  const t = setup(["done", "done"]);
  try {
    t.planner.set({ after: { project: "p", queue: "Q" } });
    assert.match(t.planner.view()?.waiting ?? "", /queue Q has 2 steps left/);
    t.engine().start("Q");
    await until("the hand-over", handedOver(t), LONGER.processes, t.show);
    assert.deepEqual(t.drains, [["done", "done"]], "the update started when every step was closed, not before");
    assert.equal(readPlanFile().ended?.why, "carried-out");
  } finally { t.stop(); }
});

test("a deploy after a queue does not happen when a step stops: the plan is dropped and the user and the orchestrator are told", async () => {
  const t = setup(["done", "stop"], { orchestrator: true });
  try {
    t.planner.set({ after: { project: "p", queue: "Q" } });
    t.engine().start("Q");
    await until("the plan to be dropped", () => readPlanFile().ended?.why === "dropped", LONGER.run, t.show);
    assert.deepEqual(t.drains, [], "no update started");
    assert.equal(t.lifecycle.status.phase, "idle");
    assert.equal(readPlanFile().plan, undefined);
    assert.match(readPlanFile().ended!.reason, /step Q\/Q2 stopped.*so queue Q is not done/);
    assert.equal(t.pushed.length, 1, "the user's devices are told");
    assert.match(t.pushed[0]!.body, /^No deploy after queue Q: step Q\/Q2 stopped/);
    await until("the orchestrator to be told", () => t.orchestrator()!.view().chat.some((c) => c.from === "nexus" && /The deploy planned after queue Q will not happen/.test(c.text)), LONGER.step);
  } finally { t.stop(); }
});

// ---------------------------------------------------------------- dropped, cancelled, failed

test("a failed or rejected step drops a plan after it; a plan for a step that will not be in is refused", async () => {
  const a = setup(["fail", "done"]);
  try {
    a.planner.set({ after: { project: "p", queue: "Q", step: "Q1" } });
    a.engine().start("Q");
    await until("the plan to be dropped", () => readPlanFile().ended?.why === "dropped", LONGER.run, a.show);
    assert.match(readPlanFile().ended!.reason, /step Q\/Q1 failed/);
    assert.deepEqual(a.drains, []);
    assert.equal(a.pushed.length, 1);
    // Set again now: the step will not be in.
    assert.throws(() => a.planner.set({ after: { project: "p", queue: "Q", step: "Q1" } }), /step Q\/Q1 failed.*no deploy is planned/);
  } finally { a.stop(); }

  const b = setup(["done", "done"], { levels: { Q1: 1 } });
  try {
    b.planner.set({ after: { project: "p", queue: "Q", step: "Q1" } });
    b.engine().start("Q");
    await until("Q1 in review", () => b.queue().steps[0]!.status === "review", LONGER.step, b.show);
    b.engine().rejectStep("Q", "Q1", "not like this");
    b.tick();
    assert.equal(readPlanFile().ended?.why, "dropped");
    assert.match(readPlanFile().ended!.reason, /step Q\/Q1 was rejected/);
    assert.deepEqual(b.drains, []);
  } finally { b.stop(); }

  assert.throws(() => b.planner.set({ after: { project: "p", queue: "X" } }), /no queue X/);
  assert.throws(() => b.planner.set({ after: { project: "p", queue: "Q", step: "Q9" } }), /no step Q9/);
  assert.throws(() => b.planner.set({ after: { project: "nope", queue: "Q" } }), /no project nope/);
});

test("cancel-plan removes a waiting plan, and cancels the drain of one that started its update; the held queue goes on", async () => {
  const a = setup(["done", "done"]);
  try {
    a.planner.set({ after: { project: "p", queue: "Q", step: "Q2" } });
    assert.throws(() => a.planner.set({ after: { project: "p", queue: "Q" } }), /already planned after step Q\/Q2; cancel it first/);
    assert.match(a.planner.cancel(), /the deploy planned after step Q\/Q2 is cancelled$/);
    assert.equal(readPlanFile().plan, undefined);
    assert.equal(readPlanFile().ended?.why, "cancelled");
    assert.throws(() => a.planner.cancel(), /no deploy is planned/);
    a.engine().start("Q");
    await until("the run to finish", () => a.queue().run?.state === "finished", LONGER.run, a.show);
    assert.deepEqual(a.drains, [], "no update");
  } finally { a.stop(); }

  let elsewhere = true; // another project's step runs: the drain waits for it
  const b = setup(["done", "done"], { busyElsewhere: () => elsewhere });
  try {
    b.planner.set({ after: { project: "p", queue: "Q", step: "Q1" } });
    b.engine().start("Q");
    await until("the drain", () => b.lifecycle.status.phase === "draining" && b.lifecycle.status.waiting.includes("other"), LONGER.step, b.show);
    assert.deepEqual(b.statuses(), ["done", "pending"]);
    assert.match(b.planner.cancel(), /the update it started is cancelled, the held queues go on/);
    assert.equal(b.lifecycle.status.phase, "idle");
    await until("the held queue to go on and finish", () => b.queue().run?.state === "finished", LONGER.run, b.show);
    assert.equal(readPlanFile().plan, undefined);
    assert.equal(b.exited(), false);
  } finally { elsewhere = false; b.stop(); }
});

test("an update that fails drops the plan it started; the user is told, and the orchestrator", async () => {
  const t = setup(["done", "done"], { successor: "crash", orchestrator: true });
  try {
    t.planner.set({ after: { project: "p", queue: "Q", step: "Q1" } });
    t.engine().start("Q");
    await until("the update to fail", () => t.lifecycle.status.phase === "failed", LONGER.processes, t.show);
    const f = readPlanFile();
    assert.equal(f.plan, undefined);
    assert.equal(f.ended?.why, "update-failed", "a plan carried to the hand-over turns out failed");
    assert.ok(t.pushed.some((n) => /^Update failed:/.test(n.body)), "the user's devices are told");
    await until("the orchestrator to be told", () => t.orchestrator()!.view().chat.some((c) => c.from === "nexus" && /The deploy planned after step Q\/Q1 started, and the update failed/.test(c.text)), LONGER.step);
    // The held queue goes on (a rollback starts over on the files), and nothing deploys again.
    await until("the queue to finish", () => t.queue().run?.state === "finished", LONGER.processes, t.show);
    assert.equal(t.drains.length, 1);
  } finally { t.stop(); }
});

// ---------------------------------------------------------------- across a restart

test("a plan stays across a plain restart; one whose update never handed over waits again", () => {
  const t = setup(["done", "done"]);
  try {
    t.planner.set({ after: { project: "p", queue: "Q", step: "Q2" } });
    const id = t.planner.plan!.id;
    const again = successor(t);
    assert.equal(again.planner.plan?.id, id, "read from the file by the next server");
    assert.match(again.planner.view()?.waiting ?? "", /step Q\/Q2 is pending/);
    again.engine.shutdown();

    // The server stopped mid-drain: the plan file says started, but no successor took over.
    const f = readPlanFile();
    writeFileSync(deployPlanFile(), JSON.stringify({ ...f, plan: { ...f.plan, started: { at: now(), update: "gone" } } }));
    const third = successor(t);
    assert.equal(third.planner.plan?.id, id);
    assert.equal(third.planner.plan?.started, undefined, "it waits again");
    third.engine.shutdown();
  } finally { t.stop(); }
});

// ---------------------------------------------------------------- the worktree warning, and the judgement itself

test("a plan after a step on a queue's own worktree branch warns that it is in the deploy only once merged", () => {
  const t = setup(["done"]);
  try {
    const q = t.store.readQueue("Q");
    t.store.writeQueue({ ...q, worktree: join(tmpdir(), "wt-q"), branch: "nexus/Q" });
    const r = t.planner.set({ after: { project: "p", queue: "Q", step: "Q1" } });
    assert.match(r.text, /note: queue Q runs on its own worktree branch \(nexus\/Q\): its work is in the deploy only once it is merged into main/);
    assert.match(readPlanFile().plan?.warning ?? "", /merged into main/);
  } finally { t.stop(); }
});

test("a target already in deploys now", async () => {
  const t = setup(["done"]);
  try {
    t.engine().start("Q");
    await until("the run to finish", () => t.queue().run?.state === "finished", LONGER.run, t.show);
    assert.equal(judgePlan({ project: "p", queue: "Q" }, loadProjectState(t.store)).verdict, "in");
    const r = t.planner.set({ after: { project: "p", queue: "Q" } });
    assert.match(r.text, /queue Q is already in: the update starts now/);
    assert.ok(r.update && r.update.phase !== "idle");
    await until("the hand-over", handedOver(t), LONGER.processes, t.show);
  } finally { t.stop(); }
});

// ---------------------------------------------------------------- through the CLI and a real server

test("nexus server update --after plans through the server, status shows the plan, it stays across a restart, cancel-plan ends it", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-plan-cli-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home;
  const root = join(base, "p");
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "One", goal: "FAKE: done", acceptance: [] }], approvals: [], history: [] });
  approveQueue(store, "Q");
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort();
  const env = { ...serverEnv({ NEXUS_HOME: home, NEXUS_PORT: String(port) }), NEXUS_SESSION: "", NEXUS_DIR: store.dir };
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, "server", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const fails = (...args: string[]) => { try { cli(...args); return ""; } catch (e) { return String((e as { stderr: string }).stderr); } };
  let out = "";
  const start = () => {
    out = "";
    const child = spawnServer({ NEXUS_HOME: home, NEXUS_PORT: String(port), NEXUS_LOG: "" }, ["ignore", "pipe", "pipe"]);
    child.stdout!.on("data", (d) => { out += d; });
    child.stderr!.on("data", (d) => { out += d; });
    return child;
  };
  const stopServer = (c: ChildProcess) => { c.kill(); return new Promise((r) => (c.exitCode !== null ? r(null) : c.on("exit", r))); };
  let s = start();
  try {
    await until("the server", () => out.includes("Nexus server on"), LONGER.processes, () => out);
    assert.match(cli("update", "--after", "Q/Q1"), /^ok: a deploy is planned after step Q\/Q1 \(step Q\/Q1 is pending\)/);
    assert.match(fails("update", "--after", "Q"), /a deploy is already planned after step Q\/Q1; cancel it first/);
    assert.match(fails("update", "--after", "Q/Q1", "--now"), /--now goes with an update at once/);
    assert.match(cli("status"), /planned update: after step Q\/Q1 of project p; waiting: step Q\/Q1 is pending/);

    await stopServer(s);
    s = start();
    await until("the server again", () => out.includes("Nexus server on"), LONGER.processes, () => out);
    assert.match(cli("status"), /planned update: after step Q\/Q1 of project p/, "the plan stays across a restart");

    assert.match(cli("cancel-plan"), /^ok: the deploy planned after step Q\/Q1 is cancelled/);
    assert.match(cli("status"), /planned update: none/);
    assert.match(fails("cancel-plan"), /no deploy is planned/);
  } finally { await stopServer(s); }
});
