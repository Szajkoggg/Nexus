// Removing a project from Nexus (PROTOCOL.md, "Removing a project"), the user's only, from the dashboard: "Remove from
// Nexus" takes it off the registry and leaves its .nexus folder, so `nexus project add` brings it back as it was;
// "Delete Nexus's data" deletes that folder too. Either one only while nothing runs in the project, and neither
// touches the project's own files, nor the worktrees and branches Nexus made (they belong to its git repository).
//
// What is deleted is guarded in code: only realpath(<the project's root>)/.nexus, only a folder of its own (never a
// link or junction), only one holding a project.yaml, and only of a project registered in this server's NEXUS_HOME.
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ActionError, isOpenQuestion, nexusHome, normPath, openPlan, readRegistry, writeRegistry,
  type ProjectState, type QueueView, type RemovalView, type RunFile,
} from "@nexus/protocol";
import { checkoutPath, samePath } from "./worktree.ts";

/** A refusal of a removal while something runs: the reasons, one sentence each, beside the message. */
export class RemovalBlocked extends ActionError {
  readonly blockers: string[];
  constructor(blockers: string[]) {
    super(`the project cannot be removed while something runs in it: ${blockers.join("; ")}`, 409);
    this.blockers = blockers;
  }
}

/** What runs in the project now beyond its files: the server's live parts. */
export interface LiveParts {
  /** No worker of the project's queues is in a turn. */
  engineIdle: boolean;
  /** The orchestrator is not in a turn. */
  orchestratorIdle: boolean;
  /** No thinking partner is in a turn. */
  conversationsIdle: boolean;
  /** Queues Nexus is merging back now (a fast-forward waiting on a checkout, src/merger.ts). */
  merging: string[];
  /** The planned deploy's target, when it is a queue (or step) of this project. */
  deploy?: { queue: string; step?: string };
  /** Nexus is updating (draining, handing over). */
  updating: boolean;
}

const RUN_WORDS: Record<RunFile["state"], string> = {
  running: "runs", pausing: "runs (it pauses after its step)", paused: "is paused", halted: "is halted", finished: "is finished",
  usage_wait: "waits for the usage window", retry_wait: "waits to try a turn again", approval_wait: "waits for an approval",
};

/** How a run that keeps the project reads after "queue A ": "runs", "is stopped", "is held (it goes on by itself)". */
function runText(q: QueueView, run: RunFile): string {
  if (run.state === "halted" && q.status === "stopped") return "is stopped";
  if (run.state === "paused" && run.resume_after_restart) return "is held (it goes on by itself)";
  return RUN_WORDS[run.state];
}

/**
 * What keeps the project from being removed now; empty: it may go. A run that started and did not finish (running,
 * paused, waiting, held or stopped) of a queue that is not done or cancelled; a merge back in progress or waiting; a
 * deploy planned after a step or queue of the project; the orchestrator or a thinking partner in a turn; an update.
 * Planned and scheduled starts and open questions do not keep it: they go with it (removalView lists them).
 */
export function removalBlockers(state: ProjectState | undefined, live: LiveParts): string[] {
  const out: string[] = [];
  /** The queues listed so far: each once. */
  const listed = new Set<string>();
  const queue = (id: string, text: string) => { listed.add(id); out.push(`queue ${id} ${text}`); };
  if (live.updating) out.push("Nexus is updating");
  const queues = state?.queues ?? [];
  for (const q of queues) {
    if (q.run && q.run.state !== "finished" && q.status !== "done" && q.status !== "cancelled") queue(q.id, runText(q, q.run));
  }
  // A worker in a turn belongs to one of those runs; only without one is it said on its own.
  if (!live.engineIdle && !listed.size) out.push("a worker of the project is in a turn");
  for (const q of queues) {
    const merge = q.git?.merge;
    if (merge?.reintegrating) queue(q.id, "is being integrated again before its merge back");
    else if (merge?.waiting && q.status !== "cancelled" && !q.git?.cleaned) queue(q.id, `waits to be merged back: ${merge.waiting.reason}`);
  }
  for (const id of live.merging) if (!listed.has(id)) out.push(`Nexus is merging queue ${id} back`);
  if (live.deploy) out.push(`a deploy is planned after ${live.deploy.step ? `step ${live.deploy.queue}/${live.deploy.step}` : `queue ${live.deploy.queue}`} of this project`);
  if (!live.orchestratorIdle) out.push("the orchestrator is in a turn");
  if (!live.conversationsIdle) out.push("a thinking partner is in a turn");
  return out;
}

/**
 * The folder "Delete Nexus's data" would delete: realpath(<root>)/.nexus, and why it may not, if so. It must be a
 * folder of its own (not a link or junction, also not by way of a link lstat does not see) holding a project.yaml.
 */
export function nexusDirOf(root: string): { dir: string; refused?: string } {
  let real: string;
  try { real = realpathSync.native(root); }
  catch (e) { return { dir: normPath(join(root, ".nexus")), refused: `the project's folder cannot be read (${(e as Error).message})` }; }
  const dir = join(real, ".nexus");
  const shown = normPath(dir);
  let st;
  try { st = lstatSync(dir); } catch { return { dir: shown, refused: "there is no .nexus folder in the project's folder" }; }
  if (st.isSymbolicLink()) return { dir: shown, refused: ".nexus is a link or junction to another folder: Nexus deletes only a folder of its own" };
  if (!st.isDirectory()) return { dir: shown, refused: ".nexus is not a folder" };
  let realDir: string;
  try { realDir = realpathSync.native(dir); } catch (e) { return { dir: shown, refused: `.nexus cannot be read (${(e as Error).message})` }; }
  if (!samePath(realDir, dir)) return { dir: shown, refused: ".nexus leads to another folder: Nexus deletes only a folder of its own" };
  if (!existsSync(join(dir, "project.yaml"))) return { dir: shown, refused: ".nexus holds no project.yaml: it is not Nexus's data" };
  return { dir: shown };
}

