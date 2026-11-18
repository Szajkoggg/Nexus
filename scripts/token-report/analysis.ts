// The breakdowns of the token report (scripts/token-report.ts): where the tokens of a project's agents went, from the
// runtimes' transcripts (per model call) and turns.jsonl (per turn), and the quality signals from the project's events,
// over a period. Pure: the tests give made-up transcripts, turns and events. The method, and what each figure counts,
// is in docs/DESIGN.md, "Measuring token use"; how to run it in README.md.
import { TOKEN_WEIGHTS, weightedTokens } from "@nexus/protocol/usage-estimate";
import type { TokenCounts, TurnRecord } from "@nexus/protocol";
import { addTokens, weigh, zeroTokens } from "./tokens.ts";
import type { Call, ToolUse, Transcript } from "./transcripts.ts";

/** A Nexus session as its session.yaml names it (only what the report needs). */
export interface SessionInfo { id: string; project: string; role: string; runtime: string; native_id?: string | null }

/** An event of a session's events.jsonl, read loosely (only the fields the quality figures use). */
export interface EventLine {
  type: string; at: string; session: string;
  queue?: string; step?: string; name?: string; ok?: boolean; to?: string;
}

export interface Input {
  transcripts: Transcript[];
  turns: TurnRecord[];
  events: EventLine[];
  sessions: SessionInfo[];
  /** The projects' roots (`C:/Code/Nexus`): their worktrees are `<root>.worktrees/<name>`. */
  roots: string[];
  /** The projects reported; every project the sessions and turns name when absent. */
  projects?: string[];
  /** ISO times: since inclusive, until exclusive. */
  since?: string; until?: string;
  /** How many of the most read files to list (default 15). */
  top?: number;
}

/** Roles as the report names them: Nexus's three, and `other` for a transcript of the project no session names. */
const ROLES = ["worker", "orchestrator", "conversation", "other"] as const;
type Role = (typeof ROLES)[number];

const IDLE_MS = 60 * 60 * 1000;
const THRESHOLDS = [300_000, 500_000] as const;

interface RoleRow {
  role: Role;
  /** Transcripts (sub-agents' apart) with a call in the period. */
  sessions: number;
  calls: number;
  /** Weighted tokens (TOKEN_WEIGHTS) and their share of every role's. */
  weighted: number; share: number;
  tokens: TokenCounts;
  /** The cache reads' part of the role's weighted tokens. */
  cache_read_share: number;
  /** A call's average context: input + cache read + cache written. */
  avg_context: number;
  /** The share of the role's context tokens spent in calls whose context was above 300k and 500k tokens. */
  above: Record<`${(typeof THRESHOLDS)[number]}`, number>;
}

interface Bucket { calls: number; weighted: number; share: number }

interface Shape {
  role: Role; calls: number;
  /** Calls with two or more tool calls. */
  multi_tool: number; multi_share: number;
  /** Calls whose tool calls only read (Read, Grep, cat, git log, nexus status …), their share and weighted share. */
  read_only: number; read_only_share: number; read_only_weighted_share: number;
  /** Runs of consecutive read-only calls in one transcript, by length. */
  runs: { "2": number; "3": number; "4-5": number; "6+": number };
}

interface FileReads { path: string; count: number; tokens: number }

interface TurnRow { role: string; runtime: string; turns: number; weighted: number; share: number; cache_read_share: number }

interface Quality {
  /** Steps reported done in the period (each once). */
  steps_done: number;
  /** The user's Fix it (a send-back from the user's review, or a picture comment sent back). */
  fix_it: number;
  rejected: number;
  /** Provisional acceptances, and those the user returned with a Fix it. */
  provisional: number; provisional_returned: number;
  /** Send-backs by the orchestrator. */
  send_backs: number;
  /** Failed check results, and those re-run later in the step (a fix round). */
  check_fails: number; check_fix_rounds: number;
}

