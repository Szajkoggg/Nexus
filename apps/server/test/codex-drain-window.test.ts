// A Codex process that exits with its stdout held open (queue CXD; LC21 finding 1): from the exit event until stdout
// ends, the adapter reads the process's last lines (codex.ts, EXIT_DRAIN_MS), and a turn's end read then leaves it
// idle although nothing can be sent to it any more. Nothing in that window may send to it: the engine's look after the
// turn and the server's looks at file changes wait for its exit, which is handled as a crash (before the fix the nudge
// threw, the engine's advance caught it, and the run halted with "engine error: the session's process has exited");
// a message to the orchestrator starts a fresh process, as after an exit (before: refused with that error).
// Against the fake: it writes the turn's end through the descendant that holds its stdout, after the exit, once the
// test opens a gate (fake-behaviour.ts, exitHeld), so the window is open when the turn ends whatever the machine's load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectStore, loadProjectState, routeAnswers } from "@nexus/protocol";
import type { Launch } from "../src/agent-host.ts";
import { CodexSession, type CodexOptions } from "../src/codex.ts";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { FAST, activityOf, setup } from "./engine-setup.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { QUICK_ENGINE, LONGER, WAIT_MS, sleep, until as waitUntil } from "./wait.ts";

// The fake runtimes as processes of their own (scripts/real-process-tests.ts).
process.env.NEXUS_CLAUDE = fileURLToPath(new URL("./fake-claude.ts", import.meta.url));
process.env.NEXUS_CODEX = fileURLToPath(new URL("./fake-codex.ts", import.meta.url));

/** Long past every wait here: the window ends when the fake's held stdout does, not by the adapter's limit. */
const DRAIN_MS = 60_000;
/** How long the fake's descendant holds stdout after it wrote the turn's end. */
const HOLD_MS = 3000;

/** Makes Codex processes that keep their stdout's drain open, recorded in `made`, without a Windows job host. */
function codexMaker(made: CodexSession[]) {
  return (launch: Launch): CodexSession => {
    assert.equal(launch.runtime, "codex");
    // On Windows every agent runs in a job host (worker-job.cs; a worker for its processes, any role for its agent job,
    // queue HG), which ends the job's descendants with the runtime, and its stdout ends with them: the window closes at
    // once. Without it, as on other systems, the descendant holds the pipe and the window stays open.
    const p = new CodexSession({ ...(launch.options as CodexOptions), ownProcesses: false, agentRole: undefined, exitDrainMs: DRAIN_MS });
    made.push(p);
    return p;
  };
}

/** Collects uncaught exceptions while the test runs (a throw from a timer would end the server). */
function catchUncaught(): { thrown: string[]; off: () => void } {
  const thrown: string[] = [];
  const on = (e: Error) => { thrown.push(e.message); };
  process.on("uncaughtException", on);
  return { thrown, off: () => process.off("uncaughtException", on) };
}

/** The fake's exit with stdout held, gated by a file in `dir`; returns the gate's path. */
function holdStdout(dir: string): string {
  const gate = join(dir, "exit-gate");
  process.env.FAKE_CODEX_EXIT_GATE = gate;
  process.env.FAKE_CODEX_HOLD_STDOUT_MS = String(HOLD_MS);
  return gate;
}
/** Opens the gate (a descendant still waiting at it, after a failure, then ends after its hold) and clears the variables. */
function release(gate: string): void {
  writeFileSync(gate, "");
  for (const k of ["FAKE_CODEX_EXIT_GATE", "FAKE_CODEX_HOLD_STDOUT_MS", "FAKE_ARGS", "FAKE_REVIEW_ACCEPT"]) delete process.env[k];
}

/** Waits for the process to exit, then lets its turn's end through and waits for it: read inside the window. */
async function turnEndsInWindow(p: CodexSession, gate: string, ms: number): Promise<void> {
  await waitUntil("the process to exit, its exit not emitted while stdout is held", () => p.exiting, ms);
  const ended = new Promise((r) => p.once("turnEnd", r));
  writeFileSync(gate, "");
  await ended;
  assert.ok(p.exiting && p.state === "idle", "the turn ended inside the window, leaving the process idle");
}

