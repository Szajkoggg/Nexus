// The server's replies that the dashboard reads, as types only (this module has no code, so the browser may import it):
// the server builds each reply as one of these and the dashboard reads it as the same, so a change on one side that
// the other does not follow fails the typecheck. docs/protocol/api.md ("Server API") describes the endpoints.
import type { AttentionItem } from "./state.ts";
import type { MergedTemplates, TemplateLayer, TemplateProblem } from "./templates.ts";

/** GET /api/projects: one registered project, with what the sidebar and the waiting list need. */
export interface ProjectSummary {
  id: string; name: string; root: string; error?: string;
  running: number; waiting: number; stopped: number; open_questions: number;
  attention: AttentionItem[];
  /** Where the project's live stream stood when the line was read (docs/protocol/live.md); absent in a live summary. */
  seq?: number;
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
  /** When the stop this was read for came (its queue.stop); a lift decides only on a read of the present stop. */
  stopped_at?: string;
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

/** Where a conversation's model or effort comes from: its own, the project's conversation settings, the runtime's default. */
export type SettingSource = "own" | "project" | "runtime";

/**
 * A conversation's model and effort in its head (GET /api/projects/:id/conversations/:cid and the live stream's
 * `session` message; docs/protocol/conversations.md): `running`, those its running process was started with (null
 * without a process; a null value: the runtime's default); `next`, those its next turn runs on, with their sources;
 * `changes`, whether they differ (the running process ends after its turn, the next turn runs on `next`);
 * `inherited`, what each value would be without its own (the project's conversation settings on its runtime, else the
 * runtime's default, null when unknown), so that the dashboard can name the default a choice goes back to.
 */
export interface ConversationSettings {
  running: { model: string | null; effort: string | null } | null;
  next: { model: string | null; effort: string | null; model_from: SettingSource; effort_from: SettingSource };
  changes: boolean;
  inherited: { model: string | null; effort: string | null; model_from: Exclude<SettingSource, "own">; effort_from: Exclude<SettingSource, "own"> };
}

/**
 * GET /api/projects/:id/removal: whether the project may be removed from Nexus now, and what goes with it or stays
 * (docs/protocol/files.md, "Removing a project"). Neither removal touches the project's own files.
 */
export interface RemovalView {
  /** The project's name: "Delete Nexus's data" asks for it to be typed, and the server checks it. */
  name: string;
  /** What keeps the project from being removed now, one sentence each; empty: it may go. */
  blockers: string[];
  /** Starts by the plan that have not come yet: they go with the project (and come back with it). */
  planned: { queue: string; after: string[] }[];
  /** Scheduled starts: they go with the project too. */
  scheduled: { queue: string; at: string }[];
  /** Open questions: they go with the project too. */
  questions: { qid: string; queue?: string; step?: string; text: string }[];
  /** Worktrees and branches Nexus made for the project's queues: they belong to its git repository and stay. */
  worktrees: { queue: string; path: string; branch?: string; exists: boolean }[];
  /** The folder "Delete Nexus's data" deletes: realpath(<the project's root>)/.nexus. */
  nexus_dir: string;
  /** Why that folder may not be deleted (a link or junction, not Nexus's data, a worktree inside it); absent: it may. */
  delete_refused?: string;
}

/** GET /api/projects/:id/templates: the queue templates in effect for the project (templates.ts), and files not used. */
export interface TemplatesResponse {
  templates: (Pick<MergedTemplates["templates"][number], "id" | "title" | "description" | "params" | "maintenance"> & {
    /** The layer it comes from, and the weaker layers it replaces. */
    layer: TemplateLayer; replaces: TemplateLayer[];
  })[];
  problems: TemplateProblem[];
}
