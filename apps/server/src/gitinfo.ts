// Git on the dashboard: what each step committed, and the state of a queue's branch. Only local git: rev-parse, log,
// rev-list, reflog, for-each-ref. Never fetch, push or anything else that reaches a remote, so the remote-tracking
// refs are as old as the last fetch someone made, and the dashboard says how old.
//
// The server records the HEAD of the queue's checkout around each step's work in queues/<id>/git.yaml (one writer:
// the server): when the step opens (or a send-back reopens it) and at the end of the turn in which it got its outcome.
// The commits of a step are those between. In the project's main checkout others may commit too (the user, another
// queue): a commit made outside every turn of the worker's session on that step is marked foreign. Which turn a commit
// was made in comes from the HEADs the server records at each turn's start and end (a round's `turns`), not from the
// commit's time: git, the CLI and the server may disagree about the time after a clock step (docs/design/state.md, "Clock
// steps"). Rounds recorded before keep the time windows.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { normPath, now, type BranchView, type CommitView, type GitFile, type LeftBehind, type ProjectStore, type QueueView, type RoundView, type StepCommitsView } from "@nexus/protocol";
import { refFromFiles } from "./gitfiles.ts";
import { gitLabel, perf } from "./perf.ts";

/** The limits of every local git read here, waited for (git) or not (gitAsync). */
const LIMITS = { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 } as const;

/** A read's own limit: `timeout` in ms instead of LIMITS.timeout (tests: a short limit and a git slower than it). */
export interface GitOptions { timeout?: number }

/**
 * A git command's answer, or why there is none (queue CI13): `code` is git's exit code when it ran to its end (1 or
 * 128 often mean "no": not a repository, no such ref), absent when it never answered (its time limit, a spawn
 * failure); `reason` says which, for the user.
 */
export type GitResult = { ok: true; out: string } | { ok: false; code?: number; reason: string; stderr: string };

type GitError = { code?: string | number | null; killed?: boolean; signal?: string | null; message: string };
const failure = (cwd: string, err: GitError, stderr: string, timeout: number): GitResult & { ok: false } => {
  const first = stderr.trim().split(/\r?\n/)[0] ?? "";
  // A folder that is not there (a worktree cleaned up) is git's "not a repository", not a git that did not answer.
  if (err.code === "ENOENT" && !existsSync(cwd)) return { ok: false, code: 128, reason: `${cwd} does not exist`, stderr: "" };
  if (typeof err.code === "number") return { ok: false, code: err.code, reason: `git exited with ${err.code}${first ? `: ${first}` : ""}`, stderr };
  if (err.killed || err.signal) return { ok: false, reason: `git did not answer within ${Math.round(timeout / 100) / 10} s`, stderr };
  return { ok: false, reason: `git could not run: ${err.message.split("\n")[0]}`, stderr };
};

/**
 * A git read that did not answer: its time limit, or git not starting. A read that ran and said no (an exit code) is
 * an answer the caller judges itself.
 */
export const noAnswer = (r: GitResult): r is GitResult & { ok: false } => !r.ok && r.code === undefined;

/**
 * Runs a local git command without holding the event loop (queue SV2), with the same LIMITS as git(), and says why
 * when it fails. `trim: false` keeps the output as git wrote it (a status's leading space is part of its first code).
 */
export function gitRead(cwd: string, args: string[], o: { trim?: boolean } & GitOptions = {}): Promise<GitResult> {
  const timeout = o.timeout ?? LIMITS.timeout;
  return perf.timed(gitLabel(args), new Promise((resolve) => {
    execFile("git", args, { cwd, ...LIMITS, timeout }, (err, stdout, stderr) => {
      resolve(err ? failure(cwd, err, String(stderr ?? ""), timeout) : { ok: true, out: o.trim === false ? stdout : stdout.trim() });
    });
  }));
}

/** gitRead without the reason: undefined when it fails, where any failure means the same (a commit's details). */
export async function gitAsync(cwd: string, args: string[], o: { trim?: boolean } & GitOptions = {}): Promise<string | undefined> {
  const r = await gitRead(cwd, args, o);
  return r.ok ? r.out : undefined;
}

/** Runs a local git command; undefined when it fails (not a repository, an unknown ref). */
export function git(cwd: string, args: string[]): string | undefined {
  const r = gitSync(cwd, args);
  return r.ok ? r.out : undefined;
}

