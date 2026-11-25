// H2 and H7 of the LWH survey (queue WHR, WHR5): a server's restart while a worker's cleanup is held inside the native
// phase, and the runtime record the next server starts from. The worker's processes run in real job hosts compiled
// with the test's gate (worker-gate-fixture.ts): End has opened and checked the handle of the step's helper and waits
// at AwaitExit's 2000 ms wait; the helper's TerminateProcess returns false/5 (injected), so the wait's success is the
// helper ending by itself, its failure the helper living on. What meets the held wait: an update's hand-over (the
// drain, then the old server's shutdown, as main.ts's release does), the server's own shutdown, its sudden death (a
// server process of the test's own killed by its handle, crash-server.ts), a runtime crash (the gate host ends its
// runtime by its own Process object) and a restart for changed process settings. The next server is a new engine on a
// new store of the same files: it knows only what is on disk.
//
// Today's rules these tests hold to (engine.ts, recoverAfterRestart; docs/design/updates.md): a plain restart pauses a
// running run ("the Nexus server restarted; resume to continue"), a run an update held goes on by itself; a Windows
// worker's recorded PID is no ownership evidence and is never ended (its job closes with its host); a cleanup's late
// outcome is dropped by a server that has stopped, or by one that no longer holds the process (cleanWorker). LCR's
// tests of the same states without a cleanup are not repeated here: crash-recovery.test.ts (a server dying at start-up
// checkpoints, LC-F3) and partner-recovery.test.ts (the record matrix for partners, LC-F5/F9); this file adds the
// cleanup's interruption: the old job's end before any new process, the held run's state kept, the work done once.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, type RuntimeFile } from "@nexus/protocol";
import { crashAt, endCrashServers } from "./crash-server.ts";
import { REAL_PROCESSES, fixtureRun, restart } from "./engine-setup.ts";
import { fakeStarts } from "./fake-behaviour.ts";
import { LONGER, holds, until } from "./wait.ts";
import { alive, atGate, isLocked, locked, sameHandle, windows, workerA, workerAProject, workerB, type A } from "./worker-gate-fixture.ts";

// The fake runtimes as processes of their own (scripts/real-process-tests.ts).
process.env.NEXUS_CLAUDE = fileURLToPath(new URL("./fake-claude.ts", import.meta.url));
process.env.NEXUS_CODEX = fileURLToPath(new URL("./fake-codex.ts", import.meta.url));

const PLAIN_RESTART = "the Nexus server restarted; resume to continue";

after(async () => { assert.equal(await endCrashServers(), 0, "every server the tests started was ended by its test"); });

/** The next server on the files: a new store and engine, its processes in gate hosts counted as before; ended with A. */
function nextServer(a: Pick<A, "root" | "cleanups" | "ends">) {
  const store = ProjectStore.forRoot(a.root);
  const engine = restart(store, { ...REAL_PROCESSES, spawn: a.cleanups.spawn });
  a.ends.push(async () => { engine.shutdown(); await until("the next server's processes exit", () => !engine.alive(), LONGER.processes); });
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  return { store, engine, queue, run: () => queue().run };
}

/** Two control queues in A's project, paused and halted, each in a worktree of its own: no restart may touch them. */
function controls(a: Pick<A, "store">) {
  fixtureRun(a.store, "P", "paused", "paused by the user");
  fixtureRun(a.store, "H", "halted", "a halt of its own");
  const read = () => [a.store.readRun("P"), a.store.readRun("H")];
  const before = read();
  return { unchanged: (what: string) => assert.deepEqual(read(), before, `the paused and halted queues ${what}`) };
}

/** The server's own shutdown at the held wait: its processes outlive it while the cleanup is held (K is read after C). */
async function shutdownAtGate(a: A): Promise<void> {
  a.engine.shutdown();
  await holds("the old processes live on while the cleanup is held", () => a.engine.alive() && alive(a.helper) && isLocked(a.dir), 300);
}

/** Opens the gate (after letting the helper end, for a success) and waits for the old server's processes and job to end. */
async function oldEnds(a: A, outcome: "success" | "failure"): Promise<void> {
  if (outcome === "success") a.releaseHelper();
  a.gate.open();
  await until("the old server's processes end", () => !a.engine.alive(), LONGER.processes);
  await until("the old job's members end", () => !alive(a.helper), LONGER.processes);
  await until("the directory is free before any next server", () => !isLocked(a.dir), LONGER.processes);
  assert.equal(a.cleanups.calls[0]!.outcome, outcome === "success" ? "done" : "failed");
  sameHandle(a, [outcome === "success" ? "0" : "258"]);
}

