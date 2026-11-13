// Derives the dashboard's view of a project from its files. Pure apart from reading through the store;
// nothing here is ever written back (state.json, if kept, is only a cache of this).
import { ORCHESTRATOR_ONLY, USER_ONLY, type StatusChange, type Event, type InboxEntry, type Note, type GitFile, type ProjectFile, type PushFile, type QueueFile, type QueueStatus, type ReviewItem, type ReviewPolicy, type RunFile, type RuntimeFile, type SessionFile, type StartFile, type StepDef, type StepStatus } from "./schemas.ts";
import { ProjectStore, revisionHash } from "./store.ts";
import { ENDED_RUN_STATES, formatClock, type Segment } from "./times.ts";
import { stopPlace } from "./attention.ts";

export interface CheckView { name: string; ok: boolean; summary?: string; at: string }
export interface AnswerView { id: string; text: string; at: string; escalate?: boolean; continue?: boolean; session: string; by: "orchestrator" | "user" }
export interface QuestionView {
  qid: string; session: string; queue?: string; step?: string; text: string; options?: string[];
  can_continue: boolean; asked_at: string;
  state: "open" | "answered" | "escalated" | "withdrawn";
  answers: AnswerView[];
}
export type InboxView = InboxEntry & { read_at?: string };
export interface AttentionItem {
  /** `start`: a planned start came due and the queue could not start (queues/<id>/start.yaml `failed`). */
  kind: "question" | "stopped" | "approval" | "review" | "failed" | "start";
  queue?: string; step?: string; qid?: string;
  text: string; at?: string;
  /**
   * A stopped queue's ways out (kind `stopped` of a queue whose status is stopped, not a halted run): `place` is where
   * the stop is (stopPlace); `continue`: the current revision is approved, so Continue lifts it (else approving the
   * revision does); `proposal`: the orchestrator's proposal to lift it.
   */
  lift?: { place: string; continue: boolean; revision: number; proposal?: { at: string; reason: string } };
}
export interface StepView extends StepDef {
  status: StepStatus;
  /** started_at: the first step.started (a resumed step keeps it); finished_at: its latest done or failed. */
  started_at?: string; finished_at?: string;
  /** Its stretches at work, one per step.started; see times.ts for durations. */
  segments: Segment[];
  progress?: { text: string; pct?: number; at: string };
  session?: string;
  summary?: string; reason?: string; commit?: string;
  /**
   * In review: whom the step waits for. The orchestrator with review policy `orchestrator`, until it asks the user
   * (`asked_user`); the user with `wait`, and also with `orchestrator` when the project has no orchestrator or its
   * notices are off.
   */
  review_with?: "orchestrator" | "user";
  /** The orchestrator's reason for handing the step's review to the user, in the current round. */
  asked_user?: { text: string; at: string };
  /**
   * Send-backs of this step, oldest first: `id` is the review.sent_back event's; `round` the round it opened once the
   * server delivered it to the worker (`delivered`); `to_user`: the orchestrator's beyond the limit, which handed the
   * step to the user instead.
   */
  sent_back: { id: string; text: string; at: string; by: "orchestrator" | "user"; round: number; delivered: boolean; to_user?: boolean }[];
  /** The round at work answers the user's Fix it: its review is the user's, whatever the policy. */
  user_fix?: boolean;
  review_items: (ReviewItem & { at: string; round?: number })[];
  /**
   * The user's marks and comments on review pictures, by the picture's path: `accepted` with its time while marked;
   * comments oldest first, with where each went.
   */
  pictures: Record<string, { accepted?: string; comments: { text: string; at: string; to: "send_back" | "note"; note_step?: string }[] }>;
  checks: CheckView[];
  notes: (Note & { read_at?: string })[];
  /** Messages sent to a session about this step while it ran. */
  messages: (InboxView & { session: string })[];
  timeline: Event[];
}
export interface QueueView extends Omit<QueueFile, "steps"> {
  status: QueueStatus;
  status_reason?: string;
  current_step?: string;
  approved: boolean;   // the latest approval pins the current revision
  revision_hash: string;
  steps: StepView[];
  report?: { path: string; summary: string; at: string };
  /**
   * The step the queue's stop came from (the latest queue.stop's, or the stopped step of a queue imported as stopped),
   * until a lift. It stays when the orchestrator skips that step: the stop is then the queue's (stopPlace).
   */
  stop_step?: string;
  /** The orchestrator's proposal to lift the queue's stop, until a lift, a later stop or an approval. */
  lift_proposal?: { at: string; reason: string };
  /**
   * The user's rejection of a step, while it holds the queue: until the user approves a revision newer than the one
   * approved when it came (`revision`). Meanwhile the run does not go on and nothing of the queue is pushed.
   */
  rejection?: { step: string; at: string; text?: string; revision: number };
  questions: QuestionView[];
  /** The engine's run of this queue, when Nexus drives it. */
  run?: RunFile;
  /** Pushing what was accepted (queues/<id>/push.yaml). */
  push?: PushFile;
  /** Git records of the queue (queues/<id>/git.yaml): its base, and a merge back and cleanup by the user. */
  git?: GitFile;
  /** A planned start of this queue (queues/<id>/start.yaml), with why it has not come yet. */
  start?: StartView;
  /** Queues planned to start when this one is done. */
  starts_next?: string[];
  updated?: string;    // time of the latest event about this queue
}
/**
 * A planned start as the dashboard shows it. `waiting`: why it has not started yet (the queue it waits for is still
 * running, halted, stopped, …; or the session it continues is busy). `blocked`: it waits on something only the user
 * or the orchestrator can change (the other queue halted, stopped, paused or cancelled).
 */