/** git() with the reason when it fails: for a caller that must tell "no" (an exit code) from "no answer". */
export function gitSync(cwd: string, args: string[]): GitResult {
  try { return { ok: true, out: perf.measure(gitLabel(args), () => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], ...LIMITS })).trim() }; }
  catch (e) {
    const err = e as { code?: string; status?: number | null; signal?: string | null; stderr?: string; message: string };
    // execFileSync names the exit code `status` (null when killed); `code` is a spawn error's name, or ETIMEDOUT.
    const killed = err.code === "ETIMEDOUT" || !!err.signal;
    return failure(cwd, { code: killed ? undefined : typeof err.status === "number" ? err.status : err.code, killed, signal: err.signal, message: err.message }, String(err.stderr ?? ""), LIMITS.timeout);
  }
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

/**
 * `git rev-parse [-q --verify] <name>` for a full ref name (HEAD, MERGE_HEAD, refs/heads/main): read from the .git files
 * where they answer as git would, without a git process (queue GB, src/gitfiles.ts); else git's own answer. Undefined
 * when there is no such ref (or no commit on the branch yet).
 */
export function revParse(cwd: string, name: string, o: { verify?: boolean } = {}): string | undefined {
  const r = refFromFiles(cwd, name);
  if (r) return r.sha ?? undefined;
  return git(cwd, o.verify ? ["rev-parse", "-q", "--verify", name] : ["rev-parse", name]);
}

const head = (dir: string | undefined) => (dir ? revParse(dir, "HEAD") ?? null : null);
const empty = (): GitFile => ({ protocol: 1, steps: {} });

/**
 * HEAD and whether the tracked files have uncommitted changes, from one git process (`git status --porcelain=v2
 * --branch`) where two were run (rev-parse HEAD, status --porcelain): queue SV2B. `head` is null before the first
 * commit; undefined when git cannot tell (not a repository).
 */
