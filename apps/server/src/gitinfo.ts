// Git on the dashboard: what each step committed, and the state of a queue's branch. Only local git: rev-parse, log,
// rev-list, reflog, for-each-ref. Never fetch, push or anything else that reaches a remote, so the remote-tracking
// refs are as old as the last fetch someone made, and the dashboard says how old.
//
// The server records the HEAD of the queue's checkout around each step's work in queues/<id>/git.yaml (one writer:
// the server): when the step opens (or a send-back reopens it) and at the end of the turn in which it got its outcome.
// The commits of a step are those between. In the project's main checkout others may commit too (the user, another
// queue): a commit made outside every turn of the worker's session on that step is marked foreign. Which turn a commit
// was made in comes from the HEADs the server records at each turn's start and end (a round's `turns`), not from the
// commit's time: git, the CLI and the server may disagree about the time after a clock step (docs/DESIGN.md, "Clock
// steps"). Rounds recorded before keep the time windows.
import { execFileSync } from "node:child_process";
import { normPath, now, type BranchView, type CommitView, type GitFile, type LeftBehind, type ProjectStore, type QueueView, type RoundView, type StepCommitsView } from "@nexus/protocol";

const TIMEOUT = 10_000;

/** Runs a local git command; undefined when it fails (not a repository, an unknown ref). */
export function git(cwd: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024 }).trim(); }
  catch { return undefined; }
}

/** Where the queue's work is: its worktree once created, else the project's checkout; undefined for one not made yet. */
export function checkoutOf(store: ProjectStore, q: Pick<QueueView, "worktree">): string | undefined {
  if (q.worktree === "auto") return undefined;
  return normPath(q.worktree ?? store.readProject().root);
}

/** The queue's own worktree, once made: undefined for a queue in the project's checkout, or one `auto` has not made. */
export function ownWorktree(q: Pick<QueueView, "worktree">): string | undefined {
  return q.worktree && q.worktree !== "auto" ? normPath(q.worktree) : undefined;
}

/** The files changed between two commits in `cwd` (git diff --name-only); empty when git cannot tell. */
export function changedFiles(cwd: string, from: string, to: string): string[] {
  return (git(cwd, ["diff", "--name-only", from, to]) ?? "").split(/\r?\n/).filter(Boolean);
}

/** The queue works in the project's own checkout (not a worktree of its own). */
function inMainCheckout(store: ProjectStore, q: Pick<QueueView, "worktree">): boolean {
  return !q.worktree || normPath(q.worktree).toLowerCase() === normPath(store.readProject().root).toLowerCase();
}

const head = (dir: string | undefined) => (dir ? git(dir, ["rev-parse", "HEAD"]) ?? null : null);
const empty = (): GitFile => ({ protocol: 1, steps: {} });

/** Sets fields of the queue's git.yaml (made when there is none yet); a field set to undefined is removed. */
export function patchGit(store: ProjectStore, queue: string, patch: Partial<Omit<GitFile, "protocol" | "steps">>): void {
  store.writeGit(queue, { ...(store.readGit(queue) ?? empty()), ...patch });
}

// ---------------------------------------------------------------- records

/** A step opened (or a send-back reopened it): a new round starts, unless the last one has not ended (a continue). */
export function recordStepStart(store: ProjectStore, queue: string, step: string, session: string): void {
  const q = store.readQueue(queue);
  const g = store.readGit(q.id) ?? empty();
  const rounds = g.steps[step] ?? [];
  const last = rounds.at(-1);
  if (last && last.end === undefined) return;
  rounds.push({ session, start: head(checkoutOf(store, q)), started_at: now(), turns: [] });
  g.steps[step] = rounds;
  store.writeGit(q.id, g);
}

/** The turn in which the step got its outcome ended: the round ends at the HEAD of now. */
export function recordStepEnd(store: ProjectStore, queue: string, step: string): void {
  const q = store.readQueue(queue);
  const g = store.readGit(q.id);
  const last = g?.steps[step]?.at(-1);
  if (!g || !last || last.end !== undefined) return;
  last.end = head(checkoutOf(store, q));
  last.ended_at = now();
  const open = last.turns?.at(-1);
  if (open && open.end === undefined) open.end = last.end;
  store.writeGit(q.id, g);
}

