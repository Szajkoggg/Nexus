// The Nexus file protocol, version 1. See docs/PROTOCOL.md.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const Id = z.string().min(1);
const Time = z.string().min(1); // ISO 8601 UTC

/**
 * What happens when a step is done: `continue` goes on, `wait` holds it for the user, `orchestrator` holds it for the
 * project's orchestrator, who accepts it, sends it back or asks the user (and the user, without one or with its
 * notices off).
 */
export const ReviewPolicy = z.enum(["continue", "wait", "orchestrator"]);
export type ReviewPolicy = z.infer<typeof ReviewPolicy>;

export const QueueStatus = z.enum([
  "draft", "proposed", "approved", "running", "paused", "waiting", "stopped", "done", "cancelled",
]);
export type QueueStatus = z.infer<typeof QueueStatus>;

export const StepStatus = z.enum([
  "pending", "running", "waiting", "review", "done", "failed", "skipped", "stopped",
]);
export type StepStatus = z.infer<typeof StepStatus>;

/**
 * `user` is the one session the server keeps for what the user does in the dashboard (answers, for now).
 * `conversation` is a thinking partner the user talks with about the project (design, ideas): it reads the project
 * and writes only in the project's notes folder; it starts no work.
 */
export const Role = z.enum(["worker", "orchestrator", "user", "conversation"]);
export const USER_SESSION = "user";
export type Role = z.infer<typeof Role>;

export const Runtime = z.enum(["claude", "codex", "external"]);

/**
 * How hard the model thinks. Claude Code takes low to max (--effort); Codex takes what each model lists (low to
 * ultra for most; a turn's effort), so the dashboard offers each model's own levels.
 */
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export type Effort = z.infer<typeof Effort>;
export const CLAUDE_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const ClaudeEffort = Effort.exclude(["ultra"]);
export type Runtime = z.infer<typeof Runtime>;

// ---------------------------------------------------------------- registry (Nexus-level, not per project)

export const RegistryFile = z.object({
  protocol: z.literal(1),
  projects: z.array(z.object({ id: Id, root: z.string() })).default([]),
});
export type RegistryFile = z.infer<typeof RegistryFile>;

// ---------------------------------------------------------------- project.yaml

export const ProjectFile = z.object({
  protocol: z.literal(1),
  id: Id,
  name: z.string(),
  root: z.string(),
  defaults: z.object({
    stop_conditions: z.array(z.string()).default([]),
    review_policy: ReviewPolicy.default("continue"),
    /**
     * How many times the orchestrator may send a step back; its next send-back hands the step to the user instead.
     * The user's Fix it does not count.
     */
    review_send_back_limit: z.number().int().min(0).default(2),
    context_reuse_threshold: z.number().min(0).max(1).default(0.6),
    /**
     * Context care: when a worker's context is fuller than context_reuse_threshold at the end of a step, the next step
     * runs in a fresh session seeded with the context summary, instead of the runtime compacting mid-step.
     */
    context_care: z.boolean().default(true),
    /**
     * Workers may not write under the project's .nexus folder with their file tools (Claude Code: deny rules for Edit
     * and Write on its absolute path). The nexus CLI, which writes their events, is a process and keeps working.
     */
    protect_nexus: z.boolean().default(true),
    /**
     * Push what was accepted: when a step is accepted (by the orchestrator or the user), the server pushes the commit
     * that was HEAD when it entered review to the branch the queue runs on (its upstream remote, else origin).
     */
    push_accepted: z.boolean().default(false),
    usage_pause_threshold: z.number().min(0).max(1).default(0.9),
    worktree_dir: z.string().optional(),
  }).prefault({}),
  runtimes: z.object({
    /** The runtime a run uses when its start does not name one. */
    default: z.enum(["claude", "codex"]).default("claude"),
    claude: z.object({
      model: z.string().optional(),
      effort: ClaudeEffort.optional(),
      permission_mode: z.enum(["acceptEdits", "auto", "bypassPermissions", "dontAsk", "manual", "plan"]).default("acceptEdits"),
      /** Added to every Nexus-launched session; `Bash(nexus:*)` is always allowed. */
      allowed_tools: z.array(z.string()).default([]),
    }).prefault({}),
    codex: z.object({
      model: z.string().optional(),
      effort: Effort.optional(),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
      /** `never`: anything outside the sandbox is refused. `on-request` with an `auto_review` reviewer: Codex's own
       *  reviewer decides each request by its risk, like Claude Code's auto mode. */
      approval_policy: z.enum(["never", "on-request", "untrusted"]).default("never"),
      approvals_reviewer: z.enum(["user", "auto_review", "guardian_subagent"]).optional(),
    }).prefault({}),
  }).prefault({}),
  /** Conversations: thinking partners for the project. */
  conversations: z.object({
    /** The one folder they may write in (their notes), relative to the project's root. */
    notes_dir: z.string().optional(),
    runtime: z.enum(["claude", "codex"]).default("claude"),
    model: z.string().optional(),
    effort: Effort.optional(),
  }).prefault({}),
  orchestrator: z.object({
    runtime: Runtime.default("claude"),
    session: Id.nullable().default(null),
    model: z.string().optional(),
    effort: ClaudeEffort.optional(),
    /** Tell the orchestrator when a worker asks, or a run halts or finishes (it starts if needed). */
    notify: z.boolean().default(true),
  }).optional(),
});
export type ProjectFile = z.infer<typeof ProjectFile>;

