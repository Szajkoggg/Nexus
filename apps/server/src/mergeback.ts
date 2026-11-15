// Merging a worktree queue back into its base, and cleaning up after it, with local git only.
//
// A queue with an integration step (PROTOCOL.md, "The integration step") goes back one way only: its base moves
// forward to the integrated commit (`git merge --ff-only`), never with a merge commit on the base. Nexus does it by
// itself when the project's merge_back is on (src/merger.ts), the user with Merge back in the dashboard; both go
// through judgeMerge and fastForward here, one at a time (a lock per queue). When the base moved on since the
// integration, the integration step runs again instead (reintegrate). Before it moves the base, it checks what the
// user's merge checked: the base is checked out somewhere (not only detached), not in this server's live worktree,
// with no uncommitted changes to tracked files, and no step at work there.
//
// A queue from before the integration step (no `integration` mark) keeps the user's old merge: `git merge` of its
// branch in the worktree where the base is checked out, a fast-forward when possible, else a merge commit; on a
// conflict the merge is aborted, so nothing is left half-done.
//
// Cleanup: `git worktree remove` (never --force) and `git branch -d` (never -D). Refused, before anything is removed,
// when the worktree has uncommitted changes or the branch is not merged. A worktree git cannot remove for paths beyond
// Windows' 260 characters (Git for Windows without core.longpaths) is deleted by Node, and the worktree list pruned.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import {
  ActionError, HOLDING_RUN_STATES, loadProjectState, normPath, now, pendingProvisional, type GitFile, type ProjectState, type ProjectStore, type QueueView,
} from "@nexus/protocol";
import { checkoutOf, git, patchGit } from "./gitinfo.ts";
import { ROOT } from "./lifecycle.ts";
import { samePath } from "./worktree.ts";

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" };
const same = samePath;

/** How many times Nexus runs the integration step again by itself when the base moved on, before it waits for the user. */
export const REINTEGRATION_LIMIT = 2;

/** Runs git, returning its output or throwing with what git said. */
function run(cwd: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: ENV, windowsHide: true, timeout: 60_000 }).trim(); }
  catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    throw new Error([err.stdout, err.stderr].filter(Boolean).join("\n").trim() || err.message);
  }
}

const isAncestor = (cwd: string, a: string, b: string) => git(cwd, ["merge-base", "--is-ancestor", a, b]) !== undefined;

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

// ---------------------------------------------------------------- one at a time

const locks = new Set<string>();
/** Runs `f` holding the queue's merge lock: the server and the user's Merge back never act on a queue at once. */
export function withMergeLock<T>(store: ProjectStore, queueId: string, f: () => T): T {
  const key = `${normPath(store.dir).toLowerCase()}|${queueId}`;
  if (locks.has(key)) throw new ActionError(`queue ${queueId} is being merged back right now; try again in a moment`, 409);
  locks.add(key);
  try { return f(); } finally { locks.delete(key); }
}

// ---------------------------------------------------------------- the base's checkout

/** Where the base branch is checked out, or what keeps it from being moved there now. */
export function baseCheckout(root: string, base: string, serverRoot = ROOT): { path: string } | { blocked: string } {
  const target = worktrees(root).find((w) => w.branch === base);
  if (!target) return { blocked: `branch ${base} is not checked out in any worktree (or only detached): check it out, then merge` };
  // This server's own checkout when it runs as the live instance: never touched by a merge.
  if (same(target.path, serverRoot) && git(serverRoot, ["branch", "--show-current"]) === "") return { blocked: "the base is checked out in the live worktree: Nexus does not merge there" };
  const dirty = git(target.path, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty === undefined) return { blocked: `cannot read the state of ${target.path}` };
  if (dirty) return { blocked: `${target.path} has uncommitted changes: commit or stash them, then merge` };
  return { path: target.path };
}

/** Queues whose run holds checkout `path` (the user's old merge refuses all of them). */
function runningIn(store: ProjectStore, state: ProjectState, path: string): QueueView[] {
  return state.queues.filter((x) => x.run && HOLDING_RUN_STATES.includes(x.run.state) && (() => { const p = checkoutOf(store, x); return !!p && same(p, path); })());
}

/**
 * Queues with a step at work in checkout `path`: its step running or waiting for an answer, or a pause asked for that
 * waits for the step's end. A run between steps, held, paused, or with its step in review is not at work there.
 */
export function atWorkIn(store: ProjectStore, state: ProjectState, path: string): QueueView[] {
  return runningIn(store, state, path).filter((x) => {
    if (x.run!.state === "pausing") return true;
    const st = x.run!.step ? x.steps.find((s) => s.id === x.run!.step) : undefined;
    return st?.status === "running" || st?.status === "waiting";
  });
}

