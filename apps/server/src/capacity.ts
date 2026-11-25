// The capacity coordinator, first slice (docs/design/checks.md, "The capacity coordinator, first slice"; docs/protocol/checks.md, "The capacity
// coordinator"). Decided 2026-11-16 (docs/ideas/worker-phases-and-resources.md) and 2026-11-17/18 (queue EC, EC1's
// proposals P2, P11, P17): one heavy operation per workstation at a time, across projects; a request is granted
// atomically or waits in line, in the order requests came; the line is shown (<NEXUS_HOME>/capacity.yaml, read by
// `nexus status` and the dashboard); the slot is released when the operation's processes have ended, not when anyone
// says the work is done; and a long wait never turns into a start beside another heavy operation.
//
// One coordinator per server: the server serves every project of the workstation. Its first user is the engine running
// a step's checks (queue EC, EC3), one grant for the whole set (P2). A full test run outside Nexus (by hand, or an
// agent against its briefing) holds the machine's full-test lock (scripts/test-lock.ts): while it does, nothing is
// granted, and the file says what occupies the machine (P11).
import { errorText } from "@nexus/protocol/errors";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { newId, writeCapacity, type CapacityFile, type CapacityRequest } from "@nexus/protocol";
import { fullTestHeld, fullTestLockFile, fullTestStaleMs } from "@nexus/protocol/full-test-lock";
import { belowNormal, spawnRuntimeChild, type RuntimeChild } from "./worker-process.ts";

/** What asks for the heavy slot: a step's checks. */
export type HeavyRequest = Pick<CapacityRequest, "kind" | "project" | "queue" | "step">;

/** A process run under a grant: its `done` resolves once its whole tree has ended, with the root's exit code. */
export interface HeavyProcess {
  readonly child: RuntimeChild;
  readonly done: Promise<number | null>;
  /** Ends its whole tree. */
  kill(): void;
}

/** The slot, granted: processes started through it hold it; `end()` says the operation is over. */
export interface Grant {
  readonly id: string;
  /**
   * Starts `bin args` under this grant, outside the event loop, its streams piped. On Windows it runs in a Job Object
   * of its own (src/worker-process.ts), so its end is the end of every process it started, detached ones included;
   * elsewhere in a process group of its own, ended with its root. The caller reads its stdout and stderr (a pipe left
   * unread stops the process once it is full).
   */
  spawn(bin: string, args: string[], o: { cwd: string; env?: NodeJS.ProcessEnv }): HeavyProcess;
  /** The operation is over. The slot is free once every process started under it has ended, not before. */
  end(): void;
}

/** A request: `granted` resolves when it gets the slot; `cancel()` withdraws it (or ends the grant). */
export interface Ticket {
  readonly id: string;
  readonly granted: Promise<Grant>;
  cancel(): void;
}

interface CapacityOptions {
  /** How many heavy operations at once (1). */
  slots?: number;
  /** The workstation's id (its host name). */
  workstation?: string;
  /** The machine's full-test lock (scripts/test-lock.ts's file, NEXUS_TEST_LOCK) and when it counts as stale. */
  testLock?: string;
  testLockStaleMs?: number;
  /** Called after the file changed (the dashboard shows what a queued step waits behind). */
  onChange?: () => void;
  /** How often a request kept only by a full run outside Nexus looks again (1 s). */
  pollMs?: number;
  /**
   * Windows: each process in a Job Object of its own (the default), so its end is its whole tree's. Off only in tests
   * whose subject is not the tree (the job host starts a PowerShell that compiles it, a second or two a process).
   */
  jobs?: boolean;
}

interface Entry {
  request: CapacityRequest;
  grant: (g: Grant) => void;
  fail: (e: Error) => void;
  /** Granted: the processes still alive, and whether its owner has ended it. */
  live?: Set<HeavyProcess>;
  ended?: boolean;
}

export class Capacity {
  private readonly slots: number;
  private readonly workstation: string;
  private readonly testLock: string;
  private readonly testLockStaleMs: number;
  private readonly pollMs: number;
  private readonly jobs: boolean;
  private readonly onChange?: () => void;
  private readonly waiting: Entry[] = [];
  private readonly held: Entry[] = [];
  private outside: CapacityFile["outside"];
  private poll?: NodeJS.Timeout;
  private stopped = false;

  /** Writes the file anew: a server becoming active has no grants (the old server's ended with its processes). */
  constructor(o: CapacityOptions = {}) {
    this.slots = o.slots ?? 1;
    this.workstation = o.workstation ?? hostname();
    this.testLock = o.testLock ?? fullTestLockFile();
    this.testLockStaleMs = o.testLockStaleMs ?? fullTestStaleMs();
    this.pollMs = o.pollMs ?? 1000;
    this.jobs = o.jobs ?? true;
    this.onChange = o.onChange;
    this.write();
  }

