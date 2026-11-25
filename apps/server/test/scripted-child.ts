// A runtime process the test writes itself (queue LCR): for the orderings neither fake nor process gives on demand. The
// adapter (ClaudeSession, CodexSession) takes it as its spawnChild; the test writes the process's stdout and stderr,
// ends them, and emits its exit, its spawn error or its signal in the order it wants: an exit before the stderr that
// explains it, stderr that never ends, a spawn that fails. What the adapter wrote to it is kept (written).
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { RuntimeChild, SpawnRuntimeChild } from "../src/worker-process.ts";

export class ScriptedChild extends EventEmitter implements RuntimeChild {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** What the adapter wrote to the process's input, chunk by chunk. */
  readonly written: string[] = [];
  /** The adapter closed the process's input. */
  inputEnded = false;
  /** kill() calls. */
  kills = 0;
  /** What kill() does: by default the process ends with exit code 1, as the Windows job host reports a termination. */
  onKill: (child: ScriptedChild) => void = (c) => c.end(1);

  readonly args: readonly string[];
  readonly pid: number;

  constructor(args: readonly string[], pid: number) {
    super();
    this.args = args;
    this.pid = pid;
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => { this.written.push(chunk.toString()); done(); },
      final: (done) => { this.inputEnded = true; done(); },
    });
  }

  /** A line (an object as JSON) or raw text on stdout. */
  out(m: object | string): void { this.stdout.write(typeof m === "string" ? m : JSON.stringify(m) + "\n"); }
  /** Text on stderr, as it comes (a chunk, maybe part of a line). */
  err(text: string): void { this.stderr.write(text); }
  /** Ends stdout and stderr. */
  endStreams(): void { this.stdout.end(); this.stderr.end(); }
  /** The exit event alone (its streams may stay open): `null` for a signal. */
  exitEvent(code: number | null): void { this.emit("exit", code, code === null ? "SIGTERM" : null); }
  /** The process's end as the job host gives it: its output ends, then the exit. */
  end(code: number | null): void { this.endStreams(); this.exitEvent(code); }
  /** A spawn failure: the error event (the job host then closes, end()). */
  fail(error: Error): void { this.emit("error", error); }
  kill(): boolean { this.kills++; this.onKill(this); return true; }
}

/** A spawnChild that makes ScriptedChild processes, kept in order of their start. */
export function scriptedSpawn(): { children: ScriptedChild[]; spawnChild: SpawnRuntimeChild } {
  const children: ScriptedChild[] = [];
  const spawnChild: SpawnRuntimeChild = (_bin, args) => {
    const c = new ScriptedChild(args, 90_000 + children.length + 1);
    children.push(c);
    return c;
  };
  return { children, spawnChild };
}