// ---------------------------------------------------------------- queue.yaml

export const StepDef = z.object({
  id: Id,
  title: z.string(),
  goal: z.string().default(""),
  acceptance: z.array(z.string()).default([]),
  review: z.object({
    prepare: z.string().optional(),
    rounds: z.number().int().positive().optional(),
    policy: ReviewPolicy.optional(),
  }).optional(),
  /**
   * The runtime, model and effort this step runs on. Each one left out is the run's; with another runtime than the
   * run's, a model or effort left out is the project's default for that runtime.
   */
  runtime: z.enum(["claude", "codex"]).optional(),
  model: z.string().min(1).optional(),
  effort: Effort.optional(),
  /** Baseline state before any event: set by imports and manual corrections. Events take precedence. */
  status: StepStatus.optional(),
  /** Free text recorded with the baseline, e.g. what an import found next to the step. */
  status_note: z.string().optional(),
});
export type StepDef = z.infer<typeof StepDef>;

export const Approval = z.object({
  revision: z.number().int().positive(),
  at: Time,
  words: z.string().optional(),
  hash: z.string(),
});
export type Approval = z.infer<typeof Approval>;

/**
 * The user took an approval back before the queue ever ran. `approvals` is how many approval records there were
 * then: the queue is approved again only by a later one. The approvals themselves stay as they were.
 */
export const Withdrawal = z.object({
  revision: z.number().int().positive(),
  at: Time,
  reason: z.string().optional(),
  approvals: z.number().int().nonnegative(),
});
export type Withdrawal = z.infer<typeof Withdrawal>;

/**
 * One change of a status made through Nexus, in queue.yaml's `changes` (written only by the server). Derivation applies
 * the entries in time order among the events.
 * - `lift`: the user lifted the queue's stop (`by`: approving a new revision, or Continue); the queue becomes approved
 *   and its stopped steps pending again; stops before it no longer count.
 * - `status`: the orchestrator's housekeeping: a step to `skipped`, or the queue to `cancelled`.
 * - `run`: the orchestrator closed a halted run of a queue whose steps are all done or skipped (`finished`).
 * - `proposal`: the orchestrator proposes that the user lift the stop; cleared by a lift, a later stop or an approval.
 */
export const StatusChange = z.object({
  at: Time,
  kind: z.enum(["lift", "status", "run", "proposal"]),
  by: z.enum(["user_approval", "user_continue", "orchestrator"]),
  /** The step it changed; absent: the queue. */
  step: Id.optional(),
  from: z.string(),
  to: z.string(),
  /** Why, in words: for a lift, the stop's own reason as it was derived ("condition: reason"). */
  reason: z.string().optional(),
  /** The revision the change was made on. */
  revision: z.number().int().positive().optional(),
});
export type StatusChange = z.infer<typeof StatusChange>;