// ---------------------------------------------------------------- judging a queue with an integration step

/** What merging a queue with an integration step back would do now. */
export type MergeDecision =
  /** Nothing to do (not finished, not Nexus's to do, or waiting for something the user already sees). */
  | { kind: "none"; why: string }
  /** It waits for something the user (and the orchestrator) should know of. */
  | { kind: "wait"; reason: string }
  /** Its work is in the base already. */
  | { kind: "merged"; sha: string }
  /** The base moved on since the integration: the integration step runs again. */
  | { kind: "reintegrate"; base: string; sha: string; count: number }
  /** Ready, but a step is at work in the base's checkout: wait for its end (the engine holds that run there). */
  | { kind: "hold"; path: string; busy: string[] }
  /** Ready: move the base forward to the integrated commit. */
  | { kind: "ff"; path: string; base: string; sha: string; branch: string };

/** The integration step's last round's end in git.yaml: the commit its work ended at. */
function integratedSha(g: GitFile | undefined, step: string): string | undefined {
  return g?.steps[step]?.filter((r) => r.end).at(-1)?.end ?? undefined;
}

/** The integration step's checks that failed in its latest round (each check's last result counts). */
function failedChecks(st: QueueView["steps"][number]): string[] {
  const since = st.segments.at(-1)?.start ?? "";
  const last = new Map<string, boolean>();
  for (const c of st.checks.filter((x) => x.at >= since)) last.set(c.name, c.ok);
  return [...last].filter(([, ok]) => !ok).map(([name]) => name);
}

/**
 * Judges merging back a finished queue with an integration step. `by: "nexus"` adds Nexus's own conditions: the
 * project's merge_back, its provisional_counts (unconfirmed provisional work holds it while that is off), the
 * integration step's checks, and the limit of runs again.
 */
export function judgeMerge(store: ProjectStore, state: ProjectState, q: QueueView, by: "nexus" | "user", serverRoot = ROOT): MergeDecision {
  const integ = q.steps.find((s) => s.integration);
  if (!integ) return { kind: "none", why: `queue ${q.id} has no integration step` };
  if (q.status !== "done") return { kind: "none", why: `queue ${q.id} is not finished (it is ${q.status})` };
  if (q.run && HOLDING_RUN_STATES.includes(q.run.state)) return { kind: "none", why: `queue ${q.id}'s run is still going` };
  if (q.git?.cleaned) return { kind: "none", why: `queue ${q.id} was cleaned up already` };
  const root = normPath(state.project.root);
  const base = q.git?.base;
  if (!base?.branch) return { kind: "wait", reason: `queue ${q.id}'s base is not known as a branch${base ? ` (${base.ref})` : ""}: merge it back by hand` };
  const branch = q.branch;
  const tip = branch ? git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) : undefined;
  if (!branch || !tip) return { kind: "wait", reason: `queue ${q.id}'s branch${branch ? ` ${branch}` : ""} does not exist` };
  const sha = integratedSha(q.git, integ.id);
  if (!sha) return { kind: "wait", reason: `queue ${q.id}'s integration step has no recorded commit` };
  if (tip !== sha) return { kind: "wait", reason: `queue ${q.id}'s branch ${branch} moved on after its integration step (it ended at ${sha.slice(0, 7)}, the branch is at ${tip.slice(0, 7)}): its work is not merged back` };
  const baseSha = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${base.ref}`]);
  if (!baseSha) return { kind: "wait", reason: `branch ${base.ref} does not exist` };
  if (isAncestor(root, sha, baseSha)) return { kind: "merged", sha };
  if (by === "nexus") {
    if (!state.project.defaults.merge_back) return { kind: "none", why: "merging back by itself is off (merge_back): the user merges back" };
    if (!state.project.defaults.provisional_counts && q.steps.some(pendingProvisional)) return { kind: "none", why: `queue ${q.id} has provisional work the user has not confirmed` };
    const failed = failedChecks(integ);
    if (failed.length) return { kind: "wait", reason: `the checks of queue ${q.id}'s integration step failed (${failed.join(", ")}): Nexus does not merge it back` };
  }
  if (!isAncestor(root, baseSha, sha)) {
    const count = q.git?.merge?.reintegrations ?? 0;
    if (by === "nexus" && count >= REINTEGRATION_LIMIT) {
      return { kind: "wait", reason: `${base.ref} moved on again after queue ${q.id}'s integration step ran ${count} more times: merge back runs it once more when you ask` };
    }
    return { kind: "reintegrate", base: base.ref, sha: baseSha, count };
  }
  const target = baseCheckout(root, base.ref, serverRoot);
  if ("blocked" in target) return { kind: "wait", reason: target.blocked };
  const busy = atWorkIn(store, state, target.path).filter((x) => x.id !== q.id);
  if (busy.length) return { kind: "hold", path: target.path, busy: busy.map((x) => x.id) };
  return { kind: "ff", path: target.path, base: base.ref, sha, branch };
}

