// The Nexus file protocol, version 1. See docs/PROTOCOL.md.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const Id = z.string().min(1);
const Time = z.string().min(1); // ISO 8601 UTC

export const ReviewPolicy = z.enum(["continue", "wait"]);
export type ReviewPolicy = z.infer<typeof ReviewPolicy>;

export const QueueStatus = z.enum([
  "draft", "proposed", "approved", "running", "paused", "waiting", "stopped", "done", "cancelled",
]);
export type QueueStatus = z.infer<typeof QueueStatus>;

export const StepStatus = z.enum([
  "pending", "running", "waiting", "review", "done", "failed", "skipped", "stopped",
]);
export type StepStatus = z.infer<typeof StepStatus>;

export const Role = z.enum(["worker", "orchestrator"]);
export type Role = z.infer<typeof Role>;

export const Runtime = z.enum(["claude", "codex", "external"]);
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
    context_reuse_threshold: z.number().min(0).max(1).default(0.6),
    usage_pause_threshold: z.number().min(0).max(1).default(0.9),
    worktree_dir: z.string().optional(),
  }).prefault({}),
  runtimes: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  orchestrator: z.object({ runtime: Runtime, session: Id.nullable() }).optional(),
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
  history: z.array(z.object({ revision: z.number().int(), hash: z.string(), replaced_at: Time })).default([]),
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
  z.object({
    ...base, type: z.literal("session.request"),
    action: z.enum(["start", "resume", "fork", "pause", "stop"]), target: z.string(),
    queue: Id.optional(), reason: z.string(),
  }),
  z.object({ ...base, type: z.literal("log"), level: z.enum(["info", "warn", "error"]), text: z.string() }),
]);
export type Event = z.infer<typeof Event>;
export type EventType = Event["type"];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

/** Event types only an orchestrator session may write. */
export const ORCHESTRATOR_ONLY: ReadonlySet<EventType> = new Set([
  "answer.given", "queue.drafted", "session.request",
]);

// ---------------------------------------------------------------- inbox (sessions/<id>/inbox.jsonl)

const ibase = { v: z.literal(1), id: Id, at: Time, from: z.enum(["user", "orchestrator", "nexus"]) };

export const InboxEntry = z.discriminatedUnion("type", [
  z.object({ ...ibase, type: z.literal("message"), text: z.string() }),
  z.object({ ...ibase, type: z.literal("answer"), qid: Id, text: z.string(), continue: z.boolean().optional() }),
  z.object({ ...ibase, type: z.literal("stop"), text: z.string().optional() }),
]);
export type InboxEntry = z.infer<typeof InboxEntry>;