test("codex worker: its process exits after a turn without an outcome, stdout held open; nothing is sent to it in the window, and the run goes on as after a crash (queue CXD)", async () => {
  const uncaught = catchUncaught();
  const made: CodexSession[] = [];
  const { store, engine, queue, received, until } = setup(["noopexit1", "done"], { ...FAST, turnSettleMs: 50, spawn: codexMaker(made) });
  const gate = holdStdout(dirname(process.env.FAKE_LOG!));
  const thrownByChange: string[] = [];
  try {
    engine.start("Q", { runtime: "codex" });
    await until("the first process", () => made.length > 0, LONGER.step);
    const first = made[0]!;
    await turnEndsInWindow(first, gate, LONGER.step);
    // Past the engine's look after the turn (turnSettleMs), and the server's looks at file changes meanwhile.
    for (let i = 0; i < 8; i++) {
      await sleep(40);
      try { engine.onChange(loadProjectState(store)); } catch (e) { thrownByChange.push((e as Error).message); }
    }
    assert.ok(first.exiting, "every look above was inside the window");
    assert.deepEqual(uncaught.thrown, [], "no uncaught exception");
    assert.deepEqual(thrownByChange, [], "engine.onChange does not throw in the window");
    assert.notEqual(queue().run?.state, "halted", `the run does not halt in the window (${queue().run?.reason})`);
    assert.ok(!queue().run?.nudged, "no nudge to the process that has exited");
    await until("the run to finish", () => queue().run?.state === "finished", LONGER.run);
    assert.deepEqual(queue().steps.map((s) => s.status), ["done", "done"]);
    // As after a crash (engine-failures.test.ts, "a runtime process that crashes mid-turn"): the turn is tried again
    // on a new process that resumes the session, and no nudge reached the process that had exited.
    assert.equal(made.length, 2, "a new process for the retry");
    assert.ok(activityOf(store, queue().run!.session).some((a) => a.kind === "retry" && a.text.startsWith("Nexus tries")), "retried as a crash");
    assert.equal(received().filter((m) => m.text.includes("step Q1 (1 of 2)")).length, 2, "the step's turn, and its retry");
    assert.ok(received().filter((m) => m.text.includes("has no outcome yet")).length <= 1, "a nudge at most once");
    assert.deepEqual(uncaught.thrown, []);
  } finally { engine.shutdown(); uncaught.off(); release(gate); }
});

test("codex orchestrator: a message in the drain window starts a fresh process that resumes its thread, as after an exit (queue CXD)", async () => {
  const uncaught = catchUncaught();
  const root = mkdtempSync(join(tmpdir(), "nexus-drain-window-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_ARGS = join(root, "args.log");
  process.env.FAKE_REVIEW_ACCEPT = "1";
  delete process.env.FAKE_LOG;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const p = store.readProject();
  store.writeProject({ ...p, orchestrator: { notify: true, session: null, ...p.orchestrator, runtime: "codex" } });
  const made: CodexSession[] = [];
  const engine: Engine = new Engine(store, () => tick(), QUICK_ENGINE);
  const orchestrator = new Orchestrator(store, engine, () => tick(), {}, { spawn: codexMaker(made) });
  // Stands in for the server's file watcher.
  function tick() { routeAnswers(store); acceptReviews(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(() => { try { tick(); } catch (e) { uncaught.thrown.push(`tick: ${(e as Error).message}`); } }, 50);
  const gate = holdStdout(root);
  const replies = () => orchestrator.view().chat.filter((c) => c.from === "orchestrator" && c.kind !== "tool");
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; chat: ${JSON.stringify(orchestrator.view().chat.slice(-4))}`);
  try {
    orchestrator.say("FAKE-EXIT-HELD hello");
    await until("the first process", () => made.length > 0, LONGER.step);
    const first = made[0]!;
    await turnEndsInWindow(first, gate, LONGER.step);
    await until("its reply", () => replies().some((c) => c.text === "exit reply"));
    let refused: string | undefined;
    try { orchestrator.say("After the exit"); } catch (e) { refused = (e as Error).message; }
    assert.ok(first.exiting, "the message came inside the window");
    assert.equal(refused, undefined, "the message is taken, not refused with the exited process's error");
    await until("the reply to the message", () => replies().length >= 2, LONGER.step);
    assert.equal(made.length, 2, "a fresh process");
    const s = orchestrator.session()!;
    const resumed = readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method?: string; threadId?: string })
      .filter((c) => c.method === "thread/resume").map((c) => c.threadId);
    assert.deepEqual(resumed, [s.native_id], "it resumes the session's thread");
    // The old process's exit, handled after the fresh one started, leaves the session's record to the fresh process.
    await until("the old process's exit", () => first.state === "exited", HOLD_MS + LONGER.step);
    await sleep(100);
    assert.notEqual(store.readRuntime(s.id)?.state, "exited", "the fresh process's record stands");
    assert.notEqual(made[1]!.state, "exited");
    assert.deepEqual(uncaught.thrown, [], "no uncaught exception");
  } finally {
    clearInterval(timer); engine.shutdown(); orchestrator.shutdown(); uncaught.off(); release(gate);
  }
});
