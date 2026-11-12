// What the user does from the dashboard, as writes to a project's files. Run by the Nexus server, which is the
// writer of queue definitions, notes and inboxes (docs/PROTOCOL.md, "Rules").
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { USER_SESSION, type InboxEntry, type QueueFile, type ReviewPolicy, type SessionFile } from "./schemas.ts";
import { ProjectStore, newId, now, revisionHash } from "./store.ts";
import { loadProjectState, type ProjectState } from "./state.ts";

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
  const latest = q.approvals.at(-1);
  if (latest && latest.revision === q.revision && latest.hash === hash) throw new ActionError("this revision is already approved", 409);
  const status = q.status === "draft" || q.status === "proposed" ? "approved" : q.status;
  const w = typeof words === "string" && words.trim() ? words.trim() : undefined;
  store.writeQueue({ ...q, status, approvals: [...q.approvals, { revision: q.revision, at: now(), words: w, hash }], updated_at: now() });
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
