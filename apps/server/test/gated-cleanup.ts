// A shared stand-in for the workers' cleanup barrier (AgentProcess.cleanup, queue LH): the runtimes' fakes as usual,
// with every cleanup counted and passed through a gate a test holds, releases or makes fail. It replaces the one-off
// wrappers (integration-free's slowHosts, worker-processes' held and failing cleanups).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProcess } from "../src/agent.ts";
import type { Launch } from "../src/agent-host.ts";
import { ClaudeSession, type ClaudeOptions } from "../src/claude.ts";
import { CodexSession, type CodexOptions } from "../src/codex.ts";
import { WorkerProcess, type SpawnRuntimeChild, type StartJobHost } from "../src/worker-process.ts";
import { tempDir } from "./temp-dirs.ts";

/** One cleanup asked of a process: whether that process had been sent a turn before, and how it ended (once it has). */
export interface CleanupCall { turned: boolean; outcome?: "done" | "failed" }

export interface GatedCleanup {
  /** Makes the processes (EngineOptions.spawn, AgentHostOptions.spawn). */
  spawn: (launch: Launch) => AgentProcess;
  /** Every cleanup asked so far, in order. */
  calls: CleanupCall[];
  /** How many cleanups wait at the gate now. */
  held(): number;
  /** Closes the gate: cleanups wait until release or fail. */
  hold(): void;
  /** Opens the gate: the waiting cleanups, and later ones, run the runtime's own. */
  release(): void;
  /** The waiting cleanups, and later ones until a release, fail with `message`. */
  fail(message?: string): void;
}

/**
 * `make`: the process itself (by default Claude's or Codex's session, against their fakes); `failBeforeTurn`: a cleanup
 * asked of a process that has run no turn yet fails with this message, whatever the gate (a busy machine, where a new
 * process's Windows job host starts later than the cleanup limit: "worker cleanup timed out", queue CI8). The gate
 * starts open.
 */
export function gatedCleanup(o: { make?: (launch: Launch) => AgentProcess; failBeforeTurn?: string } = {}): GatedCleanup {
  const make = o.make ?? ((launch: Launch) => (launch.runtime === "claude" ? new ClaudeSession(launch.options) : new CodexSession(launch.options)));
  const calls: CleanupCall[] = [];
  let gate: { open: boolean; error?: string } = { open: true };
  let waiters: (() => void)[] = [];
  const wake = () => { const w = waiters; waiters = []; for (const f of w) f(); };
  const pass = async (): Promise<void> => {
    while (!gate.open && gate.error === undefined) await new Promise<void>((r) => waiters.push(r));
    if (gate.error !== undefined) throw new Error(gate.error);
  };
  const spawn = (launch: Launch): AgentProcess => {
    const proc = make(launch);
    const own = proc.cleanup?.bind(proc);
    const send = proc.send.bind(proc);
    let turned = false;
    proc.send = (text, priority) => { turned = true; send(text, priority); };
    proc.cleanup = async () => {
      const call: CleanupCall = { turned };
      calls.push(call);
      try {
        if (!turned && o.failBeforeTurn !== undefined) throw new Error(o.failBeforeTurn);
        await pass();
        await own?.();
        call.outcome = "done";
      } catch (e) { call.outcome = "failed"; throw e; }
    };
    return proc;
  };
  return {
    spawn,
    calls,
    held: () => waiters.length,
    hold() { gate = { open: false }; },
    release() { gate = { open: true }; wake(); },
    fail(message = "injected cleanup failure") { gate = { open: false, error: message }; wake(); },
  };
}

/**
 * A gate inside the native cleanup (queue WHR, WHR4): the workers' processes run in a real job host compiled with
 * worker-gate.cs (worker-gate.ps1), which holds End at AwaitExit's 2000 ms wait on the handle it opened and checked for
 * the process the test names (`target`). Give `make` to gatedCleanup to count the cleanups as well. Windows only.
 */
