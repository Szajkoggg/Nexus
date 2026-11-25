// The workers of the native gate tests (queue WHR: worker-cleanup-gate.test.ts, WHR4; worker-cleanup-restart.test.ts,
// WHR5). Worker A runs in a git checkout with a modified tracked file and an untracked one, its steps' processes in
// gate hosts (gated-cleanup.ts, nativeGate): its step's helper (a real process holding a real directory) is the
// process the gate holds End at. Worker B, an independent queue in a normal host, holds its own directory through the
// whole test and is never touched. Only processes these tests started are handled, each by the identity the test
// checked. The test files that use it run the fake runtimes as processes of their own (scripts/real-process-tests.ts).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setStepLevel } from "@nexus/protocol";
import { setup, REAL_PROCESSES } from "./engine-setup.ts";
import { gatedCleanup, nativeGate } from "./gated-cleanup.ts";
import { LONGER, until } from "./wait.ts";

export type Runtime = "claude" | "codex";
export const RUNTIMES: Runtime[] = ["claude", "codex"];
export const windows = { skip: process.platform !== "win32" };

/** Whether a process the test started still runs (Node's signal-0 probe: it cannot see a DACL-denied helper). */
export function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
/**
 * Whether a helper still holds `dir`: an unheld (empty) directory is removed by the probe (and is then free). A helper
 * whose exit Node already sees may hold it a moment longer (its exit code is set before its handles are closed): a test
 * waits for the directory, not only for the process.
 */
export const isLocked = (dir: string) => { try { rmdirSync(dir); return false; } catch (e) { const c = (e as NodeJS.ErrnoException).code; if (c === "ENOENT") return false; if (c === "EBUSY" || c === "EPERM") return true; throw e; } };
export const locked = (dir: string) => assert.ok(isLocked(dir), `${dir} is held`);

/** Worker B: an independent queue whose helper holds its own directory through the whole test, in a normal host. */
export async function workerB(runtime: Runtime) {
  const b = setup(["ownedhold"], REAL_PROCESSES);
  const log = process.env.FAKE_LOG!;
  process.env.FAKE_RELEASE = join(dirname(log), "release");
  const end = async () => {
    writeFileSync(`${log}.helper-Q1.release`, "");
    b.engine.shutdown();
    await until("B's host exit", () => !b.engine.alive(), LONGER.processes);
  };
  try {
    b.engine.start("Q", { runtime });
    await until("B's helper ready", () => existsSync(`${log}.helper-Q1`), LONGER.step);
    const dir = join(dirname(log), ".owned-Q1");
    locked(dir);
    return { dir, pid: Number(readFileSync(`${log}.helper-Q1`, "utf8")), end };
  } catch (error) { await end(); throw error; }
}

/**
 * Worker A's project, nothing started: queue Q of `behaviours` in a git checkout with a modified tracked file and an
 * untracked one, its processes (and those of a later server given `cleanups.spawn`) in gate hosts. `level`: Q1's
 * review level (1: the user's review, accepted by the test). `launch` starts it (by default this setup's engine) and
 * names the step's helper to the gate.
 */
