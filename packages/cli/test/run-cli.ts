// The `nexus` CLI run inside the test's own process (queue IPR): main.ts's run() with the call's environment, working
// directory and standard input, its output collected. One process start less per call; the CLI's contract as a real
// process (bin/nexus.js: exit code, stdout, stderr) keeps its own test (cli-roles-errors.test.ts).
import { run } from "../src/main.ts";

export interface CliResult { status: number; stdout: string; stderr: string }

export interface CliOptions {
  /** The call's environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
  /** Its working directory (default: this process's). */
  cwd?: string;
  /** What it reads as standard input (`-`); none: empty. */
  input?: string;
}

/** Runs `nexus <args>` in this process: its exit code and what it wrote. */
export async function cliRun(args: readonly string[], o: CliOptions = {}): Promise<CliResult> {
  let stdout = "", stderr = "";
  const status = await run(args, {
    env: o.env ?? process.env, cwd: o.cwd ?? process.cwd(), stdin: () => o.input ?? "",
    stdout: { write: (s: string) => { stdout += s; return true; } },
    stderr: { write: (s: string) => { stderr += s; return true; } },
  });
  return { status, stdout, stderr };
}

/** A call that ended with another exit code than 0, as execFileSync's error shows it: status, stdout, stderr. */
export class CliError extends Error {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  constructor(args: readonly string[], r: CliResult) {
    super(`nexus ${args.join(" ")} failed (exit code ${r.status})\n${r.stderr}`);
    this.status = r.status; this.stdout = r.stdout; this.stderr = r.stderr;
  }
}

/** Runs `nexus <args>` in this process, as execFileSync runs it: its stdout, or a CliError when it fails. */
export async function cliOut(args: readonly string[], o: CliOptions = {}): Promise<string> {
  const r = await cliRun(args, o);
  if (r.status !== 0) throw new CliError(args, r);
  return r.stdout;
}
