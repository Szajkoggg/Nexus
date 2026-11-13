// Merge back and clean up a finished worktree queue: the user's actions only (dashboard writes; no CLI command, no
// event), each confirmed in the dashboard and done by the server, with local git only.
//
// Merge: in the worktree where the queue's base branch is checked out, `git merge` of the queue's branch: a
// fast-forward when possible, else a merge commit. Refused when that worktree has uncommitted changes, a run is going
// there, the base is checked out nowhere (or only detached), or it is this server's own live worktree. On a conflict
// the merge is aborted, so nothing is left half-done.
//
// Cleanup: `git worktree remove` (never --force) and `git branch -d` (never -D). Refused, before anything is removed,
// when the worktree has uncommitted changes or the branch is not merged.
import { existsSync } from "node:fs";
import { ActionError, loadProjectState, normPath, now, type ProjectStore } from "@nexus/protocol";
import { checkoutOf, git } from "./gitinfo.ts";
import { ROOT } from "./lifecycle.ts";
import { execFileSync } from "node:child_process";

const GOING = ["running", "pausing", "usage_wait", "retry_wait"];
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" };
const same = (a: string, b: string) => normPath(a).toLowerCase() === normPath(b).toLowerCase();

/** Runs git, returning its output or throwing with what git said. */
function run(cwd: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: ENV, windowsHide: true, timeout: 60_000 }).trim(); }
  catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    throw new Error([err.stdout, err.stderr].filter(Boolean).join("\n").trim() || err.message);
  }
}

interface Worktree { path: string; branch: string | undefined; detached: boolean }
function worktrees(root: string): Worktree[] {
  const out = git(root, ["worktree", "list", "--porcelain"]) ?? "";
  return out.split(/\r?\n\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    const branch = lines.find((l) => l.startsWith("branch refs/heads/"))?.slice(18);
    return path ? { path: normPath(path), branch, detached: lines.includes("detached") } : undefined;
  }).filter((w): w is Worktree => !!w);
}

/** A finished queue with a worktree of its own, its branch and base. */
function finishedWorktreeQueue(store: ProjectStore, queueId: string) {
  const state = loadProjectState(store);
  const q = state.queues.find((x) => x.id === queueId);
  if (!q) throw new ActionError(`unknown queue ${queueId}`, 404);
  const root = normPath(state.project.root);
  const path = checkoutOf(store, q);
  if (!path || same(path, root)) throw new ActionError(`queue ${queueId} works in the project's own checkout, not a worktree of its own`, 409);
  if (q.status !== "done") throw new ActionError(`queue ${queueId} is not finished (it is ${q.status})`, 409);
  if (q.run && GOING.includes(q.run.state)) throw new ActionError(`queue ${queueId}'s run is still going`, 409);
  if (q.git?.cleaned) throw new ActionError(`queue ${queueId} was cleaned up already`, 409);
  const branch = q.branch ?? (existsSync(path) ? git(path, ["branch", "--show-current"]) : undefined);
  if (!branch) throw new ActionError(`queue ${queueId} has no branch`, 409);
  if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) === undefined) throw new ActionError(`branch ${branch} does not exist`, 409);
  return { state, q, root, path, branch, base: q.git?.base };
}

