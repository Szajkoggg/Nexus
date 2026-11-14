// What the integration step is given when it opens (PROTOCOL.md, "The integration step"): the base branch to merge
// into the queue's branch (the branch the queue's worktree was made from, as git.yaml recorded it; else the branch the
// project's checkout is on), where that branch is now, the queue's branch, and whether the project lets the worker
// resolve a conflict (defaults.resolve_conflicts).
import { normPath, type ProjectState, type ProjectStore, type QueueView } from "@nexus/protocol";
import { git } from "./gitinfo.ts";
import { gitBranch } from "./worktree.ts";

export interface IntegrationContext {
  /** The base branch to merge; undefined when none can be named (the base is no branch, the checkout is on none). */
  base?: string;
  /** The base branch's commit now. */
  sha?: string;
  /** The queue's branch, checked out in its worktree. */
  branch?: string;
  /** The worker may resolve a conflict (the project's resolve_conflicts). */
  resolve: boolean;
}

export function integrationContext(store: ProjectStore, state: Pick<ProjectState, "project">, q: Pick<QueueView, "id" | "worktree" | "branch">): IntegrationContext {
  const root = normPath(state.project.root);
  const recorded = store.readGit(q.id)?.base;
  const base = recorded?.branch ? recorded.ref : gitBranch(root) ?? undefined;
  const sha = base ? git(root, ["rev-parse", `refs/heads/${base}`]) : undefined;
  const wt = q.worktree && q.worktree !== "auto" ? q.worktree : undefined;
  const branch = (wt ? gitBranch(wt) : null) ?? q.branch;
  return { base: sha ? base : undefined, sha, branch, resolve: state.project.defaults.resolve_conflicts };
}
