// What the user does from the dashboard, as writes to a project's files. Run by the Nexus server, which is the
// writer of queue definitions, notes and inboxes (docs/PROTOCOL.md, "Rules").
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ProjectFile, QueueFile, USER_SESSION, type InboxEntry, type ReviewPolicy, type SessionFile } from "./schemas.ts";
import { ProjectStore, newId, now, revisionHash } from "./store.ts";
import { isApproved, loadProjectState, type ProjectState } from "./state.ts";

export class ActionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function queueOf(store: ProjectStore, id: string): QueueFile {
  try { return store.readQueue(id); } catch { throw new ActionError(`unknown queue ${id}`, 404); }
}

function stepOf(store: ProjectStore, queue: string, step: string): QueueFile {
  const q = queueOf(store, queue);
  if (!q.steps.some((s) => s.id === step)) throw new ActionError(`queue ${queue} has no step ${step}`, 404);
  return q;
}

const nonEmpty = (text: unknown, what: string): string => {
  if (typeof text !== "string" || !text.trim()) throw new ActionError(`${what} is empty`);
  return text.trim();
};

/** The session that records what the user does in the dashboard. */
export function ensureUserSession(store: ProjectStore): SessionFile {
  try { return store.readSession(USER_SESSION); } catch { /* create it */ }
  const p = store.readProject();
  const s: SessionFile = {
    protocol: 1, id: USER_SESSION, project: p.id, role: "user", runtime: "external", title: "You (dashboard)",
    cwd: p.root, launched_by: "nexus", created_at: now(),
  };
  store.writeSession(s);
  return s;
}

// ---------------------------------------------------------------- notes and messages

export function addNote(store: ProjectStore, queue: string, step: string, text: unknown): string {
  stepOf(store, queue, step);
  const id = newId();
  store.writeNote(queue, { id, step, from: "user", at: now() }, nonEmpty(text, "the note"));
  return id;
}

/** Only a note not yet delivered can be withdrawn. */
export function deleteNote(store: ProjectStore, queue: string, step: string, id: string): void {
  const state = loadProjectState(store);
  const note = state.queues.find((q) => q.id === queue)?.steps.find((s) => s.id === step)?.notes.find((n) => n.id === id);
  if (!note) throw new ActionError("no such note", 404);
  if (note.read_at) throw new ActionError("the note was already delivered", 409);
  const file = join(store.queueDir(queue), "notes", step, `${id}.md`);
  if (existsSync(file)) unlinkSync(file);
}

export function sendMessage(store: ProjectStore, session: string, text: unknown, about?: { queue?: string; step?: string }): string {
  let s: SessionFile;
  try { s = store.readSession(session); } catch { throw new ActionError(`unknown session ${session}`, 404); }
  if (s.role === "user") throw new ActionError("cannot message the dashboard's own session");
  const entry: InboxEntry = { v: 1, id: newId(), at: now(), from: "user", type: "message", text: nonEmpty(text, "the message"), queue: about?.queue, step: about?.step };
  store.appendInbox(session, entry);
  return entry.id;
}

// ---------------------------------------------------------------- queues

export function approveQueue(store: ProjectStore, queue: string, words?: unknown): void {
  const q = queueOf(store, queue);
  const hash = revisionHash(q);
  if (isApproved(q)) throw new ActionError("this revision is already approved", 409);
  const status = q.status === "draft" || q.status === "proposed" ? "approved" : q.status;
  const w = typeof words === "string" && words.trim() ? words.trim() : undefined;
  store.writeQueue({ ...q, status, approvals: [...q.approvals, { revision: q.revision, at: now(), words: w, hash }], updated_at: now() });
}

/**
 * The user takes back the approval of a queue that has never run: it is proposed again and waits for an approval.
 * The withdrawal is recorded beside the approvals, which stay. A queue that has started is paused or stopped instead.
 * Only the user: the dashboard calls this; there is no CLI command and no event for agents.
 */
