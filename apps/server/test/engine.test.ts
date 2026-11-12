// The queue engine against fake runtimes (test/fake-claude.ts, test/fake-codex.ts): no model, no tokens. Every
// scenario runs with both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, addNote, answerAsUser, approveQueue, loadProjectState, routeAnswers, runTimes, sendMessage, type StepDef,
} from "@nexus/protocol";
import { Engine, RETRY_LIMIT, type EngineOptions } from "../src/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");
const WINDOW = { claude: 1000, codex: 2000 } as const;

/** Short retries and usage margins, so the tests wait milliseconds where the server waits minutes. */
const FAST: EngineOptions = { retryBaseMs: 30, usageMarginMs: 100 };

function setup(behaviours: string[], options: EngineOptions = FAST) {
  const root = mkdtempSync(join(tmpdir(), "nexus-engine-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const steps: StepDef[] = behaviours.map((b, i) => ({ id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: `FAKE: ${b}`, acceptance: [] }));
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], steps, approvals: [], history: [] });
  approveQueue(store, "Q");
  // The server calls onChange after every file change; here every engine notification does.
  const engine: Engine = new Engine(store, () => { routeAnswers(store); engine.onChange(loadProjectState(store)); }, options);
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; priority: string | null; busy: boolean }) : []);
  const until = async (what: string, pred: () => boolean, ms = 20_000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}; run: ${JSON.stringify(queue().run)}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return { store, engine, queue, received, until };
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: runs a queue to the end and puts each step's notes into its opening turn`, async () => {
    const { store, engine, queue, received, until } = setup(["done", "done"]);
    addNote(store, "Q", "Q2", "Keep the debris as it is.");
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished");
      const q = queue();
      assert.deepEqual(q.steps.map((s) => s.status), ["done", "done"]);
      assert.equal(q.status, "done");
      // The finished run records when it ended, after its last step's outcome.
      const run = q.run!;
      assert.ok(run.ended_at, "a finished run records its finish time");
      assert.ok(run.ended_at >= run.started_at && run.ended_at >= q.steps[1]!.finished_at!);
      assert.equal(runTimes(run, Date.now()).ended, run.ended_at);
      assert.deepEqual(q.steps.map((s) => s.segments.length), [1, 1]);
      const turns = received().filter((m) => m.text.startsWith("[Nexus] Queue"));
      assert.equal(turns.length, 2);
      assert.match(turns[1]!.text, /step Q2 \(2 of 2\)[\s\S]*Keep the debris as it is\./);
      assert.doesNotMatch(turns[0]!.text, /Keep the debris/);
      assert.ok(q.steps[1]!.notes[0]!.read_at, "the note counts as delivered");
      const s = loadProjectState(store).sessions.find((x) => x.id === q.run!.session)!;
      assert.equal(s.live?.context_window, WINDOW[runtime]);
      assert.equal(s.runtime, runtime);
      assert.ok(s.native_id, "the runtime's own session id is recorded");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a turn without an outcome is nudged once, then the run halts`, async () => {
    const { store, engine, queue, received, until } = setup(["noop"]);
    try {
      engine.start("Q", { runtime });
      await until("the run to halt", () => queue().run?.state === "halted");
      assert.match(queue().run!.reason!, /without an outcome/);
      assert.equal(received().filter((m) => m.text.includes("has no outcome yet")).length, 1);
      assert.ok(loadProjectState(store).attention.some((a) => a.kind === "stopped" && a.queue === "Q"));
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a blocking question holds the queue until the answer arrives as the next turn`, async () => {
    const { store, engine, queue, received, until } = setup(["ask", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the question", () => queue().steps[0]!.status === "waiting");
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(queue().run?.state, "running", "waiting on a question is not a halt");
      assert.equal(queue().steps[1]!.status, "pending");
      const qid = loadProjectState(store).questions[0]!.qid;
      answerAsUser(store, qid, "Left.", true);
      engine.onChange(loadProjectState(store));
      await until("the run to finish", () => queue().run?.state === "finished");
      const answer = received().find((m) => m.text.startsWith("[Nexus] Answer"));
      assert.ok(answer);
      assert.match(answer.text, /Left\./);
      assert.equal(answer.priority, null, "an idle session gets the answer as a turn");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a message reaches a working turn as 'next', without interrupting it`, async () => {
    process.env.FAKE_SLOW_MS = "2500";
    const { store, engine, queue, received, until } = setup(["slow"]);
    try {
      engine.start("Q", { runtime });
      await until("the step to run", () => queue().steps[0]!.status === "running");
      sendMessage(store, queue().run!.session, "Use the grassland settings.", { queue: "Q", step: "Q1" });
      engine.onChange(loadProjectState(store));
      await until("the run to finish", () => queue().run?.state === "finished");
      const m = received().find((x) => x.text.includes("grassland"));
      assert.deepEqual([m?.priority, m?.busy], ["next", true]);
      assert.ok(queue().steps[0]!.messages[0]!.read_at, "the message counts as delivered");
    } finally { engine.shutdown(); delete process.env.FAKE_SLOW_MS; }
  });

  test(`${runtime}: a stop condition halts the run and the queue`, async () => {
    const { engine, queue, until } = setup(["stop", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the run to halt", () => queue().run?.state === "halted");
      assert.equal(queue().status, "stopped");
      assert.ok(queue().run!.ended_at, "a halted run records when it halted");
      assert.equal(queue().steps[1]!.status, "pending");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: pause takes effect after the running step; resume goes on`, async () => {
    process.env.FAKE_SLOW_MS = "1500";
    const { engine, queue, until } = setup(["slow", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the step to run", () => queue().steps[0]!.status === "running");
      engine.pause("Q");
      assert.equal(queue().run?.state, "pausing");
      await until("the pause", () => queue().run?.state === "paused");
      assert.deepEqual(queue().steps.map((s) => s.status), ["done", "pending"]);
      const paused = queue().run!.ended_at;
      assert.ok(paused, "a paused run records when it stopped going");
      engine.resume("Q");
      assert.equal(queue().run!.ended_at, undefined, "going on clears it");
      await until("the run to finish", () => queue().run?.state === "finished");
      assert.ok(queue().run!.ended_at! > paused);
    } finally { engine.shutdown(); delete process.env.FAKE_SLOW_MS; }
  });
}

test("model and effort reach Claude Code as flags, and are kept on the session", async () => {
  const { store, engine, queue, until } = setup(["done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  try {
    engine.start("Q", { runtime: "claude", model: "sonnet", effort: "high" });
    await until("the run to finish", () => queue().run?.state === "finished");
    const argv = (JSON.parse(readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n")[0]!) as { argv: string[] }).argv;
    assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
    assert.equal(argv[argv.indexOf("--effort") + 1], "high");
    const s = loadProjectState(store).sessions.find((x) => x.id === queue().run!.session)!;
    assert.deepEqual([s.model, s.effort], ["sonnet", "high"]);
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
});

test("Codex gets the effort on every turn and the project's reviewer when the thread starts; Claude Code refuses ultra", async () => {
  const { store, engine, queue, until } = setup(["done", "done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  const p = store.readProject();
  store.writeProject({ ...p, runtimes: { ...p.runtimes, codex: { ...p.runtimes.codex, effort: "medium", approval_policy: "on-request", approvals_reviewer: "auto_review" } } });
  try {
    assert.throws(() => engine.start("Q", { runtime: "claude", effort: "ultra" }), /Claude Code takes effort/);
    engine.start("Q", { runtime: "codex" });
    await until("the run to finish", () => queue().run?.state === "finished");
    const calls = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(calls.filter((c) => c.method === "thread/start").map((c) => [c.approvalPolicy, c.approvalsReviewer]), [["on-request", "auto_review"]]);
    assert.deepEqual(calls.filter((c) => c.method === "turn/start").map((c) => c.effort), ["medium", "medium"]);
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
});

test("Codex in a queue's own worktree may write the worktree's git paths, and no more of the repository's .git", async () => {
  const { store, engine, queue, until } = setup(["done", "done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  const root = store.readProject().root;
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main"); writeFileSync(join(root, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
  store.writeQueue({ ...store.readQueue("Q"), worktree: "auto" });
  try {
    engine.start("Q", { runtime: "codex" });
    await until("the run to finish", () => queue().run?.state === "finished");
    const wt = store.readQueue("Q").worktree!;
    const gitDir = join(root, ".git"), mine = (p: string) => normalize(p).toLowerCase();
    const want = [store.dir, join(gitDir, "worktrees", "Q"), join(gitDir, "objects"), join(gitDir, "refs"), join(gitDir, "logs")].map(mine);
    const calls = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; writableRoots: string[] | null; cwd?: string });
    const start = calls.filter((c) => c.method === "thread/start"), turns = calls.filter((c) => c.method === "turn/start");
    assert.equal(mine(start[0]!.cwd!), mine(wt));
    assert.deepEqual(start.map((c) => c.writableRoots?.map(mine)), [want], "the thread's sandbox config carries the roots");
    assert.deepEqual(turns.map((c) => c.writableRoots?.map(mine)), [want, want], "every turn's sandbox policy carries them");
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
});

test("Codex in the project's own checkout gets no git roots: its .git lies inside it", async () => {
  const { store, engine, queue, until } = setup(["done"]);
  process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
  execFileSync("git", ["init", "-q"], { cwd: store.readProject().root, stdio: "ignore" });
  try {
    engine.start("Q", { runtime: "codex" });
    await until("the run to finish", () => queue().run?.state === "finished");
    const calls = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; writableRoots: string[] | null });
    assert.deepEqual(calls.filter((c) => c.method === "turn/start").map((c) => c.writableRoots), [[]]);
    assert.equal(calls.find((c) => c.method === "thread/start")!.writableRoots, null, "no roots, no sandbox config");
  } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
});

// ---------------------------------------------------------------- failures of a turn

/** The next server on the same files, as after a restart. */
function restart(store: ProjectStore, options: EngineOptions = FAST): Engine {
  const next: Engine = new Engine(store, () => { routeAnswers(store); next.onChange(loadProjectState(store)); }, options);
  return next;
}

const activityOf = (store: ProjectStore, session: string) => store.readActivity(session).entries;

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: a turn that fails twice for a passing reason is tried again, and the queue goes on`, async () => {
    const { store, engine, queue, received, until } = setup(["overloaded2", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished");
      assert.deepEqual(queue().steps.map((s) => s.status), ["done", "done"]);
      assert.equal(queue().run?.retries, undefined, "a turn that ended well clears the count");
      const opened = received().filter((m) => m.text.includes("step Q1 (1 of 2)"));
      assert.equal(opened.length, 3, "the first turn and two retries");
      assert.match(opened[2]!.text, /Continue this step[\s\S]*this is the retry/);
      assert.ok(!received().some((m) => /has no outcome yet/.test(m.text)), "a failed turn is no turn without an outcome");
      const kinds = activityOf(store, queue().run!.session).filter((a) => a.kind === "retry").map((a) => a.text);
      assert.equal(kinds.filter((t) => t.startsWith("Nexus tries")).length, 2);
      assert.ok(kinds.some((t) => !t.startsWith("Nexus tries")), "the runtime's own retries are recorded");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a passing failure that does not pass halts the run after ${RETRY_LIMIT} retries, naming it`, async () => {
    const { engine, queue, received, until } = setup(["overloaded"]);
    try {
      engine.start("Q", { runtime });
      await until("the halt", () => queue().run?.state === "halted");
      assert.match(queue().run!.reason!, new RegExp(`failed ${RETRY_LIMIT + 1} times in a row.*(overloaded|serverOverloaded)`));
      assert.equal(received().filter((m) => m.text.includes("step Q1")).length, RETRY_LIMIT + 1);
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: an authentication failure halts the run at once`, async () => {
    const { store, engine, queue, received, until } = setup(["auth", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the halt", () => queue().run?.state === "halted");
      assert.match(queue().run!.reason!, /authentication_failed|unauthorized/);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(received().length, 1, "no retry and no nudge");
      assert.ok(!activityOf(store, queue().run!.session).some((a) => a.text.startsWith("Nexus tries")));
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a runtime process that crashes mid-turn is tried again on a process that resumes the session`, async () => {
    const { store, engine, queue, until } = setup(["crash1", "done"]);
    process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished");
      const calls = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[]; method?: string; threadId?: string });
      const session = store.readSession(queue().run!.session);
      if (runtime === "claude") {
        const starts = calls.filter((c) => c.argv).map((c) => c.argv!);
        assert.equal(starts.length, 2);
        assert.equal(starts[0]![starts[0]!.indexOf("--session-id") + 1], session.native_id);
        assert.equal(starts[1]![starts[1]!.indexOf("--resume") + 1], session.native_id, "the new process resumes the same session");
      } else {
        assert.deepEqual(calls.filter((c) => c.method === "thread/resume").map((c) => c.threadId), [session.native_id]);
      }
    } finally { engine.shutdown(); delete process.env.FAKE_ARGS; }
  });

  test(`${runtime}: a usage limit with a reset time waits for the window, not for the backoff`, async () => {
    const { engine, queue, until } = setup(["limit1", "done"]);
    try {
      engine.start("Q", { runtime });
      await until("the usage wait", () => queue().run?.state === "usage_wait");
      const run = queue().run!;
      assert.ok(run.resume_at && Date.parse(run.resume_at) > Date.now() - 1000, "it waits for the reset the runtime named");
      assert.equal(run.retries, undefined, "not counted as a retry");
      await until("the run to finish", () => queue().run?.state === "finished");
    } finally { engine.shutdown(); }
  });

  test(`${runtime}: a Nexus shutdown is not retried and does not halt the run`, async () => {
    process.env.FAKE_SLOW_MS = "5000";
    const { store, engine, queue, until } = setup(["slow"]);
    let next: Engine | undefined;
    try {
      engine.start("Q", { runtime });
      await until("the step to run", () => queue().steps[0]!.status === "running");
      const session = queue().run!.session;
      engine.shutdown();
      await until("the process to exit", () => store.readRuntime(session)?.state === "exited");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(queue().run?.state, "running", "the stopped engine wrote nothing");
      next = restart(store);
      assert.equal(queue().run?.state, "paused");
      assert.match(queue().run!.reason!, /restarted/);
    } finally { engine.shutdown(); next?.shutdown(); delete process.env.FAKE_SLOW_MS; }
  });

  test(`${runtime}: a retry pending at an update's restart is made after it`, async () => {
    const { store, engine, queue, until } = setup(["overloaded1", "done"], { retryBaseMs: 1500, usageMarginMs: 100 });
    let next: Engine | undefined;
    try {
      engine.start("Q", { runtime });
      await until("the retry wait", () => queue().run?.state === "retry_wait");
      assert.deepEqual(engine.drainForUpdate(false), ["Q"], "held like a running queue");
      assert.equal(queue().run?.resume_after_restart, true);
      assert.ok(engine.idle());
      engine.shutdown();
      next = restart(store, { retryBaseMs: 1500, usageMarginMs: 100 });
      assert.equal(queue().run?.state, "retry_wait", "it still waits for its retry");
      await until("the run to finish", () => queue().run?.state === "finished");
      assert.deepEqual(queue().steps.map((s) => s.status), ["done", "done"]);
    } finally { engine.shutdown(); next?.shutdown(); }
  });
}

test("a pause or a stop by the user cancels a pending retry", async () => {
  for (const action of ["pause", "stop"] as const) {
    const { engine, queue, until } = setup(["overloaded1", "done"], { retryBaseMs: 600, usageMarginMs: 100 });
    try {
      engine.start("Q");
      await until("the retry wait", () => queue().run?.state === "retry_wait");
      if (action === "pause") engine.pause("Q"); else engine.stopNow("Q");
      assert.equal(queue().run?.state, "paused");
      assert.equal(queue().run?.resume_at, undefined);
      await new Promise((r) => setTimeout(r, 900));
      assert.equal(queue().run?.state, "paused", `no retry after a ${action}`);
    } finally { engine.shutdown(); }
  }
});

/**
 * The N2C case: an update holds a run at the end of its step, and the hand-over stops the agent right after the turn
 * ends (before the engine has looked at the step). The stop is no failure: the run is not halted, and the next server
 * finishes it, or goes on with the step left.
 */
for (const behaviours of [["slow"], ["slow", "done"]]) {
  test(`an update's hand-over right after the last turn of a step: the run ${behaviours.length === 1 ? "ends finished" : "resumes"}`, async () => {
    process.env.FAKE_SLOW_MS = "1000";
    const { store, engine, queue, until } = setup(behaviours);
    let next: Engine | undefined;
    try {
      engine.start("Q");
      await until("the step to run", () => queue().steps[0]!.status === "running");
      engine.drainForUpdate(false);
      for (const t = Date.now(); !engine.idle() && Date.now() - t < 10_000;) await new Promise((r) => setTimeout(r, 5));
      assert.equal(queue().run?.state, "pausing", "caught before the engine's own look at the ended turn");
      engine.shutdown(); // the hand-over
      const session = queue().run!.session;
      await until("the process to exit", () => store.readRuntime(session)?.state === "exited");
      assert.notEqual(queue().run?.state, "halted");
      next = restart(store);
      await until("the run to finish", () => queue().run?.state === "finished");
      assert.ok(queue().steps.every((s) => s.status === "done"));
      assert.equal(queue().run?.resume_after_restart, undefined);
    } finally { engine.shutdown(); next?.shutdown(); delete process.env.FAKE_SLOW_MS; }
  });
}

test("an unapproved revision cannot start", () => {
  const { store, engine } = setup(["done"]);
  const q = store.readQueue("Q");
  store.writeQueue({ ...q, steps: [...q.steps, { id: "Q9", title: "Added", goal: "", acceptance: [] }] });
  assert.throws(() => engine.start("Q"), /approve/);
  engine.shutdown();
});

// ---------------------------------------------------------------- updates of Nexus itself

/** A queue's run, written as a test fixture. */
function fixtureRun(store: ProjectStore, id: string, state: "paused" | "halted", reason: string) {
  store.writeQueue({ protocol: 1, id, title: id, revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: `${id}1`, title: "x", goal: "FAKE: done", acceptance: [] }], approvals: [], history: [] });
  approveQueue(store, id);
  store.writeSession({ protocol: 1, id: `s-${id}`, project: "p", role: "worker", runtime: "claude", native_id: "00000000-0000-4000-8000-000000000000", cwd: store.dir, launched_by: "nexus", created_at: new Date().toISOString() });
  const t = new Date().toISOString();
  store.writeRun(id, { protocol: 1, session: `s-${id}`, state, reason, started_at: t, updated_at: t });
}

test("an update holds a running queue at its step's end; the next server resumes it, and only it", async () => {
  process.env.FAKE_SLOW_MS = "1500";
  const { store, engine, queue, until } = setup(["slow", "done"]);
  fixtureRun(store, "R", "paused", "paused by the user");
  fixtureRun(store, "H", "halted", "fake condition: fake stop");
  let next: Engine | undefined;
  try {
    engine.start("Q");
    await until("the step to run", () => queue().steps[0]!.status === "running");
    assert.deepEqual(engine.drainForUpdate(false), ["Q"]);
    assert.equal(queue().run?.state, "pausing");
    assert.throws(() => engine.start("R"), /updating/);
    await until("the hold", () => queue().run?.state === "paused" && engine.idle());
    assert.deepEqual(queue().steps.map((s) => s.status), ["done", "pending"]);
    engine.shutdown();

    // The restart: a new engine on the same files.
    next = new Engine(store, () => { routeAnswers(store); next!.onChange(loadProjectState(store)); });
    await until("the resumed run to finish", () => queue().run?.state === "finished");
    assert.equal(store.readRun("R")?.state, "paused", "a queue the user paused stays paused");
    assert.equal(store.readRun("H")?.state, "halted", "a halted queue stays halted");
  } finally { engine.shutdown(); next?.shutdown(); delete process.env.FAKE_SLOW_MS; }
});

test("pausing during an update, or a stop condition met, keeps a queue from resuming after the restart", async () => {
  process.env.FAKE_SLOW_MS = "1200";
  const a = setup(["slow", "done"]);
  try {
    a.engine.start("Q");
    await a.until("the step to run", () => a.queue().steps[0]!.status === "running");
    a.engine.drainForUpdate(false);
    a.engine.pause("Q");
    await a.until("the pause", () => a.queue().run?.state === "paused");
    assert.equal(a.queue().run?.resume_after_restart, undefined, "the user's pause wins");
  } finally { a.engine.shutdown(); delete process.env.FAKE_SLOW_MS; }

  const b = setup(["stop", "done"]);
  try {
    b.engine.start("Q");
    b.engine.drainForUpdate(false);
    await b.until("the halt", () => b.queue().run?.state === "halted");
    assert.equal(b.queue().run?.resume_after_restart, undefined, "a stop condition is not undone by a restart");
  } finally { b.engine.shutdown(); }
});

test("a cancelled update lets the held queue go on", async () => {
  process.env.FAKE_SLOW_MS = "1200";
  const { engine, queue, until } = setup(["slow", "done"]);
  try {
    engine.start("Q");
    await until("the step to run", () => queue().steps[0]!.status === "running");
    engine.drainForUpdate(false);
    engine.cancelDrain();
    assert.equal(queue().run?.state, "running");
    await until("the run to finish", () => queue().run?.state === "finished");
  } finally { engine.shutdown(); delete process.env.FAKE_SLOW_MS; }
});

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: an agent that exits after the last step.done finishes the run: no retry, no new process, nothing waits`, async () => {
    const { store, engine, queue, until } = setup(["done", "doneexit"]);
    process.env.FAKE_ARGS = join(dirname(process.env.FAKE_LOG!), "args.log");
    const seen = new Set<string>();
    const watch = setInterval(() => { const s = store.readRun("Q")?.state; if (s) seen.add(s); }, 20);
    try {
      engine.start("Q", { runtime });
      await until("the run to finish", () => queue().run?.state === "finished");
      await new Promise((r) => setTimeout(r, 1500)); // time enough for a retry or a new process, were there one
      const q = queue();
      assert.equal(q.status, "done");
      assert.equal(q.run?.state, "finished");
      assert.ok(!seen.has("retry_wait") && !seen.has("halted"), `states seen: ${[...seen].join(", ")}`);
      const starts = readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[]; method?: string })
        .filter((a) => a.argv || a.method === "thread/start" || a.method === "thread/resume");
      assert.equal(starts.length, 1, "one process start");
      assert.deepEqual(loadProjectState(store).attention, [], "nothing waits for the user");
      assert.ok(q.run?.ended_at);
    } finally { clearInterval(watch); engine.shutdown(); delete process.env.FAKE_ARGS; }
  });
}