/** The user's merge of a finished worktree queue's branch into its base. */
export function mergeBack(store: ProjectStore, queueId: string, serverRoot = ROOT): string {
  const { state, q, root, branch, base } = finishedWorktreeQueue(store, queueId);
  if (!base || base.branch === false) throw new ActionError(`queue ${queueId}'s base is not known as a branch${base ? ` (${base.ref})` : ""}: merge it by hand`, 409);
  const target = worktrees(root).find((w) => w.branch === base.ref);
  if (!target) throw new ActionError(`branch ${base.ref} is not checked out in any worktree (or only detached): check it out, then merge`, 409);
  // This server's own checkout when it runs as the live instance: never touched by a merge.
  if (same(target.path, serverRoot) && git(serverRoot, ["branch", "--show-current"]) === "") throw new ActionError("the base is checked out in the live worktree: Nexus does not merge there", 409);
  const dirty = git(target.path, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty === undefined) throw new ActionError(`cannot read the state of ${target.path}`, 409);
  if (dirty) throw new ActionError(`${target.path} has uncommitted changes: commit or stash them, then merge`, 409);
  const busy = state.queues.find((x) => x.run && GOING.includes(x.run.state) && (() => { const p = checkoutOf(store, x); return !!p && same(p, target.path); })());
  if (busy) throw new ActionError(`queue ${busy.id} is running in ${target.path}: merge once it is not`, 409);

  const tip = run(root, ["rev-parse", `refs/heads/${branch}`]);
  if (git(root, ["merge-base", "--is-ancestor", tip, `refs/heads/${base.ref}`]) !== undefined) return `${branch} is already merged into ${base.ref}`;
  const before = run(target.path, ["rev-parse", "HEAD"]);
  try {
    run(target.path, ["merge", "--no-edit", "-m", `Merge ${branch} (queue ${q.id}: ${q.title})`, branch]);
  } catch (e) {
    const conflicts = git(target.path, ["diff", "--name-only", "--diff-filter=U"]) ?? "";
    if (git(target.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]) !== undefined) run(target.path, ["merge", "--abort"]);
    const after = git(target.path, ["rev-parse", "HEAD"]);
    const clean = after === before && !git(target.path, ["status", "--porcelain", "--untracked-files=no"]);
    throw new ActionError(`the merge of ${branch} into ${base.ref} ${conflicts ? `conflicts in ${conflicts.split(/\r?\n/).join(", ")}` : `failed: ${(e as Error).message.split("\n")[0]}`}; ${clean ? "it was aborted, nothing changed" : "it was aborted, but the worktree is not as it was: look at it"}`, 409);
  }
  const sha = run(target.path, ["rev-parse", "HEAD"]);
  const fastForward = sha === tip;
  const g = store.readGit(q.id) ?? { protocol: 1 as const, steps: {} };
  store.writeGit(q.id, { ...g, merged: { at: now(), into: base.ref, path: target.path, sha, fast_forward: fastForward } });
  return `${branch} merged into ${base.ref} in ${target.path} (${fastForward ? "fast-forward" : `merge commit ${sha.slice(0, 7)}`})`;
}

/** The user's cleanup of a finished worktree queue: the worktree removed, its branch deleted with -d. */
export function cleanUp(store: ProjectStore, queueId: string): string {
  const { q, root, path, branch } = finishedWorktreeQueue(store, queueId);
  const here = existsSync(path);
  if (here) {
    const dirty = git(path, ["status", "--porcelain"]);
    if (dirty === undefined) throw new ActionError(`cannot read the state of ${path}`, 409);
    if (dirty) throw new ActionError(`${path} has uncommitted changes (${dirty.split(/\r?\n/).length} file${dirty.includes("\n") ? "s" : ""}): commit or discard them first; nothing was removed`, 409);
  }
  // `git branch -d` deletes only a branch merged into its upstream, else into HEAD; checked first, so that a refusal
  // leaves the worktree in place. HEAD is the base's, where it is checked out, else the project's checkout.
  const baseTree = q.git?.base ? worktrees(root).find((w) => w.branch === q.git!.base!.ref)?.path : undefined;
  const cwd = baseTree && !same(baseTree, path) ? baseTree : root;
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);
  const into = upstream ? `refs/remotes/${upstream}` : "HEAD";
  if (git(cwd, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, into]) === undefined) {
    throw new ActionError(`${branch} is not merged into ${upstream ?? git(cwd, ["branch", "--show-current"]) ?? "HEAD"}: merge it first; nothing was removed`, 409);
  }
  if (here) run(root, ["worktree", "remove", path]);
  else run(root, ["worktree", "prune"]);
  run(cwd, ["branch", "-d", branch]);
  const g = store.readGit(q.id) ?? { protocol: 1 as const, steps: {} };
  store.writeGit(q.id, { ...g, cleaned: { at: now(), path, branch } });
  return `the worktree ${path} is removed and branch ${branch} deleted`;
}