/** Moves the base forward to the integrated commit (fast-forward only) and records who did it. */
export function fastForward(store: ProjectStore, q: Pick<QueueView, "id">, d: Extract<MergeDecision, { kind: "ff" }>, by: "nexus" | "user"): string {
  run(d.path, ["merge", "--ff-only", "--no-edit", d.sha]);
  const head = run(d.path, ["rev-parse", "HEAD"]);
  if (head !== d.sha) throw new ActionError(`the fast-forward of ${d.base} ended at ${head.slice(0, 7)}, not at ${d.sha.slice(0, 7)}: look at ${d.path}`, 500);
  patchGit(store, q.id, { merged: { at: now(), into: d.base, path: d.path, sha: d.sha, fast_forward: true, by }, merge: undefined });
  return `${d.base} moved forward to ${d.branch} (${d.sha.slice(0, 7)}) in ${d.path}`;
}

/**
 * Runs the integration step again (the base moved on since it ran): it goes back to pending, so the queue's next run
 * merges the base anew; Nexus's own runs again are counted (the user's Merge back starts the count anew).
 */
export function reintegrate(store: ProjectStore, q: QueueView, d: Extract<MergeDecision, { kind: "reintegrate" }>, by: "nexus" | "user"): string {
  const integ = q.steps.find((s) => s.integration)!;
  const count = by === "nexus" ? d.count + 1 : 0;
  const reason = `${d.base} moved on since the integration (to ${d.sha.slice(0, 7)}): it runs again${by === "nexus" ? ` (${count} of ${REINTEGRATION_LIMIT})` : ", as the user's Merge back asked"}`;
  const at = now();
  const file = store.readQueue(q.id);
  store.writeQueue({ ...file, changes: [...file.changes, { at, kind: "status", by: "nexus", step: integ.id, from: integ.status, to: "pending", reason, revision: file.revision }], updated_at: at });
  patchGit(store, q.id, { merge: { reintegrations: count, reintegrating: at } });
  return `queue ${q.id}'s integration step runs again: ${reason}`;
}

// ---------------------------------------------------------------- the user's Merge back

/** A finished queue with a worktree of its own, its branch and base. */
function finishedWorktreeQueue(store: ProjectStore, queueId: string) {
  const state = loadProjectState(store);
  const q = state.queues.find((x) => x.id === queueId);
  if (!q) throw new ActionError(`unknown queue ${queueId}`, 404);
  const root = normPath(state.project.root);
  const path = checkoutOf(store, q);
  if (!path || same(path, root)) throw new ActionError(`queue ${queueId} works in the project's own checkout, not a worktree of its own`, 409);
  if (q.status !== "done") throw new ActionError(`queue ${queueId} is not finished (it is ${q.status})`, 409);
  if (q.run && HOLDING_RUN_STATES.includes(q.run.state)) throw new ActionError(`queue ${queueId}'s run is still going`, 409);
  if (q.git?.cleaned) throw new ActionError(`queue ${queueId} was cleaned up already`, 409);
  const branch = q.branch ?? (existsSync(path) ? git(path, ["branch", "--show-current"]) : undefined);
  if (!branch) throw new ActionError(`queue ${queueId} has no branch`, 409);
  if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) === undefined) throw new ActionError(`branch ${branch} does not exist`, 409);
  return { state, q, root, path, branch, base: q.git?.base };
}

/**
 * The user's Merge back. A queue with an integration step goes the way Nexus's own merge goes (judgeMerge): the base
 * moves forward to the integrated commit, or the integration step runs again when the base moved on; nothing that
 * waits is overridden. A queue from before the integration step is merged as before.
 * `start`: starts the queue's run (for a run of the integration step again).
 */