export const QueueFile = z.object({
  protocol: z.literal(1),
  id: Id,
  title: z.string(),
  track: z.string().optional(),
  description: z.string().optional(),
  worktree: z.string().optional(), // a path, or "auto"
  branch: z.string().optional(),
  base: z.string().nullable().optional(),
  revision: z.number().int().positive().default(1),
  /** Baseline state before any event. Events take precedence. */
  status: QueueStatus.default("draft"),
  status_note: z.string().optional(),
  review_policy: ReviewPolicy.optional(),
  stop_conditions: z.array(z.string()).default([]),
  checks: z.array(z.string()).default([]),
  steps: z.array(StepDef).default([]),
  approvals: z.array(Approval).default([]),
  withdrawals: z.array(Withdrawal).default([]),
  history: z.array(z.object({ revision: z.number().int(), hash: z.string(), replaced_at: Time })).default([]),
  /** Status changes made through Nexus (lifts of a stop, for now), oldest first. Written only by the server. */
  changes: z.array(StatusChange).default([]),
  source: z.object({ path: z.string(), imported_at: Time }).optional(),
  created_at: Time.optional(),
  updated_at: Time.optional(),
});
export type QueueFile = z.infer<typeof QueueFile>;

// ---------------------------------------------------------------- notes (front matter of notes/<step>/<id>.md)

export const NoteMeta = z.object({
  id: Id,
  step: Id,
  from: z.enum(["user", "orchestrator"]),
  at: Time,
});
export type NoteMeta = z.infer<typeof NoteMeta>;
export type Note = NoteMeta & { queue: string; body: string };

// ---------------------------------------------------------------- session.yaml

export const SessionFile = z.object({
  protocol: z.literal(1),
  id: Id,
  project: Id,
  role: Role,
  runtime: Runtime,
  native_id: z.string().nullable().optional(),
  title: z.string().optional(),
  cwd: z.string(),
  branch: z.string().nullable().optional(),
  queue: Id.nullable().optional(),
  launched_by: z.enum(["nexus", "external"]),
  created_at: Time,
  forked_from: Id.nullable().optional(),
  /** The model asked for when Nexus launched it (an alias or a full name); kept for resuming. */
  model: z.string().optional(),
  /** The effort asked for when Nexus launched it; kept for resuming. */
  effort: Effort.optional(),
  /** A conversation the user put away: kept, not listed first. */
  archived: z.boolean().optional(),
  /** The session this one took over from (context care: the earlier one's context was full). */
  continues: Id.optional(),
  /** The session that took over from this one. */
  continued_by: Id.optional(),
});
export type SessionFile = z.infer<typeof SessionFile>;

// ---------------------------------------------------------------- events (sessions/<id>/events.jsonl)

const base = { v: z.literal(1), id: Id, at: Time, session: Id };
const qs = { queue: Id, step: Id };

export const ReviewItem = z.object({
  path: z.string().optional(),
  url: z.string().optional(),
  label: z.string().optional(),
  kind: z.enum(["image", "sheet", "doc", "data", "link"]).optional(),
}).refine((i) => i.path || i.url, { message: "a review item needs a path or a url" });
export type ReviewItem = z.infer<typeof ReviewItem>;

