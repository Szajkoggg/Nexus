// The fake runtimes inside the test's own process (queue IPR): no process start, no Windows job host, no Node to load
// per agent process. inProcessRuntime() goes into the `spawn` option of the engine, the orchestrator, the
// conversations and the review helpers (AgentHostOptions.spawn): the real adapters (ClaudeSession, CodexSession) run
// against runFakeClaude/runFakeCodex over in-memory streams, as they run against a process's stdio. What stays a
// real process, and why, is in real-process-tests.ts.
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AgentHostOptions, Launch } from "../src/agent-host.ts";
import type { AgentProcess } from "../src/agent.ts";
import { ClaudeSession } from "../src/claude.ts";
import { CodexSession } from "../src/codex.ts";
import type { RuntimeChild, SpawnOptions, SpawnRuntimeChild } from "../src/worker-process.ts";
import type { FakeIo } from "./fake-behaviour.ts";
import { runFakeClaude } from "./fake-claude.ts";
import { runFakeCodex } from "./fake-codex.ts";

// A Claude or Codex process some code still starts (a server, the model list, an engine made without the `spawn`
// option) is the fake's, never the real CLI's.
const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE ??= join(here, "fake-claude.ts");
process.env.NEXUS_CODEX ??= join(here, "fake-codex.ts");

/**
 * A one-way stream between the adapter and the fake: what is written comes out of `readable` once the writer's call has
 * returned (never inside it, as a pipe's data never is), and before the event loop goes on (process.nextTick), as a
 * pipe's data written so far is there at the reader's next read; the end comes after everything written.
 */
function pipe(): { writable: Writable; readable: PassThrough } {
  const readable = new PassThrough();
  const writable = new Writable({
    write(chunk: Buffer, _encoding, done) { process.nextTick(() => { readable.write(chunk); done(); }); },
    final(done) { process.nextTick(() => { readable.end(); done(); }); },
  });
  // A write after the end (an adapter writing to an exited runtime) fails as a pipe's would: the adapters ignore it.
  writable.on("error", () => {});
  return { writable, readable };
}

/** The fake runtime as a RuntimeChild: its stdin, stdout and stderr in memory, its exit as a process's. */
class InProcessChild extends EventEmitter implements RuntimeChild {
  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  /** No process, so no pid: Nexus records none, and looks for no process of it. */
  readonly pid = undefined;
  private readonly output = pipe();
  private readonly errors = pipe();
  private stop?: () => void;
  private exited = false;

  constructor(run: (io: FakeIo) => () => void, args: string[], options: SpawnOptions) {
    super();
    const input = pipe();
    this.stdin = input.writable;
    this.stdout = this.output.readable;
    this.stderr = this.errors.readable;
    // Started on a later turn, as a process is: the adapter has its listeners on by then.
    setImmediate(() => {
      if (this.exited) return;
      this.emit("spawn");
      this.stop = run({
        argv: args, env: options.env, cwd: options.cwd, stdin: input.readable, stdout: this.output.writable, stderr: this.errors.writable,
        exit: (code) => this.exit(code),
        // A signal on Windows: TerminateProcess with exit code 1, as the job host reports it (worker-job.cs).
        signal: () => this.exit(1),
      });
    });
  }

  /** Ended as the job host ends a process (TerminateProcess, exit code 1). */
  kill(): boolean { this.exit(1); return true; }

  /**
   * The runtime's end: it stops (no output, no timer, no `nexus` call after it), what it wrote is read, then `exit`
   * and `close` come, in the order the job host gives them (worker-process.ts: the output first).
   */
  private exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.stop?.();
    let open = 2;
    const ended = () => {
      if (--open) return;
      setImmediate(() => { this.emit("exit", code, null); this.emit("close", code, null); });
    };
    this.output.writable.end(ended);
    this.errors.writable.end(ended);
  }
}

/** A SpawnRuntimeChild that runs `run` in this process instead of the binary it is given. */
const inProcessChild = (run: (io: FakeIo) => () => void): SpawnRuntimeChild => (_bin, args, options) => {
  // The adapters start a script runtime as `node <script> <args>` (claude.ts, codex.ts): the runtime's own arguments follow.
  const own = /\.(m?[jt]s)$/.test(args[0] ?? "") ? args.slice(1) : args;
  return new InProcessChild(run, own, options);
};

/** For a test that makes an adapter itself: ClaudeOptions.spawnChild and CodexOptions.spawnChild, the fakes in this process. */
export const inProcessClaude: SpawnRuntimeChild = inProcessChild(runFakeClaude);
export const inProcessCodex: SpawnRuntimeChild = inProcessChild(runFakeCodex);

/**
 * The `spawn` option (AgentHostOptions.spawn) that runs the fake runtimes in this process: the real adapters, over
 * in-memory streams. `wrap` sees each process made (a test that counts or steers them).
 */
export function inProcessRuntime(wrap?: (proc: AgentProcess, launch: Launch) => AgentProcess): NonNullable<AgentHostOptions["spawn"]> {
  return (launch) => {
    const proc = launch.runtime === "codex"
      ? new CodexSession({ ...launch.options, spawnChild: inProcessCodex })
      : new ClaudeSession({ ...launch.options, spawnChild: inProcessClaude });
    return wrap ? wrap(proc, launch) : proc;
  };
}