/** Every gate host started after the earlier ones had exited: never a new process beside the old job. */
function noOverlap(a: A, hosts: number): void {
  assert.equal(a.gate.hosts.length, hosts, "gate hosts started");
  assert.deepEqual(a.gate.overlaps, a.gate.overlaps.map(() => 0), "no host started while an earlier one ran");
}

/** The run, Q1 not repeated and Q2 once, A's content and worker B as they were. */
function workDoneOnce(a: A, b: { dir: string; pid: number }, q2 = 1): void {
  assert.equal(a.openings("Q1"), 1, "Q1 not repeated");
  assert.equal(a.openings("Q2"), q2, `Q2 ${q2 === 1 ? "once" : `${q2} times`}`);
  a.contentKept();
  locked(b.dir);
  assert.ok(alive(b.pid), "worker B untouched");
}

// ---------------------------------------------------------------- H2: an update's hand-over

for (const [runtime, outcome] of [["claude", "success"], ["codex", "failure"]] as const) {
  test(`${runtime}: an update's hand-over at the held wait, then its ${outcome}: the drain holds the run without waiting for the cleanup; the old processes end after it and its outcome writes nothing; the next server resumes by itself, Q1 not repeated, Q2 once in a host started after the old one ended`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      a.finishTurn();
      await atGate(a);
      assert.deepEqual(a.engine.drainForUpdate(false), ["Q"], "the update holds the run");
      const heldRun = a.store.readRun("Q")!;
      assert.deepEqual([heldRun.state, heldRun.resume_after_restart], ["paused", true]);
      assert.equal(a.engine.idle(), true, "today's rule: a held cleanup is no turn, the drain does not wait for it");
      await shutdownAtGate(a);
      await oldEnds(a, outcome);
      assert.deepEqual(a.store.readRun("Q"), heldRun, "the late outcome of the stopped server's cleanup wrote nothing");
      const n = nextServer(a);
      assert.deepEqual([n.run()?.state, n.run()?.resume_after_restart, n.run()?.reason], ["paused", true, "resuming after the Nexus update"]);
      await until("the queue finishes", () => n.run()?.state === "finished", LONGER.run);
      noOverlap(a, 2);
      workDoneOnce(a, b);
    } finally { await a.end(); await b.end(); }
  });
}

test("claude: an update's hand-over at the held wait while Q1 waits for the user's review: the next server goes on by itself but runs nothing until the acceptance; then Q2 once", windows, async () => {
  const b = await workerB("claude");
  const a = await workerA("claude", ["ownedholdshared", "done"], { level: 1 }).catch(async (e: unknown) => { await b.end(); throw e; });
  try {
    a.finishTurn();
    await atGate(a);
    assert.equal(a.queue().steps[0]!.status, "review");
    a.engine.drainForUpdate(false);
    await shutdownAtGate(a);
    await oldEnds(a, "success");
    const n = nextServer(a);
    await until("the held run goes on by itself", () => !n.run()?.resume_after_restart, LONGER.step);
    // The resumed run has its session's process again (idle, in a new host); no turn before the acceptance.
    await holds("nothing runs before the review's acceptance", () => a.openings("Q2") === 0 && n.queue().steps[0]!.status === "review" && a.gate.hosts.length <= 2, 500);
    assert.equal(a.received().length, 1, "only Q1's opening was ever sent");
    n.engine.acceptReview("Q", "Q1");
    await until("the queue finishes", () => n.run()?.state === "finished", LONGER.run);
    noOverlap(a, 2);
    workDoneOnce(a, b);
  } finally { await a.end(); await b.end(); }
});

test("codex: every step done, an update's hand-over at the held wait: the next server finishes the run and starts no process", windows, async () => {
  const b = await workerB("codex");
  const a = await workerA("codex", ["ownedholdshared"]).catch(async (e: unknown) => { await b.end(); throw e; });
  try {
    a.finishTurn();
    await atGate(a);
    a.engine.drainForUpdate(false);
    await shutdownAtGate(a);
    await oldEnds(a, "success");
    const n = nextServer(a);
    assert.equal(n.run()?.state, "finished", "the run is over: its last step was done");
    await holds("no process starts", () => a.gate.hosts.length === 1 && n.run()?.state === "finished", 500);
    assert.equal(a.openings("Q1"), 1);
    a.contentKept();
    locked(b.dir);
  } finally { await a.end(); await b.end(); }
});

// ---------------------------------------------------------------- H2: the server's own shutdown and its sudden death

