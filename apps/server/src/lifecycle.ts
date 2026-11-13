// Updating Nexus while it works: drain, update the checkout, build, restart, and resume what the drain held.
//
// The live instance runs from its own git worktree on a detached HEAD (scripts/live.ps1 creates it); development
// happens in another checkout. An update first lets every running step finish (or interrupts it with `now`): queues
// stop at their step's end, marked to be resumed. When no agent is in a turn, the live worktree moves to the new
// commit, installs what changed, builds the dashboard, and the server hands over to its successor (src/handover.ts):
// it stops every agent and its own writing, frees the port, starts the successor and exits once the successor has
// passed its smoke check. The successor then resumes the marked queues.
//
// When it goes wrong, the old version goes on. Before the hand-over (a failed checkout, install or build), the live
// worktree is put back and the held queues resume at once. When the successor does not come up (it crashes, fails its
// smoke check or sends no ready signal in time), this server stops it and whatever it started, puts the live worktree
// back on the commit it came from (reinstalling and rebuilding), takes the port again and starts over on the files,
// which resumes the held queues. A development checkout is never moved: its server simply goes on.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { newId, now } from "@nexus/protocol";
import { HANDOVER_TIMEOUT_MS, handOver, isAlive, type PredecessorFile, type ReleasedFile, type UpdateAsker } from "./handover.ts";
import { pushDeployed, type GitRunner, type PushResult } from "./deploy.ts";

const run = promisify(execFile);
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface Drainable { id: string; idle(): boolean; drain(now: boolean): string[]; cancel(): void; shutdown(): void }

export interface UpdateStatus {
  /** `updated`: this server is the successor of an update; the log says which version is up. */
  phase: "idle" | "draining" | "updating" | "restarting" | "failed" | "updated";
  since?: string;
  now?: boolean;
  ref?: string;
  /** Queues stopped for the update, "project/queue". */
  held: string[];
  /** Projects with an agent still in a turn. */
  waiting: string[];
  log: string[];
  error?: string;
  /** After a deploy: whether the deployed main was pushed to its upstream (src/deploy.ts). */
  push?: PushResult;
  /** This update's id: an orchestrator that asked for it is told its outcome once (the key in its applied.jsonl). */
  id?: string;
  /** Who asked for it: an orchestrator session (absent when the user started it from the dashboard or a terminal). */
  by?: UpdateAsker;
  /** On the successor: the version that came up, and the one it replaced. */
  up?: { commit: string; subject: string; previous?: string };
}

/** What the orchestrator that asked for an update is told about its outcome (Orchestrator.notify). */
export interface UpdateNotice { key: string; by: UpdateAsker; fact: string; todo: string }