export const Event = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("step.started"), ...qs }),
  z.object({ ...base, type: z.literal("step.progress"), ...qs, text: z.string(), pct: z.number().min(0).max(100).optional() }),
  z.object({ ...base, type: z.literal("review.added"), ...qs, items: z.array(ReviewItem).min(1), round: z.number().int().optional() }),
  z.object({ ...base, type: z.literal("check.result"), ...qs, name: z.string(), ok: z.boolean(), summary: z.string().optional() }),
  z.object({ ...base, type: z.literal("step.done"), ...qs, summary: z.string(), commit: z.string().optional() }),
  z.object({ ...base, type: z.literal("step.failed"), ...qs, reason: z.string() }),
  z.object({ ...base, type: z.literal("queue.stop"), queue: Id, step: Id.optional(), condition: z.string(), reason: z.string() }),
  z.object({
    ...base, type: z.literal("question.asked"), queue: Id.optional(), step: Id.optional(),
    qid: Id, text: z.string(), options: z.array(z.string()).optional(), can_continue: z.boolean(),
  }),
  z.object({ ...base, type: z.literal("question.withdrawn"), qid: Id, reason: z.string() }),
  z.object({
    ...base, type: z.literal("answer.given"), qid: Id, text: z.string(),
    escalate: z.boolean().optional(), continue: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal("note.read"), note: Id }),
  z.object({ ...base, type: z.literal("message.read"), message: Id }),
  z.object({
    ...base, type: z.literal("context.summary"), queue: Id.optional(), step: Id.optional(),
    text: z.string(), topics: z.array(z.string()).default([]), files: z.array(z.string()).default([]),
  }),
  z.object({ ...base, type: z.literal("queue.report"), queue: Id, path: z.string(), summary: z.string() }),
  z.object({ ...base, type: z.literal("change.proposed"), queue: Id, patch: z.unknown(), reason: z.string() }),
  z.object({ ...base, type: z.literal("queue.drafted"), queue: Id, definition: z.unknown() }),
  /**
   * An orchestrator's housekeeping (`nexus queue set`): `to` is `skipped` (with `step`), `finished` (the queue's halted
   * run), `cancelled` or `propose-lift`. The server checks it and records it in the queue's `changes`.
   */
  z.object({ ...base, type: z.literal("status.set"), queue: Id, step: Id.optional(), to: z.string().min(1), reason: z.string().min(1) }),
  /** An orchestrator asks the engine to act on a queue's run; `use_session` continues an existing session. */
  z.object({
    ...base, type: z.literal("session.request"),
    action: z.enum(["start", "resume", "pause", "stop"]), queue: Id,
    use_session: Id.optional(), model: z.string().optional(), effort: Effort.optional(),
    runtime: z.enum(["claude", "codex"]).optional(), reason: z.string(),
  }),
  z.object({ ...base, type: z.literal("log"), level: z.enum(["info", "warn", "error"]), text: z.string() }),
  /**
   * The user (or orchestrator) accepts a step waiting in review. The user's note (`text`) goes `to` the next step (as
   * a note on it) or the orchestrator (told once, like a chat message of the user).
   */
  z.object({ ...base, type: z.literal("review.accepted"), ...qs, text: z.string().optional(), to: z.enum(["next", "orchestrator"]).optional() }),
  /** The orchestrator (or the user) sends a step in review back to its worker with what to fix. */
  z.object({ ...base, type: z.literal("review.sent_back"), ...qs, text: z.string().min(1) }),
  /** The orchestrator hands a step waiting for its review to the user, saying why. */
  z.object({ ...base, type: z.literal("review.asked_user"), ...qs, text: z.string().min(1) }),
]);
export type Event = z.infer<typeof Event>;
export type EventType = Event["type"];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

/** Event types a worker session may not write (orchestrators and the user may). */
export const ORCHESTRATOR_ONLY: ReadonlySet<EventType> = new Set([
  "answer.given", "queue.drafted", "session.request", "review.accepted", "review.sent_back", "review.asked_user", "status.set",
]);

// ---------------------------------------------------------------- server-owned runtime files

/**
 * queues/<id>/push.yaml: pushing what was accepted. Written only by the server. `review`: the HEAD of the queue's
 * checkout when each step last entered review (`finished_at`: the step.done of that round; `sha` null when it could
 * not be read). `steps`: what became of each accepted step's push (`acceptance`: the review.accepted event's id).
 * `pushed`: the last successful push; `error`: the last failure, until a push succeeds.
 */