export type StartView = StartFile & { waiting: string; blocked: boolean };
export interface SessionView extends SessionFile {
  last_event_at?: string;
  last_event?: string;
  context?: { text: string; topics: string[]; files: string[]; at: string };
  event_count: number;
  inbox: InboxView[];
  live?: RuntimeFile;
}
export interface ProjectState {
  project: ProjectFile;
  queues: QueueView[];
  sessions: SessionView[];
  questions: QuestionView[];
  /** What waits for the user, newest first. */
  attention: AttentionItem[];
  warnings: string[];
  generated_at: string;
}

const FINISHED_STEP: ReadonlySet<StepStatus> = new Set(["done", "skipped", "failed"]);
const TERMINAL_QUEUE: ReadonlySet<QueueStatus> = new Set(["done", "cancelled"]);

/**
 * A step that needs no more work: done or skipped, or rejected once the rejection no longer holds (a newer revision
 * was approved after it). A rejected step is never run again; it keeps its status and reason.
 */
export function stepClosed(q: Pick<QueueView, "rejection">, st: { id: string; status: StepStatus }): boolean {
  return st.status === "done" || st.status === "skipped" || (st.status === "rejected" && q.rejection?.step !== st.id);
}

export function loadProjectState(store: ProjectStore): ProjectState {
  const warnings: string[] = [];
  const project = store.readProject();

  const queues = new Map<string, QueueView>();
  for (const id of store.queueIds()) {
    try {
      const q = store.readQueue(id);
      const { notes, errors } = store.readNotes(id);
      warnings.push(...errors);
      const view = initQueue(q, notes);
      try { view.run = store.readRun(id); } catch (e) { warnings.push(`queue ${id} run: ${(e as Error).message}`); }
      try { view.push = store.readPush(id); } catch (e) { warnings.push(`queue ${id} push: ${(e as Error).message}`); }
      try { view.git = store.readGit(id); } catch (e) { warnings.push(`queue ${id} git: ${(e as Error).message}`); }
      try {
        const plan = store.readStart(id);
        if (plan) view.start = { ...plan, waiting: "", blocked: false };
      } catch (e) { warnings.push(`queue ${id} start: ${(e as Error).message}`); }
      queues.set(id, view);
    } catch (e) { warnings.push(`queue ${id}: ${(e as Error).message}`); }
  }

  const sessions = new Map<string, SessionView>();
  const noteDeliveries = new Map<string, string>();
  const events: Event[] = [];
  for (const id of store.sessionIds()) {
    try {
      const s = store.readSession(id);
      const r = store.readEvents(id);
      warnings.push(...r.errors);
      const inbox = store.readInbox(id);
      const delivered = store.readDelivered(id);
      warnings.push(...inbox.errors, ...delivered.errors);
      // What the server handed over counts as read; so do notes it put into a step turn.
      const handed = new Map(delivered.entries.filter((d) => d.kind === "inbox").map((d) => [d.id, d.at]));
      for (const d of delivered.entries) if (d.kind === "note") noteDeliveries.set(d.id, d.at);
      sessions.set(id, {
        ...s, event_count: r.entries.length, live: store.readRuntime(id),
        inbox: inbox.entries.map((m) => (handed.has(m.id) ? { ...m, read_at: handed.get(m.id) } : m)),
      });
      for (const e of r.entries) {
        if (e.session !== id) { warnings.push(`session ${id}: event ${e.id} claims session ${e.session}; ignored`); continue; }
        if (ORCHESTRATOR_ONLY.has(e.type) && s.role !== "orchestrator" && s.role !== "user") {
          warnings.push(`session ${id}: ${e.type} is for orchestrators; ignored`); continue;
        }
        if (USER_ONLY.has(e.type) && s.role !== "user") {
          warnings.push(`session ${id}: ${e.type} is the user's; ignored`); continue;
        }
        events.push(e);
      }
    } catch (e) { warnings.push(`session ${id}: ${(e as Error).message}`); }
  }
  events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  // Send-backs the server delivered to a worker, by the review.sent_back event they carry out.
  const delivered = new Set<string>();
  for (const s of sessions.values()) for (const m of s.inbox) if (m.type === "send_back") delivered.add(m.ref);

  for (const q of queues.values()) for (const st of q.steps) for (const n of st.notes) {
    const at = noteDeliveries.get(n.id);
    if (at) n.read_at = at;
  }

  // Status changes made through Nexus come in among the events, by time; at the same time the event goes first.
  const changes = [...queues.values()].flatMap((q) => q.changes.map((c) => ({ q, c })))
    .sort((a, b) => a.c.at.localeCompare(b.c.at));
  const questions = new Map<string, QuestionView>();
  let next = 0;
  for (const e of events) {
    while (next < changes.length && changes[next]!.c.at < e.at) { applyChange(changes[next]!.q, changes[next]!.c); next++; }
    apply(e, queues, sessions, questions, warnings, project, delivered);
  }
  for (; next < changes.length; next++) applyChange(changes[next]!.q, changes[next]!.c);
  // A rejection holds until an approval of a newer revision; while it holds the queue is paused.
  for (const q of queues.values()) {
    const r = q.rejection;
    if (!r) continue;
    if (q.approvals.some((a) => a.at > r.at && a.revision > r.revision)) {
      q.rejection = undefined;
      if (q.status === "paused") { q.status = "approved"; q.status_reason = undefined; }
    } else if (!TERMINAL_QUEUE.has(q.status)) {
      q.status = "paused"; q.status_reason = `step ${r.step} was rejected${r.text ? `: ${r.text}` : ""}; it goes on once you approve a revision that deals with it`;
    }
  }
  // Once its rejection no longer holds, a rejected step counts as closed: a queue whose other steps are finished is done.
  for (const q of queues.values()) {
    if (TERMINAL_QUEUE.has(q.status) || q.rejection || !q.steps.some((s) => s.status === "rejected")) continue;
    if (q.steps.every((s) => stepClosed(q, s) || FINISHED_STEP.has(s.status))) { q.status = "done"; q.status_reason = undefined; }
  }

  // An approval after a proposal to lift answers it (approving a stopped queue lifts the stop anyway).
  for (const q of queues.values()) if (q.lift_proposal && q.approvals.some((a) => a.at > q.lift_proposal!.at)) q.lift_proposal = undefined;

  // A review for the orchestrator goes to the user when there is none to do it, or its notices are off.
  const orchestrating = !!project.orchestrator && project.orchestrator.notify !== false;
  for (const q of queues.values()) for (const st of q.steps) {
    if (st.status !== "review") st.review_with = undefined;
    else if (st.review_with === "orchestrator" && !orchestrating) st.review_with = "user";
  }

  for (const q of queues.values()) {
    q.questions = [...questions.values()].filter((x) => x.queue === q.id);
    // A run that halted, finished or was stopped ends the stretch of the step it left without an outcome.
    if (q.run && ENDED_RUN_STATES.has(q.run.state)) {
      const ended = q.run.ended_at ?? q.run.updated_at;
      for (const st of q.steps) {
        const open = st.segments.at(-1);
        if (open && open.end === undefined && open.start <= ended) open.end = ended;
      }
    }
    // A step at work comes first; otherwise the latest stop (an older stop may have been taken up again since).
    q.current_step = (q.steps.find((s) => s.status === "running" || s.status === "waiting" || s.status === "review")
      ?? q.steps.findLast((s) => s.status === "stopped"))?.id;
  }

  // Planned starts: shown on both queues, with why each waits.
  for (const q of queues.values()) {
    if (!q.start) continue;
    const a = q.start.after ? queues.get(q.start.after) : undefined;
    if (a) (a.starts_next ??= []).push(q.id);
    Object.assign(q.start, startWait(q.start, a, [...queues.values()]));
  }

  // Messages sent to sessions, shown on the step they were about.
  for (const s of sessions.values()) {
    for (const m of s.inbox) {
      if (m.type !== "message" || !m.queue || !m.step) continue;
      queues.get(m.queue)?.steps.find((x) => x.id === m.step)?.messages.push({ ...m, session: s.id });
    }
  }

  return {
    project,
    queues: [...queues.values()],
    sessions: [...sessions.values()],
    questions: [...questions.values()],
    attention: attentionOf([...queues.values()], [...questions.values()]),
    warnings,
    generated_at: new Date().toISOString(),
  };
}

