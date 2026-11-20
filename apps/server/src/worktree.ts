// A queue's working directory: the project's checkout, a path the queue names, or (`worktree: auto`) a git worktree
// with a branch of its own that Nexus creates beside the checkout when the queue first starts, and the project's worktree
// setup command, run once in each worktree Nexus makes.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ActionError, fileList, normPath, now, type ProjectState, type ProjectStore, type QueueView } from "@nexus/protocol";
import { changedFiles, ownWorktree, patchGit, recordBase } from "./gitinfo.ts";
import { gitLabel, perf } from "./perf.ts";

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
    const exists = (() => { try { perf.measure("git rev-parse", () => execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root, stdio: "ignore" })); return true; } catch { return false; } })();
    const args = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, q.base ?? "HEAD"];
    // What a new branch is made from, for its ahead/behind on the dashboard (before the worktree moves anything).
    if (!exists) recordBase(store, q, root);
    try { perf.measure(gitLabel(args), () => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })); }
    catch (e) { throw new ActionError(`could not create the worktree: ${(e as { stderr?: Buffer }).stderr?.toString().trim() || (e as Error).message}`, 500); }
    // A new worktree gets the project's setup command once, before its first step (the engine runs it: setupPending).
    const command = state.project.defaults.worktree_setup?.trim();
    if (command) patchGit(store, q.id, { setup: { command, at: now() } });
  }
  // Marked as a queue with a worktree of its own, so it keeps its integration step once `worktree` names the path.
  store.writeQueue({ ...store.readQueue(q.id), worktree: path, branch, integration: true, updated_at: now() });
  return path;
}

/** The branch checked out in `cwd`; null when there is none (detached, not a repository). */
export function gitBranch(cwd: string): string | null {
  try { return perf.measure("git branch", () => execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim() || null; }
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
 * Records how a run of the setup command ended: done (on `sha`, the worktree's HEAD then; `reason`: why it ran), or
 * its failure with the reason (it runs again before the next step).
 */
export function recordSetup(store: ProjectStore, queueId: string, command: string, failure?: string, sha?: string, reason?: string): void {
  const git = store.readGit(queueId);
  if (!git?.setup) return;
  const setup = failure ? { ...git.setup, command, failed: { at: now(), reason: failure } }
    : { ...git.setup, command, done_at: now(), failed: undefined, ...(sha ? { sha } : {}), reason: reason ?? git.setup.reason ?? "first setup" };
  store.writeGit(queueId, { ...git, setup });
}

/** The lockfiles of the common package managers, anywhere in the tree: the setup's inputs by default (queue MI, M8). */
const WORKTREE_SETUP_INPUTS: readonly string[] = ["**/package-lock.json", "**/npm-shrinkwrap.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/bun.lockb", "**/bun.lock"];

/** A glob of the setup's inputs as a pattern: `**` any folders, `*` and `?` within one name; `/` separates. */
function globPattern(glob: string): RegExp {
  let out = "";
  const g = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") { out += g[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += g[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/** The setup's inputs (the project's, else the default lockfiles) among the files changed from `from` to `to` in `cwd`. */
export function setupInputsChanged(cwd: string, inputs: readonly string[] | undefined, from: string, to = "HEAD"): string[] {
  const patterns = (inputs ?? WORKTREE_SETUP_INPUTS).map(globPattern);
  return changedFiles(cwd, from, to).filter((f) => patterns.some((p) => p.test(f)));
}

/**
 * The setup to run again before a check set in the queue's worktree, because its inputs changed between the commit it
 * last ran on and HEAD (queue MI, M7): the command and why; undefined when it is current, never ran, or there is none.
 */
export function setupStale(store: ProjectStore, q: Pick<QueueView, "id" | "worktree">): { command: string; reason: string } | undefined {
  const g = store.readGit(q.id);
  const project = store.readProject();
  const command = project.defaults.worktree_setup?.trim();
  const from = g?.setup?.sha ?? g?.base?.sha;
  const cwd = ownWorktree(q);
  if (!command || !g?.setup?.done_at || !from || !cwd) return undefined;
  const changed = setupInputsChanged(cwd, project.defaults.worktree_setup_inputs, from);
  return changed.length ? { command, reason: `${fileList(changed, 3)} changed` } : undefined;
}

/** How long the setup command may run before it counts as failed. */
const SETUP_LIMIT_MS = 30 * 60_000;
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
