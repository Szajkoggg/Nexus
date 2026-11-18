// What the integration step is given when it opens (PROTOCOL.md, "The integration step"): the base branch to merge
// into the queue's branch (the branch the queue's worktree was made from, as git.yaml recorded it; else the branch the
// project's checkout is on), where that branch is now, the queue's branch, and whether the project lets the worker
// resolve a conflict (defaults.resolve_conflicts).
//
// And the merges Nexus makes itself, without a model (queue MI; PROTOCOL.md, "Without a model"): the integration step's
// when it is clean, and the base merged into the queue's branch at a step boundary when it merges cleanly. A merge is
// tested first without touching the worktree (git merge-tree), and made only when clean.
import { execFileSync } from "node:child_process";
import { fileList, normPath, now, type BasePull, type GitFile, type ProjectState, type ProjectStore, type QueueView } from "@nexus/protocol";
import { git, ownWorktree } from "./gitinfo.ts";
import { gitBranch, setupInputsChanged } from "./worktree.ts";

export interface IntegrationContext {
  /** The base branch to merge; undefined when none can be named (the base is no branch, the checkout is on none). */
  base?: string;
  /** The base branch's commit now. */
  sha?: string;
  /** The queue's branch, checked out in its worktree. */
  branch?: string;
  /** The worker may resolve a conflict (the project's resolve_conflicts). */
  resolve: boolean;
  /** Nexus tried the merge before a worker opened the step: these files conflict (queue MI). */
  conflicts?: string[];
}

export function integrationContext(store: ProjectStore, state: Pick<ProjectState, "project">, q: Pick<QueueView, "id" | "worktree" | "branch">): IntegrationContext {
  const root = normPath(state.project.root);
  const recorded = store.readGit(q.id)?.base;
  const base = recorded?.branch ? recorded.ref : gitBranch(root) ?? undefined;
  const sha = base ? git(root, ["rev-parse", `refs/heads/${base}`]) : undefined;
  const wt = ownWorktree(q);
  const branch = (wt ? gitBranch(wt) : null) ?? q.branch;
  return { base: sha ? base : undefined, sha, branch, resolve: state.project.defaults.resolve_conflicts };
}

// ---------------------------------------------------------------- merges without a model (queue MI)

const GIT_TIMEOUT = 120_000;

/** Runs git in `cwd`, its output trimmed; throws on a failure (with `status` and `stdout`, as execFileSync does). */
function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: GIT_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }).trim();
}

/** The tracked files of the checkout have no uncommitted changes (untracked files do not count). */
export function cleanCheckout(cwd: string): boolean {
  return git(cwd, ["status", "--porcelain", "--untracked-files=no"]) === "";
}

/** The files a merge left unmerged. */
const unmerged = (cwd: string): string[] => (git(cwd, ["diff", "--name-only", "--diff-filter=U"]) ?? "").split(/\r?\n/).filter(Boolean);

/**
 * The files that would conflict if `base` were merged into HEAD in `cwd`; empty when it merges cleanly. Tested without
 * touching the worktree (git merge-tree --write-tree, git 2.38 and later); an older git gets a real merge, aborted.
 */
export function mergeConflicts(cwd: string, base: string): string[] {
  try {
    run(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", base]);
    return [];
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return [...new Set((err.stdout ?? "").split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean))];
  }
  try { run(cwd, [...identity(cwd), "merge", "--no-commit", "--no-ff", base]); } catch { /* the conflicts are read below */ }
  const files = unmerged(cwd);
  git(cwd, ["merge", "--abort"]);
  return files;
}

/** Without a configured identity (a fresh machine, a test), Nexus's merge commits name Nexus. */
function identity(cwd: string): string[] {
  return git(cwd, ["config", "user.email"]) ? [] : ["-c", "user.name=Nexus", "-c", "user.email=nexus@localhost"];
}

/** What a merge of the base into the queue's branch did. */
type MergeOutcome =
  | { result: "contained"; from: string; sha: string }
  | { result: "conflict"; from: string; sha: string; conflicts: string[] }
  | { result: "merged"; from: string; sha: string; to: string; commits: number; shortstat: string };

/**
 * Merges `base` into HEAD in `cwd` (git merge --no-edit), only when it merges cleanly: a conflict leaves the branch as
 * it was. `contained`: HEAD has the base already. Undefined when git cannot read the refs.
 */
