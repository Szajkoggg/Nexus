// A server that dies without a word (queue LCR, LC-F3): a Node process of the test's own that runs the project's engine
// or orchestrator as the server does (the fakes in that process, in-process-runtime.ts; its store reading through the
// model, model-reads.ts), holds a fake at a gate (FakeGates) and says so on stdout; the test then ends it with
// TerminateProcess (ChildProcess.kill), by its own handle: no drain, no cut-off, no shutdown, no exit handler, and its
// fakes end with it. The next server, made by the test on the same files, sees only what is on disk.
//
// Run by the test as `node --import model-reads.ts crash-server.ts <plan JSON>`; the test's side is crashAt().
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore } from "@nexus/protocol";
import type { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { REAL_PROCESSES, restart } from "./engine-setup.ts";
import { FakeGates, type FakePoint } from "./fake-behaviour.ts";
import { nativeGate } from "./gated-cleanup.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";
import { assertTempHome } from "./helpers.ts";
import { LONGER, until } from "./wait.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const MODEL_READS = new URL("./model-reads.ts", import.meta.url).href;

/**
 * What the dying server does before it is held:
 * - `start`: starts queue Q's run (with `runtime`), as the user's Start;
 * - `restart`: only builds the engine, whose recovery goes on with a run an update held (resume_after_restart);
 * - `chat`: builds the orchestrator and goes on with the turn an update cut off (resumeCutOff), as main.ts's activate.
 * It holds the `process`-th fake (1: the first it starts) at `point`; earlier arrivals at the point go on.
 * `gate` (queue WHR, WHR5; with `start`, Windows only): instead, the worker's processes run as real processes in gate
 * hosts (gated-cleanup.ts, nativeGate) on that folder, which the test drives; the server is held once End waits at the
 * gate (its "arrived" file), and says so with the point "native-gate".
 */
export interface CrashPlan {
  root: string;
  does: "start" | "restart" | "chat";
  runtime?: "claude" | "codex";
  point: FakePoint | "native-gate";
  process?: number;
  gate?: string;
}

/** What the server said as it was held: the point, the fake's number, the point's detail. */
export interface Held { point: FakePoint | "native-gate"; process: number; detail?: string }

/**
 * The server's environment: the test's, without what names a Nexus outside the test (a worker's own session and project,
 * the live instance's log or hand-over) and without the test's gates (the server makes its own); NEXUS_HOME a temporary one.
 */
function serverEnv(): NodeJS.ProcessEnv {
  const keep = new Set(["NEXUS_HOME", "NEXUS_CLAUDE", "NEXUS_CODEX", "NEXUS_TEST_WAIT_MS"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NEXUS_") || keep.has(k)));
  delete env.FAKE_GATES;
  assertTempHome(env.NEXUS_HOME);
  return env;
}

/** The servers crashAt started and not yet seen exit: what a test's cleanup ends (by their handles). */
const started = new Set<ChildProcess>();

/**
 * Runs `plan` in a server process of the test's own until its fake is held, calls `atCrash` (what the test looks at on
 * disk just before), then kills that process by its handle and waits for its exit. Returns what was held and the pid
 * it ended. No other process is touched.
 */
export async function crashAt(plan: CrashPlan, atCrash?: (held: Held) => void | Promise<void>): Promise<{ held: Held; pid: number; exit: { code: number | null; signal: string | null } }> {
  const child = spawn(process.execPath, ["--import", MODEL_READS, SCRIPT, JSON.stringify(plan)], { env: serverEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  started.add(child);
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.once("exit", (code, signal) => { started.delete(child); r({ code, signal }); }));
  let out = "", err = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => { out += d; });
  child.stderr!.setEncoding("utf8").on("data", (d: string) => { err += d; });
  await until(`the server held at ${plan.point}`, () => out.includes("\n") || child.exitCode !== null, LONGER.processes, () => `; its stderr: ${err}`);
  if (!out.includes("\n")) throw new Error(`the server ended (${child.exitCode}) before it was held: ${err}`);
  const held = JSON.parse(out.slice(0, out.indexOf("\n"))) as Held;
  await atCrash?.(held);
  child.kill(); // TerminateProcess on Windows: the process ends where it stands
  const exit = await exited;
  return { held, pid: child.pid!, exit };
}

/** Ends the servers crashAt started that are still running (a failed test's): by their own handles. */
export async function endCrashServers(): Promise<number> {
  const left = [...started];
  for (const c of left) c.kill();
  await Promise.all(left.map((c) => new Promise<void>((r) => { if (c.exitCode !== null || c.signalCode !== null) r(); else c.once("exit", () => r()); })));
  return left.length;
}

// ---------------------------------------------------------------- the server's side

async function serve(plan: CrashPlan): Promise<void> {
  // Stays up until it is killed: its input (the test's pipe) is never closed.
  process.stdin.resume();
  if (plan.gate) {
    const gate = nativeGate(plan.gate);
    restart(ProjectStore.forRoot(plan.root), { ...REAL_PROCESSES, spawn: gate.make }).start("Q", { runtime: plan.runtime ?? "claude" });
    await until("End waits at the native gate", () => existsSync(join(plan.gate!, "arrived")), LONGER.run);
    process.stdout.write(JSON.stringify({ point: "native-gate", process: gate.hosts.length } satisfies Held) + "\n");
    return; // held until the test kills this process
  }
  if (plan.point === "native-gate") throw new Error("the point native-gate needs a gate folder");
  const gates = new FakeGates([plan.point]);
  process.env.FAKE_GATES = gates.id; // the fakes the engine or orchestrator starts take this process's environment
  const store = ProjectStore.forRoot(plan.root);
  if (plan.does === "start") restart(store).start("Q", { runtime: plan.runtime ?? "claude" });
  else if (plan.does === "restart") restart(store);
  else {
    const engine = { draining: false, onChange() {}, shutdown() {} } as unknown as Engine;
    new Orchestrator(store, engine, () => {}, {}, { spawn: inProcessRuntime() }).resumeCutOff();
  }
  for (;;) {
    const h = await gates.reached(plan.point);
    if (h.process === (plan.process ?? 1)) {
      process.stdout.write(JSON.stringify({ point: h.point, process: h.process, detail: h.detail } satisfies Held) + "\n");
      return; // held until the test kills this process
    }
    h.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  serve(JSON.parse(process.argv[2]!) as CrashPlan).catch((e: unknown) => { console.error(e); process.exit(2); });
}