/** GOING run states: a session with such a run is busy. */
const BUSY_RUN = new Set(["running", "pausing", "usage_wait", "retry_wait"]);

/** Why a planned start has not come yet. */
function startWait(plan: StartFile, a: QueueView | undefined, queues: QueueView[]): { waiting: string; blocked: boolean } {
  if (plan.at) return { waiting: plan.usage ? `the ${plan.usage === "codex" ? "Codex" : "Claude Code"} usage window resets` : "its time", blocked: false };
  if (!a) return { waiting: `queue ${plan.after} does not exist`, blocked: true };
  if (a.status === "done") {
    const busy = plan.session ? queues.find((x) => x.id !== plan.after && !!x.run && x.run.session === plan.session && BUSY_RUN.has(x.run.state)) : undefined;
    return busy ? { waiting: `queue ${plan.after} is done; the session to continue is running queue ${busy.id}`, blocked: false }
      : { waiting: `queue ${plan.after} is done`, blocked: false };
  }
  if (a.status === "cancelled") return { waiting: `queue ${plan.after} is cancelled`, blocked: true };
  if (a.status === "stopped") return { waiting: `queue ${plan.after} is stopped${a.status_reason ? `: ${a.status_reason}` : ""}`, blocked: true };
  const r = a.run;
  if (r?.state === "halted") return { waiting: `the run of ${plan.after} halted${r.reason ? `: ${r.reason}` : ""}`, blocked: true };
  if (r?.state === "paused") return { waiting: `the run of ${plan.after} is paused${r.reason ? `: ${r.reason}` : ""}`, blocked: true };
  if (r && BUSY_RUN.has(r.state)) return { waiting: `queue ${plan.after} is running${r.step ? ` (at ${r.step})` : ""}`, blocked: false };
  if (a.status === "running" || a.status === "waiting") return { waiting: `queue ${plan.after} is ${a.status === "waiting" ? "waiting (a question or a review)" : "running"}`, blocked: false };
  return { waiting: `queue ${plan.after} has not started yet`, blocked: false };
}