for (const [runtime, outcome] of [["codex", "success"], ["claude", "failure"]] as const) {
  test(`${runtime}: the server shuts down at the held wait, then its ${outcome}: the old processes end after it and its outcome writes nothing; the next server pauses the run (a plain restart) and starts nothing; Resume runs Q2 once; the paused and halted queues untouched`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      const c = controls(a);
      a.finishTurn();
      await atGate(a);
      const before = a.store.readRun("Q");
      assert.equal(before?.state, "running");
      await shutdownAtGate(a);
      await oldEnds(a, outcome);
      assert.deepEqual(a.store.readRun("Q"), before, "the late outcome wrote nothing");
      const n = nextServer(a);
      assert.deepEqual([n.run()?.state, n.run()?.reason, n.run()?.resume_after_restart], ["paused", PLAIN_RESTART, undefined]);
      assert.equal(n.store.readRuntime(n.run()!.session)?.state, "exited");
      await holds("a plain restart starts nothing", () => a.gate.hosts.length === 1 && n.run()?.state === "paused", 500);
      c.unchanged("after the restart");
      n.engine.resume("Q");
      await until("the queue finishes", () => n.run()?.state === "finished", LONGER.run);
      noOverlap(a, 2);
      workDoneOnce(a, b);
      c.unchanged("after the Resume");
    } finally { await a.end(); await b.end(); }
  });
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: the server dies at the held wait (killed by its handle): the old job ends with it, before the gate opens; the next server pauses the run, its stale record ends nothing; Resume runs Q2 once; the paused and halted queues untouched`, windows, async () => {
    const b = await workerB(runtime);
    const a = workerAProject(["ownedholdshared", "done"]);
    a.engine.shutdown(); // the setup's engine is not the server under test
    try {
      const c = controls(a);
      const crash = crashAt({ root: a.root, does: "start", runtime, point: "native-gate", gate: a.gate.dir }, () => {
        const q = a.queue();
        assert.deepEqual(q.steps.map((s) => s.status), ["done", "pending"]);
        locked(a.dir);
      });
      crash.catch(() => {});
      const helper = await a.launch(runtime, () => {});
      a.finishTurn();
      const { held, exit } = await crash;
      assert.equal(held.point, "native-gate");
      assert.deepEqual(exit, { code: null, signal: "SIGTERM" }, "killed where it stood");
      assert.equal(a.gate.arrived()?.pid, helper);
      await until("the OS ends the old job with its server", () => !alive(helper), LONGER.processes);
      await until("the directory is free before any next server", () => !isLocked(a.dir), LONGER.processes);
      assert.equal(a.gate.calls().at(-1), `held ${a.gate.arrived()!.handle}`, "the held End never returned: the job's close ended its members");
      const session = a.store.readRun("Q")!.session;
      const left = a.store.readRuntime(session)!;
      assert.equal(a.store.readRun("Q")?.state, "running");
      assert.ok(left.state !== "exited" && left.pid! > 0, "the dead server left its record as it was");
      const n = nextServer(a);
      assert.deepEqual([n.run()?.state, n.run()?.reason], ["paused", PLAIN_RESTART]);
      assert.equal(n.store.readRuntime(session)?.state, "exited");
      await holds("a plain restart starts nothing", () => a.gate.hosts.length === 0 && n.run()?.state === "paused", 500);
      c.unchanged("after the restart");
      n.engine.resume("Q");
      await until("the queue finishes", () => n.run()?.state === "finished", LONGER.run);
      noOverlap({ ...a, helper } as A, 1);
      workDoneOnce({ ...a, helper } as A, b);
      c.unchanged("after the Resume");
    } finally { await a.end(); await b.end(); }
  });
}

// ---------------------------------------------------------------- H2: a runtime crash and a settings restart

// A runtime crash under the held cleanup. The fake runtime keeps its children in Node's own kill-on-close job (libuv),
// so its end ends the step's helper too (on a busy machine later than the 2000 ms wait: the test opens the gate once
// the helper has ended) and the held wait succeeds: a failing wait after a runtime crash cannot be made with these
// fakes. The host's monitor reports the runtime's exit (X, then the host's own end) only once the cleanup's lock is
// free, and the control thread sends C after it has released that lock: two threads race. Today's two outcomes, both
// pinned (an observation of WHR5, not changed): C first, and the engine, told the cleanup succeeded, opens Q2 in the
// process whose runtime is gone, that turn fails as "process exited" and is retried once in a new process; or the
// host ends first, the cleanup fails as "worker job host exited" and the engine takes it as the process's exit (as a
// host's loss, worker-cleanup-gate.test.ts) and opens Q2 once in a new process. Either way the work is done once and
// nothing runs beside the old job.
for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: the runtime crashes at the held wait (its helper ends with it): its exit reaches the engine only after the cleanup's success; Q2 runs once in a host started after the old one ended (retried once when C came first); Q1 not repeated`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      a.finishTurn();
      await atGate(a);
      const runtimePid = a.store.readRuntime(a.session())!.pid;
      a.gate.crashRuntime();
      await until("the runtime is ended", () => !!a.gate.crashed(), LONGER.step);
      assert.equal(a.gate.crashed()!.pid, runtimePid, "the runtime the record names");
      // The helper's end follows the runtime's (Node's job) but may take longer than the 2000 ms wait on a busy machine:
      // the test lets the wait go on once it has ended, so the wait's success is what is tested.
      await until("the helper ends with its runtime", () => !alive(a.helper), LONGER.processes);
      await holds("the exit is not reported while the cleanup is held", () => a.runtimeState() !== "exited" && a.openings("Q2") === 0 && a.gate.hosts.length === 1, 300);
      a.gate.open();
      await until("the queue finishes", () => a.queue().run?.state === "finished", LONGER.run);
      const h = a.gate.arrived()!.handle;
      assert.deepEqual(a.gate.calls().slice(4, 8), [`held ${h}`, `runtime killed ${runtimePid}`, `WaitForSingleObject ${h} 2000 0`, `CloseHandle ${h}`], "the runtime ended at the held wait; the wait on the same handle then succeeds");
      assert.equal(alive(a.helper), false);
      const activity = a.store.readActivity(a.session()).entries;
      const opened = activity.filter((e) => e.kind === "turn_start" && e.text.startsWith("Nexus opened step Q2")).map((e) => e.text);
      const retries = activity.filter((e) => e.kind === "retry");
      if (a.cleanups.calls[0]!.outcome === "done") {
        assert.deepEqual(opened, ["Nexus opened step Q2", "Nexus opened step Q2 (continue)"], "C first: Q2 opened in the dead process, then once more");
        assert.equal(retries.length, 1, "one retry");
        assert.match(retries[0]!.text, /processExited/);
      } else {
        assert.equal(a.cleanups.calls[0]!.outcome, "failed", "the host ended first: its cleanup failed with it");
        assert.deepEqual(opened, ["Nexus opened step Q2"], "the host's end is the process's exit: Q2 opened once, in a new process");
        assert.equal(retries.length, 0);
      }
      noOverlap(a, 2);
      workDoneOnce(a, b);
    } finally { await a.end(); await b.end(); }
  });
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: the process settings change at the held wait: nothing restarts while it is held; after its success the old process ends first, then Q2 runs once in a new host`, windows, async () => {
    const b = await workerB(runtime);
    const a = await workerA(runtime, ["ownedholdshared", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
    try {
      a.finishTurn();
      await atGate(a);
      if (runtime === "claude") a.store.updateProject((p) => ({ ...p, runtimes: { ...p.runtimes, claude: { ...p.runtimes.claude, allowed_tools: ["Edit"] } } }));
      else a.store.updateProject((p) => ({ ...p, runtimes: { ...p.runtimes, codex: { ...p.runtimes.codex, approval_policy: "on-request", approvals_reviewer: "auto_review" } } }));
      a.engine.onChange(loadProjectState(a.store));
      await holds("nothing restarts while the cleanup is held", () => a.gate.hosts.length === 1 && a.openings("Q2") === 0 && alive(a.helper), 300);
      a.releaseHelper();
      a.gate.open();
      await until("the queue finishes", () => a.queue().run?.state === "finished", LONGER.run);
      assert.equal(a.cleanups.calls[0]!.outcome, "done");
      assert.ok(a.store.readActivity(a.session()).entries.some((e) => e.text.includes("restarts the session's process on the project's changed settings")), "a restart for the settings");
      noOverlap(a, 2);
      workDoneOnce(a, b);
    } finally { await a.end(); await b.end(); }
  });
}

test("claude: Q1 unfinished (its stop condition) and the server shuts down at the held wait: the next server pauses the run; a Resume is refused at once and starts nothing", windows, async () => {
  const b = await workerB("claude");
  const a = await workerA("claude", ["ownedholdsharedstop", "done"]).catch(async (e: unknown) => { await b.end(); throw e; });
  try {
    a.finishTurn();
    await atGate(a);
    assert.equal(a.queue().steps[0]!.status, "stopped");
    await shutdownAtGate(a);
    await oldEnds(a, "success");
    const n = nextServer(a);
    assert.equal(n.run()?.state, "paused");
    assert.throws(() => n.engine.resume("Q"), /stop/i, "a stopped queue is continued, not resumed");
    await holds("nothing starts", () => a.gate.hosts.length === 1 && a.openings("Q2") === 0, 500);
    assert.equal(a.openings("Q1"), 1, "Q1 not reopened");
    a.contentKept();
    locked(b.dir);
  } finally { await a.end(); await b.end(); }
});

// ---------------------------------------------------------------- H7: the record the next server starts from

type Left = "absent" | "legacy" | "stale-working-sentinel" | "idle-no-pid";

/** What the Claude starts after the Resume are, by record and by whether the fake still has the conversation. */
const STARTS: Record<Left, { saved: string[]; unsaved?: string[] }> = {
  absent: { saved: ["--session-id", "--resume"], unsaved: ["--session-id"] },
  legacy: { saved: ["--resume"], unsaved: ["--resume", "--session-id"] },
  "stale-working-sentinel": { saved: ["--resume"] },
  "idle-no-pid": { saved: ["--resume"] },
};

const CASES: [Left, boolean][] = [["absent", true], ["absent", false], ["legacy", true], ["legacy", false], ["stale-working-sentinel", true], ["idle-no-pid", true]];

for (const [record, saved] of CASES) {
  test(`claude: the server shuts down at the held wait; record ${record}, conversation ${saved ? "saved" : "unsaved"}: the next server pauses the run and ends nothing; Resume starts ${STARTS[record][saved ? "saved" : "unsaved"]!.join(" then ")} after the old job's end, Q1 not repeated, Q2 once`, windows, async () => {
    const b = await workerB("claude");
    const a = workerAProject(["ownedholdshared", "done"]);
    process.env.FAKE_ARGS = join(a.root, "args.log");
    const sentinel = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    try {
      const helper = await a.launch("claude");
      const w = { ...a, helper } as A;
      a.finishTurn();
      await atGate(w);
      await shutdownAtGate(w);
      await oldEnds(w, "success");
      const session = a.session();
      const native = a.store.readSession(session).native_id!;
      const starts = fakeStarts().length;
      assert.deepEqual(fakeStarts(), [["--session-id", native]], "one fresh start so far");
      // What a server that ended mid-cleanup may leave, written as the test's fixture.
      const file = join(a.store.sessionDir(session), "runtime.json");
      const base = a.store.readRuntime(session)!;
      const write = (r: RuntimeFile) => a.store.writeRuntime(session, r);
      if (record === "absent") rmSync(file);
      else if (record === "legacy") { const { conversation_saved: _c, ...rest } = base; write({ ...rest, state: "idle" }); }
      else if (record === "stale-working-sentinel") write({ ...base, state: "working", pid: sentinel.pid });
      else { const { pid: _p, ...rest } = base; write({ ...rest, state: "idle" }); }
      if (!saved) {
        const list = join(a.root, "fake-claude-saved.txt");
        writeFileSync(list, readFileSync(list, "utf8").split(/\r?\n/).filter((x) => x && x !== native).map((x) => `${x}\n`).join(""));
      }
      const n = nextServer(a);
      assert.deepEqual([n.run()?.state, n.run()?.reason], ["paused", PLAIN_RESTART]);
      if (record !== "absent") assert.equal(n.store.readRuntime(session)?.state, "exited", "the stale record is closed");
      await holds("a plain restart starts nothing", () => a.gate.hosts.length === 1 && n.run()?.state === "paused", 300);
      n.engine.resume("Q");
      await until("the queue finishes", () => n.run()?.state === "finished", LONGER.run);
      assert.deepEqual(fakeStarts().slice(starts).map((x) => x[0]), STARTS[record][saved ? "saved" : "unsaved"]);
      assert.ok(fakeStarts().every((x) => x[1] === native), "every start names the session's id");
      assert.equal(n.store.readSession(session).native_id, native);
      assert.equal(sentinel.exitCode, null, "the sentinel named by a stale PID lives on");
      assert.ok(alive(sentinel.pid!));
      noOverlap(w, 1 + STARTS[record][saved ? "saved" : "unsaved"]!.length);
      workDoneOnce(w, b);
    } finally {
      sentinel.kill(); // by its own handle
      await a.end(); await b.end();
      delete process.env.FAKE_ARGS;
    }
  });
}