export function mergeBack(store: ProjectStore, queueId: string, serverRoot = ROOT, start?: (queue: string) => void): string {
  const { state, q, root, branch, base } = finishedWorktreeQueue(store, queueId);
  if (q.steps.some((s) => s.integration)) {
    return withMergeLock(store, queueId, () => {
      const fresh = loadProjectState(store);
      const qq = fresh.queues.find((x) => x.id === queueId)!;
      const d = judgeMerge(store, fresh, qq, "user", serverRoot);
      switch (d.kind) {
        case "none": throw new ActionError(d.why, 409);
        case "wait": throw new ActionError(d.reason, 409);
        case "merged": return `${branch} is already merged into ${base?.ref ?? "its base"}`;
        case "hold": throw new ActionError(`a step is at work in ${d.path} (queue ${d.busy.join(", ")}): merge back once it has ended`, 409);
        case "reintegrate": {
          const text = reintegrate(store, qq, d, "user");
          try { start?.(queueId); } catch (e) { return `${text}; it starts when it can (${(e as Error).message})`; }
          return text;
        }
        case "ff": return fastForward(store, qq, d, "user");
      }
    });
  }
  if (!base || base.branch === false) throw new ActionError(`queue ${queueId}'s base is not known as a branch${base ? ` (${base.ref})` : ""}: merge it by hand`, 409);
  const target = baseCheckout(root, base.ref, serverRoot);
  if ("blocked" in target) throw new ActionError(target.blocked, 409);
  const busy = runningIn(store, state, target.path)[0];
  if (busy) throw new ActionError(`queue ${busy.id} is running in ${target.path}: merge once it is not`, 409);

  const tip = run(root, ["rev-parse", `refs/heads/${branch}`]);
  if (isAncestor(root, tip, `refs/heads/${base.ref}`)) return `${branch} is already merged into ${base.ref}`;
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
  const fastForward_ = sha === tip;
  patchGit(store, q.id, { merged: { at: now(), into: base.ref, path: target.path, sha, fast_forward: fastForward_, by: "user" } });
  return `${branch} merged into ${base.ref} in ${target.path} (${fastForward_ ? "fast-forward" : `merge commit ${sha.slice(0, 7)}`})`;
}

// ---------------------------------------------------------------- cleanup

/**
 * Removes a clean worktree: `git worktree remove` (a few tries), then what git left (paths beyond 260 characters that
 * Git for Windows cannot delete without core.longpaths) deleted by Node, and the worktree list pruned. Throws when the
 * folder or its entry is still there.
 */
export function removeWorktree(root: string, path: string, o: { tries?: number } = {}): void {
  let why = "";
  for (let i = 0; i < (o.tries ?? 3) && existsSync(path); i++) {
    try { run(root, ["worktree", "remove", path]); } catch (e) { why ||= (e as Error).message.split("\n")[0]!; }
  }
  if (existsSync(path)) {
    try { rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch (e) { why += ` / ${(e as Error).message}`; }
  }
  git(root, ["worktree", "prune"]);
  const listed = worktrees(root).some((w) => same(w.path, path));
  if (existsSync(path) || listed) throw new ActionError(`the worktree ${path} could not be removed${why ? ` (${why})` : ""}`, 500);
}

/** The cleanup of a finished worktree queue (the user's, or Nexus's after merging back): the worktree removed, its branch deleted with -d. */
export function cleanUp(store: ProjectStore, queueId: string): string {
  const { q, root, path, branch } = finishedWorktreeQueue(store, queueId);
  const here = existsSync(path);
  if (here) {
    const dirty = git(path, ["status", "--porcelain"]);
    if (dirty === undefined) throw new ActionError(`cannot read the state of ${path}`, 409);
    if (dirty) {
      // The files that block it, as git status names them (?? untracked, M modified, D deleted…), so the user sees what they are.
      const files = dirty.split(/\r?\n/).filter(Boolean);
      const shown = files.slice(0, 20).map((l) => l.trim().replace(/^(\S+)\s+/, "$1 ")).join(", "); // the output is trimmed: no fixed columns
      throw new ActionError(`${path} has uncommitted changes (${files.length} file${files.length === 1 ? "" : "s"}: ${shown}${files.length > 20 ? `, and ${files.length - 20} more` : ""}): commit or discard them first; nothing was removed`, 409);
    }
  }
  // `git branch -d` deletes only a branch merged into its upstream, else into HEAD; checked first, so that a refusal
  // leaves the worktree in place. HEAD is the base's, where it is checked out, else the project's checkout.
  const baseTree = q.git?.base ? worktrees(root).find((w) => w.branch === q.git!.base!.ref)?.path : undefined;
  const cwd = baseTree && !same(baseTree, path) ? baseTree : root;
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);
  const into = upstream ? `refs/remotes/${upstream}` : "HEAD";
  if (!isAncestor(cwd, `refs/heads/${branch}`, into)) {
    throw new ActionError(`${branch} is not merged into ${upstream ?? git(cwd, ["branch", "--show-current"]) ?? "HEAD"}: merge it first; nothing was removed`, 409);
  }
  if (here) removeWorktree(root, path);
  else run(root, ["worktree", "prune"]);
  run(cwd, ["branch", "-d", branch]);
  patchGit(store, q.id, { cleaned: { at: now(), path, branch }, merge: undefined });
  return `the worktree ${path} is removed and branch ${branch} deleted`;
}
