// A queue's working directory: the project's checkout, a path the queue names, or (`worktree: auto`) a git worktree
// with a branch of its own that Nexus creates beside the checkout when the queue first starts.
import { execFileSync } from "node:child_process";
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
  if (q.worktree !== "auto") return checkoutPath(state, q);
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
  }
  store.writeQueue({ ...store.readQueue(q.id), worktree: path, branch, updated_at: now() });
  return path;
}

/** The branch checked out in `cwd`; null when there is none (detached, not a repository). */
export function gitBranch(cwd: string): string | null {
  try { return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}