export interface NativeGate {
  /** Makes Claude's or Codex's session whose process runs in a gate host. */
  make: (launch: Launch) => AgentProcess;
  /** The gate's folder. */
  dir: string;
  /** The gate hosts started so far (to end a host's pipe or kill it, as a server's loss would). */
  hosts: ChildProcessWithoutNullStreams[];
  /** Names the process to hold at the wait. */
  target(pid: number): void;
  /** The target's first TerminateProcess returns false with error 5 instead of being made (the WH2 trace). */
  refuse(): void;
  /** End holds before its `n`th OpenProcess of any member instead (after a DACL denial: before the kill ends anything). */
  holdOpen(n: number): void;
  /** The gate's acknowledgement once End waits at it: the PID and the handle End checked, else undefined. */
  arrived(): { pid: number; handle: number } | undefined;
  /** Lets the held wait go on: the real 2000 ms wait on the same handle. */
  open(): void;
  /** The native calls End made for the target, in order. */
  calls(): string[];
  /** While End is held at the wait: the host ends its runtime by its own Process object (a runtime crash, WHR5). */
  crashRuntime(): void;
  /** The runtime the host ended on crashRuntime: its PID and exit code, once it has exited; else undefined. */
  crashed(): { pid: number; code: number } | undefined;
  /** For each gate host started, in order: how many earlier ones had not exited when it started (WHR5). */
  overlaps: number[];
  /** The gate's `k`th hold (k > 1, WHR6): its acknowledgement ("<pid> <handle> member" or "<pid> 0 open"), else undefined. */
  arrivedAt(k: number): { pid: number; handle: number } | undefined;
  /** Lets the gate's `k`th hold go on (k > 1; the first is open()). */
  openAt(k: number): void;
  /** Every membership list Clean read and every native call End made, for any member, in order (WHR6). */
  trace(): string[];
}

/** `dir`: the gate's folder, when a server process of the test's own makes the hosts (crash-server.ts); else a new one. */
export function nativeGate(dir = tempDir("nexus-gate-")): NativeGate {
  const hosts: ChildProcessWithoutNullStreams[] = [];
  const overlaps: number[] = [];
  const script = fileURLToPath(new URL("./worker-gate.ps1", import.meta.url));
  const start: StartJobHost = (cwd, env) => {
    const host = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      cwd, env: { ...env, NEXUS_TEST_GATE_DIR: dir }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    overlaps.push(hosts.filter((h) => h.exitCode === null && h.signalCode === null).length);
    hosts.push(host);
    return host;
  };
  const spawnChild: SpawnRuntimeChild = (bin, args, options) => new WorkerProcess(bin, args, options, start);
  const make = (launch: Launch): AgentProcess => {
    const options = { ...launch.options, spawnChild };
    return launch.runtime === "claude" ? new ClaudeSession(options as ClaudeOptions) : new CodexSession(options as CodexOptions);
  };
  const read = (name: string) => { const file = join(dir, name); return existsSync(file) ? readFileSync(file, "utf8").trim().split(" ").map(Number) : undefined; };
  return {
    make, dir, hosts, overlaps,
    target: (pid) => writeFileSync(join(dir, "target"), String(pid)),
    refuse: () => writeFileSync(join(dir, "refuse"), ""),
    holdOpen: (n) => writeFileSync(join(dir, "holdopen"), String(n)),
    arrived: () => {
      const file = join(dir, "arrived");
      if (!existsSync(file)) return undefined;
      const [pid, handle] = readFileSync(file, "utf8").trim().split(" ");
      return { pid: Number(pid), handle: Number(handle) };
    },
    open: () => writeFileSync(join(dir, "open"), ""),
    calls: () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean) : []),
    crashRuntime: () => writeFileSync(join(dir, "crash"), ""),
    arrivedAt: (k) => { const x = read(`arrived-${k}`); return x && { pid: x[0]!, handle: x[1]! }; },
    openAt: (k) => writeFileSync(join(dir, `open-${k}`), ""),
    trace: () => (existsSync(join(dir, "trace.log")) ? readFileSync(join(dir, "trace.log"), "utf8").split(/\r?\n/).filter(Boolean) : []),
    crashed: () => { const x = read("crashed"); return x && { pid: x[0]!, code: x[1]! }; },
  };
}