  /** Asks for the heavy slot. Requests are granted in the order they came. */
  request(r: HeavyRequest): Ticket {
    let grant!: (g: Grant) => void, fail!: (e: Error) => void;
    const granted = new Promise<Grant>((res, rej) => { grant = res; fail = rej; });
    granted.catch(() => {}); // a cancelled request's owner may not wait for it
    const entry: Entry = { request: { id: newId(), ...r, requested_at: new Date().toISOString() }, grant, fail };
    if (this.stopped) fail(new Error("the capacity coordinator has stopped"));
    else { this.waiting.push(entry); this.pump(); }
    return {
      id: entry.request.id,
      granted,
      cancel: () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) { this.waiting.splice(i, 1); entry.fail(new Error("cancelled")); this.write(); this.pump(); }
        else this.endGrant(entry);
      },
    };
  }

  /** The state as the file has it. */
  view(): CapacityFile {
    return {
      protocol: 1,
      workstation: this.workstation,
      slots: { heavy: this.slots },
      held: this.held.map((e) => e.request),
      waiting: this.waiting.map((e) => e.request),
      ...(this.outside ? { outside: this.outside } : {}),
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * This server no longer coordinates (its shutdown, or the hand-over of an update): nothing more is granted or
   * written; waiting requests fail. Processes still running are not ended here: their owners end them (an update's
   * drain stops running checks first), and on Windows they end with this process anyway (kill-on-close).
   */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.poll);
    for (const e of this.waiting.splice(0)) e.fail(new Error("the capacity coordinator has stopped"));
  }

  /** Grants what may be granted now; while only a run outside Nexus keeps a request waiting, looks again soon. */
  private pump(): void {
    clearTimeout(this.poll);
    this.poll = undefined;
    if (this.stopped) return;
    while (this.waiting.length && this.held.length < this.slots) {
      const lock = fullTestHeld(this.testLock, this.testLockStaleMs);
      this.outside = lock ? { cwd: lock.cwd, pid: lock.pid, since: lock.since } : undefined;
      if (lock) break;
      const entry = this.waiting.shift()!;
      entry.request = { ...entry.request, granted_at: new Date().toISOString() };
      entry.live = new Set();
      this.held.push(entry);
      entry.grant(this.grantOf(entry));
    }
    if (!this.waiting.length) this.outside = undefined;
    this.write();
    if (this.outside) {
      this.poll = setTimeout(() => this.pump(), this.pollMs);
      this.poll.unref();
    }
  }

  private grantOf(entry: Entry): Grant {
    return {
      id: entry.request.id,
      spawn: (bin, args, o) => {
        if (entry.ended) throw new Error("this grant has ended");
        const p = track(bin, args, o, this.jobs);
        entry.live!.add(p);
        void p.done.then(() => { entry.live!.delete(p); this.settle(entry); });
        return p;
      },
      end: () => this.endGrant(entry),
    };
  }

  private endGrant(entry: Entry): void {
    if (entry.ended || !entry.live) return;
    entry.ended = true;
    this.settle(entry);
  }

  /** Releases a grant once it is ended and its last process has ended. */
  private settle(entry: Entry): void {
    if (!entry.ended || entry.live!.size) return;
    const i = this.held.indexOf(entry);
    if (i < 0) return;
    this.held.splice(i, 1);
    this.write();
    this.pump();
  }

  private lastWritten?: string;
  /** Writes the file when what it says changed. */
  private write(): void {
    if (this.stopped) return;
    const v = this.view();
    const key = JSON.stringify({ ...v, updated_at: undefined });
    if (key === this.lastWritten) return;
    this.lastWritten = key;
    try { writeCapacity(v); }
    catch (err) { console.error(`capacity.yaml not written: ${errorText(err)}`); }
    this.onChange?.();
  }
}

/**
 * The command runs through the system's shell (cmd.exe on Windows, sh elsewhere) as Node's `shell: true` runs it, in
 * a small Node launcher: the job host quotes each argument for CreateProcess, which cmd.exe's own switches do not
 * take, and the launcher's exit code is the command's.
 */
const LAUNCHER = 'const r=require("node:child_process").spawnSync(process.argv[1],{shell:true,stdio:"inherit",windowsHide:true});process.exit(r.status===null?1:r.status)';

/** `bin` and `args` that run a shell command line through the launcher (for Grant.spawn and spawnTree). */
export function shellCommand(command: string): [string, string[]] {
  return [process.execPath, ["-e", LAUNCHER, command]];
}

/**
 * Starts a process outside any grant whose `done` and `kill` take its whole tree, as Grant.spawn's do: on Windows in a
 * Job Object of its own, elsewhere in a process group. The worktree setup the engine runs before a step (queue LKF).
 */
export function spawnTree(bin: string, args: string[], o: { cwd: string; env?: NodeJS.ProcessEnv }): HeavyProcess {
  return track(bin, args, o, true);
}

/** Starts a process whose `done` follows its whole tree (see Grant.spawn). */
function track(bin: string, args: string[], o: { cwd: string; env?: NodeJS.ProcessEnv }, jobs: boolean): HeavyProcess {
  const env = o.env ?? process.env;
  if (process.platform === "win32" && jobs) {
    // Its input stays open: closing it would have the job host end the job five seconds later.
    const child = spawnRuntimeChild(bin, args, { cwd: o.cwd, env, owned: true });
    // The job host closes once the root has exited and the job is empty (worker-job.cs), or when it failed to start.
    const done = new Promise<number | null>((res) => { child.on("close", (code: number | null) => res(code)); child.on("error", () => res(null)); });
    return { child, done, kill: () => { child.kill(); } };
  }
  // Elsewhere a process group of its own; on Windows without a job (tests), only the root is known.
  const windows = process.platform === "win32";
  const child = spawn(bin, args, { cwd: o.cwd, env, detached: !windows, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  belowNormal(child.pid);
  child.stdin.end();
  const group = () => {
    if (windows) { if (child.exitCode === null && child.signalCode === null) child.kill(); return; }
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
  };
  const done = new Promise<number | null>((res) => {
    child.on("error", () => res(null));
    // The root's end ends what it left in its group; its streams close after that.
    child.on("exit", group);
    child.on("close", (code: number | null) => res(code));
  });
  return { child, done, kill: group };
}