export function checkoutStatus(cwd: string): { head: string | null; clean: boolean } | undefined {
  const out = git(cwd, ["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "--untracked-files=no"]);
  if (out === undefined) return undefined;
  const lines = out.split(/\r?\n/).filter(Boolean);
  const oid = lines.find((l) => l.startsWith("# branch.oid "))?.slice("# branch.oid ".length).trim();
  return { head: oid && oid !== "(initial)" ? oid : null, clean: lines.every((l) => l.startsWith("#")) };
}

/**
 * The HEAD of the queue's checkout, read once however often it is asked for: a step's end and the next step's start
 * recorded in one synchronous go (the engine opening a step) share one git call (queue SV2B). Nothing of the server's
 * runs between them, so the value is what a second read would give, unless another program commits within those
 * milliseconds: then the rounds meet at the first read instead of leaving the commit to neither.
 */
export function headOnce(store: ProjectStore, queue: string): () => string | null {
  let read: { sha: string | null } | undefined;
  return () => (read ??= { sha: head(checkoutOf(store, store.readQueue(queue))) }).sha;
}

/** Sets fields of the queue's git.yaml (made when there is none yet); a field set to undefined is removed. */
export function patchGit(store: ProjectStore, queue: string, patch: Partial<Omit<GitFile, "protocol" | "steps">>): void {
  store.writeGit(queue, { ...(store.readGit(queue) ?? empty()), ...patch });
}

// ---------------------------------------------------------------- records

/** A step opened (or a send-back reopened it): a new round starts, unless the last one has not ended (a continue). */
export function recordStepStart(store: ProjectStore, queue: string, step: string, session: string, headNow?: () => string | null): void {
  const q = store.readQueue(queue);
  const g = store.readGit(q.id) ?? empty();
  const rounds = g.steps[step] ?? [];
  const last = rounds.at(-1);
  if (last && last.end === undefined) return;
  rounds.push({ session, start: headNow ? headNow() : head(checkoutOf(store, q)), started_at: now(), turns: [] });
  g.steps[step] = rounds;
  store.writeGit(q.id, g);
}

/** The turn in which the step got its outcome ended: the round ends at the HEAD of now. */
export function recordStepEnd(store: ProjectStore, queue: string, step: string, headNow?: () => string | null): void {
  const q = store.readQueue(queue);
  const g = store.readGit(q.id);
  const last = g?.steps[step]?.at(-1);
  if (!g || !last || last.end !== undefined) return;
  last.end = headNow ? headNow() : head(checkoutOf(store, q));
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


/**
 * The commits of each round of a step; undefined when the checkout is not a git repository or nothing was recorded.
 * Only reads (git.yaml, the activity, git), so its git runs without holding the loop: the dashboard's reads.
 * A git read that failed is never an empty list (queue CI13): `unreadable` says why, and the rounds hold what was read.
 */
export async function stepCommits(store: ProjectStore, q: QueueView, step: string, o: GitOptions = {}): Promise<StepCommitsView | undefined> {
  const dir = checkoutOf(store, q);
  const rounds = store.readGit(q.id)?.steps[step];
  if (!dir || !rounds?.length) return undefined;
  const repo = await gitRead(dir, ["rev-parse", "--git-dir"], o);
  if (noAnswer(repo)) return { rounds: [], unreadable: repo.reason };
  if (!repo.ok) return undefined; // git answered: not a repository
  const failed: string[] = [];
  const main = inMainCheckout(store, q);
  let headNow: string | null = null;
  if (rounds.some((r) => r.end === undefined)) {
    const h = await gitRead(dir, ["rev-parse", "HEAD"], o);
    if (h.ok) headNow = h.out; else if (noAnswer(h)) failed.push(h.reason);
  }
  const view: StepCommitsView = {
    rounds: await Promise.all(rounds.map(async (r) => {
      const end = r.end === undefined ? headNow : r.end;
      const [commits, own] = await Promise.all([
        r.start && end ? commitsBetween(dir, r.start, end, failed, o) : [],
        main && r.turns ? inTurns(dir, r.turns, end, failed, o) : undefined,
      ]);
      const windows = main && !r.turns ? turnWindows(store, r.session, q.id, step) : [];
      const foreign = (c: { sha: string; time: number }) => main
        && (own ? !own.has(c.sha) : !windows.some(([a, b]) => c.time >= a - 2000 && c.time <= b + 2000));
      return {
        session: r.session, start: r.start, end: end ?? null, open: r.end === undefined,
        commits: commits.map((c) => ({ ...c, foreign: foreign(c) })),
      };
    })),
  };
  if (failed.length) view.unreadable = failed[0]!;
  return view;
}

/**
 * The output of a read of a range of commits, or undefined with the reason added to `failed`. A range whose commit is
 * gone (git says so: history rewritten since) has no commits, as before; any other failure is no answer.
 */
async function rangeRead(dir: string, args: string[], failed: string[], o: GitOptions): Promise<string | undefined> {
  const r = await gitRead(dir, args, o);
  if (r.ok) return r.out;
  if (r.code !== undefined && /bad revision|unknown revision|invalid revision range|bad object/i.test(r.stderr)) return "";
  failed.push(r.reason);
  return undefined;
}

const SEP = "\x1f";
/** start..end, newest first, with the files and lines each changed; a failed read adds its reason to `failed`. */
async function commitsBetween(dir: string, start: string, end: string, failed: string[], o: GitOptions): Promise<(Omit<CommitView, "foreign"> & { time: number })[]> {
  const out = await rangeRead(dir, ["log", "--no-color", "--numstat", `--format=@@${SEP}%H${SEP}%ct${SEP}%an${SEP}%s`, `${start}..${end}`], failed, o);
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
async function inTurns(dir: string, turns: readonly { start: string | null; end?: string | null }[], roundEnd: string | null | undefined, failed: string[], o: GitOptions): Promise<Set<string>> {
  const ranges: [string, string][] = [];
  for (const t of turns) {
    const end = t.end === undefined ? roundEnd : t.end;
    if (!t.start || !end) continue;
    const prev = ranges.at(-1);
    if (prev && prev[1] === t.start) prev[1] = end; else ranges.push([t.start, end]);
  }
  const out = new Set<string>();
  // A failed read is no answer, not "none of these commits are the step's" (they would be marked foreign).
  const lists = await Promise.all(ranges.map(([a, b]) => rangeRead(dir, ["rev-list", `${a}..${b}`], failed, o)));
  for (const list of lists) for (const sha of list?.match(/[0-9a-f]{40,64}/g) ?? []) out.add(sha);
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

/**
 * The queue's branch against its base and its remote-tracking ref; undefined outside a git repository or detached.
 * Only reads: its git runs without holding the loop, the base's side and the upstream's side by side. A git that did
 * not answer is never "no base" or "no upstream" (queue CI13): `unreadable` says why, the rest is what was read.
 */
export async function branchState(store: ProjectStore, q: QueueView, o: GitOptions = {}): Promise<BranchView | undefined> {
  const dir = checkoutOf(store, q);
  if (!dir) return undefined;
  const failed: string[] = [];
  // The output, or undefined: git said no (an exit code), or did not answer (its reason kept).
  const read = async (args: string[]) => {
    const r = await gitRead(dir, args, o);
    if (noAnswer(r)) failed.push(r.reason);
    return r.ok ? r.out : undefined;
  };
  const unread = (): BranchView | undefined => (failed.length ? { branch: q.branch ?? "", unreadable: failed[0]! } : undefined);
  if (await read(["rev-parse", "--git-dir"]) === undefined) return unread();
  const branch = q.branch ?? await read(["branch", "--show-current"]);
  if (!branch || await read(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) === undefined) return unread();
  const counts = async (other: string) => {
    const r = await read(["rev-list", "--left-right", "--count", `refs/heads/${branch}...${other}`]);
    const m = r ? /^(\d+)\s+(\d+)$/.exec(r) : null;
    return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : undefined;
  };
  const baseRef = store.readGit(q.id)?.base?.ref ?? q.base ?? undefined;
  const base = async (): Promise<BranchView["base"]> => {
    if (!baseRef || baseRef === branch) return undefined;
    const c = await counts(baseRef);
    return c ? { ref: baseRef, ...c } : undefined;
  };
  const upstreamOf = async (): Promise<BranchView["upstream"]> => {
    // The branch's upstream, else origin's branch of the same name.
    const upstream = await read(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`])
      ?? (await read(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]) !== undefined ? `origin/${branch}` : undefined);
    if (!upstream) return undefined;
    // When the ref last changed (a fetch, a push): its newest reflog entry, kept for remote-tracking refs by default.
    const [c, entry] = await Promise.all([
      counts(`refs/remotes/${upstream}`),
      read(["reflog", "show", "-1", "--date=unix", "--format=%gd", `refs/remotes/${upstream}`]),
    ]);
    const t = entry ? /@\{(\d+)\}$/.exec(entry)?.[1] : undefined;
    return c ? { ref: upstream, ...c, at: t ? new Date(Number(t) * 1000).toISOString() : undefined } : undefined;
  };
  const [b, u] = await Promise.all([base(), upstreamOf()]);
  const view: BranchView = { branch };
  if (b) view.base = b;
  if (u) view.upstream = u;
  if (failed.length) view.unreadable = failed[0]!;
  return view;
}

// ---------------------------------------------------------------- what a stopped step left

/** Uncommitted changes in a checkout are not necessarily the stopped step's: said wherever they are shown. */
export const UNCOMMITTED_NOTE = "in the checkout, not necessarily this step's";

/** When the queue's stop came: the stopped step's latest queue.stop (an imported stop has none). */
export function stopAt(q: QueueView): string | undefined {
  return q.steps.find((s) => s.id === q.stop_step)?.timeline.findLast((e) => e.type === "queue.stop")?.at;
}

/**
 * What a stopped queue's stopped step left behind; undefined when the queue is not stopped at a step. Only reads, its
 * git without holding the loop: an action that decides by it reads it first, then decides and writes in one go
 * (src/stopwork.ts). A git read that failed is never an empty list (queue CI13): `unreadable` names the part and why,
 * and a lift is refused while the step's commits are unreadable.
 */
export async function leftBehind(store: ProjectStore, q: QueueView, o: GitOptions = {}): Promise<LeftBehind | undefined> {
  if (q.status !== "stopped" || !q.stop_step) return undefined;
  // The stop this read is for, taken before the git reads are awaited: a lift decides only on it (queue LH).
  const stoppedAt = stopAt(q);
  const dir = checkoutOf(store, q);
  // --no-optional-locks: status does not refresh the index, so it writes nothing. Untrimmed: a trim would eat the
  // leading space of the first line's status code.
  const [view, status] = await Promise.all([
    stepCommits(store, q, q.stop_step, o),
    dir ? gitRead(dir, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], { trim: false, ...o }) : undefined,
  ]);
  const commits = (view?.rounds ?? []).flatMap((r) => r.commits).filter((c) => !c.foreign);
  // git answering no (not a repository) has nothing uncommitted, as before; one that did not answer is unreadable.
  const uncommitted = (status?.ok ? status.out : "").split(/\r?\n/).filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
  const unreadable: NonNullable<LeftBehind["unreadable"]> = {};
  if (view?.unreadable) unreadable.commits = view.unreadable;
  if (status && noAnswer(status)) unreadable.uncommitted = status.reason;
  return {
    step: q.stop_step, commits, uncommitted, uncommitted_note: UNCOMMITTED_NOTE, ...(stoppedAt ? { stopped_at: stoppedAt } : {}),
    ...(unreadable.commits || unreadable.uncommitted ? { unreadable } : {}),
  };
}
