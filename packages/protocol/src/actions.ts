// What the user does from the dashboard, as writes to a project's files. Run by the Nexus server, which is the
// writer of queue definitions, notes and inboxes (docs/PROTOCOL.md, "Rules").
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ProjectFile, QueueFile, USER_SESSION, type GlobalSettings, effortIssue, type StatusChange, type InboxEntry, ReviewLevel, type RunFile, type SessionFile } from "./schemas.ts";
import { ProjectStore, newId, now, readGlobalSettings, revisionHash, writeGlobalSettings } from "./store.ts";
import { OVERRIDABLE, changedGlobal, settingKey } from "./settings.ts";
import { HOLDING_RUN_STATES } from "./times.ts";
import { commentTarget, isApproved, loadProjectState, pendingProvisional, type ProjectState } from "./state.ts";
import { validAllowRule } from "./refusals.ts";

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

/**
 * The user's note on a step: for its worker, delivered when the step starts; on a step the orchestrator holds in
 * review, for the orchestrator (`to: orchestrator`), which is told it like a chat message of the user.
 */
export function addNote(store: ProjectStore, queue: string, step: string, text: unknown): string {
  stepOf(store, queue, step);
  const id = newId();
  const st = loadProjectState(store).queues.find((q) => q.id === queue)?.steps.find((s) => s.id === step);
  const to = st?.status === "review" && st.review_with === "orchestrator" ? "orchestrator" as const : undefined;
  store.writeNote(queue, { id, step, from: "user", at: now(), to }, nonEmpty(text, "the note"));
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

/**
 * The user approves the queue's current revision. Approving a stopped queue (a new revision drafted after the stop)
 * lifts the stop: a `lift` entry in its changes with the stop's reason, the queue approved, and the old run record
 * archived (run.<time>.yaml), so a start begins at the first pending step. Only the user: the server takes it only
 * from the dashboard's page.
 */
export function approveQueue(store: ProjectStore, queue: string, words?: unknown): void {
  const q = queueOf(store, queue);
  const hash = revisionHash(q);
  if (isApproved(q)) throw new ActionError("this revision is already approved", 409);
  const view = loadProjectState(store).queues.find((x) => x.id === queue);
  const at = now();
  const w = typeof words === "string" && words.trim() ? words.trim() : undefined;
  const approvals = [...q.approvals, { revision: q.revision, at, words: w, hash }];
  if (view?.status === "stopped") {
    const run = store.readRun(queue);
    if (run && ["running", "pausing"].includes(run.state)) throw new ActionError("the queue's run is still going; stop it first", 409);
    const lift = { at, kind: "lift" as const, by: "user_approval" as const, from: "stopped", to: "approved", reason: view.status_reason, revision: q.revision };
    store.writeQueue({ ...q, status: "approved", status_note: undefined, approvals, changes: [...q.changes, lift], updated_at: at });
    store.archiveRun(queue);
    return;
  }
  const status = q.status === "draft" || q.status === "proposed" ? "approved" : q.status;
  store.writeQueue({ ...q, status, approvals, updated_at: at });
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

/** A review level from a request: 1, 2 or 3; null clears it. */
function levelOf(x: unknown, what: string): ReviewLevel | undefined {
  if (x === null) return undefined;
  const parsed = ReviewLevel.safeParse(x);
  if (!parsed.success) throw new ActionError(`${what} is 1, 2 or 3 (or null to clear it)`);
  return parsed.data;
}

/** The user's settings of a queue: its review level (null: the project's). Not part of what an approval pins. */
export function setQueueSettings(store: ProjectStore, queue: string, settings: { review_level?: unknown }): void {
  const q = queueOf(store, queue);
  if (settings.review_level === undefined) return;
  store.writeQueue({ ...q, review_level: levelOf(settings.review_level, "review_level"), updated_at: now() });
}

/**
 * The user sets a step's review level (null: back to what the step was drafted with). Recorded in the queue's
 * `user_levels`, which an approval does not pin, so it asks for no new approval, and which a later revision keeps.
 * Only the user: the dashboard calls this; there is no CLI command and no event for agents.
 */
export function setStepLevel(store: ProjectStore, queue: string, step: string, level: unknown): void {
  const q = queueOf(store, queue);
  if (!q.steps.some((s) => s.id === step)) throw new ActionError(`queue ${q.id} has no step ${step}`, 404);
  const value = levelOf(level, "a step's level");
  const { [step]: _old, ...rest } = q.user_levels ?? {};
  const user_levels = value === undefined ? rest : { ...rest, [step]: value };
  store.writeQueue({ ...q, user_levels: Object.keys(user_levels).length ? user_levels : undefined, updated_at: now() });
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

// ---------------------------------------------------------------- review pictures: marks and comments

/** The user's review picture of a step, by its path; refused when the step has no such picture. */
function pictureOf(store: ProjectStore, queue: string, step: string, path: unknown) {
  stepOf(store, queue, step);
  const q = loadProjectState(store).queues.find((x) => x.id === queue)!;
  const st = q.steps.find((s) => s.id === step)!;
  const item = typeof path === "string" ? st.review_items.find((r) => r.path === path) : undefined;
  if (!item) throw new ActionError(`step ${queue}/${step} has no review picture ${String(path)}`, 404);
  return { q, st, item, path: path as string };
}

/** The user marks a review picture accepted (or takes the mark back). A mark only: the step is not accepted. */
export function markPicture(store: ProjectStore, req: { queue: string; step: string; path: unknown; accepted: unknown }): void {
  const { path } = pictureOf(store, req.queue, req.step, req.path);
  const user = ensureUserSession(store);
  store.appendEvent({ v: 1, id: newId(), at: now(), session: user.id, type: "review.marked", queue: req.queue, step: req.step, path, accepted: req.accepted !== false });
}

/**
 * The user's comment on a review picture: while the step waits for the user's review it goes back to the worker
 * with a send-back (a Fix it, see sendBack); otherwise it becomes a note on the next pending step (commentTarget).
 * Recorded as review.commented. Returns where it went.
 */
export function commentOnPicture(store: ProjectStore, req: { queue: string; step: string; path: unknown; text: unknown }): string {
  const text = nonEmpty(req.text, "the comment");
  const { q, item, path } = pictureOf(store, req.queue, req.step, req.path);
  const target = commentTarget(q, req.step);
  if (target.to === "none") throw new ActionError(`step ${req.queue}/${req.step} is not waiting for your review and no step after it is pending: the comment has nowhere to go`, 409);
  const about = `About the picture "${item.label ?? path.split(/[\\/]/).at(-1)}" (${path}):\n${text}`;
  const user = ensureUserSession(store);
  store.appendEvent({ v: 1, id: newId(), at: now(), session: user.id, type: "review.commented", queue: req.queue, step: req.step, path, text, to: target.to, note_step: target.to === "note" ? target.step : undefined });
  if (target.to === "send_back") return sendBack(store, { queue: req.queue, step: req.step, from: "user", text: about });
  if (target.to === "orchestrator") {
    addNote(store, req.queue, req.step, about); // the step is in the orchestrator's review: a note for it
    return `the comment goes to the orchestrator, which weighs it in its review of step ${req.step}`;
  }
  addNote(store, req.queue, target.step, about);
  return `the comment is a note on step ${target.step}, delivered when it starts`;
}

// ---------------------------------------------------------------- sending a step back

/**
 * Delivers every send-back the derivation accepted (not one beyond the orchestrator's limit) to the inbox of the
 * session that worked on the step, once; that entry reopens the step as its next round. Safe to run on every change.
 */
export function routeSendBacks(store: ProjectStore, state: ProjectState = loadProjectState(store)): number {
  let routed = 0;
  for (const q of state.queues) for (const st of q.steps) for (const b of st.sent_back) {
    if (b.delivered || b.to_user || !st.session) continue;
    const worker = state.sessions.find((s) => s.id === st.session);
    if (!worker || worker.role !== "worker") continue;
    const id = `send-back-${b.id}`;
    if (worker.inbox.some((m) => m.id === id)) continue;
    store.appendInbox(worker.id, { v: 1, id, at: now(), from: b.by, type: "send_back", ref: b.id, queue: q.id, step: st.id, text: b.text, round: b.round });
    routed++;
  }
  return routed;
}

/**
 * Sends a step in review back to its worker with what to fix: the orchestrator's send-back (its review.sent_back
 * event, `event`, written by `nexus review send-back`), or the user's Fix it (written here, as the user's session; also
 * what picture comments become). The step reopens in the same session as the next round; on a paused or halted run
 * the message waits for the resume. Beyond `defaults.review_send_back_limit` the orchestrator's send-back hands the
 * step to the user instead. Returns what became of it.
 */
export function sendBack(store: ProjectStore, req: { queue: string; step: string; from: "orchestrator" | "user"; text: unknown; event?: string }): string {
  nonEmpty(req.text, req.from === "user" ? "what to fix" : "the send-back");
  const text = req.text as string; // recorded verbatim
  stepOf(store, req.queue, req.step);
  let id = req.event;
  if (req.from === "user") {
    const st = loadProjectState(store).queues.find((q) => q.id === req.queue)!.steps.find((s) => s.id === req.step)!;
    // Fix it on a step the orchestrator accepted provisionally: it stays done; the orchestrator drafts the fix.
    if (pendingProvisional(st)) return askFix(store, req.queue, req.step, text);
    if (st.status !== "review" || st.review_with !== "user") throw new ActionError(`step ${req.queue}/${req.step} is not waiting for your review`, 409);
    const user = ensureUserSession(store);
    id = newId();
    store.appendEvent({ v: 1, id, at: now(), session: user.id, type: "review.sent_back", queue: req.queue, step: req.step, text });
  }
  if (!id) throw new ActionError("an orchestrator's send-back is its review.sent_back event");
  routeSendBacks(store);
  const state = loadProjectState(store);
  const st = state.queues.find((q) => q.id === req.queue)!.steps.find((s) => s.id === req.step)!;
  const b = st.sent_back.find((x) => x.id === id);
  if (!b) {
    const why = state.warnings.find((w) => w.startsWith(`event ${id}:`));
    throw new ActionError(why ? why.replace(/^event \S+: /, "") : `step ${req.queue}/${req.step} could not be sent back`, 409);
  }
  if (b.to_user) return `step ${req.queue}/${req.step} goes to the user: it was sent back ${state.project.defaults.review_send_back_limit} times already`;
  if (!b.delivered) throw new ActionError(`step ${req.queue}/${req.step} has no worker session to send it back to`, 409);
  return `step ${req.queue}/${req.step} sent back to its worker as round ${b.round}`;
}

// ---------------------------------------------------------------- provisional acceptances (review level 3)

/** A step of the queue with a provisional acceptance waiting for the user, or a refusal saying why not. */
function provisionalStep(store: ProjectStore, queue: string, step: string) {
  stepOf(store, queue, step);
  const st = loadProjectState(store).queues.find((q) => q.id === queue)!.steps.find((s) => s.id === step)!;
  if (!pendingProvisional(st)) {
    throw new ActionError(st.provisional?.confirmed ? `step ${queue}/${step} is confirmed already`
      : st.provisional?.fix ? `a fix of step ${queue}/${step} was asked already`
      : `step ${queue}/${step} has no provisional acceptance waiting for you`, 409);
  }
  return st;
}

/**
 * The user confirms a step the orchestrator accepted provisionally: it leaves the return batch (and, with
 * provisional_counts off, what builds on it may be pushed). Only the user: the dashboard calls this; there is no CLI
 * command, and the orchestrator's review.confirmed is ignored.
 */
export function confirmProvisional(store: ProjectStore, queue: string, step: string): string {
  provisionalStep(store, queue, step);
  const user = ensureUserSession(store);
  store.appendEvent({ v: 1, id: newId(), at: now(), session: user.id, type: "review.confirmed", queue, step });
  return `step ${queue}/${step} confirmed`;
}

/**
 * The user's Fix it on a step the orchestrator accepted provisionally (`text`: what to fix, verbatim). The step stays
 * done and its work stays: the orchestrator is told (whatever its notices say) and drafts a revision with a step that
 * fixes it. A queue that went on waits for that approval at its running step's end (approval_wait); a finished queue
 * gets a revision the user approves and starts.
 */
function askFix(store: ProjectStore, queue: string, step: string, text: string): string {
  provisionalStep(store, queue, step);
  const user = ensureUserSession(store);
  store.appendEvent({ v: 1, id: newId(), at: now(), session: user.id, type: "review.fix_asked", queue, step, text });
  return `the orchestrator drafts a fix of step ${queue}/${step} as a new revision of queue ${queue}`;
}

// ---------------------------------------------------------------- queue drafts (from an orchestrator)

/** What a draft may not change of a started step (besides removing it or moving it among the started steps). */
const STEP_FIELDS = ["title", "goal", "acceptance", "review", "runtime", "model", "effort"] as const;
/** What a draft may not change of a queue once a run exists. */
const CHECKOUT_FIELDS = ["worktree", "branch", "base"] as const;

/** A started step: one that has been at work (segments), or whose status is neither pending nor skipped. */
function hasStarted(v: { segments: unknown[]; status: string }): boolean {
  return v.segments.length > 0 || !["pending", "skipped"].includes(v.status);
}

/** A record by step id with only the steps a revision keeps (undefined when none is left). */
function keptLevels<T>(byStep: Record<string, T> | undefined, steps: { id: string }[]): Record<string, T> | undefined {
  const kept = Object.entries(byStep ?? {}).filter(([id]) => steps.some((s) => s.id === id));
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/**
 * Writes a queue an orchestrator drafted. A new queue becomes `proposed` (or `draft` if it says so). A change to an
 * existing queue's steps, checks or stop conditions makes a new revision, which needs the user's approval again;
 * the approvals, history, run and the steps' recorded states are kept. A revision changes only what has not started:
 * pending steps may be added, changed, removed or reordered; a started step's definition, presence and order among
 * the started steps stay, and once the queue has run its worktree, branch and base stay too.
 */
export function applyDraft(store: ProjectStore, definition: unknown): string {
  const input = (definition ?? {}) as Record<string, unknown>;
  const parsed = QueueFile.safeParse({ protocol: 1, status: "proposed", ...input });
  if (!parsed.success) throw new ActionError(parsed.error.issues.map((i) => `${i.path.join(".") || "queue"}: ${i.message}`).join("; "));
  // The levels the user set are the user's, and old policies are the server's: a draft brings neither (an existing
  // queue's stay, below).
  const draft = { ...parsed.data, user_levels: undefined, legacy_policies: undefined };
  if (draft.status !== "draft" && draft.status !== "proposed") throw new ActionError("a drafted queue's status is draft or proposed");
  if (!/^[A-Za-z0-9][\w.-]{0,31}$/.test(draft.id)) throw new ActionError("a queue id is 1-32 letters, digits, dots, dashes or underscores");
  const ids = draft.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new ActionError("step ids must be unique");
  if (!draft.steps.length) throw new ActionError("a queue needs at least one step");
  for (const st of draft.steps) {
    const issue = st.runtime ? effortIssue(st.runtime, st.effort) : undefined;
    if (issue) throw new ActionError(`step ${st.id}: ${issue}`);
  }

  let old: QueueFile | undefined;
  try { old = store.readQueue(draft.id); } catch { old = undefined; }
  const at = now();
  // A new step starts pending, or skipped (kept for the record); statuses change through nexus queue set only.
  const fresh = draft.steps.filter((s) => !old?.steps.some((o) => o.id === s.id) && s.status && s.status !== "skipped");
  if (fresh.length) throw new ActionError(`a new step has no status or skipped: ${fresh.map((s) => `${s.id} (${s.status})`).join(", ")}`);
  if (!old) {
    store.writeQueue({ ...draft, revision: 1, approvals: [], history: [], created_at: at, updated_at: at });
    return `queue ${draft.id} created as ${draft.status} (revision 1); the user approves it in the dashboard`;
  }
  // A draft may not change the status of an existing step (that is nexus queue set's, recorded), nor drop a step
  // that has started or stopped (keep it and skip it, so the record shows what became of it).
  const statusChanged = draft.steps.flatMap((s) => {
    const before = old!.steps.find((o) => o.id === s.id);
    return before && s.status !== undefined && s.status !== before.status ? [`${s.id} (${before.status ?? "pending"} in the file, ${s.status} in the draft)`] : [];
  });
  if (statusChanged.length) throw new ActionError(`a draft does not change the status of an existing step: ${statusChanged.join(", ")}. Leave the status out, or as it is; housekeeping is nexus queue set QUEUE --step STEP skipped --reason "..."`);
  const view = loadProjectState(store).queues.find((x) => x.id === old!.id);
  const started = new Map((view?.steps ?? []).filter(hasStarted).map((v) => [v.id, v.status] as const));
  const dropped = old.steps.filter((o) => started.has(o.id) && !draft.steps.some((s) => s.id === o.id)).map((o) => `${o.id} (${started.get(o.id)})`);
  if (dropped.length) throw new ActionError(`a draft does not drop a step that has started or stopped: ${dropped.join(", ")}. Keep it in the draft and skip it with nexus queue set QUEUE --step STEP skipped --reason "replaced by ..."`);
  // A revision changes only what has not started: a started step keeps what it was approved as, and its place among
  // the other started steps; a change to it goes to its worker.
  const touched = draft.steps.flatMap((s) => {
    const before = old!.steps.find((o) => o.id === s.id);
    if (!before || !started.has(s.id)) return [];
    const fields = STEP_FIELDS.filter((f) => JSON.stringify(s[f]) !== JSON.stringify(before[f]));
    return fields.length ? [`${s.id} (${started.get(s.id)}): its ${fields.join(", ")}`] : [];
  });
  const order = (steps: { id: string }[]) => steps.filter((s) => started.has(s.id)).map((s) => s.id).join(", ");
  if (order(draft.steps) !== order(old.steps)) touched.push(`the order of the started steps (${order(old.steps)} in the queue, ${order(draft.steps)} in the draft)`);
  if (touched.length) throw new ActionError(`a revision changes only steps that have not started; this draft changes ${touched.join("; ")}. Leave started steps as they are: a change to one goes to its worker as a message, or with nexus review send-back when it waits for your review`);
  // Once a run exists, its work is in its checkout: the queue keeps it.
  if (store.readRun(old.id) || started.size) {
    const moved = CHECKOUT_FIELDS.filter((f) => draft[f] !== undefined && draft[f] !== old![f]).map((f) => `${f} (${old![f] ?? "none"} in the queue, ${draft[f]} in the draft)`);
    if (moved.length) throw new ActionError(`queue ${old.id} has run: a draft does not change its ${moved.join(", ")}, since its work is in that checkout. Leave them out or as they are; work for another checkout is a new queue`);
  }
  const steps = draft.steps.map((s) => {
    const before = old!.steps.find((o) => o.id === s.id);
    return { ...s, status: s.status ?? before?.status, status_note: s.status_note ?? before?.status_note };
  });
  const next: QueueFile = {
    ...old,
    title: draft.title, description: draft.description ?? old.description, track: draft.track ?? old.track,
    worktree: draft.worktree ?? old.worktree, branch: draft.branch ?? old.branch, base: draft.base ?? old.base,
    review_level: draft.review_level ?? old.review_level,
    // The user's levels stay over whatever the revision drafts, for the steps it keeps.
    user_levels: keptLevels(old.user_levels, steps),
    // What the steps done before review levels meant stays with them.
    legacy_policies: keptLevels(old.legacy_policies, steps),
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

/**
 * The user's Continue on a stopped queue whose current revision is approved: a `lift` by `user_continue` with the
 * stop's reason, and the queue approved. The run goes on afterwards (the engine's continueQueue). With the revision
 * not approved the user approves it instead, which lifts the stop too. Only the user: the dashboard calls this.
 */
export function liftByContinue(store: ProjectStore, queue: string): StatusChange {
  const q = queueOf(store, queue);
  const view = loadProjectState(store).queues.find((x) => x.id === q.id)!;
  if (view.status !== "stopped") throw new ActionError(`queue ${q.id} is not stopped (it is ${view.status})`, 409);
  if (!isApproved(q)) throw new ActionError(`revision ${q.revision} of queue ${q.id} is not approved: approve it instead, which lifts the stop`, 409);
  const run = store.readRun(q.id);
  if (run && HOLDING_RUN_STATES.includes(run.state)) throw new ActionError(`queue ${q.id}'s run is still going (${run.state})`, 409);
  const at = now();
  const lift: StatusChange = { at, kind: "lift", by: "user_continue", from: "stopped", to: "approved", reason: view.status_reason, revision: q.revision };
  store.writeQueue({ ...q, status: "approved", status_note: undefined, changes: [...q.changes, lift], updated_at: at });
  return lift;
}

// ---------------------------------------------------------------- housekeeping by the orchestrator

/**
 * The orchestrator's housekeeping (`nexus queue set`, event `status.set`), recorded as an entry in the queue's
 * `changes`. Allowed: a pending, stopped or failed step to `skipped`; a halted run of a queue whose steps are all done
 * or skipped to `finished`; a queue whose run is not going to `cancelled`; and `propose-lift` on a stopped queue.
 * Consent stays the user's: marking work done, approving, lifting a stop, reopening a finished step.
 */
/**
 * A run of an older revision than `revision` (the queue's current one, or the one just approved): a run without the
 * field is older when a revision of the queue (its `history`) was replaced after the run started.
 */
export function runIsOlder(run: Pick<RunFile, "revision" | "started_at">, revision: number, history: QueueFile["history"]): boolean {
  return run.revision !== undefined ? run.revision < revision : history.some((h) => h.replaced_at > run.started_at);
}

/** A live run (one that is going) has the step open: the step is at work. */
function heldByLiveRun(run: RunFile | undefined, step: string): boolean {
  return !!run && HOLDING_RUN_STATES.includes(run.state) && run.step === step;
}

/**
 * Steps a revision change left open (`running` or `waiting`, opened before the current revision replaced the one
 * before) go back to `pending` unless the queue's run record has them open (of any revision, halted or paused too:
 * the run finishes the step or a resume continues it), each through a `changes` entry by Nexus ("its run was replaced
 * by revision N"), so a start begins there. A new start (`replacing`) also releases the step the run record it
 * replaces has open ("… by a new start"). Called at the start of a run (which replaces the run record) and at server
 * start, which cleans a step an earlier server left so (a run record replaced, or a revision change before runs went
 * on across revisions). Returns the steps released.
 */
export function releaseOrphanedSteps(store: ProjectStore, queueId: string, o: { replacing?: boolean } = {}): string[] {
  const view = loadProjectState(store).queues.find((x) => x.id === queueId);
  if (!view || view.status === "done" || view.status === "cancelled") return [];
  // The run record holds the step it has open, whatever its revision: a revision changes no started step, so the run
  // finishes that step (or resumes it) and takes the new revision at the step's end.
  const current = store.readRun(queueId);
  // What a revision change set aside: a step opened (its latest stretch at work began) before the current revision
  // replaced the one before. A step opened since (by a run of this revision, or by hand) is left alone, except the one
  // the run record has open when a new start replaces that record (`replacing`).
  const changed = view.history.at(-1)?.replaced_at;
  const opened = (s: (typeof view.steps)[number]) => s.segments.at(-1)?.start ?? s.started_at ?? "";
  const why = (s: (typeof view.steps)[number]): string | undefined => {
    if (s.status !== "running" && s.status !== "waiting") return undefined;
    if (current?.step === s.id) return o.replacing ? "its run was replaced by a new start" : undefined;
    return changed && opened(s) < changed ? `its run was replaced by revision ${view.revision}` : undefined;
  };
  const open = view.steps.flatMap((s) => { const r = why(s); return r ? [{ s, r }] : []; });
  if (!open.length) return [];
  const q = store.readQueue(queueId);
  const at = now();
  store.writeQueue({
    ...q, updated_at: at,
    changes: [...q.changes, ...open.map(({ s, r }) => ({
      at, kind: "status" as const, by: "nexus" as const, step: s.id, from: s.status, to: "pending", reason: r, revision: q.revision,
    }))],
  });
  return open.map(({ s }) => s.id);
}

export function orchestratorStatusChange(store: ProjectStore, input: { queue: string; step?: string; to: string; reason: string }): string {
  const to = input.to.trim().toLowerCase();
  const reason = nonEmpty(input.reason, "the reason");
  const q = queueOf(store, input.queue);
  const view = loadProjectState(store).queues.find((x) => x.id === q.id)!;
  const step = input.step ? view.steps.find((s) => s.id === input.step) : undefined;
  if (input.step && !step) throw new ActionError(`queue ${q.id} has no step ${input.step} (has ${view.steps.map((s) => s.id).join(", ")})`, 404);
  const where = step ? `step ${q.id}/${step.id}` : `queue ${q.id}`;

  if (to === "done") throw new ActionError("the orchestrator never marks a step done: work done elsewhere is skipped, with the reason saying where it was done");
  if (to === "approved" || to === "approve") throw new ActionError("approving is the user's, in the dashboard");
  if (["lift", "lifted", "resume", "continue"].includes(to) || (!step && ["approved", "running", "pending"].includes(to))) {
    throw new ActionError("only the user lifts a stop (by approving a new revision, or with Continue); propose it with: nexus queue set QUEUE propose-lift --reason \"...\"");
  }
  if (step && ["pending", "running", "reopened", "reopen"].includes(to)) {
    throw new ActionError(step.status === "pending" ? `${where} is pending already` : `reopening ${where} (${step.status}) is the user's: a send-back`);
  }

  const at = now();
  const record = (entry: Omit<StatusChange, "at" | "by" | "revision">): void => {
    store.writeQueue({ ...q, changes: [...q.changes, { at, by: "orchestrator", revision: q.revision, ...entry }], updated_at: at });
  };
  switch (to) {
    case "skipped": {
      if (!step) throw new ActionError("skipping is for a step: nexus queue set QUEUE --step STEP skipped --reason \"...\"");
      if (view.status === "done" || view.status === "cancelled") throw new ActionError(`queue ${q.id} is ${view.status}`, 409);
      // A running step no live run holds (one a revision change left behind) is not at work: it may be skipped.
      const orphaned = step.status === "running" && !heldByLiveRun(store.readRun(q.id), step.id);
      if (!["pending", "stopped", "failed"].includes(step.status) && !orphaned) {
        throw new ActionError(step.status === "done" || step.status === "skipped"
          ? `${where} is ${step.status} already`
          : `${where} is ${step.status}: a step at work is not skipped (pause or stop the run first)`, 409);
      }
      record({ kind: "status", step: step.id, from: step.status, to: "skipped", reason });
      return `${where} skipped (was ${step.status})`;
    }
    case "finished": {
      if (step) throw new ActionError("finished is for a queue's halted run, not for a step");
      const run = store.readRun(q.id);
      if (run?.state !== "halted") throw new ActionError(`queue ${q.id} has no halted run${run ? ` (its run is ${run.state})` : ""}`, 409);
      const open = view.steps.filter((s) => s.status !== "done" && s.status !== "skipped");
      if (open.length) throw new ActionError(`queue ${q.id} still has steps that are not done or skipped: ${open.map((s) => `${s.id} (${s.status})`).join(", ")}`, 409);
      store.writeRun(q.id, { ...run, state: "finished", reason: undefined, resume_after_restart: undefined, resume_at: undefined, updated_at: at });
      record({ kind: "run", from: "halted", to: "finished", reason });
      return `the halted run of queue ${q.id} is closed as finished`;
    }
    case "cancelled": {
      if (step) throw new ActionError("cancelling is for a queue; a step is skipped");
      if (view.status === "done" || view.status === "cancelled") throw new ActionError(`queue ${q.id} is ${view.status} already`, 409);
      const run = store.readRun(q.id);
      if (run && HOLDING_RUN_STATES.includes(run.state)) throw new ActionError(`queue ${q.id} is ${run.state === "running" ? "running" : `running (${run.state})`}: stop its run first`, 409);
      record({ kind: "status", from: view.status, to: "cancelled", reason });
      return `queue ${q.id} cancelled (was ${view.status}); the user is notified`;
    }
    case "propose-lift": {
      if (step) throw new ActionError("a proposal to lift is for a queue");
      if (view.status !== "stopped") throw new ActionError(`queue ${q.id} is not stopped (it is ${view.status})`, 409);
      record({ kind: "proposal", from: "stopped", to: "lift proposed", reason });
      return `your proposal to lift the stop of queue ${q.id} is recorded; the user decides (Continue, or approving a new revision)`;
    }
    default:
      throw new ActionError(`${to} is not a status the orchestrator sets: a step can be skipped; a queue cancelled, its halted run finished, or a lift proposed (propose-lift)`);
  }
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
 * Changes a project's settings: its name, defaults, runtimes, languages and whether the orchestrator is notified. The
 * orchestrator's own model and effort go through the orchestrator (they also restart its process); its session,
 * the project's id and root never change here. A setting this gives another value becomes the project's own; one it
 * leaves as it is keeps following the global value (or keeps its own). `follow`: settings, by key
 * (`runtimes.claude.model`), that follow the global value again (store.updateProject).
 */
export function updateSettings(store: ProjectStore, patch: unknown): void {
  const p = store.readProject();
  const b = pruned(patch) as Record<string, any>;
  const keys = (name: "follow" | "own") => {
    const v = b[name];
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x: unknown) => typeof x === "string")) throw new ActionError(`${name} is a list of setting keys, like runtimes.claude.model`);
    return v as string[];
  };
  const follow = keys("follow"), own = keys("own");
  const unknown = [...follow, ...own].filter((k) => !OVERRIDABLE.some((x) => settingKey(x.path) === k));
  if (unknown.length) throw new ActionError(`not a setting with a global value: ${unknown.join(", ")}`);
  const both = follow.filter((k) => own.includes(k));
  if (both.length) throw new ActionError(`a setting either follows the global value or is the project's own, not both: ${both.join(", ")}`);
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
    languages: merged(p.languages, b.languages),
    // The orchestrator's notices, model and effort (its section is made here if the project has had none yet).
    orchestrator: b.orchestrator === undefined
      ? p.orchestrator
      : merged({ runtime: "claude" as const, session: null, notify: true, ...p.orchestrator }, {
        ...(b.orchestrator.notify !== undefined ? { notify: !!b.orchestrator.notify } : {}),
        ...("model" in b.orchestrator ? { model: b.orchestrator.model } : {}),
        ...("effort" in b.orchestrator ? { effort: b.orchestrator.effort } : {}),
      }),
  };
  const r = ProjectFile.safeParse(next);
  if (!r.success) throw new ActionError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const notes = r.data.conversations.notes_dir;
  if (notes !== undefined) r.data.conversations.notes_dir = notesDir(notes);
  store.updateProject(() => r.data, follow, own);
}

/** Changes the global settings (written only by the server: <NEXUS_HOME>/settings.yaml); every following project at once. */
export function updateGlobalSettings(patch: unknown): GlobalSettings {
  let next: GlobalSettings;
  try { next = changedGlobal(readGlobalSettings(), patch); }
  catch (e) {
    const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    throw new ActionError(issues ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message);
  }
  writeGlobalSettings(next);
  return next;
}

/**
 * Adds an allow rule for Claude Code workers to the project's Nexus settings (runtimes.claude.allowed_tools in
 * .nexus/project.yaml), typically from a refusal. Only the user: the server takes it only from the dashboard's page.
 * Nothing else is written: not the project's .claude/settings.json, not its AGENTS.md. Applies to runs started after.
 */
export function addAllowRule(store: ProjectStore, rule: unknown): { added: boolean; rule: string } {
  const r = typeof rule === "string" ? rule.trim() : "";
  if (!validAllowRule(r)) throw new ActionError("an allow rule is a tool name, optionally with a specifier in parentheses: Bash(git push:*), WebFetch(domain:example.com)");
  const p = store.readProject();
  if (p.runtimes.claude.allowed_tools.includes(r)) return { added: false, rule: r };
  store.updateProject((x) => ({ ...x, runtimes: { ...x.runtimes, claude: { ...x.runtimes.claude, allowed_tools: [...x.runtimes.claude.allowed_tools, r] } } }));
  return { added: true, rule: r };
}

/** The notes folder, relative to the project's root, inside it, with forward slashes and no trailing slash. */
export function notesDir(dir: string): string {
  const d = dir.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!d || d.startsWith("/") || /^[A-Za-z]:/.test(d) || d.split("/").includes("..")) {
    throw new ActionError("the notes folder is a path inside the project, relative to its root (for example Dev/Concepts/Gameplay)");
  }
  return d;
}
