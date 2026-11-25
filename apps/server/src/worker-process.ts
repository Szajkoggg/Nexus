// A Windows job host, with the same streams the runtime adapters already consume: a worker's (its processes are
// ended at a step's boundary), a check's, and every other agent's (the orchestrator's, a thinking partner's, a review
// helper's), whose job only marks its processes as an agent's for the server's write guard (queue HG). The control
// frames never enter a runtime's JSON stream (docs/protocol/runtimes.md, "Windows worker process host (PT)").
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants, setPriority } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

/**
 * `owned`: a worker's or a check's process, below normal priority when the server asks for it (lowerOwnedProcesses).
 * `agent`: an agent session's role; on Windows its process runs in a job the server asks about (agentOwning).
 */
export interface SpawnOptions { cwd: string; env: NodeJS.ProcessEnv; owned?: boolean; agent?: string }
/** Starts a runtime's process: spawnRuntimeChild; tests give a stand-in that runs the fake runtime in their own process. */
export type SpawnRuntimeChild = (bin: string, args: string[], options: SpawnOptions) => RuntimeChild;
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
  if ((options.owned || options.agent) && process.platform === "win32") return new WorkerProcess(bin, args, options);
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

/** The agents' job hosts still running, each with its session's role. */
const agentJobs = new Set<WorkerProcess>();

/** How long the write guard waits for a job host's answer before it lets the request through (and logs it). */
const OWNER_ANSWER_MS = 3000;

/** What agentOwning answers for a command of Codex's elevated sandbox found in no agent's job. */
const CODEX_SANDBOX = "codex-sandbox";

/** A job host's answer: a process of its job owns the connection, a command of Codex's sandbox does, or neither. */
type Ownership = "job" | "sandbox" | "none";
/** The job host's digits for an Ownership (worker-job.cs Owns); any other is "none". */
const OWNERSHIP: Readonly<Record<string, Ownership>> = { "1": "job", "2": "sandbox" };

/**
 * Which agent's job, if any, owns the client end of a loopback connection to this server, named by its two ports (the
 * client's own and the server's): the role of the agent session (queue HG, docs/design/security.md). A command run as
 * an account of Codex's elevated sandbox (the CodexSandboxUsers group) is an agent's in any case: CODEX_SANDBOX, when
 * it is in no agent's job. Asks every agent's job host at once. A host that does not answer in time counts as not
 * owning it, and is logged: a failed lookup must never lock the user out. Off Windows there are no jobs, and the answer
 * is always none.
 */
export async function agentOwning(clientPort: number, serverPort: number): Promise<string | undefined> {
  const hosts = [...agentJobs];
  if (!hosts.length) return undefined;
  const answers = await Promise.all(hosts.map((h) => h.owns(clientPort, serverPort).then(
    (owns) => ({ owns, agent: h.agent }),
    (err: Error) => {
      console.error(`write guard: an agent's job host did not answer (${err.message}); the request is let through`);
      return { owns: "none" as Ownership, agent: h.agent };
    },
  )));
  return answers.find((a) => a.owns === "job")?.agent ?? (answers.some((a) => a.owns === "sandbox") ? CODEX_SANDBOX : undefined);
}

/** Starts the job host's PowerShell (worker-job.ps1) in `cwd` with `env`. */
export type StartJobHost = (cwd: string, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
const startJobHost: StartJobHost = (cwd, env) => spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./worker-job.ps1", import.meta.url))], {
  cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});

/**
 * The server's end of a job host's control pipe. `start` is the real host but in the frame tests
 * (worker-process-frames.test.ts), which give a pipe of their own to send the host's frames and read the server's.
 */
export class WorkerProcess extends EventEmitter implements RuntimeChild {
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
  private readonly asking = new Map<number, { resolve: (owns: Ownership) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  /** The agent session's role, for an agent's job (SpawnOptions.agent). */
  readonly agent?: string;

  constructor(bin: string, args: string[], options: SpawnOptions, start: StartJobHost = startJobHost) {
    super();
    this.agent = options.agent;
    if (this.agent) agentJobs.add(this);
    this.host = start(options.cwd, { ...options.env, [JOB_PRIORITY]: lowered && options.owned ? "1" : undefined });
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
      agentJobs.delete(this);
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

  /** Who owns the client end of the loopback connection between the two ports, as this job host sees it. */
  owns(clientPort: number, serverPort: number): Promise<Ownership> {
    if (this.exited) return Promise.resolve("none");
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.asking.delete(id); reject(new Error(`no answer in ${OWNER_ANSWER_MS} ms`)); }, OWNER_ANSWER_MS);
      this.asking.set(id, { resolve, reject, timer });
      this.write(`T ${id} ${clientPort} ${serverPort}`);
    });
  }

  private fail(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    // A job that is gone owns no connection.
    for (const a of this.asking.values()) { clearTimeout(a.timer); a.resolve("none"); }
    this.asking.clear();
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
        case "T": {
          const [id, owns] = value.split(" ");
          const a = this.asking.get(Number(id));
          if (a) { clearTimeout(a.timer); this.asking.delete(Number(id)); a.resolve(OWNERSHIP[owns!] ?? "none"); }
          break;
        }
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