export function workerAProject(behaviours: string[], o: { level?: number; refuse?: boolean } = {}) {
  const gate = nativeGate();
  const cleanups = gatedCleanup({ make: gate.make });
  const a = setup(behaviours, { ...REAL_PROCESSES, spawn: cleanups.spawn });
  const log = process.env.FAKE_LOG!, root = dirname(log), release = join(root, "release");
  process.env.FAKE_RELEASE = release;
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore", windowsHide: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".nexus/\nhome/\nfake.log*\nrelease*\n.owned-*/\n");
  writeFileSync(join(root, "tracked.txt"), "committed\n");
  git("add", ".gitignore", "tracked.txt"); git("commit", "-qm", "initial");
  writeFileSync(join(root, "tracked.txt"), "changed, not committed\n");
  writeFileSync(join(root, "untracked.txt"), "never added\n");
  if (o.level) setStepLevel(a.store, "Q", "Q1", o.level);
  const dir = join(root, ".owned-Q1");
  /** Ends what this worker's servers started: the gate opened, the helper and the fakes released, the engines shut down. */
  const ends: (() => Promise<void> | void)[] = [];
  const end = async () => {
    gate.open();
    writeFileSync(`${log}.helper-Q1.release`, "");
    writeFileSync(release, "");
    a.engine.shutdown();
    for (const f of ends) await f();
    await until("A's hosts exit", () => !a.engine.alive() && gate.hosts.every((h) => h.exitCode !== null || h.signalCode !== null), LONGER.processes);
  };
  const openings = (step: string) => a.received().filter((m) => new RegExp(`step ${step} \\(`).test(m.text)).length;
  const session = () => a.store.readRun("Q")!.session;
  const project = {
    ...a, gate, cleanups, dir, root, log, session, openings, ends, end,
    /** Starts the queue (`start`, by default this setup's engine) and waits for its helper; names it to the gate. */
    async launch(runtime: Runtime, start: () => void = () => { a.engine.start("Q", { runtime }); }): Promise<number> {
      let helper: number;
      try {
        start();
        await until("A's helper ready", () => existsSync(`${log}.helper-Q1`), LONGER.step);
        helper = Number(readFileSync(`${log}.helper-Q1`, "utf8"));
      } catch (error) { await end(); throw error; }
      gate.target(helper);
      if (o.refuse !== false) gate.refuse();
      if (!isLocked(dir)) { await end(); assert.fail("A's helper holds its directory"); }
      return helper;
    },
    /** Lets Q1's turn end (the fake reports done); the cleanup follows. */
    finishTurn: () => writeFileSync(`${release}-Q1`, ""),
    /** The helper ends by itself (the held wait's success once opened). */
    releaseHelper: () => writeFileSync(`${log}.helper-Q1.release`, ""),
    runtimeState: () => a.store.readRuntime(session())?.state,
    /** The working content is as the test left it. */
    contentKept() {
      assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "changed, not committed\n");
      assert.equal(readFileSync(join(root, "untracked.txt"), "utf8"), "never added\n");
    },
  };
  return project;
}

/** Worker A started on `runtime` by its setup's engine, its helper named to the gate. */
export async function workerA(runtime: Runtime, behaviours: string[], o: { level?: number; refuse?: boolean } = {}) {
  const a = workerAProject(behaviours, o);
  const helper = await a.launch(runtime);
  return { ...a, helper };
}
export type A = Awaited<ReturnType<typeof workerA>>;

/** Waits for the gate's acknowledgement and checks it names the helper; Q1 reported and durable, Q2 pending, no new turn. */
export async function atGate(a: A, o: { counted?: boolean } = {}): Promise<void> {
  await a.until("End waits at the gate", () => !!a.gate.arrived(), LONGER.step);
  const at = a.gate.arrived()!;
  assert.equal(at.pid, a.helper, "the gate holds the helper the test named");
  assert.ok(alive(a.helper));
  locked(a.dir);
  const q = a.queue();
  assert.equal(["done", "review", "stopped"].includes(q.steps[0]!.status), true, `Q1 reported: ${q.steps[0]!.status}`);
  if (q.steps[1]) assert.equal(q.steps[1].status, "pending");
  assert.equal(a.openings("Q2"), 0, "no turn while the cleanup is held");
  if (o.counted !== false) assert.deepEqual(a.cleanups.calls.map((c) => c.outcome), [undefined], "one cleanup, pending");
}

/** End's calls for the helper, all on the one handle the gate acknowledged, closed once, last. */
export function sameHandle(a: A, waits: string[]): void {
  const h = a.gate.arrived()!.handle, pid = a.helper;
  assert.deepEqual(a.gate.calls().slice(0, 7), [
    `OpenProcess ${pid} ${h}`, `IsProcessInJob ${h} True True`, `WaitForSingleObject ${h} 0 258`,
    `TerminateProcess ${h} injected false 5`, `held ${h}`, ...waits.map((w) => `WaitForSingleObject ${h} 2000 ${w}`), `CloseHandle ${h}`,
  ].slice(0, 7));
}

export const FAILED = /worker process cleanup failed: .*TerminateProcess did not complete/;