/**
 * A turn of the step's session began or ended (the runtime's turn start and end): the HEAD of now goes in the open
 * round's `turns`. A start while a turn is still open (its end never came: a crash) closes that one here.
 */
export function recordTurn(store: ProjectStore, queue: string, step: string, edge: "start" | "end"): void {
  const g = store.readGit(queue);
  const last = g?.steps[step]?.at(-1);
  if (!g || !last || last.end !== undefined || !last.turns) return;
  const open = last.turns.at(-1);
  if (edge === "end" && (!open || open.end !== undefined)) return;
  const sha = head(checkoutOf(store, store.readQueue(queue)));
  if (open && open.end === undefined) open.end = sha;
  if (edge === "start") last.turns.push({ start: sha });
  store.writeGit(queue, g);
}

/** An auto worktree was made: what from (the named base, else the branch the project's checkout was on). */
export function recordBase(store: ProjectStore, q: Pick<QueueView, "id" | "base">, root: string): void {
  const ref = q.base ?? git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = ref ? git(root, ["rev-parse", `${ref}^{commit}`]) : undefined;
  if (!ref || ref === "HEAD" || !sha) return;
  // Whether it names a branch: only a branch can be merged back into.
  const branch = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`]) !== undefined;
  store.writeGit(q.id, { ...(store.readGit(q.id) ?? empty()), base: { ref, sha, at: now(), branch } });
}

// ---------------------------------------------------------------- a step's commits


/** The commits of each round of a step; undefined when the checkout is not a git repository or nothing was recorded. */
export function stepCommits(store: ProjectStore, q: QueueView, step: string): StepCommitsView | undefined {
  const dir = checkoutOf(store, q);
  const rounds = store.readGit(q.id)?.steps[step];
  if (!dir || !rounds?.length || git(dir, ["rev-parse", "--git-dir"]) === undefined) return undefined;
  const main = inMainCheckout(store, q);
  return {
    rounds: rounds.map((r) => {
      const end = r.end === undefined ? head(dir) : r.end;
      const commits = r.start && end ? commitsBetween(dir, r.start, end) : [];
      const own = main && r.turns ? inTurns(dir, r.turns, end) : undefined;
      const windows = main && !r.turns ? turnWindows(store, r.session, q.id, step) : [];
      const foreign = (c: { sha: string; time: number }) => main
        && (own ? !own.has(c.sha) : !windows.some(([a, b]) => c.time >= a - 2000 && c.time <= b + 2000));
      return {
        session: r.session, start: r.start, end: end ?? null, open: r.end === undefined,
        commits: commits.map((c) => ({ ...c, foreign: foreign(c) })),
      };
    }),
  };
}

const SEP = "\x1f";
/** start..end, newest first, with the files and lines each changed. */
function commitsBetween(dir: string, start: string, end: string): (Omit<CommitView, "foreign"> & { time: number })[] {
  const out = git(dir, ["log", "--no-color", "--numstat", `--format=@@${SEP}%H${SEP}%ct${SEP}%an${SEP}%s`, `${start}..${end}`]);
  if (!out) return [];
  const list: (Omit<CommitView, "foreign"> & { time: number })[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith(`@@${SEP}`)) {
      const [, sha, ct, author, subject] = line.split(SEP);
      const time = Number(ct) * 1000;
      list.push({ sha: sha!, subject: subject ?? "", author: author ?? "", at: new Date(time).toISOString(), time, files: 0, insertions: 0, deletions: 0 });
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    const c = list.at(-1);
    if (m && c) { c.files++; c.insertions += m[1] === "-" ? 0 : Number(m[1]); c.deletions += m[2] === "-" ? 0 : Number(m[2]); }
  }
  return list;
}

/**
 * The commits made in the round's turns: each turn's start..end (an open turn's end is the round's end, or the HEAD of
 * now). Turns that follow on without a commit between them are one range, one git call.
 */
function inTurns(dir: string, turns: readonly { start: string | null; end?: string | null }[], roundEnd: string | null | undefined): Set<string> {
  const ranges: [string, string][] = [];
  for (const t of turns) {
    const end = t.end === undefined ? roundEnd : t.end;
    if (!t.start || !end) continue;
    const prev = ranges.at(-1);
    if (prev && prev[1] === t.start) prev[1] = end; else ranges.push([t.start, end]);
  }
  const out = new Set<string>();
  for (const [a, b] of ranges) for (const sha of git(dir, ["rev-list", `${a}..${b}`])?.match(/[0-9a-f]{40,64}/g) ?? []) out.add(sha);
  return out;
}

/** The worker session's turns on this step, from its activity (the runtime's turn_start .. turn_end), in ms. */
function turnWindows(store: ProjectStore, session: string, queue: string, step: string): [number, number][] {
  const out: [number, number][] = [];
  let open: number | undefined;
  for (const a of store.readActivity(session).entries) {
    if (a.queue !== queue || a.step !== step) continue;
    if (a.kind === "turn_start") open ??= Date.parse(a.at);
    else if (a.kind === "turn_end" && open !== undefined) { out.push([open, Date.parse(a.at)]); open = undefined; }
  }
  if (open !== undefined) out.push([open, Date.now()]);
  return out;
}

// ---------------------------------------------------------------- the branch

/** The queue's branch against its base and its remote-tracking ref; undefined outside a git repository or detached. */
export function branchState(store: ProjectStore, q: QueueView): BranchView | undefined {
  const dir = checkoutOf(store, q);
  if (!dir || git(dir, ["rev-parse", "--git-dir"]) === undefined) return undefined;
  const branch = q.branch ?? git(dir, ["branch", "--show-current"]);
  if (!branch || git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) === undefined) return undefined;
  const counts = (other: string) => {
    const r = git(dir, ["rev-list", "--left-right", "--count", `refs/heads/${branch}...${other}`]);
    const m = r ? /^(\d+)\s+(\d+)$/.exec(r) : null;
    return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : undefined;
  };
  const view: BranchView = { branch };
  const baseRef = store.readGit(q.id)?.base?.ref ?? q.base ?? undefined;
  if (baseRef && baseRef !== branch) {
    const c = counts(baseRef);
    if (c) view.base = { ref: baseRef, ...c };
  }
  // The branch's upstream, else origin's branch of the same name.
  const upstream = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`])
    ?? (git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]) !== undefined ? `origin/${branch}` : undefined);
  if (upstream) {
    const c = counts(`refs/remotes/${upstream}`);
    // When the ref last changed (a fetch, a push): its newest reflog entry, kept for remote-tracking refs by default.
    const entry = git(dir, ["reflog", "show", "-1", "--date=unix", "--format=%gd", `refs/remotes/${upstream}`]);
    const t = entry ? /@\{(\d+)\}$/.exec(entry)?.[1] : undefined;
    if (c) view.upstream = { ref: upstream, ...c, at: t ? new Date(Number(t) * 1000).toISOString() : undefined };
  }
  return view;
}

// ---------------------------------------------------------------- what a stopped step left

/** Uncommitted changes in a checkout are not necessarily the stopped step's: said wherever they are shown. */
export const UNCOMMITTED_NOTE = "in the checkout, not necessarily this step's";

/** What a stopped queue's stopped step left behind; undefined when the queue is not stopped at a step. */
export function leftBehind(store: ProjectStore, q: QueueView): LeftBehind | undefined {
  if (q.status !== "stopped" || !q.stop_step) return undefined;
  const commits = (stepCommits(store, q, q.stop_step)?.rounds ?? []).flatMap((r) => r.commits).filter((c) => !c.foreign);
  const dir = checkoutOf(store, q);
  // --no-optional-locks: status does not refresh the index, so it writes nothing.
  // Not git(): its trim would eat the leading space of the first line's status code.
  let status: string | undefined;
  if (dir) {
    try { status = execFileSync("git", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: TIMEOUT }); }
    catch { status = undefined; }
  }
  const uncommitted = (status ?? "").split(/\r?\n/).filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
  return { step: q.stop_step, commits, uncommitted, uncommitted_note: UNCOMMITTED_NOTE };
}