export const PushFile = z.object({
  protocol: z.literal(1),
  review: z.record(z.string(), z.object({ sha: z.string().nullable(), finished_at: Time, at: Time })).default({}),
  steps: z.record(z.string(), z.object({
    acceptance: Id, sha: z.string().optional(), result: z.enum(["pushed", "failed", "skipped"]), text: z.string(), at: Time,
  })).default({}),
  pushed: z.object({ sha: z.string(), step: Id, at: Time, remote: z.string(), branch: z.string() }).optional(),
  error: z.object({ text: z.string(), at: Time, sha: z.string().optional(), step: Id }).optional(),
});
export type PushFile = z.infer<typeof PushFile>;

/** queues/<id>/run.yaml: the engine's intent for a queue. Written only by the server. */
export const RunFile = z.object({
  protocol: z.literal(1),
  session: Id,
  /**
   * running: the engine drives the steps. pausing: stop after the current step. paused: user paused or the server
   * restarted. halted: a stop, failure or stall; needs the user. finished: the last step is done.
   * usage_wait: waiting for the subscription window to reset. retry_wait: a turn failed for a passing reason (the
   * service overloaded, the network, a crashed runtime); the turn is tried again at resume_at.
   */
  state: z.enum(["running", "pausing", "paused", "halted", "finished", "usage_wait", "retry_wait"]),
  reason: z.string().optional(),
  step: Id.optional(),        // the step the engine last opened
  nudged: z.boolean().optional(),
  started_at: Time,
  updated_at: Time,
  /** When it last stopped going: became finished, halted or paused. Cleared when it goes on again. */
  ended_at: Time.optional(),
  resume_at: Time.optional(), // usage_wait: when the window resets; retry_wait: when the turn is tried again
  /** Turns that failed in a row for a passing reason; cleared by a turn that ends well and by a new step. */
  retries: z.number().int().optional(),
  /** The runtime's code for the last failure that is being retried (or that halted the run), e.g. `overloaded`. */
  failure: z.string().optional(),
  /** Stopped only for a Nexus update: the server resumes it by itself when it starts again. */
  resume_after_restart: z.boolean().optional(),
  /** The queue's revision the run was started on: a run of an older revision is not resumed. */
  revision: z.number().int().positive().optional(),
  /** The run's own runtime, model and effort, fixed at its start: what a step without its own values runs on. */
  runtime: z.enum(["claude", "codex"]).optional(),
  model: z.string().optional(),
  effort: Effort.optional(),
  /** The step whose end Nexus asked the session to write its context summary for, before a fresh session (asked once). */
  summary_asked: Id.optional(),
  /**
   * Each time the run went on in a fresh session, oldest first. `why`: `context` (context care: the old session's
   * context was full; older records without `why` are this) or `runtime` (the step runs on another runtime). `step` is
   * the first step of the new session, `fill` the old session's context fill (0 to 1) when known, `summary` where the
   * seed came from: `written` (the worker's own summary of the step), `asked` (written when Nexus asked for it),
   * `fallback` (none: the queue's description and the finished steps' summaries).
   */
  switches: z.array(z.object({
    at: Time, from: Id, to: Id, step: Id, why: z.enum(["context", "runtime"]).optional(), fill: z.number().optional(),
    summary: z.enum(["written", "asked", "fallback"]),
  })).optional(),
});
export type RunFile = z.infer<typeof RunFile>;

/** sessions/<id>/delivered.jsonl: what the server handed to a live session (notes in a step turn, inbox entries). */
export const Delivery = z.object({
  at: Time, kind: z.enum(["note", "inbox"]), id: Id,
  /** `carried`: put into the first turn of the session that took over (`to`). */
  via: z.enum(["turn", "inject", "status", "carried"]),
  to: Id.optional(),
});
export type Delivery = z.infer<typeof Delivery>;

/** sessions/<id>/activity.jsonl: a condensed record of what the agent did, from the runtime's stream. */
export const Activity = z.object({
  at: Time,
  kind: z.enum(["turn_start", "text", "tool", "tool_error", "turn_end", "error", "exit", "retry"]),
  text: z.string(),
  queue: Id.optional(),
  step: Id.optional(),
});
export type Activity = z.infer<typeof Activity>;

