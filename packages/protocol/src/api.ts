// The server's replies that the dashboard reads, as types only (this module has no code, so the browser may import it):
// the server builds each reply as one of these and the dashboard reads it as the same, so a change on one side that
// the other does not follow fails the typecheck. PROTOCOL.md ("Server API") describes the endpoints.
import type { AttentionItem } from "./state.ts";

/** GET /api/projects: one registered project, with what the sidebar and the waiting list need. */
export interface ProjectSummary {
  id: string; name: string; root: string; error?: string;
  running: number; waiting: number; stopped: number; open_questions: number;
  attention: AttentionItem[];
}

/** One commit in a step's round (git log with its diffstat). */
export interface CommitView {
  sha: string; subject: string; author: string; at: string;
  files: number; insertions: number; deletions: number;
  /** Not made in a turn of the worker's session on this step (the main checkout only). */
  foreign: boolean;
}

/** One round of a step: from its start (or a send-back) to its outcome; `open` while it is at work. */
export interface RoundView { session: string; start: string | null; end: string | null; open: boolean; commits: CommitView[] }

/** GET …/queues/:queue/steps/:step/commits: the step's commits per round; null outside git or with nothing recorded. */
export interface StepCommitsView { rounds: RoundView[] }

/** GET …/queues/:queue/git: the queue's branch; null outside git or detached. */
export interface BranchView {
  branch: string;
  /** Ahead of and behind its base (an auto worktree's, or the queue's named base). */
  base?: { ref: string; ahead: number; behind: number };
  /** Ahead of and behind the local remote-tracking ref (no fetch): `at` is when that ref last changed, if known. */
  upstream?: { ref: string; ahead: number; behind: number; at?: string };
}

/** What a stopped queue's stopped step left behind. */
export interface LeftBehind {
  step: string;
  /** The step's own commits, every round, newest first; those marked foreign are left out. */
  commits: CommitView[];
  /** `git status` of the queue's checkout (read only): `status` is its two-letter code, `path` the file. */
  uncommitted: { status: string; path: string }[];
  uncommitted_note: string;
}

/** GET …/queues/:queue/left: what the stopped step left, and whether a Discard is recorded for this stop; null when not stopped at a step. */
export interface LeftView extends LeftBehind { discarded: { at: string } | null }

/** GET /api/projects/:id/commits/:hash: one commit's details; a binary file's lines are null. */
export interface CommitDetail {
  sha: string; subject: string; author: string; at: string;
  files: { path: string; insertions: number | null; deletions: number | null }[]; insertions: number; deletions: number;
}

/** GET /api/models/:runtime: one model the runtime offers, with the efforts it takes. */
export interface ModelInfo { value: string; label: string; description?: string; efforts?: string[] }
