// Handing the server over to its successor after an update, so that exactly one server writes the projects' files
// at any time and the old one goes only once the new one has proved it is up.
//
// The two servers talk through files in <NEXUS_HOME>/handover/<id>/, each with one writer:
//   predecessor.json   predecessor   its pid and version, written before it starts the successor
//   ready.json         successor     it listens, its API answers and every registered project's state loads
//   failed.json        successor     its smoke check failed (it exits without ready.json)
//   released.json      predecessor   it saw ready.json, has stopped writing for good and exits; carries its update log
// The predecessor stops every agent and its own writing and frees the port before it starts the successor, then
// waits up to HANDOVER_TIMEOUT_MS for ready.json. The successor (NEXUS_HANDOVER names the folder) stays read-only
// until released.json appears or the predecessor's process is gone: no recovery, no resume, no agent, no write under
// any project's .nexus/. Without ready.json the predecessor rolls back (src/lifecycle.ts) and never releases.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, loadProjectState, newId, nexusHome, now, readRegistry } from "@nexus/protocol";

/** How long a predecessor waits for its successor's ready signal. */
export const HANDOVER_TIMEOUT_MS = 60_000;
const POLL_MS = 200;

export interface Version { commit: string; subject: string }
export interface PredecessorFile extends Version { pid: number; at: string }
export interface ReadyFile extends Version { pid: number; at: string }
export interface FailedFile { pid: number; at: string; reason: string }
export interface ReleasedFile { at: string; log: string[] }

const read = <T>(dir: string, name: string): T | undefined => {
  const f = join(dir, name);
  if (!existsSync(f)) return undefined;
  try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return undefined; } // half written: next poll
};
/** Written whole, then renamed: the other side never reads half a file. */
const write = (dir: string, name: string, value: unknown) => {
  const f = join(dir, name);
  writeFileSync(f + ".tmp", JSON.stringify(value, null, 2));
  renameSync(f + ".tmp", f);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// ---------------------------------------------------------------- the predecessor

/** `pid`: the successor's process, so that a predecessor can stop it. */
export type HandoverOutcome =
  | { outcome: "ready"; successor: ReadyFile; pid: number | undefined }
  | { outcome: "failed"; reason: string; pid: number | undefined }
  | { outcome: "timeout"; pid: number | undefined };

export interface HandoverOptions {
  /** The successor's command line: [node, script, ...]. */
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** This server's version, for the successor's log. */
  version: Version;
  /** Stops every agent and every write of this server and frees the port. Resolves when that is done. */
  release: () => Promise<void>;
  note: (text: string) => void;
  /** This update's log so far; it goes to the successor with released.json. */
  log: () => string[];
  timeoutMs?: number;
}

/**
 * Starts the successor and waits for its ready signal. On "ready" released.json is written and the caller exits;
 * on a failure or time-out the caller rolls back (src/lifecycle.ts), and the successor, never released, stays idle.
 */
export async function handOver(o: HandoverOptions): Promise<HandoverOutcome> {
  const timeoutMs = o.timeoutMs ?? HANDOVER_TIMEOUT_MS;
  // Only one update runs at a time: the folders of earlier hand-overs are finished; the last one stays for reading.
  const root = join(nexusHome(), "handover");
  if (existsSync(root)) for (const d of readdirSync(root)) rmSync(join(root, d), { recursive: true, force: true });
  const dir = join(root, newId());
  mkdirSync(dir, { recursive: true });
  write(dir, "predecessor.json", { pid: process.pid, ...o.version, at: now() } satisfies PredecessorFile);
  await o.release();
  o.note(`stopped every agent and freed the port; starting the successor (waiting up to ${Math.round(timeoutMs / 1000)} s for it)`);

  let exited: string | undefined;
  const child = spawn(o.command[0]!, o.command.slice(1), {
    cwd: o.cwd, detached: true, windowsHide: true, stdio: "ignore", env: { ...o.env, NEXUS_HANDOVER: dir },
  });
  child.on("error", (err) => { exited = `could not start: ${err.message}`; });
  child.on("exit", (code) => { exited = `exited (${code ?? "signal"}) before it was ready`; });
  child.unref();
  o.note(`the successor runs as pid ${child.pid ?? "?"}`);

  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ready = read<ReadyFile>(dir, "ready.json");
    if (ready) {
      o.note(`the successor ${ready.commit} is up (pid ${ready.pid}); handing over and exiting`);
      write(dir, "released.json", { at: now(), log: o.log() } satisfies ReleasedFile);
      return { outcome: "ready", successor: ready, pid: child.pid };
    }
    const failed = read<FailedFile>(dir, "failed.json");
    if (failed) { o.note(`the successor failed its smoke check: ${failed.reason}`); return { outcome: "failed", reason: `the successor failed its smoke check: ${failed.reason}`, pid: child.pid }; }
    if (exited) { o.note(`the successor ${exited}`); return { outcome: "failed", reason: `the successor ${exited}`, pid: child.pid }; }
    await sleep(POLL_MS);
  }
  o.note(`the successor sent no ready signal within ${Math.round(timeoutMs / 1000)} s`);
  return { outcome: "timeout", pid: child.pid };
}

// ---------------------------------------------------------------- the successor

/**
 * The checks a successor passes before it says it is up: its HTTP API answers (and the dashboard, if built), and
 * every registered project's state loads. Returns what failed; empty when all is well. Reads only.
 */
export async function smokeCheck(base: string, dashboard: boolean): Promise<string[]> {
  const problems: string[] = [];
  const get = async (path: string) => {
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) problems.push(`GET ${path} answered ${r.status}`);
      return r.ok ? r : undefined;
    } catch (e) { problems.push(`GET ${path}: ${(e as Error).message}`); return undefined; }
  };
  const server = await get("/api/server");
  if (server && typeof ((await server.json().catch(() => ({}))) as { commit?: unknown }).commit !== "string") problems.push("GET /api/server gave no version");
  if (dashboard) await get("/");
  for (const p of readRegistry().projects) {
    try { loadProjectState(ProjectStore.forRoot(p.root)); }
    catch (e) { problems.push(`project ${p.id} (${p.root}) does not load: ${(e as Error).message.split("\n")[0]}`); }
  }
  return problems;
}

/** The successor's side of the folder named by NEXUS_HANDOVER. */
export class Standby {
  readonly dir: string;
  constructor(dir: string) { this.dir = dir; }

  predecessor(): PredecessorFile | undefined { return read<PredecessorFile>(this.dir, "predecessor.json"); }

  ready(version: Version): void { write(this.dir, "ready.json", { pid: process.pid, ...version, at: now() } satisfies ReadyFile); }

  failed(reason: string): void { write(this.dir, "failed.json", { pid: process.pid, at: now(), reason } satisfies FailedFile); }

  /**
   * Resolves once the predecessor has stopped writing for good: it wrote released.json, or its process is gone (it
   * gave up waiting, or it is an old one). Waits as long as the predecessor lives; it waits a bounded time itself.
   */
  async released(): Promise<{ released: ReleasedFile | undefined; predecessor: PredecessorFile | undefined }> {
    const predecessor = this.predecessor();
    for (;;) {
      const released = read<ReleasedFile>(this.dir, "released.json");
      if (released) return { released, predecessor };
      if (!predecessor || !isAlive(predecessor.pid)) return { released: undefined, predecessor };
      await sleep(POLL_MS);
    }
  }
}
