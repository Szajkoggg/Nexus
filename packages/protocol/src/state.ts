// Derives the dashboard's view of a project from its files. Pure apart from reading through the store;
// nothing here is ever written back (state.json, if kept, is only a cache of this).
import { ORCHESTRATOR_ONLY, type Event, type InboxEntry, type Note, type ProjectFile, type QueueFile, type QueueStatus, type ReviewItem, type RunFile, type RuntimeFile, type SessionFile, type StepDef, type StepStatus } from "./schemas.ts";
import { ProjectStore, revisionHash } from "./store.ts";
import { ENDED_RUN_STATES, type Segment } from "./times.ts";

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
  kind: "question" | "stopped" | "approval" | "review" | "failed";
  queue?: string; step?: string; qid?: string;
  text: string; at?: string;
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
  review_items: (ReviewItem & { at: string; round?: number })[];
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
  questions: QuestionView[];
  /** The engine's run of this queue, when Nexus drives it. */
  run?: RunFile;
  updated?: string;    // time of the latest event about this queue
}
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
        events.push(e);
      }
    } catch (e) { warnings.push(`session ${id}: ${(e as Error).message}`); }
  }
  events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  for (const q of queues.values()) for (const st of q.steps) for (const n of st.notes) {
    const at = noteDeliveries.get(n.id);
    if (at) n.read_at = at;
  }

  const questions = new Map<string, QuestionView>();
  for (const e of events) apply(e, queues, sessions, questions, warnings);

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

function attentionOf(queues: QueueView[], questions: QuestionView[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const x of questions) {
    if (x.state !== "open" && x.state !== "escalated") continue;
    const by = x.answers.at(-1);
    out.push({ kind: "question", queue: x.queue, step: x.step, qid: x.qid, text: x.text, at: by?.at ?? x.asked_at });
  }
  for (const q of queues) {
    if (q.run?.state === "halted" && q.status !== "stopped") out.push({ kind: "stopped", queue: q.id, step: q.run.step, text: q.run.reason ?? "The run halted", at: q.run.updated_at });
    if (q.status === "stopped") out.push({ kind: "stopped", queue: q.id, step: q.current_step, text: q.status_reason ?? "Stopped", at: q.updated ?? q.updated_at });
    if (q.status === "proposed") out.push({ kind: "approval", queue: q.id, text: q.title, at: q.updated_at });
    if (q.status === "cancelled" || q.status === "done") continue;
    for (const s of q.steps) {
      if (s.status === "review") out.push({ kind: "review", queue: q.id, step: s.id, text: s.summary ?? s.title, at: s.finished_at });
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
    approved: isApproved(q),
    revision_hash: hash,
    questions: [],
    steps: q.steps.map((s) => ({
      ...s,
      status: s.status ?? "pending",
      review_items: [], checks: [], timeline: [], messages: [], segments: [],
      notes: notes.filter((n) => n.step === s.id),
    })),
  };
}

function apply(
  e: Event, queues: Map<string, QueueView>, sessions: Map<string, SessionView>,
  questions: Map<string, QuestionView>, warnings: string[],
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
      const policy = st.review?.policy ?? q.review_policy ?? "continue";
      st.status = policy === "wait" ? "review" : "done";
      st.finished_at = e.at; st.summary = e.summary; st.commit = e.commit;
      endSegment(st, e.at);
      if (q.steps.every((x) => FINISHED_STEP.has(x.status))) q.status = "done";
      else if (policy === "wait") q.status = "waiting";
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
      q.status = "stopped"; q.status_reason = `${e.condition}: ${e.reason}`;
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
    case "review.accepted": {
      const q = queueOf(e.queue); const st = stepOf(q, e.step);
      if (!q || !st || st.status !== "review") return;
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