function attentionOf(queues: QueueView[], questions: QuestionView[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const x of questions) {
    if (x.state !== "open" && x.state !== "escalated") continue;
    const by = x.answers.at(-1);
    out.push({ kind: "question", queue: x.queue, step: x.step, qid: x.qid, text: x.text, at: by?.at ?? x.asked_at });
  }
  for (const q of queues) {
    // A finished queue does not wait for the user, whatever its last run says (a halt after its last step is done,
    // as an unasked exit of the agent could leave it); a done queue with a failed step is treated alike below.
    if (q.run?.state === "halted" && q.status !== "stopped" && q.status !== "done" && q.status !== "cancelled") out.push({ kind: "stopped", queue: q.id, step: q.run.step, text: q.run.reason ?? "The run halted", at: q.run.updated_at });
    if (q.status === "stopped") {
      out.push({
        kind: "stopped", queue: q.id, step: q.current_step, text: q.status_reason ?? "Stopped",
        at: [q.updated ?? q.updated_at, q.lift_proposal?.at].filter((x): x is string => !!x).sort().at(-1),
        lift: { place: stopPlace(q), continue: q.approved, revision: q.revision, ...(q.lift_proposal ? { proposal: q.lift_proposal } : {}) },
      });
    }
    if (q.status === "proposed") out.push({ kind: "approval", queue: q.id, text: q.title, at: q.updated_at });
    if (q.start?.failed) {
      const when = q.start.after ? `after ${q.start.after}` : `at ${formatClock(q.start.at!, new Date())}`;
      out.push({ kind: "start", queue: q.id, text: `Did not start ${when}: ${q.start.failed.reason}`, at: q.start.failed.at });
    }
    if (q.status === "cancelled" || q.status === "done") continue;
    for (const s of q.steps) {
      // A review the orchestrator does is not the user's (the queue still shows it waiting).
      if (s.status === "review" && s.review_with !== "orchestrator") out.push({ kind: "review", queue: q.id, step: s.id, text: s.asked_user?.text ?? s.summary ?? s.title, at: s.asked_user?.at ?? s.finished_at });
      if (s.status === "failed") out.push({ kind: "failed", queue: q.id, step: s.id, text: s.reason ?? s.title, at: s.finished_at });
    }
  }
  return out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

/** The latest approval pins the current revision, and no withdrawal came after it. */
export function isApproved(q: QueueFile): boolean {
  const latest = q.approvals.at(-1);
  const withdrawn = q.withdrawals.at(-1);
  return !!latest && latest.revision === q.revision && latest.hash === revisionHash(q)
    && !(withdrawn && withdrawn.approvals >= q.approvals.length);
}

function initQueue(q: QueueFile, notes: Note[]): QueueView {
  const hash = revisionHash(q);
  const latest = q.approvals.at(-1);
  return {
    ...q,
    status: q.status,
    status_reason: q.status_note,
    stop_step: q.status === "stopped" ? q.steps.findLast((s) => s.status === "stopped")?.id : undefined,
    approved: isApproved(q),
    revision_hash: hash,
    questions: [],
    steps: q.steps.map((s) => ({
      ...s,
      status: s.status ?? "pending",
      review_items: [], checks: [], timeline: [], messages: [], segments: [], sent_back: [], pictures: {},
      notes: notes.filter((n) => n.step === s.id),
    })),
  };
}

/** The review policy that applies to a step: its own, else its queue's, else the project's default. */
export function reviewPolicyOf(st: Pick<StepDef, "review">, q: Pick<QueueFile, "review_policy">, project: Pick<ProjectFile, "defaults">): ReviewPolicy {
  return st.review?.policy ?? q.review_policy ?? project.defaults.review_policy;
}

function apply(
  e: Event, queues: Map<string, QueueView>, sessions: Map<string, SessionView>,
  questions: Map<string, QuestionView>, warnings: string[], project: ProjectFile, delivered: ReadonlySet<string>,
): void {
  const s = sessions.get(e.session);
  if (s) {
    s.last_event_at = e.at;
    s.last_event = e.type;
    if (e.type === "context.summary") s.context = { text: e.text, topics: e.topics, files: e.files, at: e.at };
  }

  const queueOf = (id: string | undefined) => {
    if (id === undefined) return undefined;
    const q = queues.get(id);
    if (!q) warnings.push(`event ${e.id} (${e.type}) names unknown queue ${id}`);
    else q.updated = e.at;
    return q;
  };
  const stepOf = (q: QueueView | undefined, id: string | undefined) => {
    if (!q || id === undefined) return undefined;
    const st = q.steps.find((x) => x.id === id);
    if (!st) warnings.push(`event ${e.id} (${e.type}) names unknown step ${q.id}/${id}`);
    else st.timeline.push(e);
    return st;
  };

  switch (e.type) {
    case "step.started": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q || !st) return;
      // Started again without an outcome in between (a halted or interrupted turn): the earlier stretch ended with the
      // step's last event before this one.
      const open = st.segments.at(-1);
      if (open && open.end === undefined) open.end = st.timeline.at(-2)?.at ?? e.at;
      st.segments.push({ start: e.at });
      st.status = "running"; st.started_at ??= e.at; st.session = e.session;
      st.finished_at = undefined; st.reason = undefined;
      if (!TERMINAL_QUEUE.has(q.status)) { q.status = "running"; q.status_reason = undefined; }
      return;
    }
    case "step.progress": {
      const st = stepOf(queueOf(e.queue), e.step);
      if (st) st.progress = { text: e.text, pct: e.pct, at: e.at };
      return;
    }
    case "review.marked":
    case "review.commented": {
      const st = stepOf(queueOf(e.queue), e.step);
      if (!st) return;
      const p = (st.pictures[e.path] ??= { comments: [] });
      if (e.type === "review.marked") p.accepted = e.accepted ? e.at : undefined;
      else p.comments.push({ text: e.text, at: e.at, to: e.to, note_step: e.note_step });
      return;
    }
    case "review.added": {
      const st = stepOf(queueOf(e.queue), e.step);
      if (st) st.review_items.push(...e.items.map((i) => ({ ...i, at: e.at, round: e.round })));
      return;
    }
    case "check.result": {
      const st = stepOf(queueOf(e.queue), e.step);
      if (st) st.checks.push({ name: e.name, ok: e.ok, summary: e.summary, at: e.at });
      return;
    }
    case "step.done": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q || !st) return;
      // After the user's Fix it, the round's review is the user's.
      const policy = st.user_fix ? "wait" : reviewPolicyOf(st, q, project);
      st.status = policy === "continue" ? "done" : "review";
      st.review_with = policy === "orchestrator" ? "orchestrator" : policy === "wait" ? "user" : undefined;
      st.asked_user = undefined; st.user_fix = undefined;
      st.finished_at = e.at; st.summary = e.summary; st.commit = e.commit;
      endSegment(st, e.at);
      if (q.steps.every((x) => FINISHED_STEP.has(x.status))) q.status = "done";
      else if (policy !== "continue") q.status = "waiting";
      return;
    }
    case "step.failed": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q || !st) return;
      st.status = "failed"; st.finished_at = e.at; st.reason = e.reason;
      endSegment(st, e.at);
      return;
    }
    case "queue.stop": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q) return;
      q.lift_proposal = undefined;
      // A done or cancelled queue stays so (a cancel by the orchestrator, for one, is not undone by a late stop).
      if (!TERMINAL_QUEUE.has(q.status)) { q.status = "stopped"; q.status_reason = `${e.condition}: ${e.reason}`; q.stop_step = e.step; }
      for (const x of q.steps) endSegment(x, e.at);
      if (st && !FINISHED_STEP.has(st.status)) { st.status = "stopped"; st.reason = e.reason; }
      return;
    }
    case "question.asked": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      questions.set(e.qid, {
        qid: e.qid, session: e.session, queue: e.queue, step: e.step, text: e.text, options: e.options,
        can_continue: e.can_continue, asked_at: e.at, state: "open", answers: [],
      });
      if (!e.can_continue && st && st.status === "running") st.status = "waiting";
      if (!e.can_continue && q && q.status === "running") q.status = "waiting";
      return;
    }
    case "question.withdrawn": {
      const x = questions.get(e.qid);
      if (x) { x.state = "withdrawn"; resume(x, queues, e); }
      return;
    }
    case "answer.given": {
      const x = questions.get(e.qid);
      if (!x) { warnings.push(`answer ${e.id} to unknown question ${e.qid}`); return; }
      x.answers.push({
        id: e.id, text: e.text, at: e.at, escalate: e.escalate, continue: e.continue, session: e.session,
        by: s?.role === "user" ? "user" : "orchestrator",
      });
      x.state = e.escalate ? "escalated" : "answered";
      if (!e.escalate) resume(x, queues, e);
      return;
    }
    case "review.asked_user": {
      const st = stepOf(queueOf(e.queue), e.step);
      if (!st || st.status !== "review" || st.review_with !== "orchestrator") { warnings.push(`event ${e.id}: step ${e.queue}/${e.step} is not waiting for the orchestrator's review; ignored`); return; }
      st.review_with = "user"; st.asked_user = { text: e.text, at: e.at };
      return;
    }
    case "review.rejected": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q || !st) return;
      if (st.status !== "review" || st.review_with !== "user") { warnings.push(`event ${e.id}: step ${e.queue}/${e.step} is not waiting for the user's review; the rejection is ignored`); return; }
      st.status = "rejected"; st.review_with = undefined; st.asked_user = undefined; st.reason = e.text;
      // The revision current when it came: the first one replaced after it, else the queue's present one.
      const current = q.history.find((h) => h.replaced_at > e.at)?.revision ?? q.revision;
      q.rejection = { step: st.id, at: e.at, text: e.text, revision: current };
      return;
    }
    case "review.sent_back": {
      // The request is recorded here; the server carries it out by writing the worker's inbox (routeSendBacks), and
      // that entry reopens the step as the next round. The orchestrator sends back only what waits for it, the
      // user (Fix it) only what waits for the user.
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q || !st) return;
      const by = s?.role === "user" ? "user" : "orchestrator";
      if (st.status !== "review" || st.review_with !== by) { warnings.push(`event ${e.id}: step ${e.queue}/${e.step} is not waiting for the ${by}'s review; the send-back is ignored`); return; }
      const round = st.timeline.filter((x) => x.type === "step.done").length + 1;
      const limit = project.defaults.review_send_back_limit;
      if (by === "orchestrator" && st.sent_back.filter((x) => x.by === "orchestrator" && !x.to_user).length >= limit) {
        st.sent_back.push({ id: e.id, text: e.text, at: e.at, by, round, delivered: false, to_user: true });
        st.review_with = "user";
        st.asked_user = { text: `The orchestrator sent this step back ${limit} time${limit === 1 ? "" : "s"} already and would again: ${e.text}`, at: e.at };
        return;
      }
      const sent = delivered.has(e.id);
      st.sent_back.push({ id: e.id, text: e.text, at: e.at, by, round, delivered: sent });
      if (!sent) return; // waits for the server to deliver it
      st.status = "running"; st.review_with = undefined; st.asked_user = undefined;
      st.user_fix = by === "user" ? true : undefined;
      st.finished_at = undefined;
      if (q.status === "waiting" && !q.steps.some((x) => x.status === "waiting" || x.status === "review")) q.status = "running";
      return;
    }
    case "review.accepted": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q || !st || st.status !== "review") return;
      // The orchestrator accepts only what waits for it; what went to the user is the user's.
      if (s?.role === "orchestrator" && st.review_with !== "orchestrator") { warnings.push(`event ${e.id}: step ${e.queue}/${e.step} waits for the user's review; the orchestrator's acceptance is ignored`); return; }
      st.review_with = undefined;
      st.status = "done";
      if (q.steps.every((x) => FINISHED_STEP.has(x.status))) q.status = "done";
      else if (q.status === "waiting" && !q.steps.some((x) => x.status === "waiting" || x.status === "review")) q.status = "running";
      return;
    }
    case "message.read": {
      const m = s?.inbox.find((x) => x.id === e.message);
      if (m) m.read_at = e.at;
      return;
    }
    case "note.read": {
      for (const q of queues.values()) for (const st of q.steps) {
        const n = st.notes.find((x) => x.id === e.note);
        if (n) { n.read_at = e.at; st.timeline.push(e); }
      }
      return;
    }
    case "queue.report": {
      const q = queueOf(e.queue);
      if (q) q.report = { path: e.path, summary: e.summary, at: e.at };
      return;
    }
    case "context.summary": {
      stepOf(queueOf(e.queue), e.step);
      return;
    }
    default:
      return;
  }
}