export function mergeBase(cwd: string, base: string): MergeOutcome | undefined {
  const from = git(cwd, ["rev-parse", "HEAD"]);
  const sha = git(cwd, ["rev-parse", `${base}^{commit}`]);
  if (!from || !sha) return undefined;
  if (git(cwd, ["merge-base", "--is-ancestor", sha, from]) !== undefined) return { result: "contained", from, sha };
  const conflicts = mergeConflicts(cwd, base);
  if (conflicts.length) return { result: "conflict", from, sha, conflicts };
  try { run(cwd, [...identity(cwd), "merge", "--no-edit", sha]); }
  catch {
    const files = unmerged(cwd);
    git(cwd, ["merge", "--abort"]);
    return { result: "conflict", from, sha, conflicts: files.length ? files : ["(the merge failed)"] };
  }
  const to = git(cwd, ["rev-parse", "HEAD"]) ?? from;
  const commits = Number(git(cwd, ["rev-list", "--count", `${from}..${sha}`]) ?? 0);
  const shortstat = git(cwd, ["diff", "--shortstat", from, to]) ?? "";
  return { result: "merged", from, sha, to, commits, shortstat };
}

/** "7 commits, 12 files changed, 340 insertions(+), 85 deletions(-)" */
export function mergedText(m: Extract<MergeOutcome, { result: "merged" }>): string {
  return `${m.commits} commit${m.commits === 1 ? "" : "s"}${m.shortstat ? `, ${m.shortstat}` : ""}`;
}

/**
 * The base merged into the queue's branch at a step boundary, before `before` opens (queue MI, M9): only in a queue with
 * an integration step, a worktree without uncommitted changes to tracked files, a base branch to name, and something to
 * bring. A clean merge is made; one that conflicts is not, and is recorded (once per base commit and step). When the
 * merge changed the setup's inputs, the setup is marked to run again (the engine runs it before the step opens).
 * Returns the record, or undefined when nothing was done.
 */
export function pullBase(store: ProjectStore, state: Pick<ProjectState, "project">, q: Pick<QueueView, "id" | "worktree" | "branch" | "integration">, before: string): BasePull | undefined {
  const cwd = ownWorktree(q);
  if (!q.integration || !cwd) return undefined;
  const ctx = integrationContext(store, state, q);
  if (!ctx.base || !cleanCheckout(cwd)) return undefined;
  const m = mergeBase(cwd, ctx.base);
  if (!m || m.result === "contained") return undefined;
  const g = store.readGit(q.id) ?? { protocol: 1 as const, steps: {} };
  const pulls = g.pulls ?? [];
  if (m.result === "conflict") {
    const last = pulls.at(-1);
    if (last && !last.to && last.before === before && last.sha === m.sha) return undefined;
    const pull: BasePull = { at: now(), before, base: ctx.base, sha: m.sha, from: m.from, conflicts: m.conflicts };
    store.writeGit(q.id, { ...g, pulls: [...pulls, pull] });
    return pull;
  }
  const changed = g.setup?.done_at ? setupInputsChanged(cwd, state.project.defaults.worktree_setup_inputs, m.from, m.to) : [];
  const pull: BasePull = { at: now(), before, base: ctx.base, sha: m.sha, from: m.from, to: m.to, ...(changed.length ? { setup: true } : {}) };
  const setup = changed.length && g.setup ? { ...g.setup, done_at: undefined, failed: undefined, reason: `${fileList(changed, 3)} changed (the merge of ${ctx.base})` } : g.setup;
  store.writeGit(q.id, { ...g, pulls: [...pulls, pull], ...(setup ? { setup } : {}) });
  return pull;
}

/** The pull made right before `step` opens now (the last one, naming it, after the step's last round began). */
export function pullBefore(store: ProjectStore, queue: string, step: string): BasePull | undefined {
  const g = store.readGit(queue);
  const last = g?.pulls?.at(-1);
  if (!last || last.before !== step) return undefined;
  const round = g?.steps[step]?.at(-1);
  return !round || round.started_at < last.at ? last : undefined;
}

/** The last base commit merged into the queue's branch at a step boundary, with the HEAD after it (queue MI, M10). */
export function lastPulled(g: GitFile | undefined): BasePull & { to: string } | undefined {
  return g?.pulls?.findLast((p): p is BasePull & { to: string } => !!p.to);
}
