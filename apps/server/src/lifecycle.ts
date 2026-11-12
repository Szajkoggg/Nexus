// Updating Nexus while it works: drain, update the checkout, build, restart, and resume what the drain held.
//
// The live instance runs from its own git worktree on a detached HEAD (scripts/live.ps1 creates it); development
// happens in another checkout. An update first lets every running step finish (or interrupts it with `now`): queues
// stop at their step's end, marked to be resumed. When no agent is in a turn, the live worktree moves to the new
// commit, installs what changed, builds the dashboard, and the server starts its successor and exits. The successor
// waits for the port, then resumes the marked queues. If anything fails before the restart, the old version goes on
// and the held queues resume at once.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { nexusHome, now } from "@nexus/protocol";

const run = promisify(execFile);
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAIN = join(ROOT, "apps/server/src/main.ts");

export interface Drainable { id: string; idle(): boolean; drain(now: boolean): string[]; cancel(): void; shutdown(): void }

export interface UpdateStatus {
  phase: "idle" | "draining" | "updating" | "restarting" | "failed";
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
async function npm(...args: string[]): Promise<void> {
  await run(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: ROOT, windowsHide: true, shell: process.platform === "win32", maxBuffer: 32 * 1024 * 1024 });
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

  constructor(parts: () => Drainable[], changed: () => void = () => {}) { this.parts = parts; this.changed = changed; }

  get busy(): boolean { return this.status.phase !== "idle" && this.status.phase !== "failed"; }

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
      this.restart();
    } catch (err) {
      this.status = { ...this.status, phase: "failed", error: (err as Error).message.slice(0, 2000) };
      this.note(`failed: ${(err as Error).message.split("\n")[0]}; the current version goes on`);
      for (const p of this.parts()) p.cancel();
    }
  }

  private async update(): Promise<void> {
    const v = await version();
    const lock = hashOf(join(ROOT, "package-lock.json"));
    if (v.live) {
      if (await git("status", "--porcelain", "--untracked-files=no")) throw new Error(`the live worktree ${ROOT} has local changes; it should only ever be updated`);
      const target = await git("rev-parse", "--short", `${this.status.ref}^{commit}`);
      this.note(`moving the live worktree from ${v.commit} to ${target} (${this.status.ref})`);
      await git("checkout", "--detach", this.status.ref!);
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

  /** Starts the successor (it waits for the port) and exits. Agents are all between turns by now. */
  private restart(): void {
    this.status.phase = "restarting";
    this.note("restarting");
    mkdirSync(nexusHome(), { recursive: true });
    const log = openSync(join(nexusHome(), "server.log"), "a");
    spawn(process.execPath, [MAIN], {
      cwd: ROOT, detached: true, windowsHide: true, stdio: ["ignore", log, log],
      env: { ...process.env, NEXUS_WAIT_PORT: "60" },
    }).unref();
    for (const p of this.parts()) p.shutdown();
    setTimeout(() => process.exit(0), 300);
  }
}