/**
 * sessions/<id>/refusals.jsonl: one line per action the agent wanted but was refused, from the runtime's stream.
 * Written only by the server. `by`: `permissions` (Claude Code's permission mode or rules), `nexus` (Nexus declined a
 * Codex approval request: it runs unattended), `auto_review` (Codex's auto reviewer denied it).
 */
export const Refusal = z.object({
  at: Time,
  session: Id,
  runtime: z.enum(["claude", "codex"]),
  by: z.enum(["permissions", "nexus", "auto_review"]),
  /** Claude Code: the tool's name (Bash, Write, mcp__server__tool). Codex: command, file_change, network, mcp, permissions, … */
  tool: z.string(),
  /** The input in short: the command, the path, the host (at most 300 characters). */
  input: z.string(),
  reason: z.string().optional(),
  /** The runtime's id for the call (tool_use_id, item id, review id): one record per refusal. */
  ref: z.string().optional(),
  queue: Id.optional(),
  step: Id.optional(),
});
export type Refusal = z.infer<typeof Refusal>;

/** sessions/<id>/runtime.json: live facts about a Nexus-launched session. Written only by the server. */
export const RuntimeFile = z.object({
  state: z.enum(["starting", "working", "idle", "exited"]),
  pid: z.number().int().optional(),
  model: z.string().optional(),
  context_tokens: z.number().optional(),
  context_window: z.number().optional(),
  turns: z.number().int().default(0),
  cost_usd: z.number().optional(),
  updated_at: Time,
});
export type RuntimeFile = z.infer<typeof RuntimeFile>;

/** sessions/<orchestrator>/applied.jsonl: the server's result for each orchestrator request (queue.drafted, session.request). */
export const Applied = z.object({ at: Time, event: Id, ok: z.boolean(), message: z.string() });
export type Applied = z.infer<typeof Applied>;

/** sessions/<orchestrator>/chat.jsonl: the conversation shown in the dashboard. */
export const ChatEntry = z.object({
  at: Time,
  from: z.enum(["user", "orchestrator", "partner", "nexus"]),
  kind: z.enum(["message", "tool", "error"]).default("message"),
  text: z.string(),
});
export type ChatEntry = z.infer<typeof ChatEntry>;

/** <NEXUS_HOME>/usage.json: the subscription's windows, from the last report of any session. */
export const UsageFile = z.object({
  updated_at: Time,
  windows: z.record(z.string(), z.object({ utilization: z.number(), resets_at: Time.optional(), status: z.string().optional() })),
});
export type UsageFile = z.infer<typeof UsageFile>;

// ---------------------------------------------------------------- inbox (sessions/<id>/inbox.jsonl)

const ibase = { v: z.literal(1), id: Id, at: Time, from: z.enum(["user", "orchestrator", "nexus"]) };

export const InboxEntry = z.discriminatedUnion("type", [
  z.object({ ...ibase, type: z.literal("message"), text: z.string(), queue: Id.optional(), step: Id.optional() }),
  /** `id` is "answer-" + the answer.given event's id, so routing the same answer twice is detectable. */
  z.object({ ...ibase, type: z.literal("answer"), qid: Id, text: z.string(), continue: z.boolean().optional() }),
  z.object({ ...ibase, type: z.literal("stop"), text: z.string().optional() }),
  /**
   * A step sent back to its worker (by the orchestrator or the user's Fix it): `id` is "send-back-" + the
   * review.sent_back event's id (`ref`); `round` is the round it opens. Its being in the inbox reopens the step.
   */
  z.object({ ...ibase, type: z.literal("send_back"), ref: Id, queue: Id, step: Id, text: z.string(), round: z.number().int().positive() }),
]);
export type InboxEntry = z.infer<typeof InboxEntry>;

/** Why a runtime cannot run at this effort, or undefined. Codex checks a model's own levels itself. */
export function effortIssue(runtime: "claude" | "codex", effort: Effort | undefined): string | undefined {
  return runtime === "claude" && effort && !CLAUDE_EFFORTS.includes(effort) ? `Claude Code takes effort ${CLAUDE_EFFORTS.join(", ")}` : undefined;
}