/** What the server gives its Lifecycle; tests replace the parts that would touch this checkout or the process. */
export interface LifecycleOptions {
  /** The checkout this server runs from. */
  root?: string;
  /** The successor's command line (default: this Node running apps/server/src/main.ts of the root). */
  successor?: string[];
  /** How long the successor has to signal ready. */
  timeoutMs?: number;
  /** Runs npm in the root. */
  npm?: (root: string, ...args: string[]) => Promise<void>;
  /** Stops every agent and every write of this server and frees the port (main.ts). */
  release?: () => Promise<void>;
  /** Takes the port again and starts over on the files, which resumes the held queues (main.ts). */
  reacquire?: () => Promise<void>;
  /** Tells the user's devices that the update failed (push). */
  notify?: (text: string) => void;
  /** Ends this process once the successor is up. */
  exit?: () => void;
  /** Runs git for the push on deploy (src/deploy.ts). */
  git?: GitRunner;
  /** An update has settled (it is up and its push done, it failed, or it was cancelled): notices may go out now. */
  settled?: () => void;
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd: root, windowsHide: true })).stdout.trim();
}
/** npm through this Node (npm-cli.js beside it), so no shell is needed for npm.cmd on Windows. */
async function npmIn(root: string, ...args: string[]): Promise<void> {
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(cli)) await run(process.execPath, [cli, ...args], { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  else await run("npm", args, { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}
const hashOf = (file: string) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "");
const firstLine = (e: unknown) => (e as Error).message.split("\n")[0]!;

/** Ends a process and everything it started (on Windows its tree; elsewhere its process group: it was detached). */
export async function stopTree(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  if (process.platform === "win32") await run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
  for (const until = Date.now() + 10_000; isAlive(pid) && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
}

/** What this server runs: its commit, and whether it is a live worktree (detached HEAD) or a development checkout. */
export async function version(root = ROOT): Promise<{ commit: string; subject: string; live: boolean; branch: string | null; root: string }> {
  const [commit, subject] = (await git(root, "log", "-1", "--format=%h%x09%s").catch(() => "?\t")).split("\t");
  const branch = await git(root, "symbolic-ref", "-q", "--short", "HEAD").catch(() => "");
  return { commit: commit ?? "?", subject: subject ?? "", live: !branch, branch: branch || null, root };
}

export class Lifecycle {
  status: UpdateStatus = { phase: "idle", held: [], waiting: [], log: [] };
  private timer?: NodeJS.Timeout;
  private readonly parts: () => Drainable[];
  private readonly changed: () => void;
  private readonly root: string;
  private readonly o: Required<Omit<LifecycleOptions, "root" | "successor" | "git">> & { successor: string[]; git?: GitRunner };
  /** The push after a deploy, while it runs (tests wait for it). */
  pushing?: Promise<void>;
  /** Where this update started: the commit to go back to, and the dependencies it had. */
  private from?: { sha: string; short: string; subject: string; live: boolean; lock: string };

  constructor(parts: () => Drainable[], changed: () => void = () => {}, options: LifecycleOptions = {}) {
    this.parts = parts; this.changed = changed;
    this.root = options.root ?? ROOT;
    this.o = {
      successor: options.successor ?? [process.execPath, join(this.root, "apps/server/src/main.ts")],
      timeoutMs: options.timeoutMs ?? HANDOVER_TIMEOUT_MS,
      npm: options.npm ?? npmIn,
      release: options.release ?? (async () => {}),
      reacquire: options.reacquire ?? (async () => {}),
      notify: options.notify ?? (() => {}),
      exit: options.exit ?? (() => setTimeout(() => process.exit(0), 300)),
      git: options.git,
      settled: options.settled ?? (() => {}),
    };
  }

  get busy(): boolean { return this.status.phase === "draining" || this.status.phase === "updating" || this.status.phase === "restarting"; }

  /** This server took over from its predecessor: the update's log (the predecessor's lines first) and what is up. */
  arrived(v: { commit: string; subject: string }, predecessor: PredecessorFile | undefined, released: ReleasedFile | undefined): void {
    this.status = {
      phase: "updated", since: now(), held: [], waiting: [], log: [...(released?.log ?? [])],
      id: predecessor?.update?.id, by: predecessor?.update?.by, up: { commit: v.commit, subject: v.subject, previous: predecessor?.commit },
    };
    const from = predecessor ? ` (was ${predecessor.commit})` : "";
    this.note(released
      ? `up: ${v.commit} ${v.subject}${from}; the predecessor handed over`
      : `up: ${v.commit} ${v.subject}${from}; the predecessor exited without handing over`);
    this.pushing = this.pushAfterDeploy(released?.ref);
  }

  /** The deploy is up: push it (a live instance's main only). Whatever happens, the deploy stands. */
  private async pushAfterDeploy(ref: string | undefined): Promise<void> {
    const v = await version(this.root);
    const push = await pushDeployed({ root: this.root, ref, live: v.live, run: this.o.git });
    this.status = { ...this.status, push };
    this.note(push.result === "pushed" ? `pushed: ${push.text}`
      : push.result === "failed" ? `push failed: ${push.text}; the deploy stands`
      : `not pushed: ${push.text}`);
    this.o.settled();
  }

  /**
   * The outcome to tell the orchestrator that asked for this update, once the update has settled: up (with its push)
   * or failed. None for an update the user started, or while one is still under way.
   */
  notice(): UpdateNotice | undefined {
    const s = this.status;
    if (!s.id || !s.by) return undefined;
    if (s.phase === "updated" && s.push && s.up) {
      const push = s.push.result === "pushed" ? ` Pushed: ${s.push.text}.` : s.push.result === "failed" ? ` The push failed: ${s.push.text}.` : ` Not pushed: ${s.push.text}.`;
      return {
        key: `notify:update:${s.id}:updated`, by: s.by,
        fact: `Nexus was updated as asked: ${s.up.commit} "${s.up.subject}" is up${s.up.previous ? ` (was ${s.up.previous})` : ""}.${push}`,
        todo: "You restarted with it; tell the user briefly, with anything the held queues need.",
      };
    }
    if (s.phase === "failed") {
      const still = this.from ? `${this.from.short} "${this.from.subject}"` : "the version from before the update";
      return {
        key: `notify:update:${s.id}:failed`, by: s.by,
        fact: `The Nexus update you ran failed: ${s.error ?? "no reason given"}. Still running: ${still}${s.held.length ? `; the queues it held (${s.held.join(", ")}) go on` : ""}.`,
        todo: "Tell the user briefly, with what you propose.",
      };
    }
    return undefined;
  }

  start(opts: { now?: boolean; ref?: string; by?: UpdateAsker }): UpdateStatus {
    if (this.busy) throw new Error(`an update is already ${this.status.phase}`);
    const held: string[] = [];
    for (const p of this.parts()) for (const q of p.drain(!!opts.now)) held.push(`${p.id}/${q}`);
    this.status = { phase: "draining", since: now(), now: !!opts.now, ref: opts.ref || "main", held, waiting: [], log: [], id: newId(), by: opts.by };
    this.from = undefined;
    this.note(held.length ? `holding ${held.join(", ")} at the end of their current step` : "no queue is running");
    this.timer = setInterval(() => void this.tick(), 2000);
    void this.tick();
    return this.status;
  }

  /** Gives up waiting: the held queues go on. */
  cancel(): void {
    if (this.status.phase !== "draining") throw new Error("nothing to cancel");
    clearInterval(this.timer);
    for (const p of this.parts()) p.cancel();
    this.status = { ...this.status, phase: "idle", waiting: [] };
    this.note("cancelled; the held queues go on");
    this.o.settled();
  }

  private note(text: string): void {
    this.status.log.push(`${new Date().toLocaleTimeString("en-GB")} ${text}`);
    console.log(`update: ${text}`);
    this.changed();
  }

  private async tick(): Promise<void> {
    if (this.status.phase !== "draining") return;
    const waiting = this.parts().filter((p) => !p.idle()).map((p) => p.id);
    if (waiting.join() !== this.status.waiting.join()) { this.status.waiting = waiting; this.changed(); }
    if (waiting.length) return;
    clearInterval(this.timer);
    this.status.phase = "updating";
    try {
      await this.update();
    } catch (err) {
      // Nothing was handed over: this server still runs and owns the files. Only the worktree may have moved.
      const back = await this.restoreWorktree();
      for (const p of this.parts()) p.cancel(); // first: the notices held while draining may go out once it settles
      this.fail(`${firstLine(err)}${back}`, `${(err as Error).message.slice(0, 2000)}${back}`);
      return;
    }
    await this.restart();
  }

  private async update(): Promise<void> {
    const v = await version(this.root);
    const sha = await git(this.root, "rev-parse", "HEAD");
    this.from = { sha, short: v.commit, subject: v.subject, live: v.live, lock: hashOf(join(this.root, "package-lock.json")) };
    if (v.live) {
      // Content, not file stamps: npm rewrites line endings of package bins, which only looks like a change.
      const changed = await git(this.root, "diff", "--name-only", "HEAD");
      if (changed) throw new Error(`the live worktree ${this.root} has local changes (${changed.split("\n").join(", ")}); it should only ever be updated`);
      const target = await git(this.root, "rev-parse", "--short", `${this.status.ref}^{commit}`);
      this.note(`moving the live worktree from ${v.commit} to ${target} (${this.status.ref})`);
      await git(this.root, "checkout", "--force", "--detach", this.status.ref!); // forced: only line-ending leftovers differ
    } else {
      this.note(`running from a development checkout (branch ${v.branch}): rebuilding and restarting without moving it`);
    }
    if (hashOf(join(this.root, "package-lock.json")) !== this.from.lock) {
      this.note("dependencies changed: npm install");
      await this.o.npm(this.root, "install", "--no-audit", "--no-fund");
    }
    this.note("building the dashboard");
    await this.o.npm(this.root, "run", "build", "-w", "@nexus/web");
  }

  /** Hands over to the successor and exits; when the successor does not come up, rolls back and goes on. */
  private async restart(): Promise<void> {
    this.status.phase = "restarting";
    this.note("restarting");
    let result: Awaited<ReturnType<typeof handOver>>;
    try {
      const v = await version(this.root);
      result = await handOver({
        command: this.o.successor, cwd: this.root,
        // The successor writes its own log (NEXUS_LOG): see main.ts.
        env: { ...process.env, NEXUS_WAIT_PORT: "60", NEXUS_LOG: process.env.NEXUS_LOG ?? "1" },
        // What this server runs: the commit the update started from (the worktree has moved on by now).
        version: this.from ? { commit: this.from.short, subject: this.from.subject } : { commit: v.commit, subject: v.subject },
        release: this.o.release, note: (t) => this.note(t), log: () => this.status.log,
        ref: this.status.ref, update: { id: this.status.id!, by: this.status.by }, timeoutMs: this.o.timeoutMs,
      });
    } catch (err) {
      result = { outcome: "failed", reason: `the hand-over failed: ${firstLine(err)}`, pid: undefined };
    }
    if (result.outcome === "ready") { this.o.exit(); return; }
    await this.rollBack(result.outcome === "timeout" ? `the successor sent no ready signal within ${Math.round(this.o.timeoutMs / 1000)} s` : result.reason, result.pid);
  }

  /**
   * The successor did not come up: stop it and what it started, put the worktree back, take the port again and go
   * on. This server's code never changed (it runs from memory); what the next start and the dashboard read from
   * disk is what has to go back.
   */
  private async rollBack(reason: string, pid: number | undefined): Promise<void> {
    this.note(`rolling back: ${reason}`);
    if (pid !== undefined && isAlive(pid)) {
      await stopTree(pid);
      this.note(`stopped the successor (pid ${pid}) and what it started`);
    }
    const back = await this.restoreWorktree();
    try {
      await this.o.reacquire();
    } catch (err) {
      this.fail(`${reason}${back}; could not take the port again: ${firstLine(err)}`);
      return;
    }
    this.fail(`${reason}${back}`);
  }

  /** Puts a live worktree back where the update found it; says what it did, for the error. */
  private async restoreWorktree(): Promise<string> {
    const from = this.from;
    if (!from) return "";
    if (!from.live) { this.note("a development checkout is not moved: this server goes on"); return "; this server goes on (a development checkout is not moved)"; }
    try {
      const head = await git(this.root, "rev-parse", "HEAD");
      if (head === from.sha) return `; rolled back to ${from.short}`; // never moved
      this.note(`moving the live worktree back to ${from.short}`);
      // node_modules follows the lock the update installed (or half installed): compare with that one.
      const updated = hashOf(join(this.root, "package-lock.json"));
      await git(this.root, "checkout", "--force", "--detach", from.sha);
      if (hashOf(join(this.root, "package-lock.json")) !== updated) {
        this.note("dependencies changed back: npm install");
        await this.o.npm(this.root, "install", "--no-audit", "--no-fund");
      }
      this.note("rebuilding the dashboard");
      await this.o.npm(this.root, "run", "build", "-w", "@nexus/web");
      return `; rolled back to ${from.short}`;
    } catch (err) {
      this.note(`rolling the worktree back failed: ${firstLine(err)}`);
      return `; rolling the worktree back to ${from.short} failed (${firstLine(err)}): put it back by hand before the next start`;
    }
  }

  private fail(summary: string, error = summary): void {
    this.status = { ...this.status, phase: "failed", error };
    this.note(`update failed: ${summary}; the held queues go on`);
    this.o.notify(`Update failed: ${summary}.`);
    this.o.settled();
  }
}
