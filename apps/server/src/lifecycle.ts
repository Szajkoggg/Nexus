// Updating Nexus while it works: drain, update the checkout, build, restart, and resume what the drain held.
//
// The live instance runs from its own git worktree on a detached HEAD (scripts/live.ps1 creates it); development
// happens in another checkout. An update first lets every running step finish (or interrupts it with `now`): queues
// stop at their step's end, marked to be resumed. When no agent is in a turn, the live worktree moves to the new
// commit, installs what changed, builds the dashboard, and the server hands over to its successor (src/handover.ts):
// it stops every agent and its own writing, frees the port, starts the successor and exits once the successor has
// passed its smoke check. The successor then resumes the marked queues. If anything fails before the restart, the
// old version goes on and the held queues resume at once.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { now } from "@nexus/protocol";
import { handOver, type PredecessorFile, type ReleasedFile } from "./handover.ts";

const run = promisify(execFile);
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAIN = join(ROOT, "apps/server/src/main.ts");

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
}

async function git(...args: string[]): Promise<string> {
  return (await run("git", args, { cwd: ROOT, windowsHide: true })).stdout.trim();
}
/** npm through this Node (npm-cli.js beside it), so no shell is needed for npm.cmd on Windows. */
async function npm(...args: string[]): Promise<void> {
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(cli)) await run(process.execPath, [cli, ...args], { cwd: ROOT, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  else await run("npm", args, { cwd: ROOT, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}
const hashOf = (file: string) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "");

/** What this server runs: its commit, and whether it is a live worktree (detached HEAD) or a development checkout. */
export async function version(): Promise<{ commit: string; subject: string; live: boolean; branch: string | null; root: string }> {
  const [commit, subject] = (await git("log", "-1", "--format=%h%x09%s").catch(() => "?\t")).split("\t");
  const branch = await git("symbolic-ref", "-q", "--short", "HEAD").catch(() => "");
  return { commit: commit ?? "?", subject: subject ?? "", live: !branch, branch: branch || null, root: ROOT };
}

export class Lifecycle {
  status: UpdateStatus = { phase: "idle", held: [], waiting: [], log: [] };
  private timer?: NodeJS.Timeout;
  private readonly parts: () => Drainable[];
  private readonly changed: () => void;
  /** Stops every agent and every write of this server and frees the port (main.ts). */
  private readonly release: () => Promise<void>;

  constructor(parts: () => Drainable[], changed: () => void = () => {}, release: () => Promise<void> = async () => {}) {
    this.parts = parts; this.changed = changed; this.release = release;
  }

  get busy(): boolean { return this.status.phase === "draining" || this.status.phase === "updating" || this.status.phase === "restarting"; }

  /** This server took over from its predecessor: the update's log (the predecessor's lines first) and what is up. */
  arrived(v: { commit: string; subject: string }, predecessor: PredecessorFile | undefined, released: ReleasedFile | undefined): void {
    this.status = { phase: "updated", since: now(), held: [], waiting: [], log: [...(released?.log ?? [])] };
    const from = predecessor ? ` (was ${predecessor.commit})` : "";
    this.note(released
      ? `up: ${v.commit} ${v.subject}${from}; the predecessor handed over`
      : `up: ${v.commit} ${v.subject}${from}; the predecessor exited without handing over`);
  }

  start(opts: { now?: boolean; ref?: string }): UpdateStatus {
    if (this.busy) throw new Error(`an update is already ${this.status.phase}`);
    const held: string[] = [];
    for (const p of this.parts()) for (const q of p.drain(!!opts.now)) held.push(`${p.id}/${q}`);
    this.status = { phase: "draining", since: now(), now: !!opts.now, ref: opts.ref || "main", held, waiting: [], log: [] };
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
      this.status = { ...this.status, phase: "failed", error: (err as Error).message.slice(0, 2000) };
      this.note(`failed: ${(err as Error).message.split("\n")[0]}; the current version goes on`);
      for (const p of this.parts()) p.cancel();
      return;
    }
    await this.restart();
  }

  private async update(): Promise<void> {
    const v = await version();
    const lock = hashOf(join(ROOT, "package-lock.json"));
    if (v.live) {
      // Content, not file stamps: npm rewrites line endings of package bins, which only looks like a change.
      const changed = await git("diff", "--name-only", "HEAD");
      if (changed) throw new Error(`the live worktree ${ROOT} has local changes (${changed.split("\n").join(", ")}); it should only ever be updated`);
      const target = await git("rev-parse", "--short", `${this.status.ref}^{commit}`);
      this.note(`moving the live worktree from ${v.commit} to ${target} (${this.status.ref})`);
      await git("checkout", "--force", "--detach", this.status.ref!); // forced: only line-ending leftovers differ
    } else {
      this.note(`running from a development checkout (branch ${v.branch}): rebuilding and restarting without moving it`);
    }
    if (hashOf(join(ROOT, "package-lock.json")) !== lock) {
      this.note("dependencies changed: npm install");
      await npm("install", "--no-audit", "--no-fund");
    }
    this.note("building the dashboard");
    await npm("run", "build", "-w", "@nexus/web");
  }

  /**
   * Hands over to the successor and exits. Agents are all between turns by now. Without a ready signal (a failed
   * smoke check, an early exit, the time limit) this server still exits: rolling back is not built yet.
   */
  private async restart(): Promise<void> {
    this.status.phase = "restarting";
    this.note("restarting");
    try {
      const v = await version();
      await handOver({
        command: [process.execPath, MAIN], cwd: ROOT,
        // The successor writes its own log (NEXUS_LOG): see main.ts.
        env: { ...process.env, NEXUS_WAIT_PORT: "60", NEXUS_LOG: process.env.NEXUS_LOG ?? "1" },
        version: { commit: v.commit, subject: v.subject },
        release: this.release, note: (t) => this.note(t), log: () => this.status.log,
      });
    } catch (err) {
      this.note(`hand-over failed: ${(err as Error).message}`);
    }
    setTimeout(() => process.exit(0), 300);
  }
}