export function withdrawApproval(store: ProjectStore, queue: string, reason?: unknown): void {
  const q = queueOf(store, queue);
  if (!isApproved(q)) throw new ActionError("the queue's current revision is not approved", 409);
  const view = loadProjectState(store).queues.find((x) => x.id === queue);
  const started = !!view?.run || store.readRun(queue) !== undefined
    || (view?.steps ?? []).some((s) => s.status !== "pending" || s.segments.length > 0);
  if (started) throw new ActionError("the queue has started; pause or stop it instead", 409);
  const r = typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
  store.writeQueue({
    ...q, status: "proposed",
    withdrawals: [...q.withdrawals, { revision: q.revision, at: now(), reason: r, approvals: q.approvals.length }],
    updated_at: now(),
  });
}

export function setQueueSettings(store: ProjectStore, queue: string, settings: { review_policy?: unknown }): void {
  const q = queueOf(store, queue);
  const rp = settings.review_policy;
  if (rp !== undefined && rp !== "continue" && rp !== "wait" && rp !== null) throw new ActionError("review_policy is continue or wait");
  store.writeQueue({ ...q, review_policy: (rp ?? undefined) as ReviewPolicy | undefined, updated_at: now() });
}

// ---------------------------------------------------------------- questions

export function answerAsUser(store: ProjectStore, qid: string, text: unknown, cont?: unknown): void {
  const state = loadProjectState(store);
  const x = state.questions.find((q) => q.qid === qid);
  if (!x) throw new ActionError("no such question", 404);
  if (x.state === "withdrawn") throw new ActionError("the question was withdrawn", 409);
  const user = ensureUserSession(store);
  store.appendEvent({
    v: 1, id: newId(), at: now(), session: user.id, type: "answer.given", qid,
    text: nonEmpty(text, "the answer"), continue: typeof cont === "boolean" ? cont : undefined,
  });
  routeAnswers(store);
}

/**
 * Delivers every final answer (not an escalation) to the inbox of the session that asked, once. Safe to run on
 * every change: an answer already in the inbox is not added again.
 */
export function routeAnswers(store: ProjectStore, state: ProjectState = loadProjectState(store)): number {
  let routed = 0;
  for (const x of state.questions) {
    const asker = state.sessions.find((s) => s.id === x.session);
    if (!asker || asker.role === "user") continue;
    for (const a of x.answers) {
      if (a.escalate) continue;
      const id = `answer-${a.id}`;
      if (asker.inbox.some((m) => m.id === id)) continue;
      store.appendInbox(asker.id, { v: 1, id, at: now(), from: a.by, type: "answer", qid: x.qid, text: a.text, continue: a.continue });
      routed++;
    }
  }
  return routed;
}

// ---------------------------------------------------------------- queue drafts (from an orchestrator)

/**
 * Writes a queue an orchestrator drafted. A new queue becomes `proposed` (or `draft` if it says so). A change to an
 * existing queue's steps, checks or stop conditions makes a new revision, which needs the user's approval again;
 * the approvals, history, run and the steps' recorded states are kept.
 */
