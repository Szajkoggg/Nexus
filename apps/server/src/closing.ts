// What the closing refactoring step is given when it opens (PROTOCOL.md, "The closing refactoring step"): the queue's
// work as a commit range from its git records (git.yaml: the first start of a round of its own steps to the last end),
// with git's --stat summary, and whether the project's AGENTS.md has a "Refactoring" section to follow. The diff itself
// is not put into the text: the worker reads it with git.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closingStepId, type ProjectStore, type QueueView } from "@nexus/protocol";
import { checkoutOf } from "./gitinfo.ts";

/** How many lines of git's --stat the opening shows at most (the summary line is always kept). */
export const STAT_LINES = 60;

export interface ClosingContext {
  /** The queue's commits: from..to (undefined when the checkout is no git repository, or nothing was recorded). */
  range?: { from: string; to: string };
  /** `git diff --stat from..to`, shortened to STAT_LINES files and the summary line; empty when nothing changed. */
  stat?: string;
  /** The project's AGENTS.md (in the queue's checkout) has a "Refactoring" section. */
  rules: boolean;
}

/** The range of the queue's own steps' rounds of work, from git.yaml; the closing step's own rounds are left out. */
export function queueRange(store: ProjectStore, q: Pick<QueueView, "id">): { from: string; to: string } | undefined {
  const g = store.readGit(q.id);
  const own = Object.entries(g?.steps ?? {}).filter(([step]) => step !== closingStepId(q.id)).flatMap(([, rounds]) => rounds);
  const from = own.filter((r) => r.start).sort((a, b) => a.started_at.localeCompare(b.started_at))[0]?.start;
  const to = own.filter((r) => r.end && r.ended_at).sort((a, b) => a.ended_at!.localeCompare(b.ended_at!)).at(-1)?.end;
  return from && to ? { from, to } : undefined;
}

/** The project's rules file has a "Refactoring" section (a Markdown heading of any level). */
export function hasRefactoringSection(dir: string | undefined): boolean {
  const file = dir ? join(dir, "AGENTS.md") : undefined;
  if (!file || !existsSync(file)) return false;
  try { return /^#{1,6}[ \t]+Refactoring\b/im.test(readFileSync(file, "utf8")); } catch { return false; }
}

/** `git diff --stat` of the range, as git aligns it (git() of gitinfo.ts trims the first line's indent away). */
function diffStat(dir: string, range: { from: string; to: string }): string | undefined {
  try {
    return execFileSync("git", ["diff", "--stat=120", `${range.from}..${range.to}`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }).trimEnd();
  } catch { return undefined; }
}

export function closingContext(store: ProjectStore, q: Pick<QueueView, "id" | "worktree">): ClosingContext {
  const dir = checkoutOf(store, q);
  const range = queueRange(store, q);
  const rules = hasRefactoringSection(dir);
  if (!range || !dir) return { rules };
  const out = diffStat(dir, range);
  if (out === undefined) return { range, rules };
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  const stat = lines.length > STAT_LINES + 1
    ? [...lines.slice(0, STAT_LINES), ` ... ${lines.length - 1 - STAT_LINES} more files`, lines.at(-1)!].join("\n")
    : lines.join("\n");
  return { range, stat, rules };
}