export interface Report {
  since?: string; until?: string;
  projects: string[];
  /** The first and last time of each source within the period. */
  span: { calls?: [string, string]; turns?: [string, string]; events?: [string, string] };
  sources: { claude_transcripts: number; codex_transcripts: number; subagents: number; turns: number; events: number };
  total_weighted: number;
  roles: RoleRow[];
  idle: Bucket & { transcripts: number; by_role: Partial<Record<Role, Bucket>> };
  routine: { tests: Bucket; checks: Bucket; build: Bucket; lock_wait: Bucket; full_test_runs: number; lock_queries: number };
  images: { images: number; calls: number };
  step_progress: number;
  reads: FileReads[];
  shapes: Shape[];
  turns: { rows: TurnRow[]; total_weighted: number; idle: { turns: number; weighted: number; share: number } };
  quality: { total: Quality; queues: (Quality & { queue: string })[]; steps: (Quality & { queue: string; step: string })[] };
  gaps: string[];
}

// ---------------------------------------------------------------- what a tool call is

const SHELLS = new Set(["Bash", "PowerShell", "exec_command", "shell", "local_shell"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const READ_COMMANDS = new Set([
  "cat", "head", "tail", "sed", "grep", "egrep", "rg", "ls", "dir", "find", "wc", "nl", "less", "more", "type", "file",
  "stat", "du", "tree", "pwd", "echo", "printf", "jq", "sort", "uniq", "cut", "awk", "tr", "column", "diff", "realpath",
  "basename", "dirname", "which", "cd", "true",
  "get-content", "gc", "select-string", "sls", "get-childitem", "gci", "get-item", "test-path", "resolve-path",
  "measure-object", "select-object", "where-object", "format-table", "format-list", "out-string", "set-location",
]);
const GIT_READS = new Set(["log", "diff", "show", "status", "blame", "grep", "ls-files", "rev-parse", "merge-base", "cat-file", "describe", "shortlog", "reflog", "branch"]);
const NEXUS_READS = /^nexus\s+(?:status|help|doc|stats|ideas\s+status|metric\s+list)\b/;
const FILE_READERS = new Set(["cat", "head", "tail", "sed", "nl", "less", "more", "type", "get-content", "gc", "bat"]);

// Matched at a simple command's start (segments), so a grep for "npm test" or a commit message naming it is none.
const FULL_TEST = /^npm(?:\.cmd)?\s+(?:run\s+)?test(?::times)?(?![\w:-])|^node(?:\.exe)?\s+scripts[\\/]test-lock\.ts\b/;
const TEST = /^npm(?:\.cmd)?\s+run\s+test:files\b|^node(?:\.exe)?\s.*\s--test\b/;
const CHECKS = /^npm(?:\.cmd)?\s+run\s+(?:typecheck|lint|knip)\b|^(?:npx\s+)?(?:tsc|eslint|knip)\b/;
const BUILD = /^npm(?:\.cmd)?\s+run\s+build\b|^(?:npx\s+)?vite\s+build\b/;
const STEP_PROGRESS = /^nexus\s+step\s+progress\b/;

/** A command line's simple commands: split at ;, &&, ||, | and new lines, leading variable assignments dropped. */
export function segments(cmd: string): string[] {
  return cmd.split(/\r?\n|&&|\|\||;|\|/).map((s) => s.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")).filter(Boolean);
}

/** A simple command's name, without its folder and .exe/.cmd, in lower case. */
const commandName = (seg: string) => (seg.split(/\s+/)[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd)$/i, "").toLowerCase();

function readOnlySegment(seg: string): boolean {
  const name = commandName(seg);
  if (name === "git") {
    // The subcommand, after git's own options (-C <path> and -c <name=value> take a value).
    const words = seg.split(/\s+/);
    let i = 1;
    while (words[i]?.startsWith("-")) i += words[i] === "-C" || words[i] === "-c" ? 2 : 1;
    const sub = words[i];
    return !!sub && GIT_READS.has(sub) && !(sub === "branch" && /\s-[dDmM]\b/.test(seg));
  }
  if (name === "nexus") return NEXUS_READS.test(seg);
  if (name === "sed") return !/\s-i\b|\s--in-place\b/.test(seg);
  if (name === "find") return !/\s-(?:delete|exec|execdir)\b/.test(seg);
  return READ_COMMANDS.has(name) && !/(^|[^0-9&])>/.test(seg);
}

/** The tool call only reads: a read tool, or a shell command each part of which reads. */
export function readOnly(t: ToolUse): boolean {
  if (READ_TOOLS.has(t.name)) return true;
  if (SHELLS.has(t.name) && t.command) return segments(t.command).every(readOnlySegment);
  return false;
}

/** The files a tool call read whole or in part: Read's file, and the files of cat, head, tail, sed, Get-Content … */
export function readPaths(t: ToolUse): string[] {
  if (t.name === "Read" && t.path) return [t.path];
  if (!SHELLS.has(t.name) || !t.command) return [];
  const out: string[] = [];
  for (const seg of segments(t.command)) {
    const name = commandName(seg);
    if (!FILE_READERS.has(name)) continue;
    const clean = seg.replace(/\d?>>?\s*\S+/g, " ").replace(/<<-?\s*\S+/g, " ");
    const words = (clean.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).slice(1);
    // sed's first word that is no option is its script, unless -e or -f gave it.
    let scriptSkipped = name !== "sed" || /\s-(?:e|f)\b/.test(seg);
    // Options that take a value of their own (head -n 5, Get-Content -TotalCount 5, sed -e 's/a/b/').
    const takesValue = name === "head" || name === "tail" ? /^-[nc]$/
      : name === "get-content" || name === "gc" ? /^-(?:TotalCount|Tail|Head|First|Last|Encoding|Delimiter|ReadCount)$/i
      : name === "sed" ? /^-[ef]$/ : /^$/;
    let skipValue = false;
    for (const w of words) {
      if (skipValue) { skipValue = false; continue; }
      if (w.startsWith("-")) { skipValue = takesValue.test(w); continue; }
      const v = w.replace(/^["']|["']$/g, "");
      if (!scriptSkipped) { scriptSkipped = true; continue; }
      if (/^\d+$/.test(v)) continue;
      if (/[\\/]/.test(v) || /\w\.[A-Za-z0-9]{1,8}$/.test(v)) out.push(v);
    }
  }
  return out;
}

const shellCommands = (c: Call) => c.tools.filter((t) => SHELLS.has(t.name) && t.command).map((t) => t.command!);

// ---------------------------------------------------------------- figures

const context = (t: TokenCounts) => t.input + t.cache_read + t.cache_creation;
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

/** A path with forward slashes, Git Bash's `/c/` as `C:/`. */
const forward = (path: string) => path.replace(/\\/g, "/").replace(/^\/([a-zA-Z])\//, (_, d: string) => `${d}:/`);
/** A project's root as paths are compared with it: forward slashes, no trailing one, lower case. */
const rootKey = (root: string) => root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** A path as the project knows it: relative to its root or worktree, slashes forward. */
export function relativePath(path: string, roots: readonly string[]): string {
  const s = forward(path.trim().replace(/^["']|["']$/g, ""));
  const low = s.toLowerCase();
  for (const r of roots.map(rootKey)) {
    if (low.startsWith(`${r}/`)) return s.slice(r.length + 1);
    if (low.startsWith(`${r}.worktrees/`)) {
      const rest = s.slice(r.length + ".worktrees/".length);
      const slash = rest.indexOf("/");
      return slash < 0 ? rest : rest.slice(slash + 1);
    }
  }
  return s.replace(/^\.\//, "");
}

/** The path lies in one of the projects (its root or a worktree of it). */
export const inside = (path: string | undefined, roots: readonly string[]) => {
  if (!path) return false;
  const p = forward(path).toLowerCase();
  return roots.map(rootKey).some((r) => p === r || p.startsWith(`${r}/`) || p.startsWith(`${r}.worktrees/`));
};

const between = (at: string, since?: string, until?: string) => {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return false;
  return (!since || t >= Date.parse(since)) && (!until || t < Date.parse(until));
};

function span(times: string[]): [string, string] | undefined {
  if (!times.length) return undefined;
  const sorted = [...times].sort();
  return [sorted[0]!, sorted.at(-1)!];
}

const emptyBucket = (): Bucket => ({ calls: 0, weighted: 0, share: 0 });
const emptyQuality = (): Quality => ({ steps_done: 0, fix_it: 0, rejected: 0, provisional: 0, provisional_returned: 0, send_backs: 0, check_fails: 0, check_fix_rounds: 0 });

/** The quality signals of the events in the period, in total, by queue and by step (steps with a signal only). */
function quality(events: readonly EventLine[], sessions: readonly SessionInfo[], since?: string, until?: string): Report["quality"] {
  const role = new Map(sessions.map((s) => [s.id, s.role]));
  const fromUser = (e: EventLine) => e.session === "user" || role.get(e.session) === "user";
  const steps = new Map<string, Quality & { queue: string; step: string }>();
  const at = (queue: string, step: string) => {
    const key = `${queue}/${step}`;
    let q = steps.get(key);
    if (!q) { q = { queue, step, ...emptyQuality() }; steps.set(key, q); }
    return q;
  };
  const inPeriod = events.filter((e) => e.queue && e.step && between(e.at, since, until)).sort((a, b) => a.at.localeCompare(b.at));
  const checks = new Map<string, EventLine[]>();
  for (const e of inPeriod) {
    const q = at(e.queue!, e.step!);
    switch (e.type) {
      case "step.done": q.steps_done = 1; break;
      case "review.sent_back": if (fromUser(e)) q.fix_it++; else q.send_backs++; break;
      case "review.commented": if (e.to === "send_back") q.fix_it++; break;
      case "review.rejected": q.rejected++; break;
      case "review.provisional": q.provisional++; break;
      case "review.fix_asked": q.provisional_returned++; break;
      case "check.result": {
        const key = `${e.queue}/${e.step}/${e.name ?? ""}`;
        checks.set(key, [...(checks.get(key) ?? []), e]);
        break;
      }
      default: break;
    }
  }
  for (const list of checks.values()) {
    const q = at(list[0]!.queue!, list[0]!.step!);
    list.forEach((e, i) => {
      if (e.ok !== false) return;
      q.check_fails++;
      if (i < list.length - 1) q.check_fix_rounds++;
    });
  }
  const keys = Object.keys(emptyQuality()) as (keyof Quality)[];
  const sum = (rows: Quality[]) => {
    const t = emptyQuality();
    for (const r of rows) for (const k of keys) t[k] += r[k];
    return t;
  };
  const all = [...steps.values()];
  const byQueue = new Map<string, Quality[]>();
  for (const s of all) byQueue.set(s.queue, [...(byQueue.get(s.queue) ?? []), s]);
  const signal = (q: Quality) => keys.some((k) => k !== "steps_done" && k !== "provisional" && q[k] > 0);
  return {
    total: sum(all),
    queues: [...byQueue].map(([queue, rows]) => ({ queue, ...sum(rows) })).sort((a, b) => a.queue.localeCompare(b.queue)),
    steps: all.filter(signal).sort((a, b) => a.queue.localeCompare(b.queue) || a.step.localeCompare(b.step, undefined, { numeric: true })),
  };
}

export function analyze(input: Input): Report {
  const { since, until } = input;
  const projects = input.projects?.length ? input.projects : [...new Set([...input.sessions.map((s) => s.project), ...input.turns.map((t) => t.project)])].sort();
  const sessions = input.sessions.filter((s) => projects.includes(s.project));
  const byNative = new Map(input.sessions.filter((s) => s.native_id).map((s) => [s.native_id!, s]));
  const gaps: string[] = [];

  // Which transcripts are the projects', and in which role.
  const mine: { t: Transcript; role: Role }[] = [];
  const unnamed = new Set<number>();
  for (const t of input.transcripts) {
    const s = byNative.get(t.session);
    if (s) {
      if (!projects.includes(s.project)) continue;
      mine.push({ t, role: (ROLES as readonly string[]).includes(s.role) ? (s.role as Role) : "other" });
    } else if (inside(t.cwd, input.roots)) {
      mine.push({ t, role: "other" });
      unnamed.add(mine.length - 1);
    }
  }

  // Per call, with the idle gap before it (over the whole transcript, so a call just inside the period knows its gap).
  interface Row { c: Call; role: Role; /** Its transcript's index in `mine`. */ transcript: number; idle: boolean; w: number }
  const rows: Row[] = [];
  const seen = new Set<string>();
  const perTranscript = mine.map(({ t, role }, i) => {
    const sorted = [...t.calls].sort((a, b) => a.at.localeCompare(b.at));
    const list: Row[] = [];
    sorted.forEach((c, j) => {
      const prev = sorted[j - 1];
      const idle = !!prev && Date.parse(c.at) - Date.parse(prev.at) > IDLE_MS;
      if (!between(c.at, since, until)) return;
      // A forked transcript repeats its parent's calls: each counts once.
      if (c.id && seen.has(c.id)) return;
      if (c.id) seen.add(c.id);
      const r = { c, role, transcript: i, idle, w: weigh(c.tokens) };
      rows.push(r);
      list.push(r);
    });
    return list;
  });
  const weightOf = (list: Row[]) => list.reduce((a, r) => a + r.w, 0);
  const total = weightOf(rows);
  if (unnamed.size) {
    const own = rows.filter((r) => unnamed.has(r.transcript));
    gaps.push(`${[...unnamed].filter((i) => !mine[i]!.t.subagent).length} transcript(s) in the projects' folders belong to no Nexus session (sessions started by hand, or no longer listed): ${own.length} call(s), ${pct(ratio(weightOf(own), total))} of the weighted tokens, counted under role "other".`);
  }
  const bucket = (list: Row[]): Bucket => {
    const weighted = weightOf(list);
    return { calls: list.length, weighted, share: ratio(weighted, total) };
  };

  // Cost by role.
  const roles: RoleRow[] = [];
  for (const role of ROLES) {
    const list = rows.filter((r) => r.role === role);
    if (!list.length) continue;
    const tokens = zeroTokens();
    for (const r of list) addTokens(tokens, r.c.tokens);
    const weighted = weightOf(list);
    const ctx = list.reduce((a, r) => a + context(r.c.tokens), 0);
    const above = Object.fromEntries(THRESHOLDS.map((th) => [`${th}`, ratio(list.filter((r) => context(r.c.tokens) > th).reduce((a, r) => a + context(r.c.tokens), 0), ctx)])) as RoleRow["above"];
    const transcripts = new Set(list.filter((r) => !mine[r.transcript]!.t.subagent).map((r) => r.transcript));
    roles.push({
      role, sessions: transcripts.size, calls: list.length, weighted, share: ratio(weighted, total), tokens,
      cache_read_share: ratio(tokens.cache_read * TOKEN_WEIGHTS.cache_read, weighted), avg_context: ratio(ctx, list.length), above,
    });
  }

  // Cache rewritten after an idle hour: the first call after the gap, its cache writes.
  const idleRows = rows.filter((r) => r.idle && r.c.tokens.cache_creation > 0);
  const idleWeighted = (list: Row[]) => list.reduce((a, r) => a + r.c.tokens.cache_creation * TOKEN_WEIGHTS.cache_creation, 0);
  const idleW = idleWeighted(idleRows);
  const idleByRole: Partial<Record<Role, Bucket>> = {};
  for (const role of ROLES) {
    const list = idleRows.filter((r) => r.role === role);
    if (list.length) { const w = idleWeighted(list); idleByRole[role] = { calls: list.length, weighted: w, share: ratio(w, total) }; }
  }

  // Routine work: a call counts once, in the first that applies: tests, typecheck and lint, build, waiting for the lock.
  const routine = { tests: [] as Row[], checks: [] as Row[], build: [] as Row[], lock_wait: [] as Row[] };
  let fullTests = 0;
  let progress = 0;
  let images = 0;
  let imageCalls = 0;
  const reads = new Map<string, FileReads>();
  for (const r of rows) {
    const segs = shellCommands(r.c).flatMap(segments);
    fullTests += segs.filter((s) => FULL_TEST.test(s)).length;
    progress += segs.filter((s) => STEP_PROGRESS.test(s)).length;
    if (segs.some((s) => FULL_TEST.test(s) || TEST.test(s))) routine.tests.push(r);
    else if (segs.some((s) => CHECKS.test(s))) routine.checks.push(r);
    else if (segs.some((s) => BUILD.test(s))) routine.build.push(r);
    else if (r.c.tools.some((t) => t.lock_wait)) routine.lock_wait.push(r);
    const n = r.c.tools.reduce((a, t) => a + t.images, 0);
    images += n;
    if (n) imageCalls++;
    for (const t of r.c.tools) {
      const paths = readPaths(t);
      for (const p of paths) {
        const path = relativePath(p, input.roots);
        const f = reads.get(path) ?? { path, count: 0, tokens: 0 };
        f.count++;
        f.tokens += t.result_chars / 4 / paths.length;
        reads.set(path, f);
      }
    }
  }
  const top = [...reads.values()].map((f) => ({ ...f, tokens: Math.round(f.tokens) }))
    .sort((a, b) => b.count - a.count || b.tokens - a.tokens || a.path.localeCompare(b.path)).slice(0, input.top ?? 15);

  // The shape of the calls: several tool calls at once, reads only, runs of reads.
  const shapes: Shape[] = [];
  for (const role of ROLES) {
    const list = rows.filter((r) => r.role === role);
    if (!list.length) continue;
    const ro = (r: Row) => r.c.tools.length > 0 && r.c.tools.every(readOnly);
    const readOnlyRows = list.filter(ro);
    const runs = { "2": 0, "3": 0, "4-5": 0, "6+": 0 };
    for (const [i, trows] of perTranscript.entries()) {
      if (mine[i]!.role !== role) continue;
      let run = 0;
      const close = () => {
        if (run === 2) runs["2"]++; else if (run === 3) runs["3"]++; else if (run >= 4 && run <= 5) runs["4-5"]++; else if (run >= 6) runs["6+"]++;
        run = 0;
      };
      for (const r of trows) { if (ro(r)) run++; else close(); }
      close();
    }
    const multi = list.filter((r) => r.c.tools.length >= 2).length;
    const roWeighted = weightOf(readOnlyRows);
    const roleWeighted = weightOf(list);
    shapes.push({
      role, calls: list.length, multi_tool: multi, multi_share: ratio(multi, list.length),
      read_only: readOnlyRows.length, read_only_share: ratio(readOnlyRows.length, list.length), read_only_weighted_share: ratio(roWeighted, roleWeighted), runs,
    });
  }

  // turns.jsonl: every runtime, by role, and the turns that began after an idle hour of their session.
  const turns = input.turns.filter((t) => projects.includes(t.project) && between(t.at, since, until));
  const turnW = (t: TurnRecord) => weightedTokens(t) ?? 0;
  const turnTotal = turns.reduce((a, t) => a + turnW(t), 0);
  const turnRows = new Map<string, TurnRow>();
  for (const t of turns) {
    const key = `${t.role}/${t.runtime}`;
    const row = turnRows.get(key) ?? { role: t.role, runtime: t.runtime, turns: 0, weighted: 0, share: 0, cache_read_share: 0 };
    row.turns++;
    row.weighted += turnW(t);
    row.cache_read_share += ((t.tokens?.cache_read ?? 0) + (t.subagent_tokens?.cache_read ?? 0)) * TOKEN_WEIGHTS.cache_read;
    turnRows.set(key, row);
  }
  for (const row of turnRows.values()) { row.cache_read_share = ratio(row.cache_read_share, row.weighted); row.share = ratio(row.weighted, turnTotal); }
  const lastEnd = new Map<string, number>();
  let idleTurns = 0;
  let idleTurnW = 0;
  for (const t of [...input.turns].filter((x) => projects.includes(x.project)).sort((a, b) => (a.started_at ?? a.at).localeCompare(b.started_at ?? b.at))) {
    const start = Date.parse(t.started_at ?? t.at);
    const prev = lastEnd.get(t.session);
    if (prev !== undefined && start - prev > IDLE_MS && between(t.at, since, until) && (t.tokens?.cache_creation ?? 0) > 0) {
      idleTurns++;
      idleTurnW += t.tokens!.cache_creation * TOKEN_WEIGHTS.cache_creation;
    }
    lastEnd.set(t.session, Math.max(prev ?? 0, Date.parse(t.at)));
  }

  // What is missing.
  const found = new Set(mine.map((m) => m.t.session));
  const withTurns = new Map<string, TurnRecord[]>();
  for (const t of turns) withTurns.set(t.session, [...(withTurns.get(t.session) ?? []), t]);
  const missing = new Map<string, { n: number; w: number }>();
  for (const s of sessions) {
    const list = withTurns.get(s.id);
    if (!list?.length || (s.native_id && found.has(s.native_id))) continue;
    const key = `${s.role} (${s.runtime})`;
    const m = missing.get(key) ?? { n: 0, w: 0 };
    m.n++;
    m.w += list.reduce((a, t) => a + turnW(t), 0);
    missing.set(key, m);
  }
  const known = new Set(sessions.map((s) => s.id));
  const unknownTurns = turns.filter((t) => !known.has(t.session));
  if (unknownTurns.length) gaps.push(`${unknownTurns.length} turn(s) in turns.jsonl name a session the project's folder no longer has (${pct(ratio(unknownTurns.reduce((a, t) => a + turnW(t), 0), turnTotal))} of the turns' weighted tokens).`);
  for (const [key, m] of missing) gaps.push(`${m.n} ${key} session(s) with turns in the period have no transcript on this machine: ${pct(ratio(m.w, turnTotal))} of the turns' weighted tokens are in turns.jsonl only.`);
  const noTokens = turns.filter((t) => !t.tokens).length;
  if (noTokens) gaps.push(`${noTokens} turn(s) have no token figures (interrupted, or no result).`);
  const callSpan = span(rows.map((r) => r.c.at));
  const turnSpan = span(turns.map((t) => t.at));
  if (callSpan && turnSpan && callSpan[0] < turnSpan[0]) gaps.push(`Transcripts reach back to ${callSpan[0]}, turns.jsonl only to ${turnSpan[0]}: the per-turn figures cover less time than the per-call ones.`);
  if (!rows.some((r) => mine[r.transcript]!.t.runtime === "codex")) gaps.push("No Codex call in the period: the per-call figures are Claude Code's only.");
  const events = input.events.filter((e) => between(e.at, since, until));

  return {
    since, until, projects,
    span: { calls: callSpan, turns: turnSpan, events: span(events.map((e) => e.at)) },
    sources: {
      claude_transcripts: mine.filter((m) => m.t.runtime === "claude" && !m.t.subagent).length,
      codex_transcripts: mine.filter((m) => m.t.runtime === "codex" && !m.t.subagent).length,
      subagents: mine.filter((m) => m.t.subagent).length,
      turns: turns.length, events: events.length,
    },
    total_weighted: total, roles,
    idle: { calls: idleRows.length, transcripts: new Set(idleRows.map((r) => r.transcript)).size, weighted: idleW, share: ratio(idleW, total), by_role: idleByRole },
    routine: {
      tests: bucket(routine.tests), checks: bucket(routine.checks), build: bucket(routine.build), lock_wait: bucket(routine.lock_wait),
      full_test_runs: fullTests, lock_queries: routine.lock_wait.length,
    },
    images: { images, calls: imageCalls }, step_progress: progress, reads: top, shapes,
    turns: { rows: [...turnRows.values()].sort((a, b) => b.weighted - a.weighted), total_weighted: turnTotal, idle: { turns: idleTurns, weighted: idleTurnW, share: ratio(idleTurnW, turnTotal) } },
    quality: quality(input.events, input.sessions, since, until),
    gaps,
  };
}

// ---------------------------------------------------------------- the report as Markdown

function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }
function tok(x: number): string {
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)}G`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)}k`;
  return `${Math.round(x)}`;
}
const table = (head: string[], body: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const QUALITY_HEAD = ["done steps", "Fix it", "rejected", "provisional", "provisional returned", "send-backs", "failed checks", "check fix rounds"];
const qualityCells = (q: Quality) => [q.steps_done, q.fix_it, q.rejected, q.provisional, q.provisional_returned, q.send_backs, q.check_fails, q.check_fix_rounds];

/** The report in Markdown: what it covers, the figures, and what is missing. `sources` names the files read. */
export function render(r: Report, sources: string[]): string {
  const out: string[] = [];
  const period = `${r.since ?? "the beginning"} to ${r.until ?? "now"}`;
  out.push("# Token report", "");
  out.push(`- Period: ${period} (since inclusive, until exclusive).`);
  out.push(`- Projects: ${r.projects.join(", ") || "none"}.`);
  if (r.span.calls) out.push(`- Calls found from ${r.span.calls[0]} to ${r.span.calls[1]}.`);
  if (r.span.turns) out.push(`- Turns found from ${r.span.turns[0]} to ${r.span.turns[1]}.`);
  if (r.span.events) out.push(`- Events found from ${r.span.events[0]} to ${r.span.events[1]}.`);
  out.push(`- Read: ${r.sources.claude_transcripts} Claude Code and ${r.sources.codex_transcripts} Codex transcripts (+${r.sources.subagents} of their sub-agents), ${r.sources.turns} turn records, ${r.sources.events} events.`);
  for (const s of sources) out.push(`- Source: ${s}`);
  out.push("- Cost is weighted tokens (TOKEN_WEIGHTS: input 1, output 5, cache write 1.25, cache read 0.1), the API's price ratios; not the subscription's bill.", "");

  out.push("## Cost by role (per model call, transcripts)", "");
  out.push(table(
    ["role", "sessions", "calls", "weighted", "share", "cache read share", "avg context", "context >300k", "context >500k"],
    r.roles.map((x) => [x.role, x.sessions, x.calls, tok(x.weighted), pct(x.share), pct(x.cache_read_share), tok(x.avg_context), pct(x.above["300000"]), pct(x.above["500000"])]),
  ), "");

  out.push("## Cost by role and runtime (per turn, turns.jsonl)", "");
  out.push(table(["role", "runtime", "turns", "weighted", "share", "cache read share"],
    r.turns.rows.map((x) => [x.role, x.runtime, x.turns, tok(x.weighted), pct(x.share), pct(x.cache_read_share)])), "");

  out.push("## Cache rewritten after more than an hour idle", "");
  out.push(`- Per call: ${r.idle.calls} call(s) in ${r.idle.transcripts} transcript(s), ${tok(r.idle.weighted)} weighted, ${pct(r.idle.share)} of all.`);
  for (const [role, b] of Object.entries(r.idle.by_role)) out.push(`  - ${role}: ${b.calls} call(s), ${pct(b.share)}`);
  out.push(`- Per turn: ${r.turns.idle.turns} turn(s), ${pct(r.turns.idle.share)} of the turns' weighted tokens.`, "");

  out.push("## Routine work", "");
  out.push(table(["kind", "calls", "weighted", "share"], [
    ["tests (npm test, test:files, node --test)", r.routine.tests.calls, tok(r.routine.tests.weighted), pct(r.routine.tests.share)],
    ["typecheck, lint, knip", r.routine.checks.calls, tok(r.routine.checks.weighted), pct(r.routine.checks.share)],
    ["build", r.routine.build.calls, tok(r.routine.build.weighted), pct(r.routine.build.share)],
    ["waiting for the full-test lock", r.routine.lock_wait.calls, tok(r.routine.lock_wait.weighted), pct(r.routine.lock_wait.share)],
  ]), "");
  out.push(`- Full \`npm test\` runs started: ${r.routine.full_test_runs}; calls that found the lock busy: ${r.routine.lock_queries}.`);
  out.push(`- Images read back: ${r.images.images} in ${r.images.calls} call(s).`);
  out.push(`- \`nexus step progress\` calls: ${r.step_progress}.`, "");

  out.push("## Files read most often", "");
  out.push(table(["file", "reads", "~tokens (chars/4)"], r.reads.map((f) => [`\`${f.path}\``, f.count, tok(f.tokens)])), "");

  out.push("## The shape of the calls", "");
  out.push(table(["role", "calls", "several tool calls", "read only", "read only (weighted)", "runs of 2", "3", "4-5", "6+"],
    r.shapes.map((s) => [s.role, s.calls, pct(s.multi_share), pct(s.read_only_share), pct(s.read_only_weighted_share), s.runs["2"], s.runs["3"], s.runs["4-5"], s.runs["6+"]])), "");

  out.push("## Quality", "");
  out.push(table(["", ...QUALITY_HEAD], [["total", ...qualityCells(r.quality.total)]]), "");
  out.push("### By queue", "");
  out.push(table(["queue", ...QUALITY_HEAD], r.quality.queues.map((q) => [q.queue, ...qualityCells(q)])), "");
  out.push("### Steps with a signal", "");
  out.push(r.quality.steps.length ? table(["step", ...QUALITY_HEAD], r.quality.steps.map((q) => [`${q.queue}/${q.step}`, ...qualityCells(q)])) : "None.", "");

  out.push("## Gaps", "");
  out.push(...(r.gaps.length ? r.gaps.map((g) => `- ${g}`) : ["- None found."]), "");
  return out.join("\n");
}