export function applyDraft(store: ProjectStore, definition: unknown): string {
  const input = (definition ?? {}) as Record<string, unknown>;
  const parsed = QueueFile.safeParse({ protocol: 1, status: "proposed", ...input });
  if (!parsed.success) throw new ActionError(parsed.error.issues.map((i) => `${i.path.join(".") || "queue"}: ${i.message}`).join("; "));
  const draft = parsed.data;
  if (draft.status !== "draft" && draft.status !== "proposed") throw new ActionError("a drafted queue's status is draft or proposed");
  if (!/^[A-Za-z0-9][\w.-]{0,31}$/.test(draft.id)) throw new ActionError("a queue id is 1-32 letters, digits, dots, dashes or underscores");
  const ids = draft.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new ActionError("step ids must be unique");
  if (!draft.steps.length) throw new ActionError("a queue needs at least one step");

  let old: QueueFile | undefined;
  try { old = store.readQueue(draft.id); } catch { old = undefined; }
  const at = now();
  if (!old) {
    store.writeQueue({ ...draft, revision: 1, approvals: [], history: [], created_at: at, updated_at: at });
    return `queue ${draft.id} created as ${draft.status} (revision 1); the user approves it in the dashboard`;
  }
  const steps = draft.steps.map((s) => {
    const before = old!.steps.find((o) => o.id === s.id);
    return { ...s, status: s.status ?? before?.status, status_note: s.status_note ?? before?.status_note };
  });
  const next: QueueFile = {
    ...old,
    title: draft.title, description: draft.description ?? old.description, track: draft.track ?? old.track,
    worktree: draft.worktree ?? old.worktree, branch: draft.branch ?? old.branch, base: draft.base ?? old.base,
    review_policy: draft.review_policy ?? old.review_policy,
    stop_conditions: draft.stop_conditions, checks: draft.checks, steps, updated_at: at,
  };
  const changed = revisionHash(next) !== revisionHash(old);
  if (changed) {
    next.revision = old.revision + 1;
    next.history = [...old.history, { revision: old.revision, hash: revisionHash(old), replaced_at: at }];
    if (["draft", "proposed", "approved"].includes(old.status)) next.status = draft.status;
  }
  store.writeQueue(next);
  return changed
    ? `queue ${draft.id} updated to revision ${next.revision}; it needs the user's approval again`
    : `queue ${draft.id} updated (no change to steps, checks or stop conditions: the approval stands)`;
}

// ---------------------------------------------------------------- project settings

/** Drops null and empty-string values, so a settings form can clear an optional field. */
function pruned(o: unknown): Record<string, unknown> {
  if (!o || typeof o !== "object" || Array.isArray(o)) return {};
  return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([, v]) => v !== null && v !== ""));
}
function merged(base: object, patch: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries((patch ?? {}) as Record<string, unknown>)) {
    if (v === null || v === "") delete out[k]; else out[k] = v;
  }
  return out;
}

/**
 * Changes a project's settings: its name, defaults, runtimes and whether the orchestrator is notified. The
 * orchestrator's own model and effort go through the orchestrator (they also restart its process); its session,
 * the project's id and root never change here.
 */
export function updateSettings(store: ProjectStore, patch: unknown): void {
  const p = store.readProject();
  const b = pruned(patch) as Record<string, any>;
  const next = {
    ...p,
    name: typeof b.name === "string" && b.name.trim() ? b.name.trim() : p.name,
    defaults: merged(p.defaults, b.defaults),
    runtimes: {
      default: b.runtimes?.default ?? p.runtimes.default,
      claude: merged(p.runtimes.claude, b.runtimes?.claude),
      codex: merged(p.runtimes.codex, b.runtimes?.codex),
    },
    conversations: merged(p.conversations, b.conversations),
    orchestrator: b.orchestrator?.notify === undefined
      ? p.orchestrator
      : { runtime: "claude" as const, session: null, ...p.orchestrator, notify: !!b.orchestrator.notify },
  };
  const r = ProjectFile.safeParse(next);
  if (!r.success) throw new ActionError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const notes = r.data.conversations.notes_dir;
  if (notes !== undefined) r.data.conversations.notes_dir = notesDir(notes);
  store.writeProject(r.data);
}

/** The notes folder, relative to the project's root, inside it, with forward slashes and no trailing slash. */
export function notesDir(dir: string): string {
  const d = dir.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!d || d.startsWith("/") || /^[A-Za-z]:/.test(d) || d.split("/").includes("..")) {
    throw new ActionError("the notes folder is a path inside the project, relative to its root (for example Dev/Concepts/Gameplay)");
  }
  return d;
}