/** `child` is `dir` or lies under it (case and slashes ignored). */
const inside = (child: string, dir: string): boolean => {
  const c = normPath(child).toLowerCase().replace(/\/+$/, ""), d = normPath(dir).toLowerCase().replace(/\/+$/, "");
  return c === d || c.startsWith(d + "/");
};

/** What the confirmation shows: what keeps the project, what goes with it, what stays, and the folder Delete deletes. */
export function removalView(root: string, name: string, state: ProjectState | undefined, live: LiveParts): RemovalView {
  const queues = state?.queues ?? [];
  const open = (q: QueueView) => q.status !== "done" && q.status !== "cancelled";
  const planned = queues.flatMap((q) => { const p = open(q) ? openPlan(q) : undefined; return p ? [{ queue: q.id, after: p.after.map((a) => a.queue) }] : []; });
  const scheduled = queues.flatMap((q) => (open(q) && q.start?.at ? [{ queue: q.id, at: q.start.at }] : []));
  const questions = (state?.questions ?? []).filter(isOpenQuestion).map((x) => ({ qid: x.qid, queue: x.queue, step: x.step, text: x.text }));
  // The worktrees Nexus made (an auto worktree, written back as its path) and not cleaned up since.
  const worktrees = state ? queues.flatMap((q) => {
    if (!q.worktree || q.git?.cleaned || !q.integration) return [];
    const path = checkoutPath(state, q);
    if (samePath(path, state.project.root)) return [];
    return [{ queue: q.id, path, branch: q.branch, exists: existsSync(path) }];
  }) : [];
  const nexus = nexusDirOf(root);
  const within = worktrees.find((w) => inside(w.path, nexus.dir));
  const refused = nexus.refused ?? (within ? `the worktree of queue ${within.queue} lies inside .nexus: Nexus does not delete a worktree` : undefined);
  return { name, blockers: removalBlockers(state, live), planned, scheduled, questions, worktrees, nexus_dir: nexus.dir, ...(refused ? { delete_refused: refused } : {}) };
}

/**
 * Checks a removal before anything is done (throws an ActionError, or RemovalBlocked with the reasons): nothing runs,
 * the project is registered in this server's NEXUS_HOME under this root, and for a Delete the name typed is the
 * project's and its .nexus may be deleted. Returns whether its data goes too.
 */
export function checkRemoval(id: string, root: string, view: RemovalView, body: { delete_data?: unknown; name?: unknown }): { deleteData: boolean } {
  if (body.delete_data !== undefined && typeof body.delete_data !== "boolean") throw new ActionError("delete_data is true or false");
  const deleteData = body.delete_data === true;
  if (view.blockers.length) throw new RemovalBlocked(view.blockers);
  if (!registeredHere(id, root)) throw new ActionError(`project ${id} is not registered at ${normPath(root)} in this server's NEXUS_HOME (${normPath(nexusHome())})`, 409);
  if (deleteData) {
    if (typeof body.name !== "string" || body.name.trim() !== view.name) throw new ActionError("to delete Nexus's data of the project, type its name (name)");
    if (view.delete_refused) throw new ActionError(`Nexus's data of the project cannot be deleted: ${view.delete_refused}`, 409);
  }
  return { deleteData };
}

/** The project is in this server's registry (<NEXUS_HOME>/projects.yaml) with this root. */
function registeredHere(id: string, root: string): boolean {
  return readRegistry().projects.some((p) => p.id === id && samePath(p.root, root));
}

/** Takes the project off this server's registry (<NEXUS_HOME>/projects.yaml); the other entries stay as they are. */
export function unregister(id: string, root: string): void {
  const reg = readRegistry();
  const projects = reg.projects.filter((p) => !(p.id === id && samePath(p.root, root)));
  if (projects.length === reg.projects.length) throw new ActionError(`project ${id} is not registered in this server's NEXUS_HOME`, 409);
  writeRegistry({ ...reg, projects });
}

/** A part of the project that runs agents or timers. */
interface Stoppable { shutdown(): void; alive?(): boolean }

/**
 * Stops the project's agents and timers (its engine, orchestrator, thinking partners and merger), and waits until
 * their processes have exited (their last writes are to the project's runtime files). Whether they all did in time.
 */
export async function stopProject(parts: Stoppable[], timeoutMs = 10_000): Promise<boolean> {
  for (const p of parts) p.shutdown();
  const alive = () => parts.some((p) => p.alive?.() ?? false);
  for (const until = Date.now() + timeoutMs; alive() && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  return !alive();
}

/**
 * Deletes the project's .nexus folder, checked once more right before (nexusDirOf): only the folder of its own under
 * realpath(root). A link or junction inside it is removed as a link; what it points to is not touched.
 */
export function deleteNexusDir(root: string): string {
  const { dir, refused } = nexusDirOf(root);
  if (refused) throw new ActionError(`Nexus's data of the project was not deleted: ${refused}`, 409);
  rmSync(dir, { recursive: true, maxRetries: 10, retryDelay: 200 });
  return dir;
}