/**
 * A lift of a stop: the queue is approved again and its stopped steps are pending again, so a start runs them; the
 * stops before it no longer count (their record stays in the steps' timelines and in the entry's reason).
 */
function applyChange(q: QueueView, c: StatusChange): void {
  switch (c.kind) {
    case "lift":
      q.lift_proposal = undefined; q.stop_step = undefined;
      if (q.status === "stopped") { q.status = "approved"; q.status_reason = undefined; }
      for (const st of q.steps) if (st.status === "stopped") { st.status = "pending"; st.reason = undefined; }
      return;
    case "proposal":
      q.lift_proposal = { at: c.at, reason: c.reason ?? "" };
      return;
    case "status": {
      if (c.step) {
        const st = q.steps.find((x) => x.id === c.step);
        if (!st) return;
        st.status = c.to as StepStatus; st.reason = c.reason;
        endSegment(st, c.at);
      } else if (c.to === "cancelled") {
        q.status = "cancelled"; q.status_reason = c.reason;
        return;
      }
      // Skipping the last open step makes the queue done.
      if (!TERMINAL_QUEUE.has(q.status) && q.steps.every((x) => FINISHED_STEP.has(x.status))) { q.status = "done"; q.status_reason = undefined; }
      return;
    }
    case "run":
      return; // the run record itself says finished; the queue's steps are all done or skipped already
  }
}

function endSegment(st: StepView, at: string): void {
  const open = st.segments.at(-1);
  if (open && open.end === undefined) open.end = at;
}

function resume(x: QuestionView, queues: Map<string, QueueView>, e: Event): void {
  const q = x.queue ? queues.get(x.queue) : undefined;
  const st = q?.steps.find((s) => s.id === x.step);
  if (st?.status === "waiting") { st.status = "running"; st.timeline.push(e); }
  if (q?.status === "waiting" && !q.steps.some((s) => s.status === "waiting" || s.status === "review")) q.status = "running";
}


/**
 * Where the user's comment on a review picture of a step goes: back to the worker with a send-back (a Fix it) while
 * the step waits for the user's review; otherwise a note on the next pending step after it; else nowhere.
 */
export function commentTarget(q: Pick<QueueView, "steps">, step: string): { to: "send_back" } | { to: "note"; step: string } | { to: "none" } {
  const i = q.steps.findIndex((s) => s.id === step);
  const st = q.steps[i];
  if (!st) return { to: "none" };
  if (st.status === "review" && st.review_with !== "orchestrator") return { to: "send_back" };
  const next = q.steps.slice(i + 1).find((s) => s.status === "pending");
  return next ? { to: "note", step: next.id } : { to: "none" };
}
