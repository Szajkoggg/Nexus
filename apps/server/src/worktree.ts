// A queue's working directory: the project's checkout, a path the queue names, or (`worktree: auto`) a git worktree
// with a branch of its own that Nexus creates beside the checkout when the queue first starts, and the project's worktree
// setup command, run once in each worktree Nexus makes.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ActionError, normPath, now, type ProjectState, type ProjectStore, type QueueView } from "@nexus/protocol";
import { recordBase } from "./gitinfo.ts";

/** Two paths name the same folder (Windows: case does not matter, nor the kind of slash). */
export const samePath = (a: string, b: string): boolean => normPath(a).toLowerCase() === normPath(b).toLowerCase();

/**
 * The checkout a queue works in, without creating anything: its worktree path, the one `auto` will create, or the
 * project's own checkout.
 */
export function checkoutPath(state: Pick<ProjectState, "project">, q: Pick<QueueView, "id" | "worktree">): string {
  if (q.worktree && q.worktree !== "auto") return normPath(q.worktree);
  if (q.worktree !== "auto") return normPath(state.project.root);
  const root = state.project.root;
  const dir = normPath(state.project.defaults.worktree_dir ?? join(dirname(root), `${basename(root)}.worktrees`));
  return normPath(join(dir, q.id));
}

/** A queue's working directory: its worktree (created when it says `auto`), else the project's checkout. */
export function worktreeFor(store: ProjectStore, state: ProjectState, q: QueueView): string {
  if (q.worktree !== "auto") {
    const path = checkoutPath(state, q);
    // A worktree the queue names by path is its own too (unless it is the project's checkout): it ends with the
    // integration step.
    if (q.worktree && !q.integration && !samePath(path, state.project.root)) store.writeQueue({ ...store.readQueue(q.id), integration: true, updated_at: now() });
    return path;
  }
  const root = state.project.root;
  const path = checkoutPath(state, q);
  const branch = q.branch ?? `nexus/${q.id}`;
  if (!existsSync(path)) {
    const exists = (() => { try { execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root, stdio: "ignore" }); return true; } catch { return false; } })();
    const args = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, q.base ?? "HEAD"];
    // What a new branch is made from, for its ahead/behind on the dashboard (before the worktree moves anything).
    if (!exists) recordBase(store, q, root);
    try { execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { throw new ActionError(`could not create the worktree: ${(e as { stderr?: Buffer }).stderr?.toString().trim() || (e as Error).message}`, 500); }
    // A new worktree gets the project's setup command once, before its first step (the engine runs it: setupPending).
    const command = state.project.defaults.worktree_setup?.trim();
    if (command) store.writeGit(q.id, { ...(store.readGit(q.id) ?? { protocol: 1, steps: {} }), setup: { command, at: now() } });
  }
  // Marked as a queue with a worktree of its own, so it keeps its integration step once `worktree` names the path.
  store.writeQueue({ ...store.readQueue(q.id), worktree: path, branch, integration: true, updated_at: now() });
  return path;
}

/** The branch checked out in `cwd`; null when there is none (detached, not a repository). */
export function gitBranch(cwd: string): string | null {
  try { return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

// ---------------------------------------------------------------- the worktree setup command

/**
 * The setup command still to run in the queue's new worktree (made by Nexus, not yet set up successfully): the
 * project's command now, so one the user corrected after a failure is the one that runs again. None when the project
 * has no command any more.
 */
export function setupPending(store: ProjectStore, queueId: string): string | undefined {
  const setup = store.readGit(queueId)?.setup;
  if (!setup || setup.done_at) return undefined;
  return store.readProject().defaults.worktree_setup?.trim() || undefined;
}

/**
 * Records how a run of the setup command ended: done, or its failure with the reason (it runs again before the next
 * step).
 */
export function recordSetup(store: ProjectStore, queueId: string, command: string, failure?: string): void {
  const git = store.readGit(queueId);
  if (!git?.setup) return;
  const setup = failure ? { ...git.setup, command, failed: { at: now(), reason: failure } } : { ...git.setup, command, done_at: now() };
  store.writeGit(queueId, { ...git, setup });
}

/** How long the setup command may run before it counts as failed. */
export const SETUP_LIMIT_MS = 30 * 60_000;
const OUTPUT_TAIL = 1500;

/**
 * Runs a setup command through the shell in `cwd`. Resolves with undefined when it succeeded, else with the reason (the
 * exit code or what stopped it, and the end of its output). `started`: the process, so its owner can end it.
 */
export function runSetup(command: string, cwd: string, o: { limitMs?: number; started?: (p: ChildProcess) => void } = {}): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    const keep = (b: Buffer) => { out = (out + b.toString()).slice(-OUTPUT_TAIL * 2); };
    let child: ChildProcess;
    try { child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return resolve(`it could not start: ${(e as Error).message}`); }
    o.started?.(child);
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, o.limitMs ?? SETUP_LIMIT_MS);
    const tail = () => { const t = out.trim().slice(-OUTPUT_TAIL); return t ? `; its output ends: ${t}` : ""; };
    child.on("error", (e) => { clearTimeout(timer); resolve(`it could not start: ${e.message}`); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) resolve(`it ran longer than ${Math.round((o.limitMs ?? SETUP_LIMIT_MS) / 60_000)} minutes and was ended${tail()}`);
      else if (code === 0) resolve(undefined);
      else resolve(`${code === null ? `it was ended (${signal})` : `exit code ${code}`}${tail()}`);
    });
  });
}
