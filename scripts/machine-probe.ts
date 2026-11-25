// The machine's state at the start of a full test run (queue TI4, TI1's report 5.4). A full run once grew from 618 s
// to 1070 s in three days with no change in the code that explained it, and a restart of the machine took most of it
// back: the tests that start processes had slowed, the pure CPU tests had not. Whether a later slowdown is the
// machine's or the code's can only be told if the machine is measured beside the run. So `scripts/test-lock.ts`,
// once it holds the lock, times how long a few processes take to start:
//
// - node:       `node -e ""`, start to exit
// - PowerShell: `powershell.exe -NoProfile` until its first line (Windows only)
// - Add-Type:   in that PowerShell, compiling a small C# class (what the worker job host did for every start before
//               TI3, and still does when its cache fails), timed inside it
// - git:        `git --version`, start to exit
//
// and, when the run ends, appends one JSON line per run to nexus-test-machine.jsonl in the system's temporary folder
// (NEXUS_TEST_MACHINE_LOG names another file; "off" turns the probe off, which the lock's own tests do) and prints it.
// A probe that cannot start (no PowerShell outside Windows, no git) leaves its field null. It takes about a second;
// each process is given at most 10 s.
import { errorText } from "@nexus/protocol/errors";
import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface MachineProbe {
  node_ms: number | null;
  powershell_ms: number | null;
  git_ms: number | null;
  addtype_ms: number | null;
  /** The whole probe, from its start to its last process's end. */
  probe_ms: number;
}

const LIMIT_MS = 10_000;

/** Where the runs' lines go; undefined when the probe is off. */
export function machineLogFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env.NEXUS_TEST_MACHINE_LOG;
  if (named === "off") return undefined;
  return named || join(tmpdir(), "nexus-test-machine.jsonl");
}

/** Milliseconds from spawn to a successful exit; null when it fails or runs too long. */
function timed(file: string, args: string[]): Promise<number | null> {
  const start = performance.now();
  return new Promise((done) => {
    execFile(file, args, { windowsHide: true, timeout: LIMIT_MS }, (error) => {
      done(error ? null : Math.round(performance.now() - start));
    });
  });
}

// Prints a line once started, then compiles a class whose name no other run has used and prints how long it took.
const ADD_TYPE = `
"ready"
$name = "NexusProbe" + [Guid]::NewGuid().ToString("N")
$watch = [Diagnostics.Stopwatch]::StartNew()
Add-Type -TypeDefinition "public static class $name { public static int Twice(int x) { return 2 * x; } }"
$watch.Stop()
[int]$watch.Elapsed.TotalMilliseconds`;

/** PowerShell's start (to its first line) and Add-Type's time inside it; both null when it cannot run. */
function powershell(): Promise<{ powershell_ms: number | null; addtype_ms: number | null }> {
  if (process.platform !== "win32") return Promise.resolve({ powershell_ms: null, addtype_ms: null });
  const start = performance.now();
  return new Promise((done) => {
    let started: number | null = null;
    let out = "";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ADD_TYPE], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => child.kill(), LIMIT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      started ??= Math.round(performance.now() - start);
      out += chunk;
    });
    const end = (ok: boolean) => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const compiled = ok && lines[0] === "ready" && /^\d+$/.test(lines[1] ?? "") ? Number(lines[1]) : null;
      done({ powershell_ms: lines[0] === "ready" ? started : null, addtype_ms: compiled });
    };
    child.on("error", () => end(false));
    child.on("exit", (code) => end(code === 0));
  });
}

/** Times the processes one after another, so that they do not slow each other. */
export async function probeMachine(): Promise<MachineProbe> {
  const start = performance.now();
  const node_ms = await timed(process.execPath, ["-e", ""]);
  const { powershell_ms, addtype_ms } = await powershell();
  const git_ms = await timed("git", ["--version"]);
  return { node_ms, powershell_ms, git_ms, addtype_ms, probe_ms: Math.round(performance.now() - start) };
}

export interface MachineLine extends MachineProbe {
  at: string;
  /** The run's time under the lock, from the probe's end to the test runner's exit. */
  run_s: number;
}

const ms = (value: number | null) => (value === null ? "-" : `${value} ms`);

/** The run's line for its output. */
export function describeMachine(line: MachineLine, file: string): string {
  return `npm test: machine: node ${ms(line.node_ms)}, PowerShell ${ms(line.powershell_ms)}, git ${ms(line.git_ms)}, `
    + `Add-Type ${ms(line.addtype_ms)} (probe ${ms(line.probe_ms)}); run ${line.run_s} s; in ${file}`;
}

/** Appends the run's line to `file`; a file that cannot be written is said, never fails the run. */
export function recordMachine(file: string, line: MachineLine, say: (text: string) => void): void {
  try { appendFileSync(file, `${JSON.stringify(line)}\n`); }
  catch (error) { say(`npm test: could not write the machine probe to ${file}: ${errorText(error)}`); return; }
  say(describeMachine(line, file));
}
