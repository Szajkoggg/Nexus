// A worker's Windows job host, with the same streams the runtime adapters already consume. Other agent roles
// keep Node's ordinary child process. The control frames never enter a runtime's JSON stream (docs/protocol/runtimes.md, "Windows worker process host (PT)").
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants, setPriority } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

interface SpawnOptions { cwd: string; env: NodeJS.ProcessEnv; owned?: boolean }
export interface RuntimeChild extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: PassThrough | ChildProcessWithoutNullStreams["stdout"];
  readonly stderr: PassThrough | ChildProcessWithoutNullStreams["stderr"];
  readonly pid?: number;
  kill(): unknown;
  cleanup?(): Promise<void>;
}

/** Quote for CreateProcess/.NET ProcessStartInfo.Arguments, not for a shell. */
function quote(value: string): string { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") + '"'; }
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

export function spawnRuntimeChild(bin: string, args: string[], options: SpawnOptions): RuntimeChild {
  if (options.owned && process.platform === "win32") return new WorkerProcess(bin, args, options);
  const child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  if (options.owned) belowNormal(child.pid);
  return child;
}

/**
 * Whether the workers' and checks' processes run below normal priority (queue SV3): the server turns it on at its start
 * (main.ts), so it and the user's programs go first. Off by default: the tests run the engine inside a test process at
 * whatever priority the suite has, and their fake workers must not fall behind the suite's other files.
 */
let lowered = false;
export function lowerOwnedProcesses(on: boolean): void { lowered = on; }

/** Tells the Windows job host to limit its job's priority class (worker-job.cs); it removes the variable before the runtime starts. */
const JOB_PRIORITY = "NEXUS_JOB_BELOW_NORMAL";

/**
 * A worker's or a check's process below normal priority when the server asked for it, as the Windows job sets for its
 * whole tree: elsewhere a nice value its children inherit. Never fails a start: a process already gone stays as it is.
 */
export function belowNormal(pid: number | undefined): void {
  if (!lowered || pid === undefined) return;
  try { setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ended already, or not allowed */ }
}

class WorkerProcess extends EventEmitter implements RuntimeChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  pid?: number;
  private readonly host: ChildProcessWithoutNullStreams;
  private buffer = "";
  private result: number | null = null;
  private exited = false;
  private closing?: NodeJS.Timeout;
  private killing?: NodeJS.Timeout;
  private next = 0;
  private readonly pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(bin: string, args: string[], options: SpawnOptions) {
    super();
    this.host = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./worker-job.ps1", import.meta.url))], {
      cwd: options.cwd, env: { ...options.env, [JOB_PRIORITY]: lowered ? "1" : undefined }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.host.stdin.on("error", () => {});
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => { this.write(`W ${chunk.toString("base64")}`); done(); },
      final: (done) => {
        this.write("E");
        this.closing = setTimeout(() => this.kill(), 5000);
        done();
      },
    });
    this.host.stdout.setEncoding("utf8");
    this.host.stdout.on("data", (chunk: string) => this.read(chunk));
    this.host.stderr.on("data", (chunk: Buffer) => this.stderr.write(chunk));
    this.host.on("error", (error) => this.emit("error", error));
    this.host.on("close", (code) => {
      this.exited = true;
      clearTimeout(this.closing); clearTimeout(this.killing);
      this.fail(new Error("worker job host exited"));
      this.stdout.end(); this.stderr.end();
      this.emit("exit", this.result ?? code);
      this.emit("close", this.result ?? code);
    });
    this.write(encode(bin));
    this.write(encode(args.map(quote).join(" ")));
  }

  private write(line: string): void { if (!this.exited) this.host.stdin.write(line + "\n"); }
  kill(): void {
    if (this.exited) return;
    this.write("K");
    // A stuck control reader must not strand its job. Node still owns this exact child's process handle.
    this.killing ??= setTimeout(() => this.host.kill(), 15_000);
  }

  cleanup(): Promise<void> {
    if (this.exited) return Promise.resolve();
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("worker cleanup timed out")); this.kill(); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write(`C ${id}`);
    });
  }

  private fail(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trimEnd();
      this.buffer = this.buffer.slice(end + 1);
      const value = line.slice(2);
      switch (line.slice(0, 1)) {
        case "R": this.pid = Number(value); this.emit("spawn"); break;
        case "O": this.stdout.write(Buffer.from(value, "base64")); break;
        case "E": this.stderr.write(Buffer.from(value, "base64")); break;
        case "X": this.result = Number(value); break;
        case "C": {
          const p = this.pending.get(Number(value));
          if (p) { clearTimeout(p.timer); this.pending.delete(Number(value)); p.resolve(); }
          break;
        }
        case "F": {
          const error = new Error(Buffer.from(value, "base64").toString("utf8"));
          this.stderr.write(error.message); this.fail(error); this.kill();
          break;
        }
        default: this.stderr.write(`invalid worker job frame: ${line}`); this.kill();
      }
    }
  }
}
